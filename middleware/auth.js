/**
 * server/middleware/auth.js
 * Supabase JWT verification middleware for Fastify.
 *
 * Usage (in any route file):
 *   fastify.addHook('preHandler', requireAuth);
 *
 * The middleware reads the Authorization: Bearer <token> header,
 * verifies it with Supabase, and attaches req.user to the request.
 */

const { PAID_PLANS } = require('../lib/plans');

// Supabase client is loaded lazily — only when env vars are present.
// This prevents a startup crash when @supabase/supabase-js is not installed locally.
let supabase = null;

function getSupabase() {
  if (supabase) return supabase;
  const url  = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY; // service-role, NOT anon key
  if (!url || !key) {
    console.warn('[auth] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — auth disabled');
    return null;
  }
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(url, key, {
    auth: { persistSession: false },
  });
  return supabase;
}

// ── Token dogrulama onbellegi ────────────────────────────────────────────────
//
// Neden: requireAuth her /cues ve her /stream cagrisinda sb.auth.getUser(token)
// yapiyordu, yani Supabase'e (eu-west-1) bir ag gidis donusu. Bu iki uc canli
// mulakatta cevap yolunun uzerinde ve overlay ikisini AYNI ANDA cagiriyor.
// Urunun tamami "ipucu bir saniyenin altinda ekranda" hedefi uzerine kurulu;
// sadece token dogrulamak icin iki tur atmak o butcenin icinden yeniyor.
//
// Neden yerel JWT dogrulamasi DEGIL: request.user.app_metadata sadece kimlik
// tasimiyor. admin.js ve errors.js rol kapisini, billing.js stripe_customer_id
// ve plani, usage.js ucretsiz/ucretli ayrimini oradan okuyor. Token'dan
// okusaydik yetkisi alinmis bir admin token omru boyunca (~1 saat) admin
// kalirdi ve daha kotusu YENI ODEME YAPAN kullanici token yenilenene kadar
// "free" gorurdu. Onbellek ayni kazancin cogunu veriyor ama bayatligi
// 60 saniyeyle siniriyor.
//
// Ham token asla saklanmiyor: anahtar token'in sha256 ozeti.
const TOKEN_TTL_MS  = 60 * 1000;
const TOKEN_MAX     = 5000;          // bellek ust siniri
const _tokenCache   = new Map();     // hash -> { user, expiresAt }

function tokenKey(token) {
  return require('crypto').createHash('sha256').update(token).digest('hex');
}

/** Onbellekten kullanici. Yoksa ya da suresi dolduysa null. */
function cachedUser(token) {
  const key = tokenKey(token);
  const hit = _tokenCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { _tokenCache.delete(key); return null; }
  return hit.user;
}

/** Yalnizca BASARILI dogrulama onbellege girer. Basarisizlar hic girmez. */
function cacheUser(token, user) {
  if (!user) return;
  // Sinir asilirsa en eski girdiyi at. Map ekleme sirasini koruyor.
  if (_tokenCache.size >= TOKEN_MAX) {
    const oldest = _tokenCache.keys().next().value;
    if (oldest !== undefined) _tokenCache.delete(oldest);
  }
  _tokenCache.set(tokenKey(token), { user, expiresAt: Date.now() + TOKEN_TTL_MS });
}

/**
 * Kullanicinin oturumunu hemen gecersiz kilmak icin (cikis, plan degisikligi,
 * rol iptali). Su an cagiran yok; plan degisikliginde cagrilmasi mantikli
 * olurdu, o yuzden disari veriliyor.
 */
function invalidateToken(token) {
  if (token) _tokenCache.delete(tokenKey(token));
}

// Suresi dolmus girdiler birikmesin.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _tokenCache) if (now > v.expiresAt) _tokenCache.delete(k);
}, 5 * 60 * 1000).unref();

/**
 * requireAuth — preHandler hook.
 * Rejects unauthenticated requests with 401.
 * On success, attaches `request.user` (Supabase User object).
 */
async function requireAuth(request, reply) {
  const sb = getSupabase();

  // If Supabase is not configured (dev mode), skip auth.
  if (!sb) {
    request.user = { id: 'dev-user', email: 'dev@localhost', tier: 'PRO' };
    return;
  }

  const authHeader = request.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);

  const cached = cachedUser(token);
  if (cached) {
    request.user = cached;
    return;
  }

  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }

  cacheUser(token, data.user);

  // Attach user to request for downstream handlers.
  request.user = data.user;
}

/**
 * optionalAuth — preHandler hook.
 * Same as requireAuth but does NOT reject if no token is present.
 * Useful for endpoints that work for both guests and authenticated users.
 */
async function optionalAuth(request, reply) {
  const sb = getSupabase();
  if (!sb) {
    request.user = null;
    return;
  }

  const authHeader = request.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    request.user = null;
    return;
  }

  const token  = authHeader.slice(7);
  const cached = cachedUser(token);
  if (cached) { request.user = cached; return; }

  const { data } = await sb.auth.getUser(token);
  if (data?.user) cacheUser(token, data.user);
  request.user = data?.user ?? null;
}

/**
 * requirePlan — preHandler factory for paid-tier endpoints.
 *
 * Must run AFTER requireAuth (it reads request.user).
 * Replies 402 Payment Required (not 403) so the client can tell
 * "you need to upgrade" apart from "you are not allowed here".
 *
 * In local dev, when Supabase is not configured, requireAuth injects a
 * synthetic dev user — that case is allowed through so the app stays usable.
 *
 * @param {string[]} allowed  plans that may access the route
 */
function requirePlan(allowed = PAID_PLANS) {
  return async function planGate(request, reply) {
    const user = request.user;
    if (!user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    // Dev mode (no Supabase env) — requireAuth already let this through.
    if (user.id === 'dev-user') return;

    const plan = user.app_metadata?.plan ?? 'free';
    if (!allowed.includes(plan)) {
      return reply.status(402).send({
        error:    'plan_required',
        message:  'This feature is available on the Pro plan.',
        plan,
        required: allowed,
      });
    }
  };
}

module.exports = {
  requireAuth, optionalAuth, requirePlan,
  // Test ve gelecekteki gecersiz kilma icin
  invalidateToken, cachedUser, cacheUser, TOKEN_TTL_MS, TOKEN_MAX, _tokenCache,
};
