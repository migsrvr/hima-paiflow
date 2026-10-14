import { Router } from 'express';
import { z } from 'zod';
import type { ChatClient } from '../services/chatService.js';

const chatSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  context: z.unknown().optional(),
});

export function aiRoutes(ai: ChatClient): Router {
  const router = Router();
  router.post('/chat', (req, res, next) => {
    if (!req.is('application/json')) {
      res.status(415).json({ error: { code: 'JSON_REQUIRED', message: 'Send this request as application/json.' } });
      return;
    }
    const input = chatSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Provide a question containing 1 to 2000 characters.' } });
      return;
    }
    // Explicit rejection handling works with both Express 4 and Express 5.
    ai.ask(input.data.question, input.data.context).then((reply) => {
      res.json({ text: reply.text, calculated: reply.calculated ?? [], suggestion: reply.suggestion ?? null });
    }).catch(next);
  });
  return router;
}
