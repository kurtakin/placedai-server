/**
 * server/routes/errors.js — Hata toplama uçları (mount: /api/v1/errors)
 *
 *   POST /        → tarayıcıdan gelen hata. Auth ZORUNLU DEĞİL:
 *                   giriş yapamayan kullanıcının hatası da bize lazım.
 *                   IP başına dakikada MAX_PER_MIN kayıt sınırı var.
 *   GET  /        → admin: son hatalar (varsayılan 100)
 *   POST /test    → admin: bilerek hata üretip zinciri doğrulamak için
 */

'use strict';

const { logError } = require('../lib/errors');
const { requireAuth } = require('../middleware/auth');

const MAX_PER_MIN = 10;
const WINDOW_MS   = 60 * 1000;

// ip → { count, resetAt }
const _hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const rec = _hits.get(ip);
  if (!rec || now > rec.resetAt) {
    _hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_PER_MIN;
}

// Map sonsuza kadar büyümesin
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of _hits) if (now > rec.resetAt) _hits.delete(ip);
}, 5 * 60 * 1000).unref();

let _sb = null;
function getSupabase() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const { createClient } = require('@supabase/supabase-js');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

async function requireAdmin(request, reply) {
  await requireAuth(request, reply);
  if (reply.sent) return;
  if (request.user?.app_metadata?.role !== 'admin') {
    return reply.status(403).send({ error: 'Admin access required' });
  }
}

async function errorRoutes(fastify) {
  // ── POST / — tarayıcı hatası ────────────────────────────────────────────
  fastify.post('/', async (request, reply) => {
    const ip = request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.ip;
    if (rateLimited(ip)) {
      return reply.status(429).send({ ok: false, error: 'too_many_reports' });
    }

    const b = request.body ?? {};
    if (!b.message) return reply.status(400).send({ ok: false, error: 'message required' });

    await logError({
      source:     'browser',
      level:      b.level === 'fatal' ? 'fatal' : 'error',
      message:    b.message,
      stack:      b.stack,
      route:      b.route,
      url:        b.url,
      user_id:    b.user_id,
      user_email: b.user_email,
      user_agent: request.headers['user-agent'],
      meta:       b.meta,
    });

    // Tarayıcıya her zaman 204 — istemci tarafında ikinci bir hata doğmasın
    return reply.status(204).send();
  });

  // ── GET / — admin: son hatalar ──────────────────────────────────────────
  fastify.get('/', { preHandler: requireAdmin }, async (request, reply) => {
    const sb = getSupabase();
    if (!sb) return reply.status(503).send({ error: 'Supabase is not configured on this server' });

    const limit  = Math.min(200, Math.max(1, parseInt(request.query.limit, 10) || 100));
    const source = ['server', 'browser'].includes(request.query.source) ? request.query.source : null;

    let q = sb.from('ia_errors')
      .select('id, created_at, last_seen, count, source, level, message, stack, route, method, status, user_email, url')
      .order('last_seen', { ascending: false })
      .limit(limit);
    if (source) q = q.eq('source', source);

    const { data, error } = await q;
    if (error) return reply.status(500).send({ error: error.message });
    return { errors: data ?? [] };
  });

  // ── POST /test — admin: zinciri doğrula ─────────────────────────────────
  fastify.post('/test', { preHandler: requireAdmin }, async (request) => {
    const result = await logError({
      source:     'server',
      level:      'error',
      message:    'Test error from /api/v1/errors/test',
      stack:      new Error('test').stack,
      route:      '/api/v1/errors/test',
      method:     'POST',
      user_id:    request.user?.id,
      user_email: request.user?.email,
    });
    return result;
  });
}

module.exports = errorRoutes;
