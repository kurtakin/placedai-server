/**
 * server/routes/olay.js — Donusum olcumu uclari (mount: /api/v1/olay) (K112, K112b).
 *
 *   POST /       → tarayicidan olay. Giris ZORUNLU DEGIL (ziyaretci de sayilir).
 *                  text/plain ya da JSON: { olay, ayrinti?, sayfa? }. Her zaman 204
 *                  (gecersiz govde 400); reddedilen istek de 204 alir ki deneme
 *                  yapan neyin sayildigini ogrenemesin.
 *   POST /kayit  → giris yapmis kullanici: hesap son 7 gunde acildiysa bir kez
 *                  'kayit_tamam'. Asil kayit olcumu artik Supabase tetikleyicisinde
 *                  (k112b SQL); bu uc yedek olarak kaliyor, cift sayim olmaz.
 *                  K115b: hesap bilgisinde (user_metadata.kayit_kaynagi) ya da
 *                  govdede { kaynak } etiket varsa (hero/demo/pricing/other/direct)
 *                  KENDI kayit satirina bir kez yazilir; hesap 24 saatten eskiyse
 *                  ya da etiket zaten varsa yok sayilir. Yalnizca olcum etiketi.
 *
 * Kotuye kullanima karsi KATMANLAR (K112b; hicbiri tek basina guvenlik degil):
 *   1. Koken: Origin (yoksa Referer) placedai.app olmali. Tarayici disi
 *      araclar bunu taklit edebilir; yalnizca baska sitelerden gelen
 *      tarayici isteklerini keser.
 *   2. Bot / otomasyon UA sayilmaz.
 *   3. Hiz: ayni IP'den dakikada 20, saatte 60 anonim olay.
 *   4. Tekrar: ayni IP + olay + sayfa + ayrinti 10 dakikada bir kez.
 *   5. Gunluk tavan: anonim satir sayisi gunde OLAY_GUNLUK_TAVAN (varsayilan
 *      20.000). Asilirsa o gun anonim olay yazilmaz, veritabani sismez.
 *   6. masaustu_ilgi: giris sart; kisi basina gunde bir.
 * Istemci IP'si (K112b, Railway forum yanitlari 9 Ekim 2026 incelendi):
 * request.ip herkes icin Railway kenar sunucusu (trustProxy yok). Railway
 * calisanlarinin yanitlari: X-Real-IP kenar tarafindan HER ZAMAN yazilir ve
 * istemcinin gonderdigi deger ezilir (eski bir hata duzeltilmis). XFF icin
 * yanitlar celisiyor ("en sagdaki guvenilir" / "kenarda temizlenir, ilk deger
 * gercek"). Bu yuzden sira: X-Real-IP -> XFF en sag -> baglanti IP'si.
 * Resmi belgede soz yok; canlida dogrulama adimi DEVAM.md K112b'de. Saatlik
 * log yalnizca SAYI yazar: farkli IP ozeti, olay sayisi ve basliklarin
 * bulunma sayilari (degerleri degil). Kesin sinir yine gunluk tavan.
 * IP HICBIR YERE YAZILMAZ. Bellekte bile ham tutulmaz: surec acilisinda
 * uretilen rastgele tuzla ozetlenir ve en gec 1 saatte silinir.
 * Kayit oncesi olaylar kisiye BAGLANMAZ (user_id bos).
 */
'use strict';

const crypto = require('crypto');
const { optionalAuth, requireAuth } = require('../middleware/auth');
const O = require('../lib/olay');

const DAKIKA_SINIR = 20;
const SAAT_SINIR   = 60;
const TEKRAR_MS    = 10 * 60 * 1000;
const DK_MS        = 60 * 1000;
const SAAT_MS      = 60 * 60 * 1000;

const IZINLI_KOKEN = new Set(['https://placedai.app', 'https://www.placedai.app']);
const YEREL_RE     = /^http:\/\/localhost(:\d+)?$/;

const _ayar = { tavan: Number(process.env.OLAY_GUNLUK_TAVAN) > 0 ? Number(process.env.OLAY_GUNLUK_TAVAN) : 20000,
                yerel: process.env.OLAY_YEREL === '1', webKoken: process.env.WEB_APP_ORIGIN || null };
const TUZ = crypto.randomBytes(16);

const _hiz    = new Map();   // ipOzeti -> { dk, dkSon, saat, saatSon }
const _tekrar = new Map();   // anahtar -> bitis
const _gun    = { gun: '', anonim: 0, uyarildi: false };

/** Railway'in yazdigi X-Real-IP; yoksa X-Forwarded-For en sag; yoksa baglanti IP'si. */
function istemciIp(request) {
  const gercek = request.headers['x-real-ip'];
  if (typeof gercek === 'string' && gercek.trim() && gercek.length <= 64) return gercek.trim();
  const xff = request.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const parcalar = xff.split(',').map((x) => x.trim()).filter(Boolean);
    if (parcalar.length) return parcalar[parcalar.length - 1];
  }
  return request.ip;
}

function ipOzeti(ip) {
  return crypto.createHash('sha256').update(TUZ).update(String(ip || '')).digest('hex').slice(0, 20);
}

/** Origin, yoksa Referer'in kokeni. Izinli degilse false. */
function kokenUygun(headers) {
  let koken = headers.origin;
  if (!koken && headers.referer) { try { koken = new URL(headers.referer).origin; } catch { koken = null; } }
  if (!koken) return false;
  if (IZINLI_KOKEN.has(koken) || (_ayar.webKoken && koken === _ayar.webKoken)) return true;
  return _ayar.yerel && YEREL_RE.test(koken);
}

function hizAsildi(oz, simdi) {
  let r = _hiz.get(oz);
  if (!r) { r = { dk: 0, dkSon: simdi + DK_MS, saat: 0, saatSon: simdi + SAAT_MS }; _hiz.set(oz, r); }
  if (simdi > r.dkSon)   { r.dk = 0;   r.dkSon = simdi + DK_MS; }
  if (simdi > r.saatSon) { r.saat = 0; r.saatSon = simdi + SAAT_MS; }
  r.dk += 1; r.saat += 1;
  return r.dk > DAKIKA_SINIR || r.saat > SAAT_SINIR;
}

function tekrarMi(anahtar, simdi, sure = TEKRAR_MS) {
  const bitis = _tekrar.get(anahtar);
  if (bitis && bitis > simdi) return true;
  _tekrar.set(anahtar, simdi + sure);
  return false;
}

function gunlukTavanDolu(simdi, log) {
  const gun = new Date(simdi).toISOString().slice(0, 10);
  if (_gun.gun !== gun) { _gun.gun = gun; _gun.anonim = 0; _gun.uyarildi = false; }
  if (_gun.anonim >= _ayar.tavan) {
    if (!_gun.uyarildi) { _gun.uyarildi = true; log.warn?.(`[olay] gunluk anonim tavan (${_ayar.tavan}) doldu; bugun anonim olay yazilmayacak`); }
    return true;
  }
  _gun.anonim += 1;
  return false;
}

// Saatlik yalnizca SAYI: kac farkli IP ozeti, kac anonim olay. IP yazilmaz.
const _saatlik = { ozetler: new Set(), olay: 0, xRealIp: 0, xff: 0, xffCok: 0 };
let _log = null;
setInterval(() => {
  const simdi = Date.now();
  for (const [k, r] of _hiz) if (simdi > r.saatSon) _hiz.delete(k);
  for (const [k, b] of _tekrar) if (simdi > b) _tekrar.delete(k);
}, 5 * 60 * 1000).unref();
setInterval(() => {
  if (_log && _saatlik.olay > 0) {
    _log.info?.({ farkliIp: _saatlik.ozetler.size, anonimOlay: _saatlik.olay, xRealIpVar: _saatlik.xRealIp, xffVar: _saatlik.xff, xffCokGirdili: _saatlik.xffCok }, '[olay] son 1 saat');
  }
  _saatlik.ozetler.clear(); _saatlik.olay = 0; _saatlik.xRealIp = 0; _saatlik.xff = 0; _saatlik.xffCok = 0;
}, SAAT_MS).unref();

let _sbTest;   // testler icin
function sb() {
  if (_sbTest !== undefined) return _sbTest;
  try { return require('../lib/bot-depo').getSupabase(); } catch { return null; }
}

async function olayRoutes(fastify) {
  _log = fastify.log;
  fastify.post('/', { preHandler: optionalAuth, bodyLimit: 1024 }, async (request, reply) => {
    const o = O.webOlayiAyikla(request.body);
    if (!o) return reply.code(400).send({ error: 'invalid_event' });
    if (!kokenUygun(request.headers) || O.botMu(request.headers['user-agent'])) return reply.code(204).send();

    const simdi = Date.now();
    const kisili = O.GIRIS_GEREKEN.has(o.olay);
    if (kisili) {
      if (!request.user) return reply.code(204).send();
      const gun = new Date(simdi).toISOString().slice(0, 10);
      if (tekrarMi(`u|${request.user.id}|${o.olay}|${gun}`, simdi, 24 * SAAT_MS)) return reply.code(204).send();
      O.olayYaz(sb(), { ...o, user: request.user, log: fastify.log });
      return reply.code(204).send();
    }

    const oz = ipOzeti(istemciIp(request));
    if (_saatlik.ozetler.size < 100000) _saatlik.ozetler.add(oz);
    _saatlik.olay += 1;
    if (request.headers['x-real-ip']) _saatlik.xRealIp += 1;
    if (request.headers['x-forwarded-for']) { _saatlik.xff += 1; if (String(request.headers['x-forwarded-for']).includes(',')) _saatlik.xffCok += 1; }
    if (hizAsildi(oz, simdi)) return reply.code(204).send();
    if (tekrarMi(`a|${oz}|${o.olay}|${o.sayfa || ''}|${o.ayrinti || ''}`, simdi)) return reply.code(204).send();
    if (gunlukTavanDolu(simdi, fastify.log)) return reply.code(204).send();
    // Beklemeden yaz: istemci cevabi beklemiyor, olcum hicbir zaman yavaslatmaz.
    O.olayYaz(sb(), { ...o, user: null, log: fastify.log });
    return reply.code(204).send();
  });

  fastify.post('/kayit', { preHandler: requireAuth, bodyLimit: 256 }, async (request, reply) => {
    let govde = request.body;
    if (typeof govde === 'string') { try { govde = JSON.parse(govde); } catch { govde = null; } }
    // Hesap bilgisindeki etiket (e-posta kaydinda yazilir) once gelir: hesaba
    // ait oldugu kesin. Adresle gelen (Google ile kayit) yalnizca o yoksa.
    const meta = request.user && request.user.user_metadata && request.user.user_metadata.kayit_kaynagi;
    const adres = govde && typeof govde === 'object' && typeof govde.kaynak === 'string' ? govde.kaynak : null;
    const kaynak = typeof meta === 'string' ? meta : adres;
    // Once satir (tetikleyici yazmadiysa), sonra etiket. Beklenir ama hatada bile 204.
    await O.kayitTamam(sb(), request.user, { log: fastify.log, kaynak });
    if (kaynak) await O.kaynakEkle(sb(), request.user, kaynak, { log: fastify.log });
    return reply.code(204).send();
  });
}

olayRoutes._testSb = (v) => { _sbTest = v; };
olayRoutes._ayarla = (a) => { Object.assign(_ayar, a); };
olayRoutes._sifirla = () => { _hiz.clear(); _tekrar.clear(); _gun.gun = ''; _gun.anonim = 0; _gun.uyarildi = false; };
olayRoutes._durum = () => ({ hizAnahtarlari: [..._hiz.keys()], tekrarAnahtarlari: [..._tekrar.keys()], gun: { ..._gun } });
olayRoutes.SINIRLAR = { DAKIKA_SINIR, SAAT_SINIR, TEKRAR_MS };
olayRoutes._istemciIp = istemciIp;
module.exports = olayRoutes;
