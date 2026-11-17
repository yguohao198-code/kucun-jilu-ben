const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { createWorker } = require('tesseract.js');
const XLSX = require('xlsx');

// 数据文件放在 exe 所在文件夹（开发时是项目文件夹）→ 复制整个文件夹 = 备份/迁移
const dataDir = () => (app.isPackaged ? path.dirname(process.execPath) : __dirname);
const dataFile = () => path.join(dataDir(), '库存数据.json');
const preImportFile = () => path.join(dataDir(), '库存数据_导入前备份.json');

function emptyData() {
  return { version: 2, products: [], specs: [], customers: [], orders: [], restocks: [] };
}

function normalize(d) {
  const out = emptyData();
  if (!d || typeof d !== 'object') return out;
  if (Array.isArray(d.products)) out.products = d.products;
  if (Array.isArray(d.specs)) out.specs = d.specs;
  if (Array.isArray(d.customers)) out.customers = d.customers;
  // 历史订单没有 status 字段 → 默认「未完成」
  if (Array.isArray(d.orders)) out.orders = d.orders.map(o => Object.assign({ status: 'pending' }, o));
  if (Array.isArray(d.restocks)) out.restocks = d.restocks;
  return out;
}

function readData() {
  // 1) 正常读主数据文件
  try {
    return { data: normalize(JSON.parse(fs.readFileSync(dataFile(), 'utf8'))), source: 'main' };
  } catch (e) {
    // 2) 主文件损坏 → 改名保留现场，再试导入前备份
    try {
      if (fs.existsSync(dataFile())) {
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
        fs.renameSync(dataFile(), path.join(dataDir(), `库存数据_损坏_${stamp}.json`));
      }
    } catch (_) {}
    try {
      return { data: normalize(JSON.parse(fs.readFileSync(preImportFile(), 'utf8'))), source: 'beforeImport' };
    } catch (e2) {
      // 3) 都没有 → 空数据开始
      return { data: emptyData(), source: 'empty' };
    }
  }
}

// 原子写：先写临时文件再改名覆盖，防止写一半断电损坏
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// 导出文件名自动递增：账单_王二_20261105.csv 已存在 → 账单_王二_2026110501.csv → 02、03…
function uniqueDefaultPath(dir, name) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, name.length - ext.length) : name;
  const cand = (suffix) => path.join(dir, base + suffix + ext);
  if (!fs.existsSync(cand(''))) return cand('');
  for (let i = 1; i < 100; i++) {
    const p = cand(String(i).padStart(2, '0'));
    if (!fs.existsSync(p)) return p;
  }
  return cand('_' + Date.now());
}

// 导出弹窗开在哪、在哪查同名文件：记住用户上次保存的文件夹（账单都存桌面，
// 不能在下载文件夹里找同名文件，否则永远查不到、序号永远不加）
const exportSettingsFile = () => path.join(dataDir(), '导出设置.json');
function readExportSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(exportSettingsFile(), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch (_) { return {}; }
}
function rememberExportDir(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  const s = readExportSettings();
  if (s.lastExportDir === dir) return;
  s.lastExportDir = dir;
  try { writeAtomic(exportSettingsFile(), JSON.stringify(s, null, 2)); } catch (_) {}
}
// 优先级：上次保存过的文件夹 → 桌面/下载/文档里最新导出文件所在处 → 下载文件夹兜底
function exportDefaultDir() {
  const s = readExportSettings();
  if (s.lastExportDir && fs.existsSync(s.lastExportDir)) return s.lastExportDir;
  let best = null, bestTime = 0;
  for (const key of ['desktop', 'downloads', 'documents']) {
    let p;
    try { p = app.getPath(key); } catch (_) { continue; }
    let names;
    try { names = fs.readdirSync(p); } catch (_) { continue; }
    for (const n of names) {
      if (!/^(账单|销售|库存备份).*\.(csv|json|xlsx)$/i.test(n)) continue;
      try {
        const st = fs.statSync(path.join(p, n));
        if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = p; }
      } catch (_) {}
    }
  }
  return best || app.getPath('downloads');
}

ipcMain.handle('load-data', () => {
  const r = readData();
  return { data: r.data, source: r.source };
});

ipcMain.handle('save-data', (e, data) => {
  try {
    writeAtomic(dataFile(), JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('import-data', (e, data) => {
  // 导入前先把当前数据另存一份，后悔了可恢复
  try {
    if (fs.existsSync(dataFile())) fs.copyFileSync(dataFile(), preImportFile());
  } catch (_) {}
  try {
    writeAtomic(dataFile(), JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 一键复制文字：主进程写剪贴板，最可靠（不依赖窗口焦点/用户手势） */
ipcMain.handle('copy-text', (e, text) => {
  try {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('save-file', async (e, opts) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const ext = String(opts.defaultName || '').split('.').pop();
  const r = await dialog.showSaveDialog(win, {
    title: '保存文件',
    defaultPath: uniqueDefaultPath(exportDefaultDir(), opts.defaultName || '文件'),
    filters: [{ name: ext === 'csv' ? 'CSV 表格文件' : ext === 'txt' ? '文本文件' : 'JSON 数据文件', extensions: [ext] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, opts.content, 'utf8');
    rememberExportDir(path.dirname(r.filePath));
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 账单导出成 Excel 表格（.xlsx）：rows = 单元格二维数组，排版按用户模板 */
ipcMain.handle('save-xlsx', async (e, opts) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    title: '保存 Excel 表格',
    defaultPath: uniqueDefaultPath(exportDefaultDir(), opts.defaultName || '表格.xlsx'),
    filters: [{ name: 'Excel 表格', extensions: ['xlsx'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(opts.rows || []);
    XLSX.utils.book_append_sheet(wb, ws, opts.sheetName || '账单');
    XLSX.writeFile(wb, r.filePath, { bookType: 'xlsx' });
    rememberExportDir(path.dirname(r.filePath));
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 分析报告导出一页纸 PDF：渲染进程生成 HTML，主进程开隐藏窗口打印成竖版 A4 */
ipcMain.handle('save-report-pdf', async (e, html) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const now = new Date();
  const ds = String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
  const r = await dialog.showSaveDialog(win, {
    title: '保存分析报告 PDF',
    defaultPath: uniqueDefaultPath(exportDefaultDir(), '库存分析报告' + ds + '.pdf'),
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  let pdfWin = null;
  try {
    pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(String(html)));
    const buf = await pdfWin.webContents.printToPDF({
      pageSize: 'A4',
      landscape: false,
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    fs.writeFileSync(r.filePath, buf);
    rememberExportDir(path.dirname(r.filePath));
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    if (pdfWin) pdfWin.destroy();
  }
});

/* ==================== 批量导入（Excel 模板） ==================== */
ipcMain.handle('export-template', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    title: '保存导入模板',
    defaultPath: uniqueDefaultPath(exportDefaultDir(), '产品导入模板.xlsx'),
    filters: [{ name: 'Excel 表格', extensions: ['xlsx'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    const wb = XLSX.utils.book_new();
    const data = [
      ['产品名', '规格名', '批发价(元)', 'VIP价(元)', '零售价(元)', '库存'],
      ['螺丝', 'M6×30', 10, 11, 12.5, 100],
      ['螺丝', 'M8×40', '', 8, 8.5, 200],
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws, '产品数据');
    const notes = [
      ['批量导入填写说明'],
      [''],
      ['1. 产品名、规格名：必填。表里有但软件里没有的产品/规格，导入时会自动新建。'],
      ['2. 批发价/VIP价/零售价：单位是"元"，可以带小数（如 12.5）。'],
      ['   更新价格时：留空 = 保持软件里的原价不动；填了 = 用新价覆盖旧价。'],
      ['   新建规格时：至少填一档价格；其他档以后可以在软件里补。'],
      ['3. 库存：填了数字 = 用表格里的数覆盖软件里的库存；留空 = 库存不动。'],
      ['   新建规格时库存留空 = 按 0 算，之后用软件里的「补货」增加。'],
      ['4. 已售数不会导入、也不会被改动。'],
      ['5. 已成交订单的价格不受导入影响（历史订单永远按成交时的价格显示）。'],
      ['6. 导入只新增和更新，不会删除软件里已有的任何产品。'],
      ['7. 示例行只是示范，导入前请删掉或改成你自己的数据。'],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(notes);
    ws2['!cols'] = [{ wch: 80 }];
    XLSX.utils.book_append_sheet(wb, ws2, '填写说明');
    XLSX.writeFile(wb, r.filePath, { bookType: 'xlsx' });
    rememberExportDir(path.dirname(r.filePath));
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('parse-import-file', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: '选择要导入的表格文件',
    properties: ['openFile'],
    filters: [{ name: '表格文件（Excel / CSV）', extensions: ['xlsx', 'xls', 'csv'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const file = r.filePaths[0];
  try {
    const wb = XLSX.readFile(file);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return { ok: false, error: '表格里没有内容' };
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    // 表头定位：前 5 行内找同时含「产品名」「规格名」的行（列名容错）
    const colOf = (row, names) => {
      for (let i = 0; i < row.length; i++) {
        const h = String(row[i] == null ? '' : row[i]).trim();
        if (names.includes(h)) return i;
      }
      return -1;
    };
    let headerIdx = -1, cName = -1, cSpec = -1, cWh = -1, cRt = -1, cVip = -1, cStock = -1;
    for (let i = 0; i < Math.min(5, aoa.length); i++) {
      cName = colOf(aoa[i], ['产品名', '品名']);
      cSpec = colOf(aoa[i], ['规格名', '规格']);
      if (cName >= 0 && cSpec >= 0) {
        headerIdx = i;
        cWh = colOf(aoa[i], ['批发价(元)', '批发价']);
        cRt = colOf(aoa[i], ['零售价(元)', '零售价']);
        cVip = colOf(aoa[i], ['VIP价(元)', 'vip价', 'VIP价']);
        cStock = colOf(aoa[i], ['库存']);
        break;
      }
    }
    if (headerIdx < 0) return { ok: false, error: '没找到表头行。请使用软件生成的模板（第一行需有「产品名」「规格名」两列）' };
    const cell = (row, col) => (col >= 0 && row[col] != null) ? String(row[col]).trim() : '';
    const rows = [];
    for (let i = headerIdx + 1; i < aoa.length; i++) {
      const row = aoa[i];
      const productName = cell(row, cName);
      const specName = cell(row, cSpec);
      if (!productName && !specName && !cell(row, cWh) && !cell(row, cRt) && !cell(row, cVip) && !cell(row, cStock)) continue; // 空行跳过
      rows.push({ rowNum: i + 1, productName, specName, wholesale: cell(row, cWh), retail: cell(row, cRt), vip: cell(row, cVip), stock: cell(row, cStock) });
    }
    if (!rows.length) return { ok: false, error: '表格里没有数据行' };
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: '读不出这个文件：' + String((err && err.message) || err) };
  }
});

/* ==================== 补货导入（Excel 模板） ==================== */
ipcMain.handle('export-restock-template', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    title: '保存补货导入模板',
    defaultPath: uniqueDefaultPath(exportDefaultDir(), '补货导入模板.xlsx'),
    filters: [{ name: 'Excel 表格', extensions: ['xlsx'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    const wb = XLSX.utils.book_new();
    const data = [
      ['产品名', '规格名', '补货数量'],
      ['螺丝', 'M6×30', 100],
      ['螺丝', 'M8×40', 200],
    ];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, '补货数据');
    const notes = [
      ['补货导入填写说明'],
      [''],
      ['1. 产品名、规格名：必填，要和软件里已有的完全一致（名字对不上会跳过）。'],
      ['2. 补货数量：必填，可带一位小数（如 100 或 10.5）。'],
      ['3. 导入后库存会在这批数字上累加（不是覆盖）。'],
      ['4. 每次补货都会自动记入软件里的「补货记录」。'],
      ['5. 导入不会新建产品/规格，也不会改动价格和已售数。'],
      ['6. 示例行只是示范，导入前请删掉或改成你自己的数据。'],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(notes);
    ws2['!cols'] = [{ wch: 80 }];
    XLSX.utils.book_append_sheet(wb, ws2, '填写说明');
    XLSX.writeFile(wb, r.filePath, { bookType: 'xlsx' });
    rememberExportDir(path.dirname(r.filePath));
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('parse-restock-file', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: '选择要导入的补货表格',
    properties: ['openFile'],
    filters: [{ name: '表格文件（Excel / CSV）', extensions: ['xlsx', 'xls', 'csv'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const file = r.filePaths[0];
  try {
    const wb = XLSX.readFile(file);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return { ok: false, error: '表格里没有内容' };
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    const colOf = (row, names) => {
      for (let i = 0; i < row.length; i++) {
        const h = String(row[i] == null ? '' : row[i]).trim();
        if (names.includes(h)) return i;
      }
      return -1;
    };
    let headerIdx = -1, cName = -1, cSpec = -1, cQty = -1;
    for (let i = 0; i < Math.min(5, aoa.length); i++) {
      cName = colOf(aoa[i], ['产品名', '品名']);
      cSpec = colOf(aoa[i], ['规格名', '规格']);
      if (cName >= 0 && cSpec >= 0) {
        headerIdx = i;
        cQty = colOf(aoa[i], ['补货数量', '补货数', '进货数量', '数量']);
        break;
      }
    }
    if (headerIdx < 0) return { ok: false, error: '没找到表头行。请使用软件生成的补货模板（第一行需有「产品名」「规格名」两列）' };
    if (cQty < 0) return { ok: false, error: '没找到「补货数量」列。请使用软件生成的补货模板' };
    const cell = (row, col) => (col >= 0 && row[col] != null) ? String(row[col]).trim() : '';
    const rows = [];
    for (let i = headerIdx + 1; i < aoa.length; i++) {
      const row = aoa[i];
      const productName = cell(row, cName);
      const specName = cell(row, cSpec);
      const qty = cell(row, cQty);
      if (!productName && !specName && !qty) continue; // 空行跳过
      rows.push({ rowNum: i + 1, productName, specName, qty });
    }
    if (!rows.length) return { ok: false, error: '表格里没有数据行' };
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: '读不出这个文件：' + String((err && err.message) || err) };
  }
});

/* ==================== 批量下单（卖货页表格导入） ==================== */

/* 生成带样式的两列模板 xlsx：SheetJS 社区版写不了单元格样式，直接拼 OOXML + zip（STORE） */
function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
}
const CRC32_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function zipStore(entries) {
  const locals = [], centrals = [];
  const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const crc = crc32(body);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(body.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([lh, nameBuf, body]));
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(body.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    offset += lh.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
function buildBatchTemplateXlsx() {
  const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const dataRows = [
    ['D20261108-01', 'AA3=10\nBB2=20'],
    ['D20261108-02', 'AA3=15\nBB2=26'],
    ['D20261108-03', 'AA3=18\nBB2=27'],
  ];
  const notes = [
    ['批量下单填写说明'],
    [''],
    ['1. 一行一笔订单：「订单号」填订单号，「订单明细」每行写一条「规格名=数量」，比如 AA3=10；多条明细在同一个格子里换行写。'],
    ['2. 只写规格名（不用写产品名），软件会按规格名自动匹配对应的产品；规格名要和软件里已有的完全一致（对不上会被跳过）。'],
    ['3. 规格名不要重复：所有产品里的规格名都不一样，软件靠名字找产品。'],
    ['4. 数量：必填，最少 0.1、最多一位小数（如 10 或 10.5）。'],
    ['5. 导入后选客户，第一笔订单会先进入右侧订单栏，点「下单」「确认成交」；'],
    ['   成交后自动载入下一笔，直到全部处理完。'],
    ['6. 价格按客户的类型自动计算（批发/VIP/零售），和手动下单一样。'],
    ['7. 示例行只是示范，导入前请删掉或改成你自己的数据。'],
    ['8. 以前那种 4 列表格（订单号、产品名、规格名、数量各一列）也还能导入。'],
  ];
  const contentTypes = DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';
  const rootRels = DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  const workbookXml = DECL +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    '<sheet name="批量下单数据" sheetId="1" r:id="rId1"/>' +
    '<sheet name="填写说明" sheetId="2" r:id="rId2"/>' +
    '</sheets></workbook>';
  const workbookRels = DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';
  /* xf 索引：0 默认 | 1 表头(蓝底白字居中) | 2 订单号(淡蓝底) | 3 订单号(白底)
     4 明细(淡蓝底左上换行) | 5 明细(白底左上换行) | 6 说明标题 | 7 说明正文 */
  const stylesXml = DECL +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="3">' +
    '<font><sz val="11"/><name val="微软雅黑"/></font>' +
    '<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/></font>' +
    '<font><b/><sz val="14"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/></font>' +
    '</fonts>' +
    '<fills count="4">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F8FF"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2">' +
    '<border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border>' +
    '<left style="thin"><color rgb="FFB9CDE5"/></left><right style="thin"><color rgb="FFB9CDE5"/></right>' +
    '<top style="thin"><color rgb="FFB9CDE5"/></top><bottom style="thin"><color rgb="FFB9CDE5"/></bottom><diagonal/>' +
    '</border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="8">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
  let sheet1Xml = DECL +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<dimension ref="A1:B' + (dataRows.length + 1) + '"/>' +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    '<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/></cols>' +
    '<sheetData>' +
    '<row r="1" ht="26" customHeight="1">' +
    '<c r="A1" s="1" t="inlineStr"><is><t>' + xmlEsc('订单号') + '</t></is></c>' +
    '<c r="B1" s="1" t="inlineStr"><is><t>' + xmlEsc('订单明细') + '</t></is></c>' +
    '</row>';
  dataRows.forEach((row, idx) => {
    const r = idx + 2;
    const tinted = r % 2 === 0;
    const sNo = tinted ? 2 : 3;
    const sDet = tinted ? 4 : 5;
    sheet1Xml += '<row r="' + r + '" ht="50" customHeight="1">' +
      '<c r="A' + r + '" s="' + sNo + '" t="inlineStr"><is><t>' + xmlEsc(row[0]) + '</t></is></c>' +
      '<c r="B' + r + '" s="' + sDet + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(row[1]) + '</t></is></c>' +
      '</row>';
  });
  sheet1Xml += '</sheetData></worksheet>';
  let sheet2Xml = DECL +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<dimension ref="A1:A' + notes.length + '"/>' +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    '<cols><col min="1" max="1" width="95" customWidth="1"/></cols>' +
    '<sheetData>';
  notes.forEach((row, i) => {
    const r = i + 1;
    if (row[0] === '') { sheet2Xml += '<row r="' + r + '" ht="8" customHeight="1"/>'; return; }
    const ht = i === 0 ? 30 : 20 * Math.max(1, Math.ceil(row[0].length / 42)) + 8;
    sheet2Xml += '<row r="' + r + '" ht="' + ht + '" customHeight="1">' +
      '<c r="A' + r + '" s="' + (i === 0 ? 6 : 7) + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(row[0]) + '</t></is></c>' +
      '</row>';
  });
  sheet2Xml += '</sheetData></worksheet>';
  return zipStore([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbookXml],
    ['xl/_rels/workbook.xml.rels', workbookRels],
    ['xl/styles.xml', stylesXml],
    ['xl/worksheets/sheet1.xml', sheet1Xml],
    ['xl/worksheets/sheet2.xml', sheet2Xml],
  ]);
}

ipcMain.handle('export-batch-order-template', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    title: '保存批量下单模板',
    defaultPath: uniqueDefaultPath(exportDefaultDir(), '批量下单模板.xlsx'),
    filters: [{ name: 'Excel 表格', extensions: ['xlsx'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, buildBatchTemplateXlsx());
    rememberExportDir(path.dirname(r.filePath));
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('parse-batch-order-file', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: '选择要导入的批量下单表格',
    properties: ['openFile'],
    filters: [{ name: '表格文件（Excel / CSV）', extensions: ['xlsx', 'xls', 'csv'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const file = r.filePaths[0];
  try {
    const wb = XLSX.readFile(file);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return { ok: false, error: '表格里没有内容' };
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    const colOf = (row, names) => {
      for (let i = 0; i < row.length; i++) {
        const h = String(row[i] == null ? '' : row[i]).trim();
        if (names.includes(h)) return i;
      }
      return -1;
    };
    let headerIdx = -1, cNo = -1, cName = -1, cSpec = -1, cQty = -1;
    for (let i = 0; i < Math.min(5, aoa.length); i++) {
      cNo = colOf(aoa[i], ['订单号', '单号']);
      cName = colOf(aoa[i], ['产品名', '品名']);
      cSpec = colOf(aoa[i], ['规格名', '规格']);
      if (cNo >= 0 && cName >= 0 && cSpec >= 0) {
        headerIdx = i;
        cQty = colOf(aoa[i], ['数量', '件数']);
        break;
      }
    }
    const cell = (row, col) => (col >= 0 && row[col] != null) ? String(row[col]).trim() : '';
    // 两列表格表头：订单号 | 订单明细
    let h2Idx = -1, c2No = -1, c2Det = -1;
    for (let i = 0; i < Math.min(5, aoa.length); i++) {
      c2No = colOf(aoa[i], ['订单号', '单号']);
      c2Det = colOf(aoa[i], ['订单明细', '明细']);
      if (c2No >= 0 && c2Det >= 0) { h2Idx = i; break; }
    }
    const rows = [];
    if (headerIdx >= 0 && cQty >= 0) {
      // 旧 4 列表格：订单号 | 产品名 | 规格名 | 数量
      for (let i = headerIdx + 1; i < aoa.length; i++) {
        const row = aoa[i];
        const orderNo = cell(row, cNo);
        const productName = cell(row, cName);
        const specName = cell(row, cSpec);
        const qty = cell(row, cQty);
        if (!orderNo && !productName && !specName && !qty) continue; // 空行跳过
        rows.push({ rowNum: i + 1, orderNo, productName, specName, qty });
      }
    } else if (h2Idx >= 0) {
      // 新两列表格：一行一笔订单，明细格子里每行一条「产品名规格名=数量」
      for (let i = h2Idx + 1; i < aoa.length; i++) {
        const row = aoa[i];
        const orderNo = cell(row, c2No);
        const detail = cell(row, c2Det);
        if (!orderNo && !detail) continue; // 空行跳过
        if (!orderNo) { rows.push({ rowNum: i + 1, orderNo: '' }); continue; }
        if (!detail) { rows.push({ rowNum: i + 1, orderNo, problem: '订单明细为空' }); continue; }
        for (const line of detail.split('\n').map(s => s.trim()).filter(Boolean)) {
          const m = line.match(/^(.+?)[=×xX*]\s*(\d+(?:\.\d+)?)\s*(?:盒|件|个)?$/);
          if (!m) {
            rows.push({ rowNum: i + 1, orderNo, problem: '明细行写法不对：「' + line + '」——每行要写成 规格名=数量（如 AA3=10）' });
            continue;
          }
          rows.push({ rowNum: i + 1, orderNo, item: m[1].trim(), qty: m[2] });
        }
      }
    } else {
      // 旧的「一格一笔」格式：一个格子里 订单号 + 空行 + 明细行
      for (let i = 0; i < aoa.length; i++) {
        const row = aoa[i];
        for (const v of row) {
          const text = String(v == null ? '' : v).trim();
          if (!text || text.indexOf('\n') < 0) continue;
          const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
          const orderNo = lines[0];
          for (let k = 1; k < lines.length; k++) {
            const m = lines[k].match(/^(.+?)[=×xX*]\s*(\d+(?:\.\d+)?)\s*(?:盒|件|个)?$/);
            if (!m) {
              rows.push({ rowNum: i + 1, orderNo, problem: '明细行写法不对：「' + lines[k] + '」——每行要写成 规格名=数量（如 AA3=10）' });
              continue;
            }
            rows.push({ rowNum: i + 1, orderNo, item: m[1].trim(), qty: m[2] });
          }
        }
      }
    }
    if (!rows.length) return { ok: false, error: '表格里没有数据行，或格式没看懂。请使用软件下载的「批量下单模板」（两列：订单号、订单明细），或旧的 4 列表格（订单号、产品名、规格名、数量）' };
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: '读不出这个文件：' + String((err && err.message) || err) };
  }
});

/* ==================== 批量建客户（Excel 模板导入） ==================== */

/* 模板两列：客户名 | 客户类型（类型列带下拉框：批发/VIP/零售，不用打字）。
   沿用批量下单模板的做法：直接拼 OOXML + zip（STORE），下拉框就是 dataValidations 元素 */
function buildCustomerTemplateXlsx() {
  const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const dataRows = [['张三', '批发'], ['李四', 'VIP'], ['王五', '零售']];
  const notes = [
    ['批量建客户填写说明'],
    [''],
    ['1. 「客户名」填客户名字；「客户类型」这一列点一下单元格，就会出现下拉框，直接选 批发 / VIP / 零售，不用打字。'],
    ['2. 客户名必填；和软件里已有的客户重名会跳过并提示。'],
    ['3. 客户类型必选；没选或写错的整行会跳过。'],
    ['4. 类型决定下单时自动用哪档价格：批发=批发价，VIP=VIP价，零售=零售价。'],
    ['5. 示例行只是示范，导入前请删掉或改成你自己的数据。'],
  ];
  const contentTypes = DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';
  const rootRels = DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  const workbookXml = DECL +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    '<sheet name="批量建客户" sheetId="1" r:id="rId1"/>' +
    '<sheet name="填写说明" sheetId="2" r:id="rId2"/>' +
    '</sheets></workbook>';
  const workbookRels = DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';
  /* xf 索引：0 默认 | 1 表头(蓝底白字居中) | 2 客户名(淡蓝底居中) | 3 客户名(白底居中)
     4 类型(淡蓝底居中) | 5 类型(白底居中) | 6 说明标题 | 7 说明正文 */
  const stylesXml = DECL +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="3">' +
    '<font><sz val="11"/><name val="微软雅黑"/></font>' +
    '<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/></font>' +
    '<font><b/><sz val="14"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/></font>' +
    '</fonts>' +
    '<fills count="4">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F8FF"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2">' +
    '<border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border>' +
    '<left style="thin"><color rgb="FFB9CDE5"/></left><right style="thin"><color rgb="FFB9CDE5"/></right>' +
    '<top style="thin"><color rgb="FFB9CDE5"/></top><bottom style="thin"><color rgb="FFB9CDE5"/></bottom><diagonal/>' +
    '</border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="8">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
  let sheet1Xml = DECL +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<dimension ref="A1:B' + (dataRows.length + 1) + '"/>' +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    '<cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="14" customWidth="1"/></cols>' +
    '<sheetData>' +
    '<row r="1" ht="26" customHeight="1">' +
    '<c r="A1" s="1" t="inlineStr"><is><t>' + xmlEsc('客户名') + '</t></is></c>' +
    '<c r="B1" s="1" t="inlineStr"><is><t>' + xmlEsc('客户类型') + '</t></is></c>' +
    '</row>';
  dataRows.forEach((row, idx) => {
    const r = idx + 2;
    const tinted = r % 2 === 0;
    const sName = tinted ? 2 : 3;
    const sType = tinted ? 4 : 5;
    sheet1Xml += '<row r="' + r + '" ht="22" customHeight="1">' +
      '<c r="A' + r + '" s="' + sName + '" t="inlineStr"><is><t>' + xmlEsc(row[0]) + '</t></is></c>' +
      '<c r="B' + r + '" s="' + sType + '" t="inlineStr"><is><t>' + xmlEsc(row[1]) + '</t></is></c>' +
      '</row>';
  });
  sheet1Xml += '</sheetData>' +
    '<dataValidations count="1">' +
    '<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="B2:B200"><formula1>"批发,VIP,零售"</formula1></dataValidation>' +
    '</dataValidations>' +
    '</worksheet>';
  let sheet2Xml = DECL +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<dimension ref="A1:A' + notes.length + '"/>' +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    '<cols><col min="1" max="1" width="95" customWidth="1"/></cols>' +
    '<sheetData>';
  notes.forEach((row, i) => {
    const r = i + 1;
    if (row[0] === '') { sheet2Xml += '<row r="' + r + '" ht="8" customHeight="1"/>'; return; }
    const ht = i === 0 ? 30 : 20 * Math.max(1, Math.ceil(row[0].length / 42)) + 8;
    sheet2Xml += '<row r="' + r + '" ht="' + ht + '" customHeight="1">' +
      '<c r="A' + r + '" s="' + (i === 0 ? 6 : 7) + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(row[0]) + '</t></is></c>' +
      '</row>';
  });
  sheet2Xml += '</sheetData></worksheet>';
  return zipStore([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['xl/workbook.xml', workbookXml],
    ['xl/_rels/workbook.xml.rels', workbookRels],
    ['xl/styles.xml', stylesXml],
    ['xl/worksheets/sheet1.xml', sheet1Xml],
    ['xl/worksheets/sheet2.xml', sheet2Xml],
  ]);
}

ipcMain.handle('export-customer-template', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    title: '保存批量建客户模板',
    defaultPath: uniqueDefaultPath(exportDefaultDir(), '批量建客户模板.xlsx'),
    filters: [{ name: 'Excel 表格', extensions: ['xlsx'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, buildCustomerTemplateXlsx());
    rememberExportDir(path.dirname(r.filePath));
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('parse-customer-file', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: '选择要导入的批量建客户表格',
    properties: ['openFile'],
    filters: [{ name: '表格文件（Excel / CSV）', extensions: ['xlsx', 'xls', 'csv'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const file = r.filePaths[0];
  try {
    const wb = XLSX.readFile(file);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return { ok: false, error: '表格里没有内容' };
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    const colOf = (row, names) => {
      for (let i = 0; i < row.length; i++) {
        const h = String(row[i] == null ? '' : row[i]).trim();
        if (names.includes(h)) return i;
      }
      return -1;
    };
    let headerIdx = -1, cName = -1, cType = -1;
    for (let i = 0; i < Math.min(5, aoa.length); i++) {
      cName = colOf(aoa[i], ['客户名', '客户名称', '姓名']);
      cType = colOf(aoa[i], ['客户类型', '类型']);
      if (cName >= 0 && cType >= 0) { headerIdx = i; break; }
    }
    if (headerIdx < 0) return { ok: false, error: '没找到表头行。请使用软件下载的「批量建客户模板」（第一行需有「客户名」「客户类型」两列）' };
    const cell = (row, col) => (col >= 0 && row[col] != null) ? String(row[col]).trim() : '';
    const rows = [];
    for (let i = headerIdx + 1; i < aoa.length; i++) {
      const row = aoa[i];
      const name = cell(row, cName);
      const type = cell(row, cType);
      if (!name && !type) continue; // 空行跳过
      rows.push({ rowNum: i + 1, name, type });
    }
    if (!rows.length) return { ok: false, error: '表格里没有数据行' };
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: '读不出这个文件：' + String((err && err.message) || err) };
  }
});

/* ==================== OCR（截图识别订单） ==================== */
let ocrWorker = null;
let ocrBusy = false;

// worker_threads 读 worker 脚本不认 asar 虚拟路径，打包后指到 app.asar.unpacked 的真实文件
function packagedPath(rel) {
  const p = path.join(__dirname, rel);
  if (!app.isPackaged) return p;
  const m = p.match(/^(.*[\\/])app\.asar([\\/].*)$/);
  if (m) {
    const unpacked = m[1] + 'app.asar.unpacked' + m[2];
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return p;
}

async function ensureOcrWorker() {
  if (ocrWorker) return ocrWorker;
  const workerPath = packagedPath('node_modules/tesseract.js/src/worker-script/node/index.js');
  const langPath = packagedPath('langdata');
  try {
    ocrWorker = await createWorker(['chi_sim', 'eng'], 1, {
      workerPath,
      langPath,
      cacheMethod: 'none',
    });
  } catch (err) {
    console.error('[ocr] worker 初始化失败:', err && err.message, '| workerPath 存在:', fs.existsSync(workerPath), '| langPath 存在:', fs.existsSync(langPath), '| workerPath =', workerPath);
    throw err;
  }
  await ocrWorker.setParameters({ tessedit_pageseg_mode: '6' }); // 微信聊天是单栏文字
  return ocrWorker;
}

// 大图压小、小图放大，识别效果更稳
function prepareImageForOcr(input) {
  let buf = input;
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return { ok: false, error: '读不出这张图片，请换一张试试' };
  const s = img.getSize();
  const maxSide = Math.max(s.width, s.height);
  let w = s.width, h = s.height;
  if (maxSide > 2000) { const k = 2000 / maxSide; w = Math.round(w * k); h = Math.round(h * k); }
  else if (maxSide < 1200) { const k = 1600 / maxSide; w = Math.round(w * k); h = Math.round(h * k); }
  return { ok: true, buf: img.resize({ width: w, height: h, quality: 'best' }).toPNG() };
}

ipcMain.handle('ocr-image', async (e, input) => {
  if (ocrBusy) return { ok: false, error: 'busy' };
  ocrBusy = true;
  try {
    const prep = prepareImageForOcr(input);
    if (!prep.ok) return prep;
    const worker = await ensureOcrWorker();
    const t0 = Date.now();
    const r = await worker.recognize(prep.buf, {}, { text: true, blocks: true });
    const lines = [];
    for (const b of r.data.blocks || []) {
      for (const p of b.paragraphs || []) {
        for (const l of p.lines || []) {
          const text = String((l.words || []).map(x => x.text).join(' ')).replace(/\s+/g, ' ').trim();
          if (text) lines.push({ text, conf: Math.round(l.confidence || 0) });
        }
      }
    }
    return { ok: true, text: String(r.data.text || ''), lines, durationMs: Date.now() - t0 };
  } catch (err) {
    console.error('[ocr] 识别失败:', err);
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    ocrBusy = false;
  }
});

app.on('before-quit', () => {
  if (ocrWorker) { try { ocrWorker.terminate(); } catch (_) {} ocrWorker = null; }
});

let mainWin = null;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: '库存记录本',
    autoHideMenuBar: true,
    backgroundColor: '#f2f4f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin.loadFile('index.html');
  mainWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (app.isPackaged) {
    mainWin.webContents.on('will-navigate', (e) => e.preventDefault());
  }
  // 开发时把页面报错转发到终端，方便排查
  if (!app.isPackaged) {
    mainWin.webContents.on('console-message', (...args) => {
      const ev = args[0];
      if (ev && typeof ev === 'object' && 'message' in ev) {
        console.log(`[renderer:${ev.level}] ${ev.message}${ev.sourceId ? ' (' + ev.sourceId + ':' + ev.lineNumber + ')' : ''}`);
      } else {
        console.log(`[renderer:${args[1]}] ${args[2]}`);
      }
    });
  }
}

// 单实例：双击两次只开一个窗口，防止并发写坏数据文件
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
  Menu.setApplicationMenu(null);
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
