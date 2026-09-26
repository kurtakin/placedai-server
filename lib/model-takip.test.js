/**
 * lib/model-takip.test.js — Model takibi (26 Eylul 2026, model yonetimi adim 2, K60).
 *
 * Calistir: node --test "*.test.js" "lib/*.test.js" "middleware/*.test.js"
 *
 * Saglayici listeleri sahte fetch ile veriliyor; gercek anahtar ya da ag yok.
 * Test verisi bilerek varsayilanlardan farkli: kullanilan kimlikler ortam
 * degiskenleriyle degistiriliyor ki kod kimligi ezbere bilmesin.
 */

const { test } = require('node:test');
const assert   = require('node:assert');

const T = require('./model-takip');

const ORTAM = {
  MODEL_HIZLI: 'claude-haiku-7-1', MODEL_GUCLU: 'claude-sonnet-7-2',
  MODEL_GPT_HIZLI: 'gpt-4o-mini', MODEL_GPT_GUCLU: 'gpt-4o',
  REALTIME_STT_MODEL: 'gpt-4o-transcribe', MOCK_TTS_MODEL: 'gpt-4o-mini-tts', GROQ_MODEL: null,
};
function ortamla(degiskenler, fn) {
  const eski = {};
  for (const [k, v] of Object.entries(degiskenler)) { eski[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  const geri = () => { for (const [k, v] of Object.entries(eski)) { if (v == null) delete process.env[k]; else process.env[k] = v; } };
  return Promise.resolve().then(fn).finally(geri);
}

const gun = (s) => new Date(s + 'T00:00:00Z');
const ANTHROPIC = [
  { id: 'claude-haiku-7-1', created_at: '2027-01-10T00:00:00Z' },
  { id: 'claude-haiku-7-5', created_at: '2027-06-01T00:00:00Z' },   // daha yeni haiku: ADAY
  { id: 'claude-haiku-6-0', created_at: '2026-01-01T00:00:00Z' },   // eski: aday degil
  { id: 'claude-opus-8-0', created_at: '2027-08-01T00:00:00Z' },    // baska katman: aday degil
  // claude-sonnet-7-2 LISTEDE YOK
  { id: 'claude-sonnet-7-0', created_at: '2026-12-01T00:00:00Z' },
];
const u = (s) => Math.floor(gun(s).getTime() / 1000);
const OPENAI = [
  { id: 'gpt-4o-mini', created: u('2024-07-18') },
  { id: 'gpt-4o', created: u('2024-05-13') },
  { id: 'gpt-4.1', created: u('2025-04-14') },
  { id: 'gpt-4.1-mini', created: u('2025-04-14') },
  { id: 'gpt-5-mini', created: u('2025-08-07') },             // gpt-4o-mini icin ADAY
  { id: 'gpt-5', created: u('2025-08-07') },                  // boy farkli: mini icin aday degil
  { id: 'gpt-4o-mini-2024-07-18', created: u('2024-07-18') },
  { id: 'gpt-5-mini-2025-08-07', created: u('2025-08-07') },  // tarihli kopya: aday degil
  { id: 'gpt-6-mini-preview', created: u('2026-05-01') },     // preview: aday degil
  { id: 'gpt-4o-mini-tts', created: u('2025-03-20') },
  { id: 'gpt-5-mini-tts', created: u('2026-02-01') },         // tts icin ADAY, mini metin icin degil
  { id: 'gpt-4o-transcribe', created: u('2025-03-20') },
  { id: 'whisper-1', created: u('2023-02-27') },
];
const GROQ = [{ id: 'whisper-large-v3-turbo', created: u('2024-10-01') }];

function sahteFetch(ozel = {}) {
  const cagri = [];
  const fn = async (url, secenek) => {
    cagri.push({ url, basliklar: secenek.headers });
    const yanit = (govde, durum = 200) => ({ ok: durum < 400, status: durum, json: async () => govde });
    if (url.startsWith('https://api.anthropic.com/v1/models')) {
      if (ozel.anthropic) return ozel.anthropic(url);
      return yanit({ data: ANTHROPIC, has_more: false });
    }
    if (url === 'https://api.openai.com/v1/models') return ozel.openai ? ozel.openai() : yanit({ data: OPENAI });
    if (url === 'https://api.groq.com/openai/v1/models') return yanit({ data: GROQ });
    throw new Error('beklenmeyen adres ' + url);
  };
  fn.cagri = cagri;
  return fn;
}
const ANAHTARLAR = { ANTHROPIC_API_KEY: 'a-test', OPENAI_API_KEY: 'o-test', GROQ_API_KEY: 'g-test' };
const satir = (r, gorev) => r.kullanilan.find((k) => k.gorev === gorev);

test('T1: kullanilan model listede yoksa bulgu; olanlar "var"', () => ortamla(ORTAM, async () => {
  const r = await T.raporOlustur({ fetchFn: sahteFetch(), env: ANAHTARLAR });
  assert.strictEqual(satir(r, 'claude-sonnet').durum, 'yok');
  assert.strictEqual(satir(r, 'claude-haiku').durum, 'var');
  assert.strictEqual(satir(r, 'yedek_ses_yazma').durum, 'var');
  assert.strictEqual(satir(r, 'groq_ses_yazma').durum, 'var');
  const b = r.bulgular.find((x) => x.includes('claude-sonnet-7-2'));
  assert.ok(b && /YOK/.test(b) && /MODEL_GUCLU/.test(b), b);
}));

test('T2: Anthropic adayi yalnizca ayni katmanda ve daha yeni', () => ortamla(ORTAM, async () => {
  const r = await T.raporOlustur({ fetchFn: sahteFetch(), env: ANAHTARLAR });
  assert.deepStrictEqual(satir(r, 'claude-haiku').adaylar, [{ kimlik: 'claude-haiku-7-5', tarih: '2027-06-01' }]);
  // listede olmayan kullanilan modelin esigi bilinmiyor: aday uydurulmuyor
  assert.deepStrictEqual(satir(r, 'claude-sonnet').adaylar, []);
}));

test('T3: OpenAI ailesi hat+boy+tur; tarihli kopya ve preview aday degil', () => ortamla(ORTAM, async () => {
  const r = await T.raporOlustur({ fetchFn: sahteFetch(), env: ANAHTARLAR });
  assert.deepStrictEqual(satir(r, 'gpt-4o-mini').adaylar.map((a) => a.kimlik), ['gpt-5-mini']);
  assert.deepStrictEqual(satir(r, 'seslendirme').adaylar.map((a) => a.kimlik), ['gpt-5-mini-tts']);
  // gpt-4.1 daha yeni ama zaten kullaniliyor (Ayarlar secicisi): aday degil
  assert.deepStrictEqual(satir(r, 'gpt-4o').adaylar.map((a) => a.kimlik), ['gpt-5']);
  assert.deepStrictEqual(satir(r, 'ses_tanima').adaylar, []);
  const b = r.bulgular.find((x) => x.startsWith('gpt-4o-mini:'));
  assert.ok(b && /gpt-5-mini \(2025-08-07\)/.test(b) && /MODEL_GPT_HIZLI/.test(b), b);
}));

test('T4: anahtar yoksa "bilinmiyor", bulgu yok; liste hatasi bulgu', () => ortamla(ORTAM, async () => {
  const f = sahteFetch({ openai: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  const r = await T.raporOlustur({ fetchFn: f, env: { OPENAI_API_KEY: 'o-test' } });
  assert.strictEqual(r.saglayicilar.anthropic.durum, 'anahtar_yok');
  assert.strictEqual(satir(r, 'claude-haiku').durum, 'bilinmiyor');
  assert.strictEqual(r.saglayicilar.openai.durum, 'hata');
  assert.strictEqual(satir(r, 'gpt-4o').durum, 'bilinmiyor');
  assert.ok(!r.bulgular.some((b) => /anthropic/.test(b)), 'anahtar yoklugu bulgu sayildi');
  assert.ok(r.bulgular.some((b) => /openai model listesi alinamadi \(HTTP 401\)/.test(b)));
  assert.ok(!f.cagri.some((c) => c.url.includes('anthropic')), 'anahtarsiz saglayiciya istek gitti');
}));

test('T5: Anthropic sayfalari after_id ile geziliyor; anahtar baslikta', () => ortamla(ORTAM, async () => {
  const f = sahteFetch({ anthropic: async (url) => {
    const ikinci = url.includes('after_id=claude-haiku-6-0');
    const d = ikinci ? { data: ANTHROPIC.slice(3), has_more: false } : { data: ANTHROPIC.slice(0, 3), has_more: true, last_id: 'claude-haiku-6-0' };
    return { ok: true, status: 200, json: async () => d };
  } });
  const r = await T.raporOlustur({ fetchFn: f, env: ANAHTARLAR });
  assert.strictEqual(r.saglayicilar.anthropic.adet, 5);
  const a = f.cagri.filter((c) => c.url.includes('anthropic'));
  assert.strictEqual(a.length, 2);
  assert.strictEqual(a[0].basliklar['x-api-key'], 'a-test');
  assert.strictEqual(f.cagri.find((c) => c.url.includes('openai.com')).basliklar.Authorization, 'Bearer o-test');
}));

test('T6: e-posta yalnizca bulgu varsa ve bulgular degistiyse; zorla tekrar gonderir', () => ortamla(ORTAM, async () => {
  T._sifirla();
  const giden = [];
  const mailer = { sendMail: async (m) => { giden.push(m); return { ok: true }; } };
  const s = { fetchFn: sahteFetch(), env: ANAHTARLAR, mailer };
  const r1 = await T.kontrolEt(s);
  assert.strictEqual(r1.posta.gonderildi, true);
  assert.match(giden[0].subject, /model takibi: \d+ bulgu/);
  assert.match(giden[0].text, /claude-sonnet-7-2/);
  assert.match(giden[0].text, /otomatik degismedi/);
  const r2 = await T.kontrolEt(s);
  assert.deepStrictEqual([r2.posta.gonderildi, r2.posta.neden], [false, 'ayni_bulgular']);
  await T.kontrolEt({ ...s, zorla: true });
  assert.strictEqual(giden.length, 2);
  // bulgu yoksa hic gonderilmez: listeler tam olarak kullanilanlardan olusuyor
  T._sifirla();
  const temiz = sahteFetch({
    anthropic: async () => ({ ok: true, status: 200, json: async () => ({ data: [
      { id: 'claude-haiku-7-1', created_at: '2027-01-10T00:00:00Z' }, { id: 'claude-sonnet-7-2', created_at: '2027-02-01T00:00:00Z' }] }) }),
    openai: async () => ({ ok: true, status: 200, json: async () => ({ data: OPENAI.filter((m) => !/^gpt-5|preview|\d{4}-\d{2}-\d{2}$/.test(m.id)) }) }),
  });
  const r4 = await T.kontrolEt({ fetchFn: temiz, env: ANAHTARLAR, mailer });
  assert.deepStrictEqual(r4.rapor.bulgular, []);
  assert.deepStrictEqual([r4.posta.gonderildi, r4.posta.neden], [false, 'bulgu_yok']);
  assert.strictEqual(giden.length, 2);
}));

test('T7: gonderilemeyen e-posta "gonderildi" sayilmaz ve bir dahaki sefere yeniden denenir', () => ortamla(ORTAM, async () => {
  T._sifirla();
  let deneme = 0;
  const mailer = { sendMail: async () => { deneme++; return deneme === 1 ? { ok: false, error: 'yapilandirilmamis' } : { ok: true }; } };
  const s = { fetchFn: sahteFetch(), env: ANAHTARLAR, mailer };
  assert.strictEqual((await T.kontrolEt(s)).posta.gonderildi, false);
  assert.strictEqual((await T.kontrolEt(s)).posta.gonderildi, true);
}));

test('T8: zamanlayici ayin 1i 09 UTC saatinde, gunde bir kez', () => {
  assert.strictEqual(T.zamaniGeldiMi(new Date('2026-10-01T09:20:00Z'), null), true);
  assert.strictEqual(T.zamaniGeldiMi(new Date('2026-10-01T09:20:00Z'), '2026-10-01'), false);
  assert.strictEqual(T.zamaniGeldiMi(new Date('2026-10-01T10:05:00Z'), null), false);
  assert.strictEqual(T.zamaniGeldiMi(new Date('2026-10-02T09:05:00Z'), null), false);
});

test('T9: admin rotasi: admin olmayana 403, admine rapor', async () => {
  let kullanici = { id: 'u-1', app_metadata: { role: 'user' } };
  const yol = require.resolve('../middleware/auth');
  const eski = require.cache[yol];
  require.cache[yol] = { id: yol, filename: yol, loaded: true,
    exports: { requireAuth: async (req) => { req.user = kullanici; } } };
  const tyol = require.resolve('./model-takip');
  const eskiT = require.cache[tyol];
  require.cache[tyol] = { id: tyol, filename: tyol, loaded: true,
    exports: { raporOlustur: async () => ({ bulgular: ['x'] }), kontrolEt: async (s) => ({ zorla: s.zorla }) } };
  delete require.cache[require.resolve('../routes/admin')];
  const Fastify = require('fastify');
  const app = Fastify({ logger: false });
  await app.register(require('../routes/admin'), { prefix: '/api/v1/admin' });
  await app.ready();
  try {
    assert.strictEqual((await app.inject({ method: 'GET', url: '/api/v1/admin/models' })).statusCode, 403);
    assert.strictEqual((await app.inject({ method: 'POST', url: '/api/v1/admin/models/check' })).statusCode, 403);
    kullanici = { id: 'u-1', app_metadata: { role: 'admin' } };
    assert.deepStrictEqual((await app.inject({ method: 'GET', url: '/api/v1/admin/models' })).json(), { bulgular: ['x'] });
    assert.deepStrictEqual((await app.inject({ method: 'POST', url: '/api/v1/admin/models/check' })).json(), { zorla: true });
  } finally {
    await app.close();
    if (eski) require.cache[yol] = eski; else delete require.cache[yol];
    if (eskiT) require.cache[tyol] = eskiT; else delete require.cache[tyol];
    delete require.cache[require.resolve('../routes/admin')];
  }
});

test('T10: aile kurali birim', () => {
  assert.strictEqual(T.aile('anthropic', 'claude-3-5-sonnet-20241022'), 'anthropic|sonnet');
  assert.strictEqual(T.aile('openai', 'gpt-4o-mini'), T.aile('openai', 'gpt-5-mini'));
  assert.notStrictEqual(T.aile('openai', 'gpt-4o-mini'), T.aile('openai', 'gpt-4o-mini-tts'));
  assert.notStrictEqual(T.aile('openai', 'gpt-4o'), T.aile('openai', 'o3'));
  assert.notStrictEqual(T.aile('openai', 'gpt-4o-transcribe'), T.aile('openai', 'gpt-4o-mini-transcribe'));
  // kullanilan kimlik listede yoksa tarih esigi bilinmiyor: aday uydurulmuyor
  assert.deepStrictEqual(T.adaylar('anthropic', 'claude-sonnet-9', [{ id: 'claude-sonnet-10', tarih: 5 }]), []);
});
