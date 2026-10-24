import { Injectable, Logger } from '@nestjs/common';
import type { UserTokenType } from '../../generated/prisma/client.js';

export interface TokenDeliveryRequest {
  type: UserTokenType;
  user: { id: string; email: string; name: string };
  /** Raw one-time token. Hand it to the channel; never log or persist it. */
  token: string;
  expiresAt: Date;
}

/**
 * Port for delivering invitation / password-reset tokens (email, WhatsApp, ...).
 * Phase 2 ships only the logging stand-in below; attach a real provider by
 * binding another implementation to this class in AuthModule.
 */
export abstract class TokenDelivery {
  abstract deliver(request: TokenDeliveryRequest): Promise<void>;
}

@Injectable()
export class NoopTokenDelivery extends TokenDelivery {
  private readonly logger = new Logger('TokenDelivery');

  async deliver(request: TokenDeliveryRequest): Promise<void> {
    // Deliberately omits the token and the email address.
    this.logger.log(
      `${request.type} token issued for user ${request.user.id}; no delivery provider configured`,
    );
  }
}
