/**
 * onay.test.js — Online Assessment onayi sunucuda KAYITLI (K56).
 *
 * Calistir: node --test "*.test.js" "lib/*.test.js" "middleware/*.test.js"
 *
 * Kullanicinin karari (B): "uyariyi okudum; gercek sinav sirasinda ya da
 * baskalarini yaniltmak icin kullanirsam sorumluluk bana aittir" onayi
 * tarayicida degil veritabaninda tutuluyor, ve bolum onaysiz CALISMIYOR.
 * Kapi istemcide degil sunucuda: kutu atlanarak uca dogrudan istek atilsa da
 * ret burada. Tablo okunamazsa kapi KAPALI kalir.
 *
 * Gercek Supabase yerine sahte bir istemci; kimlik dogrulama da sahte bir
 * kullanici veriyor, cunku gelistirme kullanicisi ('dev-user') kapidan
 * bilerek muaf.
 */

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const { OA, ONAY } = require('./lib/hata-kodlari');
const onayLib = require('./lib/onay');
const PRACT = fs.readFileSync(path.join(__dirname, 'routes', 'practice.js'), 'utf8');

// ── sahte kimlik ve model ──────────────────────────────────────────────────
let kullanici = { id: 'u-1', app_metadata: { plan: 'pro' } };
require.cache[require.resolve('./middleware/auth')] = {
  id: require.resolve('./middleware/auth'), filename: require.resolve('./middleware/auth'), loaded: true,
  exports: {
    requireAuth: async (req) => { req.user = kullanici; },
    requirePlan: () => async () => {},
    optionalAuth: async () => {},
  },
};
let aiCagri = 0;
require.cache[require.resolve('./lib/ai')] = {
  id: require.resolve('./lib/ai'), filename: require.resolve('./lib/ai'), loaded: true,
  exports: {
    createMessage: async () => { aiCagri += 1; return JSON.stringify({ key_points: ['a'], answer_draft: 'x', avoid: [], time_plan: '' }); },
    streamMessage: async () => '', resolveModel: (m) => m, isOpenAI: () => false,
  },
};

/** Sahte Supabase: tablo durumu ve yazilanlar. */
function sahteSb({ kayitVar = false, okumaHatasi = false, yazmaHatasi = false } = {}) {
  const sb = { yazilan: [], sorgu: [] };
  sb.from = (tablo) => {
    const z = { tablo, kosul: {} };
    const zincir = {
      select() { return zincir; },
      eq(a, v) { z.kosul[a] = v; return zincir; },
      async maybeSingle() {
        sb.sorgu.push(z);
        if (okumaHatasi) return { data: null, error: { message: 'relation does not exist' } };
        return { data: kayitVar ? { id: 1 } : null, error: null };
      },
      async upsert(satir, secenek) {
        sb.yazilan.push({ tablo, satir, secenek });
        return { error: yazmaHatasi ? { message: 'x' } : null };
      },
    };
    return zincir;
  };
  return sb;
}

async function istek(yontem, url, govde, sb) {
  onayLib._setSupabase(sb);
  aiCagri = 0;
  const eski = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test';
  const Fastify = require('fastify');
  const app = Fastify({ logger: false });
  await app.register(require('./routes/practice'), { prefix: '/api/v1/practice' });
  await app.ready();
  try {
    const r = await app.inject({ method: yontem, url: `/api/v1/practice${url}`, payload: govde });
    return { durum: r.statusCode, govde: r.json() };
  } finally {
    await app.close();
    onayLib._setSupabase(undefined);
    if (eski == null) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = eski;
  }
}
const SORU = { question: 'Tell me about a time you dealt with a difficult stakeholder.' };

// ── A: kapi ────────────────────────────────────────────────────────────────

test('A1: onay YOKSA bolum calismiyor, model cagrilmiyor', async () => {
  const sb = sahteSb();
  const r = await istek('POST', '/online-assessment', SORU, sb);
  assert.strictEqual(r.durum, 428);
  assert.strictEqual(r.govde.kod, OA.ONAY_GEREKLI);
  assert.strictEqual(aiCagri, 0, 'onaysiz model cagrildi');
  assert.deepStrictEqual(sb.sorgu[0].kosul, { user_id: 'u-1', feature: 'online-assessment', version: 1 },
    'yanlis kullanici, ozellik ya da surum soruldu');
});

test('A2: onay VARSA calisiyor', async () => {
  const r = await istek('POST', '/online-assessment', SORU, sahteSb({ kayitVar: true }));
  assert.strictEqual(r.durum, 200);
  assert.strictEqual(aiCagri, 1);
});

test('A3: tablo okunamazsa kapi KAPALI (sessizce acilmiyor)', async () => {
  const r = await istek('POST', '/online-assessment', SORU, sahteSb({ okumaHatasi: true }));
  assert.strictEqual(r.durum, 503);
  assert.strictEqual(r.govde.kod, OA.ONAY_OKUNAMADI);
  assert.strictEqual(aiCagri, 0);
});

test('A4: once girdi dogrulanir, sonra onay sorulur: kisa soru onay sorgusu yapmadan 422', async () => {
  // Sira bilerek: once girdi, sonra onay. Kisa soru onay sorgusu yapmadan reddedilir.
  const sb = sahteSb();
  const r = await istek('POST', '/online-assessment', { question: 'kisa' }, sb);
  assert.strictEqual(r.govde.kod, OA.KISA_SORU);
  assert.strictEqual(sb.sorgu.length, 0);
});

// ── B: onay uclari ─────────────────────────────────────────────────────────

test('B1: GET durum dogru, bilinmeyen ozellik 404', async () => {
  assert.deepStrictEqual((await istek('GET', '/onay/online-assessment', undefined, sahteSb())).govde,
    { ozellik: 'online-assessment', surum: 1, onaylandi: false });
  assert.strictEqual((await istek('GET', '/onay/online-assessment', undefined, sahteSb({ kayitVar: true }))).govde.onaylandi, true);
  const b = await istek('GET', '/onay/baska-sey', undefined, sahteSb());
  assert.strictEqual(b.durum, 404);
  assert.strictEqual(b.govde.kod, ONAY.BILINMEYEN);
  const h = await istek('GET', '/onay/online-assessment', undefined, sahteSb({ okumaHatasi: true }));
  assert.strictEqual(h.durum, 503, 'okuma hatasi "onaylanmadi" gibi gorundu');
});

test('B2: POST dogru surumle KAYIT yaziyor: kim, hangi ozellik, hangi surum, hangi dil', async () => {
  const sb = sahteSb();
  const r = await istek('POST', '/onay/online-assessment', { surum: 1, dil: 'tr' }, sb);
  assert.strictEqual(r.durum, 200);
  assert.strictEqual(r.govde.onaylandi, true);
  assert.strictEqual(sb.yazilan.length, 1);
  assert.strictEqual(sb.yazilan[0].tablo, 'feature_consents');
  assert.deepStrictEqual(sb.yazilan[0].satir, { user_id: 'u-1', feature: 'online-assessment', version: 1, language: 'tr' });
  assert.deepStrictEqual(sb.yazilan[0].secenek, { onConflict: 'user_id,feature,version', ignoreDuplicates: true },
    'ikinci onay ilk kaydin tarihini ezer');
});

test('B3: eski surum onaylanamaz, kayit yazilmaz', async () => {
  const sb = sahteSb();
  for (const surum of [0, 2, undefined, '1x']) {
    const r = await istek('POST', '/onay/online-assessment', { surum }, sb);
    assert.strictEqual(r.durum, 409, String(surum));
    assert.strictEqual(r.govde.kod, ONAY.SURUM_ESKI);
  }
  assert.strictEqual(sb.yazilan.length, 0);
});

test('B4: yazilamazsa BASARI denmiyor', async () => {
  const r = await istek('POST', '/onay/online-assessment', { surum: 1 }, sahteSb({ yazmaHatasi: true }));
  assert.strictEqual(r.durum, 503);
  assert.strictEqual(r.govde.kod, ONAY.KAYDEDILEMEDI);
});

test('B5: kullanici kimligi govdeden DEGIL oturumdan', async () => {
  const sb = sahteSb();
  await istek('POST', '/onay/online-assessment', { surum: 1, user_id: 'baskasi' }, sb);
  assert.strictEqual(sb.yazilan[0].satir.user_id, 'u-1', 'baskasi adina onay yazildi');
});

// ── C: tablo ve sayac ──────────────────────────────────────────────────────

test('C1: tablo tanimi RLS acik, politikasiz, benzersiz kayitli', () => {
  const src = fs.readFileSync(path.join(__dirname, 'lib', 'onay.js'), 'utf8');
  assert.match(src, /ENABLE ROW LEVEL SECURITY/);
  assert.match(src, /UNIQUE \(user_id, feature, version\)/);
  assert.match(src, /ON DELETE CASCADE/);
  assert.ok(!/CREATE POLICY/.test(src), 'kullanici tabloya dogrudan erisebilir');
});

test('C2: onay uclari ucretsiz planin AI hakkindan dusmuyor', () => {
  const m = /const METERED_ROUTES = new Set\(\[([\s\S]*?)\]\)/.exec(PRACT);
  assert.ok(m, 'sayac listesi bulunamadi');
  assert.ok(!/onay/.test(m[1]));
});
