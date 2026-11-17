'use strict';
/* ==================== 常量与工具 ==================== */
const TIERS = { wholesale: '批发价', retail: '零售价', vip: 'VIP价' };
const CUST_TYPES = { wholesale: '批发', retail: '零售', vip: 'VIP' };
const TIER_KEYS = ['wholesale', 'vip', 'retail'];   // 展示顺序：批发价 → VIP价 → 零售价

let state = { version: 2, products: [], specs: [], customers: [], orders: [], restocks: [] };
const ui = {
  tab: 'sell', search: '',
  cart: [], cartCustomerId: '', cartOrderNo: '', cartTier: 'auto',
  ordSearch: '', ordStart: '', ordEnd: '', ordRange: 'all',
  ordChecked: new Set(),
  stStart: '', stEnd: '', stRange: 'month', stDetailSearch: '',
  billCustomerId: '', billChecked: new Set(), billCustChecked: new Set(),
  rsSpecId: '', rsSearch: '',
  manSearch: '', custSearch: '',
  // 批量下单（卖货页表格导入）：待依次下单的订单组队列
  batchQueue: [], batchTotal: 0, batchCustomerId: '',
};
const ocr = { open: false, pickerOpen: false, busy: false, imgDataUrl: '', text: '', lines: [], rows: [], ignoredCount: 0, durationMs: 0, error: '' };

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function uid(p) { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function pad2(n) { return String(n).padStart(2, '0'); }
function money(fen) { return '¥' + (fen / 100).toFixed(2); }
function fmtTime(ts) { const d = new Date(ts); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function fmtDate(ts) { const d = new Date(ts); return (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
function todayStr(d) { d = d || new Date(); if (typeof d === 'number') d = new Date(d); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
// 导出文件名用的紧凑日期：20261105
function dateStr(d) { d = d || new Date(); return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()); }
function fenFromYuan(v) { const n = parseFloat(String(v).trim()); return isNaN(n) ? NaN : Math.round(n * 100); }
function isValidFen(v) { return typeof v === 'number' && isFinite(v) && v >= 0; }
/* ==================== 数量/库存：允许一位小数（如 1.2 个、库存 100.2） ==================== */
function round1(n) { return Math.round(n * 10) / 10; }
// 解析数量输入：只接受「数字 + 最多一位小数」（1.2 ✓、1.25 ✗、abc ✗），返回数值或 NaN
function qtyNum(v) {
  const t = String(v ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  const n = parseFloat(t);
  if (!isFinite(n) || Math.abs(n * 10 - Math.round(n * 10)) > 1e-6) return NaN;
  return n;
}
function fmtQty(v) { return String(round1(v)); }

/* ==================== 数据层 ==================== */
async function persist() {
  const r = await window.dataStore.save(state);
  if (!r.ok) toast('保存数据失败：' + r.error + '。可能是程序所在文件夹受保护，请把整个文件夹移到桌面或「文档」再使用。', 'error');
}
function specById(id) { return state.specs.find(s => s.id === id); }
function productById(id) { return state.products.find(p => p.id === id); }
function customerById(id) { return state.customers.find(c => c.id === id); }
function remaining(spec) { return round1(spec.stock - spec.sold); }
// 剩余库存文案：正数「剩 X」、零「无货」、负数「缺 X」（允许卖成负数：货已到但还没录入系统）
function remLabel(rem) { rem = round1(rem); return rem > 0 ? '剩 ' + rem : rem < 0 ? '缺 ' + (-rem) : '无货'; }
function specsOfProduct(pid) { return state.specs.filter(s => s.productId === pid); }
function tiersOf(spec) { return TIER_KEYS.filter(t => isValidFen(spec.priceFen && spec.priceFen[t])); }
// 价格档回落规则：所选档 → 零售价 → 其他唯一设了的档
function resolvePrice(spec, tierMode) {
  const chain = [tierMode, 'retail', 'wholesale', 'vip'];
  for (const t of chain) if (isValidFen(spec.priceFen && spec.priceFen[t])) return { tier: t, fen: spec.priceFen[t], fallback: t !== tierMode };
  return null;
}
function effectiveTierMode() {
  if (ui.cartTier !== 'auto') return ui.cartTier;
  const c = customerById(ui.cartCustomerId);
  return c ? c.type : 'retail';
}

/* ==================== 弹窗与提示 ==================== */
let toastTimer = null;
function toast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.className = type || '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}
function openModal(opts) {
  $('modalTitle').textContent = opts.title || '';
  $('modalBody').innerHTML = opts.body || '';
  const btns = $('modalBtns'); btns.innerHTML = '';
  (opts.buttons || []).forEach(b => {
    const el = document.createElement('button');
    el.className = 'btn ' + (b.cls || 'gray');
    el.textContent = b.label;
    el.addEventListener('click', () => { if (b.onClick) b.onClick(); });
    btns.appendChild(el);
  });
  $('modalOverlay').querySelector('.modal').className = 'modal' + (opts.wide ? ' wide' : '') + (opts.xl ? ' xl' : '');
  $('modalOverlay').hidden = false;
}
function closeModal() { $('modalOverlay').hidden = true; }
$('modalOverlay').addEventListener('click', e => {
  if (e.target !== $('modalOverlay')) return;
  if (ocr.open && ocr.pickerOpen) { ocr.pickerOpen = false; renderOcrModal(); }
  else if (ocr.open) ocrClose();
  else closeModal();
});

/* ==================== 卖货：渲染 ==================== */
function renderSell() { renderSellConfig(); renderSpecList(); renderCart(); }

function renderSellConfig() {
  // 客户选择：可搜索下拉（输入关键字过滤，点选）
  const c = customerById(ui.cartCustomerId);
  const inp = $('custPickInput');
  inp.value = c ? c.name : '';
  renderCustPickList('');
  $('inpOrderNo').value = ui.cartOrderNo;
  document.querySelectorAll('.tier-btn').forEach(b => b.classList.toggle('active', b.dataset.tier === ui.cartTier));
  updateTierHint();
}
// 客户搜索下拉列表：按名字过滤，不填 = 全部
function renderCustPickList(term) {
  const box = $('custPickList');
  const t = (term || '').trim().toLowerCase();
  const list = state.customers.filter(c => !t || c.name.toLowerCase().includes(t));
  box.innerHTML = list.length
    ? list.map(c => `<div class="cust-pick-item" data-customer-id="${esc(c.id)}">
        <span>${esc(c.name)}</span>
        <span class="badge ${esc(c.type)}">${CUST_TYPES[c.type]}</span>
      </div>`).join('')
    : `<div class="empty" style="padding:10px 12px">${t ? '没有匹配的客户' : '还没有客户，先去「产品与客户」页新增'}</div>`;
}
function updateTierHint() {
  const c = customerById(ui.cartCustomerId);
  let txt;
  if (ui.cartTier !== 'auto') txt = '手动固定用' + TIERS[ui.cartTier];
  else if (c) txt = '自动：' + CUST_TYPES[c.type] + '客户用' + TIERS[c.type];
  else txt = '自动：未选客户，暂按零售价';
  $('tierHint').textContent = txt;
}
function updateCartMeta() {
  const c = customerById(ui.cartCustomerId);
  const el = document.querySelector('.cart-meta');
  if (el) el.textContent = (c ? '客户：' + c.name + '（' + CUST_TYPES[c.type] + '）' : '未选客户') + (ui.cartOrderNo ? ' · 订单号：' + ui.cartOrderNo : '');
}

function renderSpecList() {
  const term = ui.search.trim().toLowerCase();
  const box = $('specList');
  if (!state.products.length && !state.specs.length) {
    box.innerHTML = '<div class="empty">还没有产品。请到「产品与客户」页新增产品。</div>';
    return;
  }
  let html = '';
  for (const p of state.products) {
    const specs = specsOfProduct(p.id).filter(s => !term || (p.name + ' ' + s.name).toLowerCase().includes(term));
    if (!specs.length) continue;
    const totalRemain = round1(specs.reduce((a, s) => a + remaining(s), 0));
    html += '<div class="pgroup"><h4>' + esc(p.name) + '<span>共剩 ' + totalRemain + '</span></h4><div class="spec-grid">' + specs.map(specCardHtml).join('') + '</div></div>';
  }
  const orphans = state.specs.filter(s => !productById(s.productId)).filter(s => !term || s.name.toLowerCase().includes(term));
  if (orphans.length) {
    html += '<div class="pgroup"><h4>（未分组规格）<span></span></h4><div class="spec-grid">' + orphans.map(specCardHtml).join('') + '</div></div>';
  }
  // 提示：有产品还没加规格 → 卖货页只显示规格，所以要明确告诉用户差哪一步
  const bare = state.products.filter(p => !specsOfProduct(p.id).length);
  if (!term && bare.length) {
    html = `<div class="bare-hint">有 ${bare.length} 个产品还没加规格，所以不显示在新建页：<b>${bare.map(p => esc(p.name)).join('、')}</b>。到「产品与客户」页点它右边的「新增规格」加好后，这里就会出现。</div>` + html;
  }
  box.innerHTML = html || '<div class="empty">没有找到匹配的产品或规格</div>';
}
function specCardHtml(s) {
  const rem = remaining(s);
  const prices = tiersOf(s).map(t => TIERS[t].replace('价', '') + ' ' + money(s.priceFen[t])).join(' · ');
  return `<div class="spec-card" data-spec-id="${esc(s.id)}">
    <div class="sc-top"><span class="sc-name">${esc(s.name)}</span><span class="sc-stock ${rem <= 0 ? 'out' : ''}">${remLabel(rem)}</span></div>
    <div class="sc-prices">${prices ? esc(prices) : '（未设价格）'}</div>
    <div class="sc-actions">
      <button class="qty-btn" data-action="spec-minus">−</button>
      <input class="qty-inp" type="text" inputmode="numeric" value="1">
      <button class="qty-btn" data-action="spec-plus">+</button>
      <button class="btn primary add-btn" data-action="spec-add">加入订单</button>
    </div>
  </div>`;
}

function renderCart() {
  const box = $('cartItems');
  updateCartMeta();
  const { items, total } = cartTotals();
  if (!items.length) {
    box.innerHTML = '<div class="cart-empty">订单是空的<br>在左边产品上点「加入订单」</div>';
    $('cartTotal').textContent = money(0);
    return;
  }
  box.innerHTML = items.map(it => {
    if (it.missing) {
      return `<div class="cart-item" data-spec-id="${esc(it.specId)}">
        <div class="ci-info"><div class="ci-name" style="color:var(--red)">（规格已删除，请移除）</div></div>
        <div class="ci-qty"><button class="btn danger small" data-action="cart-remove">移除</button></div>
      </div>`;
    }
    const badge = TIERS[it.tier] + (it.fallback ? '※' : '');
    const badgeTitle = it.fallback ? '该规格没设' + TIERS[effectiveTierMode()] + '，已自动回落' : '';
    const pname = productById(it.spec.productId) ? productById(it.spec.productId).name : '未分组';
    return `<div class="cart-item" data-spec-id="${esc(it.spec.id)}">
      <div class="ci-info">
        <div class="ci-name">${esc(it.spec.name)}</div>
        <div class="ci-sub">${esc(pname)} · <span title="${esc(badgeTitle)}">${esc(badge)}</span> · ${money(it.unitFen)} × ${it.qty} = ${money(it.subtotal)}</div>
      </div>
      <div class="ci-qty">
        <button class="qty-btn" data-action="cart-minus">−</button>
        <button class="qty-btn" data-action="cart-plus">+</button>
        <button class="btn danger small" data-action="cart-remove">移除</button>
      </div>
    </div>`;
  }).join('');
  $('cartTotal').textContent = money(total);
}
function cartTotals() {
  const items = []; let total = 0;
  for (const it of ui.cart) {
    const spec = specById(it.specId);
    if (!spec) { items.push({ specId: it.specId, qty: it.qty, missing: true }); continue; }
    const p = resolvePrice(spec, effectiveTierMode());
    if (!p) { items.push({ spec, qty: it.qty, noPrice: true }); continue; }
    const sub = Math.round(p.fen * it.qty); // 数量可为小数，金额四舍五入到分
    items.push({ spec, qty: it.qty, unitFen: p.fen, subtotal: sub, tier: p.tier, fallback: p.fallback });
    total += sub;
  }
  return { items, total };
}

/* ==================== 卖货：操作 ==================== */
function addToCart(specId, qty) {
  const spec = specById(specId); if (!spec) return;
  qty = qtyNum(qty);
  if (!isFinite(qty) || qty < 0.1) { toast('数量填写不对（要 ≥0.1，最多一位小数）'); return; }
  const cur = ui.cart.find(x => x.specId === specId);
  const newQty = round1((cur ? cur.qty : 0) + qty);
  // 库存可以卖成负数（货已到但还没录入系统的情况），不再拦截
  if (cur) cur.qty = newQty; else ui.cart.push({ specId, qty });
  renderCart();
}
function changeCartQty(specId, delta) {
  const it = ui.cart.find(x => x.specId === specId); if (!it) return;
  const spec = specById(specId); if (!spec) return;
  const q = round1(it.qty + delta);
  if (q < 0.1) return;
  it.qty = q;
  renderCart();
}

function createOrder() {
  const orderNo = ui.cartOrderNo.trim();
  const c = customerById(ui.cartCustomerId);
  if (!c) { toast('请先选择客户'); return; }
  if (!orderNo) { toast('请填写订单号'); return; }
  if (state.orders.some(o => o.orderNo === orderNo)) { toast('订单号「' + orderNo + '」已存在，请换一个'); return; }
  const { items, total } = cartTotals();
  if (!items.length) { toast('订单还是空的，先加入产品吧'); return; }
  if (items.some(it => it.missing)) { toast('订单里有已删除的规格，请先移除'); return; }
  const bad = items.find(it => it.noPrice);
  if (bad) { toast('「' + bad.spec.name + '」没有设价格，无法下单'); return; }
  const rows = items.map(it => `<tr><td>${esc(it.spec.name)}</td><td>${TIERS[it.tier]}${it.fallback ? '※' : ''}</td><td>${money(it.unitFen)}</td><td>${it.qty}</td><td>${money(it.subtotal)}</td></tr>`).join('');
  const negs = items.filter(it => remaining(it.spec) - it.qty < 0);
  const negNote = negs.length
    ? `<div class="note" style="color:#c0392b">下单后这些规格库存会变成负数：${negs.map(it => esc(it.spec.name) + '（' + remLabel(remaining(it.spec)) + '，卖 ' + it.qty + '）').join('、')}</div>`
    : '';
  openModal({
    title: '确认下单',
    body: `<div>客户：<b>${esc(c.name)}（${CUST_TYPES[c.type]}）</b>　订单号：<b>${esc(orderNo)}</b></div>
      <table class="summary-table" style="margin:10px 0"><tr><th>规格</th><th>价格档</th><th>单价</th><th>数量</th><th>小计</th></tr>${rows}</table>
      <div style="text-align:right">总价：<span class="big-total">${money(total)}</span></div>
      ${negNote}
      <div class="note">确认后库存将自动扣减。※ = 该规格没设这档价，已自动回落。</div>`,
    buttons: [
      { label: '返回修改', cls: 'gray', onClick: closeModal },
      { label: '确认成交', cls: 'primary', onClick: () => doCreateOrder(orderNo, c, items, total) },
    ],
  });
}
function doCreateOrder(orderNo, c, items, total) {
  // 二次校验（确认弹窗期间规格可能被删除；库存不足不再拦截，允许卖成负数）
  for (const it of items) {
    const spec = specById(it.spec.id);
    if (!spec) { toast('订单里有已删除的规格，请先移除'); closeModal(); return; }
  }
  const order = {
    id: uid('o'), orderNo, time: Date.now(), status: 'pending', paid: false,
    customerId: c.id, customerName: c.name, customerType: c.type,
    items: items.map(it => ({
      specId: it.spec.id, productId: it.spec.productId,
      productName: productById(it.spec.productId) ? productById(it.spec.productId).name : '未分组',
      specName: it.spec.name, priceFen: it.unitFen, tier: it.tier, qty: it.qty,
    })),
    totalFen: total,
  };
  items.forEach(it => { it.spec.sold = round1(it.spec.sold + it.qty); });
  state.orders.push(order);
  ui.cart = []; ui.cartOrderNo = '';
  persist();
  closeModal();
  renderAll();
  toast('已成交 ' + money(total) + '，库存已扣减');
  // 批量下单：成交后自动载入队列里下一笔；全部完成时收尾提示
  if (ui.batchQueue.length) {
    loadNextBatchOrder();
  } else if (ui.batchTotal > 0) {
    const n = ui.batchTotal;
    ui.batchTotal = 0;
    toast('批量下单完成：' + n + ' 笔订单已全部成交');
  }
}

/* ==================== 订单管理 ==================== */
function rangeFromChips(range) {
  const now = new Date();
  let start = null, end = null;
  if (range === 'today') { const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()); start = d0.getTime(); end = d0.getTime() + 86400000 - 1; }
  else if (range === 'week') { const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)); start = d0.getTime(); end = start + 7 * 86400000 - 1; }
  else if (range === 'month') { const d0 = new Date(now.getFullYear(), now.getMonth(), 1); start = d0.getTime(); end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - 1; }
  else if (range === 'lastmonth') { const d0 = new Date(now.getFullYear(), now.getMonth() - 1, 1); start = d0.getTime(); end = new Date(now.getFullYear(), now.getMonth(), 1).getTime() - 1; }
  return { start, end };
}
function parseDateRange(startStr, endStr) {
  const start = startStr ? new Date(startStr + 'T00:00:00').getTime() : null;
  const end = endStr ? new Date(endStr + 'T23:59:59.999').getTime() : null;
  return { start, end };
}
// 订单是否命中搜索词：订单号 / 客户名 / 明细里的产品名或规格名
function orderMatchesQ(o, q) {
  return o.orderNo.toLowerCase().includes(q)
    || o.customerName.toLowerCase().includes(q)
    || (o.items || []).some(it => ((it.productName || '') + '/' + (it.specName || '')).toLowerCase().includes(q));
}
function filterOrders(list, q, start, end) {
  q = (q || '').trim().toLowerCase();
  return list.filter(o => {
    if (start != null && o.time < start) return false;
    if (end != null && o.time > end) return false;
    if (q && !orderMatchesQ(o, q)) return false;
    return true;
  }).sort((a, b) => b.time - a.time);
}
function paidCellHtml(o) {
  return `<td><span class="badge ${o.paid ? 'paid' : 'unpaid'}">${o.paid ? '已付款' : '未付款'}</span> <button class="btn ${o.paid ? 'gray' : 'primary'} small" data-action="ord-paid" data-order-id="${esc(o.id)}">${o.paid ? '改回未付款' : '标记已付款'}</button></td>`;
}

function orderTable(list, opts) {
  opts = opts || {};
  if (!list.length) return '<div class="empty">没有找到订单</div>';
  const selHead = opts.selectable ? '<th style="width:36px"><input type="checkbox" class="ord-check-all" title="全选本页"></th>' : '';
  const paidHead = opts.paid ? '<th>付款</th>' : '';
  const statusHead = opts.status ? '<th>状态</th>' : '';
  const head = `<tr>${selHead}<th>订单号</th><th>时间</th><th>客户</th><th>明细摘要</th><th>总额</th>${paidHead}${statusHead}<th></th></tr>`;
  return '<table>' + head + list.map(o => {
    const first = o.items[0];
    const summary = first ? esc(first.productName + '/' + first.specName + ' ×' + first.qty) + (o.items.length > 1 ? ' 等' + o.items.length + '项' : '') : '（无明细）';
    const selCell = opts.selectable
      ? `<td><input type="checkbox" class="ord-check" data-order-id="${esc(o.id)}" ${ui.ordChecked.has(o.id) ? 'checked' : ''}></td>`
      : '';
    const statusCell = opts.status
      ? `<td><span class="badge ${o.status === 'done' ? 'done' : 'pending'}">${o.status === 'done' ? '已完成' : '未完成'}</span></td>`
      : '';
    return `<tr>
      ${selCell}
      <td>${esc(o.orderNo)}</td>
      <td>${fmtTime(o.time)}</td>
      <td>${esc(o.customerName)}<span class="badge ${esc(o.customerType)}">${CUST_TYPES[o.customerType] || ''}</span></td>
      <td>${summary}</td>
      <td><b>${money(o.totalFen)}</b></td>
      ${opts.paid ? paidCellHtml(o) : ''}
      ${statusCell}
      <td><div class="td-actions">
        <button class="btn gray small" data-action="ord-view" data-order-id="${esc(o.id)}">查看</button>
        <button class="btn gray small" data-action="ord-edit" data-order-id="${esc(o.id)}">修改</button>
        <button class="btn danger small" data-action="ord-del" data-order-id="${esc(o.id)}">删除</button>
      </div></td>
    </tr>`;
  }).join('') + '</table>';
}
function renderOrders() {
  document.querySelectorAll('#tab-orders .chip').forEach(ch => ch.classList.toggle('active', ch.dataset.range === ui.ordRange));
  $('ordStart').value = ui.ordStart; $('ordEnd').value = ui.ordEnd;
  const { start, end } = ui.ordRange === 'custom' ? parseDateRange(ui.ordStart, ui.ordEnd) : rangeFromChips(ui.ordRange);
  const list = filterOrders(state.orders, ui.ordSearch, start, end);
  ui.ordChecked = new Set();
  $('ordersList').innerHTML = orderTable(list, { status: true, paid: true, selectable: true });
}

function showOrder(o) {
  const rows = o.items.map(it => `<tr><td>${esc(it.productName)}</td><td>${esc(it.specName)}</td><td>${TIERS[it.tier] || ''}</td><td>${money(it.priceFen)}</td><td>${it.qty}</td><td>${money(it.priceFen * it.qty)}</td></tr>`).join('');
  const isDone = o.status === 'done';
  openModal({
    title: '订单详情',
    wide: true,
    body: `<div>订单号：<b>${esc(o.orderNo)}</b>　客户：<b>${esc(o.customerName)}（${CUST_TYPES[o.customerType] || ''}）</b>　时间：${fmtTime(o.time)}　状态：<span class="badge ${isDone ? 'done' : 'pending'}">${isDone ? '已完成' : '未完成'}</span>　付款：<span class="badge ${o.paid ? 'paid' : 'unpaid'}">${o.paid ? '已付款' : '未付款'}</span></div>
      <table class="summary-table" style="margin:10px 0"><tr><th>产品</th><th>规格</th><th>价格档</th><th>单价</th><th>数量</th><th>小计</th></tr>${rows}</table>
      <div style="text-align:right;font-size:18px">总额：<span class="big-total">${money(o.totalFen)}</span></div>`,
    buttons: [
      { label: '关闭', cls: 'gray', onClick: closeModal },
      {
        label: o.paid ? '改回未付款' : '标记为已付款',
        cls: o.paid ? 'gray' : 'primary',
        onClick: () => {
          o.paid = !o.paid;
          persist(); closeModal(); renderAll();
          toast(o.paid ? '已标记为已付款' : '已改回未付款');
        },
      },
      {
        label: isDone ? '标记为未完成（重新开账）' : '标记为已完成',
        cls: 'gray',
        onClick: () => {
          o.status = isDone ? 'pending' : 'done';
          persist(); closeModal(); renderAll();
          toast(isDone ? '已改回未完成，会重新出现在账单管理里' : '已标记为已完成');
        },
      },
    ],
  });
}

function restoreOrderItems(o) {
  const notes = [];
  for (const it of o.items) {
    const spec = specById(it.specId);
    if (!spec) { notes.push('「' + it.productName + '/' + it.specName + '」的产品已删除，库存无法退回'); continue; }
    if (spec.sold < it.qty) { notes.push('「' + spec.name + '」已售数不足，已按 0 处理'); spec.sold = 0; }
    else spec.sold = round1(spec.sold - it.qty);
  }
  return notes;
}

function confirmDeleteOrder(o) {
  const totalQty = round1(o.items.reduce((a, it) => a + it.qty, 0));
  openModal({
    title: '删除订单',
    body: `<div>订单号：<b>${esc(o.orderNo)}</b>（${esc(o.customerName)}）</div>
      <div style="margin-top:10px">删除后，本单 <b>${totalQty}</b> 件商品将自动退回库存。</div>
      <div class="note">此操作不可撤销，确定删除吗？</div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '确认删除', cls: 'danger', onClick: () => {
        const notes = restoreOrderItems(o);
        state.orders = state.orders.filter(x => x.id !== o.id);
        persist(); closeModal(); renderAll();
        toast('订单已删除，库存已退回' + (notes.length ? '（' + notes.join('；') + '）' : ''));
      } },
    ],
  });
}

function openEditOrder(o) {
  const draft = {
    customerId: o.customerId,
    orderNo: o.orderNo,
    items: o.items.map(it => {
      const spec = specById(it.specId);
      return { specId: it.specId, qty: it.qty, snapshotName: spec ? null : it.productName + '/' + it.specName };
    }),
  };
  function showEditModal() {
    openModal({
      title: '修改订单',
      wide: true,
      body: `<div class="form-row"><label>客户</label><select id="eoCustomer">${state.customers.map(x => `<option value="${esc(x.id)}" ${x.id === draft.customerId ? 'selected' : ''}>${esc(x.name)}（${CUST_TYPES[x.type]}）</option>`).join('')}</select></div>
        <div class="form-row"><label>订单号</label><input id="eoOrderNo" maxlength="50" value="${esc(draft.orderNo)}"></div>
        <div class="form-row"><label>订单明细</label><div id="eoItems"></div>
          <button class="btn gray small" id="eoAddItem" style="margin-top:6px">＋ 添加产品</button></div>
        <div style="text-align:right;font-size:16px;margin-top:8px">合计：<b style="font-size:24px;color:var(--red)" id="eoTotal">¥0.00</b></div>`,
      buttons: [
        { label: '取消', cls: 'gray', onClick: closeModal },
        { label: '保存修改', cls: 'primary', onClick: () => saveEditOrder(o, draft) },
      ],
    });
    renderEoItems();
    $('eoCustomer').addEventListener('change', e => { draft.customerId = e.target.value; updateEoTotal(); });
    $('eoItems').addEventListener('input', e => {
      // 输入过程中不打断（允许先打 "1." 再补小数），失焦时统一修正
      const row = e.target.closest('[data-idx]'); if (!row) return;
      const v = qtyNum(e.target.value);
      if (!isFinite(v) || v < 0.1) return;
      draft.items[+row.dataset.idx].qty = v;
      updateEoTotal();
    });
    $('eoItems').addEventListener('change', e => {
      const row = e.target.closest('[data-idx]'); if (!row) return;
      const v = qtyNum(e.target.value);
      e.target.value = (!isFinite(v) || v < 0.1) ? 1 : v;
      draft.items[+row.dataset.idx].qty = +e.target.value;
      updateEoTotal();
    });
    $('eoItems').addEventListener('click', e => {
      const btn = e.target.closest('[data-action="eo-remove"]');
      if (!btn) return;
      draft.items.splice(+btn.closest('[data-idx]').dataset.idx, 1);
      renderEoItems();
      updateEoTotal();
    });
    $('eoAddItem').addEventListener('click', () => openSpecPicker(spec => {
      const ex = draft.items.find(x => x.specId === spec.id);
      if (ex) ex.qty = round1(ex.qty + 1); else draft.items.push({ specId: spec.id, qty: 1, snapshotName: null });
      showEditModal();
    }));
    updateEoTotal();
  }
  function renderEoItems() {
    const box = $('eoItems');
    box.innerHTML = draft.items.map((it, idx) => {
      const spec = specById(it.specId);
      let name, rem;
      if (spec) { name = (productById(spec.productId) ? productById(spec.productId).name : '未分组') + ' / ' + spec.name; rem = remLabel(remaining(spec)); }
      else { name = it.snapshotName || '（已删除的规格）'; rem = '—'; }
      return `<div class="form-inline" style="margin-bottom:6px" data-idx="${idx}">
        <span style="flex:1;min-width:140px">${esc(name)}${spec ? '' : ' <span style="color:var(--red)">（已删除，只能移除）</span>'}</span>
        <span style="color:#8a8f98;font-size:13px">${rem}</span>
        <input class="eo-qty" type="text" inputmode="numeric" value="${it.qty}" style="width:70px;text-align:center;padding:6px;border:1px solid var(--border);border-radius:8px">
        <button class="btn danger small" data-action="eo-remove">移除</button>
      </div>`;
    }).join('') || '<div style="color:#8a8f98">暂无明细，请添加产品</div>';
  }
  function updateEoTotal() {
    const el = $('eoTotal'); if (!el) return;
    let total = 0;
    for (const it of draft.items) {
      const spec = specById(it.specId);
      if (!spec) { const old = o.items.find(x => x.specId === it.specId); total += old ? Math.round(old.priceFen * it.qty) : 0; continue; }
      const p = resolvePrice(spec, customerById(draft.customerId).type);
      if (p) total += Math.round(p.fen * it.qty);
    }
    el.textContent = money(total);
  }
  showEditModal();
}
function saveEditOrder(o, draft) {
  const orderNo = $('eoOrderNo').value.trim();
  const customerId = $('eoCustomer').value;
  if (!orderNo) { toast('请填写订单号'); return; }
  if (state.orders.some(x => x.id !== o.id && x.orderNo === orderNo)) { toast('订单号「' + orderNo + '」已存在，请换一个'); return; }
  const c = customerById(customerId);
  if (!c) { toast('请选择客户'); return; }
  if (!draft.items.length) { toast('订单至少要有一样产品'); return; }
  for (const it of draft.items) if (!isFinite(it.qty) || it.qty < 0.1) { toast('数量填写不对'); return; }
  // 生成新明细（快照）
  const newItems = [];
  for (const it of draft.items) {
    const spec = specById(it.specId);
    if (!spec) {
      const old = o.items.find(x => x.specId === it.specId);
      newItems.push({ specId: it.specId, productId: old ? old.productId : '', productName: old ? old.productName : '（已删除）', specName: old ? old.specName : '（已删除）', priceFen: old ? old.priceFen : 0, tier: old ? old.tier : 'retail', qty: it.qty });
      continue;
    }
    const p = resolvePrice(spec, c.type);
    if (!p) { toast('「' + spec.name + '」没有设价格，请先去补价格'); return; }
    newItems.push({ specId: spec.id, productId: spec.productId, productName: productById(spec.productId) ? productById(spec.productId).name : '未分组', specName: spec.name, priceFen: p.fen, tier: p.tier, qty: it.qty });
  }
  // 执行：先退回旧明细，再扣新明细（库存允许卖成负数，不再校验剩余）

  const notes = restoreOrderItems(o);
  newItems.forEach(it => { const spec = specById(it.specId); if (spec) spec.sold = round1(spec.sold + it.qty); });
  o.customerId = c.id; o.customerName = c.name; o.customerType = c.type;
  o.orderNo = orderNo;
  o.items = newItems;
  o.totalFen = newItems.reduce((a, it) => a + Math.round(it.priceFen * it.qty), 0);
  persist(); closeModal(); renderAll();
  toast('订单已修改' + (notes.length ? '（' + notes.join('；') + '）' : ''));
}

function openSpecPicker(onPick, prefill, onCancel) {
  openModal({
    title: '选择产品规格',
    wide: true,
    body: `<input class="search" id="pkSearch" placeholder="搜索产品或规格…" style="margin-bottom:10px"><div id="pkList"></div>`,
    buttons: [{ label: '取消', cls: 'gray', onClick: onCancel || closeModal }],
  });
  function renderPk() {
    const t = $('pkSearch').value.trim().toLowerCase();
    let html = '';
    for (const p of state.products) {
      const specs = specsOfProduct(p.id).filter(s => !t || (p.name + ' ' + s.name).toLowerCase().includes(t));
      if (!specs.length) continue;
      html += '<div class="pgroup"><h4>' + esc(p.name) + '</h4><div class="spec-grid">' + specs.map(s => {
        const rem = remaining(s);
        const prices = tiersOf(s).map(x => TIERS[x].replace('价', '') + ' ' + money(s.priceFen[x])).join(' · ');
        return `<div class="spec-card" data-spec-id="${esc(s.id)}" style="cursor:pointer">
          <div class="sc-top"><span class="sc-name">${esc(s.name)}</span><span class="sc-stock ${rem <= 0 ? 'out' : ''}">${remLabel(rem)}</span></div>
          <div class="sc-prices">${prices ? esc(prices) : '（未设价格）'}</div>
        </div>`;
      }).join('') + '</div></div>';
    }
    $('pkList').innerHTML = html || '<div class="empty">没有找到</div>';
  }
  if (prefill) $('pkSearch').value = prefill;
  renderPk();
  if (prefill) $('pkSearch').focus();
  $('pkSearch').addEventListener('input', renderPk);
  $('pkList').addEventListener('click', e => {
    const card = e.target.closest('.spec-card');
    if (!card) return;
    const spec = specById(card.dataset.specId);
    if (spec) { closeModal(); onPick(spec); }
  });
}

/* ==================== 账单管理 ==================== */
function pendingOrders() { return state.orders.filter(o => o.status !== 'done'); }

function renderBilling() {
  const custMap = new Map();
  for (const o of pendingOrders()) {
    const e = custMap.get(o.customerId) || { id: o.customerId, name: o.customerName, count: 0, fen: 0 };
    e.count++; e.fen += o.totalFen || 0;
    custMap.set(o.customerId, e);
  }
  const list = [...custMap.values()].sort((a, b) => b.fen - a.fen);
  // 清掉已经没有未开账单订单的勾选（比如刚导完账单的客户）
  const pendingCustIds = new Set(list.map(c => c.id));
  ui.billCustChecked = new Set([...ui.billCustChecked].filter(id => pendingCustIds.has(id)));
  // 只勾了 1 个客户 = 和点他一样，右侧显示他的订单
  if (ui.billCustChecked.size === 1) ui.billCustomerId = [...ui.billCustChecked][0];
  // 「全选」客户勾选框状态同步（全勾上=打勾，全没勾=不打勾）
  const custAll = $('billCustCheckAll');
  if (custAll) {
    custAll.disabled = !list.length;
    custAll.checked = list.length > 0 && list.every(c => ui.billCustChecked.has(c.id));
  }
  $('billCustomers').innerHTML = list.length
    ? list.map(c => `<div class="bill-cust${ui.billCustomerId === c.id ? ' active' : ''}" data-customer-id="${esc(c.id)}">
        <input type="checkbox" class="bill-cust-check" data-customer-id="${esc(c.id)}" ${ui.billCustChecked.has(c.id) ? 'checked' : ''}>
        <span class="bc-name">${esc(c.name)}</span>
        <span class="bc-info">${c.count} 单 · ${money(c.fen)}</span>
      </div>`).join('')
    : '<div class="empty">没有未开账单的订单<br>（新下的订单会自动出现在这里）</div>';
  renderBillOrders();
}

function renderBillOrders() {
  // 多客户合并模式：勾了 2 个及以上客户 → 右侧显示合并预览
  const mergeIds = [...ui.billCustChecked].filter(id => customerById(id));
  if (mergeIds.length >= 2) {
    const mOrders = pendingOrders().filter(o => mergeIds.includes(o.customerId)).sort((a, b) => a.time - b.time);
    const mTotal = mOrders.reduce((a, o) => a + (o.totalFen || 0), 0);
    $('billRightTitle').textContent = '多客户合并账单 · 已勾选 ' + mergeIds.length + ' 个客户';
    $('billCheckAll').style.display = 'none';
    $('billOrders').innerHTML = mOrders.length
      ? `<div class="note" style="margin-bottom:8px">将把勾选客户的 <b>${mOrders.length}</b> 笔未开账单订单合并成 <b>一张账单</b>，按日期从早到晚排列：</div>` +
        mergeIds.map(id => {
          const c = customerById(id);
          const cnt = mOrders.filter(o => o.customerId === id).length;
          const f = mOrders.filter(o => o.customerId === id).reduce((a, o) => a + (o.totalFen || 0), 0);
          return `<div class="bill-merge-row"><span class="bm-name">${esc(c.name)}</span><span class="bm-info">${cnt} 单 · ${money(f)}</span></div>`;
        }).join('') +
        `<div class="note" style="margin-top:8px">合计 <b>${money(mTotal)}</b> · 导出后这些订单全部标记「已完成」。</div>`
      : '<div class="empty">勾选的客户没有未开账单的订单</div>';
    $('btnBillExport').textContent = '合并导出账单（' + mergeIds.length + ' 客户）';
    $('btnBillExport').disabled = !mOrders.length;
    return;
  }
  // 常规模式：恢复全选框和按钮文案
  $('billCheckAll').style.display = '';
  $('btnBillExport').textContent = '合并导出账单（勾选）';
  const cid = ui.billCustomerId;
  if (!cid) {
    $('billRightTitle').textContent = '← 点左侧客户查看';
    $('billOrders').innerHTML = '';
    $('btnBillExport').disabled = true;
    $('billCheckAll').checked = false; $('billCheckAll').disabled = true;
    return;
  }
  const list = pendingOrders().filter(o => o.customerId === cid).sort((a, b) => a.time - b.time);
  const valid = new Set(list.map(o => o.id));
  ui.billChecked = new Set([...ui.billChecked].filter(id => valid.has(id)));
  const name = list.length ? list[0].customerName : (customerById(cid) ? customerById(cid).name : '');
  $('billRightTitle').textContent = name + ' · 未开账单 ' + list.length + ' 单';
  if (!list.length) {
    $('billOrders').innerHTML = '<div class="empty">该客户没有未开账单的订单</div>';
    $('btnBillExport').disabled = true;
    $('billCheckAll').checked = false; $('billCheckAll').disabled = true;
    return;
  }
  $('billCheckAll').disabled = false;
  $('billCheckAll').checked = list.every(o => ui.billChecked.has(o.id));
  $('billOrders').innerHTML = list.map(o => {
    const first = o.items[0];
    const summary = first ? esc(first.productName + '/' + first.specName + ' ×' + first.qty) + (o.items.length > 1 ? ' 等' + o.items.length + '项' : '') : '';
    return `<div class="bill-order"><label>
      <input type="checkbox" class="bill-check" data-order-id="${esc(o.id)}" ${ui.billChecked.has(o.id) ? 'checked' : ''}>
      <span class="bo-info"><span class="bo-main">${esc(o.orderNo)}</span><span class="bo-sub">${summary}</span></span>
      <span class="bo-total">${money(o.totalFen)}</span>
    </label></div>`;
  }).join('');
  $('btnBillExport').disabled = !ui.billChecked.size;
}

function exportBill() {
  // 多客户合并：导出成一张按日期排列的账单，之后全部标记已完成
  const mergeIds = [...ui.billCustChecked].filter(id => customerById(id));
  if (mergeIds.length >= 2) {
    const mOrders = pendingOrders().filter(o => mergeIds.includes(o.customerId)).sort((a, b) => a.time - b.time);
    if (!mOrders.length) { toast('勾选的客户没有未开账单的订单'); return; }
    const mTotal = mOrders.reduce((a, o) => a + (o.totalFen || 0), 0);
    openModal({
      title: '合并生成账单（多客户）',
      body: `<div>勾选了 <b>${mergeIds.length}</b> 个客户，共 <b>${mOrders.length}</b> 笔订单，将合并成 <b>一张账单</b>（按日期从早到晚排列）。</div>
        <div style="margin-top:8px">${mergeIds.map(id => {
          const c = customerById(id);
          return esc(c.name) + '（' + mOrders.filter(o => o.customerId === id).length + ' 笔）';
        }).join('　')}</div>
        <div class="note">合计 ${money(mTotal)} · 导出后这些订单会标记为「已完成」，并从账单管理里消失。导错的话可以在订单详情里改回「未完成」。</div>`,
      buttons: [
        { label: '取消', cls: 'gray', onClick: closeModal },
        { label: '确认导出', cls: 'primary', onClick: async () => {
          closeModal();
          const r = await exportBillXlsx('账单合并' + dateStr() + '.xlsx', buildBillSheet(mOrders), '账单合并');
          if (!r.ok) return;
          mOrders.forEach(o => { o.status = 'done'; });
          ui.billChecked = new Set();
          ui.billCustChecked = new Set();
          persist(); renderAll();
          toast('账单已导出，' + mOrders.length + ' 笔订单已标记为已完成');
        } },
      ],
    });
    return;
  }
  const cid = ui.billCustomerId;
  const orders = pendingOrders().filter(o => o.customerId === cid && ui.billChecked.has(o.id)).sort((a, b) => a.time - b.time);
  if (!orders.length) { toast('先勾选要开账单的订单'); return; }
  const name = orders[0].customerName;
  const totalFen = orders.reduce((a, o) => a + (o.totalFen || 0), 0);
  openModal({
    title: '确认导出账单',
    body: `<div>客户：<b>${esc(name)}</b></div>
      <div style="margin-top:8px">共 <b>${orders.length}</b> 笔订单，合计 <b>${money(totalFen)}</b>。</div>
      <div class="note">导出后这些订单会标记为「已完成」，并从账单管理里消失。导错的话可以在订单详情里改回「未完成」。</div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '确认导出', cls: 'primary', onClick: async () => {
        const r = await exportBillXlsx('账单' + name + dateStr() + '.xlsx', buildBillSheet(orders), '账单');
        closeModal();
        if (!r.ok) return;
        orders.forEach(o => { o.status = 'done'; });
        ui.billChecked = new Set();
        persist(); renderAll();
        toast('账单已导出，' + orders.length + ' 笔订单已标记为已完成');
      } },
    ],
  });
}

/* ==================== 订单管理：勾选合并生成账单（只导出，状态不变） ==================== */
// 一个按钮两种行为：勾选的订单只有一个客户 → 导出该客户一张账单；勾了多个客户 → 合并成一张按日期排列
function mergeExportOrders() {
  const orders = [...ui.ordChecked].map(id => state.orders.find(o => o.id === id)).filter(Boolean).sort((a, b) => a.time - b.time);
  if (!orders.length) { toast('先在订单列表里勾选要合并的订单'); return; }
  const custMap = new Map();
  for (const o of orders) if (!custMap.has(o.customerId)) custMap.set(o.customerId, { id: o.customerId, name: o.customerName });
  const totalFen = orders.reduce((a, o) => a + (o.totalFen || 0), 0);
  if (custMap.size === 1) {
    // 单客户：照旧导出该客户一张账单
    const c = [...custMap.values()][0];
    openModal({
      title: '合并生成账单',
      body: `<div>客户：<b>${esc(c.name)}</b>，共 <b>${orders.length}</b> 笔订单，合计 <b>${money(totalFen)}</b>。</div>
        <div class="note">只导出账单，订单状态不变。</div>`,
      buttons: [
        { label: '取消', cls: 'gray', onClick: closeModal },
        { label: '确认导出', cls: 'primary', onClick: async () => {
          closeModal();
          await exportBillXlsx('账单' + c.name + dateStr() + '.xlsx', buildBillSheet(orders), '账单');
          ui.ordChecked = new Set();
          renderOrders();
        } },
      ],
    });
    return;
  }
  // 多客户：合并成一张，按日期从早到晚排列
  const first = orders[0], last = orders[orders.length - 1];
  const days = new Set(orders.map(o => todayStr(o.time))).size;
  openModal({
    title: '合并生成账单（多客户）',
    body: `<div>勾选了 <b>${orders.length}</b> 笔订单，分属 <b>${custMap.size}</b> 个客户，将合并成 <b>一张账单</b>，按日期从早到晚排列：</div>
      <div style="margin-top:8px">${[...custMap.values()].map(c => esc(c.name) + '（' + orders.filter(o => o.customerId === c.id).length + ' 笔）').join('　')}</div>
      <div class="note">日期 ${fmtDate(first.time)} ~ ${fmtDate(last.time)}（${days} 天）· 合计 ${money(totalFen)} · 只导出账单，订单状态不变。</div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '确认导出', cls: 'primary', onClick: async () => {
        closeModal();
        await exportBillXlsx('账单合并' + dateStr() + '.xlsx', buildBillSheet(orders), '账单合并');
        ui.ordChecked = new Set();
        renderOrders();
      } },
    ],
  });
}

/* ==================== 统计 ==================== */
function initStatDates() {
  const now = new Date();
  ui.stStart = todayStr(new Date(now.getFullYear(), now.getMonth(), 1));
  ui.stEnd = todayStr(now);
  ui.stRange = 'month';
}
// 老数据没有 initialStock 字段：按「当前库存数 − 全部补货累计」反推出创建时的初始库存
function ensureInitialStock() {
  const restockSum = new Map();
  for (const r of state.restocks) restockSum.set(r.specId, round1((restockSum.get(r.specId) || 0) + (Number(r.qty) || 0)));
  for (const s of state.specs) {
    if (typeof s.initialStock === 'number' && isFinite(s.initialStock)) continue;
    s.initialStock = round1(Math.max(0, (Number(s.stock) || 0) - (restockSum.get(s.id) || 0)));
  }
}
function computeStats(start, end) {
  const map = new Map(); const details = [];
  for (const o of state.orders) {
    if (o.time < start || o.time > end) continue;
    details.push(o);
    for (const it of o.items) {
      const r = map.get(it.specId) || { specId: it.specId, productName: it.productName, specName: it.specName, restock: 0, qty: 0, fen: 0 };
      r.qty = round1(r.qty + it.qty); r.fen = Math.round(r.fen + it.priceFen * it.qty);
      map.set(it.specId, r);
    }
  }
  // 入库数 = 初始库存 + 补货累计（不看日期范围）；所有有初始库存的规格都列出
  for (const s of state.specs) {
    const init = (typeof s.initialStock === 'number' && isFinite(s.initialStock)) ? s.initialStock : (Number(s.stock) || 0);
    if (init <= 0) continue;
    let r = map.get(s.id);
    if (!r) {
      r = {
        specId: s.id,
        productName: productById(s.productId) ? productById(s.productId).name : '（已删除产品）',
        specName: s.name,
        restock: 0, qty: 0, fen: 0,
      };
      map.set(s.id, r);
    }
    r.restock = round1(r.restock + init);
  }
  // 补货记录累计（已删规格靠记录兜底）；补过货但没卖过的规格也列出来
  for (const rs of state.restocks) {
    let r = map.get(rs.specId);
    if (!r) {
      const spec = specById(rs.specId);
      r = {
        specId: rs.specId,
        productName: spec ? (productById(spec.productId) ? productById(spec.productId).name : '（已删除产品）') : (rs.productName || '（已删除产品）'),
        specName: spec ? spec.name : (rs.specName || ''),
        restock: 0, qty: 0, fen: 0,
      };
      map.set(rs.specId, r);
    }
    r.restock = round1(r.restock + rs.qty);
  }
  // 剩余数量 = 当前实际剩余（库存 − 已售，可能为负）；规格已删除的显示 —
  for (const r of map.values()) {
    const spec = specById(r.specId);
    r.rem = spec ? remaining(spec) : null;
  }
  const rows = [...map.values()].sort((a, b) => a.productName.localeCompare(b.productName, 'zh') || a.specName.localeCompare(b.specName, 'zh'));
  details.sort((a, b) => b.time - a.time);
  return { rows, details };
}
// 客户收款汇总：按订单上记录的客户名分组统计（客户删了也能统计到），
// 已支付金额 = 付款状态为已付款的订单金额，未支付金额 = 其余订单金额
function computeCustPay(start, end) {
  const map = new Map();
  for (const o of state.orders) {
    if (o.time < start || o.time > end) continue;
    const name = String(o.customerName || '') || '（未填客户）';
    let r = map.get(name);
    if (!r) { r = { name, totalFen: 0, paidFen: 0, unpaidFen: 0 }; map.set(name, r); }
    const total = Number(o.totalFen) || 0;
    r.totalFen += total;
    if (o.paid === true) r.paidFen += total; else r.unpaidFen += total;
  }
  return [...map.values()].sort((a, b) => b.totalFen - a.totalFen || a.name.localeCompare(b.name, 'zh'));
}
function renderStats() {
  document.querySelectorAll('#tab-stats .chip').forEach(ch => ch.classList.toggle('active', ch.dataset.range === ui.stRange));
  $('stStart').value = ui.stStart; $('stEnd').value = ui.stEnd;
  const { start, end } = ui.stRange === 'custom' ? parseDateRange(ui.stStart, ui.stEnd) : rangeFromChips(ui.stRange);
  const s = start == null ? -Infinity : start;
  const e = end == null ? Infinity : end;
  if (start != null && end != null && start > end) {
    $('statsSummary').innerHTML = '<div class="empty">日期范围不对（开始日期晚于结束日期）</div>';
    $('custPaySummary').innerHTML = '';
    $('statsDetail').innerHTML = '';
    return;
  }
  const { rows, details } = computeStats(s, e);
  let totalQty = 0, totalFen = 0, totalRestock = 0, totalRem = 0;
  const trs = rows.map(r => {
    totalQty = round1(totalQty + r.qty); totalFen += r.fen; totalRestock = round1(totalRestock + r.restock);
    if (r.rem != null) totalRem = round1(totalRem + r.rem);
    const remTxt = r.rem == null ? '—' : r.rem < 0 ? `<span style="color:#d92626;font-weight:700">${fmtQty(r.rem)}</span>` : fmtQty(r.rem);
    return `<tr><td>${esc(r.productName)}</td><td>${esc(r.specName)}</td><td>${fmtQty(r.restock)}</td><td>${fmtQty(r.qty)}</td><td>${remTxt}</td><td>${money(r.fen)}</td></tr>`;
  }).join('');
  $('statsSummary').innerHTML = rows.length
    ? '<table><tr><th>产品</th><th>规格</th><th>入库数</th><th>销售数量</th><th>剩余数量</th><th>销售金额</th></tr>' + trs + `<tr class="total-row"><td>合计</td><td></td><td>${fmtQty(totalRestock)}</td><td>${totalQty}</td><td>${fmtQty(totalRem)}</td><td>${money(totalFen)}</td></tr></table>`
    : '<div class="empty">这段时间没有销售或入库记录</div>';
  // 客户收款汇总
  const custs = computeCustPay(s, e);
  let cTotal = 0, cPaid = 0, cUnpaid = 0;
  const ctrs = custs.map(c => {
    cTotal += c.totalFen; cPaid += c.paidFen; cUnpaid += c.unpaidFen;
    const unpaidTxt = c.unpaidFen > 0 ? `<span style="color:#d92626;font-weight:700">${money(c.unpaidFen)}</span>` : money(0);
    return `<tr><td>${esc(c.name)}</td><td>${money(c.totalFen)}</td><td>${money(c.paidFen)}</td><td>${unpaidTxt}</td></tr>`;
  }).join('');
  $('custPaySummary').innerHTML = custs.length
    ? '<table><tr><th>客户名</th><th>总下单金额</th><th>已支付金额</th><th>未支付金额</th></tr>' + ctrs + `<tr class="total-row"><td>合计（${custs.length} 个客户）</td><td>${money(cTotal)}</td><td>${money(cPaid)}</td><td>${money(cUnpaid)}</td></tr></table>`
    : '<div class="empty">这段时间没有订单</div>';
  // 订单明细：支持搜索框过滤（订单号/客户/品名/规格）
  const dq = (ui.stDetailSearch || '').trim().toLowerCase();
  const shownDetails = dq ? details.filter(o => orderMatchesQ(o, dq)) : details;
  $('statsDetail').innerHTML = orderTable(shownDetails);
}

/* ==================== 智能库存分析报告 ==================== */
const REPORT_RECENT_DAYS = 30;   // 「近期」= 最近 30 天
const REPORT_LOW_STOCK = 5;      // 低库存线：剩余 1 ~ 5 件
const REPORT_TOP_N = 5;          // 动销榜单取前几名

function reportProductName(s) {
  const p = productById(s.productId);
  return p ? p.name : '（已删除产品）';
}
function reportSpecLabel(s) { return reportProductName(s) + ' ' + s.name; }
function reportRemText(s) {
  const rem = remaining(s);
  return rem > 0 ? '剩 ' + rem : rem < 0 ? '缺 ' + (-rem) : '无货';
}

function computeReportData() {
  const now = Date.now();
  const from = now - REPORT_RECENT_DAYS * 24 * 3600 * 1000;
  // 近 30 天每个规格的销量（只算现在还在的规格）
  const recent = new Map();
  const recentProducts = new Set();
  for (const o of state.orders) {
    if (o.time < from) continue;
    for (const it of o.items) {
      if (!specById(it.specId)) continue;
      recent.set(it.specId, round1((recent.get(it.specId) || 0) + it.qty));
      recentProducts.add(it.productId);
    }
  }
  const outOfStock = [], lowStock = [], neverSold = [], stagnant = [], good = [];
  let totalRem = 0;
  for (const s of state.specs) {
    const rem = remaining(s);
    totalRem = round1(totalRem + rem);
    if (rem <= 0) outOfStock.push(s);
    else if (rem <= REPORT_LOW_STOCK) lowStock.push(s);
    if (s.sold <= 0) { if (rem > 0) neverSold.push(s); }
    else if (rem > 0 && !recent.has(s.id)) stagnant.push(s);
    if (s.sold > 0) good.push(s);
  }
  const byName = (a, b) => reportSpecLabel(a).localeCompare(reportSpecLabel(b), 'zh');
  outOfStock.sort(byName); lowStock.sort(byName); neverSold.sort(byName); stagnant.sort(byName);
  good.sort((a, b) => b.sold - a.sold || byName(a, b));
  const topGood = good.slice(0, REPORT_TOP_N);
  // 客户收款（全部历史订单，报告不分日期范围）
  const custPay = computeCustPay(-Infinity, Infinity);
  let custTotalFen = 0, custPaidFen = 0, custUnpaidFen = 0;
  for (const c of custPay) { custTotalFen += c.totalFen; custPaidFen += c.paidFen; custUnpaidFen += c.unpaidFen; }
  const unpaidCusts = custPay.filter(c => c.unpaidFen > 0).sort((a, b) => b.unpaidFen - a.unpaidFen || a.name.localeCompare(b.name, 'zh'));
  return { now, recentProducts, outOfStock, lowStock, neverSold, stagnant, topGood, totalRem, custPay, custTotalFen, custPaidFen, custUnpaidFen, unpaidCusts };
}

function reportSummary(d) {
  if (!state.specs.length) return '还没有录入产品规格，先去「产品与客户」页添加。';
  const parts = [];
  if (d.outOfStock.length) parts.push('缺货 ' + d.outOfStock.length + ' 个');
  if (d.lowStock.length) parts.push('低库存 ' + d.lowStock.length + ' 个');
  const idleN = d.neverSold.length + d.stagnant.length;
  if (idleN) parts.push('长期未动销 ' + idleN + ' 个');
  return parts.length ? parts.join('、') + '，需要关注（详见下面）。' : '库存整体健康，暂无紧急事项。';
}

function reportSuggestions(d, nameCap) {
  // nameCap：每条建议最多点名几个规格（一页纸 PDF 用），超出加「…等 N 项」；不传 = 全列
  const namesOf = (list, fn) => {
    const shown = list.slice(0, nameCap || list.length).map(fn);
    if (nameCap && list.length > nameCap) shown.push('…等 ' + list.length + ' 项');
    return shown.join('、');
  };
  const sug = [];
  if (!state.specs.length) { sug.push('还没有产品数据，建议先到「产品与客户」页录入产品和规格。'); return sug; }
  if (d.outOfStock.length) sug.push('缺货：' + namesOf(d.outOfStock, s => reportSpecLabel(s) + '（' + reportRemText(s) + '）') + '，建议优先补货');
  if (d.lowStock.length) sug.push('低库存：' + namesOf(d.lowStock, s => reportSpecLabel(s) + '（' + reportRemText(s) + '）') + '，建议关注');
  const idle = d.neverSold.concat(d.stagnant).sort((a, b) => reportSpecLabel(a).localeCompare(reportSpecLabel(b), 'zh'));
  if (idle.length) sug.push('长期未动销：' + namesOf(idle, s => reportSpecLabel(s) + '（剩 ' + remaining(s) + '、' + (s.sold <= 0 ? '已售 0' : '近30天没卖动') + '）') + '，建议考虑促销或清理');
  if (d.topGood.length) sug.push('动销较好：' + namesOf(d.topGood.slice(0, 3), s => reportSpecLabel(s) + '（已售 ' + s.sold + '）') + '，建议保持库存充足，避免断货');
  if (d.unpaidCusts.length) {
    const ratio = d.custTotalFen > 0 ? Math.round(d.custUnpaidFen / d.custTotalFen * 100) : 0;
    sug.push('客户收款：未结清 ' + d.unpaidCusts.length + ' 家、共 ' + money(d.custUnpaidFen) + '（占下单总额 ' + ratio + '%）：' + namesOf(d.unpaidCusts, c => c.name + '（未付 ' + money(c.unpaidFen) + '）') + '，建议优先催收金额较大的客户');
  }
  if (!sug.length) sug.push('库存整体健康，暂无紧急事项，继续保持。');
  return sug;
}

function buildReportText(d) {
  const L = ['【库存分析报告】', ''];
  L.push('一、整体概况');
  L.push('- 产品规格总数：' + state.specs.length + ' 个');
  L.push('- 当前总库存数量：' + d.totalRem + ' 件');
  L.push('- 近 ' + REPORT_RECENT_DAYS + ' 天有销售的产品：' + d.recentProducts.size + ' 个');
  L.push('- 总结：' + reportSummary(d));
  L.push('');
  L.push('二、库存预警（需要关注）');
  L.push('- 缺货（剩余 ≤ 0）：' + (d.outOfStock.length ? d.outOfStock.map(s => reportSpecLabel(s) + '（' + reportRemText(s) + '）').join('、') : '无'));
  L.push('- 低库存（剩余 1~' + REPORT_LOW_STOCK + '）：' + (d.lowStock.length ? d.lowStock.map(s => reportSpecLabel(s) + '（' + reportRemText(s) + '）').join('、') : '无'));
  L.push('');
  L.push('三、滞销/积压情况');
  L.push('- 从没卖过（已售 0）：' + (d.neverSold.length ? d.neverSold.map(s => reportSpecLabel(s) + '（当前库存 ' + remaining(s) + '）').join('、') : '无'));
  L.push('- 有库存但近 ' + REPORT_RECENT_DAYS + ' 天没卖动：' + (d.stagnant.length ? d.stagnant.map(s => reportSpecLabel(s) + '（当前库存 ' + remaining(s) + '、已售 ' + s.sold + '）').join('、') : '无'));
  L.push('');
  L.push('四、动销较好的产品');
  L.push(d.topGood.length ? d.topGood.map(s => '- ' + reportSpecLabel(s) + '：已售 ' + s.sold + '、当前库存 ' + remaining(s)).join('\n') : '- 暂无（还没有卖出过任何产品）');
  L.push('');
  L.push('五、客户收款');
  L.push('- 有下单的客户：' + d.custPay.length + ' 个');
  L.push('- 总下单金额：' + money(d.custTotalFen) + '；已支付 ' + money(d.custPaidFen) + '（' + (d.custTotalFen > 0 ? Math.round(d.custPaidFen / d.custTotalFen * 100) : 0) + '%）；未支付 ' + money(d.custUnpaidFen));
  L.push('- 未结清客户：' + (d.unpaidCusts.length ? d.unpaidCusts.map(c => c.name + '（未付 ' + money(c.unpaidFen) + '）').join('、') : '无（全部已结清）'));
  L.push('');
  L.push('六、行动建议');
  const sug = reportSuggestions(d);
  for (let i = 0; i < sug.length; i++) L.push((i + 1) + '. ' + sug[i]);
  L.push('');
  L.push('七、报告生成时间');
  L.push(fmtTime(d.now));
  return L.join('\n');
}

function buildReportRows(d) {
  const rows = [];
  const listTable = (title, list, cols, cell) => {
    rows.push([title]);
    rows.push(cols);
    if (!list.length) { rows.push(['无']); return; }
    for (const s of list) rows.push(cell(s));
  };
  rows.push(['库存分析报告']);
  rows.push(['生成时间', fmtTime(d.now)]);
  rows.push([]);
  rows.push(['一、整体概况']);
  rows.push(['产品规格总数', state.specs.length + ' 个']);
  rows.push(['当前总库存数量', d.totalRem + ' 件']);
  rows.push(['近 ' + REPORT_RECENT_DAYS + ' 天有销售的产品', d.recentProducts.size + ' 个']);
  rows.push(['总结', reportSummary(d)]);
  rows.push([]);
  rows.push(['二、库存预警（需要关注）']);
  listTable('缺货（剩余 ≤ 0）', d.outOfStock, ['产品', '规格', '当前库存'], s => [reportProductName(s), s.name, reportRemText(s)]);
  listTable('低库存（剩余 1~' + REPORT_LOW_STOCK + '）', d.lowStock, ['产品', '规格', '当前库存'], s => [reportProductName(s), s.name, reportRemText(s)]);
  rows.push([]);
  rows.push(['三、滞销/积压情况']);
  listTable('从没卖过（已售 0）', d.neverSold, ['产品', '规格', '当前库存', '已售数'], s => [reportProductName(s), s.name, remaining(s), s.sold]);
  listTable('有库存但近 ' + REPORT_RECENT_DAYS + ' 天没卖动', d.stagnant, ['产品', '规格', '当前库存', '已售数'], s => [reportProductName(s), s.name, remaining(s), s.sold]);
  rows.push([]);
  rows.push(['四、动销较好的产品']);
  if (d.topGood.length) listTable('已售数前 ' + d.topGood.length + ' 名', d.topGood, ['产品', '规格', '已售数', '当前库存'], s => [reportProductName(s), s.name, s.sold, remaining(s)]);
  else rows.push(['暂无（还没有卖出过任何产品）']);
  rows.push([]);
  rows.push(['五、客户收款']);
  rows.push(['有下单的客户', d.custPay.length + ' 个']);
  rows.push(['总下单金额', money(d.custTotalFen)]);
  rows.push(['已支付金额', money(d.custPaidFen) + '（' + (d.custTotalFen > 0 ? Math.round(d.custPaidFen / d.custTotalFen * 100) : 0) + '%）']);
  rows.push(['未支付金额', money(d.custUnpaidFen)]);
  listTable('未结清客户', d.unpaidCusts, ['客户', '未支付金额'], c => [c.name, money(c.unpaidFen)]);
  rows.push([]);
  rows.push(['六、行动建议']);
  const sug = reportSuggestions(d);
  for (let i = 0; i < sug.length; i++) rows.push([(i + 1) + '. ' + sug[i]]);
  rows.push([]);
  rows.push(['七、报告生成时间']);
  rows.push([fmtTime(d.now)]);
  return rows;
}

function buildInventoryReport() {
  const d = computeReportData();
  return { d, text: buildReportText(d), rows: buildReportRows(d) };
}

/* 一页纸 PDF 版报告（竖版 A4 严格单页：每节清单最多列 8 条，超出显示「…等 N 项」，
   完整明细仍可从弹窗的 TXT/Excel 导出拿到。HTML 交给主进程隐藏窗口打印成 PDF） */
const REPORT_PDF_CAP = 8;

function buildReportHtml(d) {
  const esc2 = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cap = (list, fn) => {
    const shown = list.slice(0, REPORT_PDF_CAP).map(fn);
    if (list.length > REPORT_PDF_CAP) shown.push('<span class="more">…等 ' + list.length + ' 项（完整明细见 TXT/Excel 导出）</span>');
    return shown.join('、');
  };
  const nameList = (list, color) => (list.length
    ? cap(list, s => '<span class="warn ' + color + '">' + esc2(reportSpecLabel(s)) + '</span><span class="dim">（' + esc2(reportRemText(s)) + '）</span>')
    : '<span class="ok">无</span>');
  const neverList = (list) => (list.length
    ? cap(list, s => '<span class="warn">' + esc2(reportSpecLabel(s)) + '</span><span class="dim">（剩 ' + remaining(s) + ' · 已售 0）</span>')
    : '<span class="ok">无</span>');
  const stagnantList = (list) => (list.length
    ? cap(list, s => '<span class="warn">' + esc2(reportSpecLabel(s)) + '</span><span class="dim">（剩 ' + remaining(s) + ' · 近' + REPORT_RECENT_DAYS + '天没卖动）</span>')
    : '<span class="ok">无</span>');
  const goodList = d.topGood.length
    ? d.topGood.map(s => '<span class="warn green">' + esc2(reportSpecLabel(s)) + '</span><span class="dim">（已售 ' + s.sold + ' · 剩 ' + remaining(s) + '）</span>').join('、')
    : '<span class="ok">暂无</span>';
  const payPct = d.custTotalFen > 0 ? Math.round(d.custPaidFen / d.custTotalFen * 100) : 0;
  const unpaidList = d.unpaidCusts.length
    ? cap(d.unpaidCusts, c => '<span class="warn red">' + esc2(c.name) + '</span><span class="dim">（未付 ' + esc2(money(c.unpaidFen)) + '）</span>')
    : '<span class="ok">无（全部已结清）</span>';
  const sug = reportSuggestions(d, REPORT_PDF_CAP);
  const sugHtml = sug.map((t, i) => '<div><span class="snum">' + (i + 1) + '</span>' + esc2(t) + '</div>').join('');
  const kpi = (n, label, color) => '<div class="kpi ' + color + '"><div class="n">' + n + '</div><div class="l">' + label + '</div></div>';
  return '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><style>' +
    '*{margin:0;padding:0;box-sizing:border-box}' +
    'body{font-family:"Microsoft YaHei","微软雅黑",sans-serif;color:#1f2430;width:210mm;min-height:295mm;padding:10mm 12mm;font-size:10.5px;background:#fff;display:flex;flex-direction:column}' +
    '.hd{background:linear-gradient(135deg,#2f5fd0,#1e3f9e);color:#fff;border-radius:10px;padding:14px 18px;margin-bottom:10px}' +
    '.hd .t{font-size:21px;font-weight:700;letter-spacing:3px}' +
    '.hd .sub{margin-top:5px;font-size:10px;opacity:.88}' +
    '.kpis{display:flex;gap:8px;margin-bottom:10px}' +
    '.kpi{flex:1;border:1px solid #e3e7ef;border-radius:8px;padding:8px 4px;text-align:center;background:#fbfcfe}' +
    '.kpi .n{font-size:22px;font-weight:700;line-height:1.1}' +
    '.kpi .l{font-size:9px;color:#6b7280;margin-top:3px}' +
    '.kpi.red .n{color:#d92626}.kpi.orange .n{color:#e8820c}.kpi.blue .n{color:#2f5fd0}.kpi.green .n{color:#1f7a44}' +
    '.sum{background:#eef2fb;border-radius:8px;padding:7px 12px;font-size:10.5px;margin-bottom:10px;color:#33415c}' +
    '.sec{margin-bottom:9px}' +
    '.sec-h{font-size:13px;font-weight:700;color:#1e3f9e;border-left:4px solid #2f5fd0;padding-left:8px;margin-bottom:5px}' +
    '.chip{display:inline-block;font-size:9px;font-weight:700;color:#fff;border-radius:999px;padding:1px 7px;margin-left:6px;vertical-align:1px}' +
    '.chip.red{background:#d92626}.chip.orange{background:#e8820c}.chip.gray{background:#8a8f98}.chip.green{background:#1f7a44}' +
    '.row{margin-bottom:4px;line-height:1.55}' +
    '.row .lbl{color:#6b7280}' +
    '.warn{font-weight:700}' +
    '.warn.red{color:#d92626}.warn.orange{color:#e8820c}.warn.green{color:#1f7a44}' +
    '.dim{color:#6b7280}' +
    '.ok{color:#1f7a44;font-weight:700}' +
    '.more{color:#8a8f98;font-size:9.5px}' +
    '.sug{background:#fff6dd;border:1px solid #f0c36a;border-left:4px solid #e8820c;border-radius:8px;padding:10px 14px}' +
    '.sug .t{font-weight:700;color:#8a5a00;font-size:12.5px;margin-bottom:5px;letter-spacing:1px}' +
    '.sug div{line-height:1.6;margin-bottom:2px}' +
    '.snum{display:inline-block;min-width:14px;height:14px;line-height:14px;text-align:center;background:#e8820c;color:#fff;border-radius:999px;font-size:9px;font-weight:700;margin-right:5px}' +
    '.foot{margin-top:auto;text-align:center;font-size:9px;color:#8a8f98;padding-top:8px}' +
    '</style></head><body>' +
    '<div class="hd"><div class="t">库存分析报告</div><div class="sub">生成时间：' + esc2(fmtTime(d.now)) + ' · 数据范围：全部产品规格与订单记录</div></div>' +
    '<div class="kpis">' +
      kpi(state.specs.length, '规格总数', 'blue') +
      kpi(fmtQty(d.totalRem), '当前总库存', 'blue') +
      kpi(d.outOfStock.length, '缺货', 'red') +
      kpi(d.lowStock.length, '低库存', 'orange') +
      kpi(d.recentProducts.size, '近' + REPORT_RECENT_DAYS + '天动销', 'green') +
    '</div>' +
    '<div class="sum"><b>一、整体概况：</b>' + esc2(reportSummary(d)) + '</div>' +
    '<div class="sec"><div class="sec-h">二、库存预警<span class="chip red">缺货 ' + d.outOfStock.length + '</span><span class="chip orange">低库存 ' + d.lowStock.length + '</span></div>' +
      '<div class="row"><span class="lbl">缺货（剩余 ≤ 0）：</span>' + nameList(d.outOfStock, 'red') + '</div>' +
      '<div class="row"><span class="lbl">低库存（剩余 1~' + REPORT_LOW_STOCK + '）：</span>' + nameList(d.lowStock, 'orange') + '</div></div>' +
    '<div class="sec"><div class="sec-h">三、滞销/积压<span class="chip gray">' + (d.neverSold.length + d.stagnant.length) + ' 项</span></div>' +
      '<div class="row"><span class="lbl">从没卖过（已售 0）：</span>' + neverList(d.neverSold) + '</div>' +
      '<div class="row"><span class="lbl">近 ' + REPORT_RECENT_DAYS + ' 天没卖动：</span>' + stagnantList(d.stagnant) + '</div></div>' +
    '<div class="sec"><div class="sec-h">四、动销较好<span class="chip green">已售前 ' + d.topGood.length + ' 名</span></div>' +
      '<div class="row">' + goodList + '</div></div>' +
    '<div class="sec"><div class="sec-h">五、客户收款' + (d.unpaidCusts.length ? '<span class="chip red">未结清 ' + d.unpaidCusts.length + ' 家</span>' : '<span class="chip green">全部结清</span>') + '</div>' +
      '<div class="row"><span class="lbl">收款概况：</span>' + d.custPay.length + ' 个客户下单 · 总金额 ' + esc2(money(d.custTotalFen)) + ' · 已支付 ' + esc2(money(d.custPaidFen)) + '（' + payPct + '%）· 未支付 ' + esc2(money(d.custUnpaidFen)) + '</div>' +
      '<div class="row"><span class="lbl">未结清客户：</span>' + unpaidList + '</div></div>' +
    '<div class="sec"><div class="sec-h">六、行动建议</div>' +
      '<div class="sug"><div class="t">★ 建议优先处理</div>' + sugHtml + '</div></div>' +
    '<div class="foot">库存记录本 · 本报告由软件自动生成 · 生成时间 ' + esc2(fmtTime(d.now)) + '</div>' +
    '</body></html>';
}

async function copyReportText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
    return;
  } catch (_) {}
  // 老办法：临时文本框全选复制
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const okExec = document.execCommand('copy');
    ta.remove();
    if (okExec) { toast('已复制到剪贴板'); return; }
  } catch (_) {}
  // 最后兜底：交给主进程写剪贴板，任何情况都能复制成功
  const r = await window.dataStore.copyText(text);
  if (r && r.ok) toast('已复制到剪贴板');
  else toast('复制失败，请手动全选后复制', 'error');
}

function openReportModal() {
  const rpt = buildInventoryReport();
  openModal({
    title: '智能库存分析报告',
    body: '<div class="report-text">' + esc(rpt.text) + '</div>' +
      '<div class="note">报告基于当前库存和订单记录自动生成，可直接复制发给别人。</div>',
    wide: true,
    buttons: [
      { label: '导出 PDF（一页纸）', cls: 'primary', onClick: async () => {
        closeModal();
        const r = await window.dataStore.saveReportPdf(buildReportHtml(rpt.d));
        if (r.ok) toast('报告 PDF 已保存：' + r.path);
        else if (!r.canceled) toast('保存失败：' + (r.error || ''), 'error');
      } },
      { label: '复制全部文字', cls: 'gray', onClick: () => copyReportText(rpt.text) },
      { label: '导出 TXT', cls: 'gray', onClick: () => exportFile('库存分析报告' + dateStr() + '.txt', rpt.text) },
      { label: '导出 Excel', cls: 'gray', onClick: () => exportBillXlsx('库存分析报告' + dateStr() + '.xlsx', rpt.rows, '分析报告') },
      { label: '关闭', cls: 'gray', onClick: closeModal },
    ],
  });
}

/* ==================== 产品与客户管理 ==================== */
function renderManage() {
  // 搜索：品名和规格名都匹配（搜「螺丝」或「M6」都能找到）
  const t = ui.manSearch.trim().toLowerCase();
  let html = '';
  for (const p of state.products) {
    const specs = specsOfProduct(p.id);
    const pMatch = !t || p.name.toLowerCase().includes(t);
    const shown = !t ? specs : (pMatch ? specs : specs.filter(s => s.name.toLowerCase().includes(t)));
    // 没有规格的产品也要显示（否则刚新增的产品看不见，没法给它加规格）
    if (t && !pMatch && !shown.length) continue;
    html += `<div class="mg-product">
      <div class="mg-product-head"><span class="name">${esc(p.name)}</span>
        <span style="color:#8a8f98;font-size:13px">${specs.length} 个规格${specs.length ? '' : '（还没有规格，点右边「新增规格」后才会出现在新建页）'}</span>
        <button class="btn gray small" data-action="spec-add" data-product-id="${esc(p.id)}">新增规格</button>
        <button class="btn gray small" data-action="prod-edit" data-product-id="${esc(p.id)}">改名称</button>
        <button class="btn danger small" data-action="prod-del" data-product-id="${esc(p.id)}">删除产品</button>
      </div>` + shown.map(s => {
        const prices = tiersOf(s).map(t => TIERS[t].replace('价', '') + money(s.priceFen[t])).join(' · ');
        return `<div class="mg-spec">
          <span class="sname">${esc(s.name)}</span>
          <span class="sinfo">${remLabel(remaining(s))}（库存 ${s.stock} · 已售 ${s.sold}）${prices ? ' · ' + esc(prices) : ' · 未设价'}</span>
          <button class="btn gray small" data-action="spec-edit" data-spec-id="${esc(s.id)}">编辑</button>
          <button class="btn gray small" data-action="spec-fix" data-spec-id="${esc(s.id)}">纠错</button>
          <button class="btn danger small" data-action="spec-del" data-spec-id="${esc(s.id)}">删除</button>
        </div>`;
      }).join('') + '</div>';
  }
  const orphans = state.specs.filter(s => !productById(s.productId) && (!t || s.name.toLowerCase().includes(t)));
  if (orphans.length) {
    html += `<div class="mg-product"><div class="mg-product-head"><span class="name">（未分组规格）</span></div>` + orphans.map(s => {
      return `<div class="mg-spec">
        <span class="sname">${esc(s.name)}</span>
        <span class="sinfo">${remLabel(remaining(s))}（库存 ${s.stock} · 已售 ${s.sold}）</span>
        <button class="btn gray small" data-action="spec-edit" data-spec-id="${esc(s.id)}">编辑</button>
        <button class="btn gray small" data-action="spec-fix" data-spec-id="${esc(s.id)}">纠错</button>
        <button class="btn danger small" data-action="spec-del" data-spec-id="${esc(s.id)}">删除</button>
      </div>`;
    }).join('') + '</div>';
  }
  $('productList').innerHTML = html || (t ? '<div class="empty">没有匹配的产品或规格</div>' : '<div class="empty">还没有产品，点「新增产品」开始</div>');
  const ct = ui.custSearch.trim().toLowerCase();
  const custs = state.customers.filter(c => !ct || c.name.toLowerCase().includes(ct));
  $('customerList').innerHTML = custs.map(c => `<div class="mg-customer">
      <span class="cname">${esc(c.name)}</span>
      <span class="badge ${esc(c.type)}">${CUST_TYPES[c.type]}</span>
      <button class="btn gray small" data-action="cust-edit" data-customer-id="${esc(c.id)}">编辑</button>
      <button class="btn danger small" data-action="cust-del" data-customer-id="${esc(c.id)}">删除</button>
    </div>`).join('') || (ct ? '<div class="empty">没有匹配的客户</div>' : '<div class="empty">还没有客户，点「新增客户」开始</div>');
}

function openProductForm(p) {
  const isNew = !p;
  openModal({
    title: isNew ? '新增产品' : '修改产品名称',
    body: `<div class="form-row"><label>品名</label><input id="fProdName" maxlength="30" value="${isNew ? '' : esc(p.name)}" placeholder="例如：螺丝"></div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '保存', cls: 'primary', onClick: () => {
        const name = $('fProdName').value.trim();
        if (!name) { toast('请填写品名'); return; }
        if (isNew) {
          const np = { id: uid('p'), name };
          state.products.push(np);
          persist(); closeModal(); renderAll();
          toast('已保存。新建页显示的是「规格」，接下来给它加规格');
          // 自动弹出「新增规格」，带着用户走完完整流程（点取消也可以，以后随时能加）
          setTimeout(() => openSpecForm(np.id, null), 150);
        } else {
          p.name = name;
          persist(); closeModal(); renderAll(); toast('已保存');
        }
      } },
    ],
  });
  setTimeout(() => { const el = $('fProdName'); if (el) el.focus(); }, 50);
}

function openSpecForm(productId, s) {
  const isNew = !s;
  const pf = s ? s.priceFen : {};
  const yuan = t => (isNew || !isValidFen(pf[t])) ? '' : (pf[t] / 100);
  openModal({
    title: isNew ? '新增规格' : '修改规格',
    wide: true,
    body: `<div class="form-row"><label>规格名</label><input id="fSpecName" maxlength="30" value="${isNew ? '' : esc(s.name)}" placeholder="例如：M6×30"></div>
      <div class="form-row"><label>价格（元，至少填一档，不用的留空）</label>
        <div class="form-prices">
          <div class="form-row"><label>批发价</label><input id="fWh" type="text" inputmode="decimal" value="${yuan('wholesale')}"></div>
          <div class="form-row"><label>VIP价</label><input id="fVip" type="text" inputmode="decimal" value="${yuan('vip')}"></div>
          <div class="form-row"><label>零售价</label><input id="fRt" type="text" inputmode="decimal" value="${yuan('retail')}"></div>
        </div>
        <div class="note">价格随时可以改，已成交订单的价格不受影响。</div>
      </div>
      ${isNew ? `<div class="form-row"><label>初始库存（进货总量）</label><input id="fStock" type="text" inputmode="numeric" placeholder="例如：100"><div class="note">以后用「补货」在原数上累加，用「纠错」直接改。</div></div>` : ''}`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '保存', cls: 'primary', onClick: () => {
        const name = $('fSpecName').value.trim();
        if (!name) { toast('请填写规格名'); return; }
        const priceFen = {};
        for (const [t, id] of [['wholesale', 'fWh'], ['retail', 'fRt'], ['vip', 'fVip']]) {
          const v = $(id).value.trim();
          if (v === '') continue;
          const fen = fenFromYuan(v);
          if (!isValidFen(fen)) { toast('价格填写不对：' + v); return; }
          priceFen[t] = fen;
        }
        if (!Object.keys(priceFen).length) { toast('至少要填一档价格'); return; }
        if (isNew) {
          const stock = qtyNum($('fStock').value);
          if (!isFinite(stock) || stock < 0) { toast('初始库存填写不对（要 ≥0，最多一位小数）'); return; }
          state.specs.push({ id: uid('s'), productId, name, priceFen, stock, sold: 0, initialStock: stock });
        } else {
          s.name = name; s.priceFen = priceFen;
        }
        persist(); closeModal(); renderAll(); toast('已保存');
      } },
    ],
  });
}

function openFix(s) {
  openModal({
    title: '纠错：' + s.name,
    body: `<div class="form-row"><label>库存（进货累计总数）</label><input id="fStock" type="text" inputmode="numeric" value="${s.stock}"></div>
      <div class="form-row"><label>已售（累计）</label><input id="fSold" type="text" inputmode="numeric" value="${s.sold}"></div>
      <div class="note">剩余库存 = 库存 − 已售，会自动算出。盘点发现数字对不上时，在这里直接改成实际数字。</div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '保存', cls: 'primary', onClick: () => {
        const stock = qtyNum($('fStock').value); const sold = qtyNum($('fSold').value);
        if (!isFinite(stock) || stock < 0 || !isFinite(sold) || sold < 0) { toast('数字填写不对（要 ≥0，最多一位小数）'); return; }
        s.stock = stock; s.sold = sold;
        persist(); closeModal(); renderAll(); toast('已纠正');
      } },
    ],
  });
}

function confirmDeleteSpec(s) {
  if (s.sold > 0) {
    toast('「' + s.name + '」已有销售记录，不能删除（历史订单要靠它退回库存）。可以改名称或把价格改成 0。');
    return;
  }
  openModal({
    title: '删除规格',
    body: `<div>确定删除规格 <b>${esc(s.name)}</b> 吗？</div>
      <div class="note">${s.stock > 0 ? '注意：它的库存 ' + s.stock + ' 件也会一并删除。' : ''}删除后不可恢复。</div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '确认删除', cls: 'danger', onClick: () => {
        state.specs = state.specs.filter(x => x.id !== s.id);
        persist(); closeModal(); renderAll(); toast('已删除');
      } },
    ],
  });
}

function confirmDeleteProduct(p) {
  const specs = specsOfProduct(p.id);
  if (specs.some(s => s.sold > 0)) {
    toast('「' + p.name + '」下有规格已有销售记录，不能删除。可以把没用的规格改名称或把价格改成 0。');
    return;
  }
  openModal({
    title: '删除产品',
    body: `<div>确定删除产品 <b>${esc(p.name)}</b> 吗？</div>
      <div class="note">${specs.length ? '它的 ' + specs.length + ' 个规格也会一并删除。' : ''}删除后不可恢复。</div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '确认删除', cls: 'danger', onClick: () => {
        state.specs = state.specs.filter(x => x.productId !== p.id);
        state.products = state.products.filter(x => x.id !== p.id);
        persist(); closeModal(); renderAll(); toast('已删除');
      } },
    ],
  });
}

function openCustomerForm(c) {
  const isNew = !c;
  const t = c ? c.type : 'retail';
  openModal({
    title: isNew ? '新增客户' : '修改客户',
    body: `<div class="form-row"><label>客户名称</label><input id="fCustName" maxlength="30" value="${isNew ? '' : esc(c.name)}" placeholder="例如：张老板"></div>
      <div class="form-row"><label>客户类型（决定自动用哪档价）</label>
        <div class="radio-row">
          <label><input type="radio" name="ctype" value="wholesale" ${t === 'wholesale' ? 'checked' : ''}> 批发（批发价）</label>
          <label><input type="radio" name="ctype" value="vip" ${t === 'vip' ? 'checked' : ''}> VIP（VIP价）</label>
          <label><input type="radio" name="ctype" value="retail" ${t === 'retail' ? 'checked' : ''}> 零售（零售价）</label>
        </div></div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '保存', cls: 'primary', onClick: () => {
        const name = $('fCustName').value.trim();
        if (!name) { toast('请填写客户名称'); return; }
        const type = document.querySelector('input[name=ctype]:checked').value;
        if (isNew) state.customers.push({ id: uid('c'), name, type });
        else { c.name = name; c.type = type; }
        persist(); closeModal(); renderAll(); toast('已保存');
      } },
    ],
  });
}

function confirmDeleteCustomer(c) {
  openModal({
    title: '删除客户',
    body: `<div>确定删除客户 <b>${esc(c.name)}</b> 吗？</div>
      <div class="note">历史订单里记的客户名会原样保留，不受影响。</div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '确认删除', cls: 'danger', onClick: () => {
        state.customers = state.customers.filter(x => x.id !== c.id);
        if (ui.cartCustomerId === c.id) ui.cartCustomerId = '';
        persist(); closeModal(); renderAll(); toast('已删除');
      } },
    ],
  });
}

/* ==================== 批量建客户（Excel 模板导入）+ 导出客户名 ==================== */
const CUST_TYPE_LABEL = { '批发': 'wholesale', 'VIP': 'vip', '零售': 'retail', 'wholesale': 'wholesale', 'vip': 'vip', 'retail': 'retail' };
function parseCustomerType(text) { return CUST_TYPE_LABEL[String(text || '').trim()] || null; }

function openBatchCustomerModal() {
  openModal({
    title: '批量建客户',
    body: `<div>下载模板 → 在 Excel 里填好 → 导入，一次建好多个客户：</div>
      <div class="note">模板两列：<b>客户名 | 客户类型</b>。类型列在 Excel 里点一下单元格就有下拉框，直接选 批发/VIP/零售，不用打字。</div>
      <div class="note">客户名和软件里已有的重复会跳过并提示；类型没选或不对的行也会跳过。</div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '① 下载批量建客户模板', cls: 'gray', onClick: async () => {
        closeModal();
        const r = await window.dataStore.exportCustomerTemplate();
        if (r.ok) toast('模板已保存：' + r.path);
        else if (!r.canceled) toast('保存失败：' + (r.error || ''), 'error');
      } },
      { label: '② 选择填好的表格导入', cls: 'primary', onClick: async () => {
        closeModal();
        await pickCustomerFile();
      } },
    ],
  });
}

function buildCustomerPlan(rows) {
  const creates = [];   // {name, type}
  const problems = [];  // {rowNum, reason}
  const seen = new Set(); // 文件内重复名
  const existing = new Set(state.customers.map(c => c.name));
  for (const row of rows) {
    const name = row.name;
    if (!name) { problems.push({ rowNum: row.rowNum, reason: '客户名为空' }); continue; }
    if (existing.has(name) || seen.has(name)) { problems.push({ rowNum: row.rowNum, reason: '客户「' + name + '」已存在，跳过' }); continue; }
    const type = parseCustomerType(row.type);
    if (!type) { problems.push({ rowNum: row.rowNum, reason: '客户类型不对（要选 批发/VIP/零售）：' + (row.type || '（空）') }); continue; }
    seen.add(name);
    creates.push({ name, type });
  }
  return { creates, problems };
}

function showCustomerPreview(plan) {
  const rowsHtml = plan.creates.slice(0, 30).map(c => `<div>${esc(c.name)}（${CUST_TYPES[c.type]}）</div>`).join('')
    + (plan.creates.length > 30 ? `<div>…还有 ${plan.creates.length - 30} 个</div>` : '');
  const probHtml = plan.problems.slice(0, 20).map(p => `<div>第 ${p.rowNum} 行：${esc(p.reason)}</div>`).join('')
    + (plan.problems.length > 20 ? `<div>…还有 ${plan.problems.length - 20} 行问题</div>` : '');
  openModal({
    title: '确认批量建客户',
    wide: true,
    body: `<div style="font-size:16px">将新建 <b>${plan.creates.length}</b> 个客户
        ${plan.problems.length ? ` · <span style="color:var(--red)">问题行 ${plan.problems.length} 行（跳过）</span>` : ''}</div>
      <div style="margin-top:10px;max-height:220px;overflow:auto;font-size:14px">${rowsHtml}</div>
      ${probHtml ? `<div style="margin-top:10px;max-height:160px;overflow:auto;font-size:13px;color:var(--red)">${probHtml}</div>` : ''}`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '确认导入', cls: 'primary', onClick: () => applyCustomerPlan(plan) },
    ],
  });
}

function applyCustomerPlan(plan) {
  for (const c of plan.creates) state.customers.push({ id: uid('c'), name: c.name, type: c.type });
  persist(); closeModal(); renderAll();
  toast('批量建客户完成：新建 ' + plan.creates.length + ' 个' + (plan.problems.length ? '；跳过问题行 ' + plan.problems.length + ' 行' : ''));
}

async function pickCustomerFile() {
  const r = await window.dataStore.parseCustomerFile();
  if (r.canceled) return;
  if (!r.ok) { toast(r.error || '读不出这个文件', 'error'); return; }
  const plan = buildCustomerPlan(r.rows);
  if (!plan.creates.length) {
    toast(plan.problems.length ? '没有可新建的客户（' + plan.problems.length + ' 行有问题，请检查后重试）' : '表格里没有可导入的数据', 'warn');
    return;
  }
  showCustomerPreview(plan);
}

async function exportCustomersXlsx() {
  if (!state.customers.length) { toast('还没有客户，先建客户再导出', 'warn'); return; }
  const rows = [['客户名'], ...state.customers.map(c => [c.name])];
  await exportBillXlsx('客户名单' + dateStr() + '.xlsx', rows, '客户名单');
}

/* ==================== CSV 与备份导出 ==================== */
function csvCell(v) { return '"' + String(v ?? '').replace(/"/g, '""') + '"'; }
function buildOrdersCSV(list, opts) {
  // 分组排列：每笔订单 = 一行订单信息 + 若干明细行 + 空行分隔；末尾加醒目的总金额行
  // 2026-11-06：按需求去掉「产品」「价格档」两栏，其余保留
  // opts.bill=true（账单）：再按需求去掉「日期时间」列、客户名不带（批发/VIP）尾称
  const bill = !!(opts && opts.bill);
  const head = bill
    ? ['订单号', '客户', '规格', '单价(元)', '数量', '小计(元)', '订单总额(元)']
    : ['订单号', '日期时间', '客户', '规格', '单价(元)', '数量', '小计(元)', '订单总额(元)', '付款状态'];
  const lines = [head.map(csvCell).join(',')];
  let totalFen = 0;
  for (const o of list) {
    totalFen += o.totalFen || 0;
    const cust = bill ? o.customerName : o.customerName + '（' + (CUST_TYPES[o.customerType] || '') + '）';
    const infoRow = bill
      ? [o.orderNo, cust, '', '', '', '', (o.totalFen / 100).toFixed(2)]
      : [o.orderNo, fmtTime(o.time), cust, '', '', '', '', (o.totalFen / 100).toFixed(2), o.paid ? '已付款' : '未付款'];
    lines.push(infoRow.map(csvCell).join(','));
    for (const it of o.items) {
      const itemRow = bill
        ? ['', '', it.specName, (it.priceFen / 100).toFixed(2), fmtQty(it.qty), (Math.round(it.priceFen * it.qty) / 100).toFixed(2), '']
        : ['', '', '', it.specName, (it.priceFen / 100).toFixed(2), fmtQty(it.qty), (Math.round(it.priceFen * it.qty) / 100).toFixed(2), '', ''];
      lines.push(itemRow.map(csvCell).join(','));
    }
    lines.push('');
  }
  lines.push((bill ? ['========================================', '', '', '', '', '', ''] : ['========================================', '', '', '', '', '', '', '', '']).map(csvCell).join(','));
  const totalRow = bill
    ? ['', '', '', '', '★ 订单总金额（元） ★', '', (totalFen / 100).toFixed(2)]
    : ['', '', '', '', '', '★ 订单总金额（元） ★', '', (totalFen / 100).toFixed(2), ''];
  lines.push(totalRow.map(csvCell).join(','));
  return '﻿' + lines.join('\r\n');
}

// 合并账单导出（按用户模板排版，导出成 Excel 表格）：
// 按日期从早到晚分组 → 每天下面按客户分小节（【客户名】→ 表头行 → 明细 → 客户小计）
// → 每日合计 → 空行；末尾 ★ 总合计 ★。每笔订单只在第一条明细上带订单号。
// 金额存成数字（整数不带小数点，如 117；有小数才显示小数，如 10.5）
function buildBillSheet(list) {
  const rows = [];
  const byDay = new Map();
  for (const o of [...list].sort((a, b) => a.time - b.time)) {
    const k = todayStr(o.time);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(o);
  }
  let grandCount = 0, grandFen = 0;
  for (const [day, orders] of byDay) {
    rows.push(['===== ' + fmtDate(orders[0].time) + ' =====', '', '', '', '']);
    const byCust = new Map();
    for (const o of orders) {
      if (!byCust.has(o.customerId)) byCust.set(o.customerId, { name: o.customerName, list: [] });
      byCust.get(o.customerId).list.push(o);
    }
    const custs = [...byCust.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    let dayCount = 0, dayFen = 0;
    for (const cu of custs) {
      rows.push(['【' + cu.name + '】', '', '', '', '']);
      rows.push(['订单号', '规格', '单价(元)', '数量', '小计(元)']);
      let cCount = 0, cFen = 0;
      for (const o of cu.list) {
        cCount++; cFen += o.totalFen || 0;
        o.items.forEach((it, i) => {
          rows.push([i === 0 ? o.orderNo : '', it.specName, (it.priceFen || 0) / 100, Number(it.qty) || 0, Math.round((it.priceFen || 0) * (Number(it.qty) || 0)) / 100]);
        });
      }
      rows.push(['', cu.name + '小计：' + cCount + '单', '', '', cFen / 100]);
      dayCount += cCount; dayFen += cFen;
    }
    rows.push(['', fmtDate(orders[0].time) + '合计：' + dayCount + '单', '', '', dayFen / 100]);
    rows.push(['', '', '', '', '']);
    grandCount += dayCount; grandFen += dayFen;
  }
  rows.push(['', '★ 总合计：' + grandCount + '单★', '', '', grandFen / 100]);
  return rows;
}
async function exportFile(defaultName, content) {
  const r = await window.dataStore.saveFile({ defaultName, content });
  if (r.ok) toast('已导出：' + r.path);
  else if (!r.canceled) toast('导出失败：' + (r.error || ''), 'error');
  return r;
}
// 账单导出成 Excel 表格（.xlsx）：rows = 单元格二维数组（字符串/数字混合）
async function exportBillXlsx(defaultName, rows, sheetName) {
  const r = await window.dataStore.saveXlsx({ defaultName, rows, sheetName });
  if (r.ok) toast('已导出：' + r.path);
  else if (!r.canceled) toast('导出失败：' + (r.error || ''), 'error');
  return r;
}

function buildBackup() {
  return {
    app: '库存记录本', version: 2, exportedAt: fmtTime(Date.now()),
    products: state.products.map(p => ({ id: p.id, name: p.name })),
    specs: state.specs.map(s => ({
      id: s.id, productId: s.productId, name: s.name,
      prices: Object.fromEntries(Object.entries(s.priceFen || {}).map(([t, f]) => [t, f / 100])),
      stock: s.stock, sold: s.sold,
      initialStock: (typeof s.initialStock === 'number' && isFinite(s.initialStock)) ? s.initialStock : s.stock,
    })),
    customers: state.customers.map(c => ({ id: c.id, name: c.name, type: c.type })),
    orders: state.orders.map(o => ({
      id: o.id, orderNo: o.orderNo, time: fmtTime(o.time), ts: o.time,
      customerId: o.customerId,
      customerName: o.customerName, customerType: o.customerType,
      status: o.status === 'done' ? 'done' : 'pending', paid: o.paid === true,
      items: o.items.map(it => ({ specId: it.specId, productId: it.productId, productName: it.productName, specName: it.specName, price: it.priceFen / 100, tier: it.tier, qty: it.qty })),
      total: o.totalFen / 100,
    })),
    restocks: state.restocks.map(r => ({
      id: r.id, time: fmtTime(r.time), ts: r.time,
      productId: r.productId, productName: r.productName,
      specId: r.specId, specName: r.specName,
      qty: r.qty, way: r.way === 'import' ? 'import' : 'manual',
    })),
  };
}

function normalizeImport(d) {
  if (!d || typeof d !== 'object') return null;
  for (const k of ['products', 'specs', 'customers', 'orders']) if (!Array.isArray(d[k])) return null;
  const out = { version: 2, products: [], specs: [], customers: [], orders: [], restocks: [] };
  const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : NaN; };
  for (const p of d.products) {
    if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') continue;
    out.products.push({ id: p.id, name: p.name });
  }
  for (const s of d.specs) {
    if (!s || typeof s.id !== 'string' || typeof s.name !== 'string') return null;
    const priceFen = {};
    if (s.priceFen && typeof s.priceFen === 'object') {
      for (const t of TIER_KEYS) if (num(s.priceFen[t]) >= 0) priceFen[t] = Math.round(s.priceFen[t]);
    } else if (s.prices && typeof s.prices === 'object') {
      for (const t of TIER_KEYS) if (num(s.prices[t]) >= 0) priceFen[t] = Math.round(s.prices[t] * 100);
    }
    if (!Object.keys(priceFen).length) return null;
    const initialStock = num(s.initialStock);
    out.specs.push({ id: s.id, productId: String(s.productId || ''), name: s.name, priceFen, stock: Math.max(0, round1(num(s.stock)) || 0), sold: Math.max(0, round1(num(s.sold)) || 0), ...(isFinite(initialStock) && initialStock >= 0 ? { initialStock: round1(initialStock) } : {}) });
  }
  const specById = new Map(out.specs.map(s => [s.id, s]));
  for (const c of d.customers) {
    if (!c || typeof c.id !== 'string' || typeof c.name !== 'string') return null;
    out.customers.push({ id: c.id, name: c.name, type: TIER_KEYS.includes(c.type) ? c.type : 'retail' });
  }
  // 旧版导出备份可能没有 customerId：按「姓名+类型」或唯一姓名找回
  const custByNameType = new Map(out.customers.map(c => [c.name + '\u0001' + c.type, c.id]));
  const custByName = new Map();
  const nameCount = new Map();
  for (const c of out.customers) nameCount.set(c.name, (nameCount.get(c.name) || 0) + 1);
  for (const c of out.customers) if (nameCount.get(c.name) === 1) custByName.set(c.name, c.id);
  for (const o of d.orders) {
    if (!o || typeof o.id !== 'string' || !Array.isArray(o.items) || !o.items.length) return null;
    const ts = typeof o.ts === 'number' ? o.ts : (typeof o.time === 'number' ? o.time : Date.parse(o.time));
    if (!isFinite(ts)) return null;
    const customerName = String(o.customerName || '');
    const customerType = TIER_KEYS.includes(o.customerType) ? o.customerType : 'retail';
    const customerId = (typeof o.customerId === 'string' && o.customerId)
      ? o.customerId
      : (custByNameType.get(customerName + '\u0001' + customerType) || custByName.get(customerName) || '');
    const items = [];
    for (const it of o.items) {
      if (!it || typeof it.specId !== 'string') return null;
      const qty = round1(num(it.qty)); if (qty < 0.1) return null;
      let priceFen = num(it.priceFen);
      if (!isFinite(priceFen)) priceFen = num(it.price) * 100;
      if (!isFinite(priceFen) || priceFen < 0) return null;
      const spec = specById.get(it.specId);
      const productId = (typeof it.productId === 'string' && it.productId)
        ? it.productId
        : (spec ? spec.productId : '');
      items.push({ specId: it.specId, productId, productName: String(it.productName || ''), specName: String(it.specName || ''), priceFen: Math.round(priceFen), tier: TIER_KEYS.includes(it.tier) ? it.tier : 'retail', qty });
    }
    const totalFen = Math.round(num(o.totalFen)) || items.reduce((a, it) => a + Math.round(it.priceFen * it.qty), 0);
    out.orders.push({ id: o.id, orderNo: String(o.orderNo || ''), time: ts, customerId, customerName, customerType, status: o.status === 'done' ? 'done' : 'pending', paid: o.paid === true, items, totalFen });
  }
  if (Array.isArray(d.restocks)) {
    for (const r of d.restocks) {
      if (!r || typeof r.id !== 'string') continue;
      const ts = typeof r.ts === 'number' ? r.ts : (typeof r.time === 'number' ? r.time : Date.parse(r.time));
      if (!isFinite(ts)) continue;
      const qty = round1(num(r.qty));
      if (qty < 0.1) continue;
      out.restocks.push({ id: r.id, time: ts, productId: String(r.productId || ''), productName: String(r.productName || ''), specId: String(r.specId || ''), specName: String(r.specName || ''), qty, way: r.way === 'import' ? 'import' : 'manual' });
    }
  }
  return out;
}

/* ==================== 批量导入（Excel 模板） ==================== */
function buildImportPlan(rows) {
  const creates = [];   // {productName, specName, priceFen:{}, stock}
  const updates = [];   // {spec, priceFen:{}, stock: number|null}
  const problems = [];  // {rowNum, reason}
  const seen = new Map(); // 文件内重复行：后行覆盖前行
  for (const row of rows) {
    const pn = row.productName, sn = row.specName;
    if (!pn || !sn) { problems.push({ rowNum: row.rowNum, reason: '产品名或规格名为空' }); continue; }
    // 价格：留空=不动；填了必须合法
    const priceFen = {};
    let priceErr = '';
    for (const [tier, label, v] of [['wholesale', '批发价', row.wholesale], ['vip', 'VIP价', row.vip], ['retail', '零售价', row.retail]]) {
      if (v === '') continue;
      const fen = fenFromYuan(v);
      if (!isValidFen(fen)) { priceErr = label + '填写不对：' + v; break; }
      priceFen[tier] = fen;
    }
    if (priceErr) { problems.push({ rowNum: row.rowNum, reason: priceErr }); continue; }
    // 库存：留空=不动；填了必须 ≥0 且最多一位小数（如 100.2）
    let stock = null;
    if (row.stock !== '') {
      const n = qtyNum(row.stock);
      if (!isFinite(n) || n < 0) { problems.push({ rowNum: row.rowNum, reason: '库存填写不对（要 ≥0、最多一位小数）：' + row.stock }); continue; }
      stock = n;
    }
    const product = state.products.find(p => p.name === pn);
    const spec = product ? state.specs.find(s => s.productId === product.id && s.name === sn) : undefined;
    const key = pn + '\u0001' + sn;
    if (spec) {
      if (!Object.keys(priceFen).length && stock == null) continue; // 无变化的行静默跳过
      const prev = seen.get(key);
      if (prev && prev.type === 'update') prev.entry.priceFen = priceFen, prev.entry.stock = stock;
      else { const en = { spec, priceFen, stock }; updates.push(en); seen.set(key, { type: 'update', entry: en }); }
    } else {
      if (!Object.keys(priceFen).length) { problems.push({ rowNum: row.rowNum, reason: '新规格至少要填一档价格' }); continue; }
      const prev = seen.get(key);
      if (prev && prev.type === 'create') { prev.entry.priceFen = priceFen; prev.entry.stock = stock || 0; }
      else { const en = { productName: pn, specName: sn, priceFen, stock: stock || 0 }; creates.push(en); seen.set(key, { type: 'create', entry: en }); }
    }
  }
  return { creates, updates, problems };
}

function applyImportPlan(plan) {
  let newProducts = 0, newSpecs = 0, updated = 0;
  for (const c of plan.creates) {
    let product = state.products.find(p => p.name === c.productName);
    if (!product) { product = { id: uid('p'), name: c.productName }; state.products.push(product); newProducts++; }
    state.specs.push({ id: uid('s'), productId: product.id, name: c.specName, priceFen: c.priceFen, stock: c.stock, sold: 0, initialStock: c.stock });
    newSpecs++;
  }
  for (const u of plan.updates) {
    for (const [t, f] of Object.entries(u.priceFen)) u.spec.priceFen[t] = f;
    if (u.stock != null) u.spec.stock = u.stock;
    updated++;
  }
  persist(); closeModal(); renderAll();
  toast('导入完成：新增产品 ' + newProducts + ' 个、新增规格 ' + newSpecs + ' 个、更新 ' + updated + ' 行' + (plan.problems.length ? '；跳过问题行 ' + plan.problems.length + ' 行' : ''));
}

function openImportModal() {
  openModal({
    title: '批量导入（Excel 模板）',
    body: `<div class="note" style="margin-bottom:12px">把产品、规格、价格、库存填进表格一次导入。<br>表里有但软件里没有的产品/规格会<b>自动新建</b>；已有的会<b>更新价格/库存</b>（留空=不动）。</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn primary" id="impTemplate">① 下载导入模板</button>
        <button class="btn gray" id="impPick">② 选择填好的表格导入</button>
      </div>`,
    buttons: [{ label: '关闭', cls: 'gray', onClick: closeModal }],
  });
  $('impTemplate').addEventListener('click', async () => {
    const r = await window.dataStore.exportTemplate();
    if (r.ok) toast('模板已保存：' + r.path);
    else if (!r.canceled) toast('保存失败：' + (r.error || ''), 'error');
  });
  $('impPick').addEventListener('click', async () => {
    const r = await window.dataStore.parseImportFile();
    if (r.canceled) return;
    if (!r.ok) { toast(r.error || '读不出这个文件', 'error'); return; }
    const plan = buildImportPlan(r.rows);
    if (!plan.creates.length && !plan.updates.length) {
      toast(plan.problems.length ? '没有可导入的有效行（' + plan.problems.length + ' 行有问题，请检查后重试）' : '表格里没有可导入的数据', 'warn');
      return;
    }
    showImportPreview(plan);
  });
}

function showImportPreview(plan) {
  const newProdCount = new Set(plan.creates.map(c => c.productName).filter(n => !state.products.some(p => p.name === n))).size;
  const probHtml = plan.problems.slice(0, 20).map(p => `<div>第 ${p.rowNum} 行：${esc(p.reason)}</div>`).join('')
    + (plan.problems.length > 20 ? `<div>…还有 ${plan.problems.length - 20} 行问题</div>` : '');
  openModal({
    title: '确认导入',
    wide: true,
    body: `<div style="font-size:16px">
        新增产品 <b>${newProdCount}</b> 个 · 新增规格 <b>${plan.creates.length}</b> 个 · 更新价格/库存 <b>${plan.updates.length}</b> 行
        ${plan.problems.length ? ` · <span style="color:var(--red)">问题行 ${plan.problems.length} 行（跳过不导入）</span>` : ''}
      </div>
      ${probHtml ? `<div style="margin-top:10px;max-height:200px;overflow:auto;font-size:13px;color:var(--red)">${probHtml}</div>` : ''}
      <div class="note" style="margin-top:10px">导入只新增和更新，不会删除任何已有产品；已售数和已成交订单的价格不受影响。</div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '确认导入', cls: 'primary', onClick: () => applyImportPlan(plan) },
    ],
  });
}

/* ==================== 补货 ==================== */
function renderRestock() {
  const sel = $('rsSpec');
  let html = '<option value="">— 请选择产品规格 —</option>';
  for (const p of state.products) {
    const specs = specsOfProduct(p.id);
    if (specs.length) {
      html += `<optgroup label="${esc(p.name)}">` + specs.map(s =>
        `<option value="${esc(s.id)}" ${s.id === ui.rsSpecId ? 'selected' : ''}>${esc(s.name)}（${remLabel(remaining(s))} · 库存 ${s.stock}）</option>`).join('') + '</optgroup>';
    }
  }
  const orphans = state.specs.filter(s => !productById(s.productId));
  if (orphans.length) {
    html += `<optgroup label="（未分组规格）">` + orphans.map(s =>
      `<option value="${esc(s.id)}" ${s.id === ui.rsSpecId ? 'selected' : ''}>${esc(s.name)}（${remLabel(remaining(s))} · 库存 ${s.stock}）</option>`).join('') + '</optgroup>';
  }
  sel.innerHTML = html;
  renderRestockRecords();
}

function addRestockRecord(spec, qty, way) {
  const p = productById(spec.productId);
  state.restocks.push({
    id: uid('r'), time: Date.now(),
    productId: spec.productId, productName: p ? p.name : '未分组',
    specId: spec.id, specName: spec.name,
    qty, way, // way: manual 手动 / import 表格导入
  });
}

function doRestock() {
  const spec = specById($('rsSpec').value);
  if (!spec) { toast('请先选择产品规格'); return; }
  const n = qtyNum($('rsQty').value);
  if (!isFinite(n) || n <= 0) { toast('进货数量填写不对（要 >0，最多一位小数）'); return; }
  spec.stock = round1(spec.stock + n);
  addRestockRecord(spec, n, 'manual');
  $('rsQty').value = '';
  persist(); renderAll();
  toast('已补货 ' + n + ' 件，「' + spec.name + '」库存变为 ' + spec.stock);
}

function renderRestockRecords() {
  const t = ui.rsSearch.trim().toLowerCase();
  const all = [...state.restocks].sort((a, b) => b.time - a.time);
  const list = t ? all.filter(r => (r.productName || '').toLowerCase().includes(t) || (r.specName || '').toLowerCase().includes(t)) : all;
  $('restockList').innerHTML = list.length
    ? '<table><tr><th>时间</th><th>产品</th><th>规格</th><th>数量</th><th>方式</th></tr>' + list.map(r => `<tr>
        <td>${fmtTime(r.time)}</td>
        <td>${esc(r.productName)}</td>
        <td>${esc(r.specName)}</td>
        <td><b>+${r.qty}</b></td>
        <td>${r.way === 'import' ? '表格导入' : '手动补货'}</td>
      </tr>`).join('') + '</table>'
    : (t ? '<div class="empty">没有匹配的补货记录</div>' : '<div class="empty">还没有补货记录</div>');
}

// 补货表格导入：只找已有的产品/规格，找不到就跳过；库存累加
function buildRestockPlan(rows) {
  const problems = [];
  const agg = new Map(); // specId -> {spec, qty}（同一规格多行合并成一次补货）
  for (const row of rows) {
    const pn = row.productName, sn = row.specName;
    if (!pn || !sn) { problems.push({ rowNum: row.rowNum, reason: '产品名或规格名为空' }); continue; }
    const q = qtyNum(row.qty);
    if (!isFinite(q) || q <= 0) { problems.push({ rowNum: row.rowNum, reason: '补货数量填写不对（要 >0、最多一位小数）：' + (row.qty || '（空）') }); continue; }
    const product = state.products.find(p => p.name === pn);
    const spec = product ? state.specs.find(s => s.productId === product.id && s.name === sn) : undefined;
    if (!spec) { problems.push({ rowNum: row.rowNum, reason: '软件里没有「' + pn + ' / ' + sn + '」，请先在产品页建好' }); continue; }
    const e = agg.get(spec.id);
    if (e) e.qty = round1(e.qty + q); else agg.set(spec.id, { spec, qty: q });
  }
  return { updates: [...agg.values()], problems };
}

function applyRestockPlan(plan) {
  const totalQty = round1(plan.updates.reduce((a, u) => a + u.qty, 0));
  for (const u of plan.updates) {
    u.spec.stock = round1(u.spec.stock + u.qty);
    addRestockRecord(u.spec, u.qty, 'import');
  }
  persist(); closeModal(); renderAll();
  toast('补货导入完成：' + plan.updates.length + ' 个规格，共 ' + fmtQty(totalQty) + ' 件' + (plan.problems.length ? '；跳过问题行 ' + plan.problems.length + ' 行' : ''));
}

function showRestockPreview(plan) {
  const probHtml = plan.problems.slice(0, 20).map(p => `<div>第 ${p.rowNum} 行：${esc(p.reason)}</div>`).join('')
    + (plan.problems.length > 20 ? `<div>…还有 ${plan.problems.length - 20} 行问题</div>` : '');
  const rowsHtml = plan.updates.slice(0, 30).map(u => `<div>${esc(u.spec.name)}（${esc(productById(u.spec.productId) ? productById(u.spec.productId).name : '未分组')}）+${fmtQty(u.qty)} 件 → 库存 ${fmtQty(u.spec.stock)} + ${fmtQty(u.qty)} = ${fmtQty(u.spec.stock + u.qty)}</div>`).join('')
    + (plan.updates.length > 30 ? `<div>…还有 ${plan.updates.length - 30} 行</div>` : '');
  openModal({
    title: '确认补货导入',
    wide: true,
    body: `<div style="font-size:16px">将补货 <b>${plan.updates.length}</b> 个规格、共 <b>${fmtQty(plan.updates.reduce((a, u) => a + u.qty, 0))}</b> 件
        ${plan.problems.length ? ` · <span style="color:var(--red)">问题行 ${plan.problems.length} 行（跳过）</span>` : ''}</div>
      <div style="margin-top:10px;max-height:220px;overflow:auto;font-size:14px">${rowsHtml}</div>
      ${probHtml ? `<div style="margin-top:10px;max-height:160px;overflow:auto;font-size:13px;color:var(--red)">${probHtml}</div>` : ''}
      <div class="note" style="margin-top:10px">库存会在现有数字上累加，并记入补货记录。不会改动价格和已售数。</div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '确认导入', cls: 'primary', onClick: () => applyRestockPlan(plan) },
    ],
  });
}

async function pickRestockFile() {
  const r = await window.dataStore.parseRestockFile();
  if (r.canceled) return;
  if (!r.ok) { toast(r.error || '读不出这个文件', 'error'); return; }
  const plan = buildRestockPlan(r.rows);
  if (!plan.updates.length) {
    toast(plan.problems.length ? '没有可导入的有效行（' + plan.problems.length + ' 行有问题，请检查后重试）' : '表格里没有可导入的数据', 'warn');
    return;
  }
  showRestockPreview(plan);
}

/* ==================== 批量下单（卖货页表格导入） ==================== */
function openBatchOrderModal() {
  openModal({
    title: '批量下单（表格导入）',
    body: `<div>把一位客户的多笔订单填进表格，一次导入：</div>
      <div class="note">新模板<b>两列：订单号 | 订单明细</b>。一行一笔订单，明细格子里每行一条 <b>规格名=数量</b>（如 AA3=10，软件按规格名自动匹配产品），多条明细换行写。</div>
      <div class="note">以前那种 4 列表格（订单号 | 产品名 | 规格名 | 数量）也还能导入。</div>
      <div class="note">导入后选客户，第一笔订单先进入右侧订单栏，你依次点「下单」「确认成交」，成交后自动载入下一笔。</div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '① 下载批量下单模板', cls: 'gray', onClick: async () => {
        closeModal();
        const r = await window.dataStore.exportBatchOrderTemplate();
        if (r.ok) toast('模板已保存：' + r.path);
        else if (!r.canceled) toast('保存失败：' + (r.error || ''), 'error');
      } },
      { label: '② 选择填好的表格导入', cls: 'primary', onClick: async () => {
        closeModal();
        await pickBatchOrderFile();
      } },
    ],
  });
}

// 旧写法兜底：明细「产品名规格名」连写（如 螺丝M1），按软件里已有的产品/规格拆开；对不上返回 null
function splitBatchItemName(text) {
  const sorted = [...state.products].sort((a, b) => b.name.length - a.name.length);
  for (const p of sorted) {
    if (!text.startsWith(p.name)) continue;
    const rest = text.slice(p.name.length);
    if (!rest) continue;
    const spec = state.specs.find(s => s.productId === p.id && s.name === rest);
    if (spec) return { productName: p.name, specName: rest };
  }
  return null;
}

// 解析表格行 → 按订单号分组（同一规格多行合并数量）；对不上的行进 problems
function buildBatchPlan(rows) {
  const problems = [];
  const groups = new Map(); // orderNo -> Map(specId -> {spec, qty})
  for (const row of rows) {
    if (row.problem) { problems.push({ rowNum: row.rowNum, reason: row.problem }); continue; }
    if (!row.orderNo) { problems.push({ rowNum: row.rowNum, reason: '订单号为空' }); continue; }
    let pn = row.productName, sn = row.specName;
    if (!pn && row.item) {
      // 新写法：明细行只写规格名（如 AA3=10），按规格名全局匹配产品（规格名要求唯一）
      const sameName = state.specs.filter(s => s.name === row.item);
      if (sameName.length === 1) {
        const prod = productById(sameName[0].productId);
        pn = prod ? prod.name : '';
        sn = sameName[0].name;
      } else if (sameName.length > 1) {
        problems.push({ rowNum: row.rowNum, reason: '规格名「' + row.item + '」在软件里有重复（' + sameName.length + ' 个），请改成不重复的规格名再导入' });
        continue;
      } else {
        // 兼容旧写法：产品名规格名连写（如 螺丝M1=15）
        const sp = splitBatchItemName(row.item);
        if (!sp) { problems.push({ rowNum: row.rowNum, reason: '软件里没有「' + row.item + '」这个规格（每行要写成 规格名=数量，如 AA3=10；规格名要和软件里一致）' }); continue; }
        pn = sp.productName; sn = sp.specName;
      }
    }
    if (!pn || !sn) { problems.push({ rowNum: row.rowNum, reason: '产品名或规格名为空' }); continue; }
    const q = qtyNum(row.qty);
    if (!isFinite(q) || q < 0.1) { problems.push({ rowNum: row.rowNum, reason: '数量填写不对（要 ≥0.1、最多一位小数）：' + (row.qty || '（空）') }); continue; }
    const product = state.products.find(p => p.name === pn);
    const spec = product ? state.specs.find(s => s.productId === product.id && s.name === sn) : undefined;
    if (!spec) { problems.push({ rowNum: row.rowNum, reason: '软件里没有「' + pn + ' / ' + sn + '」，请先在产品页建好' }); continue; }
    if (!groups.has(row.orderNo)) groups.set(row.orderNo, new Map());
    const agg = groups.get(row.orderNo);
    const e = agg.get(spec.id);
    if (e) e.qty = round1(e.qty + q); else agg.set(spec.id, { spec, qty: q });
  }
  const list = [...groups.entries()].map(([orderNo, m]) => ({
    orderNo,
    items: [...m.values()],
    exists: state.orders.some(o => o.orderNo === orderNo),
  }));
  return { groups: list, problems };
}

// 预览：先选客户再确认（价格按客户类型档位算；换客户就重新渲染预览）
function renderBatchPreview(plan) {
  const cid = ui.batchCustomerId && customerById(ui.batchCustomerId) ? ui.batchCustomerId : (state.customers[0] ? state.customers[0].id : '');
  ui.batchCustomerId = cid;
  const c = customerById(cid);
  const tier = c ? c.type : 'retail';
  const priceOf = (spec) => resolvePrice(spec, tier);
  const totalFen = plan.groups.reduce((a, g) => a + g.items.reduce((x, it) => x + Math.round((priceOf(it.spec) || { fen: 0 }).fen * it.qty), 0), 0);
  const groupsHtml = plan.groups.slice(0, 30).map(g => {
    const gFen = g.items.reduce((x, it) => x + Math.round((priceOf(it.spec) || { fen: 0 }).fen * it.qty), 0);
    const rows = g.items.map(it => {
      const p = priceOf(it.spec);
      const pname = productById(it.spec.productId) ? productById(it.spec.productId).name : '未分组';
      return `<div class="batch-row"><span class="br-name">${esc(it.spec.name)}</span><span class="br-sub">${esc(pname)}</span><span>${fmtQty(it.qty)} × ${p ? money(p.fen) : '<span style="color:var(--red)">未设价</span>'} = <b>${p ? money(Math.round(p.fen * it.qty)) : '—'}</b></span></div>`;
    }).join('');
    return `<div class="batch-group"><div class="bg-head">订单号 <b>${esc(g.orderNo)}</b> · ${g.items.length} 项 · 合计 <b>${money(gFen)}</b>${g.exists ? ' · <span style="color:var(--red)">⚠ 这个订单号已经用过，下单时会提示</span>' : ''}</div>${rows}</div>`;
  }).join('') + (plan.groups.length > 30 ? `<div>…还有 ${plan.groups.length - 30} 笔订单</div>` : '');
  const probHtml = plan.problems.slice(0, 20).map(p => `<div>第 ${p.rowNum} 行：${esc(p.reason)}</div>`).join('')
    + (plan.problems.length > 20 ? `<div>…还有 ${plan.problems.length - 20} 行问题</div>` : '');
  const noPriceCount = plan.groups.reduce((a, g) => a + g.items.filter(it => !priceOf(it.spec)).length, 0);
  openModal({
    title: '批量下单预览',
    wide: true,
    body: `<div>共 <b>${plan.groups.length}</b> 笔订单、<b>${plan.groups.reduce((a, g) => a + g.items.length, 0)}</b> 行明细，合计 <b>${money(totalFen)}</b>
        ${plan.problems.length ? ` · <span style="color:var(--red)">问题行 ${plan.problems.length} 行（跳过）</span>` : ''}</div>
      <div style="margin-top:10px"><label>客户
        <select id="batchCustSel" ${state.customers.length ? '' : 'disabled'}>
          ${state.customers.map(x => `<option value="${esc(x.id)}" ${x.id === cid ? 'selected' : ''}>${esc(x.name)}（${CUST_TYPES[x.type]}）</option>`).join('')}
        </select></label></div>
      ${state.customers.length ? '' : '<div class="note" style="color:var(--red)">还没有客户，请先到「产品与客户」页新增客户</div>'}
      <div style="margin-top:10px;max-height:240px;overflow:auto">${groupsHtml}</div>
      ${probHtml ? `<div style="margin-top:10px;max-height:140px;overflow:auto;font-size:13px;color:var(--red)">${probHtml}</div>` : ''}
      ${noPriceCount ? `<div class="note" style="color:var(--red)">有 ${noPriceCount} 行规格没设这个客户类型的价格，下单时无法成交，请先去产品页补价格或在订单栏里移除</div>` : ''}
      <div class="note" style="margin-top:10px">确认后第一笔订单会进入右侧订单栏（订单号自动填好），依次「下单」「确认成交」，成交后自动载入下一笔。</div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: closeModal },
      { label: '确认导入（' + plan.groups.length + ' 笔）', cls: 'primary', onClick: () => confirmBatchImport(plan) },
    ],
  });
  const sel = $('batchCustSel');
  if (sel) sel.addEventListener('change', () => { ui.batchCustomerId = sel.value; renderBatchPreview(plan); });
}

function confirmBatchImport(plan) {
  const c = customerById(ui.batchCustomerId);
  if (!c) { toast('请先选择客户'); return; }
  ui.batchCustomerId = c.id;
  ui.batchQueue = plan.groups.map(g => ({ orderNo: g.orderNo, items: g.items.map(it => ({ specId: it.spec.id, qty: it.qty })) }));
  ui.batchTotal = ui.batchQueue.length;
  closeModal();
  loadNextBatchOrder();
}

// 把队列里下一笔订单载入订单栏（订单号自动填好、客户就位、价格按客户类型自动算）
function loadNextBatchOrder() {
  if (!ui.batchQueue.length) return;
  const g = ui.batchQueue.shift();
  const done = ui.batchTotal - ui.batchQueue.length;
  ui.cartCustomerId = ui.batchCustomerId;
  ui.cartOrderNo = g.orderNo;
  ui.cartTier = 'auto';
  ui.cart = g.items.map(it => ({ specId: it.specId, qty: it.qty }));
  renderSell();
  const c = customerById(ui.batchCustomerId);
  toast('已载入第 ' + done + '/' + ui.batchTotal + ' 笔订单：' + g.orderNo + '（' + (c ? c.name : '未选客户') + ' · ' + money(cartTotals().total) + '），请在订单栏确认下单');
}

async function pickBatchOrderFile() {
  const r = await window.dataStore.parseBatchOrderFile();
  if (r.canceled) return;
  if (!r.ok) { toast(r.error || '读不出这个文件', 'error'); return; }
  const plan = buildBatchPlan(r.rows);
  if (!plan.groups.length) {
    toast(plan.problems.length ? '没有可导入的有效行（' + plan.problems.length + ' 行有问题，请检查后重试）' : '表格里没有可导入的数据', 'warn');
    return;
  }
  renderBatchPreview(plan);
}

/* ==================== 截图识别订单 ==================== */
function openOcrModal() {
  if (!state.products.length) { toast('请先到「产品与客户」页录入产品，识别后才能自动对上订单'); return; }
  Object.assign(ocr, { open: true, pickerOpen: false, busy: false, imgDataUrl: '', text: '', lines: [], rows: [], ignoredCount: 0, durationMs: 0, error: '' });
  document.addEventListener('paste', ocrOnPaste);
  renderOcrModal();
}

// 重建识别弹窗（从规格选择器返回时复用）
function renderOcrModal() {
  openModal({
    title: '识别订单（截图/照片）',
    xl: true,
    body: `<div class="ocr-body">
      <div class="ocr-left">
        <div class="ocr-imgbox" id="ocrImgBox"></div>
        <div class="ocr-left-actions">
          <button class="btn primary" id="ocrPick">选择图片…</button>
          <input type="file" id="ocrFile" accept="image/*" hidden>
          <span class="note">或直接按 Ctrl+V 粘贴截图</span>
        </div>
        <div class="ocr-paste">
          <textarea id="ocrPaste" rows="4" placeholder="或者：把微信聊天里的订单文字直接复制粘贴到这里（一行一样产品），再点右边按钮识别"></textarea>
          <div class="ocr-paste-row">
            <button class="btn gray" id="ocrPasteGo">识别粘贴的文字</button>
            <span class="note">识别后同样在右侧逐行核对</span>
          </div>
        </div>
      </div>
      <div class="ocr-right">
        <div class="ocr-status" id="ocrStatus"></div>
        <div class="ocr-rows" id="ocrRows"></div>
        <div style="margin-top:8px"><button class="btn gray" id="ocrAddRow">＋ 补一行（识别漏了的）</button></div>
      </div>
    </div>`,
    buttons: [
      { label: '取消', cls: 'gray', onClick: ocrClose },
      { label: '全部加入订单', cls: 'primary', onClick: ocrAddAllToCart },
    ],
  });
  $('ocrPick').addEventListener('click', () => $('ocrFile').click());
  $('ocrFile').addEventListener('change', e => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) handleOcrImage(f);
  });
  $('ocrPasteGo').addEventListener('click', () => {
    const text = $('ocrPaste').value.trim();
    if (!text) { toast('先粘贴订单文字，再点「识别粘贴的文字」'); return; }
    handleOcrText(text);
  });
  $('ocrAddRow').addEventListener('click', () => {
    ocr.pickerOpen = true;
    openSpecPicker(spec => {
      ocr.pickerOpen = false;
      ocr.rows.push({ kind: 'spec', specId: spec.id, productId: spec.productId, qty: 1, qtyGiven: false, raw: '（手动补充）' });
      renderOcrModal();
    }, '', () => { ocr.pickerOpen = false; renderOcrModal(); });
  });
  $('ocrRows').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const rowEl = btn.closest('.ocr-row');
    const row = ocr.rows[+rowEl.dataset.rowIdx];
    const a = btn.dataset.action;
    if (a === 'ocr-del') { ocr.rows.splice(+rowEl.dataset.rowIdx, 1); renderOcrRows(); updateOcrStatus(); }
    else if (a === 'ocr-pick') {
      ocr.pickerOpen = true;
      openSpecPicker(spec => {
        ocr.pickerOpen = false;
        const q = OcrMatch.qtyForRawWithSpec(row.raw, spec.name);
        Object.assign(row, { kind: 'spec', specId: spec.id, productId: spec.productId });
        if (q) { row.qty = q; row.qtyGiven = true; }
        renderOcrModal();
      }, OcrMatch.stripQtyForSearch(row.raw), () => { ocr.pickerOpen = false; renderOcrModal(); });
    }
    else if (a === 'ocr-chip') {
      const spec = specById(btn.dataset.specId);
      if (spec) { Object.assign(row, { kind: 'spec', specId: spec.id, productId: spec.productId }); renderOcrRows(); updateOcrStatus(); }
    }
    else if (a === 'ocr-sugg') {
      const spec = specById(btn.dataset.specId);
      if (!spec) return;
      // 原文里确实包含这个规格名时重新推数量；没有（比如 vip10 选 vp10）就保留现有数量
      let q = null;
      try {
        if (OcrMatch.normForMatch(row.raw || '').includes(OcrMatch.normForMatch(spec.name))) q = OcrMatch.qtyForRawWithSpec(row.raw, spec.name);
      } catch (_) {}
      Object.assign(row, { kind: 'spec', specId: spec.id, productId: spec.productId, suggestions: null, ambiguous: null });
      if (q) { row.qty = q; row.qtyGiven = true; }
      renderOcrRows(); updateOcrStatus();
    }
  });
  $('ocrRows').addEventListener('input', e => {
    const inp = e.target.closest('.ocr-qty');
    if (!inp) return;
    const row = ocr.rows[+inp.closest('.ocr-row').dataset.rowIdx];
    // 输入过程中不打断（允许先打 "1." 再补小数），失焦时统一修正
    const v = qtyNum(inp.value);
    if (v > 99999) { inp.value = 99999; row.qty = 99999; }
    else if (isFinite(v) && v >= 0.1) row.qty = v;
    row.qtyGiven = true;
    updateOcrStatus();
  });
  $('ocrRows').addEventListener('change', e => {
    const inp = e.target.closest('.ocr-qty');
    if (!inp) return;
    const row = ocr.rows[+inp.closest('.ocr-row').dataset.rowIdx];
    const v = qtyNum(inp.value);
    if (!isFinite(v) || v < 0.1) { inp.value = 1; row.qty = 1; }
    else if (v > 99999) { inp.value = 99999; row.qty = 99999; }
    row.qtyGiven = true;
    updateOcrStatus();
  });
  renderOcrImage(); updateOcrStatus(); renderOcrRows();
}

function ocrClose() {
  ocr.open = false; ocr.pickerOpen = false;
  document.removeEventListener('paste', ocrOnPaste);
  closeModal();
}

function ocrOnPaste(e) {
  if (!ocr.open) return;
  if (ocr.busy) { toast('正在识别中，请稍候'); return; }
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) { e.preventDefault(); handleOcrImage(f); }
      return;
    }
  }
}

async function handleOcrImage(file) {
  if (file.size > 20 * 1024 * 1024) { toast('图片太大（超过 20MB），请压缩或截小一点'); return; }
  const dataUrl = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(file); });
  if (!ocr.open) return;
  ocr.imgDataUrl = dataUrl; ocr.text = ''; ocr.error = '';
  renderOcrImage();
  ocr.busy = true; ocr.lines = []; ocr.rows = [];
  updateOcrStatus(); renderOcrRows();
  let buf;
  try { buf = await file.arrayBuffer(); } catch { ocr.busy = false; toast('读不出这张图片，请换一张'); updateOcrStatus(); return; }
  const r = await window.dataStore.ocrImage(buf);
  if (!ocr.open) return; // 弹窗已关，结果丢弃
  ocr.busy = false;
  if (!r.ok) { ocr.error = r.error === 'busy' ? '正在识别中，请稍候' : r.error; updateOcrStatus(); return; }
  ocr.lines = r.lines || [];
  ocr.durationMs = r.durationMs || 0;
  const mr = OcrMatch.matchOcrLines(ocr.lines, state.specs, state.products);
  ocr.rows = mr.rows; ocr.ignoredCount = mr.ignoredCount;
  updateOcrStatus(); renderOcrRows();
}

// 粘贴文字识别：直接把微信聊天文字按行解析，走和截图识别一样的匹配流程
function handleOcrText(text) {
  ocr.text = text; ocr.imgDataUrl = ''; ocr.error = '';
  renderOcrImage();
  ocr.lines = text.split(/\r?\n/).map(t => ({ text: String(t || '').trim(), conf: 0 })).filter(l => l.text);
  const mr = OcrMatch.matchOcrLines(ocr.lines, state.specs, state.products);
  ocr.rows = mr.rows; ocr.ignoredCount = mr.ignoredCount; ocr.durationMs = 0;
  updateOcrStatus(); renderOcrRows();
}

function ocrHasSource() { return !!(ocr.imgDataUrl || ocr.text); }

function renderOcrImage() {
  const box = $('ocrImgBox'); if (!box) return;
  if (ocr.imgDataUrl) box.innerHTML = `<img src="${ocr.imgDataUrl}" alt="订单截图">`;
  else if (ocr.text) box.innerHTML = `<div class="ocr-pasted-text">${esc(ocr.text)}</div>`;
  else box.innerHTML = '<div class="empty">还没有图片或文字<br>点「选择图片」，或回微信截图后按 Ctrl+V 粘贴<br>也可以把订单文字粘贴到下方文本框</div>';
}

function updateOcrStatus() {
  const el = $('ocrStatus'); if (!el) return;
  if (ocr.busy) { el.textContent = '正在识别文字，请稍候…（第一次会慢一点，约几秒）'; el.className = 'ocr-status'; return; }
  if (ocr.error) { el.textContent = '识别失败：' + ocr.error + '。点「选择图片」或重新粘贴可重试。'; el.className = 'ocr-status error'; return; }
  if (!ocrHasSource()) { el.textContent = ''; return; }
  if (!ocr.lines.length) { el.textContent = '没有识别出文字行。试试把聊天窗口放大点、截清楚些再截一次，或直接粘贴文字。'; el.className = 'ocr-status'; return; }
  const matched = ocr.rows.filter(r => r.specId).length;
  const unmatched = ocr.rows.filter(r => !r.specId).length;
  el.textContent = `识别出 ${ocr.lines.length} 行 · 自动对上 ${matched} 行 · 忽略 ${ocr.ignoredCount} 行` + (ocr.durationMs ? ` · 用时 ${(ocr.durationMs / 1000).toFixed(1)} 秒` : '') + (unmatched ? ` · 还有 ${unmatched} 行未对上，请手动处理` : '');
  el.className = 'ocr-status';
}

function renderOcrRows() {
  const box = $('ocrRows'); if (!box) return;
  if (ocr.busy || !ocrHasSource()) { box.innerHTML = ''; return; }
  if (!ocr.rows.length) {
    box.innerHTML = '<div class="empty">' + (ocr.lines.length ? '识别出 ' + ocr.lines.length + ' 行文字，但没有自动对上产品。<br>请逐行点「对应产品」手动选择，或点「＋ 补一行」。' : '') + '</div>';
    return;
  }
  box.innerHTML = ocr.rows.map((r, i) => {
    if (r.kind === 'none') {
      const suggs = (r.suggestions || []).map(s => `<button class="btn gray small ocr-chip" data-action="ocr-sugg" data-spec-id="${esc(s.specId)}" title="点一下对应到 ${esc(s.productName)} ${esc(s.specName)}">${esc(s.productName)} ${esc(s.specName)}</button>`).join(' ');
      return `<div class="ocr-row none" data-row-idx="${i}">
        <span class="or-raw">${esc(r.raw)}</span>
        ${suggs ? '<span class="or-note">疑似：</span>' + suggs : ''}
        <button class="btn gray small" data-action="ocr-pick">对应产品</button>
        <button class="btn danger small" data-action="ocr-del">删除</button>
      </div>`;
    }
    if (r.kind === 'product') {
      const p = productById(r.productId);
      const cands = (r.candidates || []).map(specById).filter(Boolean);
      const chips = cands.map(s => `<button class="btn gray small ocr-chip" data-action="ocr-chip" data-spec-id="${esc(s.id)}">${esc(s.name)}</button>`).join(' ') || '<span style="color:var(--gray);font-size:13px">（该产品下没有规格）</span>';
      return `<div class="ocr-row" data-row-idx="${i}">
        <span class="or-name">${esc(p ? p.name : '?')}</span>
        <input class="ocr-qty" type="text" inputmode="numeric" value="${r.qty}">
        <span class="or-note">选规格：</span>${chips}
        <button class="btn danger small" data-action="ocr-del">删除</button>
      </div>`;
    }
    const spec = specById(r.specId);
    const p = productById(r.productId);
    const rem = spec ? remaining(spec) : null;
    return `<div class="ocr-row" data-row-idx="${i}">
      <span class="or-ok">✓</span>
      <span class="or-name">${esc(spec ? spec.name : '?')}</span>
      <span class="or-sub">${esc(p ? p.name : '')}${rem != null ? ' · ' + remLabel(rem) : ''}</span>
      <input class="ocr-qty" type="text" inputmode="numeric" value="${r.qty}">
      <span class="or-note">${r.qtyGiven ? '' : '默认1，请核对'}</span>
      <button class="btn danger small" data-action="ocr-del">删除</button>
    </div>`;
  }).join('');
}

function ocrAddAllToCart() {
  const picks = [];
  for (const r of ocr.rows) {
    if (!r.specId) continue;
    const spec = specById(r.specId);
    if (!spec) continue;
    picks.push({ specId: r.specId, qty: r.qty });
  }
  if (!picks.length) { toast('还没有对应到产品的行，请先点「对应产品」或「＋ 补一行」'); return; }
  // 按规格聚合（库存允许卖成负数，不再校验剩余）
  const agg = new Map();
  for (const p of picks) agg.set(p.specId, round1((agg.get(p.specId) || 0) + p.qty));
  for (const [specId, qty] of agg) {
    const ex = ui.cart.find(x => x.specId === specId);
    if (ex) ex.qty = round1(ex.qty + qty); else ui.cart.push({ specId, qty });
  }
  ocrClose();
  renderCart(); renderSpecList();
  toast('已把 ' + agg.size + ' 种产品加入订单，请核对数量总价，填订单号后点「下单」');
}

/* ==================== 事件绑定 ==================== */
function bindEvents() {
  // tab 切换
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    ui.tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tabpage').forEach(p => p.classList.toggle('active', p.id === 'tab-' + ui.tab));
  }));

  // 卖货：本单信息（客户可搜索下拉）
  const custInp = $('custPickInput');
  const custList = $('custPickList');
  custInp.addEventListener('focus', () => { custInp.value = ''; renderCustPickList(''); custList.hidden = false; });
  custInp.addEventListener('input', () => { renderCustPickList(custInp.value); custList.hidden = false; });
  custInp.addEventListener('blur', () => {
    // 延迟收起，让点选先生效；没选的话恢复显示已选客户名
    setTimeout(() => {
      custList.hidden = true;
      const c = customerById(ui.cartCustomerId);
      custInp.value = c ? c.name : '';
    }, 150);
  });
  custList.addEventListener('mousedown', e => {
    e.preventDefault(); // 保持输入框焦点，避免 blur 抢先
    const item = e.target.closest('.cust-pick-item');
    if (!item) return;
    ui.cartCustomerId = item.dataset.customerId;
    renderCart(); updateTierHint(); updateCartMeta();
    const c = customerById(ui.cartCustomerId);
    custInp.value = c ? c.name : '';
    custList.hidden = true;
  });
  $('inpOrderNo').addEventListener('input', e => { ui.cartOrderNo = e.target.value; updateCartMeta(); });
  $('btnBatchOrder').addEventListener('click', openBatchOrderModal);
  document.querySelector('.tier-pick').addEventListener('click', e => {
    const btn = e.target.closest('.tier-btn'); if (!btn) return;
    ui.cartTier = btn.dataset.tier;
    renderSellConfig(); renderCart();
    if (ui.cart.length) toast(ui.cartTier === 'auto' ? '已切回自动选价' : '本单固定用' + TIERS[ui.cartTier] + '，订单内已重新计价');
  });

  // 卖货：产品卡
  $('inpSearch').addEventListener('input', e => { ui.search = e.target.value; renderSpecList(); });
  $('specList').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('.spec-card');
    const specId = card.dataset.specId;
    const inp = card.querySelector('.qty-inp');
    let q = qtyNum(inp.value) || 1;
    if (btn.dataset.action === 'spec-minus') { q = Math.max(0.1, round1(q - 1)); inp.value = q; }
    else if (btn.dataset.action === 'spec-plus') { q = round1(q + 1); inp.value = q; }
    else if (btn.dataset.action === 'spec-add') addToCart(specId, q);
  });
  $('specList').addEventListener('input', e => {
    // 输入过程中不打断，失焦时统一修正
    const inp = e.target.closest('.qty-inp');
    if (!inp) return;
    const v = qtyNum(inp.value);
    if (v > 99999) inp.value = 99999;
  });
  $('specList').addEventListener('change', e => {
    const inp = e.target.closest('.qty-inp');
    if (!inp) return;
    const v = qtyNum(inp.value);
    if (!isFinite(v) || v < 0.1) inp.value = 1;
    else if (v > 99999) inp.value = 99999;
  });

  // 卖货：订单栏
  $('btnOcrOpen').addEventListener('click', openOcrModal);
  $('cartItems').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const specId = btn.closest('.cart-item').dataset.specId;
    if (btn.dataset.action === 'cart-minus') changeCartQty(specId, -1);
    else if (btn.dataset.action === 'cart-plus') changeCartQty(specId, 1);
    else if (btn.dataset.action === 'cart-remove') { ui.cart = ui.cart.filter(x => x.specId !== specId); renderCart(); }
  });
  $('btnCreateOrder').addEventListener('click', createOrder);
  $('btnClearCart').addEventListener('click', () => {
    if (!ui.cart.length) return;
    openModal({
      title: '清空订单',
      body: '<div>确定清空当前订单里已加入的所有产品吗？</div>',
      buttons: [
        { label: '取消', cls: 'gray', onClick: closeModal },
        { label: '清空', cls: 'danger', onClick: () => { ui.cart = []; closeModal(); renderCart(); } },
      ],
    });
  });

  // 订单管理
  $('ordSearch').addEventListener('input', e => { ui.ordSearch = e.target.value; renderOrders(); });
  document.querySelectorAll('#tab-orders .chip').forEach(ch => ch.addEventListener('click', () => {
    ui.ordRange = ch.dataset.range;
    const { start, end } = rangeFromChips(ui.ordRange);
    ui.ordStart = start != null ? todayStr(new Date(start)) : '';
    ui.ordEnd = end != null ? todayStr(new Date(end)) : '';
    renderOrders();
  }));
  $('ordStart').addEventListener('change', () => { ui.ordRange = 'custom'; ui.ordStart = $('ordStart').value; renderOrders(); });
  $('ordEnd').addEventListener('change', () => { ui.ordRange = 'custom'; ui.ordEnd = $('ordEnd').value; renderOrders(); });
  const onOrderAction = e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const o = state.orders.find(x => x.id === btn.dataset.orderId);
    if (!o) return;
    if (btn.dataset.action === 'ord-view') showOrder(o);
    else if (btn.dataset.action === 'ord-edit') openEditOrder(o);
    else if (btn.dataset.action === 'ord-del') confirmDeleteOrder(o);
    else if (btn.dataset.action === 'ord-paid') {
      o.paid = !o.paid;
      persist();
      btn.closest('td').outerHTML = paidCellHtml(o);
      toast(o.paid ? '已标记为已付款' : '已改回未付款');
    }
  };
  $('ordersList').addEventListener('click', onOrderAction);
  $('statsDetail').addEventListener('click', onOrderAction);
  $('btnExportOrders').addEventListener('click', () => {
    const { start, end } = ui.ordRange === 'custom' ? parseDateRange(ui.ordStart, ui.ordEnd) : rangeFromChips(ui.ordRange);
    const list = filterOrders(state.orders, ui.ordSearch, start, end);
    if (!list.length) { toast('没有可导出的订单'); return; }
    exportFile('销售明细' + dateStr() + '.csv', buildOrdersCSV(list));
  });
  // 勾选合并生成账单
  $('ordersList').addEventListener('change', e => {
    const all = e.target.closest('.ord-check-all');
    if (all) {
      const checks = $('ordersList').querySelectorAll('.ord-check');
      if (all.checked) checks.forEach(c => { c.checked = true; ui.ordChecked.add(c.dataset.orderId); });
      else { checks.forEach(c => { c.checked = false; }); ui.ordChecked.clear(); }
      return;
    }
    const cb = e.target.closest('.ord-check');
    if (!cb) return;
    if (cb.checked) ui.ordChecked.add(cb.dataset.orderId);
    else ui.ordChecked.delete(cb.dataset.orderId);
  });
  $('btnMergeExport').addEventListener('click', mergeExportOrders);
  // 一键收款：把勾选的订单全部标记为已付款（先按日期筛选 + 表头全选更方便）
  $('btnCollectAll').addEventListener('click', () => {
    if (!ui.ordChecked.size) { toast('请先勾选要收款的订单（可以先筛选日期，再点表头勾选框全选）', 'warn'); return; }
    let n = 0;
    for (const id of ui.ordChecked) {
      const o = state.orders.find(x => x.id === id);
      if (o) { o.paid = true; n++; }
    }
    persist(); renderOrders();
    toast('一键收款完成：' + n + ' 笔订单已标记为已付款');
  });

  // 账单管理
  $('billCustomers').addEventListener('click', e => {
    // 勾选框：勾 2 个及以上客户 = 多客户合并模式
    const cbox = e.target.closest('.bill-cust-check');
    if (cbox) {
      if (cbox.checked) ui.billCustChecked.add(cbox.dataset.customerId);
      else ui.billCustChecked.delete(cbox.dataset.customerId);
      renderBilling();
      return;
    }
    // 点客户行 = 查看单个客户（退出多选合并）
    const el = e.target.closest('.bill-cust');
    if (!el) return;
    ui.billCustomerId = el.dataset.customerId;
    ui.billChecked = new Set();
    ui.billCustChecked = new Set();
    renderBilling();
  });
  $('billCustCheckAll').addEventListener('change', e => {
    // 一键全选 / 取消所有客户（勾 2 个及以上自动进入多客户合并账单模式）
    if (e.target.checked) ui.billCustChecked = new Set(pendingOrders().map(o => o.customerId));
    else ui.billCustChecked = new Set();
    renderBilling();
  });
  $('billOrders').addEventListener('change', e => {
    const cb = e.target.closest('.bill-check');
    if (!cb) return;
    if (cb.checked) ui.billChecked.add(cb.dataset.orderId);
    else ui.billChecked.delete(cb.dataset.orderId);
    const checks = $('billOrders').querySelectorAll('.bill-check');
    $('billCheckAll').checked = checks.length > 0 && [...checks].every(c => c.checked);
    $('btnBillExport').disabled = !ui.billChecked.size;
  });
  $('billCheckAll').addEventListener('change', e => {
    const checks = $('billOrders').querySelectorAll('.bill-check');
    if (e.target.checked) checks.forEach(c => { c.checked = true; ui.billChecked.add(c.dataset.orderId); });
    else { checks.forEach(c => { c.checked = false; }); ui.billChecked.clear(); }
    $('btnBillExport').disabled = !ui.billChecked.size;
  });
  $('btnBillExport').addEventListener('click', exportBill);

  // 补货
  $('rsSpec').addEventListener('change', e => { ui.rsSpecId = e.target.value; });
  $('btnRestock').addEventListener('click', doRestock);
  $('btnRsTemplate').addEventListener('click', async () => {
    const r = await window.dataStore.exportRestockTemplate();
    if (r.ok) toast('模板已保存：' + r.path);
    else if (!r.canceled) toast('保存失败：' + (r.error || ''), 'error');
  });
  $('btnRsImport').addEventListener('click', pickRestockFile);
  $('rsSearch').addEventListener('input', e => { ui.rsSearch = e.target.value; renderRestockRecords(); });

  // 统计
  document.querySelectorAll('#tab-stats .chip').forEach(ch => ch.addEventListener('click', () => {
    ui.stRange = ch.dataset.range;
    const { start, end } = rangeFromChips(ui.stRange);
    if (start != null) ui.stStart = todayStr(new Date(start));
    if (end != null) ui.stEnd = todayStr(new Date(end));
    renderStats();
  }));
  $('stStart').addEventListener('change', () => { ui.stRange = 'custom'; ui.stStart = $('stStart').value; renderStats(); });
  $('stEnd').addEventListener('change', () => { ui.stRange = 'custom'; ui.stEnd = $('stEnd').value; renderStats(); });
  $('btnExportStats').addEventListener('click', () => {
    const { start, end } = ui.stRange === 'custom' ? parseDateRange(ui.stStart, ui.stEnd) : rangeFromChips(ui.stRange);
    const s = start == null ? -Infinity : start;
    const e = end == null ? Infinity : end;
    const { rows } = computeStats(s, e);
    if (!rows.length) { toast('这段时间没有销售或入库记录'); return; }
    const lines = [['产品', '规格', '入库数', '销售数量', '剩余数量', '销售金额(元)'].map(csvCell).join(',')];
    let tq = 0, tf = 0, tIn = 0, tRem = 0;
    for (const r of rows) {
      tq = round1(tq + r.qty); tf += r.fen; tIn = round1(tIn + r.restock);
      if (r.rem != null) tRem = round1(tRem + r.rem);
      lines.push([r.productName, r.specName, fmtQty(r.restock), fmtQty(r.qty), r.rem == null ? '—' : fmtQty(r.rem), (r.fen / 100).toFixed(2)].map(csvCell).join(','));
    }
    lines.push(['========================================', '', '', '', '', ''].map(csvCell).join(','));
    lines.push(['★ 合计（总金额） ★', '', fmtQty(tIn), tq, fmtQty(tRem), (tf / 100).toFixed(2)].map(csvCell).join(','));
    exportFile('销售汇总' + dateStr() + '.csv', '﻿' + lines.join('\r\n'));
  });
  $('btnExportStatsDetail').addEventListener('click', () => {
    const { start, end } = ui.stRange === 'custom' ? parseDateRange(ui.stStart, ui.stEnd) : rangeFromChips(ui.stRange);
    const s = start == null ? -Infinity : start;
    const e = end == null ? Infinity : end;
    const { details } = computeStats(s, e);
    const dq = (ui.stDetailSearch || '').trim().toLowerCase();
    const list = dq ? details.filter(o => orderMatchesQ(o, dq)) : details;
    if (!list.length) { toast(dq ? '没有符合搜索条件的订单明细' : '这段时间没有订单明细'); return; }
    exportFile('销售明细' + dateStr() + '.csv', buildOrdersCSV(list));
  });
  $('stDetailSearch').addEventListener('input', () => { ui.stDetailSearch = $('stDetailSearch').value; renderStats(); });
  $('btnExportCustPay').addEventListener('click', async () => {
    const { start, end } = ui.stRange === 'custom' ? parseDateRange(ui.stStart, ui.stEnd) : rangeFromChips(ui.stRange);
    const s = start == null ? -Infinity : start;
    const e = end == null ? Infinity : end;
    const custs = computeCustPay(s, e);
    if (!custs.length) { toast('这段时间没有订单'); return; }
    let tTotal = 0, tPaid = 0, tUnpaid = 0;
    const rows = [['客户名', '总下单金额(元)', '已支付金额(元)', '未支付金额(元)']];
    for (const c of custs) {
      tTotal += c.totalFen; tPaid += c.paidFen; tUnpaid += c.unpaidFen;
      rows.push([c.name, c.totalFen / 100, c.paidFen / 100, c.unpaidFen / 100]);
    }
    rows.push(['合计（' + custs.length + ' 个客户）', tTotal / 100, tPaid / 100, tUnpaid / 100]);
    await exportBillXlsx('客户收款汇总' + dateStr() + '.xlsx', rows, '客户收款汇总');
  });
  $('btnGenReport').addEventListener('click', openReportModal);

  // 产品与客户管理
  $('btnImportXlsx').addEventListener('click', openImportModal);
  $('manSearch').addEventListener('input', e => { ui.manSearch = e.target.value; renderManage(); });
  $('custSearch').addEventListener('input', e => { ui.custSearch = e.target.value; renderManage(); });
  $('btnAddProduct').addEventListener('click', () => openProductForm(null));
  $('btnAddCustomer').addEventListener('click', () => openCustomerForm(null));
  $('btnBatchCustomer').addEventListener('click', openBatchCustomerModal);
  $('btnExportCustomers').addEventListener('click', exportCustomersXlsx);
  $('productList').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const a = btn.dataset.action;
    if (a === 'spec-add') { openSpecForm(btn.dataset.productId, null); return; }
    if (a === 'prod-edit') { const p = productById(btn.dataset.productId); if (p) openProductForm(p); return; }
    if (a === 'prod-del') { const p = productById(btn.dataset.productId); if (p) confirmDeleteProduct(p); return; }
    const s = specById(btn.dataset.specId);
    if (!s) return;
    if (a === 'spec-edit') openSpecForm(s.productId, s);
    else if (a === 'spec-fix') openFix(s);
    else if (a === 'spec-del') confirmDeleteSpec(s);
  });
  $('customerList').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const c = customerById(btn.dataset.customerId);
    if (!c) return;
    if (btn.dataset.action === 'cust-edit') openCustomerForm(c);
    else if (btn.dataset.action === 'cust-del') confirmDeleteCustomer(c);
  });

  // 备份导入导出
  $('btnExportBackup').addEventListener('click', () => {
    exportFile('库存备份' + dateStr() + '.json', JSON.stringify(buildBackup(), null, 2));
  });
  $('btnImportBackup').addEventListener('click', () => $('fileImport').click());
  $('fileImport').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    let d;
    try { d = JSON.parse(await f.text()); } catch { toast('这个文件不是有效的备份文件', 'error'); return; }
    const data = normalizeImport(d);
    if (!data) { toast('这个文件不是有效的备份文件（内容不对）', 'error'); return; }
    openModal({
      title: '导入备份',
      body: `<div>将用这个备份<b>覆盖</b>当前全部数据：</div>
        <div style="margin-top:8px">产品 ${data.products.length} 个 · 规格 ${data.specs.length} 个 · 客户 ${data.customers.length} 个 · 订单 ${data.orders.length} 笔</div>
        <div class="note">导入前会自动把当前数据另存为「库存数据_导入前备份.json」，导错了也能恢复。</div>`,
      buttons: [
        { label: '取消', cls: 'gray', onClick: closeModal },
        { label: '确认导入', cls: 'danger', onClick: async () => {
          const r = await window.dataStore.importData(data);
          if (!r.ok) { toast('导入失败：' + r.error, 'error'); return; }
          state = data; ensureInitialStock(); closeModal(); renderAll(); toast('导入成功');
        } },
      ],
    });
  });
}

/* ==================== 渲染总控 ==================== */
function renderAll() {
  renderSell();
  renderRestock();
  renderBilling();
  renderOrders();
  renderStats();
  renderManage();
}

async function init() {
  initStatDates();
  const r = await window.dataStore.load();
  state = r.data || { version: 2, products: [], specs: [], customers: [], orders: [], restocks: [] };
  if (!Array.isArray(state.restocks)) state.restocks = [];
  ensureInitialStock();
  // 历史订单没有 status 字段 → 默认「未完成」
  state.orders.forEach(o => { if (o.status !== 'done') o.status = 'pending'; });
  if (r.source === 'beforeImport') toast('主数据文件无法读取，已自动改用「库存数据_导入前备份.json」。请检查数据是否正确！', 'warn');
  else if (r.source === 'empty') toast('没有找到已有数据，已从空白开始。数据会存在程序文件夹里的「库存数据.json」中。', 'warn');
  bindEvents();
  renderAll();
}

window.addEventListener('error', e => console.error('[window error]', e.message, e.filename, e.lineno));
window.addEventListener('unhandledrejection', e => console.error('[unhandledrejection]', e.reason));
init();
