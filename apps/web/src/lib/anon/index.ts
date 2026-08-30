/**
 * The app's door onto `@the-pit/anon`.
 *
 * The generator lives in a package rather than here because `packages/db`'s seed
 * builder needs it too, and a package may not import from the app
 * (`PHASE-0.md §3`) while this app's board read path may not import
 * `@the-pit/db` (`test/boards-read-path.test.ts`). That package's own header
 * carries the argument in full.
 *
 * This file is one line of re-export and exists so that every call site inside
 * `apps/web` — the board projection, the verdict model, the robot component, the
 * pipeline's catalogue and its deliver step — names one import path. When the
 * package moves or gains an entry point, this is the file that changes.
 *
 * Nothing here has runtime dependencies, so importing it does not put a driver or
 * a model client on the board read path. That is the property the read-path test
 * is protecting, and it is why the generator was allowed to become a package
 * rather than being duplicated.
 */

export {
  anonIdentities,
  anonSeed,
  assignPseudonyms,
  DESIGNATIONS,
  hash32,
  pseudonymFor,
  redactRanking,
  robotSpec,
  robotSvg,
  type AnonIdentity,
  type RobotOptions,
  type RobotSpec,
} from '@the-pit/anon';
