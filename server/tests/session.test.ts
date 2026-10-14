import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionService } from '../src/services/sessionService.js';
import { Clock } from './fakes.js';

const SECRET = 'x'.repeat(64);

test('issues tokens that verify to their user until they expire', () => {
  const clock = new Clock();
  const sessions = new SessionService({ secret: SECRET, ttlMs: 60_000, now: clock.now });
  const { token, expiresAt } = sessions.issue('bea.reyes@example.com');
  assert.equal(sessions.verify(token), 'bea.reyes@example.com');
  assert.equal(expiresAt, new Date(clock.t + 60_000).toISOString());
  clock.advance(60_001);
  assert.equal(sessions.verify(token), null);
});

test('rejects tampered, foreign, malformed and missing tokens', () => {
  const sessions = new SessionService({ secret: SECRET });
  const { token } = sessions.issue('bea.reyes@example.com');
  const [payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'someone@else.edu', exp: Date.now() + 60_000 })).toString('base64url');
  assert.equal(sessions.verify(`${forged}.${signature}`), null);
  assert.equal(sessions.verify(`${payload}.${signature.slice(0, -2)}AA`), null);
  assert.equal(new SessionService({ secret: 'y'.repeat(64) }).verify(token), null);
  for (const bad of [undefined, '', 'abc', `${payload}.${signature}.extra`, 'demo-lq3k9']) assert.equal(sessions.verify(bad), null);
});

test('refuses a short secret', () => {
  assert.throws(() => new SessionService({ secret: 'short' }), /SESSION_SECRET/);
});
