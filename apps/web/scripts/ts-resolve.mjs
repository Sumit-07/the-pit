/**
 * The five lines of module resolution that let a plain `node` run the app's own
 * TypeScript.
 *
 * Node 22 can strip types out of a `.ts` file (`--experimental-strip-types`) but
 * it still resolves specifiers as ESM, which means `import './favicon'` — the
 * form every module in `src/` uses, because a bundler resolves it and
 * `moduleResolution: "bundler"` requires the extension to be absent — does not
 * find `./favicon.ts`.
 *
 * Rather than add a runner as a dependency, or write the specifiers twice, this
 * fills in the extension a bundler would have filled in, and `@/` the way
 * `tsconfig.json` and `vitest.config.ts` already do. It is used by
 * `backfill-favicons.ts` and by nothing that ships: no route, no test and no
 * build goes through it.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../src/', import.meta.url);
const SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

export async function resolve(specifier, context, next) {
  let target = specifier;
  if (target.startsWith('@/')) target = new URL(target.slice(2), SRC).href;

  const relative = target.startsWith('.') || target.startsWith('file:');
  if (relative && !/\.(m?[jt]sx?|json|node)$/i.test(target)) {
    const base = new URL(target, context.parentURL);
    for (const suffix of SUFFIXES) {
      const candidate = new URL(`${base.href}${suffix}`);
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
    }
  }
  return next(target, context);
}
