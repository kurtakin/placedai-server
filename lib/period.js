'use strict';

/**
 * Kota penceresinin başlangıcı — kullanıcının kendi yıldönümüne göre.
 *
 * Takvim ayı kullanmak, ayın sonlarında kayıt olan kullanıcıya birkaç günde
 * iki pencerelik hak veriyordu: 28 Ağustos'ta gelen kişi Ağustos hakkını
 * kullanıyor, 1 Eylül'de sayaç sıfırlanıyordu.
 *
 * @param {Date} anchor  kullanıcının demir attığı tarih (kayıt ya da fatura dönemi başlangıcı)
 * @param {Date} now     şimdiki zaman
 * @returns {Date}       içinde bulunulan dönemin başlangıcı (UTC gün başı)
 */
function periodStart(anchor, now) {
  const day = anchor.getUTCDate();

  /** Ayın son gününü aşan yıldönümlerini kırp: 31 → Şubat'ta 28/29. */
  const clamp = (y, m) => Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());

  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  let start = new Date(Date.UTC(y, m, clamp(y, m)));

  // Bu ayın yıldönümü henüz gelmediyse, içinde bulunduğumuz dönem geçen ay başladı.
  if (now < start) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
    start = new Date(Date.UTC(y, m, clamp(y, m)));
  }

  return start;
}

/**
 * Dönem anahtarı — ia_usage.month sütununda saklanır.
 *
 * Sütun zaten `text`, 'YYYY-MM-DD' sığıyor; şema değişikliği gerekmiyor.
 * Demir atacak bir tarih yoksa eski takvim-ayı davranışına düşeriz —
 * yanlış olsa da sayacı tamamen kaybetmekten iyidir.
 */
function periodKey(anchorISO, now = new Date()) {
  const anchor = anchorISO ? new Date(anchorISO) : null;
  if (!anchor || Number.isNaN(anchor.getTime())) {
    return now.toISOString().slice(0, 7);          // 'YYYY-MM' — geri düşüş
  }
  return periodStart(anchor, now).toISOString().slice(0, 10);   // 'YYYY-MM-DD'
}

module.exports = { periodStart, periodKey };
