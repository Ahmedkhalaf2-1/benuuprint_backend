import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended argon2id parameters (19 MiB, 2 iterations, 1 lane).
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /** Burn the same CPU as a real check so unknown emails are not distinguishable by timing. */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('timing-equalisation-dummy-Passw0rd');
    await this.verify(await this.dummyHash, password);
  }
}
