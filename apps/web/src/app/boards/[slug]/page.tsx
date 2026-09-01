/**
 * One category board, at a permanent URL.
 *
 * `brief` Part 6: "free, CDN-cached, deduction ledgers expandable per row. Lead
 * with deductions and reasons, not composites."
 *
 * The route's whole job is: resolve a slug to a stored JSON document, project it,
 * render it. `generateStaticParams` prerenders every category that has a board, so
 * in production these are static files behind a CDN and a visitor never reaches a
 * server at all — which is what `brief` Part 3 means by a read that never touches
 * a model, and what `02 §4` means by a board that computes nothing at read time.
 *
 * `dynamicParams` stays on so a category published after this build still renders
 * (once, then it is cached); a slug with no board is a 404 rather than an empty
 * board, because serving an empty board for a category that has forty products
 * would read as "nobody entered" instead of "not published here".
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { defaultBoardSource } from '@/lib/boards/source';
import { toBoardView } from '@/lib/boards/view';
import { CategoryBoard } from '@/components/category-board';

export const revalidate = 86400;
export const dynamicParams = true;

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return (await defaultBoardSource().list()).map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const document_ = await defaultBoardSource().read(slug);
  if (document_ === undefined) return { title: 'No board here' };
  return {
    title: document_.category,
    // `brief` Part 5: never promise a rank. The description says what the board
    // holds and what it cost, and stamps the count — not a position.
    description: `${document_.productCount} products, every cut and the juror who took it.`,
  };
}

export default async function BoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<ReactNode> {
  const { slug } = await params;
  const document_ = await defaultBoardSource().read(slug);
  if (document_ === undefined) notFound();

  return (
    <div className="wrap wide">
      <nav>
        <a className="mark" href="/">
          THE <i>PIT</i>
        </a>
        <span className="navr">
          <a className="navlink" href="/how-it-works">
            how it works
          </a>
          <a className="navlink" href="/boards">
            all boards
          </a>
        </span>
      </nav>
      <CategoryBoard board={toBoardView(document_)} />
    </div>
  );
}
