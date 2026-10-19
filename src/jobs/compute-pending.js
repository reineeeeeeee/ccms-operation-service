import { getDb } from '../lib/data-source.js';
import { runtimeDeps } from '../modules/transaction/deps.js';
import { runComputePending as compute } from '../modules/transaction/compute-pending.js';

/** One run of compute-pending (CC023): batch of 50 completed transactions without a result. */
export async function runComputePending(overrides = {}) {
  const { core } = runtimeDeps();
  return compute({ dataSource: await getDb(), core, ...overrides });
}
