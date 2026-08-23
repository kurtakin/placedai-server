/**
 * server/lib/errors.js — Merkezi hata kaydı
 *
 * Hatalar Supabase'deki `ia_errors` tablosuna yazılır. Aynı hata tekrar ederse
 * yeni satır açılmaz, `count` artar ve `last_seen` güncellenir (fingerprint benzersiz).
 *
 * Gerekli env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   — yoksa sadece console.error'a düşer
 *   ALERT_EMAIL (opsiyonel)                   — kritik hata bildirimi, varsayılan info@placedai.app
 *   ERROR_ALERTS=off                          — mail bildirimini tamamen kapatır
 */

'use strict';

const crypto = require('crypto');

const ALERT_TO       = process.env.ALERT_EMAIL || 'info@placedai.app';
const ALERTS_ENABLED = String(process.env.ERROR_ALERTS || '').toLowerCase() !== 'off';
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;   // aynı hata için saatte en fazla 1 mail

const MAX_MESSAGE = 1000;
const MAX_STACK   = 8000;

// fingerprint → son mail gönderim zamanı
const _lastAlertAt = new Map();

let _sb = null;
let _sbChecked = false;

function getSupabase() {
  if (_sbChecked) return _sb;
  _sbChecked = true;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('[errors] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY yok — hatalar sadece log\'a yazılacak');
    return null;
  }
  const { createClient } = require('@supabase/supabase-js');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

function clip(str, max) {
  if (str === null || str === undefined) return null;
  const s = String(str);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Aynı hatayı tek satırda toplamak için kimlik üret.
 * Mesajdaki değişken kısımlar (sayı, uuid, tırnak içi) sabitlenir ki
 * "user 123 not found" ile "user 456 not found" aynı satıra düşsün.
 */
function makeFingerprint({ source, route, message, status }) {
  const norm = String(message || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d{3,}\b/g, '<n>')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .slice(0, 200);
  const basis = [source || '', route || '', status || '', norm].join('|');
  return crypto.createHash('sha1').update(basis).digest('hex');
}

/**
 * Hatayı kaydet. Asla throw etmez — hata kaydı uygulamayı düşürmemeli.
 *
 * @param {object} e
 * @param {'server'|'browser'} e.source
 * @param {'warn'|'error'|'fatal'} [e.level]
 * @param {string} e.message
 * @param {string} [e.stack]
 * @param {string} [e.route]  @param {string} [e.method]  @param {number} [e.status]
 * @param {string} [e.user_id] @param {string} [e.user_email]
 * @param {string} [e.user_agent] @param {string} [e.url]
 * @param {object} [e.meta]
 */
async function logError(e = {}) {
  const row = {
    source:      e.source === 'browser' ? 'browser' : 'server',
    level:       ['warn', 'error', 'fatal'].includes(e.level) ? e.level : 'error',
    message:     clip(e.message || 'Unknown error', MAX_MESSAGE),
    stack:       clip(e.stack, MAX_STACK),
    route:       clip(e.route, 300),
    method:      clip(e.method, 10),
    status:      Number.isInteger(e.status) ? e.status : null,
    user_id:     e.user_id && /^[0-9a-f-]{36}$/i.test(e.user_id) ? e.user_id : null,
    user_email:  clip(e.user_email, 200),
    user_agent:  clip(e.user_agent, 400),
    url:         clip(e.url, 500),
    meta:        e.meta && typeof e.meta === 'object' ? e.meta : null,
  };
  row.fingerprint = makeFingerprint(row);

  // Her hâlükârda log'a yaz — Railway log'unda da görünsün
  console.error(`[error:${row.source}] ${row.route || '-'} ${row.message}`);

  const sb = getSupabase();
  if (!sb) return { ok: false, reason: 'no_supabase' };

  try {
    // Var mı? Varsa say, yoksa ekle.
    const { data: existing } = await sb
      .from('ia_errors')
      .select('id, count')
      .eq('fingerprint', row.fingerprint)
      .maybeSingle();

    if (existing) {
      await sb.from('ia_errors')
        .update({ count: existing.count + 1, last_seen: new Date().toISOString(), stack: row.stack })
        .eq('id', existing.id);
    } else {
      await sb.from('ia_errors').insert(row);
    }

    if (row.level === 'fatal') await maybeAlert(row);
    return { ok: true, fingerprint: row.fingerprint, first: !existing };
  } catch (err) {
    console.error('[errors] kayıt başarısız:', err.message);
    return { ok: false, error: err.message };
  }
}

/** Kritik hatada mail — aynı fingerprint için saatte 1 kez. */
async function maybeAlert(row) {
  if (!ALERTS_ENABLED) return;

  const now  = Date.now();
  const last = _lastAlertAt.get(row.fingerprint) || 0;
  if (now - last < ALERT_COOLDOWN_MS) return;
  _lastAlertAt.set(row.fingerprint, now);

  try {
    const { getTransporter, fromAddress, isConfigured } = require('./mailer');
    if (!isConfigured()) return;
    const transporter = getTransporter();
    if (!transporter) return;

    await transporter.sendMail({
      from:    fromAddress(),
      to:      ALERT_TO,
      subject: `🔴 PlacedAI hata: ${String(row.message).slice(0, 80)}`,
      text: [
        `Kaynak : ${row.source}`,
        `Route  : ${row.method || ''} ${row.route || '-'}`,
        `Durum  : ${row.status ?? '-'}`,
        `Kullanıcı: ${row.user_email || row.user_id || '-'}`,
        '',
        row.message,
        '',
        row.stack || '',
      ].join('\n'),
    });
  } catch (err) {
    console.error('[errors] uyarı maili gönderilemedi:', err.message);
  }
}

module.exports = { logError, makeFingerprint };
