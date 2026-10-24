import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Param,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/access-control.decorators.js';
import { LocalStorageProvider } from './local-storage.provider.js';
import { StorageService } from './storage.service.js';

// Types the upload validator can produce; anything else is served as opaque bytes.
const SAFE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

/**
 * Serves objects for the local provider. Public by design: the signed,
 * expiring token IS the credential (as with S3 presigned URLs). Tokens are
 * minted only after an authenticated `assets.read` check.
 */
@ApiExcludeController()
@Controller('storage/local')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Get(':token')
  @Header('Cache-Control', 'private, no-store')
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  download(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ): StreamableFile {
    if (!(this.storage instanceof LocalStorageProvider)) {
      throw new ForbiddenException('Invalid or expired download link');
    }
    const opened = this.storage.open(token);
    if (!opened)
      throw new ForbiddenException('Invalid or expired download link');
    const { stream, payload } = opened;
    const type =
      payload.c && SAFE_TYPES.has(payload.c)
        ? payload.c
        : 'application/octet-stream';
    const disposition =
      type === 'application/octet-stream'
        ? 'attachment'
        : (payload.d ?? 'attachment');
    const name = (payload.n ?? 'download')
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\]/g, '_');
    res.set(
      'Content-Disposition',
      `${disposition}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(payload.n ?? 'download')}`,
    );
    stream.on('error', () => res.destroy());
    return new StreamableFile(stream, { type });
  }
}
