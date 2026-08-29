/**
 * Not a test — a renderer, run through the test runner because that is the only
 * place the seeded-verdict helpers are wired up.
 *
 * Writes two real verdict pages to `PIT_PREVIEW_OUT` so the design can be looked
 * at in a browser: `/v/<slug>` needs a delivered verdict in Postgres, and there is
 * no database on a laptop. Skipped unless the variable is set, so it costs a
 * normal run nothing.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { parseVerdict } from '@/lib/verdict/model';
import { renderVerdictPage } from '@/lib/verdict/page';

import { seededVerdictNamed } from './helpers/verdict';

const out = process.env['PIT_PREVIEW_OUT'];

describe.skipIf(out === undefined || out === '')('verdict preview', () => {
  it('writes a scored verdict and a solo-cluster verdict', async () => {
    const dir = out ?? '';
    await mkdir(dir, { recursive: true });
    for (const [file, slug, name] of [
      ['verdict-scored.html', 'developer-tools', 'Capgo'],
      ['verdict-solo.html', 'developer-tools', 'Carillon'],
    ] as const) {
      const verdict = parseVerdict(await seededVerdictNamed(slug, name));
      await writeFile(join(dir, file), renderVerdictPage(verdict, { origin: 'https://thepit.show' }), 'utf8');
    }
  });
});
