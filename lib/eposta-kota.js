'use strict';

/**
 * server/lib/eposta-kota.js — Kullanicilara giden e-postalarin ORTAK gunluk
 * tavani (K85, 30 Eylul 2026).
 *
 * Resend ucretsiz plani gunde 100 e-posta (olculdu, K80). Bot ozeti (K81) ve
 * basvuru sonuc hatirlatmasi (K85) ayni kotayi kullaniyor; ikisinin toplami
 * EPOSTA_GUNLUK (varsayilan 80; eski ad BOT_EPOSTA_GUNLUK da okunur). Kalan
 * pay operator bildirimlerinin (hata, model takibi).
 *
 * Sayac BELLEKTE ve UTC gunune bagli: sunucu yeniden baslarsa o gun icin
 * sifirlanir (bilinen sinir, K81).
 */

const gunAnahtari = (t) => new Date(t).toISOString().slice(0, 10);
let gun = null;
let adet = 0;

function tavan(env = process.env) {
  for (const ad of ['EPOSTA_GUNLUK', 'BOT_EPOSTA_GUNLUK']) {
    if (env[ad] === undefined || env[ad] === '') continue;
    const n = Number(env[ad]);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return 80;
}

function tazele(simdi) {
  const g = gunAnahtari(simdi);
  if (gun !== g) { gun = g; adet = 0; }
}

/** Bugun kalan e-posta hakki. */
function kalan(simdi = Date.now(), env = process.env) {
  tazele(+simdi);
  return Math.max(0, tavan(env) - adet);
}

/** Bir e-posta gonderilecek: sayaci artir. */
function say(simdi = Date.now()) {
  tazele(+simdi);
  adet++;
}

function _sifirla() { gun = null; adet = 0; }

module.exports = { kalan, say, tavan, _sifirla };
