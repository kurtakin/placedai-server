/**
 * bildirim-kapatildi.test.js — Kullanıcının başvurusu operatörün kutusuna gitmez.
 *
 * Calistir: node --test "*.test.js" "lib/*.test.js" "middleware/*.test.js"
 *
 * NEDEN VAR. 23 Eylul 2026'da olculdu (K52). Basvuru Takibi'ndeki
 * "Add & Send Email" dugmesi e-postayi KULLANICIYA degil sunucunun TEK
 * adresine gonderiyordu:
 *
 *     mailer.js  toAddress() = NOTIFY_EMAIL || GMAIL_USER
 *
 * Yani HER kullanicinin her basvurusu, NOTLARI dahil, operatorun gelen
 * kutusuna gidiyordu. Uc ek kusur:
 *   - /notify-apply ve /email-status KIMLIK DOGRULAMASIZ ve HIZ SINIRSIZDI
 *   - /email-status `notify_to` alanini MASKESIZ donuyordu; sayfa bunu her
 *     ziyaretciye gosteriyordu
 *   - e-posta HTML'i kacissizdi (K47'nin sunucu tarafi kopyasi)
 *
 * Karar: ozellik ucretsiz testten once KAPATILDI. Bu dosya iki seyi kilitler:
 * uclarin GERCEKTEN kapali oldugunu (istek atilarak) ve bir gun yeniden
 * kurulacak sablonun kacisli kaldigini (e-posta GERCEKTEN uretilerek).
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const TOOLS = fs.readFileSync(path.join(__dirname, 'routes', 'tools.js'), 'utf8');

async function uygulama() {
  const Fastify = require('fastify');
  const app = Fastify({ logger: false });
  await app.register(require('./routes/tools'), { prefix: '/api/v1/tools' });
  await app.ready();
  return app;
}

// ── A: uclar kapali ────────────────────────────────────────────────────────

test('A1: /notify-apply ARTIK YOK', async () => {
  const app = await uygulama();
  try {
    const r = await app.inject({ method: 'POST', url: '/api/v1/tools/notify-apply',
      payload: { company: 'X', role: 'Y', notes: 'maas beklentisi' } });
    assert.strictEqual(r.statusCode, 404, `uc hala yanit veriyor: ${r.statusCode}`);
  } finally { await app.close(); }
});

test('A2: /email-status ARTIK YOK', async () => {
  const app = await uygulama();
  try {
    const r = await app.inject({ method: 'GET', url: '/api/v1/tools/email-status' });
    assert.strictEqual(r.statusCode, 404, `uc hala yanit veriyor: ${r.statusCode}`);
  } finally { await app.close(); }
});

test('A3: KOMSU uc hala calisiyor (kapsam denetimi)', async () => {
  // A1 ve A2 404 aliyor; eklenti hic yuklenmese de 404 alirdi. Ayni
  // eklentideki baska bir ucun YANIT VERDIGI olculmeli, yoksa "kapattim" ile
  // "hicbir sey calismiyor" ayni sonucu verir.
  const app = await uygulama();
  try {
    const r = await app.inject({ method: 'POST', url: '/api/v1/tools/export-excel',
      payload: { applications: [] } });
    assert.notStrictEqual(r.statusCode, 404, 'eklenti yuklenmemis, A1/A2 anlamsiz');
  } finally { await app.close(); }
});

test('A4: kaynakta operatore giden bildirim cagrisi KALMADI', () => {
  const kod = TOOLS.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
  assert.ok(!/sendApplicationNotification/.test(kod), 'bildirim islevi hala cagriliyor');
  assert.ok(!/notify_to/.test(kod), 'operator adresi hala bir yanitta');
  assert.ok(!/['"]\/notify-apply['"]/.test(kod), 'rota tanimi duruyor');
  assert.ok(!/['"]\/email-status['"]/.test(kod), 'rota tanimi duruyor');
});

// ── B: sablon kacisli (ozellik yeniden kurulursa) ──────────────────────────

async function epostaUret(app) {
  const eski = { key: process.env.RESEND_API_KEY, fetch: global.fetch };
  let govde = null;
  process.env.RESEND_API_KEY = 'test';
  global.fetch = async (_u, o) => {
    govde = JSON.parse(o.body);
    return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
  };
  try {
    delete require.cache[require.resolve('./lib/mailer')];
    const m = require('./lib/mailer');
    const r = await m.sendApplicationNotification(app);
    assert.ok(r.ok, 'e-posta uretilemedi, test anlamsiz');
    assert.ok(govde && govde.html, 'e-posta govdesi yakalanmadi');
    return govde;
  } finally {
    if (eski.key == null) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = eski.key;
    global.fetch = eski.fetch;
  }
}

test('B1: her alan AYRI AYRI kacisli', async () => {
  // Alan alan: birinde unutulsa oburleri testi ayakta tutardi.
  const alanlar = ['company', 'role', 'notes', 'date', 'status'];
  for (const alan of alanlar) {
    const g = await epostaUret({ company: 'A', role: 'B', [alan]: '<img src=x onerror=alert(1)>' });
    assert.ok(!/<img[\s>]/.test(g.html), `${alan}: gercek <img> etiketi uretildi`);
    assert.match(g.html, /&lt;img src=x onerror=alert\(1\)&gt;/, `${alan}: kacisli hali yok`);
  }
});

test('B2: javascript: adresi baglanti olarak YAZILMIYOR', async () => {
  const g = await epostaUret({ company: 'A', role: 'B', url: 'javascript:alert(1)' });
  assert.ok(!/href="javascript/i.test(g.html), 'javascript: href uretildi');
  assert.ok(!g.html.includes('İlan</td>'), 'reddedilen adres icin satir cizildi');
});

test('B3: gecerli adres baglanti olarak yaziliyor (kapsam denetimi)', async () => {
  const g = await epostaUret({ company: 'A', role: 'B', url: 'linkedin.com/jobs/1' });
  assert.match(g.html, /href="https:\/\/linkedin\.com\/jobs\/1"/, 'gecerli adres cizilmedi');
});

test('B4: konu satirinda satir sonu YOK (baslik enjeksiyonu)', async () => {
  const g = await epostaUret({ company: 'A', role: 'B\r\nBcc: kotu@ornek.com' });
  assert.ok(!/[\r\n]/.test(g.subject), `konuda satir sonu var: ${JSON.stringify(g.subject)}`);
});

test('B5: hata raporlama e-postasi ETKILENMEDI', () => {
  // mailer'in diger kullanicisi lib/errors.js: operatore HATA raporu
  // gonderiyor, bu mesru. Kaldirilan yalnizca basvuru bildirimi.
  const errors = fs.readFileSync(path.join(__dirname, 'lib', 'errors.js'), 'utf8');
  assert.match(errors, /require\('\.\/mailer'\)/, 'hata raporlama mailer\'dan kopmus');
  const m = require('./lib/mailer');
  assert.strictEqual(typeof m.sendMail, 'function', 'sendMail kaldirilmis');
  assert.strictEqual(typeof m.isConfigured, 'function', 'isConfigured kaldirilmis');
});
