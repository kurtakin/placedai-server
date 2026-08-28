'use strict';

/**
 * server/lib/usage.js — Free plan usage tracking.
 *
 * Free plan: 10 AI answers per period.
 * Paid plans: unlimited (no DB check performed).
 *
 * The period is anchored to the user's own date — their billing period start
 * when they have one, otherwise the day they signed up. Calendar months used
 * to hand anyone who joined late in the month two windows in a few days.
 *
 * Supabase table required — run this once in the SQL editor:
 *
 *   CREATE TABLE IF NOT EXISTS ia_usage (
 *     user_id uuid  REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
 *     month   text  NOT NULL,               -- period key: 'YYYY-MM-DD' (UTC)
 *     answers int   NOT NULL DEFAULT 0,
 *     PRIMARY KEY (user_id, month)
 *   );
 *   ALTER TABLE ia_usage ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "own usage" ON ia_usage USING (auth.uid() = user_id);
 */

const { periodKey }      = require('./period');
const { liveSecondsFor } = require('./plans');

const FREE_LIMIT = 10;

/** Tek nabiz atisinin ekleyebilecegi en fazla sure (saniye). Istemci 60'ta bir
 *  bildiriyor; 180 sekme donmasina pay birakir, kotuye kullanima birakmaz. */
const MAX_HEARTBEAT_SECONDS = 180;

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

/** 'free' | 'pro' | 'multi' — default 'free' */
function getUserPlan(user) {
  return user?.app_metadata?.plan ?? 'free';
}

/**
 * Kullanicinin donemi neye demirlenecek?
 *
 * Odeme yapan kullanicida fatura donemi baslangici (webhook yaziyor), aksi
 * halde kayit tarihi. Ikisi de yoksa periodKey takvim ayina geri duser.
 */
function anchorFor(user) {
  return user?.app_metadata?.billing_anchor || user?.created_at || null;
}

/** Kullanicinin icinde bulundugu donemin anahtari. */
function currentPeriod(user) {
  return periodKey(anchorFor(user));
}

/**
 * Check limit and increment if allowed.
 *
 * @param {object} user  — request.user from requireAuth
 * @returns {{ allowed: boolean, used: number|null, limit: number|null, plan: string }}
 */
async function checkAndIncrement(user) {
  const plan = getUserPlan(user);

  // Paid plans: no limit
  if (plan !== 'free') {
    return { allowed: true, used: null, limit: null, plan };
  }

  const sb = getSupabase();
  if (!sb) {
    // Dev mode (no Supabase env): allow everything
    return { allowed: true, used: null, limit: null, plan };
  }

  const userId = user.id;
  const month  = currentPeriod(user);

  // Read current count
  const { data: row } = await sb
    .from('ia_usage')
    .select('answers')
    .eq('user_id', userId)
    .eq('month', month)
    .maybeSingle();

  const used = row?.answers ?? 0;

  if (used >= FREE_LIMIT) {
    return { allowed: false, used, limit: FREE_LIMIT, plan };
  }

  // Increment (upsert is safe for concurrent requests)
  await sb.from('ia_usage').upsert(
    { user_id: userId, month, answers: used + 1 },
    { onConflict: 'user_id,month' }
  );

  return { allowed: true, used: used + 1, limit: FREE_LIMIT, plan };
}

/**
 * Read-only usage snapshot (for the /usage endpoint).
 *
 * @returns {{ plan: string, used: number|null, limit: number|null }}
 */
async function getUsage(user) {
  const plan = getUserPlan(user);
  if (plan !== 'free') return { plan, used: null, limit: null };

  const sb = getSupabase();
  if (!sb) return { plan, used: 0, limit: FREE_LIMIT };

  const { data: row } = await sb
    .from('ia_usage')
    .select('answers')
    .eq('user_id', user.id)
    .eq('month', currentPeriod(user))
    .maybeSingle();

  return { plan, used: row?.answers ?? 0, limit: FREE_LIMIT };
}

/**
 * Canli dinleme suresi — okuma.
 *
 * @returns {{ plan, used_seconds, limit_seconds, remaining_seconds, exhausted }}
 */
async function getLiveUsage(user) {
  const plan  = getUserPlan(user);
  const limit = liveSecondsFor(plan);

  const sb = getSupabase();
  if (!sb) return { plan, used_seconds: 0, limit_seconds: limit, remaining_seconds: limit, exhausted: false };

  const { data: row } = await sb
    .from('ia_usage')
    .select('live_seconds')
    .eq('user_id', user.id)
    .eq('month', currentPeriod(user))
    .maybeSingle();

  const used = row?.live_seconds ?? 0;
  return {
    plan,
    used_seconds:      used,
    limit_seconds:     limit,
    remaining_seconds: Math.max(0, limit - used),
    exhausted:         used >= limit,
  };
}

/**
 * Canli dinleme suresi — ekleme.
 *
 * Istemci her dakika gecen sureyi bildiriyor. Tek bir atisin ekleyebilecegi
 * sure sinirli: bozuk ya da kotu niyetli bir istemci tek istekle aylik hakki
 * tuketemesin, ya da eksiye dusuremesin.
 */
async function addLiveSeconds(user, seconds) {
  const delta = Math.max(0, Math.min(Math.round(Number(seconds) || 0), MAX_HEARTBEAT_SECONDS));
  const plan  = getUserPlan(user);
  const limit = liveSecondsFor(plan);

  const sb = getSupabase();
  if (!sb || !delta) {
    const snap = await getLiveUsage(user);
    return snap;
  }

  const period = currentPeriod(user);
  const { data: row } = await sb
    .from('ia_usage')
    .select('answers, live_seconds')
    .eq('user_id', user.id)
    .eq('month', period)
    .maybeSingle();

  const used = (row?.live_seconds ?? 0) + delta;

  await sb.from('ia_usage').upsert(
    { user_id: user.id, month: period, answers: row?.answers ?? 0, live_seconds: used },
    { onConflict: 'user_id,month' }
  );

  return {
    plan,
    used_seconds:      used,
    limit_seconds:     limit,
    remaining_seconds: Math.max(0, limit - used),
    exhausted:         used >= limit,
  };
}

module.exports = {
  checkAndIncrement, getUsage, getUserPlan, currentPeriod, anchorFor, FREE_LIMIT,
  getLiveUsage, addLiveSeconds, MAX_HEARTBEAT_SECONDS,
};
