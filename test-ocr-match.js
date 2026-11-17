/* 匹配算法自测（临时脚本，验证后删除） */
const { matchOcrLines, stripQtyForSearch, firstQtyFromText } = require('./ocr-match.js');

const products = [
  { id: 'p1', name: '螺丝' },
  { id: 'p2', name: '螺母' },
  { id: 'p3', name: '垫片' },
];
const specs = [
  { id: 's1', productId: 'p1', name: 'M6×30' },
  { id: 's2', productId: 'p1', name: 'M8×40' },
  { id: 's3', productId: 'p2', name: 'M8' },
  { id: 's4', productId: 'p3', name: '通用垫片' },
];

let pass = 0, fail = 0;
function check(name, lines, expect) {
  const { rows, ignoredCount } = matchOcrLines(lines, specs, products);
  const got = rows.map(r => `${r.kind === 'spec' ? 'S' : r.kind === 'product' ? 'P' : 'N'}:${specs.find(s => s.id === r.specId) ? specs.find(s => s.id === r.specId).name : (r.kind === 'product' ? 'PROD' : r.raw)}${r.qtyGiven ? `=${r.qty}` : `=?(${r.qty})`}`).join(' | ');
  const ok = JSON.stringify(rows.map(r => [r.kind, r.specId || null, r.qty, r.qtyGiven])) === JSON.stringify(expect);
  console.log((ok ? '✓' : '✗') + ' ' + name + '  →  ' + got + (ignoredCount ? `  [忽略${ignoredCount}]` : ''));
  ok ? pass++ : fail++;
}

const S = (id, qty, given) => ['spec', id, qty, given];
const P = qty => ['product', null, qty, true];
const N = raw => ['none', null, 1, false];

check('混合式：螺丝 M6×30 10件，螺母 20个', [{ text: '螺丝 M6×30 10件，螺母 20个' }],
  [S('s1', 10, true), S('s3', 20, true)]);
check('乘号式：M6×30 螺丝 ×10', [{ text: 'M6×30 螺丝 ×10' }],
  [S('s1', 10, true)]);
check('价格干扰：M6×30螺丝 12.5元', [{ text: 'M6×30螺丝 12.5元' }],
  [S('s1', 1, false)]);
check('各N：螺丝 M6×30、M8×40 各20', [{ text: '螺丝 M6×30、M8×40 各20' }],
  [S('s1', 20, true), S('s2', 20, true)]);
check('多规格品名：螺丝100个', [{ text: '螺丝100个' }],
  [P(100)]);
check('OCR易混：M6x30 1O件', [{ text: 'M6x30 1O件' }],
  [S('s1', 10, true)]);
check('全角数字：M６×３０ 10件', [{ text: 'M６×３０ 10件' }],
  [S('s1', 10, true)]);
check('合计行忽略：合计 128元', [{ text: '合计 128元' }],
  []);
check('标题行：螺丝 / M6×30 10件', [{ text: '螺丝' }, { text: 'M6×30 10件' }],
  [S('s1', 10, true)]);
check('纯数量行：螺丝 M6×30 / 10件', [{ text: '螺丝 M6×30' }, { text: '10件' }],
  [S('s1', 10, true)]);
check('日期行忽略：2026-11-05', [{ text: '2026-11-05' }],
  []);
check('干扰项+补单：垫片 ×5，合计 128元', [{ text: '垫片 ×5，合计 128元' }],
  [S('s4', 5, true)]);
// —— 第一行/最后行优化：无数字的问候语、客套话、时间戳自动忽略 ——
check('首行问候语忽略：老板，帮我配点货:', [{ text: '老板，帮我配点货:' }],
  []);
check('末行客套话忽略：谢谢!', [{ text: '谢谢!' }],
  []);
check('时间戳行忽略：下午 13:45', [{ text: '下午 13:45' }],
  []);
check('微信标题行忽略：微信(3)', [{ text: '微信(3)' }],
  []);
check('日期行忽略：11月5日', [{ text: '11月5日' }],
  []);
check('无合计字样的总价行忽略：共1200', [{ text: '共1200' }],
  []);
check('纯手机号行忽略：13812345678 张老板', [{ text: '13812345678 张老板' }],
  []);
check('未匹配但带数量仍显示：老样子 20件', [{ text: '老样子 20件' }],
  [N('老样子 20件')]);
check('完整聊天混合：问候/产品/合计/谢谢', [
  { text: '老板，帮我配点货:' },
  { text: '螺丝 M6x30 10件' },
  { text: '合计 128元' },
  { text: '谢谢!' },
], [S('s1', 10, true)]);

console.log('stripQtyForSearch("螺丝 M6×30 10件") =', JSON.stringify(stripQtyForSearch('螺丝 M6×30 10件')));
console.log('firstQtyFromText("螺丝 M6×30 10件") =', JSON.stringify(firstQtyFromText('螺丝 M6×30 10件')));
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
