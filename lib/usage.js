'use strict';

/**
 * server/lib/usage.js — Free plan monthly usage tracking.
 *
 * Free plan: 10 AI answers per calendar month (UTC).
 * Pro / Multi: unlimited (no DB check performed).
 *
 * Supabase table required — run this once in the SQL editor:
 *
 *   CREATE TABLE IF NOT EXISTS ia_usage (
 *     user_id uuid  REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
 *     month   text  NOT NULL,               -- 'YYYY-MM'  (UTC)
 *     answers int   NOT NULL DEFAULT 0,
 *     PRIMARY KEY (user_id, month)
 *   );
 *   ALTER TABLE ia_usage ENABLE ROW LEVEL SECURITY;
 *   CREATE POLICY "own usage" ON ia_usage USING (auth.uid() = user_id);
 */

const FREE_LIMIT = 10;

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

/** Current UTC month as 'YYYY-MM' */
function currentMonth() {
  return new Date().toISOString().slice(0, 7);
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
  const month  = currentMonth();

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
    .eq('month', currentMonth())
    .maybeSingle();

  return { plan, used: row?.answers ?? 0, limit: FREE_LIMIT };
}

module.exports = { checkAndIncrement, getUsage, getUserPlan, FREE_LIMIT };
