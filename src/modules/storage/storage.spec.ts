import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageProvider } from './local-storage.provider.js';
import {
  createSignedToken,
  deriveSigningKey,
  verifySignedToken,
} from './signed-url.js';
import { assertValidStorageKey } from './storage.service.js';

describe('storage keys', () => {
  it.each([
    'assets/2026/10/3f2b1c0e-0000-4000-8000-000000000000.png',
    'a/b/c',
    'file.pdf',
  ])('accepts %s', (key) => {
    expect(() => assertValidStorageKey(key)).not.toThrow();
  });

  it.each([
    '../etc/passwd',
    'assets/../../etc/passwd',
    '/absolute/path',
    'assets//double',
    'assets/./dot',
    'assets\\windows',
    'assets/%2e%2e/x',
    'assets/UPPER.png',
    'assets/a b.png',
    'assets/null\u0000.png',
    '',
    'a/'.repeat(120),
  ])('rejects %j', (key) => {
    expect(() => assertValidStorageKey(key)).toThrow('Invalid storage key');
  });
});

describe('signed tokens', () => {
  const key = deriveSigningKey('unit-test-secret-unit-test-secret-1234');
  const now = new Date('2026-01-01T00:00:00Z');
  const exp = Math.floor(now.getTime() / 1000) + 60;

  it('verifies a fresh token and exposes the payload', () => {
    const token = createSignedToken(key, {
      k: 'assets/x.png',
      e: exp,
      n: 'x.png',
      d: 'inline',
    });
    expect(verifySignedToken(key, token, now)).toMatchObject({
      k: 'assets/x.png',
      d: 'inline',
    });
  });

  it('rejects expired, tampered, re-signed-with-another-key and malformed tokens', () => {
    const token = createSignedToken(key, { k: 'assets/x.png', e: exp });
    expect(
      verifySignedToken(key, token, new Date(now.getTime() + 120_000)),
    ).toBeNull();
    const [body, sig] = token.split('.');
    const forgedBody = Buffer.from(
      JSON.stringify({ k: 'assets/secret.png', e: exp }),
    ).toString('base64url');
    expect(verifySignedToken(key, `${forgedBody}.${sig}`, now)).toBeNull();
    expect(verifySignedToken(key, `${body}.${sig}x`, now)).toBeNull();
    expect(
      verifySignedToken(
        deriveSigningKey('another-secret-another-secret-12345'),
        token,
        now,
      ),
    ).toBeNull();
    expect(verifySignedToken(key, 'garbage', now)).toBeNull();
    expect(verifySignedToken(key, `${body}.${sig}.extra`, now)).toBeNull();
  });
});

describe('LocalStorageProvider', () => {
  let root: string;
  let storage: LocalStorageProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bp-storage-'));
    storage = new LocalStorageProvider({
      root,
      signingSecret: 'unit-test-secret-unit-test-secret-1234',
      defaultTtlSeconds: 60,
    });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('stores privately (0600), reports existence, and deletes', async () => {
    const key = 'assets/2026/10/abc.png';
    await storage.put(key, Buffer.from('hello'), { contentType: 'image/png' });
    expect(await storage.exists(key)).toBe(true);
    expect(await readFile(join(root, key), 'utf8')).toBe('hello');
    expect((await stat(join(root, key))).mode & 0o077).toBe(0);
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });

  it('never overwrites an existing object', async () => {
    await storage.put('assets/dup.png', Buffer.from('1'), {
      contentType: 'image/png',
    });
    await expect(
      storage.put('assets/dup.png', Buffer.from('2'), {
        contentType: 'image/png',
      }),
    ).rejects.toThrow();
    expect(await readFile(join(root, 'assets/dup.png'), 'utf8')).toBe('1');
  });

  it('refuses traversal keys on every operation', async () => {
    await expect(
      storage.put('../escape.png', Buffer.from('x'), {
        contentType: 'image/png',
      }),
    ).rejects.toThrow('Invalid storage key');
    await expect(storage.exists('../../etc/passwd')).resolves.toBe(false);
    await expect(storage.delete('../escape.png')).rejects.toThrow(
      'Invalid storage key',
    );
    await expect(storage.getDownloadUrl('../escape.png')).rejects.toThrow(
      'Invalid storage key',
    );
  });

  it('issues expiring signed URLs that open only the signed key', async () => {
    await storage.put('assets/ok.png', Buffer.from('data'), {
      contentType: 'image/png',
    });
    const { url, expiresAt } = await storage.getDownloadUrl('assets/ok.png', {
      fileName: 'ok.png',
    });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    const token = url.split('/').pop()!;
    const opened = storage.open(token);
    expect(opened?.payload.k).toBe('assets/ok.png');
    opened?.stream.destroy();
    expect(storage.open('x.y')).toBeNull();
    const expired = await storage.getDownloadUrl('assets/ok.png', {
      expiresInSeconds: -5,
    });
    expect(storage.open(expired.url.split('/').pop()!)).toBeNull();
  });

  it('does not expose the filesystem root in URLs', async () => {
    const { url } = await storage.getDownloadUrl('assets/ok.png');
    expect(url).not.toContain(root);
    expect(url.startsWith('/api/v1/storage/local/')).toBe(true);
  });
});
