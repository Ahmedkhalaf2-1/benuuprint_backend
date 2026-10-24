import { sanitizeFileName, sniffFile } from './asset-file.js';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

describe('sniffFile', () => {
  it.each([
    ['png', PNG, 'image/png'],
    ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), 'image/jpeg'],
    ['gif89a', Buffer.from('GIF89a......'), 'image/gif'],
    ['gif87a', Buffer.from('GIF87a......'), 'image/gif'],
    [
      'webp',
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.alloc(4),
        Buffer.from('WEBPVP8 '),
      ]),
      'image/webp',
    ],
    ['pdf', Buffer.from('%PDF-1.7\n...'), 'application/pdf'],
  ])('identifies %s by content', (_name, buf, mime) => {
    expect(sniffFile(buf)?.mimeType).toBe(mime);
  });

  it.each([
    ['windows executable', Buffer.from('MZ\x90\x00\x03')],
    [
      'svg (scriptable)',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    ],
    ['html', Buffer.from('<!doctype html><script>alert(1)</script>')],
    [
      'riff but not webp (wav)',
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.alloc(4),
        Buffer.from('WAVEfmt '),
      ]),
    ],
    ['too short', Buffer.from([0x89, 0x50])],
    ['empty', Buffer.alloc(0)],
  ])('rejects %s', (_name, buf) => {
    expect(sniffFile(buf)).toBeNull();
  });
});

describe('sanitizeFileName', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\system32\\evil.png', 'evil.png'],
    ['/abs/path/logo.png', 'logo.png'],
    ['we"ird<na>me?.png', 'weirdname.png'],
    ['tab\tand\nnewline.pdf', 'tabandnewline.pdf'],
    ['  spaced   name .png ', 'spaced name .png'],
    ['....', 'file'],
    ['', 'file'],
    ['null\u0000byte.png', 'nullbyte.png'],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });

  it('clips very long names', () => {
    expect(
      sanitizeFileName('a'.repeat(500) + '.png').length,
    ).toBeLessThanOrEqual(200);
  });
});
