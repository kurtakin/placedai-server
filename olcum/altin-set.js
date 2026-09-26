/**
 * server/olcum/altin-set.js — ALTIN TEST SETI (26 Eylul 2026, model yonetimi adim 3, K61)
 *
 * Her vaka, canli testte GERCEKTEN yasadigimiz bir tuzaktan geliyor. Bir aday
 * model bu vakalarda mevcut modelden kotu davranirsa gecis yapilmaz.
 *
 * KURAL: Buradaki CV, profil ve cevaplar UYDURMA kisilere ait (Deniz Arslan,
 * Northfield Supply). Kullanicinin gercek CV'si asla test verisi olmaz.
 *
 * Yeni vaka eklemek: yeni bir tuzak yasandiginda buraya bir vaka ekle; rota
 * ve govde uretimdeki istegin aynisi, denetim o tuzagin kendisi.
 */

'use strict';

const { yasak, gerekli, enFazla, adet, uydurmaSayi, dogrulanamayanAlinti, tekrarAlinti, kaynaksizRakam } = require('./denetimler');

const CV = `Deniz Arslan
Inventory Analyst, Northfield Supply Co. (2021 - present)
- Ran weekly cycle counts across 3 warehouses
- Cut picking errors by 18% by redesigning bin labels
- Trained 6 new team members on the WMS
Warehouse Associate, Lakeside Foods (2018 - 2021)
- Received and put away inbound shipments
Skills: Excel, SQL, Power BI, SAP WM, forklift certified`;

const PROFIL_SAYISIZ = `Customer support specialist who enjoys solving problems for people. I handle customer emails and calls, help customers track orders and process returns, and work with the warehouse team when something goes wrong. I like clear processes and calm conversations. Currently looking for a customer success role in e-commerce.`;

const TURLAR_KISA = [
  { question: 'How do you usually start your day at work?', answer: 'My email box and customer requests.' },
  { question: 'Tell me about a time you handled an upset customer.', answer: 'A customer called because their order was late for the second time. I listened first, apologized, and checked the tracking with the carrier while they were on the line. I found the parcel was stuck at a depot, so I arranged a replacement to ship the same day and called them back the next morning to confirm it arrived. They thanked me and later left a good review.' },
  { question: 'Why do you want this role?', answer: 'I like helping people and I want to grow into a team lead position where I can improve how we handle returns.' },
];

const HIREVUE = (govde) => ({ platform: 'hirevue', question_type: 'video_behavioral', time_limit: 120, output_language: 'auto', ...govde });
const geriBildirimMetni = (y) => [y.summary, y.strengths, y.improvements, Object.values(y.categories || {}).map((c) => c.comment)];
const TURKCE = /[ğüşıöçĞÜŞİÖÇ]/;

module.exports = [
  // ── HireVue cevap taslagi (K55 eki) ────────────────────────────────────
  {
    id: 'oa-cvsiz', tuzak: 'CV yokken model aday adina olay ve sayi uyduruyordu',
    rota: '/online-assessment', katman: 'hizli',
    govde: HIREVUE({ question: 'Tell me about a time you resolved a disagreement with a coworker.' }),
    denetimler: [
      enFazla('kaynaksiz sayi denemesi', uydurmaSayi, 0),
      // "[number]" sayilmaz: onu model degil kodun denetimi koyuyor (oa-denetim.js)
      gerekli('doldurulacak yer birakilmis', (y) => y.answer_draft, /\[(?!number\])[^\]]{2,}\]/),
    ],
  },
  {
    id: 'oa-cvli', tuzak: 'CV verilince CV\'de olmayan bir olay kurup adayin hikayesi gibi yaziyordu',
    rota: '/online-assessment', katman: 'hizli',
    govde: HIREVUE({ question: 'Describe a time you improved a process at work.', cv_text: CV }),
    denetimler: [
      enFazla('kaynaksiz sayi denemesi', uydurmaSayi, 0),
      gerekli('CV\'deki gercek olayi kullaniyor', (y) => y.answer_draft, /pick|bin label|cycle count/i),
    ],
  },
  {
    id: 'oa-turkce', tuzak: 'Cikti dili sorunun dili olmali (otomatik)',
    rota: '/online-assessment', katman: 'hizli',
    govde: HIREVUE({ question: 'Bir iş arkadaşınızla yaşadığınız bir anlaşmazlığı nasıl çözdüğünüzü anlatın.' }),
    denetimler: [
      gerekli('taslak Turkce', (y) => y.answer_draft, TURKCE),
      enFazla('kaynaksiz sayi denemesi', uydurmaSayi, 0),
    ],
  },
  {
    id: 'oa-kendi-cevap', tuzak: 'Adayin kendi kisa cevabina geri bildirim; sayi uydurmadan',
    rota: '/online-assessment', katman: 'hizli',
    govde: HIREVUE({ question: 'Tell me about a mistake you made and what you learned.', own_answer: 'I once sent a shipment to the wrong store because I did not double check the label. I told my manager right away and now I always scan the label twice.' }),
    denetimler: [
      gerekli('geri bildirim var', (y) => y.feedback && y.feedback.summary, /\S{3,}/),
      enFazla('kaynaksiz sayi denemesi', uydurmaSayi, 0),
    ],
  },

  // ── Sesli deneme mulakati: soru plani (K58) ─────────────────────────────
  {
    id: 'plan-beceri-proje', tuzak: 'CV\'deki beceri (Power BI) ile deneyimi birlestirip olmayan bir proje uydurdu',
    rota: '/mock/plan', katman: 'hizli',
    govde: { role: 'Inventory Analyst', type: 'mixed', level: 'mid', count: 5, language: 'English', cv_text: CV },
    denetimler: [
      adet('istenen soru sayisi', (y) => y.questions, 5),
      yasak('beceriyi proje gibi varsayan soru', (y) => y.questions,
        /\byour\b[^?]{0,80}(power bi[^?]{0,60}(project|dashboard|initiative|report)|(project|dashboard|initiative)[^?]{0,60}power bi)/i),
      yasak('CV\'de olmayan bir basari varsayimi', (y) => y.questions, /\b(you (led|launched|built|implemented|developed)[^?]{0,60}power bi)/i),
    ],
  },
  {
    id: 'plan-cvsiz', tuzak: 'CV verilmeden CV\'den soz eden soru',
    rota: '/mock/plan', katman: 'hizli',
    govde: { role: 'Customer Service Representative', type: 'behavioral', level: 'entry', count: 3, language: 'English' },
    denetimler: [
      adet('istenen soru sayisi', (y) => y.questions, 3),
      yasak('olmayan CV\'ye atif', (y) => y.questions, /\b(your (cv|resume|résumé)|you (mentioned|listed|wrote))\b/i),
    ],
  },
  {
    id: 'plan-turkce', tuzak: 'Mulakat dili Turkce secilince sorular Turkce',
    rota: '/mock/plan', katman: 'hizli',
    govde: { role: 'Depo Sorumlusu', type: 'behavioral', level: 'mid', count: 3, language: 'Turkish' },
    denetimler: [
      adet('istenen soru sayisi', (y) => y.questions, 3),
      gerekli('sorular Turkce', (y) => y.questions, TURKCE),
    ],
  },

  // ── Sesli deneme mulakati: geri bildirim (K58 ekleri) ──────────────────
  {
    id: 'geri-kisa-ilgili', tuzak: 'Kisa ama ilgili cevap "konu disi" sayildi; tek alinti dort kategoriye kanit yapildi',
    rota: '/mock/feedback', katman: 'guclu',
    govde: { role: 'Customer Service Representative', language: 'English', turns: TURLAR_KISA },
    denetimler: [
      yasak('kisa cevap konu disi sayilmis', geriBildirimMetni, /\b(incoherent|irrelevant|off[- ]topic|unrelated|nonsensical|did(n't| not) answer the question)\b/i),
      enFazla('dogrulanamayan alinti', dogrulanamayanAlinti, 0),
      enFazla('ayni alinti birden cok kategoride', tekrarAlinti, 0),
    ],
  },
  {
    id: 'geri-hitap', tuzak: 'Geri bildirim adaya "sen" diye degil "the candidate" diye yazildi',
    rota: '/mock/feedback', katman: 'guclu',
    govde: { role: 'Customer Service Representative', language: 'English', turns: TURLAR_KISA.slice(1) },
    denetimler: [
      yasak('ucuncu sahis hitap', geriBildirimMetni, /\bthe (candidate|interviewee|applicant)\b/i),
      enFazla('dogrulanamayan alinti', dogrulanamayanAlinti, 0),
    ],
  },
  {
    id: 'geri-turkce', tuzak: 'Cikti dili Turkce secilince geri bildirim Turkce, alintilar yine cevaptan',
    rota: '/mock/feedback', katman: 'guclu',
    govde: { role: 'Depo Sorumlusu', language: 'Turkish', turns: [
      { question: 'Bir ekibi zor bir dönemde nasıl motive ettiniz?', answer: 'Yoğun sezonda ekip çok yorgundu. Vardiyaları yeniden planladım, herkese kısa molalar verdim ve her akşam günün sonunda neyin iyi gittiğini birlikte konuştuk. Hata oranı düştü ve kimse sezon ortasında ayrılmadı.' },
      { question: 'Stok sayımında bir fark bulduğunuzda ne yaparsınız?', answer: 'Önce sayımı tekrar ederim, sonra sistemdeki son hareketlere bakarım.' },
    ] },
    denetimler: [
      gerekli('geri bildirim Turkce', (y) => y.summary, TURKCE),
      enFazla('dogrulanamayan alinti', dogrulanamayanAlinti, 0),
    ],
  },

  // ── LinkedIn (K53) ─────────────────────────────────────────────────────
  {
    id: 'li-sayisiz', tuzak: 'Rakamsiz profile model rakam uyduruyordu ("Once 42 -> Sonra 91" sinifi)',
    rota: '/optimize-linkedin', katman: 'guclu',
    govde: { profile_text: PROFIL_SAYISIZ, target_role: 'Customer Success Associate', language: 'auto' },
    denetimler: [
      enFazla('kaynaksiz rakam', kaynaksizRakam, 0),
      gerekli('baslikta hedef rol', (y) => y.headline, /customer success/i),
    ],
  },
  {
    id: 'li-dil', tuzak: 'Ingilizce profil arayuz dili yuzunden Turkceye cevrildi (K39)',
    rota: '/optimize-linkedin', katman: 'guclu',
    govde: { profile_text: PROFIL_SAYISIZ, target_role: 'Customer Success Associate', language: 'auto' },
    denetimler: [
      yasak('Ingilizce profilde Turkce metin', (y) => [y.headline, y.about, y.skills], TURKCE),
    ],
  },
];
