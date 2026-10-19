import { createCoreClient } from './core-client.js';

/** What the routes use at run time: the Core client (built from the environment on every call) and the clock. */
export function runtimeDeps() {
  return { core: createCoreClient(), now: () => new Date() };
}
