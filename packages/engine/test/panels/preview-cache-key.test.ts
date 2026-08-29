/**
 * The preview cache key — `the-pit-build-brief.md` §1.3.
 *
 * The defect being fixed is a key that is too NARROW: caching on the description
 * hash alone serves a stale rank band after any placement in the category. So the
 * discriminating tests are the ones that vary a single non-description component
 * and require the key to move. A key derived from `descriptionHash` alone passes
 * a "same input, same key" test perfectly and fails every one of those.
 */

import { describe, expect, it } from 'vitest';

import { previewCacheKey } from '../../src/panels/preview-cache-key.js';
import type { PreviewCacheKeyInput } from '../../src/panels/preview-cache-key.js';

const BASE: PreviewCacheKeyInput = {
  descriptionHash: 'sha256:5e884898da280471',
  categorySnapshotVersion: 'health-fitness-wellness@2026-08-29-001',
  promptVersion: 'jury-v3',
  personaVersion: 'personas-v2',
};

describe('previewCacheKey — stability', () => {
  it('is the same string for the same four components', () => {
    expect(previewCacheKey(BASE)).toBe(previewCacheKey({ ...BASE }));
  });

  it('does not depend on the order the object literal was written in', () => {
    expect(
      previewCacheKey({
        personaVersion: BASE.personaVersion,
        promptVersion: BASE.promptVersion,
        categorySnapshotVersion: BASE.categorySnapshotVersion,
        descriptionHash: BASE.descriptionHash,
      }),
    ).toBe(previewCacheKey(BASE));
  });

  it('stays readable, so a stale entry can be diagnosed by looking at it', () => {
    expect(previewCacheKey(BASE)).toBe(
      'preview|desc=sha256%3A5e884898da280471|cat=health-fitness-wellness%402026-08-29-001|prompt=jury-v3|persona=personas-v2',
    );
  });
});

describe('previewCacheKey — every component moves the key (the §1.3 fix)', () => {
  const CHANGES: ReadonlyArray<[keyof PreviewCacheKeyInput, string]> = [
    ['descriptionHash', 'sha256:0000000000000000'],
    ['categorySnapshotVersion', 'health-fitness-wellness@2026-08-30-002'],
    ['promptVersion', 'jury-v4'],
    ['personaVersion', 'personas-v3'],
  ];

  it.each(CHANGES)('changes when %s changes', (field, value) => {
    expect(previewCacheKey({ ...BASE, [field]: value })).not.toBe(previewCacheKey(BASE));
  });

  it('separates two submissions of identical text into different category snapshots', () => {
    // brief §1.2: appending a product shifts the population mean and std, so every
    // existing z-score changes. The same text is a different answer afterwards.
    const before = previewCacheKey(BASE);
    const after = previewCacheKey({ ...BASE, categorySnapshotVersion: 'health-fitness-wellness@2026-08-29-002' });
    expect(after).not.toBe(before);
  });

  it('produces four distinct keys when each component is varied on its own', () => {
    const keys = new Set([previewCacheKey(BASE), ...CHANGES.map(([field, value]) => previewCacheKey({ ...BASE, [field]: value }))]);
    expect(keys.size).toBe(5);
  });
});

describe('previewCacheKey — unambiguous encoding', () => {
  it('cannot be made to collide by a component containing a separator', () => {
    // Without encoding, "a|c=b" in the description hash would let one submission
    // impersonate another's key on a public, unauthenticated, free endpoint.
    const a = previewCacheKey({ ...BASE, descriptionHash: 'a|c=b', categorySnapshotVersion: 'x' });
    const b = previewCacheKey({ ...BASE, descriptionHash: 'a', categorySnapshotVersion: 'b|c=x' });
    expect(a).not.toBe(b);
  });

  it('encodes the separators out of every component', () => {
    const key = previewCacheKey({ ...BASE, promptVersion: 'a|b=c' });
    expect(key).toContain('prompt=a%7Cb%3Dc');
    expect(key.split('|')).toHaveLength(5);
  });

  it('survives non-ASCII component values', () => {
    const key = previewCacheKey({ ...BASE, categorySnapshotVersion: 'santé-2026' });
    expect(key).toContain('cat=sant%C3%A9-2026');
    expect(key).not.toBe(previewCacheKey({ ...BASE, categorySnapshotVersion: 'sante-2026' }));
  });
});

describe('previewCacheKey — refuses to collide two different states', () => {
  it.each(['descriptionHash', 'categorySnapshotVersion', 'promptVersion', 'personaVersion'] as const)(
    'throws on an empty %s',
    (field) => {
      expect(() => previewCacheKey({ ...BASE, [field]: '' })).toThrow(RangeError);
    },
  );

  it('throws rather than stringifying a missing component', () => {
    const missing = { ...BASE } as Partial<PreviewCacheKeyInput>;
    delete missing.personaVersion;
    expect(() => previewCacheKey(missing as PreviewCacheKeyInput)).toThrow(RangeError);
  });
});
