import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/app.config.js';
import { EmailProvider } from '../../notifications/providers/provider.ports.js';
import { toHtml } from '../../notifications/template-renderer.js';

/**
 * Sends the self-signup verification email straight through the EmailProvider port.
 *
 * Deliberately NOT the notification outbox: outbox payloads and stored notification bodies are forbidden
 * from holding secrets, and the verification link is a credential. The token therefore exists only in the
 * email itself; the database keeps its sha256. A delivery failure never fails the request (the visitor can
 * ask for another link).
 */
@Injectable()
export class CustomerVerificationEmailService {
  private readonly logger = new Logger('CustomerVerificationEmail');
  private readonly cfg: AppConfig;

  constructor(
    private readonly email: EmailProvider,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>('app');
  }

  verificationUrl(token: string): string | null {
    const base = this.cfg.publicAppUrl;
    return base
      ? `${base.replace(/\/$/, '')}/account/verify-email?token=${encodeURIComponent(token)}`
      : null;
  }

  async send(params: {
    tokenId: string;
    to: string;
    name: string;
    token: string;
    expiresAt: Date;
  }): Promise<void> {
    const url = this.verificationUrl(params.token);
    if (!url) {
      this.logger.warn('PUBLIC_APP_URL is not set; verification email skipped');
      return;
    }
    if (!this.email.enabled) {
      this.logger.warn('Email channel disabled; verification email skipped');
      return;
    }
    const hours = this.cfg.accountTokens.emailVerificationTtlHours;
    const text = [
      `Hello ${params.name},`,
      'Welcome to Benue Print. Please confirm your email address to finish creating your account:',
      url,
      `This link works once and expires in ${hours} hour${hours === 1 ? '' : 's'}. If you did not create this account you can ignore this email.`,
      'Benue Print',
    ].join('\n\n');
    try {
      await this.email.send({
        to: params.to,
        from: this.cfg.notifications.emailFrom,
        subject: 'Verify your Benue Print email',
        text,
        html: toHtml(text),
        // one delivery per issued token, even if the call is retried
        idempotencyKey: `email-verification:${params.tokenId}`,
        metadata: { type: 'CUSTOMER_EMAIL_VERIFICATION' },
      });
      // Dev convenience only (same switch that lets admins see invitation tokens): never on in production.
      if (this.cfg.accountTokens.exposeTokens) {
        this.logger.debug(`DEV verification link: ${url}`);
      }
    } catch (e) {
      this.logger.warn(
        `Verification email failed: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }
  }
}
