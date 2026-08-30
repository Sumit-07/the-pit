/** Installs `ts-resolve.mjs` as a resolver hook. Passed to node with `--import`. */
import { register } from 'node:module';

register('./ts-resolve.mjs', import.meta.url);
