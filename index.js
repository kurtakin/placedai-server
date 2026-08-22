/**
 * server/index.js — Fastify API Server
 * Runs alongside the Electron app on port 3001.
 * Handles all AI calls so the renderer never touches the API key directly.
 */

'use strict';

// Load .env from project root (Electron mode) — in production env vars come from Railway/cloud
const _envPath = require('path').join(__dirname, '..', '.env');
require('dotenv').config({ path: _envPath, override: false }); // override:false so cloud env vars win
console.log('[server] PORT:', process.env.PORT || 3001);

const Fastify   = require('fastify');
const cors      = require('@fastify/cors');
// @fastify/multipart kaldırıldı — CV yükleme artık base64 JSON ile yapılıyor

const authRoutes        = require('./routes/auth');
const aidRoutes         = require('./routes/aid');
const questionsRoutes   = require('./routes/questions');
const transcribeRoutes  = require('./routes/transcribe');
const practiceRoutes    = require('./routes/practice');
const toolsRoutes       = require('./routes/tools');
const duoRoutes         = require('./routes/duo');
const feedbackRoutes    = require('./routes/feedback');
const adminRoutes       = require('./routes/admin');

const PORT = process.env.PORT || 3001;

async function build() {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'production',
    bodyLimit: 10 * 1024 * 1024, // 10MB — audio files can be large
  });

  // ── CORS: allow Electron renderer (file://) + web app ────────────────────
  const allowedOrigins = [
    'file://',
    /^http:\/\/localhost(:\d+)?$/,
    'https://placedai.app',
    'https://www.placedai.app',
    process.env.WEB_APP_ORIGIN, // optional override via env var
  ].filter(Boolean);

  await app.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // ── Routes ────────────────────────────────────────────────────────────────
  await app.register(authRoutes,        { prefix: '/api/v1/auth' });
  await app.register(aidRoutes,        { prefix: '/api/v1/aid' });
  await app.register(questionsRoutes,  { prefix: '/api/v1/questions' });
  await app.register(transcribeRoutes, { prefix: '/api/v1/transcribe' });
  await app.register(practiceRoutes,   { prefix: '/api/v1/practice' });
  await app.register(toolsRoutes,      { prefix: '/api/v1/tools' });
  await app.register(duoRoutes,        { prefix: '/api/v1/duo' });
  await app.register(feedbackRoutes,   { prefix: '/api/v1/feedback' });
  await app.register(adminRoutes,      { prefix: '/api/v1/admin' });

  // ── Health check ──────────────────────────────────────────────────────────
  app.get('/health', async () => ({ status: 'ok', ts: Date.now() }));

  return app;
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
build().then(async (app) => {
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`[server] Listening on http://127.0.0.1:${PORT}`);
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
});
