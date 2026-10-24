import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  auditActions,
  auth,
  createTestApp,
  createUserAndLogin,
  loginSuperAdmin,
  uniq,
} from './support/app.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('swatch'),
]);

describe('Master data (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { accessToken: string };
  const http = () => request(app.getHttpServer());
  const A = () => auth(admin.accessToken);
  const code = (p = 'T') => uniq(p).toUpperCase().replace(/-/g, '_');

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginSuperAdmin(app);
  });
  afterAll(() => app.close());

  // ---------------------------------------------------------------------------
  // The five code-addressed entities share behaviour; run one suite over all.
  // ---------------------------------------------------------------------------
  const simple = [
    {
      label: 'product types',
      path: 'product-types',
      create: () => ({
        code: code('PT'),
        name: 'Test Product',
        category: 'TOPS',
        defaultSampleFee: 150.5,
        sortOrder: 5,
      }),
      update: { name: 'Renamed', description: 'd', defaultSampleFee: null },
      check: (b: any) => expect(b.defaultSampleFee).toBe('150.50'),
      filter: 'category=TOPS',
      bad: { category: 'NOPE' },
      audit: 'product_type',
    },
    {
      label: 'print methods',
      path: 'print-methods',
      create: () => ({
        code: code('PM'),
        name: 'Test Print',
        type: 'PRINT',
        maxColors: 4,
        minQuantity: 12,
        supportsFullColor: false,
        setupFee: 99.99,
      }),
      update: { name: 'Renamed', maxColors: null, supportsFullColor: true },
      check: (b: any) => expect(b.setupFee).toBe('99.99'),
      filter: 'type=PRINT',
      bad: { maxColors: 0 },
      audit: 'print_method',
    },
    {
      label: 'accessories',
      path: 'accessories',
      create: () => ({
        code: code('AC'),
        name: 'Test Accessory',
        category: 'Trim',
        unit: 'PCS',
      }),
      update: { name: 'Renamed', unit: null },
      check: (b: any) => expect(b.category).toBe('Trim'),
      filter: 'category=trim',
      bad: { unit: 'x'.repeat(40) },
      audit: 'accessory',
    },
    {
      label: 'label/packaging components',
      path: 'component-options',
      create: () => ({
        code: code('CO'),
        name: 'Test Component',
        category: 'PACKAGING',
      }),
      update: { name: 'Renamed', category: 'LABEL' },
      check: (b: any) => expect(b.category).toBe('PACKAGING'),
      filter: 'category=PACKAGING',
      bad: { category: 'WRONG' },
      audit: 'component_option',
    },
    {
      label: 'size scales',
      path: 'size-scales',
      create: () => ({ code: code('SC'), name: 'Test Scale' }),
      update: { name: 'Renamed', description: 'kids' },
      check: (b: any) => expect(b.sizes).toEqual([]),
      filter: 'isActive=true',
      bad: { sortOrder: -1 },
      audit: 'size_scale',
    },
    {
      label: 'fabrics',
      path: 'fabrics',
      create: () => ({
        code: code('FB'),
        name: 'Test Fabric',
        composition: '100% cotton',
        minGsm: 150,
        maxGsm: 250,
        defaultGsm: 200,
        unit: 'KG',
      }),
      update: { name: 'Renamed', notes: 'n', composition: null },
      check: (b: any) => expect(b.referenceNumber).toMatch(/^FAB-\d{6}$/),
      filter: 'isActive=true',
      bad: { minGsm: 0 },
      audit: 'fabric',
    },
  ] as const;

  describe.each(simple)('$label', (cfg) => {
    const url = `/api/v1/admin/${cfg.path}`;

    it('creates, reads, updates and archives with audit entries', async () => {
      const body = cfg.create();
      const created = await http().post(url).set(A()).send(body).expect(201);
      expect(created.body.code).toBe(body.code);
      expect(created.body.isActive).toBe(true);
      expect(created.body.archivedAt).toBeNull();
      cfg.check(created.body);

      const got = await http()
        .get(`${url}/${created.body.id}`)
        .set(A())
        .expect(200);
      expect(got.body.id).toBe(created.body.id);

      const upd = await http()
        .patch(`${url}/${created.body.id}`)
        .set(A())
        .send(cfg.update)
        .expect(200);
      expect(upd.body.name).toBe('Renamed');
      expect(upd.body.code).toBe(body.code);

      await http().delete(`${url}/${created.body.id}`).set(A()).expect(204);
      const row = await (prisma as any)[
        {
          'product-types': 'productType',
          'print-methods': 'printMethod',
          accessories: 'accessory',
          'component-options': 'componentOption',
          'size-scales': 'sizeScale',
          fabrics: 'fabric',
        }[cfg.path]!
      ].findUnique({ where: { id: created.body.id } });
      expect(row.archivedAt).not.toBeNull();
      expect(row.isActive).toBe(false);

      await http().delete(`${url}/${created.body.id}`).set(A()).expect(409);
      await http()
        .patch(`${url}/${created.body.id}`)
        .set(A())
        .send({ name: 'After archive' })
        .expect(404);
      expect(await auditActions(app, created.body.id)).toEqual(
        expect.arrayContaining([
          `${cfg.audit}.created`,
          `${cfg.audit}.updated`,
          `${cfg.audit}.archived`,
        ]),
      );
    });

    it('rejects duplicate codes (including archived), invalid codes and immutable-field edits', async () => {
      const body = cfg.create();
      const created = await http().post(url).set(A()).send(body).expect(201);
      await http()
        .post(url)
        .set(A())
        .send({ ...cfg.create(), code: body.code })
        .expect(409);
      await http()
        .post(url)
        .set(A())
        .send({ ...cfg.create(), code: body.code.toLowerCase() })
        .expect(409); // normalised to upper-case
      await http().delete(`${url}/${created.body.id}`).set(A()).expect(204);
      await http()
        .post(url)
        .set(A())
        .send({ ...cfg.create(), code: body.code })
        .expect(409); // archived codes stay reserved
      await http()
        .post(url)
        .set(A())
        .send({ ...cfg.create(), code: 'bad code!' })
        .expect(400);
      await http()
        .post(url)
        .set(A())
        .send({ ...cfg.create(), code: 'X' })
        .expect(400);
      await http()
        .post(url)
        .set(A())
        .send({ ...cfg.create(), id: '3f2b1c0e-0000-4000-8000-000000000000' })
        .expect(400);
      await http()
        .post(url)
        .set(A())
        .send({ ...cfg.create(), ...cfg.bad })
        .expect(400);
      const live = await http()
        .post(url)
        .set(A())
        .send(cfg.create())
        .expect(201);
      await http()
        .patch(`${url}/${live.body.id}`)
        .set(A())
        .send({ code: 'NEWCODE' })
        .expect(400);
    });

    it('lists with search, active filter, archived handling, sorting and pagination', async () => {
      const marker = code('MK').replace(/_/g, '');
      const make = (suffix: string, extra: object = {}) =>
        http()
          .post(url)
          .set(A())
          .send({
            ...cfg.create(),
            code: `${marker}_${suffix}`,
            name: `${marker} ${suffix}`,
            ...extra,
          })
          .expect(201);
      const [a, b, c] = [await make('A'), await make('B'), await make('C')];
      await http()
        .patch(`${url}/${b.body.id}`)
        .set(A())
        .send({ isActive: false })
        .expect(200);
      await http().delete(`${url}/${c.body.id}`).set(A()).expect(204);

      const live = await http()
        .get(`${url}?search=${marker}`)
        .set(A())
        .expect(200);
      expect(
        live.body.data
          .map((x: any) => x.id)
          .sort((a: string, b: string) => a.localeCompare(b)),
      ).toEqual(
        [a.body.id, b.body.id].sort((a: string, b: string) =>
          a.localeCompare(b),
        ),
      );
      const active = await http()
        .get(`${url}?search=${marker}&isActive=true`)
        .set(A());
      expect(active.body.data.map((x: any) => x.id)).toEqual([a.body.id]);
      const inactive = await http()
        .get(`${url}?search=${marker}&isActive=false`)
        .set(A());
      expect(inactive.body.data.map((x: any) => x.id)).toEqual([b.body.id]);
      const withArchived = await http()
        .get(`${url}?search=${marker}&includeArchived=true`)
        .set(A());
      expect(withArchived.body.meta.total).toBe(3);
      const byCode = await http()
        .get(`${url}?search=${marker.toLowerCase()}_a`)
        .set(A());
      expect(byCode.body.data.map((x: any) => x.id)).toEqual([a.body.id]);

      const sorted = await http()
        .get(
          `${url}?search=${marker}&includeArchived=true&sortBy=name&sortOrder=desc&pageSize=2`,
        )
        .set(A());
      expect(sorted.body.data.map((x: any) => x.name)).toEqual([
        `${marker} C`,
        `${marker} B`,
      ]);
      expect(sorted.body.meta).toEqual({ page: 1, pageSize: 2, total: 3 });
      await http().get(`${url}?${cfg.filter}`).set(A()).expect(200);
      await http().get(`${url}?sortBy=secret`).set(A()).expect(400);
      await http().get(`${url}?isActive=maybe`).set(A()).expect(400);
    });

    it('enforces read vs manage permissions', async () => {
      const created = await http()
        .post(url)
        .set(A())
        .send(cfg.create())
        .expect(201);
      await http().get(url).expect(401);
      const reader = await createUserAndLogin(app, {
        permissions: ['master_data.read'],
      });
      await http().get(url).set(auth(reader.accessToken)).expect(200);
      await http()
        .get(`${url}/${created.body.id}`)
        .set(auth(reader.accessToken))
        .expect(200);
      await http()
        .post(url)
        .set(auth(reader.accessToken))
        .send(cfg.create())
        .expect(403);
      await http()
        .patch(`${url}/${created.body.id}`)
        .set(auth(reader.accessToken))
        .send({ name: 'x' })
        .expect(403);
      await http()
        .delete(`${url}/${created.body.id}`)
        .set(auth(reader.accessToken))
        .expect(403);
      const stranger = await createUserAndLogin(app, {
        permissions: ['customers.read'],
      });
      await http().get(url).set(auth(stranger.accessToken)).expect(403);
      const manager = await createUserAndLogin(app, {
        permissions: ['master_data.manage'],
      });
      await http()
        .post(url)
        .set(auth(manager.accessToken))
        .send(cfg.create())
        .expect(201);
      await http().get(url).set(auth(manager.accessToken)).expect(403); // manage does not imply read
    });
  });

  it('applies the seeded least-privilege matrix: operations read, only ADMIN manages', async () => {
    const url = '/api/v1/admin/accessories';
    const cases: [string, number, number][] = [
      ['ADMIN', 200, 201],
      ['SALES', 200, 403],
      ['FABRIC', 200, 403],
      ['PATTERN_MAKER', 200, 403],
      ['SEWING', 200, 403],
      ['FINANCE', 200, 403],
      ['DELIVERY', 403, 403],
    ];
    for (const [role, readStatus, writeStatus] of cases) {
      const u = await createUserAndLogin(app, { roleCodes: [role] });
      await http().get(url).set(auth(u.accessToken)).expect(readStatus);
      await http()
        .post(url)
        .set(auth(u.accessToken))
        .send({ code: code('RM'), name: `by ${role}` })
        .expect(writeStatus);
    }
  });

  // ---------------------------------------------------------------------------
  describe('fabric specifics', () => {
    it('validates the GSM range consistently on create and update', async () => {
      const f = (extra: object) =>
        http()
          .post('/api/v1/admin/fabrics')
          .set(A())
          .send({ code: code('G'), name: 'G', ...extra });
      await f({ minGsm: 300, maxGsm: 200 }).expect(400);
      await f({ minGsm: 100, maxGsm: 200, defaultGsm: 50 }).expect(400);
      await f({ minGsm: 100, maxGsm: 200, defaultGsm: 250 }).expect(400);
      const ok = await f({ minGsm: 100, maxGsm: 200, defaultGsm: 150 }).expect(
        201,
      );
      await http()
        .patch(`/api/v1/admin/fabrics/${ok.body.id}`)
        .set(A())
        .send({ maxGsm: 120 })
        .expect(400); // default 150 > new max
      await http()
        .patch(`/api/v1/admin/fabrics/${ok.body.id}`)
        .set(A())
        .send({ minGsm: 90, maxGsm: 300 })
        .expect(200);
    });

    it('manages colours/swatches with unique names per fabric, custom values allowed later', async () => {
      const fabric = (
        await http()
          .post('/api/v1/admin/fabrics')
          .set(A())
          .send({ code: code('FC'), name: 'Colour Fabric' })
          .expect(201)
      ).body;
      const red = await http()
        .post(`/api/v1/admin/fabrics/${fabric.id}/colors`)
        .set(A())
        .send({
          name: 'Red',
          hex: '#ff0000',
          pantone: '18-1664 TPX',
          internalCode: 'R01',
        })
        .expect(201);
      expect(red.body).toMatchObject({
        fabricId: fabric.id,
        hex: '#ff0000',
        isAvailable: true,
      });
      await http()
        .post(`/api/v1/admin/fabrics/${fabric.id}/colors`)
        .set(A())
        .send({ name: 'RED' })
        .expect(409);
      await http()
        .post(`/api/v1/admin/fabrics/${fabric.id}/colors`)
        .set(A())
        .send({ name: 'Bad', hex: 'red' })
        .expect(400);
      await http()
        .post(`/api/v1/admin/fabrics/${fabric.id}/colors`)
        .set(A())
        .send({
          name: 'Blue',
          swatchAssetId: '3f2b1c0e-0000-4000-8000-000000000000',
        })
        .expect(400);

      const other = (
        await http()
          .post('/api/v1/admin/fabrics')
          .set(A())
          .send({ code: code('FC'), name: 'Other' })
          .expect(201)
      ).body;
      await http()
        .post(`/api/v1/admin/fabrics/${other.id}/colors`)
        .set(A())
        .send({ name: 'Red' })
        .expect(201); // same name, other fabric

      const upd = await http()
        .patch(`/api/v1/admin/fabric-colors/${red.body.id}`)
        .set(A())
        .send({ isAvailable: false, pantone: null, hex: '#aa0000' })
        .expect(200);
      expect(upd.body).toMatchObject({
        isAvailable: false,
        pantone: null,
        hex: '#aa0000',
      });

      const list = await http()
        .get(`/api/v1/admin/fabrics/${fabric.id}/colors`)
        .set(A())
        .expect(200);
      expect(list.body.map((c: any) => c.name)).toEqual(['Red']);
      const detail = await http()
        .get(`/api/v1/admin/fabrics/${fabric.id}`)
        .set(A());
      expect(detail.body.colors).toHaveLength(1);

      await http()
        .delete(`/api/v1/admin/fabric-colors/${red.body.id}`)
        .set(A())
        .expect(204);
      await http()
        .delete(`/api/v1/admin/fabric-colors/${red.body.id}`)
        .set(A())
        .expect(404);
      expect(
        (await http().get(`/api/v1/admin/fabrics/${fabric.id}/colors`).set(A()))
          .body,
      ).toHaveLength(0);
      expect(
        (
          await http()
            .get(
              `/api/v1/admin/fabrics/${fabric.id}/colors?includeArchived=true`,
            )
            .set(A())
        ).body,
      ).toHaveLength(1);
      await http()
        .post(`/api/v1/admin/fabrics/${fabric.id}/colors`)
        .set(A())
        .send({ name: 'Red' })
        .expect(201); // name free after archive
      expect(await auditActions(app, red.body.id)).toEqual(
        expect.arrayContaining([
          'fabric_color.created',
          'fabric_color.updated',
          'fabric_color.archived',
        ]),
      );

      const reader = await createUserAndLogin(app, {
        permissions: ['master_data.read'],
      });
      await http()
        .get(`/api/v1/admin/fabrics/${fabric.id}/colors`)
        .set(auth(reader.accessToken))
        .expect(200);
      await http()
        .post(`/api/v1/admin/fabrics/${fabric.id}/colors`)
        .set(auth(reader.accessToken))
        .send({ name: 'Nope' })
        .expect(403);
      await http()
        .post(
          '/api/v1/admin/fabrics/3f2b1c0e-0000-4000-8000-000000000000/colors',
        )
        .set(A())
        .send({ name: 'X' })
        .expect(404);
    });

    it('accepts only an image asset of type FABRIC_SWATCH as a swatch', async () => {
      const fabric = (
        await http()
          .post('/api/v1/admin/fabrics')
          .set(A())
          .send({ code: code('SW'), name: 'Swatch Fabric' })
      ).body;
      const up = (type: string) =>
        http()
          .post('/api/v1/admin/assets')
          .set(A())
          .field('type', type)
          .attach('file', PNG, 'swatch.png');
      const swatch = (await up('FABRIC_SWATCH').expect(201)).body;
      const logo = (await up('LOGO').expect(201)).body;
      await http()
        .post(`/api/v1/admin/fabrics/${fabric.id}/colors`)
        .set(A())
        .send({ name: 'WrongType', swatchAssetId: logo.id })
        .expect(400);
      const ok = await http()
        .post(`/api/v1/admin/fabrics/${fabric.id}/colors`)
        .set(A())
        .send({ name: 'WithSwatch', swatchAssetId: swatch.id })
        .expect(201);
      expect(ok.body.swatchAssetId).toBe(swatch.id);
      await http()
        .patch(`/api/v1/admin/fabric-colors/${ok.body.id}`)
        .set(A())
        .send({ swatchAssetId: logo.id })
        .expect(400);
      const cleared = await http()
        .patch(`/api/v1/admin/fabric-colors/${ok.body.id}`)
        .set(A())
        .send({ swatchAssetId: null })
        .expect(200);
      expect(cleared.body.swatchAssetId).toBeNull();
    });

    it('records recommended/allowed product compatibility without restricting anything else', async () => {
      const pt = (
        await http()
          .post('/api/v1/admin/product-types')
          .set(A())
          .send({ code: code('PC'), name: 'Compat Product' })
      ).body;
      const f1 = (
        await http()
          .post('/api/v1/admin/fabrics')
          .set(A())
          .send({ code: code('F1'), name: 'Compat One' })
      ).body;
      const f2 = (
        await http()
          .post('/api/v1/admin/fabrics')
          .set(A())
          .send({ code: code('F2'), name: 'Compat Two' })
      ).body;
      const base = `/api/v1/admin/product-types/${pt.id}/fabrics`;

      const set1 = await http()
        .put(`${base}/${f1.id}`)
        .set(A())
        .send({ isRecommended: true, notes: 'best option' })
        .expect(200);
      expect(set1.body).toMatchObject({
        isRecommended: true,
        isAllowed: true,
        notes: 'best option',
        fabricCode: f1.code,
      });
      await http()
        .put(`${base}/${f2.id}`)
        .set(A())
        .send({ isAllowed: false })
        .expect(200);
      const upd = await http()
        .put(`${base}/${f1.id}`)
        .set(A())
        .send({ isRecommended: false, notes: null })
        .expect(200);
      expect(upd.body).toMatchObject({ isRecommended: false, notes: null });

      const list = await http().get(base).set(A()).expect(200);
      expect(
        list.body
          .map((x: any) => x.fabricId)
          .sort((a: string, b: string) => a.localeCompare(b)),
      ).toEqual(
        [f1.id, f2.id].sort((a: string, b: string) => a.localeCompare(b)),
      );
      const filtered = await http()
        .get(`/api/v1/admin/fabrics?productTypeId=${pt.id}`)
        .set(A());
      expect(filtered.body.data.map((x: any) => x.id)).toEqual([f1.id]); // f2 is not allowed
      const fabricDetail = await http()
        .get(`/api/v1/admin/fabrics/${f1.id}`)
        .set(A());
      expect(fabricDetail.body.productTypes[0]).toMatchObject({
        productTypeId: pt.id,
        isAllowed: true,
      });

      await http()
        .put(`${base}/3f2b1c0e-0000-4000-8000-000000000000`)
        .set(A())
        .send({})
        .expect(404);
      await http()
        .put(`${base}/${f1.id}`)
        .set(A())
        .send({ isRecommended: 'yes' })
        .expect(400);
      await http().delete(`${base}/${f2.id}`).set(A()).expect(204);
      await http().delete(`${base}/${f2.id}`).set(A()).expect(404);
      expect(await auditActions(app, pt.id)).toEqual(
        expect.arrayContaining([
          'product_type_fabric.set',
          'product_type_fabric.removed',
        ]),
      );

      const reader = await createUserAndLogin(app, {
        permissions: ['master_data.read'],
      });
      await http().get(base).set(auth(reader.accessToken)).expect(200);
      await http()
        .put(`${base}/${f1.id}`)
        .set(auth(reader.accessToken))
        .send({})
        .expect(403);
    });
  });

  describe('size scales', () => {
    it('adds, edits and archives sizes within a scale', async () => {
      const scale = (
        await http()
          .post('/api/v1/admin/size-scales')
          .set(A())
          .send({ code: code('KIDS'), name: 'Kids' })
          .expect(201)
      ).body;
      const s1 = await http()
        .post(`/api/v1/admin/size-scales/${scale.id}/sizes`)
        .set(A())
        .send({ code: 'K2', name: '2 years', sortOrder: 20 })
        .expect(201);
      await http()
        .post(`/api/v1/admin/size-scales/${scale.id}/sizes`)
        .set(A())
        .send({ code: 'K1', name: '1 year', sortOrder: 10 })
        .expect(201);
      await http()
        .post(`/api/v1/admin/size-scales/${scale.id}/sizes`)
        .set(A())
        .send({ code: 'K2', name: 'dup' })
        .expect(409);
      const detail = await http()
        .get(`/api/v1/admin/size-scales/${scale.id}`)
        .set(A());
      expect(detail.body.sizes.map((s: any) => s.code)).toEqual(['K1', 'K2']);
      await http()
        .patch(`/api/v1/admin/size-options/${s1.body.id}`)
        .set(A())
        .send({ name: 'Two years', code: 'X' })
        .expect(400);
      const upd = await http()
        .patch(`/api/v1/admin/size-options/${s1.body.id}`)
        .set(A())
        .send({ name: 'Two years' })
        .expect(200);
      expect(upd.body.name).toBe('Two years');
      await http()
        .delete(`/api/v1/admin/size-options/${s1.body.id}`)
        .set(A())
        .expect(204);
      await http()
        .delete(`/api/v1/admin/size-options/${s1.body.id}`)
        .set(A())
        .expect(404);
      expect(
        (await http().get(`/api/v1/admin/size-scales/${scale.id}`).set(A()))
          .body.sizes,
      ).toHaveLength(1);
      expect(await auditActions(app, s1.body.id)).toEqual(
        expect.arrayContaining([
          'size_option.created',
          'size_option.updated',
          'size_option.archived',
        ]),
      );
      await http()
        .post(
          '/api/v1/admin/size-scales/3f2b1c0e-0000-4000-8000-000000000000/sizes',
        )
        .set(A())
        .send({ code: 'ZZ', name: 'ZZ' })
        .expect(404);
    });
  });

  describe('read-only catalog (configurator view)', () => {
    it('exposes only active, customer-safe data', async () => {
      const pt = (
        await http()
          .post('/api/v1/admin/product-types')
          .set(A())
          .send({
            code: code('CP'),
            name: 'Cat Product',
            defaultSampleFee: 500,
          })
      ).body;
      const fabric = (
        await http()
          .post('/api/v1/admin/fabrics')
          .set(A())
          .send({
            code: code('CF'),
            name: 'Cat Fabric',
            notes: 'internal supplier note',
          })
      ).body;
      await http()
        .post(`/api/v1/admin/fabrics/${fabric.id}/colors`)
        .set(A())
        .send({ name: 'Visible', hex: '#00ff00' })
        .expect(201);
      await http()
        .post(`/api/v1/admin/fabrics/${fabric.id}/colors`)
        .set(A())
        .send({ name: 'Unavailable', isAvailable: false })
        .expect(201);
      await http()
        .put(`/api/v1/admin/product-types/${pt.id}/fabrics/${fabric.id}`)
        .set(A())
        .send({ isRecommended: true })
        .expect(200);
      const hidden = (
        await http()
          .post('/api/v1/admin/product-types')
          .set(A())
          .send({ code: code('CH'), name: 'Hidden Product', isActive: false })
      ).body;
      const pm = (
        await http()
          .post('/api/v1/admin/print-methods')
          .set(A())
          .send({
            code: code('CM'),
            name: 'Cat Print',
            setupFee: 300,
            notes: 'secret margin',
          })
      ).body;

      const reader = await createUserAndLogin(app, {
        permissions: ['master_data.read'],
      });
      const types = await http()
        .get('/api/v1/catalog/product-types')
        .set(auth(reader.accessToken))
        .expect(200);
      expect(types.body.map((t: any) => t.id)).toContain(pt.id);
      expect(types.body.map((t: any) => t.id)).not.toContain(hidden.id);
      expect(JSON.stringify(types.body)).not.toMatch(
        /defaultSampleFee|sortOrder|archivedAt|createdAt/,
      );

      const fabrics = await http()
        .get('/api/v1/catalog/fabrics')
        .set(auth(reader.accessToken))
        .expect(200);
      const item = fabrics.body.find((f: any) => f.id === fabric.id);
      expect(item.colors.map((c: any) => c.name)).toEqual(['Visible']);
      expect(item.productTypes).toEqual([
        { productTypeId: pt.id, isRecommended: true },
      ]);
      expect(JSON.stringify(fabrics.body)).not.toMatch(
        /internal supplier note|referenceNumber|notes/,
      );

      const methods = await http()
        .get('/api/v1/catalog/print-methods')
        .set(auth(reader.accessToken))
        .expect(200);
      expect(methods.body.find((m: any) => m.id === pm.id)).toBeDefined();
      expect(JSON.stringify(methods.body)).not.toMatch(
        /setupFee|secret margin|notes/,
      );

      const scales = await http()
        .get('/api/v1/catalog/size-scales')
        .set(auth(reader.accessToken))
        .expect(200);
      expect(
        scales.body
          .find((s: any) => s.code === 'STANDARD')
          .sizes.map((s: any) => s.code),
      ).toEqual(['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'ONE_SIZE']);

      await http().get('/api/v1/catalog/fabrics').expect(401);
      const stranger = await createUserAndLogin(app, {
        permissions: ['customers.read'],
      });
      await http()
        .get('/api/v1/catalog/fabrics')
        .set(auth(stranger.accessToken))
        .expect(403);
    });
  });

  describe('seeded reference data', () => {
    it('contains the specified product types, fabrics, methods, accessories, components and sizes', async () => {
      // Look rows up by code (not by page) so the check is independent of how much test data exists.
      const present = async (model: string, codes: string[]) =>
        (
          await (prisma as any)[model].findMany({
            where: { code: { in: codes } },
            select: { code: true },
          })
        )
          .map((r: { code: string }) => r.code)
          .sort((a: string, b: string) => a.localeCompare(b));
      const expectAll = async (model: string, codes: string[]) =>
        expect(await present(model, codes)).toEqual(
          [...codes].sort((a, b) => a.localeCompare(b)),
        );
      await expectAll('productType', [
        'TEE',
        'POLO',
        'HOODIE',
        'CREWNECK',
        'PANTS',
        'SHORTS',
        'JACKET',
        'QUARTER_ZIP',
        'SHIRT',
        'TANK',
        'CROP_TOP',
        'DRESS',
        'CAP',
      ]);
      await expectAll('fabric', [
        'MILTON',
        'SUMMER_MILTON',
        'BOULEVARD',
        'PARASOLA',
        'SINGLE_LYCRA',
        'FRENCH_TERRY',
        'LINEN',
        'WATERPROOF',
        'GABARDINE',
        'RUSSETA',
        'BEKA_POLO',
        'INTERLOCK',
        'OTHER_NOT_SURE',
      ]);
      await expectAll('printMethod', [
        'DTF',
        'VINYL',
        'SCREEN_PRINT',
        'PUFF_PRINT',
        'EMBROIDERY',
      ]);
      await expectAll('accessory', [
        'ZIP',
        'DRAWCORD',
        'PATCH',
        'BUTTON',
        'RIB',
        'ELASTIC',
        'LABEL',
      ]);
      await expectAll('componentOption', [
        'NECK_LABEL',
        'CARE_LABEL',
        'SIZE_LABEL',
        'HANG_TAG',
        'POLYBAG',
        'BOX',
      ]);

      // and they are reachable through the API
      const fabric = await http()
        .get('/api/v1/admin/fabrics?search=FRENCH_TERRY')
        .set(A())
        .expect(200);
      expect(fabric.body.data[0].code).toBe('FRENCH_TERRY');
      const hoodie = await prisma.productType.findUniqueOrThrow({
        where: { code: 'HOODIE' },
      });
      const forHoodie = await http()
        .get(`/api/v1/admin/fabrics?productTypeId=${hoodie.id}&search=FRENCH`)
        .set(A());
      expect(forHoodie.body.data.map((f: any) => f.code)).toContain(
        'FRENCH_TERRY',
      );
    });
  });
});
