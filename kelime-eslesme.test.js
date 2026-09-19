/**
 * kelime-eslesme.test.js — "Eslesti" demek yetmez, BAKARIZ.
 *
 * Calistir: node --test "*.test.js" "lib/*.test.js" "middleware/*.test.js"
 *
 * NEDEN VAR. 19 Eylul 2026'da uretimde olculdu. ATS sayfasi on tane
 * "eslesen anahtar kelime" gosterdi; ikisi kullanicinin CV'sinde HIC
 * gecmiyordu:
 *
 *   KPIs                   CV'de gecis: 0
 *   quantitative research  CV'de gecis: 0   <- ILANDAN geliyor
 *
 * Istemde bunu yasaklayan EVIDENCE RULES bolumu VARDI. Model uymadi ve puan
 * sisti. K32'nin siniri tam burasi: kuralin istemde DURDUGUNU kilitleyebiliriz,
 * modelin UYDUGUNU kilitleyemeyiz.
 *
 * IKI YONLU RISK. Uydurma bir eslesmeyi birakmak puani sisirir; gercek bir
 * eslesmeyi silmek kullaniciya sahip oldugu beceriyi eksik gosterir. Ikincisi
 * daha sinsi, cunku kullanici kendi CV'sine bakip "ama bu bende var" der ve
 * urune guvenmeyi birakir. Bu yuzden asagidaki B bolumu ZOR ornekleri
 * kilitliyor: CV'de bicim olarak FARKLI gecen gercek eslesmeler.
 */

const { test } = require('node:test');
const assert   = require('node:assert');

const { normalle, tekille, tekilAdaylari, terimGecer, izVar, eslesmeleriDogrula } = require('./lib/kelime-eslesme');

/** Kullanicinin gercek CV'sinden alinmis, kisaltilmis bir ornek. */
const CV = `
AKIN KURT
SKILLS SUMMARY
- Languages: Python, SQL, R
- Tools: Power BI, Excel, Word, PowerPoint, Tableau, MySQL, SQLite
- Platforms: AccellosOne WMS - Warehouse Management System, Using inventory
  replenishment systems (ERP), Freshdesk, PyCharm, Jupyter Notebook
- Soft Skills: Rapport Building, Strong Stakeholder management
WORK EXPERIENCE
Inventory Control Specialist, Containerworld, September 2022 to Present
- Conduct and verify inventory checks to ensure accuracy of stock records
- Investigate and identify root causes of inventory errors
- Reconcile inventory discrepancies by liaising with clients
- Coordinate and execute physical inventory count
- Perform ongoing stock control to maintain inventory accuracy
PROJECTS
Inventory Optimization Dashboard: interactive dashboard using Power BI
Metadata Cleaning for E-commerce: Python and Pandas data cleaning, 100K+ rows
CERTIFICATES
Demand Planning Professional Certificate
SAP S/4HANA: Beyond the Basics
Google Analytics 4 Certification
Lean Six Sigma Foundations
`;

const ILAN = `
We are hiring an Inventory Analyst. Proven quantitative research and analytical
techniques. Experience with Salesforce dashboards, Airtable and CRM tools.
KPIs and benchmarking. Knowledge of process automation and data infrastructure.
`;

// ── A: uydurma eslesmeler ELENIYOR ─────────────────────────────────────────

test('A1: CV\'de hic gecmeyen terim eslesen sayilmiyor', () => {
  const cv = normalle(CV);
  assert.strictEqual(terimGecer('KPIs', cv).gecer, false);
  assert.strictEqual(terimGecer('quantitative research', cv).gecer, false);
  assert.strictEqual(terimGecer('Salesforce', cv).gecer, false);
  assert.strictEqual(terimGecer('Airtable', cv).gecer, false);
  assert.strictEqual(terimGecer('Oracle', cv).gecer, false);
});

test('A2: ILANDA gecen ama CV\'de olmayan terim EKSIGE tasiniyor', () => {
  // Kullaniciya ise yarayan bilgi bu: "bunu istiyorlar, sende yok".
  const r = eslesmeleriDogrula(['Python', 'quantitative research'], [], CV, ILAN);
  assert.deepStrictEqual(r.eslesen, ['Python']);
  assert.deepStrictEqual(r.elenen, ['quantitative research']);
  assert.ok(r.eksik.includes('quantitative research'), 'eksik listesine tasinmamis');
  assert.deepStrictEqual(r.atilan, []);
});

test('A3: HICBIR belgede olmayan terim ATILIYOR, eksige yazilmiyor', () => {
  // Ne CV'de ne ilanda olan bir terim yalnizca gurultudur; "eksik nitelik"
  // diye gostermek kullaniciya olmayan bir gereklilik uydurmak olur.
  const r = eslesmeleriDogrula(['BlockchainXYZ'], [], CV, ILAN);
  assert.deepStrictEqual(r.eslesen, []);
  assert.deepStrictEqual(r.elenen, []);
  assert.deepStrictEqual(r.atilan, ['BlockchainXYZ']);
  assert.deepStrictEqual(r.eksik, [], 'uydurma terim eksik listesine sizdi');
});

test('A4: eksik listesinde YINELEME olusmuyor', () => {
  const r = eslesmeleriDogrula(['Salesforce'], ['salesforce'], CV, ILAN);
  assert.strictEqual(r.eksik.length, 1, `yinelendi: ${r.eksik.join(', ')}`);
});

// ── B: GERCEK eslesmeler silinmiyor (yanlis silme riski) ───────────────────

test('B1: bicimi farkli gecen gercek eslesmeler KATI olcutten geciyor', () => {
  const cv = normalle(CV);
  const zor = [
    ['ERP', 'birebir'],                    // CV: "systems (ERP)" -> parantez normalize edilir
    ['SAP', 'birebir'],                    // CV: "SAP S/4HANA"
    ['Tableau', 'birebir'],
    ['inventory accuracy', 'birebir'],
    ['warehouse management', 'birebir'],   // CV: "Warehouse Management System"
    ['stakeholder management', 'birebir'],
    ['Power BI dashboards', 'kelime kelime'],
    ['inventory replenishment', 'birebir'],
    ['physical inventory', 'birebir'],
    ['Six Sigma', 'birebir'],
    ['Google Analytics', 'birebir'],
    ['data cleaning', 'birebir'],
  ];
  const silinen = [];
  for (const [terim, beklenenYol] of zor) {
    const r = terimGecer(terim, cv);
    if (!r.gecer) silinen.push(terim);
    else assert.strictEqual(r.yol, beklenenYol, `${terim} baska yoldan gecti: ${r.yol}`);
  }
  assert.deepStrictEqual(silinen, [], `YANLIS SILME: ${silinen.join(', ')}`);
});

test('B1b: KATI olcutten gecmeyen ama izi olan terim SILINMIYOR', () => {
  // BU TESTI YAZARKEN KUSUR BULDUM, uretimde degil. Kisaltilmis CV'de
  // "identify root causes of inventory errors" yaziyor ama "analysis"
  // kelimesi o cumlede gecmiyor. Kati olcut "root cause analysis"i eliyordu:
  // kullaniciya SAHIP OLDUGU beceriyi eksik gosterecektik.
  //
  // Ilk olcumde 33/33 cikmasi kismen tesadufmus: tam CV'nin baska bir
  // yerinde "Data Analysis" geciyordu ve terim oradan kurtuluyordu.
  const cv = normalle(CV);
  assert.strictEqual(terimGecer('root cause analysis', cv).gecer, false, 'kati olcut degismis');
  assert.strictEqual(izVar('root cause analysis', cv), true, 'kismi iz gorulmuyor');

  const r = eslesmeleriDogrula(['root cause analysis'], [], CV, ILAN);
  assert.deepStrictEqual(r.eslesen, ['root cause analysis'], 'gercek beceri silindi');
  assert.deepStrictEqual(r.elenen, []);
});

test('B1c: hicbir izi olmayan terim ELENIYOR', () => {
  // izVar bir hosgoru, ama sinirsiz degil: uretimde gorulen iki vaka hala
  // takiliyor.
  const cv = normalle(CV);
  assert.strictEqual(izVar('quantitative research', cv), false);
  assert.strictEqual(izVar('KPIs', cv), false);
  assert.strictEqual(izVar('Salesforce', cv), false);
});

test('B2: cogul eki eslesmeyi bozmuyor', () => {
  assert.strictEqual(terimGecer('dashboards', normalle(CV)).gecer, true);
  assert.strictEqual(terimGecer('projects', normalle('PROJECTS')).gecer, true);
  assert.strictEqual(tekille('dashboards'), 'dashboard');
  assert.strictEqual(tekille('capabilities'), 'capability');
  // Bu iki satir testte yakalanan bir kusurun kaydi: eski desen 'sses' ekini
  // butunuyle siliyordu.
  assert.strictEqual(tekille('processes'), 'process', "'proce' donuyordu");
  assert.strictEqual(tekille('boxes'), 'box', "'bo' donuyordu");
  assert.strictEqual(tekille('class'), 'class', 'tekil kelimenin sonu yendi');
});

test('B4: Turkce noktali I terimi BOLMUYOR', () => {
  // 'I'.toLowerCase() 'i' + U+0307 verir; birlesen nokta karakter sinifina
  // girmedigi icin bosluga donuyor ve "Iliskileri" ikiye boluniyordu.
  assert.strictEqual(normalle('Müşteri İlişkileri'), 'müşteri ilişkileri');
  assert.strictEqual(terimGecer('İlişki', normalle('Müşteri İlişkileri')).gecer, true);
});

test('B3: sertifika ADI da eslesme sayilir ve bu BILEREK boyle', () => {
  // Olcum sirasinda cikti: "demand planning" CV'de var ama
  // "Demand Planning Professional Certificate" adinda. Kural "CV'de geciyor
  // mu" diyor, "deneyimi var mi" demiyor. Ayrimi bir metin suzgeci yapamaz;
  // yapmaya calismak yeni bir yalan turu uretir.
  assert.strictEqual(terimGecer('demand planning', normalle(CV)).gecer, true);
});

test('B5: kelime BASKA KELIMENIN ICINDE aranmiyor', () => {
  // URETIMDE GORULDU (19 Eylul 2026). Ekranda "Google Drive" eslesen anahtar
  // kelime olarak cikti. Kullanicinin CV'sinde "Drive" kelimesi HIC gecmiyor;
  // eslesmenin sebebi "data-driven" icindeki "drive" parcasiydi.
  //
  // Ayni tuzak: "art" -> "start", "ai" -> "email", "cv" -> "recover".
  const cv = normalle('Data-Driven Decisions, Google Analytics');
  assert.strictEqual(terimGecer('Google Drive', cv).gecer, false,
    '"drive" kelimesi "data-driven" icinden eslesti');
  // Gercek olanlar bozulmadi:
  assert.strictEqual(terimGecer('Google Analytics', cv).gecer, true);
  assert.strictEqual(terimGecer('data-driven decisions', cv).gecer, true);
});

test('B6: iz olcutu YARIDAN COGU, "en az biri" degil', () => {
  // Ilk surum "en az bir kelime" diyordu ve cok gevsekti: "Google Drive"
  // yalnizca "Google" yuzunden, "statistical analysis" yalnizca "analysis"
  // yuzunden kaliyordu. Iki kelimelik bir terimin yarisi tek kelimedir ve o
  // kelime cogu zaman genel olandir ("data", "google", "analysis").
  const cv = normalle(CV);
  assert.strictEqual(izVar('Google Drive', cv), false, '1/2 yeterli sayildi');
  assert.strictEqual(izVar('statistical analysis', cv), false, '1/2 yeterli sayildi');
  assert.strictEqual(izVar('process automation', cv), false, '1/2 yeterli sayildi');
  // Ama 2/3 hala yeterli: guvenlik payi duruyor.
  assert.strictEqual(izVar('root cause analysis', cv), true, 'guvenlik payi kayboldu');
});

test('B7: tireli yazim iki bicimde de esleşiyor', () => {
  // Ilan "data driven decision making" yazar, CV "Data-Driven Decisions"
  // yazar. Ikisi ayni sey; tire yuzunden eslesmemek sessiz bir kayip olurdu.
  const cv = normalle('Data-Driven Decisions, Power BI');
  assert.strictEqual(terimGecer('data driven', cv).gecer, true, 'tireli yazim bolunmuyor');
  assert.strictEqual(terimGecer('data-driven', cv).gecer, true);
  // Ama tire parcasi hala TAM KELIME: "drive" tek basina eslesmemeli.
  assert.strictEqual(terimGecer('Google Drive', normalle('Data-Driven, Google Analytics')).gecer,
    false, '"drive" parcasi "driven" icinden eslesti');
});

test('B8: tekil adaylari HEM "process" HEM "cause" bicimini uretiyor', () => {
  // Ingilizce'de "-ses" iki farkli ekten gelir ve ayrimi sozluk yapar:
  //   processes = process + es      causes = cause + s
  // Tek kurala baglayan surum "causes"i "caus" yapiyordu ve "root cause
  // analysis" eslesmesi sessizce kayboluyordu. Tahmin yerine ikisi de
  // uretiliyor; yanlis aday hicbir belgede gecmeyecegi icin zararsiz.
  assert.ok(tekilAdaylari('causes').includes('cause'), '"cause" adayi uretilmiyor');
  assert.ok(tekilAdaylari('processes').includes('process'), '"process" adayi uretilmiyor');
  assert.ok(tekilAdaylari('boxes').includes('box'));
  assert.ok(tekilAdaylari('capabilities').includes('capability'));
  assert.ok(tekilAdaylari('class').includes('class'), 'tekil kelime bozuldu');
});

// ── C: suzgecin kendisi anlamsizlasmiyor ───────────────────────────────────

test('C1: kisa kelimeler kelime kelime eslesmeyi bozmuyor', () => {
  // "of", "in", "to" her belgede bulunur, ustelik BASKA KELIMELERIN ICINDE
  // de bulunur ("in" -> "programming"). Ucten kisa kelimeler sayilmazsa bir
  // terim yalnizca baglaclari sayesinde eslesebilir.
  const cv = normalle('the art of inventory');
  assert.strictEqual(terimGecer('art of war', cv).gecer, false, 'suzgec anlamsizlasmis');

  // AYIRT EDICI VAKA. Mutasyon testinde `length > 2` suzgecini kaldirdim ve
  // yukaridaki satir bunu yakalayamadi ("war" zaten yoktu). Bu vakada
  // terimin BUTUN kisa kelimeleri belgede bulunur ve tek anlamli kelimesi
  // tek basinadir: suzgec olmadan gecer, suzgecle gecmez.
  const belge = normalle('Python, SQL, R programming');
  assert.strictEqual(terimGecer('SQL in R', belge).gecer, false,
    'terim yalnizca baglaclari sayesinde eslesti');
  // Ayni belgede gercek terim yine geciyor:
  assert.strictEqual(terimGecer('SQL', belge).gecer, true);
});

test('C2: tek kelimelik terim kelime kelime yolunu kullanamaz', () => {
  // Tek kelime icin "tum kelimeler var" demek "birebir var" ile aynidir;
  // ayri bir yol acmak yalnizca hosgoruyu gevsetir.
  const r = terimGecer('Airtable', normalle('Air table'));
  assert.strictEqual(r.gecer, false);
});

test('C3: bos ve bozuk girdiler patlamiyor', () => {
  const cv = normalle(CV);
  for (const x of ['', '   ', null, undefined, 123, {}, []]) {
    assert.strictEqual(terimGecer(x, cv).gecer, false, `patladi ya da gecti: ${JSON.stringify(x)}`);
  }
  const r = eslesmeleriDogrula(null, undefined, CV, ILAN);
  assert.deepStrictEqual(r.eslesen, []);
  assert.deepStrictEqual(r.eksik, []);
});

test('C4: normalizasyon teknik terimleri BOZMUYOR', () => {
  // Nokta, arti, diyez, tire ve egik cizgi korunmali: "C++", "C#",
  // "S/4HANA", "data-driven", "node.js" ayri terimler.
  assert.strictEqual(normalle('C++'), 'c++');
  assert.strictEqual(normalle('C#'), 'c#');
  assert.strictEqual(normalle('Node.js'), 'node.js');
  assert.strictEqual(normalle('data-driven'), 'data-driven');
  assert.strictEqual(normalle('SAP S/4HANA'), 'sap s/4hana');
  assert.strictEqual(normalle('Müşteri İlişkileri'), 'müşteri ilişkileri');
});

// ── D: butun senaryo ───────────────────────────────────────────────────────

test('D1: uretimde gorulen vaka bastan sona dogru sonuclaniyor', () => {
  const eslesenHam = ['Python', 'SQL', 'Excel', 'Power BI', 'data cleaning',
                      'dashboard', 'data analysis', 'KPIs', 'inventory data',
                      'quantitative research'];
  const r = eslesmeleriDogrula(eslesenHam, ['Salesforce', 'Airtable'], CV, ILAN);

  assert.ok(!r.eslesen.includes('KPIs'), 'KPIs hala eslesen sayiliyor');
  assert.ok(!r.eslesen.includes('quantitative research'), 'ilandan gelen terim hala eslesen');
  for (const k of ['Python', 'SQL', 'Excel', 'Power BI', 'data cleaning', 'dashboard']) {
    assert.ok(r.eslesen.includes(k), `gercek eslesme silindi: ${k}`);
  }
  assert.strictEqual(r.elenen.length, 2, `elenen: ${r.elenen.join(', ')}`);
  assert.ok(r.eksik.includes('KPIs') && r.eksik.includes('quantitative research'));
});
