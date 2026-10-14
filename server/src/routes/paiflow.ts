import { Router } from 'express';
import type { PaiflowRegistry } from '../integrations/paiflow/registry.js';
import type { FlowCatalog } from '../services/flowCatalog.js';

/**
 * Safe metadata about Hima's three deployments: readiness, problems and the public addresses they
 * pay. Never tokens, webhook secrets or private configuration.
 */
export function paiflowRoutes(registry: PaiflowRegistry, catalog: FlowCatalog): Router {
  const router = Router();
  router.get('/flows', (_req, res, next) => {
    registry.statuses().then((statuses) => {
      res.json({
        flows: statuses.map((s) => ({
          ...s,
          expected: s.flow === 'checkout' ? catalog.checkout : s.flow === 'allowance' ? catalog.allowance : catalog.reward,
        })),
      });
    }).catch(next);
  });
  return router;
}
