export interface EmailAddress {
  email: string;
  name?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  /**
   * Plain-text alternative. Mandatory, not optional: a text part improves
   * deliverability, and some clients render nothing else.
   */
  text: string;
}

export interface SendEmailInput extends RenderedEmail {
  to: string;
  /** Template id, recorded on the email_events row for debugging. */
  template: string;
  replyTo?: string;
  /** Correlates the send with the request that triggered it. */
  requestId?: string;
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface EmailTransport {
  readonly name: string;
  send(input: SendEmailInput, from: string): Promise<SendResult>;
}
