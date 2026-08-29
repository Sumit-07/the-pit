/**
 * Shared sample panel inputs. Not a test file — `vitest.config.ts` collects only
 * `test/**\/*.test.ts`.
 */

import type { PanelOrdering } from '../../src/panels/index.js';
import type { JurorMandate, Persona, Product, RubricMetric } from '../../src/types.js';

/** Pins every deterministic render order in the tests. */
export const ORDERING: PanelOrdering = { category: 'Developer Tools', categoryVersion: 'v7' };

export function product(id: number, name: string, description: string): Product {
  return {
    id,
    name,
    description,
    url: `https://example.com/${id}`,
    normalized_url: `example.com/${id}`,
    orig_rank: id + 1,
  };
}

export const PRODUCTS: Product[] = [
  product(0, 'Fathom', 'Records and summarises sales calls without a bot joining the meeting.'),
  product(1, 'Loomly', 'Schedules social posts for small marketing teams and flags brand-guideline breaks.'),
  product(2, 'Kettle', 'Turns a Postgres table into a typed HTTP API in one command.'),
];

export const METRICS: RubricMetric[] = [
  {
    name: 'Craft',
    description: 'How well the thing is actually built and finished.',
    anchors: {
      '100': 'Nothing to fix; the details a rushed team would skip are all handled.',
      '80': 'Solid and considered, with one or two rough edges.',
      '50': 'Works, but obviously unfinished in places a user will hit.',
      '20': 'Barely holds together; the seams show everywhere.',
    },
  },
  {
    name: 'Utility',
    description: 'How much real work it takes off someone.',
    anchors: {
      '100': 'Removes a whole recurring chore for a clearly named person.',
      '80': 'Saves real time on a task people do often.',
      '50': 'Helps a little, or helps a lot of people rarely.',
      '20': 'Solves something nobody was struggling with.',
    },
  },
  {
    name: 'Clarity',
    description: 'How quickly a stranger understands what it is.',
    anchors: {
      '100': 'One sentence and you know exactly who it is for and what it does.',
      '80': 'Clear after a short read.',
      '50': 'Understandable, but you have to work for it.',
      '20': 'Could be almost anything.',
    },
  },
];

export const JUROR: JurorMandate = {
  role: 'The Operator',
  who: 'Ran support for a 40-person SaaS company for six years.',
  cares_most: 'Whether the thing survives contact with a real workday.',
  biased_against: 'Demos that only work on the happy path.',
  voice: 'Flat, specific, allergic to adjectives.',
  weights: { Craft: 1, Utility: 2, Clarity: 0.5 },
};

export const PERSONA: Persona = {
  name: 'Ana Ruiz',
  description: 'Solo consultant billing eight clients a month out of a spare room.',
  needs: ['Something that works on the first evening', 'No seat minimums'],
  price_sensitivity: 'high',
};
