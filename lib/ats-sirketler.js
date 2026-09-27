/**
 * server/lib/ats-sirketler.js — ONERILEN sirket panolari (yol haritasi madde 5,
 * adim 2, K67).
 *
 * KAYNAK. 26 Eylul 2026'da web aramasiyla 31 aday toplandi (Vancouver/BC,
 * tedarik zinciri ve depo odakli) ve Railway'den yoklandi (K65). Bu listede
 * YALNIZCA yoklamada ilan donduren 29 sirket var. Cikarilanlar (404):
 * `ibkr` (Greenhouse), `efm-warehousing` (Workable).
 *
 * GORUNEN AD. Greenhouse ve Workable sirket adini cevapta veriyor; Lever
 * vermiyor (yalnizca kod: "arcteryx.com"). `ad` alani ekranda gorunen ad;
 * Greenhouse/Workable'da cevaptaki ad varsa o kullanilir.
 *
 * YENIDEN DOGRULAMA. Panolar kapanabilir, kod degisebilir. Admin
 * `GET /api/v1/admin/ats-dogrula` bu listeyi yeniden yoklar; 404 donen sirket
 * buradan cikarilir. `dogrulandi` son yoklama tarihi.
 *
 * KONUM. Listede BC disinda da ilani cok olan sirketler var (Twilio, StockX,
 * SupplyHouse...). Onlari cikarmiyoruz: konum kademesi (K66) kullanicinin
 * konumuna uzak ilanlari varsayilanda gizliyor.
 */

'use strict';

const DOGRULANDI = '2026-09-26';

const ONERILEN = [
  // Greenhouse (8)
  { platform: 'greenhouse', kod: 'asana', ad: 'Asana' },
  { platform: 'greenhouse', kod: 'vaco', ad: 'Vaco' },
  { platform: 'greenhouse', kod: 'lush', ad: 'Lush Handmade Cosmetics' },
  { platform: 'greenhouse', kod: 'twilio', ad: 'Twilio' },
  { platform: 'greenhouse', kod: 'stockx', ad: 'StockX' },
  { platform: 'greenhouse', kod: 'flexport', ad: 'Flexport' },
  { platform: 'greenhouse', kod: 'supplyhouse', ad: 'SupplyHouse.com' },
  { platform: 'greenhouse', kod: 'unybrands', ad: 'unybrands' },
  // Lever (9): ad cevapta YOK, burada tutuluyor
  { platform: 'lever', kod: 'arcteryx.com', ad: "Arc'teryx" },
  { platform: 'lever', kod: 'paralleldomain', ad: 'Parallel Domain' },
  { platform: 'lever', kod: 'badge-group', ad: 'Badge' },
  { platform: 'lever', kod: 'matchgroup', ad: 'Match Group' },
  { platform: 'lever', kod: 'invinity', ad: 'Invinity Energy Systems' },
  { platform: 'lever', kod: 'voltus', ad: 'Voltus' },
  { platform: 'lever', kod: 'minesense', ad: 'MineSense' },
  { platform: 'lever', kod: 'knix', ad: 'Knix' },
  { platform: 'lever', kod: 'Black-White-Zebra', ad: 'Black & White Zebra' },
  // Workable (12)
  { platform: 'workable', kod: 'veritree', ad: 'veritree' },
  { platform: 'workable', kod: 'novacom', ad: 'Novacom Building Partners' },
  { platform: 'workable', kod: 'bardel-entertainment', ad: 'Bardel Entertainment' },
  { platform: 'workable', kod: 'export-development-canada', ad: 'Export Development Canada' },
  { platform: 'workable', kod: 'keycafe', ad: 'Keycafe' },
  { platform: 'workable', kod: 'joey-restaurants-1', ad: 'JOEY Restaurants' },
  { platform: 'workable', kod: 'cobs-bread-2', ad: 'COBS Bread' },
  { platform: 'workable', kod: 'doman-building-materials', ad: 'Doman Building Materials' },
  { platform: 'workable', kod: 'woodfibre-management-limited', ad: 'Pacific Energy Canada' },
  { platform: 'workable', kod: 'now-courier', ad: 'NOW Courier' },
  { platform: 'workable', kod: 'spt-labtech', ad: 'SPT Labtech' },
  { platform: 'workable', kod: 'silver-hills-bakery', ad: 'Silver Hills Bakery' },
];

module.exports = { ONERILEN, DOGRULANDI };
