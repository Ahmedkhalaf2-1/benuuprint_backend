import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  auditActions,
  createTestApp,
  createUserAndLogin,
  uniq,
} from './support/app.js';
import {
  acceptActiveTerms,
  api,
  completeDraft,
  createCustomerWithBrand,
  createFabricColor,
  lookupRefs,
  makeActors,
  type Actors,
  type Refs,
} from './support/factory.js';

describe('Samples: drafts, specification and editing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let a: Actors;
  let refs: Refs;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    a = await makeActors(app);
    refs = await lookupRefs(app);
  });
  afterAll(() => app.close());

  const newDraft = async (extra: Record<string, unknown> = {}) => {
    const { customer, brand } = await createCustomerWithBrand(a.admin);
    return (
      await a.admin
        .post('/admin/samples', {
          customerId: customer.id,
          brandId: brand.id,
          ...extra,
        })
        .expect(201)
    ).body;
  };

  describe('draft creation', () => {
    it('creates an incomplete DRAFT with only customer and brand, with a generated SMP number', async () => {
      const s = await newDraft();
      expect(s.sampleNumber).toMatch(/^SMP-\d{6}$/);
      expect(s).toMatchObject({
        status: 'DRAFT',
        fitMethod: 'NOT_SURE',
        fabricProvider: 'NOT_DECIDED',
        productType: null,
        customProductName: null,
        decorations: [],
        accessories: [],
        components: [],
        paymentState: 'UNPAID',
        revisionNumber: 1,
      });
      expect(s.allowedActions).toEqual(
        expect.arrayContaining(['submit', 'cancel']),
      );
      expect(await auditActions(app, s.id)).toContain('sample.created');
      const hist = (
        await a.admin.get(`/admin/samples/${s.id}/status-history`).expect(200)
      ).body;
      expect(hist.map((h: any) => h.action)).toEqual(['create']);
    });

    it('generates unique contiguous SMP numbers under concurrency', async () => {
      const { customer, brand } = await createCustomerWithBrand(a.admin);
      const made = await Promise.all(
        Array.from({ length: 8 }, () =>
          a.admin.post('/admin/samples', {
            customerId: customer.id,
            brandId: brand.id,
          }),
        ),
      );
      expect(made.every((r) => r.status === 201)).toBe(true);
      const nums = made
        .map((r) => Number(r.body.sampleNumber.slice(4)))
        .sort((x, y) => x - y);
      expect(new Set(nums).size).toBe(8);
      expect(nums[7]! - nums[0]!).toBe(7);
    });

    it('supports a configured product, fabric and colour', async () => {
      const color = await createFabricColor(a.admin, refs.fabricId);
      const s = await newDraft({
        productTypeId: refs.productTypeId,
        fabricId: refs.fabricId,
        fabricColorId: color.id,
        sampleSizeOptionId: refs.sizeId,
        gsm: 160,
      });
      expect(s.productType.code).toBe('TEE');
      expect(s.fabric.code).toBe('SINGLE_LYCRA');
      expect(s.fabricColor.id).toBe(color.id);
      expect(s.sampleSize).toMatchObject({ code: 'M', scaleCode: 'STANDARD' });
      expect(s.gsm).toBe(160);
    });

    it('supports a custom product, custom fabric and custom colour (Pantone/hex/name)', async () => {
      const s = await newDraft({
        customProductName: 'Quilted vest',
        customProductDescription: 'Sleeveless, 3 pockets',
        customFabricName: 'Customer wool blend',
        customFabricDescription: 'Supplied by customer',
        customColorName: 'Brick',
        customPantone: '18-1550 TCX',
        customHex: '#a0402c',
        fabricProvider: 'CUSTOMER',
      });
      expect(s).toMatchObject({
        productType: null,
        customProductName: 'Quilted vest',
        fabric: null,
        customFabricName: 'Customer wool blend',
        fabricColor: null,
        customColorName: 'Brick',
        customPantone: '18-1550 TCX',
        customHex: '#a0402c',
        fabricProvider: 'CUSTOMER',
      });
    });

    it('supports the "Other / Not Sure" fabric and keeps fabric provider on the sample, not the fabric', async () => {
      const s = await newDraft({
        fabricId: refs.otherFabricId,
        fabricProvider: 'NOT_DECIDED',
      });
      expect(s.fabric.code).toBe('OTHER_NOT_SURE');
      const fabric = await prisma.fabric.findUniqueOrThrow({
        where: { id: refs.otherFabricId },
      });
      expect(Object.keys(fabric)).not.toContain('fabricProvider');
      const other = await newDraft({
        fabricId: refs.otherFabricId,
        fabricProvider: 'BENUE_PRINT',
      });
      expect(other.fabricProvider).toBe('BENUE_PRINT');
      expect(
        (await a.admin.get(`/admin/samples/${s.id}`).expect(200)).body
          .fabricProvider,
      ).toBe('NOT_DECIDED');
    });

    it('rejects contradictory choices instead of silently fixing them', async () => {
      const { customer, brand } = await createCustomerWithBrand(a.admin);
      const base = { customerId: customer.id, brandId: brand.id };
      const color = await createFabricColor(a.admin, refs.fabricId);
      const bad = async (body: object) =>
        (await a.admin.post('/admin/samples', { ...base, ...body }).expect(400))
          .body.message;
      expect(
        await bad({
          productTypeId: refs.productTypeId,
          customProductName: 'Both',
        }),
      ).toEqual(
        expect.arrayContaining([expect.stringMatching(/mutually exclusive/)]),
      );
      expect(
        await bad({ fabricId: refs.fabricId, customFabricName: 'Both' }),
      ).toEqual(
        expect.arrayContaining([expect.stringMatching(/mutually exclusive/)]),
      );
      expect(
        await bad({
          fabricId: refs.fabricId,
          fabricColorId: color.id,
          customPantone: '19-4052',
        }),
      ).toEqual(
        expect.arrayContaining([expect.stringMatching(/mutually exclusive/)]),
      );
      expect(await bad({ fabricColorId: color.id })).toEqual(
        expect.arrayContaining(['fabricColorId requires fabricId']),
      );
      expect(
        await bad({ fabricId: refs.otherFabricId, fabricColorId: color.id }),
      ).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/does not belong to the selected fabric/),
        ]),
      );
      expect(
        await bad({ patternVersionId: '3f2b1c0e-0000-4000-8000-000000000000' }),
      ).toBeDefined();
      expect(
        await bad({ productTypeId: '3f2b1c0e-0000-4000-8000-000000000000' }),
      ).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/product type not found/),
        ]),
      );
      await a.admin
        .post('/admin/samples', { ...base, customHex: 'red' })
        .expect(400);
      await a.admin
        .post('/admin/samples', { ...base, sampleNumber: 'SMP-000001' })
        .expect(400); // not client-settable
      await a.admin
        .post('/admin/samples', { ...base, status: 'APPROVED' })
        .expect(400);
    });

    it('rejects a brand of another customer, an unknown customer, and blocked/archived customers', async () => {
      const one = await createCustomerWithBrand(a.admin);
      const two = await createCustomerWithBrand(a.admin);
      const wrong = await a.admin
        .post('/admin/samples', {
          customerId: one.customer.id,
          brandId: two.brand.id,
        })
        .expect(400);
      expect(wrong.body.message).toEqual(
        expect.arrayContaining([expect.stringMatching(/different customer/)]),
      );
      await a.admin
        .post('/admin/samples', {
          customerId: '3f2b1c0e-0000-4000-8000-000000000000',
          brandId: one.brand.id,
        })
        .expect(400);
      await a.admin
        .patch(`/admin/customers/${one.customer.id}/status`, {
          status: 'BLOCKED',
        })
        .expect(200);
      await a.admin
        .post('/admin/samples', {
          customerId: one.customer.id,
          brandId: one.brand.id,
        })
        .expect(409);
    });

    it('requires a pattern version only with fit method BENUE_PATTERN, and only an APPROVED one', async () => {
      const { customer, brand } = await createCustomerWithBrand(a.admin);
      const base = { customerId: customer.id, brandId: brand.id };
      const pattern = (
        await a.admin
          .post('/admin/patterns', {
            code: uniq('DP').toUpperCase().replace(/-/g, '_'),
            name: 'Draft',
            productTypeId: refs.productTypeId,
          })
          .expect(201)
      ).body;
      const draftVersion = pattern.versions[0].id;
      const r1 = await a.admin
        .post('/admin/samples', {
          ...base,
          fitMethod: 'BENUE_PATTERN',
          patternVersionId: draftVersion,
        })
        .expect(400);
      expect(r1.body.message).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/only APPROVED pattern versions/),
        ]),
      );
      const r2 = await a.admin
        .post('/admin/samples', {
          ...base,
          fitMethod: 'COPY_CUSTOMER_PIECE',
          patternVersionId: draftVersion,
        })
        .expect(400);
      expect(r2.body.message).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/only be set when fitMethod is BENUE_PATTERN/),
        ]),
      );
    });
  });

  describe('editing', () => {
    it('edits a DRAFT incrementally; null clears; unchanged values are no-ops', async () => {
      const s = await newDraft({ customProductName: 'Cape' });
      const r1 = await a.admin
        .patch(`/admin/samples/${s.id}`, {
          notes: 'rush',
          gsm: 200,
          fitNotes: 'loose',
        })
        .expect(200);
      expect(r1.body).toMatchObject({
        notes: 'rush',
        gsm: 200,
        fitNotes: 'loose',
        customProductName: 'Cape',
      });
      const r2 = await a.admin
        .patch(`/admin/samples/${s.id}`, { gsm: null, notes: null })
        .expect(200);
      expect(r2.body).toMatchObject({
        gsm: null,
        notes: null,
        fitNotes: 'loose',
      });
      const before = await prisma.auditLog.count({
        where: { entityId: s.id, action: 'sample.updated' },
      });
      await a.admin
        .patch(`/admin/samples/${s.id}`, { fitNotes: 'loose' })
        .expect(200);
      expect(
        await prisma.auditLog.count({
          where: { entityId: s.id, action: 'sample.updated' },
        }),
      ).toBe(before);
    });

    it('switches between configured and custom explicitly', async () => {
      const s = await newDraft({ customProductName: 'Cape' });
      await a.admin
        .patch(`/admin/samples/${s.id}`, { productTypeId: refs.productTypeId })
        .expect(400);
      const ok = await a.admin
        .patch(`/admin/samples/${s.id}`, {
          productTypeId: refs.productTypeId,
          customProductName: null,
        })
        .expect(200);
      expect(ok.body.productType.code).toBe('TEE');
      expect(ok.body.customProductName).toBeNull();
    });

    it('records old → new for relation changes in the audit trail', async () => {
      const s = await newDraft({ fabricId: refs.fabricId });
      await a.admin
        .patch(`/admin/samples/${s.id}`, { fabricId: refs.otherFabricId })
        .expect(200);
      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: s.id, action: 'sample.updated' },
        orderBy: { createdAt: 'desc' },
      });
      expect((entry.metadata as any).changes.fabricId).toEqual({
        from: refs.fabricId,
        to: refs.otherFabricId,
      });
    });

    it('never lets the sample number, customer or status be edited through PATCH', async () => {
      const s = await newDraft();
      for (const body of [
        { sampleNumber: 'SMP-999999' },
        { customerId: s.customer.id },
        { status: 'QUOTED' },
        { paymentState: 'PAID' },
      ]) {
        await a.admin.patch(`/admin/samples/${s.id}`, body).expect(400);
      }
      await expect(
        prisma.$executeRaw`UPDATE samples SET sample_number = 'SMP-999999' WHERE id = ${s.id}::uuid`,
      ).rejects.toThrow();
      await expect(
        prisma.$executeRaw`UPDATE samples SET customer_id = (SELECT id FROM customers WHERE id <> ${s.customer.id}::uuid LIMIT 1) WHERE id = ${s.id}::uuid`,
      ).rejects.toThrow();
    });

    it('enforces exclusivity and consistency in the database as well', async () => {
      const s = await newDraft();
      await expect(
        prisma.sample.update({
          where: { id: s.id },
          data: { productTypeId: refs.productTypeId, customProductName: 'x' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.sample.update({ where: { id: s.id }, data: { gsm: 0 } }),
      ).rejects.toThrow();
      await expect(
        prisma.sample.update({
          where: { id: s.id },
          data: { status: 'SUBMITTED' },
        }), // no product
      ).rejects.toThrow();
    });
  });

  describe('listing, search and filters', () => {
    it('searches by sample number, customer number/name/phone/email and brand; paginates; sorts', async () => {
      const marker = uniq('zz').replace(/-/g, '');
      const { customer, brand } = await createCustomerWithBrand(a.admin, {
        displayName: `Find ${marker} Co`,
        email: `${marker}@find.example`,
        phone: '+201055566677',
      });
      const make = async () =>
        (
          await a.admin.post('/admin/samples', {
            customerId: customer.id,
            brandId: brand.id,
            productTypeId: refs.productTypeId,
          })
        ).body;
      const [s1, s2, s3] = [await make(), await make(), await make()];
      const find = async (q: string) =>
        (
          await a.admin
            .get(`/admin/samples?search=${encodeURIComponent(q)}&pageSize=100`)
            .expect(200)
        ).body.data.map((x: any) => x.id);
      expect((await find(s1.sampleNumber)).includes(s1.id)).toBe(true);
      expect((await find(s1.sampleNumber.toLowerCase())).includes(s1.id)).toBe(
        true,
      );
      expect(
        (await find(customer.customerNumber)).sort((x, y) =>
          String(x).localeCompare(String(y)),
        ),
      ).toEqual(
        [s1.id, s2.id, s3.id].sort((x, y) =>
          String(x).localeCompare(String(y)),
        ),
      );
      expect((await find(`Find ${marker}`)).length).toBe(3);
      expect((await find(`${marker}@find`)).length).toBe(3);
      expect((await find('+20 105 556 6677')).length).toBeGreaterThanOrEqual(3);
      expect((await find(brand.name)).length).toBe(3);

      const page = await a.admin
        .get(
          `/admin/samples?search=${marker}&pageSize=2&page=2&sort=sampleNumber`,
        )
        .expect(200);
      expect(page.body.meta).toEqual({ page: 2, pageSize: 2, total: 3 });
      expect(page.body.data.map((x: any) => x.id)).toEqual([s3.id]);
      const oldest = await a.admin
        .get(`/admin/samples?search=${marker}&sort=oldest`)
        .expect(200);
      expect(oldest.body.data[0].id).toBe(s1.id);
      const newest = await a.admin
        .get(`/admin/samples?search=${marker}&sort=newest`)
        .expect(200);
      expect(newest.body.data[0].id).toBe(s3.id);
      await a.admin.get('/admin/samples?sort=password').expect(400);
    });

    it('filters by status, sales owner, product, fabric, payment/approval state and dates; hides archived', async () => {
      const { customer, brand } = await createCustomerWithBrand(a.admin);
      const mk = async (body: object) =>
        (
          await a.admin.post('/admin/samples', {
            customerId: customer.id,
            brandId: brand.id,
            ...body,
          })
        ).body;
      const tee = await mk({
        productTypeId: refs.productTypeId,
        fabricId: refs.fabricId,
      });
      const hood = await mk({
        productTypeId: refs.hoodieId,
        fabricId: refs.otherFabricId,
      });
      const custom = await mk({ customProductName: 'Cape' });
      await a.admin
        .post(`/admin/samples/${hood.id}/assign-sales`, {
          userId: a.salesUserId,
        })
        .expect(200);
      await a.admin
        .post(`/admin/samples/${custom.id}/cancel`, { reason: 'duplicate' })
        .expect(200);
      const q = async (qs: string) =>
        (
          await a.admin
            .get(`/admin/samples?customerId=${customer.id}&${qs}`)
            .expect(200)
        ).body.data
          .map((x: any) => x.id)
          .sort((x, y) => String(x).localeCompare(String(y)));
      expect(await q('')).toEqual(
        [tee.id, hood.id, custom.id].sort((x, y) =>
          String(x).localeCompare(String(y)),
        ),
      );
      expect(await q('status=CANCELLED')).toEqual([custom.id]);
      expect(await q('status=DRAFT,CANCELLED')).toEqual(
        [tee.id, hood.id, custom.id].sort((x, y) =>
          String(x).localeCompare(String(y)),
        ),
      );
      expect(await q(`assignedSalesUserId=${a.salesUserId}`)).toEqual([
        hood.id,
      ]);
      expect(await q('unassigned=true')).toEqual(
        [tee.id, custom.id].sort((x, y) => String(x).localeCompare(String(y))),
      );
      expect(await q(`productTypeId=${refs.hoodieId}`)).toEqual([hood.id]);
      expect(await q(`fabricId=${refs.fabricId}`)).toEqual([tee.id]);
      expect(await q('paymentState=PAID')).toEqual([]);
      expect(await q('paymentState=UNPAID')).toHaveLength(3);
      expect(await q('approvalState=PENDING')).toEqual([]);
      expect(await q('submittedFrom=2000-01-01')).toEqual([]);
      expect(
        await q(`createdFrom=${new Date(Date.now() - 3600_000).toISOString()}`),
      ).toHaveLength(3);
      expect(
        await q(`createdTo=${new Date(Date.now() - 86_400_000).toISOString()}`),
      ).toEqual([]);
      await a.admin.get('/admin/samples?status=NOPE').expect(400);

      await a.admin.del(`/admin/samples/${custom.id}`).expect(204);
      expect(await q('')).toEqual(
        [tee.id, hood.id].sort((x, y) => String(x).localeCompare(String(y))),
      );
      expect(await q('includeArchived=true')).toHaveLength(3);
    });
  });

  describe('decorations, accessories, labels/packaging', () => {
    it('treats zero decorations as "no print" and manages decoration specs', async () => {
      const s = await newDraft();
      expect(s.decorations).toEqual([]);
      const d = (
        await a.admin
          .post(`/admin/samples/${s.id}/decorations`, {
            printMethodId: refs.printMethodId,
            placement: 'Chest',
            side: 'FRONT',
            width: 25.5,
            height: 10,
            unit: 'CM',
            colorCount: 3,
            artworkRequired: true,
          })
          .expect(201)
      ).body;
      expect(d).toMatchObject({
        placement: 'Chest',
        width: '25.50',
        height: '10.00',
        unit: 'CM',
        colorCount: 3,
        artworkRequired: true,
      });
      expect(d.printMethod.code).toBe('DTF');
      const upd = await a.admin
        .patch(`/admin/sample-decorations/${d.id}`, {
          placement: 'Left chest',
          height: null,
          width: null,
          unit: null,
          notes: 'small',
        })
        .expect(200);
      expect(upd.body).toMatchObject({
        placement: 'Left chest',
        width: null,
        height: null,
        unit: null,
        notes: 'small',
      });
      expect(
        (await a.admin.get(`/admin/samples/${s.id}`)).body.decorations,
      ).toHaveLength(1);
      await a.admin.del(`/admin/sample-decorations/${d.id}`).expect(204);
      await a.admin.del(`/admin/sample-decorations/${d.id}`).expect(404);
      expect(
        (await a.admin.get(`/admin/samples/${s.id}`)).body.decorations,
      ).toEqual([]);
      expect(await auditActions(app, d.id)).toEqual(
        expect.arrayContaining([
          'sample_decoration.created',
          'sample_decoration.updated',
          'sample_decoration.removed',
        ]),
      );
    });

    it('validates decorations (unit with size, positive size, print method, artwork scope)', async () => {
      const s = await newDraft();
      const post = (body: object) =>
        a.admin.post(`/admin/samples/${s.id}/decorations`, body);
      await post({
        printMethodId: refs.printMethodId,
        placement: 'Chest',
        width: 10,
      }).expect(400); // unit required
      await post({
        printMethodId: refs.printMethodId,
        placement: 'Chest',
        width: -1,
        unit: 'CM',
      }).expect(400);
      await post({ printMethodId: refs.printMethodId, placement: '' }).expect(
        400,
      );
      await post({
        printMethodId: '3f2b1c0e-0000-4000-8000-000000000000',
        placement: 'Chest',
      }).expect(400);
      await post({
        printMethodId: refs.printMethodId,
        placement: 'Chest',
        side: 'TOP',
      }).expect(400);
      const other = await createCustomerWithBrand(a.admin);
      const foreign = (
        await a.admin
          .post('/admin/artworks', {
            brandId: other.brand.id,
            name: 'Foreign',
            assetId: (await a.admin.upload('ARTWORK').expect(201)).body.id,
          })
          .expect(201)
      ).body;
      const r = await post({
        printMethodId: refs.printMethodId,
        placement: 'Chest',
        artworkId: foreign.id,
      }).expect(400);
      expect(r.body.message).toMatch(/different brand or sample/);
    });

    it('selects accessories and labels/packaging, catalogue or custom, and not both', async () => {
      const s = await newDraft();
      const zip = (
        await a.admin
          .post(`/admin/samples/${s.id}/accessories`, {
            accessoryId: refs.accessoryId,
            quantity: 2,
            notes: 'metal',
          })
          .expect(201)
      ).body;
      const custom = (
        await a.admin
          .post(`/admin/samples/${s.id}/accessories`, {
            customName: 'Wooden toggle',
          })
          .expect(201)
      ).body;
      expect(zip.accessory.code).toBe('ZIP');
      expect(custom).toMatchObject({
        accessory: null,
        customName: 'Wooden toggle',
      });
      await a.admin.post(`/admin/samples/${s.id}/accessories`, {}).expect(400);
      await a.admin
        .post(`/admin/samples/${s.id}/accessories`, {
          accessoryId: refs.accessoryId,
          customName: 'x',
        })
        .expect(400);
      await a.admin
        .post(`/admin/samples/${s.id}/accessories`, {
          accessoryId: refs.accessoryId,
          quantity: 0,
        })
        .expect(400);
      const upd = await a.admin
        .patch(`/admin/sample-accessories/${zip.id}`, {
          quantity: 4,
          notes: null,
        })
        .expect(200);
      expect(upd.body).toMatchObject({ quantity: 4, notes: null });
      await a.admin
        .patch(`/admin/sample-accessories/${zip.id}`, {
          customName: 'rename catalogue item',
        })
        .expect(400);

      const poly = (
        await a.admin
          .post(`/admin/samples/${s.id}/components`, {
            componentOptionId: refs.componentId,
            notes: 'recycled',
          })
          .expect(201)
      ).body;
      expect(poly.componentOption.code).toBe('POLYBAG');
      expect(poly.category).toBe('PACKAGING');
      await a.admin
        .post(`/admin/samples/${s.id}/components`, {
          componentOptionId: refs.componentId,
        })
        .expect(409); // already selected
      await a.admin
        .post(`/admin/samples/${s.id}/components`, {
          customName: 'Gift ribbon',
        })
        .expect(201);
      await a.admin
        .post(`/admin/samples/${s.id}/components`, {
          componentOptionId: refs.componentId,
          customName: 'x',
        })
        .expect(400);

      const detail = (await a.admin.get(`/admin/samples/${s.id}`)).body;
      expect(detail.accessories).toHaveLength(2);
      expect(detail.components).toHaveLength(2);
      await a.admin.del(`/admin/sample-accessories/${custom.id}`).expect(204);
      await a.admin.del(`/admin/sample-components/${poly.id}`).expect(204);
      expect(await auditActions(app, zip.id)).toEqual(
        expect.arrayContaining([
          'sample_accessory.created',
          'sample_accessory.updated',
        ]),
      );
    });
  });

  describe('files attached to a sample', () => {
    it('attaches allowed asset types to a DRAFT sample, rejects others, detaches', async () => {
      const s = await newDraft();
      const ref = (await a.admin.upload('REFERENCE', 'ref.png').expect(201))
        .body;
      const att = (
        await a.admin
          .post(`/admin/samples/${s.id}/assets`, { assetId: ref.id })
          .expect(201)
      ).body;
      expect(att).toMatchObject({
        assetId: ref.id,
        targetType: 'SAMPLE',
        targetId: s.id,
      });
      await a.admin
        .post(`/admin/samples/${s.id}/assets`, { assetId: ref.id })
        .expect(409);
      const proof = (await a.admin.upload('PAYMENT_PROOF', 'p.png').expect(201))
        .body;
      const bad = await a.admin
        .post(`/admin/samples/${s.id}/assets`, { assetId: proof.id })
        .expect(400);
      expect(bad.body.message).toMatch(/cannot be attached to a sample/);
      const list = (
        await a.admin.get(`/admin/samples/${s.id}/assets`).expect(200)
      ).body;
      expect(list).toHaveLength(1);
      expect(JSON.stringify(list)).not.toMatch(/storageKey|assets\/\d{4}/);
      expect(
        (await a.admin.get(`/admin/samples/${s.id}`)).body.attachments,
      ).toHaveLength(1);
      const byTarget = (
        await a.admin
          .get(`/admin/assets?targetType=SAMPLE&targetId=${s.id}`)
          .expect(200)
      ).body;
      expect(byTarget.data.map((x: any) => x.id)).toEqual([ref.id]);
      await a.admin.del(`/admin/samples/${s.id}/assets/${att.id}`).expect(204);
      await a.admin.del(`/admin/samples/${s.id}/assets/${att.id}`).expect(404);
    });

    it('requires samples.manage even through the generic asset route (no side door)', async () => {
      const s = await newDraft();
      const asset = (await a.admin.upload('MOCKUP', 'm.png').expect(201)).body;
      const assetsOnly = await createUserAndLogin(app, {
        permissions: ['assets.manage', 'assets.read'],
      });
      const u = api(app, assetsOnly.accessToken);
      await u
        .post(`/admin/assets/${asset.id}/attachments`, {
          targetType: 'SAMPLE',
          targetId: s.id,
        })
        .expect(403);
      await u
        .post(`/admin/samples/${s.id}/assets`, { assetId: asset.id })
        .expect(403);
    });

    it('keeps the exactly-one-target rule for sample attachments in the database', async () => {
      const s = await newDraft();
      const { customer } = await createCustomerWithBrand(a.admin);
      const asset = (await a.admin.upload('REFERENCE', 'x.png').expect(201))
        .body;
      await expect(
        prisma.assetAttachment.create({
          data: { assetId: asset.id, sampleId: s.id, customerId: customer.id },
        }),
      ).rejects.toThrow();
    });

    it('locks files and spec parts once the sample is submitted', async () => {
      const draft = await completeDraft(app, a.admin, refs);
      const asset = (await a.admin.upload('REFERENCE', 'r.png').expect(201))
        .body;
      const att = (
        await a.admin
          .post(`/admin/samples/${draft.id}/assets`, { assetId: asset.id })
          .expect(201)
      ).body;
      const deco = (
        await a.admin
          .post(`/admin/samples/${draft.id}/decorations`, {
            printMethodId: refs.printMethodId,
            placement: 'Chest',
          })
          .expect(201)
      ).body;
      await a.sales.post(`/admin/samples/${draft.id}/submit`).expect(200);
      const second = (await a.admin.upload('REFERENCE', 'r2.png').expect(201))
        .body;
      await a.admin
        .post(`/admin/samples/${draft.id}/assets`, { assetId: second.id })
        .expect(409);
      await a.admin
        .del(`/admin/samples/${draft.id}/assets/${att.id}`)
        .expect(409);
      await a.admin
        .post(`/admin/samples/${draft.id}/decorations`, {
          printMethodId: refs.printMethodId,
          placement: 'Back',
        })
        .expect(409);
      await a.admin
        .patch(`/admin/sample-decorations/${deco.id}`, { placement: 'Hem' })
        .expect(409);
      await a.admin.del(`/admin/sample-decorations/${deco.id}`).expect(409);
      await a.admin
        .post(`/admin/samples/${draft.id}/accessories`, { customName: 'late' })
        .expect(409);
      await a.admin
        .post(`/admin/samples/${draft.id}/components`, { customName: 'late' })
        .expect(409);
      await a.admin.del(`/admin/assets/${asset.id}`).expect(409); // attached to a submitted sample
    });
  });

  describe('notes, assignment, terms, archive and revisions', () => {
    it('keeps notes internal by default, hides content from the audit log, and limits archiving', async () => {
      const s = await newDraft();
      const note = (
        await a.sales
          .post(`/admin/samples/${s.id}/notes`, {
            content: 'Customer is picky about the neckline',
          })
          .expect(201)
      ).body;
      expect(note).toMatchObject({
        visibility: 'INTERNAL',
        authorUserId: expect.any(String),
      });
      await a.admin
        .post(`/admin/samples/${s.id}/notes`, {
          content: 'Customer-facing update',
          visibility: 'CUSTOMER_VISIBLE',
        })
        .expect(201);
      expect(
        (await a.admin.get(`/admin/samples/${s.id}/notes`).expect(200)).body,
      ).toHaveLength(2);
      const internal = (
        await a.admin.get(`/admin/samples/${s.id}/notes?visibility=INTERNAL`)
      ).body;
      expect(internal.map((n: any) => n.id)).toEqual([note.id]);
      // the sample payload never carries notes
      expect(
        JSON.stringify((await a.admin.get(`/admin/samples/${s.id}`)).body),
      ).not.toMatch(/picky about the neckline/);
      const audit = await prisma.auditLog.findMany({
        where: { entityId: s.id },
      });
      expect(JSON.stringify(audit)).not.toMatch(/picky about the neckline/);

      const other = await createUserAndLogin(app, { roleCodes: ['SALES'] });
      await api(app, other.accessToken)
        .del(`/admin/samples/${s.id}/notes/${note.id}`)
        .expect(403); // not the author
      await a.admin.del(`/admin/samples/${s.id}/notes/${note.id}`).expect(204); // admin holds samples.assign
      await a.admin.del(`/admin/samples/${s.id}/notes/${note.id}`).expect(409);
      expect(
        (await a.admin.get(`/admin/samples/${s.id}/notes`)).body,
      ).toHaveLength(1);
      expect(await auditActions(app, s.id)).toEqual(
        expect.arrayContaining(['sample_note.created', 'sample_note.archived']),
      );
      await a.admin
        .post(`/admin/samples/${s.id}/notes`, { content: '' })
        .expect(400);
    });

    it('assigns a sales owner only to active staff who can manage samples, and audits it', async () => {
      const s = await newDraft();
      const ok = await a.admin
        .post(`/admin/samples/${s.id}/assign-sales`, { userId: a.salesUserId })
        .expect(200);
      expect(ok.body.assignedSales.id).toBe(a.salesUserId);
      const sewingUser = await prisma.user.findFirstOrThrow({
        where: { roles: { some: { role: { code: 'SEWING' } } } },
      });
      const bad = await a.admin
        .post(`/admin/samples/${s.id}/assign-sales`, { userId: sewingUser.id })
        .expect(400);
      expect(bad.body.message).toMatch(/samples\.manage/);
      await a.admin
        .post(`/admin/samples/${s.id}/assign-sales`, {
          userId: '3f2b1c0e-0000-4000-8000-000000000000',
        })
        .expect(400);
      const cleared = await a.admin
        .post(`/admin/samples/${s.id}/assign-sales`, { userId: null })
        .expect(200);
      expect(cleared.body.assignedSales).toBeNull();
      await a.sales
        .post(`/admin/samples/${s.id}/assign-sales`, { userId: a.salesUserId })
        .expect(403); // needs samples.assign
      const entries = await prisma.auditLog.findMany({
        where: { entityId: s.id, action: 'sample.sales_assigned' },
        orderBy: { createdAt: 'asc' },
      });
      expect(entries).toHaveLength(2);
      expect((entries[0]!.metadata as any).to).toBe(a.salesUserId);
    });

    it('records staff-assisted terms acceptance with its evidence and version', async () => {
      const s = await newDraft();
      const active = (
        await a.admin.get('/admin/terms?code=SAMPLE_TERMS').expect(200)
      ).body.find((t: any) => t.isActive);
      await a.admin
        .post(`/admin/samples/${s.id}/terms-acceptances`, {})
        .expect(400); // evidence required
      const acc = (
        await a.sales
          .post(`/admin/samples/${s.id}/terms-acceptances`, {
            sourceNote: 'WhatsApp, 21 Oct 14:05',
          })
          .expect(201)
      ).body;
      expect(acc).toMatchObject({
        termsVersionId: active.id,
        mode: 'STAFF_RECORDED_ON_BEHALF',
        sourceNote: 'WhatsApp, 21 Oct 14:05',
        code: 'SAMPLE_TERMS',
      });
      await a.sales
        .post(`/admin/samples/${s.id}/terms-acceptances`, {
          sourceNote: 'again',
        })
        .expect(409);
      const row = await prisma.sampleTermsAcceptance.findFirstOrThrow({
        where: { sampleId: s.id },
      });
      expect(row.recordedByStaffUserId).toBe(a.salesUserId);
      expect(row.acceptedByCustomerId).toBe(s.customer.id);
      expect(row.ipAddress).toBeTruthy();
      expect(
        (await a.admin.get(`/admin/samples/${s.id}`)).body.termsAcceptances[0],
      ).toMatchObject({ version: active.version });
      await expect(
        prisma.sampleTermsAcceptance.update({
          where: { id: row.id },
          data: { sourceNote: 'edited' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.sampleTermsAcceptance.delete({ where: { id: row.id } }),
      ).rejects.toThrow();
      expect(await auditActions(app, s.id)).toContain('sample.terms_accepted');
    });

    it('archives only DRAFT/CANCELLED/REJECTED samples, hides them, and blocks further edits', async () => {
      const s = await newDraft();
      await a.admin.del(`/admin/samples/${s.id}`).expect(204);
      await a.admin.del(`/admin/samples/${s.id}`).expect(409);
      await a.admin.patch(`/admin/samples/${s.id}`, { notes: 'x' }).expect(409);
      await a.admin.post(`/admin/samples/${s.id}/submit`).expect(409);
      expect(
        (await prisma.sample.findUniqueOrThrow({ where: { id: s.id } }))
          .archivedAt,
      ).not.toBeNull();
      const submitted = await completeDraft(app, a.admin, refs);
      await a.sales.post(`/admin/samples/${submitted.id}/submit`).expect(200);
      const r = await a.admin.del(`/admin/samples/${submitted.id}`).expect(409);
      expect(r.body.message).toMatch(/cancel or reject it first/);
      expect(await auditActions(app, s.id)).toContain('sample.archived');
    });

    it('creates a revision of a submitted sample by cloning, never editing the original', async () => {
      const refsLocal = refs;
      const draft = await completeDraft(app, a.admin, refsLocal, {
        notes: 'orig notes',
        customProductName: undefined,
      });
      await a.admin
        .post(`/admin/samples/${draft.id}/decorations`, {
          printMethodId: refsLocal.printMethodId,
          placement: 'Chest',
          colorCount: 2,
        })
        .expect(201);
      await a.admin
        .post(`/admin/samples/${draft.id}/accessories`, {
          accessoryId: refsLocal.accessoryId,
          quantity: 1,
        })
        .expect(201);
      await a.admin
        .post(`/admin/samples/${draft.id}/components`, {
          componentOptionId: refsLocal.componentId,
        })
        .expect(201);
      const ref = (await a.admin.upload('REFERENCE', 'ref.png').expect(201))
        .body;
      await a.admin
        .post(`/admin/samples/${draft.id}/assets`, { assetId: ref.id })
        .expect(201);
      await a.admin
        .post(`/admin/samples/${draft.id}/notes`, { content: 'private' })
        .expect(201);
      await a.admin.post(`/admin/samples/${draft.id}/revise`).expect(409); // a DRAFT is edited directly
      await a.sales.post(`/admin/samples/${draft.id}/submit`).expect(200);

      const rev = (
        await a.sales.post(`/admin/samples/${draft.id}/revise`).expect(201)
      ).body;
      expect(rev.sampleNumber).not.toBe(draft.sampleNumber);
      expect(rev).toMatchObject({
        status: 'DRAFT',
        revisionNumber: 2,
        revisionOfId: draft.id,
        notes: 'orig notes',
      });
      expect(rev.decorations).toHaveLength(1);
      expect(rev.accessories).toHaveLength(1);
      expect(rev.components).toHaveLength(1);
      expect(rev.attachments).toHaveLength(1);
      expect(rev.termsAcceptances).toEqual([]); // must be accepted again
      expect(rev.patternVersion.id).toBe(draft.patternVersionId);
      expect(
        (await a.admin.get(`/admin/samples/${rev.id}/notes`)).body,
      ).toEqual([]);
      expect(
        (await a.admin.get(`/admin/samples/${draft.id}`)).body.status,
      ).toBe('SUBMITTED');
      await a.sales.post(`/admin/samples/${draft.id}/revise`).expect(409); // one open revision at a time
      await a.admin
        .patch(`/admin/samples/${rev.id}`, { notes: 'changed in revision' })
        .expect(200);
      expect((await a.admin.get(`/admin/samples/${draft.id}`)).body.notes).toBe(
        'orig notes',
      );
      expect(await auditActions(app, rev.id)).toContain(
        'sample.revision_created',
      );
      // cancelling the revision frees the slot
      await a.admin
        .post(`/admin/samples/${rev.id}/cancel`, { reason: 'changed mind' })
        .expect(200);
      await a.sales.post(`/admin/samples/${draft.id}/revise`).expect(201);
    });
  });

  describe('authorization', () => {
    it('applies the seeded matrix for samples', async () => {
      const draft = await newDraft();
      await api(app, '').get('/admin/samples').expect(401);
      const patternMaker = await createUserAndLogin(app, {
        roleCodes: ['PATTERN_MAKER'],
      });
      const pm = api(app, patternMaker.accessToken);
      await pm.get('/admin/samples').expect(200);
      await pm.get(`/admin/samples/${draft.id}`).expect(200);
      await pm
        .post('/admin/samples', {
          customerId: draft.customer.id,
          brandId: draft.brand.id,
        })
        .expect(403);
      await pm.patch(`/admin/samples/${draft.id}`, { notes: 'x' }).expect(403);
      await pm.post(`/admin/samples/${draft.id}/submit`).expect(403);

      await a.sewing.get('/admin/samples').expect(403); // production roles have no sample access yet
      await a.sewing
        .post('/admin/samples', {
          customerId: draft.customer.id,
          brandId: draft.brand.id,
        })
        .expect(403);

      // finance can read but not change
      await a.finance.get(`/admin/samples/${draft.id}`).expect(200);
      await a.finance
        .patch(`/admin/samples/${draft.id}`, { notes: 'x' })
        .expect(403);
      await a.finance
        .post(`/admin/samples/${draft.id}/notes`, { content: 'x' })
        .expect(403);

      // sales can work a sample but not assign owners, manage terms or verify payments
      await a.sales
        .patch(`/admin/samples/${draft.id}`, { notes: 'ok' })
        .expect(200);
      await a.sales
        .post('/admin/terms', {
          code: 'SAMPLE_TERMS',
          title: 't',
          content: 'c',
        })
        .expect(403);
      await a.finance
        .post('/admin/terms', {
          code: 'SAMPLE_TERMS',
          title: 't',
          content: 'c',
        })
        .expect(403);
    });

    it('lets submit/review/approve be granted independently', async () => {
      const draft = await completeDraft(app, a.admin, refs);
      const onlyManage = await createUserAndLogin(app, {
        permissions: ['samples.read', 'samples.manage'],
      });
      const submitOnly = await createUserAndLogin(app, {
        permissions: ['samples.read', 'samples.submit'],
      });
      const reviewOnly = await createUserAndLogin(app, {
        permissions: ['samples.read', 'samples.review'],
      });
      await api(app, onlyManage.accessToken)
        .post(`/admin/samples/${draft.id}/submit`)
        .expect(403);
      await api(app, reviewOnly.accessToken)
        .post(`/admin/samples/${draft.id}/submit`)
        .expect(403);
      await api(app, submitOnly.accessToken)
        .post(`/admin/samples/${draft.id}/submit`)
        .expect(200);
      await api(app, submitOnly.accessToken)
        .post(`/admin/samples/${draft.id}/review`)
        .expect(403);
      await api(app, reviewOnly.accessToken)
        .post(`/admin/samples/${draft.id}/review`)
        .expect(200);
      await api(app, onlyManage.accessToken)
        .post(`/admin/samples/${draft.id}/hold`, { reason: 'x' })
        .expect(403);
      await api(app, reviewOnly.accessToken)
        .post(`/admin/samples/${draft.id}/hold`, { reason: 'waiting' })
        .expect(200);
    });
  });

  it('keeps a stable customer-facing boundary: factoryInstructions only on staff detail', async () => {
    const s = await newDraft({
      factoryInstructions: 'internal: use the old cutting table',
    });
    const detail = (await a.admin.get(`/admin/samples/${s.id}`)).body;
    expect(detail.factoryInstructions).toBe(
      'internal: use the old cutting table',
    );
    const list = (await a.admin.get(`/admin/samples?search=${s.sampleNumber}`))
      .body.data[0];
    expect(JSON.stringify(list)).not.toMatch(
      /factoryInstructions|internal: use/,
    );
    void acceptActiveTerms;
  });
});
