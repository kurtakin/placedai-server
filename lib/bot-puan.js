'use strict';

/**
 * server/lib/bot-puan.js — Botun buldugu ilana basit uygunluk puani (0-100).
 *
 * Kullanicinin karari (K80): once basit puan, yapay zeka puani ancak olcumden
 * sonra. Uc parca, hepsi acik ve yeniden uretilebilir:
 *
 *   baslik  45  arama kelimelerinin ya da profildeki unvanin ilan basliginda
 *               gecme orani (hangisi yuksekse). Her kelime bir kelimenin
 *               BASINDA gecmeli: "engineer" -> "Engineering" eslesir.
 *   beceri  30  profildeki becerilerden kacinin baslikta ya da aciklamada
 *               gectigi; iki eslesme tam puan.
 *   konum   25  konum.js kademesinden (sehir en yakin, uzak sifir).
 *
 * Olcum (K81, 30 Eylul 2026): 46 gercek ilan, bes arama; sonuc DEVAM.md'de.
 */

const { sade } = require('./konum');

const AGIRLIK = Object.freeze({ baslik: 45, beceri: 30, konum: 25 });
const BECERI_TAM = 2;

// Kademe -> konum parcasinin orani. konum.js KADEMELER ile ayni adlar.
const KONUM_ORANI = Object.freeze({
  sehir: 1, bolge: 0.88, ulke_uzaktan: 0.8, eyalet: 0.72,
  uzaktan_belirsiz: 0.48, ulke: 0.32, bilinmiyor: 0.32, uzak: 0,
});

const DURAK = new Set(['and', 'or', 'the', 'of', 'in', 'at', 'for', 'to', 've', 'ile', 'a', 'an']);

function kelimeler(metin) {
  return sade(metin).split(' ').filter((w) => w.length >= 2 && !DURAK.has(w));
}

/** Kelimelerin kaci metinde bir kelimenin basinda geciyor (0-1). */
function oran(metinSade, ks) {
  if (!ks.length) return 0;
  const t = ` ${metinSade}`;
  return ks.filter((w) => t.includes(` ${w}`)).length / ks.length;
}

/** Beceri ifadesi metinde tam kelime(ler) olarak geciyor mu ("power bi", "sql"). */
function ifadeVar(metinSade, ifade) {
  const s = sade(ifade);
  return !!s && (` ${metinSade} `).includes(` ${s} `);
}

/**
 * @param {{title:string, description?:string}} ilan
 * @param {{anahtar?:string, profil?:{unvan?:string, beceriler?:string[]}, kademe?:string|null}} baglam
 * @returns {{puan:number, parcalar:{baslik:number, beceri:number, konum:number}}}
 */
function uygunlukPuani(ilan, { anahtar = '', profil = {}, kademe = null } = {}) {
  const baslik = sade(ilan && ilan.title);
  const metin = `${baslik} ${sade(ilan && ilan.description)}`.trim();

  const baslikOrani = Math.max(oran(baslik, kelimeler(anahtar)), oran(baslik, kelimeler(profil && profil.unvan)));
  const beceriler = Array.isArray(profil && profil.beceriler) ? profil.beceriler : [];
  const eslesen = beceriler.filter((b) => ifadeVar(metin, b)).length;
  const beceriOrani = Math.min(1, eslesen / BECERI_TAM);
  const konumOrani = KONUM_ORANI[kademe] ?? KONUM_ORANI.bilinmiyor;

  const parcalar = {
    baslik: Math.round(AGIRLIK.baslik * baslikOrani),
    beceri: Math.round(AGIRLIK.beceri * beceriOrani),
    konum:  Math.round(AGIRLIK.konum * konumOrani),
  };
  const puan = Math.max(0, Math.min(100, parcalar.baslik + parcalar.beceri + parcalar.konum));
  return { puan, parcalar };
}

module.exports = { uygunlukPuani, AGIRLIK, KONUM_ORANI, BECERI_TAM, kelimeler, oran, ifadeVar };
