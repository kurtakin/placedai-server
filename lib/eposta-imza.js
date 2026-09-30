'use strict';

/**
 * server/lib/eposta-imza.js — E-postadaki "bu e-postalari kapat" baglantisinin
 * imzasi (K81).
 *
 * Baglanti oturum acmadan calismali (Kanada CASL: kolay ve hemen calisan bir
 * cikis yolu). Oturum yoksa kimin e-postasinin kapatilacagini baglantinin
 * kendisi soyler; baskasi adina kapatilamasin diye HMAC ile imzali.
 *
 * Anahtar: BOT_EPOSTA_ANAHTARI varsa o. Yoksa service-role anahtarindan
 * turetilir (sha256), boylece Railway'e yeni bir gizli deger eklemek
 * gerekmiyor; turetilmis anahtar service-role anahtarini ele vermez. Ikisi
 * de yoksa imza uretilmez ve baglanti eklenmez (yerel gelistirme).
 *
 * `amac` imzaya girer: bot ozeti icin uretilen baglanti ileride gelecek
 * kampanya e-postalarini kapatmakta kullanilamaz, tersi de.
 */

const crypto = require('crypto');

const API_URL_VARSAYILAN = 'https://placedai-server-production.up.railway.app';

function anahtar(env = process.env) {
  if (env.BOT_EPOSTA_ANAHTARI) return String(env.BOT_EPOSTA_ANAHTARI);
  if (env.SUPABASE_SERVICE_ROLE_KEY) {
    return crypto.createHash('sha256').update(`placedai-eposta-v1:${env.SUPABASE_SERVICE_ROLE_KEY}`).digest('hex');
  }
  return null;
}

function imzala(userId, amac, env = process.env) {
  const a = anahtar(env);
  if (!a || !userId || !amac) return null;
  return crypto.createHmac('sha256', a).update(`${amac}:${userId}`).digest('base64url').slice(0, 32);
}

function dogrula(userId, amac, imza, env = process.env) {
  const beklenen = imzala(userId, amac, env);
  if (!beklenen || typeof imza !== 'string' || imza.length !== beklenen.length) return false;
  return crypto.timingSafeEqual(Buffer.from(imza), Buffer.from(beklenen));
}

/** Kapatma sayfasinin adresi; imza uretilemezse null. */
function kapatmaLinki(userId, amac = 'bot_ozet', env = process.env) {
  const t = imzala(userId, amac, env);
  if (!t) return null;
  const taban = String(env.API_URL || API_URL_VARSAYILAN).replace(/\/+$/, '');
  return `${taban}/api/v1/bot/eposta-kapat?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(t)}`;
}

module.exports = { imzala, dogrula, kapatmaLinki, anahtar, API_URL_VARSAYILAN };
