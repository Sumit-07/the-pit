import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { HEADER_ID, HEADER_SIGNATURE, HEADER_TIMESTAMP, verifyWebhookSignature } from '../../src/checkout/signature.js';

const SECRET = 'whsec_c2VjcmV0LWtleS1mb3ItdGVzdGluZw==';
const NOW = new Date('2026-08-29T12:00:00.000Z');
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));
const BODY = '{"id":"evt_1","type":"payment.succeeded"}';

/**
 * An independent expression of the Standard Webhooks signing rule, written from
 * the spec rather than by calling `signWebhook`. If the implementation and this
 * ever disagree, one of them is wrong and the test says so — which is the whole
 * point of not reusing the production helper here.
 */
function signIndependently(id: string, timestamp: string, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

function headers(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [HEADER_ID]: 'msg_1',
    [HEADER_TIMESTAMP]: TIMESTAMP,
    [HEADER_SIGNATURE]: `v1,${signIndependently('msg_1', TIMESTAMP, BODY)}`,
    ...overrides,
  };
}

describe('verifyWebhookSignature', () => {
  it('accepts a signature built to the Standard Webhooks spec', () => {
    expect(verifyWebhookSignature({ rawBody: BODY, headers: headers(), secret: SECRET, now: NOW })).toEqual({
      valid: true,
    });
  });

  it('finds the headers whatever case the proxy sent them in', () => {
    const upper = {
      'Webhook-Id': 'msg_1',
      'Webhook-Timestamp': TIMESTAMP,
      'Webhook-Signature': `v1,${signIndependently('msg_1', TIMESTAMP, BODY)}`,
    };
    expect(verifyWebhookSignature({ rawBody: BODY, headers: upper, secret: SECRET, now: NOW }).valid).toBe(true);
  });

  it('rejects a body that changed after signing', () => {
    const tampered = BODY.replace('evt_1', 'evt_2');
    const result = verifyWebhookSignature({ rawBody: tampered, headers: headers(), secret: SECRET, now: NOW });
    expect(result).toEqual({ valid: false, reason: 'no_matching_signature' });
  });

  it('rejects a signature made with a different secret', () => {
    const forged = `v1,${signIndependently('msg_1', TIMESTAMP, BODY, 'whsec_b3RoZXI=')}`;
    const result = verifyWebhookSignature({
      rawBody: BODY,
      headers: headers({ [HEADER_SIGNATURE]: forged }),
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: 'no_matching_signature' });
  });

  it('rejects a signature bound to a different message id', () => {
    const other = `v1,${signIndependently('msg_2', TIMESTAMP, BODY)}`;
    const result = verifyWebhookSignature({
      rawBody: BODY,
      headers: headers({ [HEADER_SIGNATURE]: other }),
      secret: SECRET,
      now: NOW,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a replay from outside the tolerance window', () => {
    const old = String(Number(TIMESTAMP) - 301);
    const result = verifyWebhookSignature({
      rawBody: BODY,
      headers: {
        [HEADER_ID]: 'msg_1',
        [HEADER_TIMESTAMP]: old,
        [HEADER_SIGNATURE]: `v1,${signIndependently('msg_1', old, BODY)}`,
      },
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: 'timestamp_outside_tolerance' });
  });

  it('rejects a timestamp too far in the future as well as too far in the past', () => {
    const ahead = String(Number(TIMESTAMP) + 301);
    const result = verifyWebhookSignature({
      rawBody: BODY,
      headers: {
        [HEADER_ID]: 'msg_1',
        [HEADER_TIMESTAMP]: ahead,
        [HEADER_SIGNATURE]: `v1,${signIndependently('msg_1', ahead, BODY)}`,
      },
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: 'timestamp_outside_tolerance' });
  });

  it('accepts a timestamp at the edge of the window', () => {
    const edge = String(Number(TIMESTAMP) - 300);
    const result = verifyWebhookSignature({
      rawBody: BODY,
      headers: {
        [HEADER_ID]: 'msg_1',
        [HEADER_TIMESTAMP]: edge,
        [HEADER_SIGNATURE]: `v1,${signIndependently('msg_1', edge, BODY)}`,
      },
      secret: SECRET,
      now: NOW,
    });
    expect(result.valid).toBe(true);
  });

  it('reports missing headers rather than throwing', () => {
    expect(
      verifyWebhookSignature({ rawBody: BODY, headers: { [HEADER_ID]: 'msg_1' }, secret: SECRET, now: NOW }),
    ).toEqual({ valid: false, reason: 'missing_headers' });
  });

  it('rejects a non-numeric timestamp', () => {
    const result = verifyWebhookSignature({
      rawBody: BODY,
      headers: headers({ [HEADER_TIMESTAMP]: 'yesterday' }),
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ valid: false, reason: 'malformed_timestamp' });
  });

  it('accepts when one of several rotated signatures matches', () => {
    const mixed = `v1,${signIndependently('msg_1', TIMESTAMP, BODY, 'whsec_b3RoZXI=')} v1,${signIndependently('msg_1', TIMESTAMP, BODY)}`;
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        headers: headers({ [HEADER_SIGNATURE]: mixed }),
        secret: SECRET,
        now: NOW,
      }).valid,
    ).toBe(true);
  });

  it('does not accept a future scheme version on its own', () => {
    const v2Only = `v2,${signIndependently('msg_1', TIMESTAMP, BODY)}`;
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        headers: headers({ [HEADER_SIGNATURE]: v2Only }),
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: 'no_matching_signature' });
  });
});
