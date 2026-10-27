import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { userIdOf } from '../middleware/auth.js';
import type { CheckoutService } from '../services/checkoutService.js';

export const paymentIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{6,64}$/);

const requestSchema = z.object({
  paymentId: paymentIdSchema,
  merchantId: z.string().trim().min(1).max(64),
  amount: z.number().positive().finite(),
  // The Hima receipt reference ("HM-1014-0042"), stored with the payment for cross-reference.
  reference: z.string().trim().regex(/^[A-Za-z0-9-]{1,32}$/),
}).strict();

const paySchema = z.union([z.object({ quoteId: paymentIdSchema }).strict(), requestSchema]);

function json(req: Request, res: Response): boolean {
  if (req.is('application/json')) return true;
  res.status(415).json({ error: { code: 'JSON_REQUIRED', message: 'Send this request as application/json.' } });
  return false;
}

/** Flow 1. The client never chooses an address: the merchant maps to the checkout deployment. */
export function checkoutRoutes(
  checkout: CheckoutService,
  hooks: { beforePay?: RequestHandler; afterPay?: () => void } = {},
): Router {
  const router = Router();

  // Prices the payment and its 90/10 split; nothing is prepared or signed until it is paid.
  router.post('/quote', (req, res, next) => {
    if (!json(req, res)) return;
    const input = requestSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Provide paymentId, merchantId, amount and reference.' } });
      return;
    }
    checkout.quote(userIdOf(res), input.data).then((view) => res.json(view)).catch(next);
  });

  // After the student authorizes on the phone: `{ quoteId }`, or a full request to quote and pay at once.
  router.post('/payments', hooks.beforePay ?? ((_req, _res, next) => next()), (req, res, next) => {
    if (!json(req, res)) return;
    const input = paySchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Provide a quoteId, or paymentId, merchantId, amount and reference.' } });
      return;
    }
    checkout.pay(userIdOf(res), input.data).then((view) => {
      res.json(view);
      hooks.afterPay?.();
    }).catch(next);
  });

  return router;
}
