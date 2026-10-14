import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/**
 * Signed session tokens for the demo's mock login: `<payload>.<HMAC-SHA256>`, payload `{ sub, exp }`.
 * Stateless; a token is valid until it expires or SESSION_SECRET changes.
 */
export class SessionService {
  private readonly key: Buffer;

  constructor(private readonly options: { secret: string; ttlMs?: number; now?: () => Date }) {
    if (options.secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
    this.key = Buffer.from(options.secret, 'utf8');
  }

  private now() {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  issue(userId: string): { token: string; expiresAt: string } {
    const exp = this.now() + (this.options.ttlMs ?? 7 * 24 * 60 * 60_000);
    const payload = b64url(JSON.stringify({ sub: userId, exp }));
    const signature = b64url(createHmac('sha256', this.key).update(payload).digest());
    return { token: `${payload}.${signature}`, expiresAt: new Date(exp).toISOString() };
  }

  /** The user id, or null for a missing, tampered or expired token. */
  verify(token: string | undefined): string | null {
    if (!token) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    const expected = createHmac('sha256', this.key).update(payload).digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown; exp?: unknown };
      if (typeof sub !== 'string' || !sub || typeof exp !== 'number' || exp <= this.now()) return null;
      return sub;
    } catch {
      return null;
    }
  }
}
