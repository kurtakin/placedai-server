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
const errorRoutes       = require('./routes/errors');
const { logError }      = require('./lib/errors');

// ── Question bank self-check (used by /health) ────────────────────────────────
const _fs = require('fs');
const _path = require('path');
let _bankInfo = null;

function bankInfo() {
  if (_bankInfo) return _bankInfo;

  const candidates = [
    _path.join(__dirname, 'questions'),
    _path.join(__dirname, '..'),
  ];

  for (const dir of candidates) {
    const idx = _path.join(dir, 'question_bank_index.json');
    if (!_fs.existsSync(idx)) continue;
    try {
      const index = JSON.parse(_fs.readFileSync(idx, 'utf8'));
      let count = 0;
      for (const entry of index.files) {
        try {
          count += JSON.parse(_fs.readFileSync(_path.join(dir, entry.file), 'utf8')).questions.length;
        } catch (_) { /* skip unreadable file */ }
      }
      _bankInfo = { dir, count };
      return _bankInfo;
    } catch (_) { /* try next candidate */ }
  }

  _bankInfo = { dir: null, count: 0 };
  return _bankInfo;
}

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
  await app.register(errorRoutes,      { prefix: '/api/v1/errors' });

  // ── Merkezi hata yakalayıcı ───────────────────────────────────────────────
  // 5xx hataları ia_errors'a yazılır; kullanıcıya iç detay sızmaz.
  // 4xx (doğrulama, yetki) kullanıcı hatasıdır — kaydedilmez, olduğu gibi döner.
  app.setErrorHandler(async (err, request, reply) => {
    const status = err.statusCode || 500;

    if (status >= 500) {
      await logError({
        source:     'server',
        level:      'error',
        message:    err.message,
        stack:      err.stack,
        route:      request.routerPath || request.url,
        method:     request.method,
        status,
        user_id:    request.user?.id,
        user_email: request.user?.email,
        user_agent: request.headers['user-agent'],
      });
      return reply.status(status).send({ error: 'Server error. The problem has been logged and will be looked at.' });
    }

    return reply.status(status).send({ error: err.message });
  });


  // ── Health check ──────────────────────────────────────────────────────────
  // `questions` reports how many entries the question bank resolved to, so a
  // broken/missing bank on the deployed instance is visible without a login.
  app.get('/health', async () => ({
    status:    'ok',
    ts:        Date.now(),
    bank_dir:  bankInfo().dir,
    questions: bankInfo().count,
  }));

  return app;
}

// ── Yakalanmamış hatalar ─────────────────────────────────────────────────────
// Süreci öldürmeden önce hatayı kaydetmeye çalış; Railway yeniden başlatır.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logError({ source: 'server', level: 'fatal', message: `unhandledRejection: ${err.message}`, stack: err.stack })
    .catch(() => {});
});

process.on('uncaughtException', (err) => {
  logError({ source: 'server', level: 'fatal', message: `uncaughtException: ${err.message}`, stack: err.stack })
    .catch(() => {})
    .finally(() => setTimeout(() => process.exit(1), 1500));
});

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
