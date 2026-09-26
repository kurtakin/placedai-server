/**
 * lib/usage-okuma.test.js — Sayac okunamazsa YAZILMAZ ve sayi uydurulmaz (K62).
 *
 * Calistir: node --test "*.test.js" "lib/*.test.js" "middleware/*.test.js"
 *
 * Eskiden okuma hatasi "0 kullanildi" sayiliyordu ve ardindan gelen yazma
 * gercek sayacin uzerine yaziyordu: 8 olan cevap sayaci 1'e, canli oturumda
 * iki sayac birden sifira iniyordu. Kapinin davranisi (hatada gecir) ayni.
 */

const { test } = require('node:test');
const assert   = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://sahte.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sahte';
const U = require('./usage');

function sahteSb({ satir = null, okumaHatasi = null, yazmaHatasi = null } = {}) {
  const yazilan = [], okunan = [];
  const sb = {
    from(tablo) {
      assert.strictEqual(tablo, 'ia_usage');
      const sorgu = { filtre: {} };
      const zincir = {
        select(alanlar) { sorgu.alanlar = alanlar; return zincir; },
        eq(k, v) { sorgu.filtre[k] = v; return zincir; },
        async maybeSingle() { okunan.push(sorgu); return okumaHatasi ? { data: null, error: okumaHatasi } : { data: satir, error: null }; },
        async upsert(kayit, secenek) { yazilan.push({ kayit, secenek }); return { error: yazmaHatasi }; },
      };
      return zincir;
    },
  };
  return { sb, yazilan, okunan };
}
const KULLANICI = { id: 'u-42', created_at: '2026-03-14T10:00:00Z', app_metadata: { plan: 'free' } };
const HATA = { message: 'connection reset' };

function sessiz(fn) {
  const eski = console.error; const log = [];
  console.error = (...a) => log.push(a.join(' '));
  return Promise.resolve().then(fn).then((r) => ({ r, log })).finally(() => { console.error = eski; });
}

test('U1: cevap sayaci okunamazsa YAZILMIYOR, kapi eskisi gibi geciriyor, sayi null', async () => {
  const s = sahteSb({ okumaHatasi: HATA });
  U._setSupabase(s.sb);
  const { r, log } = await sessiz(() => U.checkAndIncrement(KULLANICI));
  assert.deepStrictEqual(r, { allowed: true, used: null, limit: U.FREE_LIMIT, plan: 'free' });
  assert.strictEqual(s.yazilan.length, 0, 'okunamayan sayacin uzerine yazildi');
  assert.match(log[0], /sayac okunamadi.*connection reset/);
});

test('U2: normal yol: okunan sayinin bir fazlasi yaziliyor, donem anahtari kullanicinin', async () => {
  const s = sahteSb({ satir: { answers: 7 } });
  U._setSupabase(s.sb);
  const r = await U.checkAndIncrement(KULLANICI);
  assert.deepStrictEqual([r.allowed, r.used], [true, 8]);
  assert.deepStrictEqual(s.yazilan[0].kayit, { user_id: 'u-42', month: U.currentPeriod(KULLANICI), answers: 8 });
  assert.deepStrictEqual(s.yazilan[0].secenek, { onConflict: 'user_id,month' });
  assert.strictEqual(s.okunan[0].filtre.user_id, 'u-42');
});

test('U3: sinira gelince reddediliyor ve yazilmiyor', async () => {
  const s = sahteSb({ satir: { answers: U.FREE_LIMIT } });
  U._setSupabase(s.sb);
  const r = await U.checkAndIncrement(KULLANICI);
  assert.deepStrictEqual([r.allowed, r.used], [false, U.FREE_LIMIT]);
  assert.strictEqual(s.yazilan.length, 0);
});

test('U4: canli sure okunamazsa iki sayac da YAZILMIYOR; kalan bilinmiyor (null), oturum kesilmiyor', async () => {
  const s = sahteSb({ okumaHatasi: HATA });
  U._setSupabase(s.sb);
  const { r } = await sessiz(() => U.addLiveSeconds(KULLANICI, 60));
  assert.strictEqual(s.yazilan.length, 0, 'answers ve live_seconds sifirlanirdi');
  assert.deepStrictEqual([r.used_seconds, r.remaining_seconds, r.exhausted], [null, null, false]);
  assert.strictEqual(r.limit_seconds, 600);
});

test('U5: canli sure normal yol: cevap sayaci korunarak ekleniyor', async () => {
  const s = sahteSb({ satir: { answers: 6, live_seconds: 500 } });
  U._setSupabase(s.sb);
  const r = await U.addLiveSeconds(KULLANICI, 90);
  assert.deepStrictEqual(s.yazilan[0].kayit, { user_id: 'u-42', month: U.currentPeriod(KULLANICI), answers: 6, live_seconds: 590 });
  assert.deepStrictEqual([r.used_seconds, r.remaining_seconds, r.exhausted], [590, 10, false]);
});

test('U6: salt okuma uclari hatada 0 degil null donuyor', async () => {
  U._setSupabase(sahteSb({ okumaHatasi: HATA }).sb);
  const { r: cevap } = await sessiz(() => U.getUsage(KULLANICI));
  const { r: canli } = await sessiz(() => U.getLiveUsage(KULLANICI));
  assert.strictEqual(cevap.used, null);
  assert.deepStrictEqual([canli.used_seconds, canli.remaining_seconds, canli.exhausted], [null, null, false]);
  U._setSupabase(sahteSb({ satir: null }).sb);
  assert.strictEqual((await U.getUsage(KULLANICI)).used, 0, 'satir yoksa gercekten 0');
  assert.strictEqual((await U.getLiveUsage(KULLANICI)).remaining_seconds, 600);
});

test('U7: yazma hatasi sessiz gecmiyor (loga dusuyor)', async () => {
  const s = sahteSb({ satir: { answers: 2 }, yazmaHatasi: { message: 'disk full' } });
  U._setSupabase(s.sb);
  const { r, log } = await sessiz(() => U.checkAndIncrement(KULLANICI));
  assert.strictEqual(r.allowed, true);
  assert.ok(log.some((l) => /sayac yazilamadi.*disk full/.test(l)), log.join('\n'));
  U._setSupabase(null);
});
