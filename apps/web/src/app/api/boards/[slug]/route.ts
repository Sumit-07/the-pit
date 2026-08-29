import { NextResponse } from 'next/server';

import { BOARD_CACHE_CONTROL } from '@/lib/pipeline/snapshot';
import { defaultBindings } from '@/lib/pipeline/service';

/**
 * A category board, served as the static JSON a placement already wrote.
 *
 * `brief` Part 3: "Boards are **CDN snapshots**, regenerated on placement. Reads
 * never touch a model." `02 §4`: "The board never computes anything at read
 * time."
 *
 * So this route reads one file and returns it. It does not rank, re-weight,
 * re-derive a composite or open a `ModelClient` — it has no way to, because
 * nothing it imports takes one. The regeneration happens in the pipeline's
 * `deliver` step, which runs once per delivered run, and a placement is the only
 * event that triggers it.
 *
 * The response is cached hard at the edge and revalidated in the background, so a
 * board survives the moment a placement is rewriting it. Browsers are told
 * `max-age=0` because `brief §1.2` reshuffles every rank on every placement, and
 * a locally cached board would show positions that no longer exist.
 *
 * A board that has never been published is a 404 rather than an empty board: a
 * category with no snapshot has not been run, and serving `[]` for it would let a
 * front end render "no products" over a category that has forty.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const snapshot = await defaultBindings().snapshots.read(slug);

  if (snapshot === undefined) {
    return NextResponse.json(
      { error: 'no board', slug, detail: 'this category has no published snapshot yet' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(snapshot, { headers: { 'Cache-Control': BOARD_CACHE_CONTROL } });
}
