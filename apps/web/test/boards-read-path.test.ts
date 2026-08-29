/**
 * "Reads must never touch a model, or a database" — enforced structurally.
 *
 * `brief` Part 3: "Boards are CDN snapshots, regenerated on placement. Reads never
 * touch a model." `02 §4`: "The board never computes anything at read time."
 *
 * A test that mocked a database client and asserted it was not called would pass
 * for the wrong reason the moment the import moved somewhere the mock did not
 * reach. So this walks the **module graph** instead, starting at the three public
 * board routes and following every runtime import through the app's own files. If
 * anything on that graph gains a runtime import of a database driver, the db
 * package, the engine, an SDK or the pipeline's write side, this fails — and it
 * fails naming the file and the specifier.
 *
 * Type-only imports are followed by nobody, because `import type` is erased
 * before a byte of it runs. That is what lets the read path speak the engine's
 * `Ranking` shape and the pipeline's snapshot envelope without either of them
 * being on the graph at runtime, and it is why the distinction is enforced here
 * rather than waved at.
 *
 * The second half of the file asserts the same thing dynamically: a full board
 * renders from a JSON fixture with `@the-pit/db` rigged to throw on load.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import { describe, expect, it, vi } from 'vitest';

const SRC = resolve(process.cwd(), 'src');

/** The routes a visitor can reach on the public board surface. */
const ENTRY_POINTS = [
  'app/page.tsx',
  'app/boards/page.tsx',
  'app/boards/[slug]/page.tsx',
  'app/layout.tsx',
];

/**
 * Anything here on a board read means the read is doing work a cached document
 * must never do: opening a connection, loading a driver, or reaching for a model.
 */
const FORBIDDEN = [
  '@the-pit/db',
  '@the-pit/engine',
  '@the-pit/auth',
  '@the-pit/payments',
  'postgres',
  'pg',
  'drizzle-orm',
  '@anthropic-ai/sdk',
  'inngest',
  '@/lib/pipeline/service',
  '@/lib/pipeline/store',
  '@/lib/pipeline/inngest',
  '@/lib/pipeline/run',
  '@/lib/pipeline/local',
  '@/lib/engine',
];

interface Edge {
  specifier: string;
  typeOnly: boolean;
}

/**
 * Pull the import edges out of a module.
 *
 * Deliberately a regex rather than a parser: the thing being asserted is a
 * property of the source text a reviewer reads, and a dependency on a TypeScript
 * parser would be a second thing that can be wrong. It handles the four forms
 * this codebase uses — `import x from`, `import { x } from`, `import type ... from`
 * and a bare side-effect `import './pit.css'` — and `export … from`.
 */
function importsOf(source: string): Edge[] {
  const edges: Edge[] = [];
  const withClause = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(withClause)) {
    const [, typeKeyword, clause = '', specifier = ''] = match;
    // `import { type A, type B }` is erased just as thoroughly as `import type`.
    const named = clause.trim().startsWith('{') && clause.trim().endsWith('}');
    const bindings = named
      ? clause
          .trim()
          .slice(1, -1)
          .split(',')
          .map((binding) => binding.trim())
          .filter((binding) => binding.length > 0)
      : [];
    const allTypeBindings = named && bindings.length > 0 && bindings.every((binding) => binding.startsWith('type '));
    edges.push({ specifier, typeOnly: typeKeyword !== undefined || allTypeBindings });
  }
  const sideEffect = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(sideEffect)) {
    edges.push({ specifier: match[1] ?? '', typeOnly: false });
  }
  return edges;
}

async function readModule(path: string): Promise<string | undefined> {
  for (const candidate of [path, `${path}.ts`, `${path}.tsx`, join(path, 'index.ts'), join(path, 'index.tsx')]) {
    try {
      return await readFile(candidate, 'utf8');
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Resolve an app-local specifier to a file path, or `undefined` if it is a package. */
function localPath(specifier: string, from: string): string | undefined {
  if (specifier.startsWith('@/')) return join(SRC, specifier.slice(2));
  if (specifier.startsWith('.')) return resolve(dirname(from), specifier);
  return undefined;
}

/** Walk the runtime graph. Returns every (file, specifier) pair that must not be there. */
async function offences(): Promise<string[]> {
  const seen = new Set<string>();
  const found: string[] = [];
  const queue = ENTRY_POINTS.map((entry) => join(SRC, entry));

  while (queue.length > 0) {
    const path = queue.pop();
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);

    const source = await readModule(path);
    if (source === undefined) continue;

    for (const edge of importsOf(source)) {
      if (edge.typeOnly) continue;
      if (edge.specifier.endsWith('.css')) continue;
      if (FORBIDDEN.includes(edge.specifier)) {
        found.push(`${relative(SRC, path)} -> ${edge.specifier}`);
        continue;
      }
      const next = localPath(edge.specifier, path);
      if (next !== undefined) queue.push(next);
    }
  }
  return found.sort();
}

describe('the board read path cannot reach a database or a model', () => {
  it('imports none of them, transitively, from any public board route', async () => {
    expect(await offences()).toEqual([]);
  });

  it('actually walks past the entry points, so an empty result means something', async () => {
    // A walker that resolved nothing would also report no offences. Prove it
    // reaches the leaves of the read path before trusting the assertion above.
    const source = await readModule(join(SRC, 'lib/boards/source.ts'));
    expect(source).toBeDefined();
    const edges = importsOf(source ?? '');
    expect(edges.some((edge) => edge.specifier === 'node:fs/promises' && !edge.typeOnly)).toBe(true);
    // The engine and the snapshot envelope are types here, and types only.
    expect(edges.find((edge) => edge.specifier === '@the-pit/engine')?.typeOnly).toBe(true);
    expect(edges.find((edge) => edge.specifier === '@/lib/pipeline/snapshot')?.typeOnly).toBe(true);
  });

  it('would fail if a route reached for the pipeline bindings', () => {
    // The guard rail itself, checked: `defaultBindings` is what constructs a
    // store, and it is on the forbidden list under its module.
    expect(FORBIDDEN).toContain('@/lib/pipeline/service');
    expect(FORBIDDEN).toContain('@the-pit/db');
    expect(FORBIDDEN).toContain('postgres');
  });
});

describe('a board renders with the database rigged to explode', () => {
  it('produces a full board from snapshot JSON without constructing a client', async () => {
    // Any attempt to load the db package — or the driver under it — from the read
    // path detonates here rather than silently succeeding against a real socket.
    vi.doMock('@the-pit/db', () => {
      throw new Error('a board read constructed a database client');
    });
    vi.doMock('postgres', () => {
      throw new Error('a board read loaded the postgres driver');
    });

    const { CategoryBoard } = await import('@/components/category-board');
    const { toBoardView } = await import('@/lib/boards/view');
    const { sampleRanking } = await import('./helpers/boards');

    const html = renderToStaticMarkup(
      createElement(CategoryBoard, {
        board: toBoardView({
          slug: 'developer-tools',
          category: 'Developer Tools',
          generatedAt: '2026-08-29T14:05:00.000Z',
          productCount: 3,
          categoryVersion: 'v2',
          origin: 'seeded-run',
          ranking: sampleRanking(),
        }),
      }),
    );

    expect(html).toContain('Ashgrove');
    expect(html).toContain('No trigger event anywhere in the pitch.');
    expect(html).toContain('The Seed Investor');
    vi.doUnmock('@the-pit/db');
    vi.doUnmock('postgres');
  });
});
