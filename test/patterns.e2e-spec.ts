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
  Buffer.from('pattern'),
]);

describe('Patterns (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: { accessToken: string };
  const http = () => request(app.getHttpServer());
  const A = () => auth(admin.accessToken);
  const code = (p = 'PAT') => uniq(p).toUpperCase().replace(/-/g, '_');

  const productType = async () =>
    (
      await http()
        .post('/api/v1/admin/product-types')
        .set(A())
        .send({ code: code('PT'), name: 'Pattern Product' })
        .expect(201)
    ).body;
  const newPattern = async (productTypeId: string, extra: object = {}) =>
    (
      await http()
        .post('/api/v1/admin/patterns')
        .set(A())
        .send({
          code: code(),
          name: 'Regular Tee',
          productTypeId,
          fitType: 'REGULAR',
          ...extra,
        })
        .expect(201)
    ).body;
  const uploadPattern = async () =>
    (
      await http()
        .post('/api/v1/admin/assets')
        .set(A())
        .field('type', 'PATTERN')
        .attach('file', PNG, 'pattern.png')
        .expect(201)
    ).body;
  const attach = (assetId: string, versionId: string) =>
    http()
      .post(`/api/v1/admin/assets/${assetId}/attachments`)
      .set(A())
      .send({ targetType: 'PATTERN_VERSION', targetId: versionId });
  /** Approving needs at least one attached PATTERN file, so the helper attaches one first. */
  const ensureFile = async (versionId: string) => {
    const asset = await uploadPattern();
    await attach(asset.id, versionId); // ignored when the version is no longer a DRAFT
  };
  const approve = (patternId: string, versionId: string) => {
    let headers = A();
    let custom = false;
    const url = `/api/v1/admin/patterns/${patternId}/versions/${versionId}/approve`;
    const builder = {
      set(h: Record<string, string>) {
        headers = h;
        custom = true;
        return builder;
      },
      async expect(status: number) {
        if (!custom) await ensureFile(versionId);
        return http().post(url).set(headers).expect(status);
      },
    };
    return builder;
  };
  const approveRaw = (patternId: string, versionId: string) =>
    http()
      .post(`/api/v1/admin/patterns/${patternId}/versions/${versionId}/approve`)
      .set(A());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginSuperAdmin(app);
  });
  afterAll(() => app.close());

  it('creates a pattern with a reference number and an initial DRAFT version', async () => {
    const pt = await productType();
    const p = await newPattern(pt.id, {
      description: 'd',
      versionNotes: 'first cut',
    });
    expect(p.referenceNumber).toMatch(/^PAT-\d{6}$/);
    expect(p).toMatchObject({
      status: 'DRAFT',
      currentVersionId: null,
      currentVersionNumber: null,
      fitType: 'REGULAR',
    });
    expect(p.productType).toMatchObject({ id: pt.id, code: pt.code });
    expect(p.versions).toHaveLength(1);
    expect(p.versions[0]).toMatchObject({
      versionNumber: 1,
      status: 'DRAFT',
      notes: 'first cut',
      approvedAt: null,
    });
    expect(await auditActions(app, p.id)).toContain('pattern.created');
    expect(await auditActions(app, p.versions[0].id)).toContain(
      'pattern_version.created',
    );
  });

  it('supports several patterns per product type with filtering and search', async () => {
    const pt = await productType();
    const marker = uniq('mk').replace(/-/g, '');
    const a = await newPattern(pt.id, { name: `${marker} Oversized` });
    const b = await newPattern(pt.id, { name: `${marker} Slim` });
    const other = await newPattern((await productType()).id, {
      name: `${marker} Elsewhere`,
    });
    const list = await http()
      .get(`/api/v1/admin/patterns?productTypeId=${pt.id}`)
      .set(A())
      .expect(200);
    expect(
      list.body.data
        .map((x: any) => x.id)
        .sort((a: string, b: string) => a.localeCompare(b)),
    ).toEqual([a.id, b.id].sort((a: string, b: string) => a.localeCompare(b)));
    const search = await http()
      .get(`/api/v1/admin/patterns?search=${marker}`)
      .set(A());
    expect(search.body.meta.total).toBe(3);
    const byRef = await http()
      .get(`/api/v1/admin/patterns?search=${other.referenceNumber}`)
      .set(A());
    expect(byRef.body.data.map((x: any) => x.id)).toEqual([other.id]);
    const byStatus = await http()
      .get(`/api/v1/admin/patterns?search=${marker}&status=ACTIVE`)
      .set(A());
    expect(byStatus.body.meta.total).toBe(0);
  });

  it('rejects duplicate codes, unknown product types and unknown fields', async () => {
    const pt = await productType();
    const p = await newPattern(pt.id);
    const post = (body: object) =>
      http().post('/api/v1/admin/patterns').set(A()).send(body);
    await post({ code: p.code, name: 'dup', productTypeId: pt.id }).expect(409);
    await post({
      code: code(),
      name: 'x',
      productTypeId: '3f2b1c0e-0000-4000-8000-000000000000',
    }).expect(400);
    await post({ code: code(), name: 'x', productTypeId: 'nope' }).expect(400);
    await post({
      code: code(),
      name: 'x',
      productTypeId: pt.id,
      status: 'ACTIVE',
    }).expect(400);
    await http()
      .patch(`/api/v1/admin/patterns/${p.id}`)
      .set(A())
      .send({ code: 'NEWCODE' })
      .expect(400);
    await http()
      .patch(`/api/v1/admin/patterns/${p.id}`)
      .set(A())
      .send({ status: 'ACTIVE' })
      .expect(400);
  });

  it('versions: draft is editable, approval promotes it, approved versions are immutable', async () => {
    const p = await newPattern((await productType()).id);
    const v1 = p.versions[0];
    const edited = await http()
      .patch(`/api/v1/admin/patterns/${p.id}/versions/${v1.id}`)
      .set(A())
      .send({ notes: 'tweaked' })
      .expect(200);
    expect(edited.body.notes).toBe('tweaked');

    const approved = await approve(p.id, v1.id).expect(200);
    expect(approved.body).toMatchObject({
      status: 'ACTIVE',
      currentVersionId: v1.id,
      currentVersionNumber: 1,
    });
    expect(approved.body.versions[0]).toMatchObject({ status: 'APPROVED' });
    expect(approved.body.versions[0].approvedAt).not.toBeNull();
    expect(approved.body.versions[0].approvedByUserId).toBeTruthy();

    await http()
      .patch(`/api/v1/admin/patterns/${p.id}/versions/${v1.id}`)
      .set(A())
      .send({ notes: 'silent overwrite' })
      .expect(409);
    await approve(p.id, v1.id).expect(409);
    const row = await prisma.patternVersion.findUniqueOrThrow({
      where: { id: v1.id },
    });
    expect(row.notes).toBe('tweaked');
    expect(await auditActions(app, v1.id)).toEqual(
      expect.arrayContaining([
        'pattern_version.created',
        'pattern_version.updated',
        'pattern_version.approved',
      ]),
    );
  });

  it('keeps history: a new version supersedes the previous on approval, one draft at a time', async () => {
    const p = await newPattern((await productType()).id);
    await approve(p.id, p.versions[0].id).expect(200);

    const v2 = await http()
      .post(`/api/v1/admin/patterns/${p.id}/versions`)
      .set(A())
      .send({ notes: 'tighter sleeve' })
      .expect(201);
    expect(v2.body).toMatchObject({ versionNumber: 2, status: 'DRAFT' });
    await http()
      .post(`/api/v1/admin/patterns/${p.id}/versions`)
      .set(A())
      .send({})
      .expect(409); // v2 still a draft
    // current stays v1 until v2 is approved
    expect(
      (await http().get(`/api/v1/admin/patterns/${p.id}`).set(A())).body
        .currentVersionNumber,
    ).toBe(1);

    const after = await approve(p.id, v2.body.id).expect(200);
    expect(after.body).toMatchObject({
      currentVersionId: v2.body.id,
      currentVersionNumber: 2,
    });
    expect(
      after.body.versions.map((v: any) => [v.versionNumber, v.status]),
    ).toEqual([
      [2, 'APPROVED'],
      [1, 'SUPERSEDED'],
    ]);
    await http()
      .patch(`/api/v1/admin/patterns/${p.id}/versions/${p.versions[0].id}`)
      .set(A())
      .send({ notes: 'rewrite history' })
      .expect(409);
    await approve(p.id, p.versions[0].id).expect(409); // cannot re-approve a superseded version
    const v3 = await http()
      .post(`/api/v1/admin/patterns/${p.id}/versions`)
      .set(A())
      .send({})
      .expect(201);
    expect(v3.body.versionNumber).toBe(3);
  });

  it('numbers versions safely under concurrent requests', async () => {
    const p = await newPattern((await productType()).id);
    await approve(p.id, p.versions[0].id).expect(200);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        http()
          .post(`/api/v1/admin/patterns/${p.id}/versions`)
          .set(A())
          .send({}),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    const versions = await prisma.patternVersion.findMany({
      where: { patternId: p.id },
    });
    expect(versions.map((v) => v.versionNumber).sort((a, b) => a - b)).toEqual([
      1, 2,
    ]);
  });

  it('freezes files of approved versions (attach, detach, archive all blocked)', async () => {
    const p = await newPattern((await productType()).id);
    const v1 = p.versions[0];
    const asset = await uploadPattern();
    const att = await attach(asset.id, v1.id).expect(201);
    expect(att.body).toMatchObject({
      targetType: 'PATTERN_VERSION',
      targetId: v1.id,
    });
    const listed = await http()
      .get(`/api/v1/admin/assets?targetType=PATTERN_VERSION&targetId=${v1.id}`)
      .set(A());
    expect(listed.body.data.map((a: any) => a.id)).toEqual([asset.id]);

    await approveRaw(p.id, v1.id).expect(200);
    const second = await uploadPattern();
    await attach(second.id, v1.id).expect(409);
    await http()
      .delete(`/api/v1/admin/assets/${asset.id}/attachments/${att.body.id}`)
      .set(A())
      .expect(409);
    await http()
      .delete(`/api/v1/admin/assets/${asset.id}`)
      .set(A())
      .expect(409);
    expect(
      (
        await http()
          .get(
            `/api/v1/admin/assets?targetType=PATTERN_VERSION&targetId=${v1.id}`,
          )
          .set(A())
      ).body.data,
    ).toHaveLength(1);

    // the next version starts empty and editable
    const v2 = await http()
      .post(`/api/v1/admin/patterns/${p.id}/versions`)
      .set(A())
      .send({})
      .expect(201);
    const att2 = await attach(second.id, v2.body.id).expect(201);
    await http()
      .delete(`/api/v1/admin/assets/${second.id}/attachments/${att2.body.id}`)
      .set(A())
      .expect(204);

    await approve(p.id, v2.body.id).expect(200);
    await http()
      .delete(`/api/v1/admin/assets/${asset.id}/attachments/${att.body.id}`)
      .set(A())
      .expect(409); // v1 is SUPERSEDED, still frozen
  });

  it('refuses to approve a version that has no attached PATTERN file', async () => {
    const p = await newPattern((await productType()).id);
    const v1 = p.versions[0];
    const blocked = await approveRaw(p.id, v1.id).expect(409);
    expect(blocked.body.message).toMatch(/no attached PATTERN file/);
    expect(
      (await prisma.patternVersion.findUniqueOrThrow({ where: { id: v1.id } }))
        .status,
    ).toBe('DRAFT');

    // only PATTERN assets count: a reference photo is not a pattern file
    const photo = (
      await http()
        .post('/api/v1/admin/assets')
        .set(A())
        .field('type', 'REFERENCE')
        .attach('file', PNG, 'photo.png')
        .expect(201)
    ).body;
    await attach(photo.id, v1.id).expect(201);
    await approveRaw(p.id, v1.id).expect(409);

    // an archived pattern file does not count either
    const file = await uploadPattern();
    await attach(file.id, v1.id).expect(201);
    await http().delete(`/api/v1/admin/assets/${file.id}`).set(A()).expect(204);
    await approveRaw(p.id, v1.id).expect(409);

    const good = await uploadPattern();
    await attach(good.id, v1.id).expect(201);
    await approveRaw(p.id, v1.id).expect(200);
  });

  it('cannot detach the last pattern file and then approve (draft files stay editable)', async () => {
    const p = await newPattern((await productType()).id);
    const v1 = p.versions[0];
    const file = await uploadPattern();
    const att = await attach(file.id, v1.id).expect(201);
    await http()
      .delete(`/api/v1/admin/assets/${file.id}/attachments/${att.body.id}`)
      .set(A())
      .expect(204);
    await approveRaw(p.id, v1.id).expect(409);
  });

  it('changes the product type only before any approval', async () => {
    const [pt1, pt2] = [await productType(), await productType()];
    const p = await newPattern(pt1.id);
    const moved = await http()
      .patch(`/api/v1/admin/patterns/${p.id}`)
      .set(A())
      .send({ productTypeId: pt2.id, name: 'Moved', fitType: null })
      .expect(200);
    expect(moved.body.productType.id).toBe(pt2.id);
    expect(moved.body.fitType).toBeNull();
    await http()
      .patch(`/api/v1/admin/patterns/${p.id}`)
      .set(A())
      .send({ productTypeId: '3f2b1c0e-0000-4000-8000-000000000000' })
      .expect(400);
    await approve(p.id, p.versions[0].id).expect(200);
    await http()
      .patch(`/api/v1/admin/patterns/${p.id}`)
      .set(A())
      .send({ productTypeId: pt1.id })
      .expect(409);
    await http()
      .patch(`/api/v1/admin/patterns/${p.id}`)
      .set(A())
      .send({ name: 'Renamed after approval' })
      .expect(200);
    expect(await auditActions(app, p.id)).toContain('pattern.updated');
  });

  it('archives patterns softly, keeping versions and blocking further changes', async () => {
    const p = await newPattern((await productType()).id);
    await approve(p.id, p.versions[0].id).expect(200);
    await http().delete(`/api/v1/admin/patterns/${p.id}`).set(A()).expect(204);
    await http().delete(`/api/v1/admin/patterns/${p.id}`).set(A()).expect(409);
    const row = await prisma.pattern.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({ status: 'ARCHIVED' });
    expect(row.archivedAt).not.toBeNull();
    expect(
      await prisma.patternVersion.count({ where: { patternId: p.id } }),
    ).toBe(1);

    const hidden = await http()
      .get(`/api/v1/admin/patterns?search=${p.code}`)
      .set(A());
    expect(hidden.body.data).toHaveLength(0);
    const shown = await http()
      .get(`/api/v1/admin/patterns?search=${p.code}&includeArchived=true`)
      .set(A());
    expect(shown.body.data).toHaveLength(1);
    await http().get(`/api/v1/admin/patterns/${p.id}`).set(A()).expect(200);
    await http()
      .patch(`/api/v1/admin/patterns/${p.id}`)
      .set(A())
      .send({ name: 'x' })
      .expect(404);
    await http()
      .post(`/api/v1/admin/patterns/${p.id}/versions`)
      .set(A())
      .send({})
      .expect(404);
    expect(await auditActions(app, p.id)).toContain('pattern.archived');
  });

  it('404s for unknown patterns and versions of other patterns', async () => {
    const pt = await productType();
    const [p1, p2] = [await newPattern(pt.id), await newPattern(pt.id)];
    await http()
      .get('/api/v1/admin/patterns/3f2b1c0e-0000-4000-8000-000000000000')
      .set(A())
      .expect(404);
    await approve(p1.id, p2.versions[0].id).expect(404);
    await http()
      .patch(`/api/v1/admin/patterns/${p1.id}/versions/${p2.versions[0].id}`)
      .set(A())
      .send({ notes: 'x' })
      .expect(404);
  });

  it('separates read, manage and approval rights', async () => {
    const pt = await productType();
    const p = await newPattern(pt.id);
    await http().get('/api/v1/admin/patterns').expect(401);

    const reader = await createUserAndLogin(app, {
      permissions: ['master_data.read'],
    });
    await http()
      .get('/api/v1/admin/patterns')
      .set(auth(reader.accessToken))
      .expect(200);
    await http()
      .get(`/api/v1/admin/patterns/${p.id}`)
      .set(auth(reader.accessToken))
      .expect(200);
    await http()
      .post('/api/v1/admin/patterns')
      .set(auth(reader.accessToken))
      .send({ code: code(), name: 'x', productTypeId: pt.id })
      .expect(403);
    await approve(p.id, p.versions[0].id)
      .set(auth(reader.accessToken))
      .expect(403);
    await http()
      .post(`/api/v1/admin/patterns/${p.id}/versions`)
      .set(auth(reader.accessToken))
      .send({})
      .expect(403);
    await http()
      .delete(`/api/v1/admin/patterns/${p.id}`)
      .set(auth(reader.accessToken))
      .expect(403);

    const writerOnly = await createUserAndLogin(app, {
      permissions: ['patterns.manage'],
    });
    await http()
      .get('/api/v1/admin/patterns')
      .set(auth(writerOnly.accessToken))
      .expect(403);
    await http()
      .post('/api/v1/admin/patterns')
      .set(auth(writerOnly.accessToken))
      .send({ code: code(), name: 'by writer', productTypeId: pt.id })
      .expect(201);

    const patternMaker = await createUserAndLogin(app, {
      roleCodes: ['PATTERN_MAKER'],
    });
    await http()
      .post('/api/v1/admin/patterns')
      .set(auth(patternMaker.accessToken))
      .send({ code: code(), name: 'by pattern maker', productTypeId: pt.id })
      .expect(201);
    const sales = await createUserAndLogin(app, { roleCodes: ['SALES'] });
    await http()
      .get('/api/v1/admin/patterns')
      .set(auth(sales.accessToken))
      .expect(200);
    await http()
      .post('/api/v1/admin/patterns')
      .set(auth(sales.accessToken))
      .send({ code: code(), name: 'by sales', productTypeId: pt.id })
      .expect(403);
  });
});
