import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  auditActions,
  createTestApp,
  createUserAndLogin,
} from './support/app.js';
import {
  api,
  completeDraft,
  createCustomerWithBrand,
  lookupRefs,
  makeActors,
  type Actors,
  type Refs,
} from './support/factory.js';

describe('Artwork versioning (e2e)', () => {
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

  const asset = async (type = 'ARTWORK', name = 'art.png') =>
    (await a.admin.upload(type, name).expect(201)).body;

  /** Brand artwork with v1 plus a sample of that brand to record approvals against. */
  const setup = async () => {
    const d = await completeDraft(app, a.admin, refs);
    const first = await asset();
    const artwork = (
      await a.admin
        .post('/admin/artworks', {
          brandId: d.brandId,
          name: 'Chest logo',
          purpose: 'FRONT_PRINT',
          assetId: first.id,
          notes: 'first draft',
        })
        .expect(201)
    ).body;
    return { d, first, artwork, v1: artwork.versions[0] };
  };
  const requestApproval = (sampleId: string, versionId: string) =>
    a.sales.post(`/admin/samples/${sampleId}/approvals`, {
      type: 'ARTWORK',
      artworkVersionId: versionId,
    });
  const approveVersion = async (
    sampleId: string,
    versionId: string,
    note = 'Customer OK via WhatsApp',
  ) => {
    const req = (await requestApproval(sampleId, versionId).expect(201)).body;
    return a.sales
      .post(`/admin/approvals/${req.id}/approve`, { sourceNote: note })
      .expect(200);
  };

  it('creates an artwork with version 1 as a DRAFT and never exposes storage details', async () => {
    const { artwork, first } = await setup();
    expect(artwork).toMatchObject({
      name: 'Chest logo',
      purpose: 'FRONT_PRINT',
      approvedVersionId: null,
    });
    expect(artwork.versions).toHaveLength(1);
    expect(artwork.versions[0]).toMatchObject({
      versionNumber: 1,
      status: 'DRAFT',
      notes: 'first draft',
      approvedAt: null,
    });
    expect(artwork.versions[0].asset).toMatchObject({
      assetId: first.id,
      type: 'ARTWORK',
      mimeType: 'image/png',
    });
    expect(JSON.stringify(artwork)).not.toMatch(
      /storageKey|storage_key|assets\/\d{4}|url/i,
    );
    expect(await auditActions(app, artwork.id)).toContain('artwork.created');
    expect(await auditActions(app, artwork.versions[0].id)).toContain(
      'artwork_version.created',
    );
  });

  it('validates ownership, purpose and the file used', async () => {
    const d = await completeDraft(app, a.admin, refs);
    const f = await asset();
    const post = (body: object) =>
      a.admin.post('/admin/artworks', { name: 'X', assetId: f.id, ...body });
    await post({}).expect(400); // neither owner
    await post({ brandId: d.brandId, sampleId: d.id }).expect(400); // both owners
    await post({ brandId: d.brandId, purpose: 'WALLPAPER' }).expect(400);
    await post({ brandId: '3f2b1c0e-0000-4000-8000-000000000000' }).expect(404);
    await post({
      brandId: d.brandId,
      assetId: '3f2b1c0e-0000-4000-8000-000000000000',
    }).expect(400);
    const proof = await asset('PAYMENT_PROOF');
    const bad = await post({ brandId: d.brandId, assetId: proof.id }).expect(
      400,
    );
    expect(bad.body.message).toMatch(/cannot be used as artwork/);
    await post({ brandId: d.brandId, id: 'x' }).expect(400);
    // sample-owned artwork
    const owned = (await post({ sampleId: d.id }).expect(201)).body;
    expect(owned).toMatchObject({ sampleId: d.id, brandId: null });
    await expect(
      prisma.artwork.create({
        data: { name: 'both', brandId: d.brandId, sampleId: d.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.artwork.create({ data: { name: 'none' } }),
    ).rejects.toThrow();
  });

  it('uploads new versions (never in place) and allows only one open draft', async () => {
    const { artwork, v1 } = await setup();
    const second = await asset('ARTWORK', 'v2.png');
    await a.admin
      .post(`/admin/artworks/${artwork.id}/versions`, { assetId: second.id })
      .expect(409); // v1 still a draft
    const edited = await a.admin
      .patch(`/admin/artwork-versions/${v1.id}`, { notes: 'tweaked' })
      .expect(200);
    expect(edited.body.notes).toBe('tweaked');
    await a.admin
      .patch(`/admin/artwork-versions/${v1.id}`, { assetId: second.id })
      .expect(400); // file cannot be swapped
  });

  it('approval promotes a draft; a newer approval supersedes it; exactly one version is ever approved', async () => {
    const { d, artwork, v1 } = await setup();
    const approved = await approveVersion(d.id, v1.id);
    expect(approved.body).toMatchObject({
      type: 'ARTWORK',
      status: 'APPROVED',
      mode: 'STAFF_RECORDED_ON_BEHALF',
      staffRecorded: true,
    });
    let current = (await a.admin.get(`/admin/artworks/${artwork.id}`)).body;
    expect(current.approvedVersionId).toBe(v1.id);
    expect(current.versions[0]).toMatchObject({ status: 'APPROVED' });
    expect(current.versions[0].approvedAt).not.toBeNull();

    const f2 = await asset('ARTWORK', 'v2.png');
    const v2 = (
      await a.admin
        .post(`/admin/artworks/${artwork.id}/versions`, {
          assetId: f2.id,
          notes: 'new colours',
        })
        .expect(201)
    ).body;
    expect(v2).toMatchObject({ versionNumber: 2, status: 'DRAFT' });
    expect(
      (await a.admin.get(`/admin/artworks/${artwork.id}`)).body
        .approvedVersionId,
    ).toBe(v1.id); // v1 stays production-facing until v2 is approved
    await approveVersion(d.id, v2.id);
    current = (await a.admin.get(`/admin/artworks/${artwork.id}`)).body;
    expect(current.approvedVersionId).toBe(v2.id);
    expect(
      current.versions.map((v: any) => [v.versionNumber, v.status]),
    ).toEqual([
      [2, 'APPROVED'],
      [1, 'SUPERSEDED'],
    ]);
    expect(current.versions[1].supersededAt).not.toBeNull();
    expect(await auditActions(app, v1.id)).toEqual(
      expect.arrayContaining([
        'artwork_version.approved',
        'artwork_version.superseded',
      ]),
    );

    // the database also refuses a second APPROVED version
    await expect(
      prisma.artworkVersion.update({
        where: { id: v1.id },
        data: { status: 'APPROVED' },
      }),
    ).rejects.toThrow();
  });

  it('makes approved versions immutable, in the API and in the database', async () => {
    const { d, artwork, v1 } = await setup();
    await approveVersion(d.id, v1.id);
    await a.admin
      .patch(`/admin/artwork-versions/${v1.id}`, { notes: 'sneaky edit' })
      .expect(409);
    await expect(
      prisma.artworkVersion.update({
        where: { id: v1.id },
        data: { notes: 'sneaky' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.artworkVersion.update({
        where: { id: v1.id },
        data: { status: 'DRAFT' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.artworkVersion.update({
        where: { id: v1.id },
        data: { status: 'REJECTED' },
      }),
    ).rejects.toThrow();
    const other = await asset('ARTWORK', 'swap.png');
    await expect(
      prisma.artworkVersion.update({
        where: { id: v1.id },
        data: { assetId: other.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.artworkVersion.delete({ where: { id: v1.id } }),
    ).rejects.toThrow();
    // superseded and rejected are final as well
    const f2 = await asset('ARTWORK', 'v2.png');
    const v2 = (
      await a.admin
        .post(`/admin/artworks/${artwork.id}/versions`, { assetId: f2.id })
        .expect(201)
    ).body;
    await approveVersion(d.id, v2.id);
    await expect(
      prisma.artworkVersion.update({
        where: { id: v1.id },
        data: { status: 'APPROVED' },
      }),
    ).rejects.toThrow();
    // the approved file cannot be archived out from under production
    const row = await prisma.artworkVersion.findUniqueOrThrow({
      where: { id: v2.id },
    });
    expect(
      (await a.admin.del(`/admin/assets/${row.assetId}`).expect(409)).body
        .message,
    ).toMatch(/artwork version/);
  });

  it('records a rejection with its reason and keeps the file as history', async () => {
    const { d, v1, artwork } = await setup();
    const req = (await requestApproval(d.id, v1.id).expect(201)).body;
    await a.sales
      .post(`/admin/approvals/${req.id}/reject`, {
        sourceNote: 'Email 21 Oct',
        responseNote: 'Colours are wrong',
      })
      .expect(200);
    const version = (await a.admin.get(`/admin/artworks/${artwork.id}`)).body
      .versions[0];
    expect(version).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'Colours are wrong',
    });
    expect(version.rejectedAt).not.toBeNull();
    // a replacement can now be uploaded
    const f2 = await asset('ARTWORK', 'fixed.png');
    await a.admin
      .post(`/admin/artworks/${artwork.id}/versions`, { assetId: f2.id })
      .expect(201);
    await a.admin
      .patch(`/admin/artwork-versions/${v1.id}`, { notes: 'x' })
      .expect(409);
  });

  it('handles concurrent decisions on one version safely', async () => {
    const { d, v1, artwork } = await setup();
    const req = (await requestApproval(d.id, v1.id).expect(201)).body;
    const results = await Promise.all([
      a.sales.post(`/admin/approvals/${req.id}/approve`, {
        sourceNote: 'WhatsApp',
      }),
      a.sales.post(`/admin/approvals/${req.id}/reject`, {
        sourceNote: 'WhatsApp',
        responseNote: 'no',
      }),
      a.sales.post(`/admin/approvals/${req.id}/approve`, {
        sourceNote: 'WhatsApp again',
      }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const final = (await a.admin.get(`/admin/artworks/${artwork.id}`)).body
      .versions[0].status;
    expect(['APPROVED', 'REJECTED']).toContain(final);
    expect(
      await prisma.approval.count({
        where: { artworkVersionId: v1.id, status: { not: 'PENDING' } },
      }),
    ).toBe(1);
  });

  it('refuses artwork of another brand, an archived artwork and duplicate pending requests', async () => {
    const { d, v1, artwork } = await setup();
    const other = await createCustomerWithBrand(a.admin);
    const foreignAsset = await asset();
    const foreign = (
      await a.admin
        .post('/admin/artworks', {
          brandId: other.brand.id,
          name: 'Foreign',
          assetId: foreignAsset.id,
        })
        .expect(201)
    ).body;
    await requestApproval(d.id, foreign.versions[0].id).expect(400);
    await requestApproval(d.id, v1.id).expect(201);
    await requestApproval(d.id, v1.id).expect(409); // already pending
    const pending = await prisma.approval.findFirstOrThrow({
      where: { artworkVersionId: v1.id },
    });
    await a.sales.post(`/admin/approvals/${pending.id}/cancel`).expect(200);
    await a.sales
      .post(`/admin/approvals/${pending.id}/approve`, { sourceNote: 'late' })
      .expect(409);
    await a.admin.del(`/admin/artworks/${artwork.id}`).expect(204);
    await requestApproval(d.id, v1.id).expect(409);
    await a.admin.del(`/admin/artworks/${artwork.id}`).expect(409);
  });

  it('blocks archiving artwork that a decoration uses, and clones sample-owned artwork into revisions', async () => {
    const { d, artwork } = await setup();
    const deco = (
      await a.admin
        .post(`/admin/samples/${d.id}/decorations`, {
          printMethodId: refs.printMethodId,
          placement: 'Chest',
          artworkId: artwork.id,
        })
        .expect(201)
    ).body;
    const archive = await a.admin
      .del(`/admin/artworks/${artwork.id}`)
      .expect(409);
    expect(archive.body.message).toMatch(/used by 1 sample decoration/);

    const owned = await completeDraft(app, a.admin, refs);
    const f = await asset('ARTWORK', 'owned.png');
    const sampleArt = (
      await a.admin
        .post('/admin/artworks', {
          sampleId: owned.id,
          name: 'One-off',
          assetId: f.id,
        })
        .expect(201)
    ).body;
    await a.admin
      .post(`/admin/samples/${owned.id}/decorations`, {
        printMethodId: refs.printMethodId,
        placement: 'Back',
        artworkId: sampleArt.id,
        artworkRequired: true,
      })
      .expect(201);
    await a.sales.post(`/admin/samples/${owned.id}/submit`).expect(200);
    const rev = (
      await a.sales.post(`/admin/samples/${owned.id}/revise`).expect(201)
    ).body;
    const revisedArtworkId = rev.decorations[0].artworkId;
    expect(revisedArtworkId).toBeTruthy();
    expect(revisedArtworkId).not.toBe(sampleArt.id);
    const clone = (await a.admin.get(`/admin/artworks/${revisedArtworkId}`))
      .body;
    expect(clone).toMatchObject({ sampleId: rev.id, name: 'One-off' });
    expect(clone.versions[0]).toMatchObject({
      versionNumber: 1,
      status: 'DRAFT',
    });
    expect(clone.versions[0].asset.assetId).toBe(f.id); // same private file, new draft version
    void deco;
  });

  it('lists with filters and enforces permissions', async () => {
    const { d, artwork } = await setup();
    const list = (
      await a.admin
        .get(`/admin/artworks?brandId=${d.brandId}&purpose=FRONT_PRINT`)
        .expect(200)
    ).body;
    expect(list.data.map((x: any) => x.id)).toEqual([artwork.id]);
    expect(
      (await a.admin.get('/admin/artworks?search=chest logo').expect(200)).body
        .data.length,
    ).toBeGreaterThan(0);
    const reader = await createUserAndLogin(app, {
      permissions: ['samples.read'],
    });
    const r = api(app, reader.accessToken);
    await r.get(`/admin/artworks/${artwork.id}`).expect(200);
    await r
      .post('/admin/artworks', {
        brandId: d.brandId,
        name: 'x',
        assetId: (await asset()).id,
      })
      .expect(403);
    await r
      .post(`/admin/artworks/${artwork.id}/versions`, {
        assetId: (await asset()).id,
      })
      .expect(403);
    await a.sewing.get('/admin/artworks').expect(403);
    await api(app, '').get('/admin/artworks').expect(401);
    // only people with approvals.manage can record an artwork decision
    const v = artwork.versions[0];
    await a.finance
      .post(`/admin/samples/${d.id}/approvals`, {
        type: 'ARTWORK',
        artworkVersionId: v.id,
      })
      .expect(403);
  });
});
