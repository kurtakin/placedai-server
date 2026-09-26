/**
 * server/olcum/denetimler.js — Altin test setinin denetim yapi taslari (K61).
 *
 * Her denetim { ad, fn(yanit) -> { gecti, kanit } } dondurur. Kanit, bir
 * insanin sonucu kendi gozuyle kontrol edebilmesi icin ESLESEN METNIN KENDISI
 * (K53: puan degil kanit). Desenler sezgisel: kacirabilir, yanlis alarm
 * verebilir; bu yuzden karar raporu okuyan kullanicinindir.
 */

'use strict';

const metin = (d) => {
  if (d == null) return '';
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map(metin).join('\n');
  if (typeof d === 'object') return Object.values(d).map(metin).join('\n');
  return String(d);
};

function baglam(m, yer, uzunluk) {
  const bas = Math.max(0, yer - 40), son = Math.min(m.length, yer + uzunluk + 40);
  return (bas ? '...' : '') + m.slice(bas, son).replace(/\s+/g, ' ') + (son < m.length ? '...' : '');
}

/** Metinde desen GECMEMELI. Gecerse kanit eslesen yerin cevresi. */
function yasak(ad, sec, desen) {
  return { ad, fn: (y) => {
    const m = metin(sec(y));
    const e = desen.exec(m);
    desen.lastIndex = 0;
    return e ? { gecti: false, kanit: baglam(m, e.index, e[0].length) } : { gecti: true, kanit: '' };
  } };
}

/** Metinde desen GECMELI. */
function gerekli(ad, sec, desen) {
  return { ad, fn: (y) => {
    const m = metin(sec(y));
    const e = desen.exec(m);
    desen.lastIndex = 0;
    return e ? { gecti: true, kanit: baglam(m, e.index, e[0].length) }
      : { gecti: false, kanit: m ? `bulunamadi: ${m.slice(0, 120).replace(/\s+/g, ' ')}...` : 'alan bos' };
  } };
}

/** Olculen sayi sinirin ustune cikmamali. olc: (yanit) -> { sayi, kanit } */
function enFazla(ad, olc, sinir) {
  return { ad, fn: (y) => {
    const { sayi, kanit } = olc(y);
    return { gecti: sayi <= sinir, kanit: `${sayi} (sinir ${sinir})${kanit ? `: ${kanit}` : ''}` };
  } };
}

/** Dizi uzunlugu tam olarak beklenen olmali. */
function adet(ad, sec, beklenen) {
  return { ad, fn: (y) => {
    const d = sec(y);
    const n = Array.isArray(d) ? d.length : 0;
    return { gecti: n === beklenen, kanit: `${n} (beklenen ${beklenen})` };
  } };
}

// ── Hazir olculer ────────────────────────────────────────────────────────────

/** HireVue taslaginda "[number]": modelin kaynaksiz sayi yazmaya calistigi yer sayisi. */
const uydurmaSayi = (y) => {
  const m = metin([y && y.answer_draft, y && y.key_points]);
  const n = (m.match(/\[number\]/g) || []).length;
  return { sayi: n, kanit: n ? baglam(m, m.indexOf('[number]'), 8) : '' };
};

/** Geri bildirimde dogrulanamayan (cevaplarda gecmeyen) alinti sayisi. */
const dogrulanamayanAlinti = (y) => {
  const k = Object.entries((y && y.categories) || {}).filter(([, c]) => c && c.unverified).map(([a]) => a);
  return { sayi: k.length, kanit: k.join(', ') };
};

/** Ayni alintinin birden cok kategoriye kanit yapilmasi. */
const tekrarAlinti = (y) => {
  const k = Object.entries((y && y.categories) || {}).filter(([, c]) => c && c.reused).map(([a]) => a);
  return { sayi: k.length, kanit: k.join(', ') };
};

/** LinkedIn denetiminin kaynaksiz saydigi rakamlar. */
const kaynaksizRakam = (y) => {
  const d = ((y && y.denetim) || []).find((x) => x.kod === 'rakam_kaynak');
  const liste = d && Array.isArray(d.deger) ? d.deger : [];
  return { sayi: liste.length, kanit: liste.join(', ') };
};

module.exports = { metin, yasak, gerekli, enFazla, adet, uydurmaSayi, dogrulanamayanAlinti, tekrarAlinti, kaynaksizRakam };
