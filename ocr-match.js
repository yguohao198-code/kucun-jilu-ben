/* 截图识别：OCR 文字 → 订单草稿 匹配算法（纯函数，无 DOM 依赖，可在 Node 里单测） */
(function (global) {
  'use strict';

  const UNIT_RE = '(件|个|只|支|盒|包|条|套|对|双|箱|公斤|千克|斤|米|根|片|台|袋|桶|颗|张|卷|组|打|副|瓶|罐|本)';

  // 归一化：全角数字→半角、小写、去空格、乘号统一为 ×；保留标点（分隔符和 . 小数要用）
  function normForMatch(s) {
    return String(s || '')
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .toLowerCase()
      .replace(/[\s　 ]/g, '')
      .replace(/[xX*＊✕✖]/g, '×');
  }

  // OCR 易混修正：0 常被认成 O/o
  function fixOcrMixups(s) {
    return String(s || '')
      .replace(/1[Oo]件/g, '10件')
      .replace(/(\d)[Oo](\d)/g, '$10$2');
  }

  // 从文本里提数量，claimedRanges 是已被品名/规格占用的区间（里面的数字不算）
  function extractNumbers(t, claimedRanges) {
    const inClaim = p => (claimedRanges || []).some(r => p >= r[0] && p < r[1]);
    const nums = [];
    const re = /\d+(\.\d+)?/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      if (inClaim(m.index)) continue;
      const digits = m[0];
      const before = t.slice(0, m.index);
      const after = t.slice(m.index + digits.length);
      const suf2 = after.slice(0, 2);
      if (/(¥|￥)$/.test(before)) continue;            // ¥12.5
      if (/^(元|块)/.test(suf2)) continue;             // 12.5元、3块
      if (digits.includes('.')) {
        // 小数：带单位或跟在 × 后才算数量（1.2件、×1.5）；裸小数一律当价格
        if (!new RegExp('^' + UNIT_RE).test(after) && !/×$/.test(before)) continue;
      }
      if (digits.length >= 7) continue;                // 订单号/编码
      if (digits.length === 11 && /^1[3-9]/.test(digits)) continue; // 手机号
      if (/\d{4}([-/年]\d{1,2}([-/月]\d{1,2})?日?)/.test(before + digits + after)) continue; // 日期
      let kind = 'bare';
      if (/各$/.test(before)) kind = 'each';
      else if (new RegExp('^' + UNIT_RE).test(after)) kind = 'unit';
      else if (/×$/.test(before)) kind = 'times';
      nums.push({ value: parseFloat(digits), pos: m.index, kind });
    }
    return nums;
  }

  function buildIndex(specs, products) {
    const specEntries = (specs || [])
      .map(s => ({ norm: normForMatch(s.name), spec: s }))
      .filter(e => e.norm.length >= 1)
      .sort((a, b) => b.norm.length - a.norm.length);   // 最长优先："M6×30" 不会被 "M6" 抢
    const prodEntries = (products || [])
      .map(p => ({ norm: normForMatch(p.name), p }))
      .filter(e => e.norm.length >= 1)
      .sort((a, b) => b.norm.length - a.norm.length);
    return { specEntries, prodEntries };
  }

  // 解析一个 token（一行里逗号分出的片段），返回条目和数量
  function parseToken(t, index) {
    const claims = [];
    const tryClaim = (start, len, entry) => {
      if (len < 1) return false;
      for (const c of claims) if (start < c.end && c.start < start + len) return false;
      claims.push({ start, end: start + len, entry });
      return true;
    };
    // 1) 规格最长匹配优先，记录占用区间
    for (const se of index.specEntries) {
      let i = t.indexOf(se.norm);
      while (i !== -1) {
        if (tryClaim(i, se.norm.length, { kind: 'spec', specId: se.spec.id, productId: se.spec.productId })) break;
        i = t.indexOf(se.norm, i + 1);
      }
    }
    // 2) 未被占用的空隙里匹配品名
    claims.sort((a, b) => a.start - b.start);
    const gaps = [];
    let pos = 0;
    for (const c of claims) {
      if (c.start > pos) gaps.push([pos, c.start]);
      pos = Math.max(pos, c.end);
    }
    if (pos < t.length) gaps.push([pos, t.length]);
    for (const [gs, ge] of gaps) {
      const sub = t.slice(gs, ge);
      for (const pe of index.prodEntries) {
        let i = sub.indexOf(pe.norm);
        while (i !== -1) {
          if (tryClaim(gs + i, pe.norm.length, { kind: 'product', productId: pe.p.id })) break;
          i = sub.indexOf(pe.norm, i + 1);
        }
      }
    }
    // 2.5) 边界校验：匹配占满 token 后还残留字母（如 "vip10" 里 "ip10" 前面多出 "v"）
    // → 不再静默接受，交给界面当未匹配行处理并附疑似候选
    if (claims.length) {
      let residue = '';
      let pos = 0;
      const sorted = [...claims].sort((a, b) => a.start - b.start);
      for (const c of sorted) {
        if (c.start > pos) residue += t.slice(pos, c.start);
        pos = Math.max(pos, c.end);
      }
      if (pos < t.length) residue += t.slice(pos);
      if (/[a-z]/.test(residue)) return { rows: [], numbers: [], ambiguous: true, claimedRanges: claims.map(c => [c.start, c.end]) };
    }
    // 3) 相邻的品名+规格合并成一条（"螺丝M6×30" / "M6×30螺丝"）
    claims.sort((a, b) => a.start - b.start);
    const entries = [];
    for (let i = 0; i < claims.length; i++) {
      const c = claims[i], n = claims[i + 1];
      if (n && n.start === c.end && c.entry.kind !== n.entry.kind) {
        const specC = c.entry.kind === 'spec' ? c.entry : n.entry;
        const prodC = c.entry.kind === 'product' ? c.entry : n.entry;
        // 只有品名和规格属于同一个产品才合并（防止 "ip10vip" 把 ip10 错并进 vip）
        if (specC.productId === prodC.productId) {
          entries.push({ kind: 'spec', specId: specC.specId, productId: prodC.productId, pos: c.start, len: n.end - c.start });
          i++;
          continue;
        }
      }
      entries.push({ kind: c.entry.kind, specId: c.entry.specId, productId: c.entry.productId, pos: c.start, len: c.end - c.start });
    }
    // 4) 提数量：先把名称占用的区间遮蔽成占位符（防止 "M6×30" 的 30 和后面的 "10" 连成 "3010"）
    const claimedRanges = entries.map(e => [e.pos, e.pos + e.len]);
    const masked = t.split('').map((c, i) => claimedRanges.some(r => i >= r[0] && i < r[1]) ? '■' : c).join('');
    const numbers = extractNumbers(masked, []);
    // 5) 就近配对；"各N" 作为剩余条目的兜底
    const used = numbers.map(() => false);
    const eachNum = numbers.find(n => n.kind === 'each');
    const rows = [];
    for (const en of entries) {
      let qty = null;
      let best = -1, bestScore = Infinity;
      for (let i = 0; i < numbers.length; i++) {
        if (used[i] || numbers[i].kind === 'each') continue;
        const numLen = String(numbers[i].value).length;
        const dist = numbers[i].pos >= en.pos + en.len
          ? numbers[i].pos - (en.pos + en.len)
          : en.pos - (numbers[i].pos + numLen);
        if (dist > 20) continue;
        const score = dist + (numbers[i].kind === 'bare' ? 10 : 0);
        if (score < bestScore) { bestScore = score; best = i; }
      }
      if (best >= 0) { qty = numbers[best].value; used[best] = true; }
      else if (eachNum) qty = eachNum.value;
      rows.push({ kind: en.kind, specId: en.specId, productId: en.productId, qty: qty != null ? qty : 1, qtyGiven: qty != null });
    }
    return { rows, numbers };
  }

  // 编辑距离（Levenshtein，小字符串够用）
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      const tmp = prev; prev = cur; cur = tmp;
    }
    return prev[n];
  }

  // 去掉末尾的「数量尾巴」（×3 / 5件 / 10个…），名字里自带的数字不动（"vip10" 的 10 保留）
  function stripQtyTail(s) {
    let out = s;
    const re = new RegExp('([×]?\\d+(?:\\.\\d+)?' + UNIT_RE + '|[×]\\d+(?:\\.\\d+)?)$');
    while (re.test(out)) out = out.replace(re, '');
    return out;
  }

  // 未匹配/歧义文本的「疑似匹配」候选：
  // 整串相近 > 名字拆「字母段+尾数字段」锚定（vp10 → vp+10，原文 "vip105件" 里 10 后面只跟数量尾巴） > 原文包含规格名 > 规格名包含原文
  function suggestMatches(t, specs, products) {
    const out = [];
    const t2 = stripQtyTail(t);
    const qtyTailRe = new RegExp('^[×\\d.]+(?:' + UNIT_RE + ')?$');
    const runRe = /\d+(?:\.\d+)?/g;
    for (const s of specs || []) {
      const n = normForMatch(s.name);
      if (!n || n === t) continue;
      let best = { score: 0, prefix: 0 };
      const consider = (score, prefix) => {
        if (score > best.score || (score === best.score && prefix > best.prefix)) best = { score, prefix };
      };
      // 1) 整串相近（也试去掉数量尾巴后的串）
      const limit = n.length <= 4 ? 1 : (n.length <= 8 ? 2 : 3);
      const d = Math.min(levenshtein(t, n), levenshtein(t2, n));
      if (d <= limit) {
        let p = 0; while (p < t2.length && p < n.length && t2[p] === n[p]) p++;
        consider(5 - d, p);
      }
      // 2) 原文/去尾串包含规格名、或规格名包含原文
      if (t.includes(n) || (t2 !== t && t2.includes(n))) consider(3, 0);
      if ((n.includes(t) && t.length >= 2) || (n.includes(t2) && t2.length >= 2)) consider(2, 0);
      // 3) 尾数字段锚定：名字的结尾数字段在原文里出现（或作为数字段前缀，如 105 里的 10），
      //    且其后的部分只含数量尾巴（数字/×/单位），字母段再比一次编辑距离
      const m = n.match(/^(.*?)(\d+(?:\.\d+)?)$/);
      if (m && m[1]) {
        runRe.lastIndex = 0;
        let rm;
        while ((rm = runRe.exec(t)) !== null) {
          if (!rm[0].startsWith(m[2])) continue;
          const tL = t.slice(0, rm.index);
          const tRest = t.slice(rm.index + m[2].length);
          if (!qtyTailRe.test(tRest)) continue;
          const dL = levenshtein(tL, m[1]);
          if (dL <= (m[1].length <= 4 ? 1 : 2)) {
            let p = 0; while (p < tL.length && p < m[1].length && tL[p] === m[1][p]) p++;
            consider(5, p);
          }
        }
      }
      if (!best.score) continue;
      const p = (products || []).find(x => x.id === s.productId);
      out.push({ specId: s.id, productId: s.productId, specName: s.name, productName: p ? p.name : '', score: best.score, prefix: best.prefix });
    }
    out.sort((a, b) => b.score - a.score || b.prefix - a.prefix || a.specName.localeCompare(b.specName, 'zh'));
    return out.slice(0, 4);
  }

  // 主要入口：lines = [{text}]（OCR 返回的行），specs/products = 当前库存数据
  function matchOcrLines(lines, specs, products) {
    const index = buildIndex(specs, products);
    const rows = [];
    let ignoredCount = 0;

    (lines || []).forEach((line, lineIdx) => {
      const raw = String(line.text || '').trim();
      const t = fixOcrMixups(normForMatch(raw));
      if (!t) { ignoredCount++; return; }
      // 纯日期行、合计类行直接忽略
      if (/^(合计|总计|总价|实付|应付|优惠|运费|抹零|小计|共计|收款)/.test(t)) { ignoredCount++; return; }
      if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(t)) { ignoredCount++; return; }

      const tokens = t.split(/[，,;；。|]/).filter(Boolean)
        .map(tok => tok.replace(/^[0-9]{1,2}[、.．)）:：]/, ''));
      const lineRows = [];
      let lastEntry = null;
      for (const tok of tokens) {
        if (!tok) continue;
        const pr = parseToken(tok, index);
        if (pr.ambiguous) {
          // 名字旁边残留字母 → 不静默配错，进未匹配列表并附「疑似」候选；
          // 数量只认带单位/× 的数字（"vip10" 里的 10 是名字的一部分，不当作数量）；
          // 名称占用的区间逐字遮蔽，防止 "vip10 5件" 的 10 和 5 连成 105
          const masked = tok.split('').map((c, i) => (pr.claimedRanges || []).some(r => i >= r[0] && i < r[1]) ? '■' : c).join('');
          const nums = extractNumbers(masked, []);
          const q = nums.find(n => n.kind === 'unit' || n.kind === 'times');
          const row = { kind: 'none', ambiguous: true, suggestions: suggestMatches(tok, specs, products), qty: q ? q.value : 1, qtyGiven: !!q };
          lineRows.push(row); lastEntry = row;
          continue;
        }
        if (pr.rows.length) {
          for (const r of pr.rows) { lineRows.push(r); lastEntry = r; }
          continue;
        }
        // 纯数量片段（如 "10件" 单独成段）→ 补给上一个没数量的条目
        if (lastEntry && !lastEntry.qtyGiven && pr.numbers.length === 1 && /^[×\d.]+/.test(tok)) {
          lastEntry.qty = pr.numbers[0].value;
          lastEntry.qtyGiven = true;
          continue;
        }
      }
      if (!lineRows.length) {
        // 纯价格行忽略
        if (/[¥￥]/.test(t) || (/^\d+(\.\d+)?(元|块)$/.test(t))) { ignoredCount++; return; }
        // 无数字的行（问候语、人名、"谢谢"等客套话）忽略 —— 解决第一行/最后行误入审核列表
        if (!/\d/.test(t)) { ignoredCount++; return; }
        // 纯时间/日期行（聊天截图顶部时间戳）忽略
        const ts = t.replace(/^(今天|昨天|前天|上午|下午|晚上|中午|凌晨|刚刚|刚才)/, '');
        if (/^\d{1,2}[:：]\d{2}$/.test(ts)) { ignoredCount++; return; }
        if (/^微信(\(\d+\))?$/.test(t)) { ignoredCount++; return; }
        if (/^\d{4}年\d{1,2}月\d{1,2}日?$/.test(t) || /^\d{1,2}月\d{1,2}日?$/.test(t)) { ignoredCount++; return; }
        // "共1200" 这类没有"合计"字样的总价行忽略
        if (/^(共|一共|总共|共计)[¥￥]?\d+(\.\d+)?(元|块)?$/.test(t)) { ignoredCount++; return; }
        // 有数字但提不出数量（如纯手机号行）忽略；其余作为"未匹配"行留给用户手动对应
        if (!extractNumbers(t, []).length) { ignoredCount++; return; }
        rows.push({ kind: 'none', raw, lineIdx, qty: 1, qtyGiven: false });
        return;
      }
      for (const r of lineRows) rows.push(Object.assign({ raw, lineIdx }, r));
    });

    // 跨行处理 1：纯数量行（整行只有一个数字）→ 补给上一行没数量的条目
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.kind !== 'none') continue;
      const nums = extractNumbers(fixOcrMixups(normForMatch(r.raw)), []);
      if (nums.length !== 1 || r.raw.replace(/[^\d×]/g, '').length > 6) continue;
      for (let j = i - 1; j >= 0; j--) {
        if (rows[j].kind === 'none' || rows[j].lineIdx === r.lineIdx) continue;
        if (!rows[j].qtyGiven) { rows[j].qty = nums[0].value; rows[j].qtyGiven = true; rows.splice(i, 1); i--; }
        break;
      }
    }
    // 跨行处理 2：品名标题行（品名单独一行，规格在后面行）
    const specProductIds = new Set(rows.filter(r => r.kind === 'spec').map(r => r.productId));
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.kind === 'product' && !r.qtyGiven && specProductIds.has(r.productId)) rows.splice(i, 1);
    }
    // 跨行处理 3：连续两行都没匹配上 → 拼起来重试
    for (let i = 0; i + 1 < rows.length; i++) {
      const a = rows[i], b = rows[i + 1];
      if (a.kind !== 'none' || b.kind !== 'none' || b.lineIdx - a.lineIdx !== 1) continue;
      const merged = fixOcrMixups(normForMatch(a.raw + b.raw));
      const tokens = merged.split(/[，,;；。|]/).filter(Boolean);
      const found = [];
      for (const tok of tokens) {
        const pr = parseToken(tok, index);
        for (const r of pr.rows) found.push(Object.assign({ raw: a.raw + ' ' + b.raw, lineIdx: a.lineIdx }, r));
      }
      if (found.length) {
        rows.splice(i, 2, ...found);
        i += found.length - 1;
      }
    }
    // 只有品名的行：该产品恰好 1 个规格 → 自动指定；多个留给界面让用户选
    for (const r of rows) {
      if (r.kind !== 'product') continue;
      const cands = (specs || []).filter(s => s.productId === r.productId);
      if (cands.length === 1) { r.kind = 'spec'; r.specId = cands[0].id; }
      else r.candidates = cands.map(s => s.id);
    }
    return { rows, ignoredCount };
  }

  // 手动对应时预填搜索框：去掉数量/价格痕迹，只留文字
  function stripQtyForSearch(raw) {
    const s = fixOcrMixups(String(raw || ''));
    const out = s
      .replace(new RegExp('\\d+(\\.\\d+)?\\s*' + UNIT_RE, 'g'), '')             // 10件、1.2件
      .replace(new RegExp('[\\s，,、。;；:：|][×xX*＊]\\s*\\d+(\\.\\d+)?', 'g'), '') // " ×10 / ×1.5"（名称里的 ×30 不动）
      .replace(/[¥￥]\s*\d+(\.\d+)?/g, '')                                      // ¥12.5
      .replace(/\d+(\.\d+)?\s*(元|块)/g, '')                                    // 12.5元
      .replace(/[，,、。.;；:：|¥￥]/g, ' ');
    return out.replace(/\s+/g, ' ').trim();
  }

  // 手动对应后，按"该规格名从原文里剔除"的方式重新推数量
  function qtyForRawWithSpec(raw, specName) {
    const t = fixOcrMixups(normForMatch(raw));
    const n = normForMatch(specName);
    const masked = t.split(n).join('■'.repeat(n.length));
    const nums = extractNumbers(masked, []);
    if (!nums.length) return null;
    const good = nums.find(x => x.kind !== 'bare') || nums[0];
    return good.value;
  }

  // 从未匹配文本里猜一个数量（不知道规格名时的兜底：优先 单位式，其次靠后数字）
  function firstQtyFromText(raw) {
    const s = fixOcrMixups(String(raw || ''))
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    const re = /\d+(\.\d+)?/g;
    const cands = [];
    let m;
    while ((m = re.exec(s)) !== null) {
      const digits = m[0];
      const before = s.slice(0, m.index);
      const after = s.slice(m.index + digits.length);
      if (/(¥|￥)\s*$/.test(before)) continue;
      if (/^\s*(元|块)/.test(after)) continue;
      if (digits.includes('.')) {
        // 小数：带单位或跟在 × 后才算数量；裸小数当价格
        if (!new RegExp('^\\s*' + UNIT_RE).test(after) && !(/[×xX*＊]\s*$/.test(before))) continue;
      }
      if (digits.length >= 7) continue;
      const kind = new RegExp('^\\s*' + UNIT_RE).test(after) ? 'unit' : (/[×xX*＊]\s*$/.test(before) ? 'times' : 'bare');
      cands.push({ value: parseFloat(digits), kind });
    }
    if (!cands.length) return null;
    const good = cands.find(c => c.kind !== 'bare') || cands[cands.length - 1];
    return good.value;
  }

  const api = { normForMatch, fixOcrMixups, extractNumbers, parseToken, matchOcrLines, stripQtyForSearch, qtyForRawWithSpec, firstQtyFromText, suggestMatches };
  global.OcrMatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
