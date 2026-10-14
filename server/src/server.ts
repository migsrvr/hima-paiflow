import { createApp } from './app.js';
import { compose } from './compose.js';
import { loadConfig } from './config.js';

function start() {
  const config = loadConfig();
  const services = compose(config);
  const server = createApp({ ...services, corsOrigins: config.corsOrigins }).listen(config.port, config.host, () => {
    console.log(`Hima server listening on http://${config.host}:${config.port}`);
    console.log(`AI: ${services.ai.configured ? `Groq, model ${config.model}` : 'off (GROQ_API_KEY is unset; AI requests return 503)'}`);
    console.log(config.corsOrigins.length
      ? `Browser origins allowed (CORS_ORIGINS): ${config.corsOrigins.join(', ')}`
      : 'No browser origins allowed (CORS_ORIGINS is empty): the phone app works, the web preview is blocked.');
    for (const warning of services.warnings) console.warn(`[config] ${warning}`);
    if (!services.student) console.warn('[wallet] STELLAR_STUDENT_SECRET is unset: checkout returns 503. Run npm run stellar:setup.');
    // Each deployment's readiness, from its recorded capabilities. Never prints tokens or secrets.
    services.registry.statuses().then((statuses) => {
      for (const s of statuses) {
        const id = s.deploymentId ? ` ${s.deploymentId.slice(0, 8)}…` : '';
        console.log(`[paiflow] ${s.flow}${id}: ${s.ready ? 'ready' : `not ready — ${s.problems.join(' ')}`}`);
      }
    }).catch(() => console.warn('[paiflow] Could not check deployment readiness.'));
  });
  server.requestTimeout = Math.max(config.timeoutMs, config.paiflow.timeoutMs * 2) + 5000;
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(`Server failed to listen (${error.code ?? 'unknown error'}).`);
    process.exitCode = 1;
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const force = setTimeout(() => {
      server.closeAllConnections();
      process.exitCode = 1;
    }, config.timeoutMs + 5000);
    force.unref();
    server.close(() => { clearTimeout(force); });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

try { start(); } catch (error) {
  console.error(error instanceof Error ? error.message : 'Unable to start Hima server.');
  process.exitCode = 1;
}
