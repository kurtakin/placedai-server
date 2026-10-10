/**
 * scripts/demo-cevaplari.js — ana sayfa demosu icin GERCEK cevaplari bir kez uretir
 * (K113, Asama 3, 9 Ekim 2026).
 *
 * Ne yapar:
 *   Canli sistemin KENDI rotalarini (routes/aid.js: /cues ve /stream) bu
 *   bilgisayarda, sunucu acmadan, bellekte calistirir. Overlay'in gonderdigi
 *   istegin aynisini gonderir: hayali bir CV + hayali bir is ilani + soru.
 *   Prompt, model ve cevap bicimi canlidakiyle birebir; kod kopyalanmadi.
 *   Sonucu scripts/demo-cevaplari.json dosyasina yazar.
 *
 * Kullanilan kisiler ve sirketler HAYALI (scripts/demo-profilleri.json;
 * kaynak: web sitesindeki CV ornekleri).
 *
 * Calistir (server klasorunde):   node scripts/demo-cevaplari.js
 *   Yalnizca bazi sahneleri yenilemek icin:  node scripts/demo-cevaplari.js genel depo
 *   (digerleri mevcut demo-cevaplari.json'dan AYNEN korunur).
 *   - API anahtarlari projenin kendi .env dosyasindan okunur (index.js ile
 *     ayni yer). Anahtar hicbir yere yazilmaz, ekrana basilmaz.
 *   - Veritabanina BAGLANMAZ: Supabase degiskenleri bu surecte bosaltilir;
 *     kullanim sayaci, olcum ve hesaplar etkilenmez.
 *   - Maliyet: 8 soru x (1 kisa ipucu + 1 kisa cevap), yaklasik 2-5 sent.
 */
'use strict';

const path = require('path');
const fs   = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: false });
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: false });

// Veritabani yok: sayac, olcum ve plan okuma bu surecte calismaz.
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY']) delete process.env[k];

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY bulunamadi (.env). Betik durdu; hicbir sey uretilmedi.');
  process.exit(1);
}

// Kimlik: hayali, ucretli plan (sinir ve sayac devreye girmesin). Gercek hesap DEGIL.
const DEMO_KULLANICI = { id: '00000000-0000-4000-8000-00000000d3e0', app_metadata: { plan: 'ultimate' } };
const yolA = require.resolve('../middleware/auth');
const gercek = require('../middleware/auth');
require.cache[yolA] = { id: yolA, filename: yolA, loaded: true, exports: {
  ...gercek,
  requireAuth: async (q) => { q.user = DEMO_KULLANICI; },
  optionalAuth: async (q) => { q.user = DEMO_KULLANICI; },
  requirePlan: () => async (q) => { q.user = DEMO_KULLANICI; },
} };

/** Overlay'in buildJdContext()'i ile ayni alanlar ve sira. */
function baglam(p, ilan) {
  return [
    `Candidate: ${p.ad}`, `Role: ${p.unvan}`, `Location: ${p.yer}`,
    `Skills: ${p.beceriler.slice(0, 300)}`, `CV: ${p.cv.slice(0, 800)}`,
    `Target role: ${ilan.rol}`, `Company: ${ilan.sirket}`, `Seniority: ${ilan.kidem}`,
    `Required skills: ${ilan.beceriler.join(', ')}`, `What they care about: ${ilan.odak.join(', ')}`,
  ].join('\n');
}

/**
 * Ipucunda gecen her sayi profilde de geciyor mu? Gecmiyorsa uyari (K113b:
 * "99.8%" ipucu "8%" olarak gelmisti). Uretimi durdurmaz; insan gozden gecirir.
 */
function sayiUyarilari(ipuclari, p) {
  const metin = [p.ozet, p.beceriler, p.cv].filter(Boolean).join(' ');
  const uyari = [];
  for (const ip of ipuclari) for (const n of String(ip).match(/\d+(?:[.,]\d+)?/g) || []) {
    const kalip = new RegExp(`(?<![\\d.,])${n.replace(/[.,]/g, '[.,]')}(?![\\d])`);
    if (!kalip.test(metin)) uyari.push(`"${ip}" icindeki ${n} profilde yok`);
  }
  return uyari;
}

/** SSE govdesinden metni topla; overlay'in yaptigi gibi POINTS / ANSWER ayir. */
function akisiCoz(govde) {
  let ham = '';
  for (const satir of String(govde).split('\n')) {
    if (!satir.startsWith('data: ')) continue;
    try { const o = JSON.parse(satir.slice(6)); if (o.type === 'token') ham += o.data; if (o.type === 'error') throw new Error(o.data); }
    catch (e) { if (e instanceof SyntaxError) continue; throw e; }
  }
  const p = ham.match(/POINTS:\s*(.+?)(?:\r?\n|ANSWER:)/i);
  const a = ham.match(/ANSWER:\s*([\s\S]*)/i);
  return {
    noktalar: p ? p[1].split('|').map((x) => x.trim()).filter(Boolean).slice(0, 3) : [],
    cevap: (a ? a[1] : ham).trim(),
  };
}

async function main() {
  const { sahneler } = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-profilleri.json'), 'utf8'));
  const yol = process.env.DEMO_CIKTI || path.join(__dirname, 'demo-cevaplari.json');   // DEMO_CIKTI: yalnizca testler
  const sadece = process.argv.slice(2);
  const bilinmeyen = sadece.filter((id) => !sahneler.some((s) => s.id === id));
  if (bilinmeyen.length) throw new Error(`bilinmeyen sahne: ${bilinmeyen.join(', ')} (gecerli: ${sahneler.map((s) => s.id).join(', ')})`);
  let eski = null;
  if (sadece.length) {
    if (!fs.existsSync(yol)) throw new Error('kismi yenileme icin once tam uretim gerekli (demo-cevaplari.json yok)');
    eski = JSON.parse(fs.readFileSync(yol, 'utf8'));
  }
  const simdi = new Date().toISOString();
  const app = require('fastify')({ logger: false });
  await app.register(require('../routes/aid'), { prefix: '/api/v1/aid' });
  await app.ready();

  const sonuc = [];
  for (const s of sahneler) {
    if (eski && !sadece.includes(s.id)) {
      const k = eski.sahneler.find((x) => x.id === s.id);
      if (!k) throw new Error(`${s.id}: eski dosyada yok; tam uretim yap`);
      sonuc.push({ ...k, uretildi: k.uretildi || eski.uretildi });
      continue;
    }
    const jd = baglam(s.profil, s.ilan);
    process.stdout.write(`${s.id}: ${s.soru} ... `);
    const cr = await app.inject({ method: 'POST', url: '/api/v1/aid/cues', payload: { question: s.soru, jd_context: jd, language: 'en' } });
    const cues = (cr.json().cues || []).slice(0, 3);
    const t0 = Date.now();
    const ar = await app.inject({ method: 'POST', url: '/api/v1/aid/stream', payload: {
      question: s.soru, jd_context: jd, model: 'claude-haiku', answer_length: 'short',
      interview_type: 'job_interview', language: 'en', sector: 'universal_behavioral', seniority: 'mid', with_points: true,
    } });
    if (ar.statusCode !== 200) throw new Error(`/stream ${ar.statusCode}: ${ar.body.slice(0, 200)}`);
    const { noktalar, cevap } = akisiCoz(ar.body);
    const ipuclari = cues.length ? cues : noktalar;
    if (!cevap || ipuclari.length === 0) throw new Error(`${s.id}: bos cikti (ipucu ${ipuclari.length}, cevap ${cevap.length} karakter)`);
    sonuc.push({ id: s.id, etiket: s.etiket, soru: s.soru, ipuclari, cevap, ipucu_kaynagi: cues.length ? 'cues' : 'stream', aday: s.profil.ad, rol: s.ilan.rol, uretildi: simdi });
    console.log(`tamam (${ipuclari.length} ipucu, ${cevap.split(/\s+/).length} kelime, ${Date.now() - t0} ms)`);
    for (const u of sayiUyarilari(ipuclari, s.profil)) console.log(`  UYARI: ${u}`);
  }
  await app.close();

  const cikti = {
    uretildi: simdi,
    model: 'claude-haiku (/stream) + canli /cues yolu',
    not: 'Canli PlacedAI rotalariyla, hayali profiller icin bir kez uretildi. Elle duzenlenmedi.',
    sahneler: sonuc,
  };
  fs.writeFileSync(yol, JSON.stringify(cikti, null, 1) + '\n');
  console.log(`\nYazildi: ${path.relative(process.cwd(), yol)} (${sonuc.length} sahne). Claude'a "uretildi" demen yeterli.`);
}

main().catch((e) => { console.error('\nHATA:', e.message); process.exit(1); });
