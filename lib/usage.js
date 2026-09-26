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

/** Testler icin: sahte istemci ver (null verilirse gercege doner). */
function _setSupabase(sb) { _sb = sb; }

function getSupabase() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const { createClient } = require('@supabase/supabase-js');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

/**
 * OKUMA HATASI "0 KULLANILDI" DEGILDIR (26 Eylul 2026, K57'nin acik kalani).
 *
 * Eskiden Supabase'in `{ error }` donusune bakilmiyordu; okuma basarisiz
 * olunca satir `null`, kullanim 0 sayiliyordu. Olculen sonuc sadece fazladan
 * hak degildi, VERI BOZULMASIYDI:
 *   checkAndIncrement  -> answers: 1 yaziyordu (ornegin 8 olan sayac 1'e iner)
 *   addLiveSeconds     -> answers: 0 VE live_seconds: <bu atis> yaziyordu;
 *                         canli oturum sirasindaki tek bir anlik hata iki
 *                         sayaci da sifirliyordu
 * Simdi: okunamayan sayac YAZILMAZ ve sayi uydurulmaz (null). Kapinin
 * davranisi DEGISMEDI: okuma hatasinda istek eskisi gibi gecer (fail-open).
 * Hatada kapatmak (fail-closed) bir urun karari; kullaniciya birakildi.
 */
async function satirOku(sb, userId, month, alanlar) {
  const { data, error } = await sb
    .from('ia_usage')
    .select(alanlar)
    .eq('user_id', userId)
    .eq('month', month)
    .maybeSingle();
  if (error) {
    console.error('[usage] sayac okunamadi, yazilmayacak:', error.message || error);
    return { row: null, hata: true };
  }
  return { row: data, hata: false };
}

async function satirYaz(sb, kayit) {
  const { error } = await sb.from('ia_usage').upsert(kayit, { onConflict: 'user_id,month' });
  if (error) console.error('[usage] sayac yazilamadi:', error.message || error);
}

/** 'free' | 'pro' | 'ultimate' — default 'free' */
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
  const { row, hata } = await satirOku(sb, userId, month, 'answers');
  if (hata) return { allowed: true, used: null, limit: FREE_LIMIT, plan };

  const used = row?.answers ?? 0;

  if (used >= FREE_LIMIT) {
    return { allowed: false, used, limit: FREE_LIMIT, plan };
  }

  // Increment. Not: oku-sonra-yaz atomik degil; ayni anda iki istek bir
  // sayimi kaybedebilir (bilinen, ayri is: veritabaninda artiran fonksiyon).
  await satirYaz(sb, { user_id: userId, month, answers: used + 1 });

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

  const { row, hata } = await satirOku(sb, user.id, currentPeriod(user), 'answers');
  return { plan, used: hata ? null : (row?.answers ?? 0), limit: FREE_LIMIT };
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

  const { row, hata } = await satirOku(sb, user.id, currentPeriod(user), 'live_seconds');
  if (hata) return { plan, used_seconds: null, limit_seconds: limit, remaining_seconds: null, exhausted: false };

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
  const { row, hata } = await satirOku(sb, user.id, period, 'answers, live_seconds');
  if (hata) return { plan, used_seconds: null, limit_seconds: limit, remaining_seconds: null, exhausted: false };

  const used = (row?.live_seconds ?? 0) + delta;

  await satirYaz(sb, { user_id: user.id, month: period, answers: row?.answers ?? 0, live_seconds: used });

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
  getLiveUsage, addLiveSeconds, MAX_HEARTBEAT_SECONDS, _setSupabase,
};
