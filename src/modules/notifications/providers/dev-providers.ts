import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  EmailProvider,
  PermanentProviderError,
  TransientProviderError,
  WhatsAppProvider,
  type DeliveryResult,
  type EmailMessage,
  type WhatsAppMessage,
} from './provider.ports.js';

export interface SimulatedFailure {
  transient?: number;
  permanent?: boolean;
}

const mask = (to: string) =>
  to.includes('@')
    ? `${to.slice(0, 2)}***@${to.split('@')[1]}`
    : `${to.slice(0, 3)}***${to.slice(-2)}`;

/**
 * Shared behaviour of the development providers: records every delivery in memory (tests and local use),
 * logs metadata only (never the body), is idempotent on the idempotency key, and can simulate failures.
 */
abstract class RecordingProvider<
  M extends { to: string; idempotencyKey: string },
> {
  abstract readonly name: string;
  readonly enabled = true;
  readonly sent: (M & { providerMessageId: string })[] = [];
  /** Every attempt, including failures (idempotent replays are not attempts). */
  attempts = 0;
  private readonly byKey = new Map<string, string>();
  private simulated: SimulatedFailure = {};
  protected abstract readonly logger: Logger;

  /** Test hook: make the next sends fail. Ignored in production (the log provider is not used there). */
  simulate(failure: SimulatedFailure) {
    this.simulated = { ...failure };
  }

  reset() {
    this.sent.length = 0;
    this.byKey.clear();
    this.attempts = 0;
    this.simulated = {};
  }

  protected deliver(message: M, describe: string): DeliveryResult {
    const existing = this.byKey.get(message.idempotencyKey);
    if (existing) return { providerMessageId: existing }; // replay: no second delivery
    this.attempts += 1;
    if (this.simulated.permanent)
      throw new PermanentProviderError('Simulated permanent failure');
    if ((this.simulated.transient ?? 0) > 0) {
      this.simulated.transient = (this.simulated.transient ?? 0) - 1;
      throw new TransientProviderError('Simulated transient failure');
    }
    const providerMessageId = `${this.name}-${randomUUID()}`;
    this.byKey.set(message.idempotencyKey, providerMessageId);
    this.sent.push({ ...message, providerMessageId });
    this.logger.log(
      `${describe} to ${mask(message.to)} (${providerMessageId})`,
    );
    return { providerMessageId };
  }
}

export class LogEmailProvider
  extends RecordingProvider<EmailMessage>
  implements EmailProvider
{
  readonly name = 'log-email';
  protected readonly logger = new Logger('LogEmailProvider');
  send(message: EmailMessage): Promise<DeliveryResult> {
    try {
      return Promise.resolve(
        this.deliver(message, `email "${message.subject.slice(0, 40)}"`),
      );
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

export class LogWhatsAppProvider
  extends RecordingProvider<WhatsAppMessage>
  implements WhatsAppProvider
{
  readonly name = 'log-whatsapp';
  protected readonly logger = new Logger('LogWhatsAppProvider');
  send(message: WhatsAppMessage): Promise<DeliveryResult> {
    try {
      return Promise.resolve(
        this.deliver(message, `whatsapp template ${message.templateName}`),
      );
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

/** Channel switched off by configuration: nothing is planned for it, and a stray send fails permanently. */
export class DisabledEmailProvider extends EmailProvider {
  readonly name = 'disabled';
  readonly enabled = false;
  send(): Promise<DeliveryResult> {
    return Promise.reject(
      new PermanentProviderError('The email channel is disabled'),
    );
  }
}
export class DisabledWhatsAppProvider extends WhatsAppProvider {
  readonly name = 'disabled';
  readonly enabled = false;
  send(): Promise<DeliveryResult> {
    return Promise.reject(
      new PermanentProviderError('The WhatsApp channel is disabled'),
    );
  }
}
