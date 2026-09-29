// 購入者向け CSV テンプレートと架空サンプルを生成（アプリの取込定義から作るので列名が一致する）
import fs from 'node:fs';
import { FIELDS, templateCsv, toCsv, type ImportKind } from '../src/server/services/csv.js';
const dir = 'docs/buyer/csv';
for (const k of Object.keys(FIELDS) as ImportKind[]) fs.writeFileSync(`${dir}/テンプレート_${k}.csv`, templateCsv(k));
const h = (k: ImportKind) => FIELDS[k].map((f) => f.label);
fs.writeFileSync(`${dir}/サンプル_仕入先.csv`, toCsv(h('suppliers'), [['SUP-A', 'サンプル衣料卸（架空）', '山田', '', 14, ''], ['SUP-B', 'サンプル雑貨商会（架空）', '', '', 7, '']]));
fs.writeFileSync(`${dir}/サンプル_保管場所.csv`, toCsv(h('locations'), [['SHELF-A', '棚A', '通常', ''], ['EVENT', 'イベントケース', '通常', '出店用'], ['HOLD', '検品保留箱', '保留', '返品・破損の一時保管']]));
fs.writeFileSync(
  `${dir}/サンプル_商品.csv`,
  toCsv(h('skus'), [
    ['TS-BK-M', 'Tシャツ', 'Tシャツ', '黒', 'M', '', '衣料', '', '個', 'SUP-A', '', 5, 10, 30, 0, 5, '', '2000000000015'],
    ['TS-BK-L', 'Tシャツ', 'Tシャツ', '黒', 'L', '', '衣料', '', '個', 'SUP-A', '', 5, 10, 30, 0, 5, '', ''],
    ['MG-WH', 'マグカップ', 'マグカップ', '白', '', '', '雑貨', '', '個', 'SUP-B', '', 3, 5, 12, 0, 6, '', ''],
    ['ST-001', 'ステッカー', 'ステッカー', '', '', '', '紙もの', '', '枚', 'SUP-B', '', '', '', '', '', '', '', ''],
  ]),
);
fs.writeFileSync(`${dir}/サンプル_初期在庫.csv`, toCsv(h('initial_stock'), [['TS-BK-M', 'SHELF-A', 5], ['TS-BK-L', 'SHELF-A', 18], ['MG-WH', 'SHELF-A', 10], ['ST-001', 'SHELF-A', 120]]));
fs.writeFileSync(`${dir}/サンプル_発注下書き.csv`, toCsv(h('po_drafts'), [['SUP-A', 'TS-BK-M', 25, 'SHELF-A', '2026-10-20', ''], ['SUP-B', 'MG-WH', 12, 'SHELF-A', '', '']]));
fs.writeFileSync(
  `${dir}/サンプル_入出庫履歴.csv`,
  toCsv(h('movements'), [
    ['EX-0001', '場所移動', '2026-10-01', 'ST-001', 'SHELF-A', 'EVENT', 20, '', '', ''],
    ['EX-0002', '出庫', '2026-10-02', 'ST-001', 'EVENT', '', 8, '販売', '', 'EVENT-10-02'],
    ['EX-0003', '発注外入庫', '2026-10-03', 'MG-WH', 'SHELF-A', '', 2, '', '展示品を戻した', ''],
  ]),
);
console.log('ok');
