/**
 * Folding the raw score log into one row per (juror, product, metric).
 *
 * Both the merit composite (`01 §6.1`) and the scorecard (`01 §6.6`) need the
 * same view of the score log, and `01 §6` is explicit that the board and the
 * health stats share their arithmetic "so they always agree". This module is
 * that shared view.
 *
 * A juror scoring more than `CHUNK_SIZE` products makes `ceil(n / CHUNK_SIZE)`
 * calls (`01 §5.1`), which can arrive as several `ScoreLogEntry` values with the
 * same `juror_role`. They MUST be merged before anything normalizes, because
 * `01 §6.1` z-normalizes a juror's scores **across products** — a z-score taken
 * within one chunk would rank a product against 40 arbitrary neighbours instead
 * of against the category.
 */

import type { MetricScore, ScoreLogEntry } from '../types.js';

/** One juror's complete scores, keyed for lookup: product id -> metric name -> metric. */
export interface MergedJuror {
  role: string;
  rows: Map<number, Map<string, MetricScore>>;
}

/**
 * Merge a score log into one `MergedJuror` per distinct `juror_role`, in
 * first-appearance order.
 *
 * Within a juror, a repeated (product, metric) pair takes the last value seen.
 * That only arises from a retried or overlapping chunk, where the later call is
 * the one that completed.
 */
export function mergeScoreLog(scoreLog: readonly ScoreLogEntry[]): MergedJuror[] {
  const byRole = new Map<string, MergedJuror>();
  const order: MergedJuror[] = [];

  for (const entry of scoreLog) {
    let juror = byRole.get(entry.juror_role);
    if (juror === undefined) {
      juror = { role: entry.juror_role, rows: new Map() };
      byRole.set(entry.juror_role, juror);
      order.push(juror);
    }
    for (const row of entry.scores) {
      let metrics = juror.rows.get(row.id);
      if (metrics === undefined) {
        metrics = new Map();
        juror.rows.set(row.id, metrics);
      }
      for (const metric of row.metrics) metrics.set(metric.name, metric);
    }
  }

  return order;
}
