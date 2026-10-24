export interface SniffedFile {
  mimeType: string;
  extension: string;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Identify a file by its magic bytes. The client's Content-Type and filename
 * extension are never trusted. Only formats listed here can be uploaded; SVG
 * and HTML are intentionally excluded because they can carry scripts.
 */
export function sniffFile(buf: Buffer): SniffedFile | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG)) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return { mimeType: 'image/gif', extension: 'gif' };
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { mimeType: 'application/pdf', extension: 'pdf' };
  }
  return null;
}

export const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
] as const;

/**
 * The original name is display metadata only (never part of the storage key).
 * Strip directory components, control characters and reserved characters.
 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const clipped = cleaned.length > 200 ? cleaned.slice(-200) : cleaned;
  return clipped || 'file';
}
