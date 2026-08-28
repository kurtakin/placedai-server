'use strict';

/**
 * server/lib/plans.js — plan adlarının tek doğruluk kaynağı.
 *
 * Eskiden bir 'multi' (Multi-Profile, $29.99) katmanı vardı; Ultimate onun
 * yerini aldı. Geriye dönük uyumluluk için bir süre taşındı, sonra o planda
 * hiç kullanıcı olmadığı doğrulandı ve kaldırıldı — var olmayan bir kitleyi
 * koruyan kod, altı ay sonra kimsenin sebebini bilmediği bir tuzağa dönüşür.
 */

const ALL_PLANS           = ['free', 'pro', 'ultimate'];
const PAID_PLANS          = ['pro', 'ultimate'];
const MULTI_PROFILE_PLANS = ['ultimate'];

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
  // Ultimate — kampanyayi yonetmek: cok rol, otomasyon, gelisim dongusu
  'performance': ['ultimate'],   // mulakat sonrasi radar + STAR + oneriler
  'duo-mode':    ['ultimate'],   // arkadas canli soru/ipucu gonderiyor
  'botapply':    ['ultimate'],   // zamanlanmis is tarama

  // Ucretli — mulakati kazanma isi. Eleme asamasi da buraya ait: HireVue bir
  // video mulakat, TestGorilla yetenek sinavi. Bunlari ust katmana kilitlemek,
  // Pro musterisine "mulakatta yardim ederim ama mulakata gelmeden elenirsin"
  // demek olurdu.
  'coding':            PAID_PLANS,   // LeetCode/HackerRank cozumu
  'online-assessment': PAID_PLANS,   // HireVue, CodeSignal, HackerRank, Codility, TestGorilla
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
