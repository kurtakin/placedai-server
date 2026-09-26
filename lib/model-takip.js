/**
 * server/lib/model-takip.js — MODEL TAKIBI (26 Eylul 2026, model yonetimi adim 2, K60)
 *
 * NE YAPAR. Kullandigimiz her modelin kimligini (lib/modeller.js ozet() ve
 * lib/whisper.js saglayicilari) saglayicilarin kendi /v1/models listesiyle
 * karsilastirir ve iki sey soyler:
 *   1. KULLANILAN MODEL LISTEDE YOK: model emekliye ayrilmis ya da kimlik
 *      yanlis yazilmis olabilir. Bu gun gelince istekler hata verir.
 *   2. AYNI AILEDE DAHA YENI TARIHLI MODEL VAR: yalnizca ADAY. "Daha iyi"
 *      demiyoruz; bunu altin test seti (adim 3) olcer, karari kullanici verir.
 *
 * NE YAPMAZ. Hicbir modeli kendi kendine degistirmez (K59: gecis olculup
 * onayla yapilir). Emeklilik TARIHINI bilemez: saglayicilarin listesinde
 * boyle bir alan yok; o duyurular saglayicilardan e-postayla geliyor.
 *
 * AILE KURALI (bilerek basit ve acik):
 *   Anthropic: katman adi (opus / sonnet / haiku). Sonnet'in adayi yalnizca
 *     daha yeni bir Sonnet olur.
 *   OpenAI ve Groq: hat (gpt, o, whisper...) + boy (mini, nano, pro ya da yok)
 *     + tur (transcribe, tts, realtime, audio...). gpt-4o-mini'nin adayi
 *     gpt-5-mini olabilir, gpt-5 ya da gpt-4o-mini-tts olamaz.
 *   Tarihli surum kopyalari (-2024-07-18), preview ve latest takma adlari aday
 *   sayilmaz: bunlar yeni model degil, ayni modelin surumleri. Zaten
 *   kullandigimiz bir kimlik de aday sayilmaz.
 *
 * NE ZAMAN. Ayin 1'i, 09:00-09:59 UTC arasinda bir kez (saatlik zamanlayici).
 * Yalnizca bulgu varsa ve bulgular son gonderilenden farkliysa e-posta atar.
 * Istege bagli: GET /api/v1/admin/models (rapor), POST /api/v1/admin/models/check
 * (rapor + e-posta, tekrar kontrolu olmadan). MODEL_TAKIP=kapali zamanlayiciyi kapatir.
 */

'use strict';

const ZAMAN_ASIMI_MS = 15000;
const ADAY_SINIRI = 3;

// Hangi gorev hangi ortam degiskeniyle degistirilir (e-postada yol gostermek icin).
const DEGISKENLER = {
  'claude-haiku': 'MODEL_HIZLI',
  'claude-sonnet': 'MODEL_GUCLU',
  'gpt-4o-mini': 'MODEL_GPT_HIZLI',
  'gpt-4o': 'MODEL_GPT_GUCLU',
  ses_tanima: 'REALTIME_STT_MODEL',
  seslendirme: 'MOCK_TTS_MODEL',
  groq: 'GROQ_MODEL',
};

/** Kimligin saglayicisi. Bilinmeyen bicim null: takip disi kalir, uydurmayiz. */
function saglayiciBul(kimlik, gorev) {
  if (gorev && gorev.startsWith('groq')) return 'groq';
  if (/^claude-/.test(kimlik)) return 'anthropic';
  if (/^(gpt-|o\d|whisper-1$|tts-|chatgpt-)/.test(kimlik)) return 'openai';
  return null;
}

/** Takip edilecek (gorev, kimlik) ciftleri: modeller.ozet() + whisper saglayicilari. */
function kullanilanlar() {
  const { ozet } = require('./modeller');
  const liste = [];
  for (const [gorev, kimlik] of Object.entries(ozet())) {
    if (!kimlik || /^\(/.test(kimlik)) continue; // '(otomatik secim)': Groq kendi seciyor
    liste.push({ gorev, kimlik });
  }
  let ses = [];
  try { ses = require('./whisper').SES_MODELLERI || []; } catch (_) { /* yoksa atla */ }
  for (const s of ses) liste.push({ gorev: s.gorev, kimlik: s.model });
  return liste.map((k) => ({ ...k, saglayici: saglayiciBul(k.kimlik, k.gorev) }));
}

// ── Saglayici listeleri ─────────────────────────────────────────────────────

async function jsonGetir(fetchFn, url, basliklar) {
  const r = await fetchFn(url, { headers: basliklar, signal: AbortSignal.timeout(ZAMAN_ASIMI_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Anthropic: sayfali (has_more + after_id). created_at ISO metni. */
async function anthropicListe(fetchFn, anahtar) {
  const modeller = [];
  let sonraki = null;
  for (let sayfa = 0; sayfa < 10; sayfa++) {
    const url = 'https://api.anthropic.com/v1/models?limit=1000' + (sonraki ? `&after_id=${encodeURIComponent(sonraki)}` : '');
    const d = await jsonGetir(fetchFn, url, { 'x-api-key': anahtar, 'anthropic-version': '2023-06-01' });
    for (const m of d.data || []) modeller.push({ id: m.id, tarih: Date.parse(m.created_at) || 0 });
    if (!d.has_more || !d.last_id) break;
    sonraki = d.last_id;
  }
  return modeller;
}

/** OpenAI ve Groq: ayni bicim, created Unix saniyesi. */
async function openaiBicimiListe(fetchFn, url, anahtar) {
  const d = await jsonGetir(fetchFn, url, { Authorization: `Bearer ${anahtar}` });
  return (d.data || []).map((m) => ({ id: m.id, tarih: (Number(m.created) || 0) * 1000 }));
}

const KAYNAKLAR = {
  anthropic: { anahtar: 'ANTHROPIC_API_KEY', getir: (f, a) => anthropicListe(f, a) },
  openai: { anahtar: 'OPENAI_API_KEY', getir: (f, a) => openaiBicimiListe(f, 'https://api.openai.com/v1/models', a) },
  groq: { anahtar: 'GROQ_API_KEY', getir: (f, a) => openaiBicimiListe(f, 'https://api.groq.com/openai/v1/models', a) },
};

// ── Aile kurali ─────────────────────────────────────────────────────────────

const TURLER = ['transcribe', 'diarize', 'tts', 'realtime', 'audio', 'search', 'image', 'embedding',
  'moderation', 'codex', 'oss', 'instruct', 'chat', 'research', 'computer', 'guard', 'vision', 'versatile', 'instant'];
const BOYLAR = ['mini', 'nano', 'pro'];

/** Aday olamayacak kimlikler: tarihli surum kopyasi, preview, latest. */
function surumKopyasiMi(id) {
  return /-\d{4}-?\d{2}-?\d{2}$/.test(id) || /-\d{8}$/.test(id) || /preview|latest/.test(id);
}

function aile(saglayici, id) {
  const s = String(id).toLowerCase();
  if (saglayici === 'anthropic') {
    const k = s.match(/(opus|sonnet|haiku)/);
    return k ? `anthropic|${k[1]}` : null;
  }
  const parca = s.split(/[-_/:]/);
  const hat = /^gpt-/.test(s) ? 'gpt' : /^o\d/.test(s) ? 'o' : parca[0];
  const boy = BOYLAR.filter((b) => parca.includes(b)).join('+');
  const tur = TURLER.filter((t) => parca.some((p) => p.startsWith(t))).join('+');
  return `${saglayici}|${hat}|${boy}|${tur}`;
}

/**
 * Ayni ailede, kullanilandan daha yeni tarihli, surum kopyasi olmayan ve
 * zaten kullanmadigimiz (bilinen) modeller. gpt-4.1-mini Ayarlar'da zaten
 * secilebildigi icin gpt-4o-mini'ye "yeni aday" diye yeniden onerilmez.
 */
function adaylar(saglayici, kimlik, liste, bilinen = new Set()) {
  const a = aile(saglayici, kimlik);
  if (!a) return [];
  const kendisi = liste.find((m) => m.id === kimlik);
  // Anthropic'te kullanilan kimlik tarihli olabilir (claude-haiku-4-5-20251001):
  // kendisi listede yoksa esik bilinmiyor, aday da soylenmez (uydurma olmasin).
  if (!kendisi) return [];
  return liste
    .filter((m) => m.id !== kimlik && !bilinen.has(m.id) && m.tarih > kendisi.tarih && aile(saglayici, m.id) === a)
    .filter((m) => saglayici === 'anthropic' ? true : !surumKopyasiMi(m.id))
    .sort((x, y) => y.tarih - x.tarih)
    .slice(0, ADAY_SINIRI)
    .map((m) => ({ kimlik: m.id, tarih: new Date(m.tarih).toISOString().slice(0, 10) }));
}

// ── Rapor ───────────────────────────────────────────────────────────────────

/**
 * @param {{fetchFn?:Function, env?:object, simdi?:Date}} secenek
 * @returns {Promise<{zaman:string, saglayicilar:object, kullanilan:Array, bulgular:string[]}>}
 */
async function raporOlustur(secenek = {}) {
  const fetchFn = secenek.fetchFn || fetch;
  const env = secenek.env || process.env;
  const kullanilan = kullanilanlar();

  const gerekli = [...new Set(kullanilan.map((k) => k.saglayici).filter(Boolean))];
  const saglayicilar = {};
  const listeler = {};
  await Promise.all(gerekli.map(async (s) => {
    const anahtar = env[KAYNAKLAR[s].anahtar];
    if (!anahtar) { saglayicilar[s] = { durum: 'anahtar_yok' }; return; }
    try {
      listeler[s] = await KAYNAKLAR[s].getir(fetchFn, anahtar);
      saglayicilar[s] = { durum: 'ok', adet: listeler[s].length };
    } catch (e) {
      saglayicilar[s] = { durum: 'hata', hata: String(e && e.message || e).slice(0, 120) };
    }
  }));

  const bulgular = [];
  for (const [s, d] of Object.entries(saglayicilar)) {
    if (d.durum === 'hata') bulgular.push(`${s} model listesi alinamadi (${d.hata}). Anahtar gecersiz ya da servis erisilemiyor olabilir.`);
  }

  const bilinen = new Set(kullanilan.map((k) => k.kimlik));
  const satirlar = kullanilan.map((k) => {
    const liste = k.saglayici && listeler[k.saglayici];
    if (!liste) return { ...k, durum: 'bilinmiyor', adaylar: [] };
    const var_ = liste.some((m) => m.id === k.kimlik);
    const ad = var_ ? adaylar(k.saglayici, k.kimlik, liste, bilinen) : [];
    const degisken = DEGISKENLER[k.gorev];
    const nasil = degisken ? `Degistirmek icin: Railway'de ${degisken}.` : 'Bu kimlik kodda sabit.';
    if (!var_) {
      bulgular.push(`${k.gorev}: "${k.kimlik}" ${k.saglayici} listesinde YOK. Emekliye ayrilmis ya da yanlis yazilmis olabilir. ${nasil}`);
    } else if (ad.length) {
      bulgular.push(`${k.gorev}: "${k.kimlik}" icin ayni ailede daha yeni aday: ${ad.map((a) => `${a.kimlik} (${a.tarih})`).join(', ')}. Once olcum (altin test seti), sonra karar. ${nasil}`);
    }
    return { ...k, durum: var_ ? 'var' : 'yok', adaylar: ad };
  });

  return { zaman: (secenek.simdi || new Date()).toISOString(), saglayicilar, kullanilan: satirlar, bulgular };
}

// ── Bildirim ve zamanlayici ─────────────────────────────────────────────────

let sonParmakIzi = null;
let sonCalismaGunu = null;

function epostaMetni(rapor) {
  return [
    'PlacedAI model takibi (aylik).',
    '',
    ...rapor.bulgular.map((b) => `- ${b}`),
    '',
    'Hicbir model otomatik degismedi. Aday bir model once altin test setiyle olculur, karari sen verirsin.',
    `Rapor zamani: ${rapor.zaman}`,
  ].join('\n');
}

/**
 * Raporu olusturur; bulgu varsa ve (zorla ya da) son gonderilenden farkliysa e-posta atar.
 * @returns {Promise<{rapor:object, posta:{gonderildi:boolean, neden?:string, sonuc?:object}}>}
 */
async function kontrolEt(secenek = {}) {
  const rapor = await raporOlustur(secenek);
  const mailer = secenek.mailer || require('./mailer');
  if (!rapor.bulgular.length) return { rapor, posta: { gonderildi: false, neden: 'bulgu_yok' } };
  const iz = rapor.bulgular.join('\n');
  if (!secenek.zorla && iz === sonParmakIzi) return { rapor, posta: { gonderildi: false, neden: 'ayni_bulgular' } };
  const sonuc = await mailer.sendMail({ subject: `PlacedAI model takibi: ${rapor.bulgular.length} bulgu`, text: epostaMetni(rapor) });
  if (sonuc && sonuc.ok) sonParmakIzi = iz;
  return { rapor, posta: { gonderildi: !!(sonuc && sonuc.ok), sonuc } };
}

/** Ayin 1'i, 09 UTC saati, o gun henuz calismadiysa. */
function zamaniGeldiMi(simdi, sonGun) {
  const gun = simdi.toISOString().slice(0, 10);
  return simdi.getUTCDate() === 1 && simdi.getUTCHours() === 9 && sonGun !== gun;
}

function zamanlayiciBaslat(log = console) {
  if (String(process.env.MODEL_TAKIP || '').toLowerCase() === 'kapali') return null;
  const t = setInterval(async () => {
    const simdi = new Date();
    if (!zamaniGeldiMi(simdi, sonCalismaGunu)) return;
    sonCalismaGunu = simdi.toISOString().slice(0, 10);
    try {
      const { rapor, posta } = await kontrolEt();
      log.info?.(`[model-takip] ${rapor.bulgular.length} bulgu, e-posta: ${posta.gonderildi ? 'gonderildi' : posta.neden || 'gonderilemedi'}`);
    } catch (e) {
      log.error?.(`[model-takip] ${e && e.message}`);
    }
  }, 60 * 60 * 1000);
  if (t.unref) t.unref();
  return t;
}

function _sifirla() { sonParmakIzi = null; sonCalismaGunu = null; }

module.exports = { raporOlustur, kontrolEt, zamanlayiciBaslat, zamaniGeldiMi, aile, adaylar, kullanilanlar, _sifirla };
