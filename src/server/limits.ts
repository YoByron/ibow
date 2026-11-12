/** A fixed-window rate limiter held in memory: one process serves one business (D-009), so nothing is shared. */

export interface Limit {
  max: number;
  windowMs: number;
}

export interface Limiter {
  /** Counts one hit for `key`; false once the key has used up its window. */
  hit(key: string, now: number): boolean;
  /** Whether `key` is over the limit right now, without counting. */
  blocked(key: string, now: number): boolean;
  reset(key: string): void;
}

export function createLimiter({ max, windowMs }: Limit): Limiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = 0;

  function current(key: string, now: number): { count: number; resetAt: number } | undefined {
    if (now >= nextSweep) {
      for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
      nextSweep = now + windowMs;
    }
    const w = windows.get(key);
    return w !== undefined && w.resetAt > now ? w : undefined;
  }

  return {
    hit(key, now) {
      const w = current(key, now);
      if (w === undefined) {
        windows.set(key, { count: 1, resetAt: now + windowMs });
        return max >= 1;
      }
      w.count++;
      return w.count <= max;
    },
    blocked(key, now) {
      return (current(key, now)?.count ?? 0) >= max;
    },
    reset(key) {
      windows.delete(key);
    },
  };
}

export interface Backoff {
  /** Attempts allowed before a lockout. */
  max: number;
  /** The first lockout; each further one doubles, up to `maxMs`. Also the window attempts are counted in. */
  windowMs: number;
  maxMs: number;
}

export interface Lockout {
  /** Reserves one attempt for `key` before it is checked; false while locked out or once attempts run out. */
  attempt(key: string, now: number): boolean;
  /** A success clears the key, backoff included. */
  reset(key: string): void;
}

/** Attempts per key with exponential lockouts: `max` tries, then locked for windowMs, 2×, 4×, … up to maxMs. */
export function createLockout({ max, windowMs, maxMs }: Backoff): Lockout {
  const state = new Map<string, { count: number; windowEnd: number; lockedUntil: number; level: number }>();
  let nextSweep = 0;
  return {
    attempt(key, now) {
      if (now >= nextSweep) {
        for (const [k, s] of state) if (Math.max(s.windowEnd, s.lockedUntil) + maxMs <= now) state.delete(k);
        nextSweep = now + windowMs;
      }
      let s = state.get(key);
      if (s === undefined) {
        s = { count: 0, windowEnd: now + windowMs, lockedUntil: 0, level: 0 };
        state.set(key, s);
      }
      if (s.lockedUntil > now) return false;
      if (now >= s.windowEnd) {
        s.count = 0;
        s.windowEnd = now + windowMs;
      }
      s.count++;
      if (s.count <= max) return true;
      s.lockedUntil = now + Math.min(windowMs * 2 ** s.level, maxMs);
      s.level++;
      s.count = 0;
      s.windowEnd = s.lockedUntil + windowMs;
      return false;
    },
    reset(key) {
      state.delete(key);
    },
  };
}
