import { Router } from 'express';
import type { WalletService } from '../services/walletService.js';

export function walletRoutes(wallet: WalletService): Router {
  const router = Router();

  // Hima's testnet paying wallet, its balance and the demo rate. No balance is ever invented on error.
  router.get('/stellar', (_req, res, next) => {
    wallet.wallet().then((view) => res.json(view)).catch(next);
  });

  // Read-only lookup for a linked Freighter address.
  router.get('/stellar/accounts/:address', (req, res, next) => {
    wallet.lookupAccount(req.params.address).then((account) => res.json(account)).catch(next);
  });

  return router;
}
