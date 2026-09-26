#!/usr/bin/env node
/**
 * server/olcum/altin-calistir.js — ALTIN TEST SETI CALISTIRICISI (K61)
 *
 * NE ICIN. Model takibi (K60) "ayni ailede daha yeni aday var" dediginde
 * gecis KARARI bu olcumle verilir. Aday model, uretimdeki rotalarin AYNISINDAN
 * (ayni istem, ayni JSON cozumu, ayni kod denetimleri) gecirilir; yalnizca
 * model degisir. Karsilastirmak icin once mevcut modelle, sonra adayla calistir.
 *
 * NASIL (bilgisayarinda, server klasorunde; anahtarlar ../.env ya da .env'den):
 *   node olcum/altin-calistir.js                      # mevcut modeller
 *   node olcum/altin-calistir.js --hizli claude-haiku-5-0 --tekrar 3
 *   node olcum/altin-calistir.js --guclu gpt-5 --vaka geri-hitap,li-dil
 *   node olcum/altin-calistir.js --cikti olcum/sonuc-haiku5.json
 *
 * --hizli / --guclu, Railway'deki MODEL_HIZLI / MODEL_GUCLU ile ayni seyi yapar:
 * uretimde gecis de tam olarak bu degiskenle yapilir, yani olculen sey
 * uygulanacak seyin kendisi.
 *
 * GUVENLIK. Supabase'e dokunmaz: kimlik, hak sayaci ve onay kaydi sahte.
 * Kullanici hakki dusmez, veritabanina yazilmaz. Yalnizca model saglayicisina
 * istek gider; her vaka x tekrar bir (bazen iki) cagri. Test verisi uydurma kisilere ait.
 *
 * NE OLCER. Vaka basina: denetimlerden gecme orani (kanitiyla), cozulemeyen
 * JSON, kesilen yanit, hata, sure (ms), girdi/cikti token ve fiyat tablosu
 * varsa tahmini maliyet. Tek bir "puan" uretmez (K53): sonuc kanitlariyla
 * okunur, karar kullanicinin.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const KOK = path.join(__dirname, '..');
const yol = (p) => path.join(KOK, p);

// ── Uretim rotalarini sahte kimlik/sayac/onay ile kur ───────────────────────

function sahteModul(dosya, exports) {
  const id = require.resolve(yol(dosya));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

/**
 * @param {Function|undefined} ozelCagri  testte sahte model (ag yok)
 * @param {Array} kayit                   her model cagrisinin olcumu buraya
 */
async function uygulamaKur(ozelCagri, kayit) {
  sahteModul('middleware/auth.js', {
    requireAuth: async (req) => { req.user = { id: 'olcum', email: 'olcum@ornek.test', app_metadata: { plan: 'pro' } }; },
    requirePlan: () => async () => {},
    optionalAuth: async () => {},
  });
  sahteModul('lib/usage.js', {
    checkAndIncrement: async () => ({ allowed: true, used: 0, limit: null }),
    getUsage: async () => ({ plan: 'pro', used: 0, limit: null }),
    getLiveUsage: async () => ({ plan: 'pro', used_seconds: 0, limit_seconds: null, remaining_seconds: null }),
  });
  delete require.cache[require.resolve(yol('lib/onay.js'))];
  const onay = require(yol('lib/onay.js'));
  sahteModul('lib/onay.js', { ...onay, onayDurumu: async () => 'var', onayKaydet: async () => ({ ok: true }) });

  delete require.cache[require.resolve(yol('lib/ai.js'))];
  const ai = require(yol('lib/ai.js'));
  const asil = ozelCagri || ai.createMessage;
  sahteModul('lib/ai.js', { ...ai, createMessage: async (opts, ustveri) => {
    const u = ustveri && typeof ustveri === 'object' ? ustveri : {};
    const kimlik = ai.resolveModel(opts.model);
    const bas = Date.now();
    try {
      return await asil(opts, u);
    } finally {
      kayit.push({ model: kimlik, ms: Date.now() - bas, girdi: u.girdi_token ?? null, cikti: u.cikti_token ?? null, kesildi: !!u.kesildi });
    }
  } });

  for (const r of ['routes/practice.js', 'routes/mock.js']) delete require.cache[require.resolve(yol(r))];
  const Fastify = require('fastify');
  const app = Fastify({ logger: false });
  await app.register(require(yol('routes/practice.js')), { prefix: '/api/v1/practice' });
  await app.ready();
  return app;
}

// ── Maliyet ──────────────────────────────────────────────────────────────────

function fiyatTablosu() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'fiyatlar.json'), 'utf8')).modeller || {}; } catch { return {}; }
}

/** En uzun onek eslesmesi: 'gpt-4o-mini' fiyati 'gpt-4o'ya karismaz. */
function fiyatBul(tablo, kimlik) {
  const anahtar = Object.keys(tablo).filter((k) => kimlik === k || kimlik.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return anahtar ? tablo[anahtar] : null;
}

function maliyet(tablo, cagrilar) {
  let top = 0;
  for (const c of cagrilar) {
    const f = fiyatBul(tablo, c.model);
    if (!f || c.girdi == null || c.cikti == null) return null;
    top += (c.girdi * f.girdi + c.cikti * f.cikti) / 1e6;
  }
  return top;
}

// ── Calistirma ───────────────────────────────────────────────────────────────

/**
 * @param {{vakalar?:Array, tekrar?:number, createMessage?:Function, fiyatlar?:object}} s
 * @returns {Promise<{modeller:object, vakalar:Array}>}
 */
async function calistir(s = {}) {
  const vakalar = s.vakalar || require('./altin-set');
  const tekrar = Math.max(1, s.tekrar || 1);
  const tablo = s.fiyatlar || fiyatTablosu();
  const kayit = [];
  const app = await uygulamaKur(s.createMessage, kayit);
  const { katmanlar } = require(yol('lib/modeller.js'));
  const sonuc = [];
  try {
    for (const v of vakalar) {
      const denemeler = [];
      for (let i = 0; i < tekrar; i++) {
        const once = kayit.length;
        const bas = Date.now();
        const r = await app.inject({ method: 'POST', url: `/api/v1/practice${v.rota}`, payload: v.govde });
        const ms = Date.now() - bas;
        const cagrilar = kayit.slice(once);
        let govde = null;
        try { govde = r.json(); } catch { /* govde JSON degil */ }
        const kod = govde && govde.kod;
        const d = { durum: r.statusCode, kod: kod || null, ms, cagrilar,
          json_hata: /cozulemedi/.test(kod || ''), kesildi: /kesildi/.test(kod || ''),
          hata: r.statusCode >= 400 ? String((govde && (govde.kod || govde.error)) || r.statusCode).slice(0, 200) : null,
          maliyet: maliyet(tablo, cagrilar), denetimler: [] };
        if (r.statusCode === 200) {
          for (const dn of v.denetimler) {
            let s2;
            try { s2 = dn.fn(govde); } catch (e) { s2 = { gecti: false, kanit: `denetim hatasi: ${e.message}` }; }
            d.denetimler.push({ ad: dn.ad, ...s2 });
          }
        }
        denemeler.push(d);
      }
      const basarili = denemeler.filter((d) => d.durum === 200);
      const denetimOzeti = v.denetimler.map((dn) => {
        const hepsi = basarili.map((d) => d.denetimler.find((x) => x.ad === dn.ad));
        return { ad: dn.ad, gecen: hepsi.filter((x) => x && x.gecti).length, toplam: denemeler.length,
          kanitlar: hepsi.filter((x) => x && !x.gecti).map((x) => x.kanit) };
      });
      const ort = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
      const mal = denemeler.map((d) => d.maliyet);
      sonuc.push({ id: v.id, tuzak: v.tuzak, rota: v.rota,
        model: [...new Set(denemeler.flatMap((d) => d.cagrilar.map((c) => c.model)))].join(', '),
        deneme: denemeler.length, basarili: basarili.length,
        json_hata: denemeler.filter((d) => d.json_hata).length,
        kesildi: denemeler.filter((d) => d.kesildi).length,
        hatalar: denemeler.filter((d) => d.hata && !d.json_hata && !d.kesildi).map((d) => d.hata),
        ort_ms: ort(denemeler.map((d) => d.ms)),
        ort_girdi_token: ort(denemeler.flatMap((d) => d.cagrilar.map((c) => c.girdi)).filter((x) => x != null)),
        ort_cikti_token: ort(denemeler.flatMap((d) => d.cagrilar.map((c) => c.cikti)).filter((x) => x != null)),
        toplam_maliyet_usd: mal.some((x) => x == null) ? null : mal.reduce((a, b) => a + b, 0),
        denetimler: denetimOzeti });
    }
  } finally {
    await app.close();
  }
  return { zaman: new Date().toISOString(), modeller: katmanlar(), tekrar, vakalar: sonuc };
}

function ozetYazdir(rapor, yaz = console.log) {
  yaz(`\nAltin test seti  ${rapor.zaman}`);
  yaz(`Hizli katman: ${rapor.modeller.hizli}   Guclu katman: ${rapor.modeller.guclu}   Tekrar: ${rapor.tekrar}\n`);
  let gecen = 0, toplam = 0, para = 0, paraBilinmiyor = false;
  for (const v of rapor.vakalar) {
    const tamam = v.denetimler.every((d) => d.gecen === d.toplam) && v.basarili === v.deneme;
    yaz(`${tamam ? 'TAMAM ' : 'SORUN '} ${v.id}  (${v.model || 'cagri yok'})  ${v.ort_ms ?? '-'} ms  token ${v.ort_girdi_token ?? '?'}/${v.ort_cikti_token ?? '?'}`);
    if (v.json_hata) yaz(`        cozulemeyen JSON: ${v.json_hata}/${v.deneme}`);
    if (v.kesildi) yaz(`        kesilen yanit: ${v.kesildi}/${v.deneme}`);
    for (const h of v.hatalar) yaz(`        hata: ${h}`);
    for (const d of v.denetimler) {
      gecen += d.gecen; toplam += d.toplam;
      yaz(`        ${d.gecen}/${d.toplam}  ${d.ad}`);
      for (const k of d.kanitlar.slice(0, 2)) yaz(`              kanit: ${k}`);
    }
    if (v.toplam_maliyet_usd == null) paraBilinmiyor = true; else para += v.toplam_maliyet_usd;
  }
  yaz(`\nDenetim: ${gecen}/${toplam} gecti.  Maliyet: ${paraBilinmiyor ? 'fiyat tablosunda olmayan model var (olcum/fiyatlar.json)' : `yaklasik ${para.toFixed(4)} USD`}`);
  yaz('Bu bir puan degil: SORUN satirlarinin kanitini oku, karari sen ver.\n');
}

function argumanlar(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) { a[k.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  }
  return a;
}

async function ana() {
  require('dotenv').config({ path: path.join(KOK, '..', '.env'), override: false });
  require('dotenv').config({ path: path.join(KOK, '.env'), override: false });
  const a = argumanlar(process.argv.slice(2));
  if (a.hizli) process.env.MODEL_HIZLI = a.hizli;
  if (a.guclu) process.env.MODEL_GUCLU = a.guclu;
  let vakalar = require('./altin-set');
  if (a.vaka) {
    const secili = String(a.vaka).split(',');
    vakalar = vakalar.filter((v) => secili.includes(v.id));
    if (!vakalar.length) { console.error('Vaka bulunamadi. Olanlar:', require('./altin-set').map((v) => v.id).join(', ')); process.exit(2); }
  }
  const eksik = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].filter((k) => !process.env[k]);
  if (eksik.length) console.warn(`Uyari: ${eksik.join(', ')} yok; o saglayicinin modelleri hata verir.`);
  const rapor = await calistir({ vakalar, tekrar: parseInt(a.tekrar, 10) || 2 });
  ozetYazdir(rapor);
  const cikti = typeof a.cikti === 'string' ? a.cikti
    : path.join(__dirname, `sonuc-${rapor.zaman.slice(0, 19).replace(/[:T]/g, '-')}.json`);
  fs.writeFileSync(cikti, JSON.stringify(rapor, null, 2));
  console.log(`Ayrintili rapor: ${cikti}`);
}

if (require.main === module) {
  ana().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { calistir, ozetYazdir, fiyatBul, maliyet, argumanlar };
