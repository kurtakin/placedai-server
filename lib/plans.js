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

module.exports = { ALL_PLANS, PAID_PLANS, MULTI_PROFILE_PLANS, LIVE_MINUTES, liveSecondsFor };
