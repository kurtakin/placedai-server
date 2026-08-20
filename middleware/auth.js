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

  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }

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

  const token = authHeader.slice(7);
  const { data } = await sb.auth.getUser(token);
  request.user = data?.user ?? null;
}

module.exports = { requireAuth, optionalAuth };
