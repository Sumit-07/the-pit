import { ENGINE } from '@/lib/engine';

/**
 * A placeholder, and only a placeholder.
 *
 * `brief` Part 6 and the build order put the homepage and the category boards at
 * step 5, and another agent owns them. What this route exists to prove is the one
 * thing Phase 2's shell is for: the app renders, and it reads `@the-pit/engine`
 * as a library. If the workspace link or the engine's build output were wrong,
 * `next build` would fail here rather than three phases from now.
 *
 * The numbers below are read from the engine, never written down. `01 §9` rule 4
 * and `docs/plans/phase-1-engine.md`'s Global Constraint 4 put every constant in
 * `packages/engine/src/config/constants.ts`; a page that hard-coded `0.65` would
 * be a second source of truth for a weight that decides rank.
 */
export default function Home() {
  return (
    <main>
      <h1>You can&rsquo;t outbid the pit.</h1>
      <p>Everyone walks in at 100. Fewest cuts wins.</p>

      <section aria-label="Shell status">
        <p>
          Phase 2 shell. The boards, the verdict page and checkout are not built yet.
        </p>
        <dl>
          <dt>Engine</dt>
          <dd>{ENGINE.version}</dd>

          <dt>Jurors</dt>
          <dd>{ENGINE.jurors}</dd>

          <dt>Merit / demand weight</dt>
          <dd>
            {ENGINE.meritWeight} / {ENGINE.demandWeight}
          </dd>
        </dl>
      </section>
    </main>
  );
}
