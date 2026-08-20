/**
 * server/routes/feedback.js
 * POST /api/v1/feedback — collect user feedback.
 *
 * Authentication: optional (guests and authenticated users both allowed).
 * The optionalAuth middleware attaches request.user when a valid JWT is present.
 *
 * Persistence: when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are configured,
 * feedback is written to the `feedback` table. Otherwise it is only logged.
 */

'use strict';

const { optionalAuth } = require('../middleware/auth');

// Lazy Supabase client — require only when env vars are present.
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

/** Allowed values for `category` */
const VALID_CATEGORIES = ['bug', 'feature', 'general'];

async function feedbackRoutes(fastify) {
  /**
   * POST /api/v1/feedback
   * Body: { rating: 1-5, category: 'bug'|'feature'|'general', content: string }
   */
  fastify.post('/', {
    preHandler: optionalAuth,
    schema: {
      body: {
        type: 'object',
        required: ['rating', 'category', 'content'],
        properties: {
          rating:   { type: 'integer', minimum: 1, maximum: 5 },
          category: { type: 'string', enum: VALID_CATEGORIES },
          content:  { type: 'string', minLength: 5, maxLength: 2000 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { rating, category, content } = request.body;
    const userId = request.user?.id ?? null;

    const sb = getSupabase();

    if (sb) {
      // Persist to Supabase
      const { error } = await sb
        .from('feedback')
        .insert({ user_id: userId, rating, category, content });

      if (error) {
        fastify.log.error('[feedback] Supabase insert error:', error.message);
        return reply.status(500).send({ error: 'Failed to save feedback' });
      }
    } else {
      // No Supabase — log only (dev mode)
      fastify.log.info('[feedback] (dev mode, not persisted)', { userId, rating, category, content });
    }

    return reply.status(201).send({ ok: true, message: 'Feedback received — thank you!' });
  });

  /**
   * GET /api/v1/feedback/health — simple health check for this route
   */
  fastify.get('/health', async () => ({ ok: true }));
}

module.exports = feedbackRoutes;
