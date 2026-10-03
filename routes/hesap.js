/**
 * server/routes/hesap.js — Hesap islemleri (K95, 3 Ekim 2026).
 *
 *   POST /api/v1/hesap/sil   { onay: 'DELETE', yorum_kalsin?: boolean }
 *
 * Kullanici yalnizca KENDI hesabini siler (kimlik token'dan, govdeden degil).
 * Ayrintilar ve adim sirasi: lib/hesap-silme.js.
 */
'use strict';

const { requireAuth } = require('../middleware/auth');
const { hesabiSil, SilmeHatasi } = require('../lib/hesap-silme');
const { logError } = require('../lib/errors');

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

let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const Stripe = require('stripe');
  _stripe = new Stripe(key);
  return _stripe;
}

// Hangi adimda durduysa kullaniciya ne denecek. Hesap SILINMEDI.
const ADIM_KODU = {
  stripe:   'billing_cancel_failed',
  izin:     'consent_archive_failed',
  yorum:    'testimonial_detach_failed',
  hazirlik: 'not_configured',
  hesap:    'delete_failed',
};

async function hesapRoutes(fastify) {
  fastify.post('/sil', {
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object',
        required: ['onay'],
        additionalProperties: false,
        properties: {
          onay:         { type: 'string', const: 'DELETE' },
          yorum_kalsin: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const sb = getSupabase();
    if (!sb) return reply.code(503).send({ kod: ADIM_KODU.hazirlik, error: 'Account deletion is not available right now' });
    try {
      const s = await hesabiSil({ sb, stripe: getStripe(), kullanici: request.user, yorumKalsin: request.body.yorum_kalsin === true });
      // Kimlik ya da e-posta loga gitmez.
      request.log.info({ abonelik: s.abonelik, izinArsivi: s.izinArsivi, yorumKaldi: s.yorumKaldi, temizlikHatasi: s.temizlikHatasi }, '[hesap] silindi');
      return { ok: true, yorum_kaldi: s.yorumKaldi };
    } catch (e) {
      const adim = e instanceof SilmeHatasi ? e.adim : 'hesap';
      await logError({ source: 'server', level: 'error', message: `[hesap/sil] ${adim}: ${String(e.message).replace(/[^\s@]+@[^\s@]+/g, '[email]').slice(0, 200)}`, route: '/api/v1/hesap/sil', status: 502 });
      return reply.code(adim === 'hazirlik' ? 503 : 502).send({ kod: ADIM_KODU[adim] || ADIM_KODU.hesap, error: 'Your account was not deleted. Please try again or write to privacy@placedai.app.' });
    }
  });
}

module.exports = hesapRoutes;
