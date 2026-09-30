/**
 * bot-sunucu.test.js — Sunucuda calisan is botu (K81, 30 Eylul 2026).
 *
 *   lib/bot-depo.js          Supabase sorgulari (sahte istemciyle: sorgu bicimi)
 *   lib/bot-zamanlayici.js   12 saat, Ultimate, kotalar, gunde bir ozet
 *   lib/bot-ozet.js          e-posta icerigi (kacis, puan gosterilmez)
 *   routes/bot.js            ayarlar ve e-posta kapatma
 *
 * Calistir: node --test
 */
'use strict';

const { test, beforeEach } = require('node:test');
const assert   = require('node:assert');

const depo = require('./lib/bot-depo');
const Z = require('./lib/bot-zamanlayici');
const { ozetIcerigi, GOSTERILEN } = require('./lib/bot-ozet');
const imza = require('./lib/eposta-imza');
const { BOT } = require('./lib/hata-kodlari');

// ── Sahte Supabase: zinciri kaydeder, sirayla hazir sonuc doner ─────────────
function sahteSb(sonuclar = []) {
  const kayit = [];
  const sira = [...sonuclar];
  const zincir = (tablo) => {
    const adimlar = [];
    const k = { tablo, adimlar };
    kayit.push(k);
    const p = new Proxy({}, {
      get(_, ad) {
        if (ad === 'then') {
          const s = sira.length ? sira.shift() : { data: null, error: null };
          return (ok, hata) => Promise.resolve(s).then(ok, hata);
        }
        return (...args) => { adimlar.push([ad, ...args]); return p; };
      },
    });
    return p;
  };
  return {
    kayit,
    from: (t) => zincir(t),
    auth: { admin: { getUserById: async (id) => (sira.length ? sira.shift() : { data: { user: null }, error: null }) } },
  };
}
const adimlar = (k) => k.adimlar.map((a) => a[0]);

test('D1: Supabase yoksa islevler hata atiyor (sessiz basari yok)', async () => {
  depo._setSupabase(null);
  await assert.rejects(depo.ayarOku('u'), (e) => e.supabaseYok === true);
  await assert.rejects(depo.epostaKapat('u'), /Supabase/);
  depo._setSupabase(undefined);
});

test('D2: sorgu bicimleri: siradakiler, ilan ekleme, ozet', async () => {
  const sb = sahteSb([{ data: [{ user_id: 'a' }] }, { data: [{ id: 1 }, { id: 2 }] }, { data: [] }, { data: null }, { data: null }, { data: null }]);
  depo._setSupabase(sb);
  const simdi = new Date('2026-09-30T12:00:00Z');
  assert.deepStrictEqual(await depo.siradakiler(simdi, 5), [{ user_id: 'a' }]);
  assert.deepStrictEqual(sb.kayit[0].adimlar, [['select', '*'], ['eq', 'aktif', true], ['lte', 'sonraki_arama', '2026-09-30T12:00:00.000Z'], ['order', 'sonraki_arama', { ascending: true }], ['limit', 5]]);
  assert.strictEqual(sb.kayit[0].tablo, 'ia_bot_ayarlari');

  assert.strictEqual(await depo.ilanlariEkle('u1', [{ ilan_anahtari: 'x', user_id: 'baskasi' }]), 2);
  const ek = sb.kayit[1];
  assert.strictEqual(ek.tablo, 'ia_bot_ilanlari');
  assert.deepStrictEqual(ek.adimlar[0], ['upsert', [{ ilan_anahtari: 'x', user_id: 'u1' }], { onConflict: 'user_id,ilan_anahtari', ignoreDuplicates: true }], 'user_id ezilemez');

  await depo.ozetIlanlari('u1');
  assert.deepStrictEqual(adimlar(sb.kayit[2]), ['select', 'eq', 'eq', 'is', 'order', 'order', 'limit']);
  assert.deepStrictEqual(sb.kayit[2].adimlar.slice(1, 4), [['eq', 'user_id', 'u1'], ['eq', 'durum', 'yeni'], ['is', 'epostada', null]]);

  await depo.ozetIsaretle('u1', ['i1'], simdi);
  assert.deepStrictEqual(sb.kayit[3].adimlar, [['update', { epostada: '2026-09-30T12:00:00.000Z' }], ['eq', 'user_id', 'u1'], ['in', 'id', ['i1']]]);
  assert.deepStrictEqual(sb.kayit[4].adimlar, [['update', { son_eposta: '2026-09-30T12:00:00.000Z' }], ['eq', 'user_id', 'u1']]);
  await depo.epostaKapat('u9');
  assert.deepStrictEqual(sb.kayit[5].adimlar, [['update', { eposta_ozet: false }], ['eq', 'user_id', 'u9']]);
  depo._setSupabase(undefined);
});

test('D3: ayar yazma user_id\'yi govdeden almiyor; hata metni yukari cikiyor; bos liste sorgu yok', async () => {
  const sb = sahteSb([{ data: { aktif: true } }, { data: null, error: { message: 'boom' } }]);
  depo._setSupabase(sb);
  await depo.ayarYaz('u1', { aktif: true, user_id: 'baskasi' });
  assert.deepStrictEqual(sb.kayit[0].adimlar[0], ['upsert', { aktif: true, user_id: 'u1' }, { onConflict: 'user_id' }]);
  await assert.rejects(depo.aramaBitti('u1', { sonraki_arama: new Date(0) }), /boom/);
  assert.strictEqual(await depo.ilanlariEkle('u1', []), 0);
  assert.strictEqual(sb.kayit.length, 2, 'bos ilan listesi icin sorgu atildi');
  depo._setSupabase(undefined);
});

test('D4: kullanici: plan ve e-posta; yoksa null; plan yoksa free', async () => {
  depo._setSupabase(sahteSb([
    { data: { user: { email: 'a@b.co', app_metadata: { plan: 'ultimate' } } }, error: null },
    { data: { user: { email: 'c@d.co', app_metadata: {} } }, error: null },
    { data: null, error: { status: 404, message: 'User not found' } },
    { data: null, error: { status: 500, message: 'db down' } },
  ]));
  assert.deepStrictEqual(await depo.kullanici('1'), { plan: 'ultimate', email: 'a@b.co' });
  assert.deepStrictEqual(await depo.kullanici('2'), { plan: 'free', email: 'c@d.co' });
  assert.strictEqual(await depo.kullanici('3'), null);
  await assert.rejects(depo.kullanici('4'), /db down/);
  depo._setSupabase(undefined);
});

// ── Zamanlayici ─────────────────────────────────────────────────────────────
const SIMDI = new Date('2026-09-30T12:00:00Z');
const ENV = { ADZUNA_APP_ID: 'i', ADZUNA_APP_KEY: 'k', SUPABASE_SERVICE_ROLE_KEY: 'gizli', BOT_ADZUNA_GUNLUK: '120', BOT_EPOSTA_GUNLUK: '80' };
const AYAR = { user_id: 'u1', aktif: true, anahtar_kelime: 'data analyst', konum: 'Toronto, ON', sirketler: [{ platform: 'lever', kod: 'plaid' }], profil: { beceriler: ['SQL'] }, eposta_ozet: true, son_eposta: null };

function sahteDepo(ek = {}) {
  const c = { aramaBitti: [], ilanlariEkle: [], ayarYaz: [], ozetIsaretle: [] };
  return {
    c,
    kullanici: async () => ({ plan: 'ultimate', email: 'kisi@ornek.com' }),
    aramaBitti: async (id, x) => { c.aramaBitti.push([id, x]); },
    ilanlariEkle: async (id, s) => { c.ilanlariEkle.push([id, s]); return s.length; },
    ayarYaz: async (id, a) => { c.ayarYaz.push([id, a]); },
    ozetIlanlari: async () => [{ id: 'i1', baslik: 'Data Analyst', sirket: 'Acme', konum: 'Toronto, ON', uygunluk: 70 }],
    ozetIsaretle: async (id, ids, t) => { c.ozetIsaretle.push([id, ids, t]); },
    siradakiler: async () => [AYAR],
    ...ek,
  };
}
const JOBS = [
  { title: 'Data Analyst', company: 'Acme', location: 'Toronto, ON', link: 'https://x.test/1', source: 'Adzuna', konum_kademe: 'sehir', description: 'SQL' },
  { title: 'Data Analyst', company: 'ACME', location: 'Toronto ON', link: 'https://y.test/2', source: 'Lever', konum_kademe: 'sehir' },   // ayni ilan
  { title: 'Pricing Analyst', company: 'B', location: 'Mississauga, ON', link: 'javascript:alert(1)', source: 'Adzuna', konum_kademe: 'bolge' },
];
const araSahte = (kayit, sonuc) => async (o) => { kayit.push(o); return sonuc || { jobs: JOBS, sources: [{ key: 'adzuna', status: 'found' }] }; };

beforeEach(() => Z._sifirla());

test('Z1: Ultimate kullanici: arama, puanli ve tekil satirlar, 12 saat sonra yeniden', async () => {
  const d = sahteDepo(); const cagri = [];
  const r = await Z.kullaniciTara(AYAR, { depo: d, ara: araSahte(cagri), simdi: SIMDI, env: ENV });
  assert.deepStrictEqual(r, { durum: 'arandi', eklenen: 2, adzuna: true });
  assert.strictEqual(cagri[0].keywords, 'data analyst');
  assert.strictEqual(cagri[0].kullaniciKonumu, 'Toronto, ON');
  assert.strictEqual(cagri[0].uzaklariGoster, false);
  assert.deepStrictEqual(cagri[0].ekSirketler, AYAR.sirketler);
  assert.deepStrictEqual(cagri[0].sources.sort(), ['adzuna', 'sirketler']);
  const [id, satirlar] = d.c.ilanlariEkle[0];
  assert.strictEqual(id, 'u1');
  assert.deepStrictEqual(satirlar.map((s) => s.ilan_anahtari), ['data analyst|acme|toronto on', 'pricing analyst|b|mississauga on']);
  assert.strictEqual(satirlar[0].uygunluk, 45 + 15 + 25, 'baslik tam, bir beceri (SQL aciklamada), sehir');
  assert.strictEqual(satirlar[1].link, '', 'javascript: baglantisi yazilmadi');
  assert.deepStrictEqual(d.c.aramaBitti[0], ['u1', { son_arama: SIMDI, sonraki_arama: new Date(+SIMDI + 12 * 3600e3) }]);
});

test('Z2: Ultimate degilse arama yok, 12 saat sonra yeniden bakilir; anahtar yoksa arama yok', async () => {
  for (const plan of ['free', 'pro']) {
    const d = sahteDepo({ kullanici: async () => ({ plan, email: 'x@y.z' }) }); const cagri = [];
    assert.deepStrictEqual(await Z.kullaniciTara(AYAR, { depo: d, ara: araSahte(cagri), simdi: SIMDI, env: ENV }), { durum: 'plan' });
    assert.strictEqual(cagri.length, 0);
    assert.deepStrictEqual(d.c.aramaBitti[0], ['u1', { sonraki_arama: new Date(+SIMDI + Z.ARALIK_MS) }]);
  }
  const d = sahteDepo(); const cagri = [];
  assert.strictEqual((await Z.kullaniciTara({ ...AYAR, anahtar_kelime: '  ' }, { depo: d, ara: araSahte(cagri), simdi: SIMDI, env: ENV })).durum, 'anahtar_yok');
  assert.strictEqual(cagri.length, 0);
  const y = sahteDepo({ kullanici: async () => null });
  assert.strictEqual((await Z.kullaniciTara(AYAR, { depo: y, ara: araSahte([]), simdi: SIMDI, env: ENV })).durum, 'hesap_yok');
  assert.strictEqual(y.c.ayarYaz.length, 0, 'olmayan hesap icin satir olusturulmaz');
});

test('Z3: hata: butun kaynaklar dusunce ya da arama atinca 1 saat sonra; hata atmiyor', async () => {
  const d = sahteDepo();
  const r = await Z.kullaniciTara(AYAR, { depo: d, ara: araSahte([], { jobs: [], sources: [{ key: 'adzuna', status: 'error' }, { key: 'sirketler', status: 'error' }] }), simdi: SIMDI, env: ENV });
  assert.strictEqual(r.durum, 'hata');
  assert.match(r.hata, /adzuna error/);
  assert.strictEqual(d.c.ilanlariEkle.length, 0);
  assert.deepStrictEqual(d.c.aramaBitti[0][1].sonraki_arama, new Date(+SIMDI + Z.HATA_BEKLE_MS));
  const d2 = sahteDepo();
  const r2 = await Z.kullaniciTara(AYAR, { depo: d2, ara: async () => { throw new Error('ag'); }, simdi: SIMDI, env: ENV });
  assert.deepStrictEqual(r2, { durum: 'hata', hata: 'ag' });
  // bir kaynak calistiysa "0 ilan" normal
  const d3 = sahteDepo();
  const r3 = await Z.kullaniciTara(AYAR, { depo: d3, ara: araSahte([], { jobs: [], sources: [{ key: 'adzuna', status: 'error' }, { key: 'sirketler', status: 'none' }] }), simdi: SIMDI, env: ENV });
  assert.deepStrictEqual(r3, { durum: 'arandi', eklenen: 0, adzuna: true });
});

test('Z4: Adzuna gunluk tavani: dolunca yalnizca sirket panolari; ertesi gun sifirlanir', async () => {
  const env = { ...ENV, BOT_ADZUNA_GUNLUK: '2' };
  const cagri = [];
  for (let i = 0; i < 3; i++) await Z.kullaniciTara(AYAR, { depo: sahteDepo(), ara: araSahte(cagri), simdi: SIMDI, env });
  assert.deepStrictEqual(cagri.map((c) => c.sources.includes('adzuna')), [true, true, false]);
  assert.ok(cagri[2].sources.includes('sirketler'));
  await Z.kullaniciTara(AYAR, { depo: sahteDepo(), ara: araSahte(cagri), simdi: new Date('2026-10-01T00:05:00Z'), env });
  assert.ok(cagri[3].sources.includes('adzuna'), 'yeni gunde sayac sifirlanmadi');
  // Adzuna anahtari yoksa hic istenmez ve sayilmaz
  const c2 = [];
  const r = await Z.kullaniciTara(AYAR, { depo: sahteDepo(), ara: araSahte(c2), simdi: SIMDI, env: {} });
  assert.deepStrictEqual(c2[0].sources, ['sirketler']);
  assert.strictEqual(r.adzuna, false);
});

test('Z5: ozet: gonderilir, isaretlenir, kapatma baglantisi ve tek tik basligi var', async () => {
  const d = sahteDepo(); const giden = [];
  const r = await Z.ozetGonder(AYAR, { depo: d, postaGonder: async (m) => { giden.push(m); return { ok: true }; }, simdi: SIMDI, env: ENV });
  assert.deepStrictEqual(r, { durum: 'gonderildi', adet: 1 });
  assert.strictEqual(giden[0].to, 'kisi@ornek.com');
  assert.match(giden[0].subject, /^1 new job match for "data analyst"$/);
  const link = imza.kapatmaLinki('u1', 'bot_ozet', ENV);
  assert.ok(giden[0].text.includes(link) && giden[0].html.includes(link.replace(/&/g, '&amp;')));
  assert.deepStrictEqual(giden[0].headers, { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  assert.deepStrictEqual(d.c.ozetIsaretle[0], ['u1', ['i1'], SIMDI]);
});

test('Z6: ozet gonderilmez: kapali, 24 saat dolmadi, yeni ilan yok, adres yok; gonderim basarisizsa isaretlenmez', async () => {
  const gonder = async () => ({ ok: true });
  const r = (ayar, ek, pg = gonder) => Z.ozetGonder(ayar, { depo: sahteDepo(ek), postaGonder: pg, simdi: SIMDI, env: ENV });
  assert.strictEqual((await r({ ...AYAR, eposta_ozet: false })).durum, 'kapali');
  assert.strictEqual((await r({ ...AYAR, son_eposta: new Date(+SIMDI - 23.9 * 3600e3).toISOString() })).durum, 'erken');
  assert.strictEqual((await r({ ...AYAR, son_eposta: new Date(+SIMDI - 24 * 3600e3).toISOString() })).durum, 'gonderildi', 'tam 24 saat');
  assert.strictEqual((await r(AYAR, { ozetIlanlari: async () => [] })).durum, 'bos');
  assert.strictEqual((await r(AYAR, { kullanici: async () => ({ plan: 'ultimate', email: '' }) })).durum, 'adres_yok');
  const d = sahteDepo();
  const x = await Z.ozetGonder(AYAR, { depo: d, postaGonder: async () => ({ ok: false, error: 'rate' }), simdi: SIMDI, env: ENV });
  assert.deepStrictEqual(x, { durum: 'gonderilemedi', hata: 'rate' });
  assert.strictEqual(d.c.ozetIsaretle.length, 0, 'gitmeyen e-posta gitti sayildi');
});

test('Z7: e-posta gunluk tavani', async () => {
  const env = { ...ENV, BOT_EPOSTA_GUNLUK: '1' };
  const pg = async () => ({ ok: true });
  assert.strictEqual((await Z.ozetGonder(AYAR, { depo: sahteDepo(), postaGonder: pg, simdi: SIMDI, env })).durum, 'gonderildi');
  assert.strictEqual((await Z.ozetGonder({ ...AYAR, user_id: 'u2' }, { depo: sahteDepo(), postaGonder: pg, simdi: SIMDI, env })).durum, 'tavan');
});

test('Z8: tur: arandiysa ozet, degilse ozet yok; kullanici bir kez okunur', async () => {
  let okuma = 0;
  const d = sahteDepo({
    siradakiler: async (t, n) => { assert.strictEqual(n, Z.TUR_BASINA); return [AYAR, { ...AYAR, user_id: 'u2' }]; },
    kullanici: async (id) => { okuma++; return id === 'u1' ? { plan: 'ultimate', email: 'a@b.co' } : { plan: 'free', email: 'c@d.co' }; },
  });
  const giden = [];
  const log = { info() {}, warn() {} };
  const s = await Z.turCalistir({ depo: d, ara: araSahte([]), postaGonder: async (m) => { giden.push(m); return { ok: true }; }, simdi: SIMDI, env: ENV, log });
  assert.deepStrictEqual(s.map((x) => [x.user_id, x.tara.durum, x.ozet.durum]), [['u1', 'arandi', 'gonderildi'], ['u2', 'plan', 'atlandi']]);
  assert.strictEqual(giden.length, 1);
  assert.strictEqual(okuma, 2, 'kullanici her biri icin bir kez okunmali');
});

test('Z9: zamanlayici: kapali ya da Supabase yoksa baslamaz', () => {
  assert.strictEqual(Z.zamanlayiciBaslat({}, { env: { BOT_ZAMANLAYICI: 'kapali', SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'y' } }), null);
  assert.strictEqual(Z.zamanlayiciBaslat({}, { env: {} }), null);
  const t = Z.zamanlayiciBaslat({}, { env: { SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'y' }, depo: sahteDepo(), postaGonder: async () => ({ ok: true }) });
  assert.ok(t); clearInterval(t);
  assert.strictEqual(Z.TUR_MS, 15 * 60 * 1000);
  assert.strictEqual(Z.ARALIK_MS, 12 * 3600 * 1000);
  assert.strictEqual(Z.OZET_ARALIK_MS, 24 * 3600 * 1000);
});

test('Z10: ilan anahtari baslik+sirket+konum, bos ilan atlanir', () => {
  assert.strictEqual(Z.ilanAnahtari({ title: 'Data Analyst', company: 'Acme Inc.', location: 'Toronto, ON' }), 'data analyst|acme inc|toronto on');
  assert.strictEqual(Z.ilanAnahtari({ title: 'Data Analyst' }), 'data analyst');
  assert.strictEqual(Z.ilanAnahtari({}), null);
  assert.ok(Z.ilanAnahtari({ title: 'x'.repeat(500), company: 'y'.repeat(500), location: 'z'.repeat(500) }).length <= 200);
  assert.deepStrictEqual(Z.satirlaraCevir([{}, { title: '' }], AYAR), []);
});

// ── Ozet icerigi ────────────────────────────────────────────────────────────
test('O1: ilk 10 gosterilir, kalani sayi; HTML kacisli; puan yok; baglanti yoksa satir yok', () => {
  const ilanlar = Array.from({ length: 13 }, (_, i) => ({ baslik: `Job ${i + 1}`, sirket: 'Co', konum: 'X', uygunluk: 93 }));
  ilanlar[0].baslik = '<img src=x onerror=alert(1)>';
  const e = ozetIcerigi({ ilanlar, anahtar: 'qa "lead"\r\nBcc: x@y.z', kapatmaLinki: 'https://a.test/k?u=1&t=2', appUrl: 'https://app.test/' });
  assert.strictEqual(GOSTERILEN, 10);
  assert.ok(!/[\r\n]/.test(e.subject), 'konu satirinda satir sonu');
  assert.ok(e.html.includes('&lt;img src=x onerror=alert(1)&gt;') && !e.html.includes('<img'));
  assert.ok(e.text.includes('+ 3 more') && e.html.includes('+ 3 more'));
  assert.ok(e.text.includes('10. Job 10') && !e.text.includes('Job 11'));
  assert.ok(!/93/.test(e.text) && !/93/.test(e.html), 'puan gosterilmemeli');
  assert.ok(e.html.includes('href="https://app.test/dashboard"'));
  assert.ok(e.html.includes('href="https://a.test/k?u=1&amp;t=2"'));
  assert.ok(!/—/.test(e.text + e.html), 'uzun tire');
  const b = ozetIcerigi({ ilanlar: ilanlar.slice(0, 1), anahtar: '', kapatmaLinki: null, appUrl: 'https://app.test' });
  assert.strictEqual(b.subject, '1 new job match');
  assert.ok(!/Turn off/.test(b.text) && !/Turn off/.test(b.html));
  assert.ok(!/more on your bot page/.test(b.text));
});

// ── Rotalar ─────────────────────────────────────────────────────────────────
const UID = '11111111-2222-4333-8444-555555555555';
async function uygulama(kullanici, depoEk = {}) {
  const yolA = require.resolve('./middleware/auth');
  const gercek = require('./middleware/auth');
  const eskiA = require.cache[yolA];
  require.cache[yolA] = { id: yolA, filename: yolA, loaded: true, exports: { ...gercek, requireAuth: async (q) => { q.user = kullanici; } } };
  const yazilan = [];
  const eski = {};
  const sahte = { ayarOku: async () => null, ayarYaz: async (id, a) => { yazilan.push([id, a]); return { user_id: id, ...a }; }, epostaKapat: async (id) => { yazilan.push(['kapat', id]); }, ...depoEk };
  for (const k of Object.keys(sahte)) { eski[k] = depo[k]; depo[k] = sahte[k]; }
  delete require.cache[require.resolve('./routes/bot')];
  const app = require('fastify')({ logger: false });
  await app.register(require('./routes/bot'), { prefix: '/api/v1/bot' });
  await app.ready();
  const bitir = async () => {
    await app.close();
    for (const k of Object.keys(eski)) depo[k] = eski[k];
    if (eskiA) require.cache[yolA] = eskiA; else delete require.cache[yolA];
    delete require.cache[require.resolve('./routes/bot')];
  };
  return { app, yazilan, bitir };
}
const kisi = (plan) => ({ id: UID, app_metadata: { plan } });

test('Y1: POST ayarlar yalnizca Ultimate; kisisel alanlar yazilmiyor; ilk acilista hemen arama', async () => {
  const pro = await uygulama(kisi('pro'));
  const r = await pro.app.inject({ method: 'POST', url: '/api/v1/bot/ayarlar', payload: { aktif: true, anahtar_kelime: 'qa' } });
  assert.strictEqual(r.statusCode, 402);
  assert.strictEqual(pro.yazilan.length, 0);
  await pro.bitir();

  const u = await uygulama(kisi('ultimate'));
  const once = Date.now();
  const y = await u.app.inject({ method: 'POST', url: '/api/v1/bot/ayarlar', payload: {
    aktif: true, anahtar_kelime: 'data analyst', konum: 'Toronto, ON', profil: { unvan: 'Analyst', telefon: '6045550199', beceriler: ['SQL', 'x@y.co'] }, user_id: 'baskasi', eposta: 'a@b.c' } });
  assert.strictEqual(y.statusCode, 200);
  const [id, alan] = u.yazilan[0];
  assert.strictEqual(id, UID);
  assert.deepStrictEqual(Object.keys(alan).sort(), ['aktif', 'anahtar_kelime', 'konum', 'profil', 'sonraki_arama']);
  assert.deepStrictEqual(alan.profil, { unvan: 'Analyst', beceriler: ['SQL'] });
  assert.ok(Date.parse(alan.sonraki_arama) >= once - 1000 && Date.parse(alan.sonraki_arama) <= Date.now() + 1000);
  assert.ok(!('user_id' in y.json().ayarlar), 'cevapta user_id');
  await u.bitir();
});

test('Y2: dogrulama: konumda rakam 422, anahtarsiz acma 422; kapatma anahtar istemez', async () => {
  const u = await uygulama(kisi('ultimate'));
  const k = await u.app.inject({ method: 'POST', url: '/api/v1/bot/ayarlar', payload: { konum: '12 Main St' } });
  assert.deepStrictEqual([k.statusCode, k.json().kod], [422, BOT.KONUM_BOLGE]);
  const a = await u.app.inject({ method: 'POST', url: '/api/v1/bot/ayarlar', payload: { aktif: true } });
  assert.deepStrictEqual([a.statusCode, a.json().kod], [422, BOT.ANAHTAR_BOS]);
  const kapa = await u.app.inject({ method: 'POST', url: '/api/v1/bot/ayarlar', payload: { aktif: false } });
  assert.strictEqual(kapa.statusCode, 200);
  assert.deepStrictEqual(u.yazilan[0][1], { aktif: false }, 'kapatirken arama zamani kurulmamali');
  await u.bitir();
});

test('Y3: sonraki arama: degisiklik yoksa dokunulmaz; degisince en erken son aramadan 1 saat sonra', async () => {
  const { sonrakiArama } = require('./routes/bot');
  const simdi = new Date('2026-09-30T12:00:00Z');
  const once = { aktif: true, anahtar_kelime: 'qa', konum: 'Toronto', sirketler: [], sonraki_arama: '2026-09-30T20:00:00Z', son_arama: '2026-09-30T11:30:00Z' };
  assert.strictEqual(sonrakiArama(once, { eposta_ozet: false }, simdi), undefined);
  assert.strictEqual(sonrakiArama(once, { anahtar_kelime: 'qa' }, simdi), undefined, 'ayni deger');
  assert.strictEqual(sonrakiArama(once, { profil: { unvan: 'x' } }, simdi), undefined, 'profil aramayi degistirmez');
  assert.strictEqual(sonrakiArama(once, { anahtar_kelime: 'dev' }, simdi), '2026-09-30T12:30:00.000Z');
  assert.strictEqual(sonrakiArama({ ...once, son_arama: '2026-09-30T08:00:00Z' }, { konum: 'X' }, simdi), '2026-09-30T12:00:00.000Z');
  assert.strictEqual(sonrakiArama({ ...once, aktif: false }, { aktif: true }, simdi), '2026-09-30T12:30:00.000Z', 'kapat-ac kotayi yemez');
  assert.strictEqual(sonrakiArama(null, { aktif: true }, simdi), '2026-09-30T12:00:00.000Z');
  assert.strictEqual(sonrakiArama(once, { aktif: false, anahtar_kelime: 'z' }, simdi), undefined);
  assert.strictEqual(sonrakiArama({ ...once, sonraki_arama: null, son_arama: null }, {}, simdi), '2026-09-30T12:00:00.000Z');
});

test('Y4: GET ayarlar: plan bilgisi; tablo okunamazsa 503 kodla', async () => {
  const u = await uygulama(kisi('pro'), { ayarOku: async () => ({ user_id: UID, aktif: true, anahtar_kelime: 'qa', profil: {} }) });
  const r = await u.app.inject({ method: 'GET', url: '/api/v1/bot/ayarlar' });
  assert.strictEqual(r.json().plan_uygun, false);
  assert.strictEqual(r.json().ayarlar.anahtar_kelime, 'qa');
  assert.strictEqual(r.json().ayarlar.son_eposta, null);
  await u.bitir();
  const h = await uygulama(kisi('ultimate'), { ayarOku: async () => { throw new Error('x'); } });
  const r2 = await h.app.inject({ method: 'GET', url: '/api/v1/bot/ayarlar' });
  assert.deepStrictEqual([r2.statusCode, r2.json().kod], [503, BOT.KAYDEDILEMEDI]);
  await h.bitir();
});

test('Y5: e-posta kapatma: GET durumu degistirmez; POST imzayla kapatir; yanlis imza 400', async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY_ESKI = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-gizli';
  try {
    const u = await uygulama(null);
    const t = imza.imzala(UID, 'bot_ozet');
    const g = await u.app.inject({ method: 'GET', url: `/api/v1/bot/eposta-kapat?u=${UID}&t=${t}` });
    assert.strictEqual(g.statusCode, 200);
    assert.match(g.headers['content-type'], /text\/html/);
    assert.match(g.body, /<form method="post" action="\?u=11111111-2222-4333-8444-555555555555&amp;t=/);
    assert.strictEqual(u.yazilan.length, 0, 'GET kapatti (tarayici on-acmasi e-postayi kapatirdi)');
    const p = await u.app.inject({ method: 'POST', url: `/api/v1/bot/eposta-kapat?u=${UID}&t=${t}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    assert.strictEqual(p.statusCode, 200);
    assert.deepStrictEqual(u.yazilan, [['kapat', UID]]);
    const bos = await u.app.inject({ method: 'POST', url: `/api/v1/bot/eposta-kapat?u=${UID}&t=${t}` });
    assert.strictEqual(bos.statusCode, 200, 'govdesiz form');
    for (const q of [`u=${UID}&t=yanlis`, `u=baska&t=${t}`, `t=${t}`, `u=${UID}`, `u=${UID}&t=${imza.imzala(UID, 'kampanya')}`,
      `u=baska&t=${imza.imzala('baska', 'bot_ozet')}`]) {   // imza gecerli ama kimlik uuid degil
      const x = await u.app.inject({ method: 'POST', url: `/api/v1/bot/eposta-kapat?${q}` });
      assert.strictEqual(x.statusCode, 400, q);
    }
    assert.strictEqual(u.yazilan.length, 2);
    const ks = await u.app.inject({ method: 'GET', url: `/api/v1/bot/eposta-kapat?u=${UID}&t=%3Cscript%3E` });
    assert.ok(!ks.body.includes('<script>'));
    await u.bitir();
  } finally {
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY_ESKI;
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY_ESKI;
  }
});

test('Y6: index.js rotayi ve zamanlayiciyi bagliyor; hata kodlari disa acik', () => {
  const src = require('fs').readFileSync(require.resolve('./index.js'), 'utf8');
  assert.match(src, /app\.register\(botRoutes,\s*\{ prefix: '\/api\/v1\/bot' \}\)/);
  assert.match(src, /require\('\.\/lib\/bot-zamanlayici'\)\.zamanlayiciBaslat\(app\.log\)/);
  assert.deepStrictEqual(require('./lib/hata-kodlari').BOT_KODLARI.sort(), ['bot_anahtar_bos', 'bot_kaydedilemedi', 'bot_konum_bolge']);
});
