/**
 * Worker process entry (`pool: 'process'`): forked by ProcessPool, one per worker lane. It rebuilds the parent's run
 * (config, specs, plan, support code) and runs the plan nodes it is sent. See runtime/src/pool.ts.
 */
import { serveWorker } from '@bddr/runtime';
import { prepareWorker } from './run.js';

serveWorker(prepareWorker);
