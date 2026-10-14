import { Router } from 'express';
import { userIdOf } from '../middleware/auth.js';
import type { AttemptStore } from '../services/attemptStore.js';
import { attemptView } from '../services/attemptView.js';
import { findOwnedAttempt, type CheckoutService } from '../services/checkoutService.js';
import type { DepositExecutor } from '../services/depositExecutor.js';
import { paymentIdSchema } from './checkout.js';

/** Status of any of the user's payment attempts, by Hima id or the app's payment id. */
export function paymentRoutes(store: AttemptStore, executor: DepositExecutor, checkout: CheckoutService): Router {
  const router = Router();
  router.get('/:id', (req, res, next) => {
    const id = paymentIdSchema.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Use a valid payment id.' } });
      return;
    }
    Promise.resolve()
      .then(() => executor.refresh(findOwnedAttempt(store, userIdOf(res), id.data)))
      .then((attempt) => (attempt.flow === 'checkout' ? checkout.present(attempt) : attemptView(attempt)))
      .then((view) => res.json(view))
      .catch(next);
  });
  return router;
}
