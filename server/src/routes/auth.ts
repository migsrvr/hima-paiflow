import { Router } from 'express';
import { z } from 'zod';
import type { SessionService } from '../services/sessionService.js';

const sessionSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });

/**
 * Demo login: the app's sign-in is mock (any well-formed email), so the server issues a signed
 * session for that email. Every user route then checks the token and the record's owner.
 * Swap for real auth (Supabase) without changing the routes that consume `res.locals.userId`.
 */
export function authRoutes(sessions: SessionService): Router {
  const router = Router();
  router.post('/session', (req, res) => {
    const input = sessionSchema.safeParse(req.body ?? {});
    if (!input.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Use a valid email address.' } });
      return;
    }
    const { token, expiresAt } = sessions.issue(input.data.email);
    res.json({ token, expiresAt, userId: input.data.email });
  });
  return router;
}
