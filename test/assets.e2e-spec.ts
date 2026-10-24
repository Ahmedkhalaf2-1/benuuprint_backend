import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service.js';
import { StorageService } from '../src/modules/storage/storage.service.js';
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
  Buffer.from('benue-test-image-bytes'),
]);
const PDF = Buffer.from('%PDF-1.4\n%benue test pdf\n');

describe('Assets (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  let admin: { accessToken: string };
  const http = () => request(app.getHttpServer());
  const A = () => auth(admin.accessToken);

  const upload = (
    file: Buffer | null,
    opts: {
      filename?: string;
      contentType?: string;
      type?: string;
      token?: string;
      description?: string;
    } = {},
  ) => {
    let req = http()
      .post('/api/v1/admin/assets')
      .set(auth(opts.token ?? admin.accessToken));
    req = req.field('type', opts.type ?? 'LOGO');
    if (opts.description) req = req.field('description', opts.description);
    if (file)
      req = req.attach('file', file, {
        filename: opts.filename ?? 'logo.png',
        contentType: opts.contentType ?? 'image/png',
      });
    return req;
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
    admin = await loginSuperAdmin(app);
  });
  afterAll(() => app.close());

  describe('upload and metadata', () => {
    it('stores a valid file privately and exposes metadata without storage internals', async () => {
      const res = await upload(PNG, {
        description: 'brand logo',
        filename: 'Logo Final.png',
      }).expect(201);
      expect(res.body).toMatchObject({
        type: 'LOGO',
        originalName: 'Logo Final.png',
        mimeType: 'image/png',
        sizeBytes: PNG.length,
        description: 'brand logo',
        archivedAt: null,
      });
      expect(res.body.checksum).toMatch(/^[0-9a-f]{64}$/);
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(
        /storageKey|storage_key|storageProvider|assets\/\d{4}|\/tmp|benue-print-test-storage/,
      );

      const row = await prisma.asset.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.storageKey).toMatch(
        /^assets\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/,
      );
      expect(row.storageProvider).toBe('local');
      expect(await storage.exists(row.storageKey)).toBe(true);
      expect(await auditActions(app, res.body.id)).toContain('asset.uploaded');
    });

    it('identifies content by magic bytes, ignoring the declared type and extension', async () => {
      const asPng = await upload(PNG, {
        filename: 'definitely-not-a-png.exe',
        contentType: 'text/html',
      }).expect(201);
      expect(asPng.body.mimeType).toBe('image/png');
      const row = await prisma.asset.findUniqueOrThrow({
        where: { id: asPng.body.id },
      });
      expect(row.storageKey.endsWith('.png')).toBe(true);

      const pdf = await upload(PDF, {
        filename: 'sheet.png',
        contentType: 'image/png',
        type: 'TECH_PACK',
      }).expect(201);
      expect(pdf.body.mimeType).toBe('application/pdf');

      const fakeImage = await upload(
        Buffer.from('MZ\x90\x00 this is an executable'),
        { filename: 'logo.png', contentType: 'image/png' },
      );
      expect(fakeImage.status).toBe(415);
      const svg = await upload(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        ),
        {
          filename: 'x.svg',
          contentType: 'image/svg+xml',
        },
      );
      expect(svg.status).toBe(415);
      const html = await upload(
        Buffer.from('<html><script>alert(1)</script></html>'),
        { filename: 'x.png', contentType: 'image/png' },
      );
      expect(html.status).toBe(415);
    });

    it('rejects missing, empty and oversized files and invalid fields', async () => {
      await upload(null).expect(400);
      await upload(Buffer.alloc(0)).expect(400);
      const tooBig = Buffer.concat([PNG, Buffer.alloc(70 * 1024)]);
      const big = await upload(tooBig);
      expect(big.status).toBe(413);
      await upload(PNG, { type: 'NOT_A_TYPE' }).expect(400);
      await http()
        .post('/api/v1/admin/assets')
        .set(A())
        .field('type', 'LOGO')
        .attach('file', PNG, 'a.png')
        .field('storageKey', '../x')
        .expect(400);
      await http()
        .post('/api/v1/admin/assets')
        .set(A())
        .send({ type: 'LOGO' })
        .expect(400);
    });

    it('neutralises path traversal in file names and never uses them in the storage key', async () => {
      const res = await upload(PNG, {
        filename: '../../../etc/passwd.png',
      }).expect(201);
      expect(res.body.originalName).not.toMatch(/[\\/]|\.\./);
      const row = await prisma.asset.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.storageKey).not.toContain('passwd');
      expect(row.storageKey).not.toContain('..');
    });

    it('updates type and description with an audit entry', async () => {
      const a = await upload(PNG).expect(201);
      const upd = await http()
        .patch(`/api/v1/admin/assets/${a.body.id}`)
        .set(A())
        .send({ type: 'ARTWORK', description: null })
        .expect(200);
      expect(upd.body).toMatchObject({ type: 'ARTWORK', description: null });
      await http()
        .patch(`/api/v1/admin/assets/${a.body.id}`)
        .set(A())
        .send({ mimeType: 'text/html' })
        .expect(400);
      await http()
        .patch(`/api/v1/admin/assets/${a.body.id}`)
        .set(A())
        .send({ storageKey: 'x' })
        .expect(400);
      expect(await auditActions(app, a.body.id)).toContain('asset.updated');
    });

    it('lists with filters and pagination', async () => {
      const marker = uniq('lst').replace(/-/g, '');
      await upload(PNG, { filename: `${marker}-a.png`, type: 'MOCKUP' }).expect(
        201,
      );
      await upload(PNG, {
        filename: `${marker}-b.png`,
        type: 'REFERENCE',
      }).expect(201);
      const all = await http()
        .get(`/api/v1/admin/assets?search=${marker}`)
        .set(A())
        .expect(200);
      expect(all.body.meta.total).toBe(2);
      const mock = await http()
        .get(`/api/v1/admin/assets?search=${marker}&type=MOCKUP`)
        .set(A());
      expect(mock.body.data).toHaveLength(1);
      const page = await http()
        .get(`/api/v1/admin/assets?search=${marker}&pageSize=1`)
        .set(A());
      expect(page.body.data).toHaveLength(1);
      await http()
        .get('/api/v1/admin/assets?targetType=CUSTOMER')
        .set(A())
        .expect(400);
    });
  });

  describe('private access', () => {
    it('requires authentication and the right permission', async () => {
      const a = await upload(PNG).expect(201);
      await http()
        .post('/api/v1/admin/assets')
        .field('type', 'LOGO')
        .attach('file', PNG, 'a.png')
        .expect(401);
      await http().get('/api/v1/admin/assets').expect(401);
      await http()
        .get(`/api/v1/admin/assets/${a.body.id}/download-url`)
        .expect(401);

      const reader = await createUserAndLogin(app, {
        permissions: ['assets.read'],
      });
      await http()
        .get(`/api/v1/admin/assets/${a.body.id}`)
        .set(auth(reader.accessToken))
        .expect(200);
      await upload(PNG, { token: reader.accessToken }).expect(403);
      await http()
        .patch(`/api/v1/admin/assets/${a.body.id}`)
        .set(auth(reader.accessToken))
        .send({ type: 'OTHER' })
        .expect(403);
      await http()
        .delete(`/api/v1/admin/assets/${a.body.id}`)
        .set(auth(reader.accessToken))
        .expect(403);

      const nobody = await createUserAndLogin(app, {
        permissions: ['customers.read'],
      });
      await http()
        .get(`/api/v1/admin/assets/${a.body.id}`)
        .set(auth(nobody.accessToken))
        .expect(403);
      await http()
        .get(`/api/v1/admin/assets/${a.body.id}/download-url`)
        .set(auth(nobody.accessToken))
        .expect(403);

      // least privilege from the seeded matrix: PRINTING can read, SALES can upload, DELIVERY neither
      const printing = await createUserAndLogin(app, {
        roleCodes: ['PRINTING'],
      });
      await http()
        .get(`/api/v1/admin/assets/${a.body.id}`)
        .set(auth(printing.accessToken))
        .expect(200);
      await upload(PNG, { token: printing.accessToken }).expect(403);
      const sales = await createUserAndLogin(app, { roleCodes: ['SALES'] });
      await upload(PNG, { token: sales.accessToken }).expect(201);
      const delivery = await createUserAndLogin(app, {
        roleCodes: ['DELIVERY'],
      });
      await http()
        .get(`/api/v1/admin/assets/${a.body.id}`)
        .set(auth(delivery.accessToken))
        .expect(403);
    });

    it('serves bytes only through a short-lived signed URL with safe headers', async () => {
      const a = await upload(PNG, {
        filename: 'secret-artwork.png',
        type: 'ARTWORK',
      }).expect(201);
      const reader = await createUserAndLogin(app, {
        permissions: ['assets.read'],
      });
      const link = await http()
        .get(`/api/v1/admin/assets/${a.body.id}/download-url`)
        .set(auth(reader.accessToken))
        .expect(200);
      expect(link.body.url).toMatch(/^\/api\/v1\/storage\/local\/.+\..+$/);
      expect(new Date(link.body.expiresAt).getTime()).toBeGreaterThan(
        Date.now(),
      );
      expect(JSON.stringify(link.body)).not.toMatch(
        /benue-print-test-storage|\/tmp/,
      );

      const file = await http().get(link.body.url).buffer(true).expect(200);
      expect(Buffer.from(file.body).equals(PNG)).toBe(true);
      expect(file.headers['content-type']).toContain('image/png');
      expect(file.headers['content-disposition']).toMatch(
        /^attachment; filename="secret-artwork.png"/,
      );
      expect(file.headers['cache-control']).toContain('no-store');
      expect(file.headers['x-content-type-options']).toBe('nosniff');

      const inline = await http()
        .get(
          `/api/v1/admin/assets/${a.body.id}/download-url?disposition=inline`,
        )
        .set(auth(reader.accessToken));
      const inlineFile = await http().get(inline.body.url).expect(200);
      expect(inlineFile.headers['content-disposition']).toMatch(/^inline;/);
      await http()
        .get(`/api/v1/admin/assets/${a.body.id}/download-url?disposition=evil`)
        .set(auth(reader.accessToken))
        .expect(400);
    });

    it('rejects tampered, forged, expired and guessed download links', async () => {
      const a = await upload(PNG).expect(201);
      const row = await prisma.asset.findUniqueOrThrow({
        where: { id: a.body.id },
      });
      const { url } = await storage.getDownloadUrl(row.storageKey);
      const token = url.split('/').pop()!;
      const [body, sig] = token.split('.');

      await http().get(`/api/v1/storage/local/${body}.${sig}x`).expect(403);
      const forged = Buffer.from(
        JSON.stringify({ k: 'assets/2026/01/other.png', e: 4102444800 }),
      ).toString('base64url');
      await http().get(`/api/v1/storage/local/${forged}.${sig}`).expect(403);
      await http().get('/api/v1/storage/local/garbage').expect(403);
      await http().get(`/api/v1/storage/local/${a.body.id}`).expect(403);
      await http().get(`/api/v1/storage/local/${row.storageKey}`).expect(404);

      const expired = await storage.getDownloadUrl(row.storageKey, {
        expiresInSeconds: -5,
      });
      await http().get(expired.url).expect(403);
      // no static or id-based public route exists
      await http().get(`/api/v1/admin/assets/${a.body.id}/content`).expect(404);
      await http()
        .get(`/api/v1/admin/assets/${a.body.id}/content`)
        .set(A())
        .expect(404);
      await http().get(`/storage/${row.storageKey}`).expect(404);
      await http().get(`/${row.storageKey}`).expect(404);
    });

    it('archives: hidden, no longer downloadable, bytes retained', async () => {
      const a = await upload(PNG).expect(201);
      const row = await prisma.asset.findUniqueOrThrow({
        where: { id: a.body.id },
      });
      await http()
        .delete(`/api/v1/admin/assets/${a.body.id}`)
        .set(A())
        .expect(204);
      await http()
        .get(`/api/v1/admin/assets/${a.body.id}/download-url`)
        .set(A())
        .expect(404);
      await http()
        .patch(`/api/v1/admin/assets/${a.body.id}`)
        .set(A())
        .send({ type: 'OTHER' })
        .expect(404);
      await http()
        .delete(`/api/v1/admin/assets/${a.body.id}`)
        .set(A())
        .expect(404);
      const meta = await http()
        .get(`/api/v1/admin/assets/${a.body.id}`)
        .set(A())
        .expect(200);
      expect(meta.body.archivedAt).not.toBeNull();
      const list = await http()
        .get(
          `/api/v1/admin/assets?search=${encodeURIComponent(a.body.originalName)}&pageSize=100`,
        )
        .set(A());
      expect(list.body.data.map((x: any) => x.id)).not.toContain(a.body.id);
      expect(await storage.exists(row.storageKey)).toBe(true);
      expect(await auditActions(app, a.body.id)).toContain('asset.archived');
    });
  });

  describe('attachments to Phase 2 entities', () => {
    const makeTargets = async () => {
      const customer = (
        await http()
          .post('/api/v1/admin/customers')
          .set(A())
          .send({ displayName: `Att ${uniq('c')}` })
      ).body;
      const brand = (
        await http()
          .post(`/api/v1/admin/customers/${customer.id}/brands`)
          .set(A())
          .send({ name: 'AttBrand' })
      ).body;
      const code = () => uniq('T').toUpperCase().replace(/-/g, '_');
      const fabric = (
        await http()
          .post('/api/v1/admin/fabrics')
          .set(A())
          .send({ code: code(), name: 'Att Fabric' })
      ).body;
      const productType = (
        await http()
          .post('/api/v1/admin/product-types')
          .set(A())
          .send({ code: code(), name: 'Att Product' })
      ).body;
      const printMethod = (
        await http()
          .post('/api/v1/admin/print-methods')
          .set(A())
          .send({ code: code(), name: 'Att Print' })
      ).body;
      return { customer, brand, fabric, productType, printMethod };
    };

    it('attaches, lists by target, detaches, and audits each step', async () => {
      const t = await makeTargets();
      const pairs: [string, string][] = [
        ['CUSTOMER', t.customer.id],
        ['BRAND', t.brand.id],
        ['FABRIC', t.fabric.id],
        ['PRODUCT_TYPE', t.productType.id],
        ['PRINT_METHOD', t.printMethod.id],
      ];
      const a = await upload(PNG, { type: 'REFERENCE' }).expect(201);
      const attachmentIds: string[] = [];
      for (const [targetType, targetId] of pairs) {
        const res = await http()
          .post(`/api/v1/admin/assets/${a.body.id}/attachments`)
          .set(A())
          .send({ targetType, targetId })
          .expect(201);
        expect(res.body).toMatchObject({
          assetId: a.body.id,
          targetType,
          targetId,
        });
        attachmentIds.push(res.body.id);
        await http()
          .post(`/api/v1/admin/assets/${a.body.id}/attachments`)
          .set(A())
          .send({ targetType, targetId })
          .expect(409);
        const byTarget = await http()
          .get(
            `/api/v1/admin/assets?targetType=${targetType}&targetId=${targetId}`,
          )
          .set(A())
          .expect(200);
        expect(byTarget.body.data.map((x: any) => x.id)).toEqual([a.body.id]);
      }
      const attachments = await http()
        .get(`/api/v1/admin/assets/${a.body.id}/attachments`)
        .set(A())
        .expect(200);
      expect(attachments.body).toHaveLength(5);

      await http()
        .delete(
          `/api/v1/admin/assets/${a.body.id}/attachments/${attachmentIds[0]}`,
        )
        .set(A())
        .expect(204);
      await http()
        .delete(
          `/api/v1/admin/assets/${a.body.id}/attachments/${attachmentIds[0]}`,
        )
        .set(A())
        .expect(404);
      const empty = await http()
        .get(
          `/api/v1/admin/assets?targetType=CUSTOMER&targetId=${t.customer.id}`,
        )
        .set(A());
      expect(empty.body.data).toHaveLength(0);
      const actions = await auditActions(app, a.body.id);
      expect(actions.filter((x) => x === 'asset.attached')).toHaveLength(5);
      expect(actions).toContain('asset.detached');
    });

    it('rejects unknown, malformed and archived targets', async () => {
      const t = await makeTargets();
      const a = await upload(PNG).expect(201);
      const post = (body: object) =>
        http()
          .post(`/api/v1/admin/assets/${a.body.id}/attachments`)
          .set(A())
          .send(body);
      await post({
        targetType: 'CUSTOMER',
        targetId: '3f2b1c0e-0000-4000-8000-000000000000',
      }).expect(404);
      await post({ targetType: 'SAMPLE', targetId: t.customer.id }).expect(400);
      await post({ targetType: 'CUSTOMER', targetId: 'nope' }).expect(400);
      await post({ targetType: 'CUSTOMER' }).expect(400);
      await http()
        .delete(`/api/v1/admin/brands/${t.brand.id}`)
        .set(A())
        .expect(204);
      await post({ targetType: 'BRAND', targetId: t.brand.id }).expect(409);
      await http()
        .delete(`/api/v1/admin/fabrics/${t.fabric.id}`)
        .set(A())
        .expect(204);
      await post({ targetType: 'FABRIC', targetId: t.fabric.id }).expect(409);
    });

    it('enforces assets.manage for attaching', async () => {
      const t = await makeTargets();
      const a = await upload(PNG).expect(201);
      const reader = await createUserAndLogin(app, {
        permissions: ['assets.read'],
      });
      await http()
        .post(`/api/v1/admin/assets/${a.body.id}/attachments`)
        .set(auth(reader.accessToken))
        .send({ targetType: 'CUSTOMER', targetId: t.customer.id })
        .expect(403);
      await http()
        .get(`/api/v1/admin/assets/${a.body.id}/attachments`)
        .set(auth(reader.accessToken))
        .expect(200);
    });

    it('enforces exactly-one-target at the database level', async () => {
      const t = await makeTargets();
      const a = await upload(PNG).expect(201);
      await expect(
        prisma.assetAttachment.create({
          data: {
            assetId: a.body.id,
            customerId: t.customer.id,
            brandId: t.brand.id,
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.assetAttachment.create({ data: { assetId: a.body.id } }),
      ).rejects.toThrow();
    });
  });
});
