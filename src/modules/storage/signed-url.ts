import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedUrlPayload {
  /** storage key */
  k: string;
  /** expiry, epoch seconds */
  e: number;
  /** download file name */
  n?: string;
  /** content type */
  c?: string;
  /** disposition */
  d?: 'attachment' | 'inline';
}

/** Derive a purpose-specific key so the JWT secret is never used directly for URL signing. */
export function deriveSigningKey(secret: string): Buffer {
  return createHmac('sha256', secret)
    .update('benue-print:storage-url:v1')
    .digest();
}

const sign = (key: Buffer, body: string) =>
  createHmac('sha256', key).update(body).digest('base64url');

export function createSignedToken(
  key: Buffer,
  payload: SignedUrlPayload,
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(key, body)}`;
}

/** Returns the payload only if the signature is valid and the link has not expired. */
export function verifySignedToken(
  key: Buffer,
  token: string,
  now: Date = new Date(),
): SignedUrlPayload | null {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(key, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return null;
  try {
    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString(),
    ) as SignedUrlPayload;
    if (typeof payload.k !== 'string' || typeof payload.e !== 'number')
      return null;
    return payload.e * 1000 > now.getTime() ? payload : null;
  } catch {
    return null;
  }
}
