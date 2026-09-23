/**
 * server/lib/linkedin-denetim.js — LinkedIn metninin KODDA olculen denetimi.
 *
 * NEDEN VAR. 23 Eylul 2026'da olculdu (K53): LinkedIn sayfasi "Once 42 ->
 * Sonra 91" gosteriyordu ve iki sayiyi da MODEL uyduruyordu. Ikincisi modelin
 * kendi yazdigi metne verdigi nottu. Kodda hicbir sey olculmuyordu; puan
 * gelmezse ekranda gercek bir olcum gibi "0" gorunuyordu.
 *
 * Yerine koydugumuz sey bir PUAN degil, her maddesi ayri dogrulanabilen bir
 * liste. Her madde bir KOD tasir; metni arayuz kendi sozlugunden yazar (K25).
 *
 * Sinirlar LinkedIn'in 2026 sinirlari: baslik 220, Hakkinda 2.600 karakter.
 */

'use strict';

const BASLIK_SINIRI   = 220;
const HAKKINDA_SINIRI = 2600;

/**
 * Metindeki sayilar, karsilastirilabilir bicimde.
 *
 * "1,200" ile "1200" ayni sayidir; ayraclar atilir. "2.5" ile "25" de ayni
 * gorunur: bu bilincli bir bedel, cunku amac BIR SAYININ KAYNAKTA OLUP
 * OLMADIGINI bulmak ve yanlis alarm, kacirilan uydurmadan ucuzdur.
 *
 * Yaziyla yazilan sayilar ("seven years") YAKALANMAZ. Bu denetim uydurmayi
 * azaltir, yok etmez; istemdeki yasak hala asil korumadir.
 */
function sayilar(metin) {
  const bulunan = String(metin || '').match(/\d+(?:[.,]\d+)*/g) || [];
  return bulunan.map((s) => s.replace(/[.,]/g, ''));
}

/** Kaynakta OLMAYAN sayilar, ilk goruldukleri bicimleriyle, tekrarsiz. */
function kaynaksizSayilar(uretilen, kaynak) {
  const var_ = new Set(sayilar(kaynak));
  const ham = String(uretilen || '').match(/\d+(?:[.,]\d+)*/g) || [];
  const cikti = [];
  for (const s of ham) {
    const n = s.replace(/[.,]/g, '');
    if (!var_.has(n) && !cikti.includes(s)) cikti.push(s);
  }
  return cikti;
}

const sade = (m) => String(m || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Modelin "mevcut baslik" diye verdigi metin profilde GERCEKTEN geciyor mu?
 * Gecmiyorsa bos dondur: uydurulmus bir "once" hali, uydurulmus bir puan
 * kadar yaniltici.
 */
function mevcutBaslikDogrula(profil, baslik) {
  const b = sade(baslik);
  if (!b) return '';
  return sade(profil).includes(b) ? String(baslik).trim() : '';
}

/**
 * @returns {{kod:string, durum:'tamam'|'uyari'|'bilgi', deger:(number|string[])}[]}
 */
function profilDenetimi({ profil, hedef, sonuc }) {
  const baslik   = String(sonuc.headline || '');
  const hakkinda = String(sonuc.about || '');
  const liste = [];

  liste.push({
    kod: 'baslik_uzunluk',
    durum: baslik.length <= BASLIK_SINIRI ? 'tamam' : 'uyari',
    deger: baslik.length,
  });

  const h = sade(hedef);
  if (h) {
    liste.push({
      kod: 'baslik_hedef',
      durum: sade(baslik).includes(h) ? 'tamam' : 'uyari',
      deger: String(hedef).trim(),
    });
  }

  liste.push({
    kod: 'hakkinda_uzunluk',
    durum: hakkinda.length <= HAKKINDA_SINIRI ? 'tamam' : 'uyari',
    deger: hakkinda.length,
  });

  liste.push({
    kod: 'beceri_sayisi',
    durum: 'bilgi',
    deger: Array.isArray(sonuc.skills) ? sonuc.skills.length : 0,
  });

  const kaynaksiz = kaynaksizSayilar(`${baslik}\n${hakkinda}`, profil);
  liste.push({
    kod: 'rakam_kaynak',
    durum: kaynaksiz.length ? 'uyari' : 'tamam',
    deger: kaynaksiz,
  });

  return liste;
}

module.exports = {
  profilDenetimi, mevcutBaslikDogrula, kaynaksizSayilar,
  BASLIK_SINIRI, HAKKINDA_SINIRI,
  DENETIM_KODLARI: ['baslik_uzunluk', 'baslik_hedef', 'hakkinda_uzunluk', 'beceri_sayisi', 'rakam_kaynak'],
};
