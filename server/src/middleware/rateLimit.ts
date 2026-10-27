import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AttemptStore, PaymentAttempt } from '../services/attemptStore.js';
import { userIdOf } from './auth.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Public-demo limits. 0 turns a limit off. */
export interface RateLimits {
  signInPerIpHour: number;
  aiPerUserHour: number;
  aiPerIpHour: number;
  paymentsPerUserDay: number;
  paymentsPerIpDay: number;
  paymentsPerDay: number;
}

/** Fixed-window counters in memory. A restart forgets them; payment quotas are counted from the store instead. */
export class WindowCounter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one hit. Returns the seconds until the window resets when the limit is already used up. */
  hit(key: string, max: number, windowMs: number): { ok: true } | { ok: false; retryAfter: number } {
    if (max <= 0) return { ok: true };
    const now = this.now();
    if (this.windows.size > 10_000) this.sweep(now, windowMs);
    let window = this.windows.get(key);
    if (!window || now - window.start >= windowMs) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= max) return { ok: false, retryAfter: Math.ceil((window.start + windowMs - now) / 1000) };
    window.count += 1;
    return { ok: true };
  }

  private sweep(now: number, windowMs: number) {
    for (const [key, window] of this.windows) if (now - window.start >= windowMs) this.windows.delete(key);
  }
}

function refuse(res: Response, retryAfter: number, message: string) {
  res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
  res.status(429).json({ error: { code: 'RATE_LIMITED', message } });
}

const ipOf = (req: Request) => req.ip ?? 'unknown';

/** Limits a route per client IP, and optionally per signed-in user. */
export function limitRequests(
  counter: WindowCounter,
  name: string,
  rules: { perIp?: number; perUser?: number; windowMs: number },
  message: string,
): RequestHandler {
  return (req, res, next) => {
    const byIp = counter.hit(`${name}:ip:${ipOf(req)}`, rules.perIp ?? 0, rules.windowMs);
    if (!byIp.ok) return refuse(res, byIp.retryAfter, message);
    if (rules.perUser) {
      const byUser = counter.hit(`${name}:user:${userIdOf(res)}`, rules.perUser, rules.windowMs);
      if (!byUser.ok) return refuse(res, byUser.retryAfter, message);
    }
    next();
  };
}

/** Attempts that never reached the network cost nothing, so they don't count. */
const sent = (a: PaymentAttempt) => !['created', 'awaiting_authorization', 'cancelled'].includes(a.status);

/**
 * Daily checkout quota for the public demo: per user and overall, counted from the attempt store so it
 * survives restarts, plus per IP in memory. Repeating a payment that was already sent always passes,
 * so a retry or reconciliation is never refused.
 */
export function limitPayments(store: AttemptStore, counter: WindowCounter, limits: RateLimits, now: () => number = Date.now): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      const userId = userIdOf(res);
      const body = (req.body ?? {}) as { quoteId?: unknown; paymentId?: unknown };
      const existing = typeof body.quoteId === 'string'
        ? await store.get(body.quoteId)
        : typeof body.paymentId === 'string' ? await store.findByKey(userId, 'checkout', body.paymentId) : undefined;
      if (existing && existing.userId === userId && sent(existing)) return next();

      const since = now() - DAY_MS;
      const today = (await store.list({ flow: 'checkout' })).filter((a) => sent(a) && Date.parse(a.createdAt) >= since);
      const message = 'The public demo allows a few testnet payments per day. Try again tomorrow.';
      if (limits.paymentsPerUserDay > 0 && today.filter((a) => a.userId === userId).length >= limits.paymentsPerUserDay) {
        return refuse(res, DAY_MS / 1000, message);
      }
      if (limits.paymentsPerDay > 0 && today.length >= limits.paymentsPerDay) return refuse(res, DAY_MS / 1000, message);
      const byIp = counter.hit(`payments:ip:${ipOf(req)}`, limits.paymentsPerIpDay, DAY_MS);
      if (!byIp.ok) return refuse(res, byIp.retryAfter, message);
      next();
    })().catch(next);
  };
}

export const WINDOWS = { HOUR_MS, DAY_MS };
