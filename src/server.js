require('dotenv').config();

const express = require('express');
const cors = require('cors');

const db = require('./config/db');
const ollama = require('./services/ollama.service');
const authRoutes = require('./routes/auth.routes');
const documentRoutes = require('./routes/document.routes');
const chatRoutes = require('./routes/chat.routes');
const agentRoutes = require('./routes/agent.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const adminRoutes = require('./routes/admin.routes');
const agentService = require('./services/agent.service');
const subscriptionService = require('./services/subscription.service');
const {
  errorHandler,
  notFoundHandler,
  asyncHandler,
} = require('./middleware/error.middleware');

const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// One-line request log - enough to follow the pipeline while learning.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
  });
  next();
});

/**
 * GET /api/health
 * Reports whether both dependencies (MongoDB Atlas and Ollama) are reachable.
 * Returns 503 if either one is down, so a monitor can act on it.
 */
app.get(
  '/api/health',
  asyncHandler(async (req, res) => {
    const [mongodb, ollamaStatus] = await Promise.all([
      db.ping().then(() => ({ reachable: true })).catch((err) => ({ reachable: false, error: err.message })),
      ollama.checkHealth(),
    ]);

    const healthy = mongodb.reachable && ollamaStatus.reachable;
    res.status(healthy ? 200 : 503).json({
      success: healthy,
      message: healthy ? 'RAG backend is running' : 'RAG backend is degraded',
      services: {
        mongodb: { ...mongodb, database: db.DB_NAME, vectorIndex: db.VECTOR_INDEX_NAME },
        ollama: {
          ...ollamaStatus,
          llmModel: ollama.LLM_MODEL(),
          embeddingModel: ollama.EMBED_MODEL(),
        },
      },
    });
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/admin', adminRoutes);

// 404 first, then the centralized error handler (must be last).
app.use(notFoundHandler);
app.use(errorHandler);

/**
 * On macOS, "AirPlay Receiver" (ControlCenter) also listens on port 5000 and
 * answers requests with an empty 403 before Express ever sees them. Detect
 * that instead of leaving you debugging a phantom 403.
 */
async function warnIfPortHijacked() {
  if (process.platform !== 'darwin') return;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    const server = res.headers.get('server') || '';
    if (server.includes('AirTunes')) {
      console.warn(
        `\n[startup] WARNING: macOS AirPlay Receiver is answering on port ${PORT}, not this app.\n` +
          '           Fix: System Settings > General > AirDrop & Handoff > turn off AirPlay Receiver,\n' +
          `           or set a different PORT in .env (e.g. PORT=5001).\n`
      );
    }
  } catch {
    /* the check is best-effort only */
  }
}

/**
 * Boot sequence: connect to Atlas, then make sure both kinds of index exist
 * before accepting traffic.
 *
 * The vector index is the one that needs waiting on: Atlas builds search
 * indexes asynchronously, and querying one that is not yet `queryable`
 * fails. Blocking here means the first upload cannot hit that race.
 */
async function prepareDatabase() {
  await db.connect();
  console.log(`[startup] MongoDB Atlas OK (database "${db.DB_NAME}")`);

  await db.ensureCollectionIndexes();
  console.log('[startup] collection indexes ready');

  const seeded = await agentService.ensureAgents();
  console.log(`[startup] agent catalog ready (${seeded} agents)`);

  await subscriptionService.ensureBillingDefaults();
  console.log('[startup] subscription plans and billing settings ready');

  const index = await db.ensureVectorIndex();
  console.log(`[startup] vector index ready: ${index.name} (${index.status})`);
}

/**
 * A connection timeout is almost never a bug in this app, so say what to go
 * and check instead of printing a bare stack trace.
 */
function explainDatabaseFailure(err) {
  const message = err.message || err.name;
  console.error(`\n[startup] Cannot reach MongoDB: ${message}`);

  if (/timed out|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(message)) {
    console.error(
      '\n  DNS resolves but nothing answers on port 27017. In order of likelihood:\n' +
        '    1. Your IP is not in Atlas > Network Access. "Add current IP address" pins\n' +
        '       ONE address, so a new Wi-Fi network, a VPN toggle or an ISP reassignment\n' +
        '       silently breaks it. Re-add it, and check the entry has not expired.\n' +
        '    2. The cluster is paused. A free M0 auto-pauses after inactivity and behaves\n' +
        '       exactly like this - the Atlas dashboard shows a Resume button.\n' +
        '    3. Port 27017 is blocked on this network (common on office/college Wi-Fi and\n' +
        '       some VPNs). Test with:  nc -vz <shard-host> 27017\n' +
        '       Tethering to your phone for 30 seconds tells you straight away.\n'
    );
  }
}

/**
 * Keep trying to reach Atlas instead of exiting on the first failure.
 *
 * Exiting made nodemon print "app crashed" and then sit there until a file
 * changed, so a brief network blip meant restarting the dev server by hand.
 * Retrying in the background means the server picks the database up by itself
 * the moment it is reachable - including the moment you fix the allowlist.
 */
async function connectWithRetry({ delayMs = 10000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await prepareDatabase();
      if (attempt > 1) console.log('[startup] database recovered, all routes are live');
      return true;
    } catch (err) {
      if (attempt === 1) {
        explainDatabaseFailure(err);
      } else {
        console.warn(`[startup] database still unreachable (attempt ${attempt}), retrying...`);
      }
      // Until this succeeds every route that touches the database answers 503
      // via the error handler, and /api/health reports mongodb as unreachable.
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function start() {
  // Not awaited: the server comes up either way, so nodemon stays alive and
  // /api/health can tell you exactly which dependency is missing.
  connectWithRetry();

  const health = await ollama.checkHealth();
  if (!health.reachable) {
    console.warn(`[startup] WARNING: Ollama unreachable (${health.error}). Uploads and chat will fail.`);
  } else {
    if (!health.llmAvailable) console.warn(`[startup] WARNING: model ${ollama.LLM_MODEL()} not found in Ollama`);
    if (!health.embeddingAvailable) console.warn(`[startup] WARNING: model ${ollama.EMBED_MODEL()} not found in Ollama`);
    console.log('[startup] Ollama OK');
  }

  const server = app.listen(PORT, () => {
    console.log(`[startup] RAG backend listening on http://localhost:${PORT}`);
    warnIfPortHijacked();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[startup] Port ${PORT} is already in use. Change PORT in .env.`);
      process.exit(1);
    }
    throw err;
  });

  const shutdown = async (signal) => {
    console.log(`\n[shutdown] ${signal} received, closing...`);
    server.close(async () => {
      await db.close().catch(() => {});
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Only start a server when run directly, so tests can import `app`.
if (require.main === module) start();

module.exports = app;
