import { getDb } from '../lib/data-source.js';
import { runtimeDeps } from '../modules/transaction/deps.js';
import { runAutoClose } from '../modules/transaction/auto-close.js';

/** One run of auto-close (CC028): batch of 100 oldest open transactions. */
export async function runAutoCloseJob(overrides = {}) {
  const { core, now } = runtimeDeps();
  return runAutoClose({ dataSource: await getDb(), core, now, ...overrides });
}
