/**
 * The mail seam.
 *
 * `brief` Part 7 names Resend as the provider. There is no API key in this
 * repository and there must not be one in a test, so sending is an interface
 * with exactly one method and two implementations: `FixtureMailTransport`, which
 * keeps messages in an array, and `ResendMailTransport`, which is given its
 * `fetch` rather than reaching for the global one.
 *
 * ## The delivery result is not the request's result
 *
 * `send` reports what happened, but `requestMagicLink` answers "check your
 * inbox" either way. That is not sloppiness — it is `brief §2.1`'s
 * no-enumeration rule applied to the failure path. If a bounce, a suppression
 * list hit, or a provider 4xx changed the HTTP response, then the response would
 * once again depend on properties of the target address, and the enumeration
 * oracle the identical body was written to close would reopen through the error
 * path. Failures are for logs and alarms; the visitor is told the same sentence
 * regardless.
 *
 * `send` therefore RETURNS a result rather than throwing on a provider error,
 * and callers treat a thrown error the same way they treat a returned failure.
 */

/**
 * One outbound message.
 *
 * Both bodies are required. A text/plain alternative is not politeness: a
 * message with no plain part scores worse with spam filters, and the domain's
 * reputation is the thing standing between this link and a junk folder — see
 * the SPF/DKIM/DMARC note in the Phase 4 report.
 */
export interface OutboundEmail {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * Given to the provider for deduplication where it supports one, and logged
   * either way. Derived from the token hash, never from the token.
   */
  readonly idempotencyKey: string;
}

export type MailSendResult =
  | { readonly outcome: 'sent'; readonly providerMessageId: string }
  /** Recorded, alarmed on, and invisible to the requester. */
  | { readonly outcome: 'failed'; readonly reason: string };

export interface MailTransport {
  send(message: OutboundEmail): Promise<MailSendResult>;
}
