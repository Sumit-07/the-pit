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

import { boardStats } from '@/lib/boards/home';
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

  // `brief` Part 5: never promise a rank. The share line says what the board
  // holds and where its middle sits — two facts about the category, neither of
  // which is a position, and both computed off the snapshot the page is about to
  // render rather than looked up.
  //
  // The median comes from `boardStats`, which is the homepage's own fold, run
  // over a list of one. A second median in this file would be a second answer to
  // "where is the middle of a board", and the two would part the first time
  // either was touched.
  const headline =
    `${document_.category} · ${document_.productCount} products judged · ` +
    `median health ${Math.round(boardStats([toBoardView(document_)]).medianHealth)}`;
  const description = `${document_.productCount} products, every cut and the juror who took it.`;

  return {
    title: document_.category,
    description,
    alternates: { canonical: `/boards/${slug}` },
    openGraph: {
      type: 'article',
      siteName: 'The Pit',
      url: `/boards/${slug}`,
      title: headline,
      description,
    },
    twitter: { card: 'summary_large_image', title: headline, description },
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
    <div className="wrap wide" data-page="boards">
      <CategoryBoard board={toBoardView(document_)} />
    </div>
  );
}
