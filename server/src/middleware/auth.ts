import type { RequestHandler } from 'express';
import type { SessionService } from '../services/sessionService.js';

/** Requires `Authorization: Bearer <session token>` and sets `res.locals.userId`. */
export function requireSession(sessions: SessionService): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization;
    const userId = sessions.verify(header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined);
    if (!userId) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in again to continue.' } });
      return;
    }
    res.locals.userId = userId;
    next();
  };
}

/** The signed-in user id set by requireSession. */
export const userIdOf = (res: { locals: Record<string, unknown> }) => res.locals.userId as string;
