/**
 * server/lib/kelime-eslesme.js — "Bu terim bu belgede geciyor mu?"
 *
 * NEDEN VAR. 19 Eylul 2026'da uretimde olculdu. ATS puani sayfasi ekrana on
 * tane "eslesen anahtar kelime" bastu ve ikisi kullanicinin CV'sinde HIC
 * gecmiyordu:
 *
 *   KPIs                   CV'de gecis sayisi: 0
 *   quantitative research  CV'de gecis sayisi: 0   <- ILANDAN geliyor
 *
 * Ilanda "Proven quantitative research and analytical techniques" yaziyordu.
 * Yani model, isverenin ARADIGI terimi adayin SAHIP OLDUGU terim gibi
 * listeledi ve puan sisti. Sistem isteminde bunu yasaklayan EVIDENCE RULES
 * bolumu VARDI; model uymadi.
 *
 * K32'nin siniri buydu: testler kuralin istemde DURDUGUNU kilitler, modelin
 * ona UYDUGUNU kilitleyemez. O yuzden burada modele guvenmek yerine
 * DOGRULUYORUZ: iki belge de elimizde, bakmak bedava.
 *
 * KAPSAM SINIRI, bilerek. Bu dosya yalnizca "terim belgede geciyor mu"
 * sorusuna cevap verir. "Adayin bu deneyimi var mi" sorusuna DEGIL.
 * Olcum sirasinda cikan ornek: "demand planning" CV'de geciyor, ama
 * "Demand Planning Professional Certificate" adinda. Suzgec bunu eslesme
 * sayar ve bu DOGRU; kural "CV'de geciyor mu" diyor. Ayrimi bir metin
 * suzgeci yapamaz, yapmaya calismasi da yeni bir yalan turu uretir.
 *
 * YANLIS SILME RISKI OLCULDU (19 Eylul 2026, kullanicinin gercek CV'si):
 * 33 vaka, 14'u zor ornek (ERP, SAP, "Power BI dashboards", "stakeholder
 * management", "inventory accuracy"). Ilk surum 33/33 dogru siniflandirdi,
 * AMA bu kismen tesadufu: "root cause analysis" ancak CV'nin BASKA bir
 * yerinde "Data Analysis" gectigi icin kurtulmustu. Kisaltilmis bir CV ile
 * calisan test bunu hemen yakaladi ve olcut izVar() ile gevsetildi.
 */

'use strict';

/**
 * Karsilastirma icin normalize eder.
 * Buyuk/kucuk harf, noktalama ve fazla bosluk atilir. Turkce harfler,
 * nokta, arti, diyez ve tire KORUNUR: "Power BI", "C++", "C#", "S/4HANA",
 * "data-driven" gibi terimler bozulmasin.
 */
function normalle(metin) {
  return String(metin == null ? '' : metin)
    .toLowerCase()
    // Turkce noktali I: 'I'.toLowerCase() -> 'i' + U+0307 (birlesen nokta).
    // Karakter sinifina girmedigi icin bosluga donuyor ve "Iliskileri"
    // ikiye bolunuyordu; yani Turkce terimler sessizce parcalaniyordu.
    .replace(/\u0307/g, '')
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9ğüşıöç+#./ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Kaba bir Ingilizce tekillestirme. Yalnizca cogul ekini duşurur. */
function tekille(kelime) {
  return kelime
    // 'processes' -> 'proce' veriyordu: eski desen 'sses' ekini butunuyle
    // siliyordu, 'boxes' -> 'bo'. Dogrusu 'es' ekini s/x/z/ch/sh'den SONRA
    // atmak, ve son 's'yi yalnizca 'ss' degilse dusurmek.
    .replace(/ies$/, 'y')
    .replace(/(s|x|z|ch|sh)es$/, '$1')
    .replace(/([^s])s$/, '$1');
}

/**
 * Bir kelimenin olasi tekil bicimleri.
 *
 * NEDEN LISTE, tek bir cevap degil. Ingilizce'de "-ses" eki iki farkli
 * seyden gelebilir ve ayrimi ancak sozluk yapar:
 *   "processes" = "process" + es     -> tekil "process"
 *   "causes"    = "cause"   + s      -> tekil "cause"
 * Tek kurala baglayan surum "causes"i "caus" yapiyordu ve "root cause
 * analysis" eslesmesi sessizce kayboluyordu. Tahmin etmek yerine ikisini de
 * uretip kumeye koyuyoruz: yanlis aday hicbir belgede gecmeyecegi icin
 * zararsiz, dogru aday isini goruyor.
 */
function tekilAdaylari(kelime) {
  const a = new Set([kelime]);
  if (/ies$/.test(kelime))                 a.add(kelime.replace(/ies$/, 'y'));
  if (/(s|x|z|ch|sh)es$/.test(kelime))     a.add(kelime.replace(/(s|x|z|ch|sh)es$/, '$1'));
  // Bu kural "causes" -> "cause" isini de goruyor ('e' + 's'), o yuzden
  // ayri bir 'ses' kurali gereksiz. Mutasyon testinde fark edildi:
  // ayri kurali silmek hicbir testi dusurmedi, cunku olu koddu.
  if (/[^s]s$/.test(kelime))               a.add(kelime.slice(0, -1));
  return [...a].filter(Boolean);
}

/**
 * Belgedeki KELIMELERIN kumesi (tekil halleriyle birlikte).
 *
 * NEDEN VAR. Uretimde goruldu (19 Eylul 2026): ekranda "Google Drive"
 * eslesen anahtar kelime olarak cikti. Kullanicinin CV'sinde "Drive"
 * kelimesi HIC gecmiyor; eslesmenin sebebi "data-driven" icindeki "drive"
 * parcasiydi. Yani kelime kelime karsilastirma, kelimeleri BASKA
 * KELIMELERIN ICINDE ariyordu.
 *
 * Ayni tuzak "art" -> "start", "ai" -> "email", "R" -> her yerde.
 * Cozum: kelime kelime kademesi artik TAM KELIME ariyor.
 */
function kelimeSeti(belgeNorm) {
  const küme = new Set();
  const ekle = (w) => { for (const a of tekilAdaylari(w)) küme.add(a); };
  for (const w of belgeNorm.split(/[^a-z0-9ğüşıöç+#.\/-]+/)) {
    if (!w) continue;
    ekle(w);
    // "data-driven" hem butun hem parcalariyla girsin: tire ile birlesik
    // yazilan terimler iki bicimde de gecebiliyor.
    if (w.includes('-')) for (const p of w.split('-')) if (p) ekle(p);
  }
  return küme;
}

/**
 * `terim` normalize edilmis `belge` icinde geciyor mu?
 *
 * Uc kademe, en katidan en hosgorulüye:
 *   1. birebir        "reconciliation" -> "reconcile inventory discrepancies"? hayir
 *   2. tekil hali     "dashboards" -> "dashboard"
 *   3. kelime kelime  "Power BI dashboards" -> "power bi" + "dashboard" ayri ayri
 *
 * Ucuncu kademe yalnizca COK KELIMELI terimler icin ve yalnizca uc harften
 * uzun kelimeler sayilir; yoksa "of", "in" gibi kelimeler her belgede bulunur
 * ve suzgec anlamsizlasir.
 *
 * @returns {{gecer: boolean, yol: string|null}}
 */
function terimGecer(terim, belgeNorm) {
  const t = normalle(terim);
  if (!t) return { gecer: false, yol: null };

  if (belgeNorm.includes(t)) return { gecer: true, yol: 'birebir' };

  const tek = tekille(t);
  if (tek !== t && tek.length >= 3 && belgeNorm.includes(tek)) {
    return { gecer: true, yol: 'tekil' };
  }

  // Kelime kelime: TAM KELIME arar. Alt dize aramasi "Google Drive"i
  // "data-driven" uzerinden eslestirmisti.
  const kelimeler = t.split(' ').filter((w) => w.length > 2);
  if (kelimeler.length > 1) {
    const küme = kelimeSeti(belgeNorm);
    if (kelimeler.every((w) => tekilAdaylari(w).some((a) => küme.has(a)))) {
      return { gecer: true, yol: 'kelime kelime' };
    }
  }

  return { gecer: false, yol: null };
}

/**
 * Terimin belgede HIC IZI var mi? ("iz" = anlamli kelimelerinden en az biri)
 *
 * BU BIR HOSGORU DEGIL, GUVENLIK PAYI. Testte yakalandi: "root cause
 * analysis" terimi, CV'de "identify root causes of inventory errors" yazdigi
 * halde eleniyordu, cunku o cumlede "analysis" kelimesi gecmiyor. Yani
 * kullaniciya SAHIP OLDUGU bir beceriyi "eksik" diye gosterecektik.
 *
 * Iki hata turu esit degil:
 *   uydurma eslesmeyi BIRAKMAK -> puan bir miktar sisik kalir (bugunku hal)
 *   gercek eslesmeyi SILMEK    -> kullaniciya yalan soyleriz; kendi CV'sine
 *                                 bakar, bizim yanildigimizi gorur ve urune
 *                                 guvenmeyi birakir
 *
 * Bu yuzden yalnizca ACIKCA uydurma olanlar eleniyor: terimin HICBIR anlamli
 * kelimesi CV'de gecmiyorsa. Uretimde gorulen iki vaka da bu olcute takiliyor
 * ("KPIs", "quantitative research"), ama kismi destegi olan hicbir terim
 * silinmiyor.
 *
 * BEDELI KAYITLI: "process automation" gibi, yalnizca yaygin bir kelimesi
 * ("process") CV'de gecen terimler eleme disi kalir. Bilerek kabul edilen bir
 * kacak; alternatifi gercek bir beceriyi silmek.
 */
function izVar(terim, belgeNorm) {
  const t = normalle(terim);
  if (!t) return false;
  const kelimeler = t.split(' ').filter((w) => w.length > 2);
  if (!kelimeler.length) return belgeNorm.includes(t);
  const küme = kelimeSeti(belgeNorm);
  const bulunan = kelimeler.filter((w) => tekilAdaylari(w).some((a) => küme.has(a))).length;
  // YARIDAN COGU. "en az biri" cok gevsekti: "Google Drive" yalnizca
  // "Google" yuzunden, "statistical analysis" yalnizca "analysis" yuzunden
  // kaliyordu. Tam yari da yetmez, cunku iki kelimelik terimlerin yarisi
  // tek kelimedir ve o kelime cogu zaman genel olandir ("data", "google").
  return bulunan * 2 > kelimeler.length;
}

/**
 * Modelin "eslesti" dedigi terimleri CV'ye karsi dogrular.
 *
 * Dogrulanamayan bir terim iki gruba ayrilir:
 *   - ILANDA geciyorsa  -> gercekten EKSIK bir nitelik, eksik listesine tasinir
 *   - hicbirinde yoksa  -> ne CV'den ne ilandan; tamamen uydurma, atilir
 *
 * Ayrim onemli: ilki kullaniciya ise yarar bir bilgi ("bunu istiyorlar,
 * sende yok"), ikincisi yalnizca gurultudur.
 *
 * @returns {{eslesen: string[], eksik: string[], elenen: string[], atilan: string[]}}
 */
function eslesmeleriDogrula(eslesenHam, eksikHam, cvMetni, ilanMetni) {
  const cv   = normalle(cvMetni);
  const ilan = normalle(ilanMetni);

  const dizi = (x) => (Array.isArray(x) ? x : []).filter((s) => typeof s === 'string' && s.trim());

  const eslesen = [];
  const elenen  = [];   // CV'de yok, ilanda var -> eksige tasindi
  const atilan  = [];   // ikisinde de yok -> tamamen atildi

  for (const terim of dizi(eslesenHam)) {
    // Kati olcut: terim gercekten geciyor mu.
    if (terimGecer(terim, cv).gecer) { eslesen.push(terim); continue; }
    // Gecmiyor ama KISMI izi var: SILMIYORUZ. Gerekce izVar()'da.
    if (izVar(terim, cv))            { eslesen.push(terim); continue; }
    // Hicbir izi yok: acikca uydurma.
    if (terimGecer(terim, ilan).gecer || izVar(terim, ilan)) elenen.push(terim);
    else atilan.push(terim);
  }

  // Eksik listesine tasirken YINELEME yapma.
  const eksik = dizi(eksikHam).slice();
  const varOlan = new Set(eksik.map((x) => normalle(x)));
  for (const terim of elenen) {
    if (!varOlan.has(normalle(terim))) { eksik.push(terim); varOlan.add(normalle(terim)); }
  }

  return { eslesen, eksik, elenen, atilan };
}

module.exports = { normalle, tekille, tekilAdaylari, kelimeSeti, terimGecer, izVar, eslesmeleriDogrula };
