/**
 * The figures on the verdict page.
 *
 * The rule every test here follows: **an assertion that cannot fail when the
 * derivation breaks is not a test of the derivation.** So nothing below asserts
 * "a grid was rendered" or "the html contains a percent sign". Each one either
 *
 *  - recomputes the value independently from the parsed verdict (summing raw
 *    deductions by role and metric, say) and demands the figure agree, or
 *  - pins a number hand-derived from the committed `cjr/runs/.../ranking.json`,
 *
 * and then reads the value back out of the rendered HTML, so a chart that draws a
 * width the derivation did not produce fails here rather than looking plausible.
 *
 * The three rules the figures themselves are bound by — a solo cluster draws no
 * demand chart, the table view carries the same numbers the cells encode, and
 * nothing is ever recomputed from a live board — each have a test that fails if
 * they are dropped.
 */

import { describe, expect, it } from 'vitest';

import {
  CUT_RAMP,
  cutMatrix,
  demandChart,
  lossChart,
  rampLabel,
  rampStep,
} from '@/lib/verdict/charts';
import { TOKENS } from '@/lib/theme';
import { parseVerdict, type Verdict } from '@/lib/verdict/model';
import { renderVerdictPage } from '@/lib/verdict/page';

import { handBuiltVerdict, seededVerdictNamed } from './helpers/verdict.js';

async function seeded(slug: string, name: string): Promise<Verdict> {
  return parseVerdict(await seededVerdictNamed(slug, name));
}

/** Sum the raw deductions independently of `cutMatrix`, straight off the ledger. */
function pointsFor(verdict: Verdict, role: string, metric: string): number {
  return verdict.metrics
    .filter((entry) => entry.metric === metric)
    .flatMap((entry) => entry.deductions)
    .filter((deduction) => deduction.role === role)
    .reduce((sum, deduction) => sum + deduction.points, 0);
}

/** Every `data-points` on the rendered grid, in document order. */
function cellPoints(html: string): number[] {
  return [...html.matchAll(/<span class="mxc [^"]*" data-points="(\d+)"/g)].map(([, value]) => Number(value));
}

describe('the ramp', () => {
  it('bins a juror’s points into five steps and leaves zero unpainted', () => {
    // The breaks are 10 / 25 / 50 / 75. Both sides of each one.
    expect(rampStep(0)).toBe(0);
    expect(rampStep(1)).toBe(1);
    expect(rampStep(10)).toBe(1);
    expect(rampStep(11)).toBe(2);
    expect(rampStep(25)).toBe(2);
    expect(rampStep(26)).toBe(3);
    expect(rampStep(50)).toBe(3);
    expect(rampStep(51)).toBe(4);
    expect(rampStep(75)).toBe(4);
    expect(rampStep(76)).toBe(5);
    expect(rampStep(100)).toBe(5);
  });

  it('labels each step from the same breaks it bins by', () => {
    expect([1, 2, 3, 4, 5].map(rampLabel)).toEqual(['1–10', '11–25', '26–50', '51–75', '76+']);
  });

  it('is one hue in five steps, monotonically lighter — a sequential ramp, not a set of colours', () => {
    // The validated values, pinned. `scripts/validate_palette.js --ordinal --mode
    // dark --surface "#1a1610"` passes on exactly this list; a step edited without
    // re-running it fails here first.
    expect(CUT_RAMP).toEqual(['#763c2d', '#974631', '#b95035', '#dc5a38', '#ff653c']);
    const luminance = CUT_RAMP.map((hex) => {
      const channel = (offset: number): number => {
        const value = parseInt(hex.slice(1 + offset * 2, 3 + offset * 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    });
    for (let i = 1; i < luminance.length; i += 1) {
      expect(luminance[i]).toBeGreaterThan(luminance[i - 1] ?? 0);
    }
  });

  it('stays on the theme’s own accent hue, so a re-theme cannot leave it behind', () => {
    // `lib/theme.ts`: two hues, and --cut is the one that means TAKEN. A heatmap
    // of deductions is the most literal instance of that there is, so the ramp is
    // that hue stepped — not a hue chosen to look like it. If --cut moves, these
    // five hexes are stale, and a stale ramp is a third hue in a two-hue system.
    // Hue is compared in OKLab, which is where the ramp was built.
    const hue = (hex: string): number => {
      const lin = [0, 1, 2].map((offset) => {
        const value = parseInt(hex.slice(1 + offset * 2, 3 + offset * 2), 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      const [r = 0, g = 0, b = 0] = lin;
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      return (
        (Math.atan2(
          0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
          1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        ) *
          180) /
        Math.PI
      );
    };

    const cut = /--cut:(#[0-9A-Fa-f]{6})/.exec(TOKENS)?.[1];
    expect(cut, '--cut is declared in the theme').toBeDefined();
    for (const step of CUT_RAMP) {
      expect(Math.abs(hue(step) - hue(cut ?? '#000000')), `${step} is on --cut’s hue`).toBeLessThan(1.5);
    }
  });
});

describe('the juror × metric matrix', () => {
  it('puts every juror’s own points in their own cell, summed when they cut twice', async () => {
    const verdict = await seeded('developer-tools', 'Sequo');
    const matrix = cutMatrix(verdict);

    // Every cell agrees with a sum taken independently off the ledger.
    for (const row of matrix.rows) {
      for (const cell of row.cells) {
        expect(cell.points, `${row.role} × ${cell.metric}`).toBe(pointsFor(verdict, row.role, cell.metric));
      }
    }

    // And one hand-derived from `cjr/runs/developer-tools/ranking.json`: the
    // Release Engineer took TWO cuts on Durability, 40 and 30. A matrix that
    // kept the last one, or the heaviest, reads 40 or 30 here instead of 70.
    const durability = matrix.rows
      .find((row) => row.role === 'The Release Engineer')
      ?.cells.find((cell) => cell.metric === 'Durability');
    expect(durability?.points).toBe(70);
    expect(durability?.deductions).toHaveLength(2);
    expect(durability?.step).toBe(rampStep(70));
  });

  it('carries all six jurors and every metric, with the ledger’s column order', async () => {
    const verdict = await seeded('developer-tools', 'Sequo');
    const matrix = cutMatrix(verdict);

    expect(matrix.rows).toHaveLength(6);
    expect(matrix.metrics).toEqual(verdict.metrics.map((metric) => metric.metric));
    // Heaviest merged loss first — the ledger's own order, so the leftmost
    // column is where the panel took the most.
    expect(matrix.metrics[0]).toBe('Durability');
    for (const row of matrix.rows) expect(row.cells).toHaveLength(matrix.metrics.length);
  });

  it('orders rows by what the juror took, and names the single deepest cut', async () => {
    const verdict = await seeded('developer-tools', 'Sequo');
    const matrix = cutMatrix(verdict);

    const totals = matrix.rows.map((row) => row.total);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    for (const row of matrix.rows) {
      expect(row.total).toBe(row.cells.reduce((sum, cell) => sum + cell.points, 0));
    }

    // Sequo's heaviest single cut is the Platform Owner's -80 on Durability,
    // which is also the card's pull quote — one number, one definition.
    expect(matrix.heaviest?.role).toBe('The Platform Owner');
    expect(matrix.heaviest?.metric).toBe('Durability');
    expect(matrix.heaviest?.points).toBe(80);
    expect(verdict.sharpest?.points).toBe(80);
  });

  it('states the score a juror gave, from their own points and nothing else', async () => {
    const verdict = await seeded('developer-tools', 'Sequo');
    const matrix = cutMatrix(verdict);

    for (const row of matrix.rows) {
      // `01 §5.1`: a metric starts at 100 and that juror's deductions on it sum
      // to `100 - their score`. So the mean of their scores is this, exactly.
      expect(row.meanScore).toBeCloseTo(100 - row.total / row.answered, 10);
    }

    // The mean of the six jurors' means is the card's own `cuts`, from the other
    // direction: `100 - mean(metric score)`. Two arithmetics, one number.
    const meanOfMeans =
      matrix.rows.reduce((sum, row) => sum + (row.meanScore ?? 0), 0) / matrix.rows.length;
    expect(100 - meanOfMeans).toBeCloseTo(verdict.cuts, 8);
  });

  it('never paints a juror who returned nothing as a juror who took nothing', () => {
    // The hand-built card substitutes The Docs Writer on Workflow Fit. That juror
    // scored a 50 they never gave; painting the cell would attribute an opinion
    // to them, and reading it as a 0 would credit them with agreeing.
    const verdict = parseVerdict(handBuiltVerdict());
    const matrix = cutMatrix(verdict);

    const writer = matrix.rows.find((row) => row.role === 'The Docs Writer');
    expect(writer, 'a substituted juror still gets a row').toBeDefined();
    const cell = writer?.cells.find((entry) => entry.metric === 'Workflow Fit');
    expect(cell?.substituted).toBe(true);
    expect(cell?.step).toBe(0);
    // And they are not averaged over a metric they did not answer.
    expect(writer?.answered).toBe(verdict.metrics.length - 1);

    const html = renderVerdictPage(verdict);
    expect(html).toContain('The Docs Writer returned no answer on Workflow Fit');
    expect(html).toContain('<td>no answer</td>');
  });
});

describe('the matrix, rendered', () => {
  it('draws one cell per juror per metric, each carrying the derived number', async () => {
    const verdict = await seeded('developer-tools', 'Sequo');
    const matrix = cutMatrix(verdict);
    const html = renderVerdictPage(verdict);

    const drawn = cellPoints(html);
    expect(drawn).toHaveLength(matrix.rows.length * matrix.metrics.length);
    expect(drawn).toEqual(matrix.rows.flatMap((row) => row.cells.map((cell) => cell.points)));

    // The step class is the ramp's, not an arbitrary one.
    for (const row of matrix.rows) {
      for (const cell of row.cells) {
        if (cell.points === 0) continue;
        expect(html).toContain(`<span class="mxc k${cell.step}" data-points="${cell.points}"`);
      }
    }
  });

  it('says who cut what in text, so no cell is legible only as a colour', async () => {
    const verdict = await seeded('developer-tools', 'Sequo');
    const html = renderVerdictPage(verdict);

    expect(html).toContain('aria-label="The Platform Owner took 80 off Durability"');
    // And the juror's own sentence rides the cell.
    expect(html).toContain(
      'Convenience layer over project-memory features coding-agent vendors are already adding natively.',
    );
  });

  it('lists the same numbers in the table view that the cells encode', async () => {
    const verdict = await seeded('health-fitness-wellness', 'Fuel Log');
    const matrix = cutMatrix(verdict);
    const html = renderVerdictPage(verdict);

    const table = /<details class="tv">(.*?)<\/details>/s.exec(html)?.[1] ?? '';
    expect(table).not.toBe('');

    // Row by row, the table's cells are the grid's cells — including the row
    // total and the mean score, which the grid states in its row header.
    for (const row of matrix.rows) {
      const line = new RegExp(
        `<th scope="row">${row.role.replaceAll(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}</th>(.*?)</tr>`,
        's',
      ).exec(table)?.[1];
      expect(line, `${row.role} has a table row`).toBeDefined();
      const numbers = [...(line ?? '').matchAll(/<td>(?:&minus;)?(\d+(?:\.\d+)?)<\/td>/g)].map(([, value]) =>
        Number(value),
      );
      expect(numbers.slice(0, matrix.metrics.length)).toEqual(row.cells.map((cell) => cell.points));
      expect(numbers[matrix.metrics.length]).toBe(row.total);
    }

    // Every number the grid painted is somewhere in the table.
    for (const points of cellPoints(html)) {
      if (points === 0) continue;
      expect(table).toContain(`<td>&minus;${points}</td>`);
    }
  });

  it('escapes a hostile juror role and reason inside the cell readout and its label', () => {
    const verdict = parseVerdict(
      handBuiltVerdict({
        scorecard: [
          {
            metric: 'Trust Surface',
            score: 40,
            spread: 0,
            juror_count: 6,
            substituted_roles: [],
            deductions: [
              { points: 60, reason: '<img src=x onerror=alert(1)>', role: 'The "<b>Skeptic</b>"' },
            ],
          },
        ],
      }),
    );
    const html = renderVerdictPage(verdict);

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>Skeptic</b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // Including inside the aria-label, where an unescaped quote breaks the attribute.
    expect(html).toContain('aria-label="The &quot;&lt;b&gt;Skeptic&lt;/b&gt;&quot; took 60 off Trust Surface"');
  });
});

describe('what each metric kept, with the spread', () => {
  it('plots the merged score that SURVIVED and the cross-juror spread on one axis', async () => {
    const verdict = await seeded('developer-tools', 'Sequo');
    const { bars, polarity } = lossChart(verdict);

    // The direction, asserted before the numbers: this figure was turned round to
    // match the two radials above it, and every assertion below only means
    // anything if it stayed round.
    expect(polarity).toBe('more-is-better');
    expect(bars).toHaveLength(verdict.metrics.length);
    for (const [index, bar] of bars.entries()) {
      const metric = verdict.metrics[index];
      expect(metric).toBeDefined();
      expect(bar.metric).toBe(metric?.metric);
      // What the bar draws is the score, not the loss.
      expect(bar.held).toBeCloseTo(metric?.score ?? 0, 10);
      expect(bar.cuts).toBeCloseTo(100 - (metric?.score ?? 0), 10);
      // The two halves are exactly one track, with nothing left over.
      expect(bar.held + bar.cuts).toBeCloseTo(100, 10);
      expect(bar.spread).toBe(metric?.spread);
      // The whisker is the SCORE plus or minus one standard deviation, clamped to
      // the axis it is drawn on — the mirror of the interval it used to be.
      expect(bar.low).toBeCloseTo(Math.max(0, bar.held - bar.spread), 10);
      expect(bar.high).toBeCloseTo(Math.min(100, bar.held + bar.spread), 10);
    }
  });

  it('marks the metric the panel split widest on, and only that one', async () => {
    const verdict = await seeded('developer-tools', 'Sequo');
    const { bars } = lossChart(verdict);

    const widest = Math.max(...bars.map((bar) => bar.spread));
    for (const bar of bars) expect(bar.widest).toBe(bar.spread === widest);
    // Sequo's two widest are Durability at 10.80 and Trust Surface at 10.70 —
    // close enough that a page picking by eye would get it wrong, which is why
    // it is picked by arithmetic and pinned here.
    expect(bars.find((bar) => bar.widest)?.metric).toBe('Durability');
  });

  it('draws the head at what survived, the remainder at the cut, and the whisker at the spread', async () => {
    const verdict = await seeded('developer-tools', 'Sequo');
    const { bars } = lossChart(verdict);
    const html = renderVerdictPage(verdict);

    for (const bar of bars) {
      // The head is the score. The old chart drew `bar.cuts` here, so a revert
      // fails this line rather than merely looking different.
      expect(html).toContain(`<i class="lbfill" style="width:${bar.held.toFixed(2)}%"></i>`);
      // And the cut is the rest of the same track, starting where the head ends.
      expect(html).toContain(
        `<i class="lbcut" style="left:${bar.held.toFixed(2)}%;width:${bar.cuts.toFixed(2)}%"></i>`,
      );
      expect(html).not.toContain(`<i class="lbfill" style="width:${bar.cuts.toFixed(2)}%"></i>`);
      if (bar.spread <= 0) continue;
      expect(html).toContain(
        `<i class="lbwhisk" style="left:${bar.low.toFixed(2)}%;width:${(bar.high - bar.low).toFixed(2)}%"></i>`,
      );
    }
  });

  it('draws no whisker at all when the six scored a metric identically', () => {
    const verdict = parseVerdict(
      handBuiltVerdict({
        scorecard: [
          {
            metric: 'Trust Surface',
            score: 70,
            spread: 0,
            juror_count: 6,
            substituted_roles: [],
            deductions: [{ points: 30, reason: 'No stated failure mode.', role: 'The Release Engineer' }],
          },
        ],
      }),
    );
    const html = renderVerdictPage(verdict);

    expect(lossChart(verdict).bars[0]?.spread).toBe(0);
    expect(html).not.toContain('<i class="lbwhisk"');
    expect(html).toContain('every juror scored it identically');
  });
});

describe('the Floor', () => {
  it('is not drawn at all for a solo cluster, which is the majority case', async () => {
    const verdict = await seeded('developer-tools', 'Carillon');
    expect(verdict.floor.kind).toBe('solo');
    expect(demandChart(verdict)).toBeNull();

    const html = renderVerdictPage(verdict);
    // No conviction bar, no roster meter, no component meters — and above all no
    // zeros standing in for a panel that never convened (`DECISIONS.md` S3).
    expect(html).not.toContain('class="dparts"');
    expect(html).not.toContain('class="dbar"><span class="dk">Conviction');
    expect(html).not.toContain('<div class="pick">');
    // The explanation is what is there instead.
    expect(html).toContain('No buyers were shown this product, because nothing in the category was close enough');
    expect(html).toContain('that weight was moved onto merit rather than scored as a zero');
  });

  it('counts the buyers who declined rather than inventing rows for them', async () => {
    const verdict = await seeded('developer-tools', 'Sequo');
    const chart = demandChart(verdict);

    // 5 of the 6-persona roster named Sequo; the payload names the five who did
    // and never the one who did not, so the sixth is a count and not a row.
    expect(chart?.named).toBe(5);
    expect(chart?.roster).toBe(6);
    expect(chart?.silent).toBe(1);
    expect(chart?.rows).toHaveLength(5);

    const html = renderVerdictPage(verdict);
    // The wording tightened when the prose moved below the charts; the rule it
    // protects did not. The count is a COUNT, with its denominator, and never a
    // list of personas the run does not record.
    expect(html).toContain('<b>1</b> of the 6 buyers were shown it and reached for something else');
    expect(html).toContain('reached for something else');
  });

  it('draws each buyer’s conviction at the strength they gave, first choices first', async () => {
    const verdict = await seeded('developer-tools', 'Sequo');
    const chart = demandChart(verdict);
    const html = renderVerdictPage(verdict);

    // Sorted: first picks above runners-up, then by strength descending.
    const strengths = (chart?.rows ?? []).map((row) => row.strength ?? -1);
    expect([...strengths].sort((a, b) => b - a)).toEqual(strengths);

    for (const row of chart?.rows ?? []) {
      if (row.strength === null) continue;
      expect(html).toContain(`<i class="dfill" style="width:${row.strength.toFixed(2)}%"></i>`);
      expect(html).toContain(`<span class="dval">${row.strength} / 100</span>`);
    }
    // Deniz Aksoy put 60 behind it; the bar is 60% of the axis and says so.
    expect(chart?.rows.some((row) => row.persona === 'Deniz Aksoy' && row.strength === 60)).toBe(true);
  });

  it('says a runner-up carries no conviction rather than drawing an empty bar', () => {
    // `01 §6.2` records a strength only on a persona's FIRST pick. A 0%-wide bar
    // would read as "they picked you and meant nothing by it".
    const verdict = parseVerdict(
      handBuiltVerdict({
        demandStatus: 'scored',
        picks: [{ persona: 'Marco Devlin', pick: 'second', reason: 'Would pick it if the audit log were there.' }],
        rosterSize: 4,
      }),
    );
    const html = renderVerdictPage(verdict);

    expect(demandChart(verdict)?.rows[0]?.strength).toBeNull();
    expect(html).toContain('runner-up choices carry no conviction score');
    expect(html).not.toContain('style="width:0.00%"');
  });

  it('draws the four demand components as the payload froze them', async () => {
    const verdict = await seeded('developer-tools', 'Sequo');
    const chart = demandChart(verdict);
    const html = renderVerdictPage(verdict);

    expect(chart?.parts.map((part) => part.label)).toEqual(['Share', 'Capture', 'Breadth', 'Intensity']);
    for (const part of chart?.parts ?? []) {
      expect(html).toContain(`<i class="dfill" style="width:${(part.value * 100).toFixed(2)}%"></i>`);
    }
    // `breadth = share × capture` — the spec's own composition, so a page that
    // mislabelled two of these meters would disagree with itself here.
    const value = (label: string): number => chart?.parts.find((part) => part.label === label)?.value ?? Number.NaN;
    expect(value('Breadth')).toBeCloseTo(value('Share') * value('Capture'), 10);
  });
});

describe('frozen, not recomputed', () => {
  it('draws the payload’s numbers even when they no longer match any live board', async () => {
    const row = await seededVerdictNamed('developer-tools', 'Sequo');
    const payload = structuredClone(row.payload) as {
      verdict: { scorecard: { metric: string; score: number; spread: number }[] };
    };
    // A score the live board does not hold, on the metric the page sorts on.
    const first = payload.verdict.scorecard[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      first.score = 4;
      first.spread = 0;
    }

    const verdict = parseVerdict({ ...row, payload });
    const html = renderVerdictPage(verdict);
    const bar = lossChart(verdict).bars.find((entry) => entry.metric === first?.metric);

    expect(bar?.cuts).toBe(96);
    expect(bar?.held).toBe(4);
    expect(html).toContain('<i class="lbfill" style="width:4.00%"></i>');
    expect(html).toContain('<i class="lbcut" style="left:4.00%;width:96.00%"></i>');
  });
});
