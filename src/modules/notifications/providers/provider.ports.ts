/**
 * Delivery ports. Business and notification code depends on these abstract classes only; a real provider
 * (Resend, SES, Twilio, Meta WhatsApp Cloud API …) is one more implementation selected by configuration.
 *
 * Contract:
 *  - `idempotencyKey` is the notification id: a provider that supports idempotency passes it on, and a
 *    retry after a crash must not produce a second message.
 *  - A `PermanentProviderError` means retrying cannot help (invalid recipient, channel disabled, template
 *    rejected); anything else is treated as transient and retried with backoff.
 */

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}
export class PermanentProviderError extends ProviderError {
  constructor(message: string) {
    super(message, true);
  }
}
export class TransientProviderError extends ProviderError {
  constructor(message: string) {
    super(message, false);
  }
}

export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  /** Escaped HTML rendition of `text`; optional for providers that only send text. */
  html?: string;
  idempotencyKey: string;
  /** Non-sensitive correlation data (notification id, type, entity). */
  metadata?: Record<string, string>;
}

export interface WhatsAppMessage {
  /** E.164 phone number. */
  to: string;
  /**
   * WhatsApp Business only allows pre-approved templates outside the 24 h customer-care window. `templateName`
   * is the approved template reference (`<templateCode>_<locale>`); `variables` fill its numbered slots in order.
   * `fallbackText` is the fully rendered text for providers or sessions that allow free-form messages.
   */
  templateName: string;
  locale: string;
  variables: string[];
  fallbackText: string;
  idempotencyKey: string;
  metadata?: Record<string, string>;
}

export interface DeliveryResult {
  providerMessageId: string;
}

export abstract class EmailProvider {
  abstract readonly name: string;
  /** false → the channel is switched off; no EMAIL notifications are planned. */
  abstract readonly enabled: boolean;
  abstract send(message: EmailMessage): Promise<DeliveryResult>;
}

export abstract class WhatsAppProvider {
  abstract readonly name: string;
  abstract readonly enabled: boolean;
  abstract send(message: WhatsAppMessage): Promise<DeliveryResult>;
}
