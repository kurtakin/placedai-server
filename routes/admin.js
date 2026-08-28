/**
 * server/routes/admin.js
 * Admin-only user & plan management.
 *
 * Every route requires:
 *   1. a valid Supabase JWT  (requireAuth)
 *   2. app_metadata.role === 'admin'  (requireAdmin)
 *
 * The service-role key never leaves the server — the browser only ever
 * sends its own user JWT and receives already-filtered data.
 *
 * Routes (mounted at /api/v1/admin):
 *   GET  /users      → list users with plan + role
 *   POST /set-plan   → { user_id, plan }  plan ∈ free | pro | multi
 *   POST /set-role   → { user_id, role }  role ∈ admin | user
 */

'use strict';

const { requireAuth } = require('../middleware/auth');

// ── Lazy Supabase admin client ───────────────────────────────────────────────
let _sb = null;
function getSupabase() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY; // service-role, NOT anon
  if (!url || !key) return null;
  const { createClient } = require('@supabase/supabase-js');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

const { ALL_PLANS } = require('../lib/plans');
const VALID_PLANS = ALL_PLANS;
const VALID_ROLES = ['admin', 'user'];

/**
 * preHandler: authenticated AND admin.
 * requireAuth replies 401 itself when the token is missing/invalid;
 * we bail out in that case instead of sending a second reply.
 */
async function requireAdmin(request, reply) {
  await requireAuth(request, reply);
  if (reply.sent) return;

  const role = request.user?.app_metadata?.role;
  if (role !== 'admin') {
    return reply.status(403).send({ error: 'Admin access required' });
  }
}

/** Shape a Supabase user object into the minimal payload the UI needs. */
function toRow(u) {
  return {
    id:            u.id,
    email:         u.email,
    plan:          u.app_metadata?.plan ?? 'free',
    role:          u.app_metadata?.role ?? 'user',
    created_at:    u.created_at,
    last_sign_in:  u.last_sign_in_at,
  };
}

async function adminRoutes(fastify) {
  /**
   * GET /api/v1/admin/users?page=1&per_page=100
   * Returns { users: [...], page, per_page }
   */
  fastify.get('/users', { preHandler: requireAdmin }, async (request, reply) => {
    const sb = getSupabase();
    if (!sb) {
      return reply.status(503).send({ error: 'Supabase is not configured on this server' });
    }

    const page     = Math.max(1, parseInt(request.query.page, 10) || 1);
    const perPage  = Math.min(200, Math.max(1, parseInt(request.query.per_page, 10) || 100));

    const { data, error } = await sb.auth.admin.listUsers({ page, perPage });
    if (error) {
      request.log?.error?.(error);
      return reply.status(500).send({ error: error.message });
    }

    const users = (data?.users ?? [])
      .map(toRow)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    return { users, page, per_page: perPage };
  });

  /**
   * POST /api/v1/admin/set-plan
   * Body: { user_id: string, plan: 'free'|'pro'|'ultimate' }
   */
  fastify.post('/set-plan', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['user_id', 'plan'],
        properties: {
          user_id: { type: 'string', minLength: 10 },
          plan:    { type: 'string', enum: VALID_PLANS },
        },
      },
    },
  }, async (request, reply) => {
    const sb = getSupabase();
    if (!sb) {
      return reply.status(503).send({ error: 'Supabase is not configured on this server' });
    }

    const { user_id, plan } = request.body;

    // Read current metadata so we merge instead of overwriting other keys.
    const { data: existing, error: readErr } = await sb.auth.admin.getUserById(user_id);
    if (readErr || !existing?.user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const app_metadata = { ...(existing.user.app_metadata || {}), plan };

    const { data, error } = await sb.auth.admin.updateUserById(user_id, { app_metadata });
    if (error) {
      request.log?.error?.(error);
      return reply.status(500).send({ error: error.message });
    }

    return { ok: true, user: toRow(data.user) };
  });

  /**
   * POST /api/v1/admin/set-role
   * Body: { user_id: string, role: 'admin'|'user' }
   * You cannot change your own role — prevents locking yourself out.
   */
  fastify.post('/set-role', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['user_id', 'role'],
        properties: {
          user_id: { type: 'string', minLength: 10 },
          role:    { type: 'string', enum: VALID_ROLES },
        },
      },
    },
  }, async (request, reply) => {
    const sb = getSupabase();
    if (!sb) {
      return reply.status(503).send({ error: 'Supabase is not configured on this server' });
    }

    const { user_id, role } = request.body;

    if (user_id === request.user.id) {
      return reply.status(400).send({ error: 'You cannot change your own role' });
    }

    const { data: existing, error: readErr } = await sb.auth.admin.getUserById(user_id);
    if (readErr || !existing?.user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const app_metadata = { ...(existing.user.app_metadata || {}), role };

    const { data, error } = await sb.auth.admin.updateUserById(user_id, { app_metadata });
    if (error) {
      request.log?.error?.(error);
      return reply.status(500).send({ error: error.message });
    }

    return { ok: true, user: toRow(data.user) };
  });
}

module.exports = adminRoutes;
