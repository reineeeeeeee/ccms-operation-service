import { RateLimitHit } from './db.js';

/**
 * Fixed-window rate limiter for the public (no login) endpoints.
 *
 * On Vercel every request may run in a different serverless instance, so counting in process
 * memory would not limit anything. The default store for services is therefore a small table in
 * the service's own Neon database (rate_limit_hits): one atomic upsert per request.
 * The in-memory store is kept for tests and for running a single local process.
 *
 *   const limiter = createRateLimiter({ store: createDbStore(getDb) });
 *   const { allowed, retryAfterSeconds } = await limiter.check(key, { limit: 60, windowMs: 60_000 });
 */

/** In-process store. Per process only. */
export function createMemoryStore() {
  const hits = new Map(); // key -> { count, resetAt }
  let lastSweep = 0;
  return {
    async hit(key, windowMs, time) {
      if (time - lastSweep >= 60_000 || hits.size >= 10_000) {
        lastSweep = time;
        for (const [k, entry] of hits) if (entry.resetAt <= time) hits.delete(k);
      }
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= time) {
        entry = { count: 0, resetAt: time + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return { count: entry.count, resetAt: entry.resetAt };
    },
    async reset() {
      hits.clear();
    },
  };
}

/**
 * Database store: counts in the rate_limit_hits table, so every instance of the service shares
 * one counter. The service must list RateLimitHit in its entities (the table is auto-created).
 */
export function createDbStore(getDb) {
  let lastSweep = 0;
  return {
    async hit(key, windowMs, time) {
      const dataSource = await getDb();
      const now = new Date(time);
      const resetAt = new Date(time + windowMs);
      const rows = await dataSource.query(
        `INSERT INTO rate_limit_hits (key, count, reset_at) VALUES ($1, 1, $2)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN rate_limit_hits.reset_at <= $3 THEN 1 ELSE rate_limit_hits.count + 1 END,
           reset_at = CASE WHEN rate_limit_hits.reset_at <= $3 THEN $2 ELSE rate_limit_hits.reset_at END
         RETURNING count, reset_at`,
        [key, resetAt, now],
      );
      if (time - lastSweep >= 60_000) {
        lastSweep = time;
        // Housekeeping only; a failure here must never affect the request.
        dataSource.getRepository(RateLimitHit).createQueryBuilder().delete().where('reset_at <= :now', { now }).execute().catch(() => {});
      }
      return { count: Number(rows[0].count), resetAt: new Date(rows[0].reset_at).getTime() };
    },
    async reset() {
      const dataSource = await getDb();
      await dataSource.getRepository(RateLimitHit).clear();
    },
  };
}

export function createRateLimiter({ now = () => Date.now(), store = createMemoryStore(), failOpen = true } = {}) {
  return {
    /** Counts one request. Returns { allowed, retryAfterSeconds }. */
    async check(key, { limit, windowMs }) {
      const time = now();
      let result;
      try {
        result = await store.hit(key, windowMs, time);
      } catch (err) {
        // A broken counter must not take the public site down.
        if (!failOpen) throw err;
        console.warn('Rate limit store unavailable, allowing request:', err.message);
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (result.count > limit) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt - time) / 1000)) };
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },
    async reset() {
      await store.reset();
    },
  };
}

/** Team-set numbers; override with PUBLIC_RATE_LIMIT (requests) and PUBLIC_RATE_WINDOW_SECONDS. */
export function publicLimits(env = process.env) {
  const limit = Number(env.PUBLIC_RATE_LIMIT);
  const windowSeconds = Number(env.PUBLIC_RATE_WINDOW_SECONDS);
  return {
    limit: Number.isInteger(limit) && limit > 0 ? limit : 60,
    windowMs: (Number.isInteger(windowSeconds) && windowSeconds > 0 ? windowSeconds : 60) * 1000,
  };
}
