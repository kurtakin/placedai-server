'use strict';

/**
 * server/lib/plans.js — plan adlarının tek doğruluk kaynağı.
 *
 * 'multi' eski "Multi-Profile" paketinin adı. Ultimate onun yerini aldı ama
 * eski aboneler hâlâ 'multi' taşıyor, bu yüzden ikisi de geçerli kalıyor.
 */

const ALL_PLANS           = ['free', 'pro', 'multi', 'ultimate'];
const PAID_PLANS          = ['pro', 'multi', 'ultimate'];
const MULTI_PROFILE_PLANS = ['multi', 'ultimate'];

/**
 * Canli mulakat yardimi icin aylik dakika hakki.
 *
 * Canli dinleme sureye bagli para harciyor: transkripsiyon ~$0.36/saat,
 * cevap uretimi ~$0.40/saat. Bu yuzden aylik bir tavan var — ama tavan
 * ORTALAMA kullaniciyi fiyatlamak icin degil, kuyrugu kesmek icin. Gercek bir
 * is arayan yogun bir ayda 6-8 saat kullaniyor; limit ona degmemeli, cunku
 * degdigi anda destek talebi ve iptal uretir, ki bunun maliyeti yapay
 * zekadan pahali.
 *
 * Free 10 dakika: piyasa standardi (Final Round AI 10, Sensei 15, Craqly 20).
 * Bir mulakati bitirmeye yetmez ama urunun calistigini gostermeye yeter —
 * satin alma karari zaten orada veriliyor.
 */
const LIVE_MINUTES = {
  free:      10,
  pro:      300,   // 5 saat
  multi:    300,   // eski Multi-Profile paketi Pro ile ayni hakki aliyor
  ultimate: 720,   // 12 saat
};

/** Planin aylik canli saniye hakki. Bilinmeyen plan free sayilir. */
function liveSecondsFor(plan) {
  return (LIVE_MINUTES[plan] ?? LIVE_MINUTES.free) * 60;
}

/**
 * Hangi ozellik hangi planda? — kapinin ve arayuzdeki kilidin ORTAK kaynagi.
 *
 * Anahtarlar dashboard'daki `data-view` degerleriyle birebir ayni. Sunucu bu
 * haritadan kapi kuruyor, dashboard ayni haritayi cekip kartlara kilit ciziyor;
 * ikisi ayni nesneden beslendigi icin celisemezler. Arayuz kibarlik, sunucu
 * kural — ama ikisinin ayni seyi soylemesi gerekiyor.
 *
 * Burada YER ALMAYAN her ozellik tum planlarda acik. Ucretsiz katmanda onlar
 * aylik sayacla sinirli (lib/usage.js), kilitli degil: kullanicinin urunun
 * calistigini gormesi lazim.
 */
const FEATURE_PLANS = {
  // Ultimate — surec yonetimi: cok rol, otomasyon, eleme sinavlari, gelisim
  'performance':       ['ultimate'],   // mulakat sonrasi radar + STAR + oneriler
  'online-assessment': ['ultimate'],   // HireVue, CodeSignal, HackerRank, Codility, TestGorilla
  'duo-mode':          ['ultimate'],   // arkadas canli soru/ipucu gonderiyor
  'botapply':          ['ultimate'],   // zamanlanmis is tarama

  // Ucretli — mulakati kazanma isi
  'coding':            PAID_PLANS,     // LeetCode/HackerRank cozumu
};

/** Bu ozellige bu plan erisebilir mi? Haritada yoksa herkese acik. */
function planAllows(plan, feature) {
  const allowed = FEATURE_PLANS[feature];
  if (!allowed) return true;
  return allowed.includes(plan);
}

/** Ozelligi acan en dusuk plan — arayuz "Ultimate gerekiyor" diyebilsin. */
function minPlanFor(feature) {
  const allowed = FEATURE_PLANS[feature];
  if (!allowed) return null;
  return ALL_PLANS.find((p) => allowed.includes(p)) || null;
}

module.exports = {
  ALL_PLANS, PAID_PLANS, MULTI_PROFILE_PLANS,
  LIVE_MINUTES, liveSecondsFor,
  FEATURE_PLANS, planAllows, minPlanFor,
};
