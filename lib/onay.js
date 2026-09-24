'use strict';

/**
 * server/lib/onay.js — Ozellik bazinda kullanici onayinin KAYDI.
 *
 * NEDEN VAR (K56, 24 Eylul 2026). Kullanicinin karari: Online Assessment
 * bolumu, kullanici "uyariyi okudum; gercek bir sinav sirasinda ya da
 * baskalarini yaniltmak icin kullanirsam sorumluluk bana aittir" kutusunu
 * isaretlemeden calismiyor. Onay yalnizca tarayicida tutulsaydi verildigi
 * GOSTERILEMEZDI; o yuzden kim, ne zaman, hangi metin surumunu onayladi,
 * sunucuda yaziliyor.
 *
 * Metnin kendisi saklanmiyor, SURUM numarasi saklaniyor: her surumun metni
 * i18n.js'te ve git gecmisinde duruyor. Metin degisirse surum artar ve herkesten
 * yeniden onay istenir.
 *
 * KAPALI BASARISIZLIK. Tablo okunamazsa ozellik ACILMIYOR. Kaydi olmayan bir
 * onay, onay degildir; aciyor olsaydik tabloyu kurmayi unutmak onay kapisini
 * sessizce kaldirirdi.
 *
 * Supabase tablosu (SQL editorunde bir kez calistirilir):
 *
 *   CREATE TABLE IF NOT EXISTS public.feature_consents (
 *     id          bigserial   PRIMARY KEY,
 *     user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 *     feature     text        NOT NULL,
 *     version     integer     NOT NULL,
 *     language    text,
 *     accepted_at timestamptz NOT NULL DEFAULT now(),
 *     UNIQUE (user_id, feature, version)
 *   );
 *   ALTER TABLE public.feature_consents ENABLE ROW LEVEL SECURITY;
 *
 * Politika YOK: tabloya yalnizca sunucu (service role) erisir. Kullanici
 * kendi onayini tarayicidan silemez ya da baskasi adina yazamaz.
 */

/** Ozellik -> gecerli onay metni surumu. Metin degisince burasi artar. */
const ONAY_SURUMLERI = Object.freeze({ 'online-assessment': 1 });

const TABLO = 'feature_consents';

let _sb;          // undefined: henuz kurulmadi; null: Supabase yok (gelistirme)
function getSupabase() {
  if (_sb !== undefined) return _sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { _sb = null; return _sb; }
  const { createClient } = require('@supabase/supabase-js');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

/** Testler icin: sahte istemci ver ya da sifirla (undefined). */
function _setSupabase(sb) { _sb = sb; }

/**
 * @returns {Promise<'var'|'yok'|'okunamadi'>}
 */
async function onayDurumu(user, ozellik) {
  const surum = ONAY_SURUMLERI[ozellik];
  if (!surum) return 'yok';
  const sb = getSupabase();
  // Gelistirme modu (Supabase yok): requireAuth de sahte kullanici veriyor;
  // diger moduller gibi burasi da kapiyi aciyor.
  if (!sb || user?.id === 'dev-user') return 'var';
  try {
    const { data, error } = await sb.from(TABLO).select('id')
      .eq('user_id', user.id).eq('feature', ozellik).eq('version', surum)
      .maybeSingle();
    if (error) return 'okunamadi';
    return data ? 'var' : 'yok';
  } catch {
    return 'okunamadi';
  }
}

/**
 * @returns {Promise<boolean>} yazildi mi (zaten varsa da true)
 */
async function onayKaydet(user, ozellik, dil) {
  const surum = ONAY_SURUMLERI[ozellik];
  if (!surum) return false;
  const sb = getSupabase();
  if (!sb || user?.id === 'dev-user') return true;
  try {
    const { error } = await sb.from(TABLO).upsert(
      { user_id: user.id, feature: ozellik, version: surum, language: String(dil || '').slice(0, 8) || null },
      { onConflict: 'user_id,feature,version', ignoreDuplicates: true },
    );
    return !error;
  } catch {
    return false;
  }
}

module.exports = { ONAY_SURUMLERI, onayDurumu, onayKaydet, _setSupabase, TABLO };
