/**
 * Invalidating the RENDERED board pages when a placement republishes a board.
 *
 * ## The bug this closes
 *
 * `/`, `/boards` and `/boards/<slug>` are all `export const revalidate = 86400`,
 * and until now there was no `revalidatePath` or `revalidateTag` anywhere in
 * `apps/web/src`. `SNAPSHOT_PURGE_URL` purges the board JSON at the CDN — that is
 * `BucketSnapshotSink`'s job and it does it — but the Next ISR page is a
 * SEPARATE artifact built from that JSON, and nothing was invalidating it. A
 * customer could pay $5, watch the placement complete, see the new board in
 * `/api/boards/<slug>`, and find the page every visitor actually lands on
 * unchanged for up to a day. No error anywhere: two documents, one updated.
 *
 * It is the same shape as the seam already fixed one layer down, where
 * `/boards/<slug>` read a directory while a placement published to a bucket. The
 * fix is the same: one call site, on the one event that means a board changed,
 * covering every path that republishes one.
 *
 * ## Why an interface rather than a bare import
 *
 * `revalidatePath` only does anything inside a Next request context, and it is
 * imported from `next/cache` — which the delivery logic must not depend on if
 * that logic is going to be driven by a test, by a script, or by a different
 * executor later. So the capability is a one-method seam, `nextBoardInvalidator`
 * is the production implementation, and a test asserts the exact set of paths
 * rather than asserting that a framework function was reached.
 *
 * ## Which paths, and why all three
 *
 * A placement changes one category's board — and it changes the other two
 * surfaces as well, because both read the same document:
 *
 * - `/boards/<slug>` renders that board directly.
 * - `/boards` lists every board with its product count, which has just moved.
 * - `/` leads with a rolling rail over the real boards, so the home page shows
 *   rows out of the same JSON.
 *
 * Invalidating only the category page would leave two surfaces contradicting it,
 * which is the failure this module exists to prevent rather than a smaller
 * version of it.
 */

/** The seam. One method, because a republish is one event. */
export interface BoardInvalidator {
  /** Drop the rendered pages that read the board for `slug`. */
  invalidateBoard(slug: string): Promise<void>;
}

/**
 * Every rendered path that reads one category's board, in the order a reader
 * would check them.
 *
 * Exported so a test can assert the SET rather than the call: a page added later
 * that reads a board and is not listed here is the regression, and a test that
 * only checked `revalidatePath` was called could not see it.
 */
export function boardPaths(slug: string): readonly string[] {
  return ['/', '/boards', `/boards/${slug}`];
}

/**
 * The production invalidator.
 *
 * `revalidatePath` is imported lazily, inside the call, for one reason: this
 * module is reachable from the delivery path, the delivery path is reachable from
 * a test, and a top-level `import 'next/cache'` would drag the framework into
 * every one of them. The import is also what makes the no-context case
 * survivable — outside a request, Next throws, and a board that failed to
 * invalidate must not undo a delivery that has already been settled.
 */
export function nextBoardInvalidator(): BoardInvalidator {
  return {
    async invalidateBoard(slug: string): Promise<void> {
      const paths = boardPaths(slug);
      try {
        const { revalidatePath } = await import('next/cache');
        for (const path of paths) revalidatePath(path);
      } catch (error) {
        // Loud, and not fatal. The board JSON is already correct and the CDN
        // purge already ran; what is stale is a rendered page, and it will be
        // rebuilt at the next `revalidate` window. Failing the delivery over it
        // would trade a stale page for an unsettled payment.
        console.error(
          `[delivery] could not invalidate ${paths.join(', ')}: ` +
            `${error instanceof Error ? error.message : String(error)}. The board JSON is published; the ` +
            'rendered pages will be up to `revalidate` (1 day) late.',
        );
      }
    },
  };
}
