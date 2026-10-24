import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  createSignedToken,
  deriveSigningKey,
  verifySignedToken,
  type SignedUrlPayload,
} from './signed-url.js';
import {
  StorageService,
  assertValidStorageKey,
  type DownloadUrlOptions,
  type PutOptions,
  type SignedDownload,
} from './storage.service.js';

export const LOCAL_DOWNLOAD_PATH = '/api/v1/storage/local';

export interface LocalStorageOptions {
  root: string;
  signingSecret: string;
  defaultTtlSeconds: number;
}

/**
 * Development/single-node provider: files live under a private directory that
 * is never served statically. Reads go through a signed, expiring URL handled
 * by StorageController, mirroring how presigned S3 URLs behave.
 */
@Injectable()
export class LocalStorageProvider extends StorageService {
  readonly providerName = 'local';
  private readonly root: string;
  private readonly signingKey: Buffer;

  constructor(private readonly options: LocalStorageOptions) {
    super();
    this.root = resolve(options.root);
    this.signingKey = deriveSigningKey(options.signingSecret);
  }

  async put(key: string, data: Buffer, _options: PutOptions): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    // 'wx': never overwrite an existing object (keys are random, a clash is a bug).
    await writeFile(path, data, { flag: 'wx', mode: 0o600 });
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(key))).isFile();
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async getDownloadUrl(
    key: string,
    options: DownloadUrlOptions = {},
  ): Promise<SignedDownload> {
    assertValidStorageKey(key);
    const ttl = Math.min(
      options.expiresInSeconds ?? this.options.defaultTtlSeconds,
      86400,
    );
    const expiresAt = new Date(Date.now() + ttl * 1000);
    const token = createSignedToken(this.signingKey, {
      k: key,
      e: Math.floor(expiresAt.getTime() / 1000),
      n: options.fileName,
      c: options.contentType,
      d: options.disposition ?? 'attachment',
    });
    return { url: `${LOCAL_DOWNLOAD_PATH}/${token}`, expiresAt };
  }

  /** Used by StorageController only: validate a token and open the file. */
  open(
    token: string,
  ): { stream: ReadStream; payload: SignedUrlPayload } | null {
    const payload = verifySignedToken(this.signingKey, token);
    if (!payload) return null;
    try {
      return { stream: createReadStream(this.pathFor(payload.k)), payload };
    } catch {
      return null;
    }
  }

  /** Resolve a key inside the root; anything escaping it is rejected. */
  private pathFor(key: string): string {
    assertValidStorageKey(key);
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) {
      throw new Error('Invalid storage key');
    }
    return path;
  }
}
