import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import type { PaiflowRegistry } from './integrations/paiflow/registry.js';
import { requireSession } from './middleware/auth.js';
import { limitPayments, limitRequests, WINDOWS, WindowCounter, type RateLimits } from './middleware/rateLimit.js';
import { aiRoutes } from './routes/ai.js';
import { authRoutes } from './routes/auth.js';
import { checkoutRoutes } from './routes/checkout.js';
import { merchantRoutes } from './routes/merchants.js';
import { paiflowRoutes } from './routes/paiflow.js';
import { paymentRoutes } from './routes/payments.js';
import { walletRoutes } from './routes/wallet.js';
import type { AttemptStore } from './services/attemptStore.js';
import { ChatServiceError, type ChatClient } from './services/chatService.js';
import type { CheckoutService } from './services/checkoutService.js';
import type { DepositExecutor } from './services/depositExecutor.js';
import { ServiceError } from './services/errors.js';
import type { FlowCatalog } from './services/flowCatalog.js';
import type { SessionService } from './services/sessionService.js';
import type { WalletService } from './services/walletService.js';

export interface AppServices {
  ai: ChatClient;
  sessions: SessionService;
  registry: PaiflowRegistry;
  catalog: FlowCatalog;
  attempts: AttemptStore;
  executor: DepositExecutor;
  checkout: CheckoutService;
  wallet: WalletService;
}

interface AppOptions extends AppServices {
  corsOrigins?: string[];
  /** Public-demo limits on sign-in, AI and payments. Omitted: no limits (tests, local tools). */
  limits?: RateLimits;
  /** Express `trust proxy`, so limits count the client's IP behind Render's proxy. */
  trustProxy?: boolean | number;
  /** Refills the testnet paying wallet after payments when it runs low. */
  topUp?: { maybeTopUp(): Promise<unknown>; balance(): Promise<bigint | null> };
  /** Request and diagnostic log (default console.log). Tests pass a no-op. */
  log?: (message: string) => void;
}

export function createApp({ corsOrigins = [], log = console.log, limits, trustProxy = false, topUp, ...s }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  const counter = new WindowCounter();
  const pass: express.RequestHandler = (_req, _res, next) => next();
  // One line per request: method, path (no query string), status, time and browser origin. Never bodies.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const origin = req.headers.origin ? ` origin=${req.headers.origin}` : '';
      log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - started} ms${origin}`);
    });
    next();
  });
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Native apps send no Origin and need no CORS. Browsers (the Expo web preview) must be listed in
  // CORS_ORIGINS; otherwise the browser blocks the call after the preflight, so say so once per origin.
  const warned = new Set<string>();
  app.use(cors({
    origin(origin, callback) {
      if (!origin || corsOrigins.includes(origin)) {
        callback(null, Boolean(origin));
        return;
      }
      if (!warned.has(origin)) {
        warned.add(origin);
        log(`[cors] Blocked browser requests from ${origin}. Add it to CORS_ORIGINS in server/.env and restart the server.`);
      }
      callback(null, false);
    },
  }));
  app.use(express.json({ limit: '32kb' }));

  // A liveness/configuration probe, not an external provider availability check.
  app.get('/health', (_req, res) => res.json({
    status: 'ok',
    ai: s.ai.configured,
    payments: s.checkout.configured && s.registry.configured('checkout'),
  }));

  // Readiness is public and reports only persistent-store health, never database details.
  app.get('/ready', (_req, res) => {
    s.attempts.ready().then(() => res.json({ status: 'ready' })).catch(() => {
      res.status(503).json({ status: 'not_ready' });
    });
  });

  // Public: what the demo allows, and whether the shared testnet wallet can pay. No addresses or secrets.
  app.get('/api/demo/status', (_req, res, next) => {
    (topUp ? topUp.balance() : Promise.resolve(null)).then((stroops) => res.json({
      limits: limits ?? null,
      wallet: { xlm: stroops === null ? null : Number(stroops / 10_000_000n) },
    })).catch(next);
  });

  // Public: sign-in, deployment readiness (no secrets), merchant tag lookup.
  app.use('/api/auth', limits
    ? limitRequests(counter, 'signin', { perIp: limits.signInPerIpHour, windowMs: WINDOWS.HOUR_MS }, 'Too many sign-ins from this network. Try again later.')
    : pass, authRoutes(s.sessions));
  app.use('/api/paiflow', paiflowRoutes(s.registry, s.catalog));
  app.use('/api/merchants', merchantRoutes());

  // Everything with user data needs a session; records belonging to someone else are "not found".
  const signedIn = requireSession(s.sessions);
  app.use('/api/ai', signedIn, limits
    ? limitRequests(counter, 'ai', { perIp: limits.aiPerIpHour, perUser: limits.aiPerUserHour, windowMs: WINDOWS.HOUR_MS },
      "You've asked Hima a lot this hour. Try again later.")
    : pass, aiRoutes(s.ai));
  app.use('/api/wallet', signedIn, walletRoutes(s.wallet));
  app.use('/api/checkout', signedIn, checkoutRoutes(s.checkout, {
    beforePay: limits ? limitPayments(s.attempts, counter, limits) : pass,
    // After each payment, refill the shared testnet wallet if it is running low (at most hourly).
    afterPay: () => { void topUp?.maybeTopUp(); },
  }));
  app.use('/api/payments', signedIn, paymentRoutes(s.attempts, s.executor, s.checkout));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } });
  });
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    if (error instanceof ChatServiceError || error instanceof ServiceError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    const type = error && typeof error === 'object' && 'type' in error ? error.type : undefined;
    if (type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'REQUEST_TOO_LARGE', message: 'Keep the JSON request below 32 KB.' } });
      return;
    }
    if (type === 'entity.parse.failed' || error instanceof URIError) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'The request contains invalid JSON or URL encoding.' } });
      return;
    }
    log(`[error] ${error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error'}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
  };
  app.use(errorHandler);
  return app;
}
