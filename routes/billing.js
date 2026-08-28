/**
 * server/routes/billing.js — Stripe abonelikleri (mount: /api/v1/billing)
 *
 *   POST /checkout   → auth: Stripe Checkout oturumu açar, URL döner
 *   POST /portal     → auth: Stripe müşteri portalı (iptal, kart güncelleme)
 *   GET  /status     → auth: kullanıcının güncel planı
 *   POST /webhook    → Stripe çağırır. İmza doğrulanır, plan Supabase'e yazılır.
 *
 * Doğruluk kaynağı Supabase'deki `app_metadata.plan`. Overlay, profil sınırı ve
 * sunucu ölçümlemesi hep oradan okuyor — Stripe ikinci bir kaynak yaratmıyor,
 * yalnızca o alanı güncelliyor.
 *
 * Gerekli env:
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 *   STRIPE_PRICE_PRO_MONTHLY, STRIPE_PRICE_PRO_YEARLY
 *   STRIPE_PRICE_ULTIMATE_MONTHLY, STRIPE_PRICE_ULTIMATE_YEARLY
 *   APP_URL (varsayılan https://www.placedai.app)
 */

'use strict';

const { requireAuth } = require('../middleware/auth');
const { logError }    = require('../lib/errors');

const APP_URL = process.env.APP_URL || 'https://www.placedai.app';

let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const Stripe = require('stripe');
  _stripe = new Stripe(key);
  return _stripe;
}

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

// ── Fiyat eşlemesi ──────────────────────────────────────────────────────────
// Fiyatlar kodda değil ortamda. Stripe panelinde fiyat değişirse kod değişmez.
function priceFor(plan, period) {
  const map = {
    'pro:monthly':      process.env.STRIPE_PRICE_PRO_MONTHLY,
    'pro:yearly':       process.env.STRIPE_PRICE_PRO_YEARLY,
    'ultimate:monthly': process.env.STRIPE_PRICE_ULTIMATE_MONTHLY,
    'ultimate:yearly':  process.env.STRIPE_PRICE_ULTIMATE_YEARLY,
  };
  return map[`${plan}:${period}`] || null;
}

/** Webhook'ta ters yön: hangi fiyat hangi plana denk geliyor. */
function planForPrice(priceId) {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_ULTIMATE_MONTHLY ||
      priceId === process.env.STRIPE_PRICE_ULTIMATE_YEARLY) return 'ultimate';
  if (priceId === process.env.STRIPE_PRICE_PRO_MONTHLY ||
      priceId === process.env.STRIPE_PRICE_PRO_YEARLY)     return 'pro';
  return null;
}

/** Aboneliğin ücretli sayıldığı durumlar. */
function isActive(status) {
  return status === 'active' || status === 'trialing' || status === 'past_due';
}

/**
 * Aboneligin icinde bulundugu fatura doneminin baslangici, ISO damgasi olarak.
 *
 * Kota penceresi buna demirleniyor: takvim ayi kullanmak, ayin sonunda abone
 * olan kullaniciya birkac gunde iki pencerelik hak verirdi.
 *
 * Stripe bu alani 2025-03-31 surumunde abonelikten kalemlere tasidi; ikisine
 * de bakiyoruz ki API surumu degisince sessizce bozulmasin.
 */
function periodStartOf(sub) {
  const secs = sub?.items?.data?.[0]?.current_period_start ?? sub?.current_period_start;
  return Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : null;
}

/** Donemin bitisi — yenilenme ya da iptal tarihi. periodStartOf ile ayni tuzak. */
function periodEndOf(sub) {
  const secs = sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end;
  return Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : null;
}

/** Abonelikten okunan, arayuzun gostermesi gereken her sey. */
function billingFacts(sub) {
  return {
    subscription_status:  sub?.status || null,
    subscription_ends_at: periodEndOf(sub),
    subscription_cancels: !!sub?.cancel_at_period_end,
  };
}

/**
 * Kullanıcının planını yaz. app_metadata'nın diğer alanlarını (role gibi)
 * korumak için önce okuyup birleştiriyoruz — üzerine yazmak admin rolünü siler.
 */
async function setUserPlan(userId, plan, extra = {}) {
  const sb = getSupabase();
  if (!sb || !userId) return { ok: false, reason: 'no_supabase_or_user' };

  const { data: current, error: readErr } = await sb.auth.admin.getUserById(userId);
  if (readErr) return { ok: false, error: readErr.message };

  const existing = current?.user?.app_metadata || {};
  const merged   = { ...existing, ...extra, plan };

  const { error } = await sb.auth.admin.updateUserById(userId, { app_metadata: merged });
  if (error) return { ok: false, error: error.message };

  console.log(`[billing] plan set: ${userId} → ${plan}`);
  return { ok: true };
}

/** Stripe müşteri kimliğinden kullanıcıyı bul (metadata yoksa son çare). */
async function userIdFromCustomer(customerId) {
  const stripe = getStripe();
  if (!stripe || !customerId) return null;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return customer?.metadata?.user_id || null;
  } catch {
    return null;
  }
}

async function billingRoutes(fastify) {
  // ── Ham gövde ─────────────────────────────────────────────────────────────
  // Stripe imza doğrulaması ham baytları istiyor; Fastify ise JSON'ı otomatik
  // ayrıştırır. Ayrıştırılmış gövdeyi tekrar stringify etmek boşluk/sıra
  // farkları yüzünden imzayı bozar ve ödeme alınıp plan güncellenmez — sessiz
  // ve pahalı bir hata. Bu yüzden bu eklenti kapsamında gövde Buffer kalıyor;
  // JSON isteyen uçlar aşağıda kendisi ayrıştırıyor.
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  const jsonBody = (request) => {
    try { return JSON.parse((request.body || Buffer.alloc(0)).toString('utf8') || '{}'); }
    catch { return {}; }
  };

  // ── POST /checkout ────────────────────────────────────────────────────────
  fastify.post('/checkout', { preHandler: requireAuth }, async (request, reply) => {
    const stripe = getStripe();
    if (!stripe) return reply.code(503).send({ error: 'Billing is not configured on this server' });

    const { plan, period } = jsonBody(request);
    const wanted = String(plan || '').toLowerCase();
    const cycle  = String(period || 'monthly').toLowerCase();

    if (!['pro', 'ultimate'].includes(wanted))     return reply.code(400).send({ error: 'plan must be pro or ultimate' });
    if (!['monthly', 'yearly'].includes(cycle))    return reply.code(400).send({ error: 'period must be monthly or yearly' });

    const price = priceFor(wanted, cycle);
    if (!price) return reply.code(503).send({ error: `No Stripe price configured for ${wanted} ${cycle}` });

    const user = request.user;

    try {
      // Müşteriyi tekrar tekrar yaratmayalım: varsa app_metadata'daki kimliği kullan.
      let customerId = user.app_metadata?.stripe_customer_id || null;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email:    user.email,
          metadata: { user_id: user.id },
        });
        customerId = customer.id;
        await setUserPlan(user.id, user.app_metadata?.plan || 'free', { stripe_customer_id: customerId });
      }

      // Managed Payments: Stripe merchant of record olur ve 80+ ülkede satış
      // vergisi / VAT / GST yükümlülüğünü üstlenir; karşılığında işlem başına
      // %3.5 ek ücret alır. Panelde açılmadan bu parametreyi göndermek Checkout
      // çağrısını hataya düşürür, o yüzden değişkene bağlı.
      const managed = String(process.env.STRIPE_MANAGED_PAYMENTS || '') === '1';

      const session = await stripe.checkout.sessions.create({
        mode:                'subscription',
        customer:            customerId,
        line_items:          [{ price, quantity: 1 }],
        client_reference_id: user.id,
        ...(managed ? { managed_payments: { enabled: true } } : {}),
        // Abonelik olaylarında kullanıcıyı bulabilmek için: müşteri kaydı
        // silinse bile abonelik metadata'sı olayla birlikte geliyor.
        subscription_data:   { metadata: { user_id: user.id, plan: wanted } },
        allow_promotion_codes: true,
        // Plan adini geri tasiyoruz: donus sayfasi oturumu tazelerken neyi
        // bekledigini bilmeli. "Plan degisti mi" kiyaslamasi, ayni plani
        // yeniden satin alan kullanicida yanlis sonuc verirdi.
        success_url: `${APP_URL}/dashboard?checkout=success&plan=${wanted}`,
        cancel_url:  `${APP_URL}/#pricing`,
      });

      return { url: session.url };
    } catch (err) {
      fastify.log.error(err, '[billing] checkout');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── POST /portal ──────────────────────────────────────────────────────────
  fastify.post('/portal', { preHandler: requireAuth }, async (request, reply) => {
    const stripe = getStripe();
    if (!stripe) return reply.code(503).send({ error: 'Billing is not configured on this server' });

    const customerId = request.user.app_metadata?.stripe_customer_id;
    if (!customerId) {
      return reply.code(400).send({ error: 'You do not have a subscription yet.' });
    }

    try {
      const session = await stripe.billingPortal.sessions.create({
        customer:   customerId,
        return_url: `${APP_URL}/dashboard`,
      });
      return { url: session.url };
    } catch (err) {
      fastify.log.error(err, '[billing] portal');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── GET /status ───────────────────────────────────────────────────────────
  fastify.get('/status', { preHandler: requireAuth }, async (request) => {
    const meta = request.user.app_metadata || {};
    return {
      plan:                  meta.plan || 'free',
      subscription_status:   meta.subscription_status  || null,
      subscription_ends_at:  meta.subscription_ends_at || null,
      cancels_at_period_end: !!meta.subscription_cancels,
      // Musteri kaydi duruyorsa portal acilabilir — iptal etmis biri de fatura
      // gecmisini gorebilmeli. Bu alan aboneligi degil, o kaydi olcuyor; adi da
      // artik bunu soyluyor.
      has_billing_account:   !!meta.stripe_customer_id,
      billing_ready:         !!process.env.STRIPE_SECRET_KEY,
      merchant_of_record:    String(process.env.STRIPE_MANAGED_PAYMENTS || '') === '1' ? 'stripe' : 'placedai',
    };
  });

  // ── POST /webhook ─────────────────────────────────────────────────────────
  // Kimlik doğrulaması YOK — çağıran Stripe. Güvenlik imzadan geliyor.
  fastify.post('/webhook', async (request, reply) => {
    const stripe = getStripe();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !secret) return reply.code(503).send({ error: 'Billing is not configured' });

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body,                                  // Buffer — ayrıştırılmamış
        request.headers['stripe-signature'],
        secret
      );
    } catch (err) {
      // İmza tutmuyorsa bu istek Stripe'dan gelmiyor olabilir. 400 döndür ki
      // Stripe tekrar denesin ve panelde hata olarak görünsün.
      fastify.log.warn({ msg: err.message }, '[billing] webhook signature rejected');
      return reply.code(400).send({ error: `Webhook signature verification failed: ${err.message}` });
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const s      = event.data.object;
          const userId = s.client_reference_id || s.metadata?.user_id;
          if (!userId) { console.warn('[billing] checkout completed without a user reference'); break; }

          let plan   = 'pro';
          let anchor = null;
          let facts  = {};
          if (s.subscription) {
            const sub = await stripe.subscriptions.retrieve(s.subscription);
            plan   = planForPrice(sub.items?.data?.[0]?.price?.id) || sub.metadata?.plan || 'pro';
            anchor = periodStartOf(sub);
            facts  = billingFacts(sub);
          }
          await setUserPlan(userId, plan, { stripe_customer_id: s.customer, billing_anchor: anchor, ...facts });
          break;
        }

        case 'customer.subscription.updated':
        case 'customer.subscription.created': {
          const sub    = event.data.object;
          const userId = sub.metadata?.user_id || await userIdFromCustomer(sub.customer);
          if (!userId) { console.warn('[billing] subscription event without a user reference'); break; }

          const active = isActive(sub.status);
          const plan = active
            ? (planForPrice(sub.items?.data?.[0]?.price?.id) || sub.metadata?.plan || 'pro')
            : 'free';
          // Plan dustuyse demiri de birakiyoruz; kota yeniden kayit tarihine baglanir.
          await setUserPlan(userId, plan, {
            stripe_customer_id: sub.customer,
            billing_anchor:     active ? periodStartOf(sub) : null,
            ...billingFacts(sub),
          });
          break;
        }

        case 'customer.subscription.deleted': {
          const sub    = event.data.object;
          const userId = sub.metadata?.user_id || await userIdFromCustomer(sub.customer);
          if (!userId) { console.warn('[billing] cancellation without a user reference'); break; }
          await setUserPlan(userId, 'free', {
            stripe_customer_id:   sub.customer,
            billing_anchor:       null,
            subscription_status:  'canceled',
            subscription_ends_at: null,
            subscription_cancels: false,
          });
          break;
        }

        case 'invoice.payment_failed': {
          const inv = event.data.object;
          // Planı hemen düşürmüyoruz: Stripe birkaç gün yeniden deniyor ve
          // aboneliği kendisi iptal ediyor. O iptal zaten yukarıdaki olayı
          // tetikler. Burada sadece görünür kayıt bırakıyoruz.
          await logError({
            source:     'server',
            level:      'warn',
            message:    `Stripe payment failed for ${inv.customer_email || inv.customer}`,
            route:      '/api/v1/billing/webhook',
            method:     'POST',
            meta:       { invoice: inv.id, amount_due: inv.amount_due, attempt: inv.attempt_count },
          });
          break;
        }

        default:
          break;   // ilgilenmediğimiz olaylar sessizce onaylanır
      }

      return { received: true };
    } catch (err) {
      fastify.log.error(err, `[billing] handler failed for ${event.type}`);
      // 500 dönersek Stripe tekrar dener — geçici bir Supabase hatasında istediğimiz bu.
      return reply.code(500).send({ error: err.message });
    }
  });
}

module.exports = billingRoutes;
