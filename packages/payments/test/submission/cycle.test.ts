import { describe, expect, it } from 'vitest';

import { countdownTo, cycleAt, cycleLockedMessage, NIGHTLY_REBUILD } from '../../src/submission/cycle.js';

describe('cycleAt (brief §2.4: one pitch per product per recalibration cycle)', () => {
  it('puts 01:30 UTC in the cycle that opened at 02:00 the previous day', () => {
    // The case a naive "today's date" key gets wrong: it is the 29th, but the
    // board being pitched into was built at 02:00 on the 28th.
    const cycle = cycleAt(new Date('2026-08-29T01:30:00.000Z'));
    expect(cycle.id).toBe('2026-08-28');
    expect(cycle.startedAt.toISOString()).toBe('2026-08-28T02:00:00.000Z');
    expect(cycle.endsAt.toISOString()).toBe('2026-08-29T02:00:00.000Z');
  });

  it('opens the new cycle at exactly the rebuild instant', () => {
    const cycle = cycleAt(new Date('2026-08-29T02:00:00.000Z'));
    expect(cycle.id).toBe('2026-08-29');
    expect(cycle.startedAt.toISOString()).toBe('2026-08-29T02:00:00.000Z');
  });

  it('still belongs to the old cycle one millisecond earlier', () => {
    expect(cycleAt(new Date('2026-08-29T01:59:59.999Z')).id).toBe('2026-08-28');
  });

  it('puts an evening submission in the cycle that opened this morning', () => {
    const cycle = cycleAt(new Date('2026-08-29T21:30:00.000Z'));
    expect(cycle.id).toBe('2026-08-29');
    expect(cycle.endsAt.toISOString()).toBe('2026-08-30T02:00:00.000Z');
  });

  it('crosses a month boundary backwards', () => {
    expect(cycleAt(new Date('2026-09-01T00:30:00.000Z')).id).toBe('2026-08-31');
  });

  it('honours a different rebuild hour', () => {
    const cycle = cycleAt(new Date('2026-08-29T05:00:00.000Z'), { hourUtc: 6, minuteUtc: 30 });
    expect(cycle.startedAt.toISOString()).toBe('2026-08-28T06:30:00.000Z');
  });
});

describe('countdownTo (brief §2.4: a countdown, not an arbitrary limit)', () => {
  it('counts the half hour to a 02:00 rebuild', () => {
    const now = new Date('2026-08-29T01:30:00.000Z');
    const countdown = countdownTo(cycleAt(now), now);
    expect(countdown.secondsRemaining).toBe(1800);
    expect(countdown.humanized).toBe('30m');
    expect(countdown.nextRebuildAt.toISOString()).toBe('2026-08-29T02:00:00.000Z');
  });

  it('counts a full day from the instant a cycle opens', () => {
    const now = new Date('2026-08-29T02:00:00.000Z');
    const countdown = countdownTo(cycleAt(now), now);
    expect(countdown.secondsRemaining).toBe(86400);
    expect(countdown.humanized).toBe('24h 0m');
  });

  it('renders hours and minutes together', () => {
    const now = new Date('2026-08-29T21:30:00.000Z');
    const countdown = countdownTo(cycleAt(now), now);
    expect(countdown.secondsRemaining).toBe(16200);
    expect(countdown.humanized).toBe('4h 30m');
  });

  it('falls back to seconds in the last minute', () => {
    const now = new Date('2026-08-29T01:59:15.000Z');
    expect(countdownTo(cycleAt(now), now).humanized).toBe('45s');
  });
});

describe('cycleLockedMessage', () => {
  it('names the rebuild time and the wait, not a limit', () => {
    const now = new Date('2026-08-29T21:30:00.000Z');
    const message = cycleLockedMessage(cycleAt(now), now, NIGHTLY_REBUILD);
    expect(message).toContain('02:00 UTC');
    expect(message).toContain('4h 30m');
    expect(message).not.toMatch(/limit|quota|allowance/i);
  });
});
