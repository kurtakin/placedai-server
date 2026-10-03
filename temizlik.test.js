/**
 * temizlik.test.js — Saklama surelerinin uygulanmasi (K94 Adim 4, 3 Ekim 2026).
 *
 * Calistir: node --test temizlik.test.js
 *
 * /privacy'deki sureler: bot ilanlari 30 gun (+ kisa anahtar 90 gun), hata
 * kayitlari 90 gun, izin arsivi sil_sonra. Bu test sorgularin tam olarak bu
 * sinirlarla yazildigini ve bir adimin hatasinin digerlerini durdurmadigini
 * kilitliyor.
 */
'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const T = require('./lib/temizlik');

/** Zincirdeki her cagriyi kaydeden sahte Supabase (bot-sunucu.test.js ile ayni kalip). */
function sahteSb(sonuclar = []) {
  const kayit = [];
  const sira = [...sonuclar];
  const zincir = (tablo) => {
    const adimlar = [];
    kayit.push({ tablo, adimlar });
    const p = new Proxy({}, {
      get(_, ad) {
        if (ad === 'then') {
          const s = sira.length ? sira.shift() : { data: [], error: null };
          return (ok, hata) => (s instanceof Error ? Promise.reject(s) : Promise.resolve(s)).then(ok, hata);
        }
        return (...args) => { adimlar.push([ad, ...args]); return p; };
      },
    });
    return p;
  };
  return { kayit, from: (t) => zincir(t) };
}
const sessiz = { info() {}, error() {} };
const SIMDI = new Date('2026-10-03T12:00:00Z');

test('T1: sureler politikayla ayni; bosaltilan alanlar anahtari ve durumu birakir', () => {
  assert.strictEqual(T.ILAN_ICERIK_GUN, 30);
  assert.strictEqual(T.ILAN_IZ_GUN, 90);
  assert.strictEqual(T.HATA_GUN, 90);
  assert.deepStrictEqual(T.BOS_ICERIK, { baslik: '', sirket: '', konum: '', link: '', kaynak: '', konum_kademe: null });
  for (const kalan of ['ilan_anahtari', 'durum', 'bulundu', 'user_id']) assert.ok(!(kalan in T.BOS_ICERIK), kalan);
});

test('T2: sorgular: once 90 gun silme, sonra 30 gun bosaltma (iki gecis), hata kayitlari, izin arsivi', async () => {
  const sb = sahteSb([{ data: [{ id: 1 }, { id: 2 }] }, { data: [{ id: 3 }] }, { data: [{ id: 4 }] }, { data: [{ id: 5 }] }, { data: [] }]);
  const s = await T.turCalistir({ sb, simdi: SIMDI, log: sessiz });
  assert.deepStrictEqual(s, { ilanSilindi: 2, ilanBosaltildi: 2, hataSilindi: 1, izinSilindi: 0 });
  const [sil90, bos1, bos2, hata, izin] = sb.kayit;
  assert.strictEqual(sil90.tablo, 'ia_bot_ilanlari');
  assert.deepStrictEqual(sil90.adimlar, [['delete'], ['lt', 'bulundu', '2026-07-05T12:00:00.000Z'], ['select', 'id']]);
  for (const [k, alan] of [[bos1, 'baslik'], [bos2, 'link']]) {
    assert.strictEqual(k.tablo, 'ia_bot_ilanlari');
    assert.deepStrictEqual(k.adimlar, [['update', T.BOS_ICERIK], ['lt', 'bulundu', '2026-09-03T12:00:00.000Z'], ['neq', alan, ''], ['select', 'id']]);
  }
  assert.strictEqual(hata.tablo, 'ia_errors');
  assert.deepStrictEqual(hata.adimlar, [['delete'], ['or', 'last_seen.lt.2026-07-05T12:00:00.000Z,and(last_seen.is.null,created_at.lt.2026-07-05T12:00:00.000Z)'], ['select', 'id']]);
  assert.strictEqual(izin.tablo, 'ia_izin_arsivi');
  assert.deepStrictEqual(izin.adimlar, [['delete'], ['lt', 'sil_sonra', '2026-10-03T12:00:00.000Z'], ['select', 'id']]);
  // Baska hicbir tabloya dokunulmaz (basvurular, yorumlar, hesaplar...)
  assert.deepStrictEqual([...new Set(sb.kayit.map((k) => k.tablo))].sort(), ['ia_bot_ilanlari', 'ia_errors', 'ia_izin_arsivi']);
});

test('T3: bir adimin hatasi digerlerini durdurmaz; basarisiz adim null', async () => {
  const hatalar = [];
  const log = { info() {}, error: (m) => hatalar.push(m) };
  const sb = sahteSb([{ data: null, error: { message: 'kilit' } }, new Error('ag'), { data: [{ id: 1 }] }, { data: [{ id: 2 }] }, { data: [{ id: 3 }, { id: 4 }] }]);
  const s = await T.turCalistir({ sb, simdi: SIMDI, log });
  assert.deepStrictEqual(s, { ilanSilindi: null, ilanBosaltildi: null, hataSilindi: 1, izinSilindi: 2 });
  assert.strictEqual(sb.kayit.length, 5, 'adimlar atlandi');
  assert.strictEqual(hatalar.length, 2);
  assert.ok(hatalar.every((m) => /^\[temizlik\] /.test(m)));
});

test('T4: log yalnizca sayilar', async () => {
  const kayit = [];
  await T.turCalistir({ sb: sahteSb([{ data: [{ id: 'a', baslik: 'Gizli' }] }]), simdi: SIMDI, log: { info: (o, m) => kayit.push([o, m]), error() {} } });
  assert.strictEqual(kayit.length, 1);
  assert.deepStrictEqual(Object.keys(kayit[0][0]).sort(), ['hataSilindi', 'ilanBosaltildi', 'ilanSilindi', 'izinSilindi']);
  for (const v of Object.values(kayit[0][0])) assert.ok(v === null || Number.isInteger(v));
});

test('T5: zamanlama: gunde bir, TEMIZLIK_SAATI sonrasi (varsayilan 9 UTC); kapatilabilir; Supabase yoksa kurulmaz', () => {
  assert.strictEqual(T.zamaniGeldiMi(new Date('2026-10-03T08:59:00Z'), null, {}), false);
  assert.strictEqual(T.zamaniGeldiMi(new Date('2026-10-03T09:00:00Z'), null, {}), true);
  assert.strictEqual(T.zamaniGeldiMi(new Date('2026-10-03T20:00:00Z'), '2026-10-03', {}), false, 'ayni gun ikinci kez');
  assert.strictEqual(T.zamaniGeldiMi(new Date('2026-10-04T09:30:00Z'), '2026-10-03', {}), true);
  assert.strictEqual(T.zamaniGeldiMi(new Date('2026-10-03T03:00:00Z'), null, { TEMIZLIK_SAATI: '3' }), true);
  assert.strictEqual(T.zamaniGeldiMi(new Date('2026-10-03T03:00:00Z'), null, { TEMIZLIK_SAATI: 'x' }), false);
  assert.strictEqual(T.zamanlayiciBaslat(sessiz, { env: { TEMIZLIK_ZAMANLAYICI: 'kapali', SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k' } }), null);
  assert.strictEqual(T.zamanlayiciBaslat(sessiz, { env: {} }), null);
  const t = T.zamanlayiciBaslat(sessiz, { env: { SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k' } });
  assert.ok(t);
  clearInterval(t);
  assert.match(fs.readFileSync(require.resolve('./index.js'), 'utf8'), /require\('\.\/lib\/temizlik'\)\.zamanlayiciBaslat\(app\.log\)/);
});
