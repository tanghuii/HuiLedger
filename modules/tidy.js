// 整理转账 / 整理分类：和手机端同一套规则、同一个样子。
// 规则照搬 LedgerViewModel.kt 的 findFixes / applyFixes / ignoreFix / restoreIgnored、categoryCleanupPlan / applyCategoryCleanup，
// 以及 CategoryRules.kt；界面照搬 ToolsScreens.kt 的 TransfersScreen、CategoryCleanupScreen。样式在 css/tidy.css。
// 标过"不是重复 / 不用改"的建议和手机端一样只记在本机（浏览器里的 hl.ignoredFixes）。
'use strict';

const TD = { picked: new Map(), skipped: new Map(), busy: false, sig: null, fixes: null, plan: null, checked: false };

// ---------------------------------------------------------------- 小工具

const TD_KIND = { DUP_TRANSFER: 'DUP_TRANSFER', CONVERT: 'CONVERT', MERGE: 'MERGE', DUPLICATE: 'DUPLICATE' };
/** 和手机端 dao.txs() 一样的顺序：日期、录入时间、id 都从新到旧。后面的"取第一个最近的"都依赖这个顺序。 */
const tdTxs = () => [...state.data.tx.values()].sort((a, b) => b.date - a.date || (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id - a.id);
const tdOrdered = (m) => [...m.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
const tdLedger = (t) => t.ledgerId ?? 1;
const tdPid = (c) => Number(c?.parentId) || 0;
const tdTagList = (t) => String(t.tags ?? '').split(' ').filter((x) => x.trim());
/** Kotlin 的 minByOrNull / maxByOrNull：一样大时取先出现的。 */
function tdMinBy(list, f) { let best = null, bv = Infinity; for (const x of list) { const v = f(x); if (v < bv) { bv = v; best = x; } } return best; }
function tdMaxBy(list, f) { let best = null, bv = -Infinity; for (const x of list) { const v = f(x); if (v > bv) { bv = v; best = x; } } return best; }
function tdGroupBy(list, key) { const m = new Map(); for (const x of list) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }
const tdToast = (text) => { if (typeof edToast === 'function') edToast(text); else { state.notice = text; } };
const tdCat = (name) => (typeof catName === 'function' ? catName(name) : name);

/** 银行品牌，顺序和手机端 Brands.all 一样（备注里提到的品牌认的是第一个对上的）。 */
const TD_BRANDS = [['中国银行', '中行', 'boc'], ['工商', '工行', 'icbc'], ['农业', '农行', 'abc'], ['建设银行', '建行', 'ccb'], ['招商', '招行', 'cmb'], ['交通银行', '交行', 'bocom'],
  ['民生', 'cmbc'], ['中信'], ['邮储', '邮政'], ['支付宝', 'alipay'], ['微信', 'wechat', 'weixin'], ['ing'], ['revolut'], ['paypal'], ['bunq'], ['asn'], ['kraken'],
  ['wise', 'transferwise'], ['abn'], ['n26'], ['trade republic', 'traderepublic'], ['trading 212', 'trading212', 'trading'], ['bitvavo'], ['coinbase'], ['rabo'],
  ['平安', 'pingan'], ['桂林银行'], ['中泰'], ['scalable'], ['lemfi'], ['robin'], ['degiro'], ['binance', '币安'], ['finst']];
const tdAscii = (s) => /^[\x00-\x7f]*$/.test(s);
/** Brands.match：返回品牌序号，认不出是 -1。三个字母以内的英文缩写要是独立的词。 */
function tdBrand(name) {
  const n = String(name ?? '').toLowerCase(), words = new Set(n.split(/[^a-z0-9]+/));
  return TD_BRANDS.findIndex((keys) => keys.some((k) => (k.length <= 3 && tdAscii(k) ? words.has(k) : n.includes(k))));
}

/** 数据有没有变：账单、分类、账户里和识别有关的字段算一个指纹。变了才重新识别。 */
function tdSig() {
  let s = 7;
  const mix = (v) => { s = (Math.imul(s, 31) + (Number(v) % 1e9 | 0)) | 0; };
  const str = (x) => { const t = String(x ?? ''); mix(t.length); for (let i = 0; i < t.length; i += 3) mix(t.charCodeAt(i)); };
  for (const t of state.data.tx.values()) { mix(t.id); mix(t.amountCents); mix(t.date); mix(t.kind); mix(t.accountId); mix(t.toAccountId); mix(t.categoryId); mix(tdLedger(t)); mix(t.createdAt ?? 0); mix(t.reimburse ?? 0); str(t.note); str(t.tags); }
  for (const c of state.data.category.values()) { mix(c.id); mix(tdPid(c)); mix(c.isIncome ? 1 : 0); mix(c.sortOrder ?? 0); str(c.name); }
  for (const a of state.data.account.values()) { mix(a.id); mix(a.sortOrder ?? 0); str(a.name); }
  str(tdIgnored().join(','));
  return s;
}
function tdFresh() {
  // 同一次画页面里只算一次指纹
  if (TD.checked) return;
  TD.checked = true; queueMicrotask(() => { TD.checked = false; });
  const sig = tdSig();
  if (sig !== TD.sig) { TD.sig = sig; TD.fixes = null; TD.plan = null; }
}
/** 不管数据变没变，下次都重新识别。 */
function tdReset() { TD.sig = null; TD.fixes = null; TD.plan = null; TD.checked = false; }

// ---------------------------------------------------------------- 忽略的建议（只在本机）

const tdIgnored = () => { const v = store.get('hl.ignoredFixes', []); return Array.isArray(v) ? v : []; };
const tdKey = (f) => `${f.kind}:${f.a.id}:${f.b?.id ?? 0}`;

// ---------------------------------------------------------------- 整理转账：识别（findFixes）

const TD_CLEAR_INCOME = new Set(['退款', '报销', '工资', '奖金', '外快兼职', '利息', '投资收益', '礼金']);
const TD_REPAY = /还款|还信用卡|信用卡还|还卡|repay|card payment|creditcard afschrijving/i;
const TD_FEE_WORDS = ['费', '奖', '返', '利', '息', 'fee', 'reward', 'cashback', 'bonus', 'interest'];

/**
 * 在历史账单里找记错了的转账和重复的账单。都只在同一账本、日期相差不超过 3 天的范围里找：
 * DUP_TRANSFER 收支和已有转账金额相同；CONVERT 其实是转账的收支；MERGE 一出一进；DUPLICATE 重复录入。
 * likely 表示把握较大，界面上默认勾选。
 */
function tdFindFixes() {
  tdFresh();
  if (TD.fixes) return TD.fixes;
  const cats = state.data.category;
  const topName = (id) => { const c = cats.get(id); return c ? (tdPid(c) ? cats.get(c.parentId)?.name ?? c.name : c.name) : ''; };
  const close = (a, b) => tdLedger(a) === tdLedger(b) && Math.abs(a.date - b.date) <= 3;
  const all = tdTxs();
  const accounts = tdOrdered(state.data.account);
  const plain = all.filter((t) => t.kind !== KIND.TRANSFER).sort((a, b) => b.amountCents - a.amountCents);
  const transfers = tdGroupBy(all.filter((t) => t.kind === KIND.TRANSFER), (t) => t.amountCents);
  const brands = new Map(accounts.map((a) => [a.id, tdBrand(a.name)]));
  const used = new Set(), fixes = [];

  // 备注里提到的自己的另一个账户（按账户名，或按银行品牌）
  const mentioned = (tx) => {
    const raw = String(tx.note ?? '');
    if (!raw.trim()) return null;
    const note = raw.toLowerCase();
    // 手续费、奖励、返现这类虽然提到了账户，但确实是收支
    if (TD_FEE_WORDS.some((w) => note.includes(w))) return null;
    const words = new Set(note.split(/[^a-z0-9]+/)), brand = tdBrand(raw);
    return accounts.find((a) => {
      const name = String(a.name ?? '').toLowerCase();
      // 英文账户名要整词出现（不然 "heating" 会被认成 ING），中文名包含即可
      const named = name.length >= 3 && (tdAscii(name) ? words.has(name) : note.includes(name));
      return a.id !== tx.accountId && (named || (brand >= 0 && brands.get(a.id) === brand));
    }) ?? null;
  };

  // 信用卡还款记成了支出：还到哪张卡，先看备注；没提就找和付款账户同一家的（名字第一个词相同）里收到转账最多的
  const transfersIn = new Map();
  for (const t of all) if (t.kind === KIND.TRANSFER) transfersIn.set(t.toAccountId, (transfersIn.get(t.toAccountId) ?? 0) + 1);
  const stemOf = (name) => String(name ?? '').trim().split(' ')[0].toLowerCase();
  const repayTarget = (tx) => {
    if (tx.kind !== KIND.EXPENSE || !TD_REPAY.test(String(tx.note ?? ''))) return null;
    const m = mentioned(tx);
    if (m) return m;
    const own = accounts.find((a) => a.id === tx.accountId);
    if (!own) return null;
    const stem = stemOf(own.name);
    return tdMaxBy(accounts.filter((a) => a.id !== tx.accountId && stemOf(a.name) === stem), (a) => transfersIn.get(a.id) ?? 0);
  };

  for (const tx of plain) {
    const top = topName(tx.categoryId);
    // 工资、奖金、退款这些明确的收入不会是转账
    if (tx.kind === KIND.INCOME && TD_CLEAR_INCOME.has(top)) continue;
    const other = mentioned(tx);
    // 同一次录入的两笔要同一天才算；分两次录入的放宽到 3 天
    const same = (transfers.get(tx.amountCents) ?? []).filter((t) => !used.has(t.id) && close(t, tx) && (t.date === tx.date || Math.abs((t.createdAt ?? 0) - (tx.createdAt ?? 0)) > 60000));
    // 提到了另一个账户时，只有那笔转账也涉及它才算同一笔钱
    const dup = tdMinBy(same.filter((t) => !other || t.accountId === other.id || t.toAccountId === other.id), (t) => Math.abs(t.date - tx.date));
    if (dup) {
      used.add(tx.id); used.add(dup.id);
      fixes.push({ kind: TD_KIND.DUP_TRANSFER, a: tx, b: dup, toAccount: 0, likely: tx.amountCents >= 5000 });
      continue;
    }
    const repay = repayTarget(tx);
    if (repay) {
      used.add(tx.id);
      // "还款"也可能是还别的欠款，所以只提出来，不默认勾选
      fixes.push({ kind: TD_KIND.CONVERT, a: tx, b: null, toAccount: repay.id, likely: false });
    } else if (other && !tx.reimburse && top === '其他') {
      // 只看记在"其他"下的：正经的消费都有自己的分类
      used.add(tx.id);
      fixes.push({ kind: TD_KIND.CONVERT, a: tx, b: null, toAccount: other.id, likely: tx.amountCents >= 10000 });
    }
  }

  const incomes = tdGroupBy(plain.filter((t) => t.kind === KIND.INCOME), (t) => t.amountCents);
  for (const out of plain.filter((t) => t.kind === KIND.EXPENSE && !used.has(t.id))) {
    const match = tdMinBy((incomes.get(out.amountCents) ?? []).filter((t) => !used.has(t.id) && t.accountId !== out.accountId && close(t, out)), (t) => Math.abs(t.date - out.date));
    if (!match) continue;
    used.add(out.id); used.add(match.id);
    const likely = out.amountCents >= 10000 && !out.reimburse && !['退款', '报销', '工资', '奖金'].includes(topName(match.categoryId));
    fixes.push({ kind: TD_KIND.MERGE, a: out, b: match, toAccount: 0, likely });
  }

  // 重复录入的：收支和转账都查
  for (const [later, earlier] of tdDuplicates(all, used)) fixes.push({ kind: TD_KIND.DUPLICATE, a: later, b: earlier, toAccount: 0, likely: later.amountCents >= 2000 });

  const ignored = new Set(tdIgnored());
  for (const f of fixes) f.key = tdKey(f);
  TD.fixes = fixes.filter((f) => !ignored.has(f.key)).sort((x, y) => y.a.amountCents - x.a.amountCents);
  return TD.fixes;
}

/**
 * Merge.duplicates：同一账本、类型和金额相同、日期相差 3 天内、录入时间隔一分钟以上的两笔。
 * 转账还要求至少有一头是同一个账户。返回 [后录入的, 先录入的]；每笔最多出现在一对里。
 */
function tdDuplicates(txs, skip) {
  const used = new Set(skip), pairs = [];
  for (const group of tdGroupBy(txs.filter((t) => !used.has(t.id)), (t) => `${t.amountCents}|${t.kind}|${tdLedger(t)}`).values()) {
    if (group.length < 2) continue;
    for (const later of [...group].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))) {
      if (used.has(later.id)) continue;
      const earlier = tdMinBy(group.filter((e) => !used.has(e.id) && e.id !== later.id && Math.abs(e.date - later.date) <= 3 && (later.createdAt ?? 0) - (e.createdAt ?? 0) > 60000 &&
        (later.kind !== KIND.TRANSFER || e.accountId === later.accountId || e.toAccountId === later.toAccountId)), (e) => Math.abs(e.date - later.date));
      if (!earlier) continue;
      used.add(later.id); used.add(earlier.id);
      pairs.push([later, earlier]);
    }
  }
  return pairs;
}

/** Merge.mergeNote：一段已经包含另一段就取长的，否则拼起来。 */
function tdMergeNote(old, neu) {
  old = String(old ?? ''); neu = String(neu ?? '');
  const has = (a, b) => a.toLowerCase().includes(b.toLowerCase());
  const r = !neu.trim() || has(old, neu) ? old : !old.trim() || has(neu, old) ? neu : `${old} · ${neu}`;
  return r.slice(0, 500);
}

// ---------------------------------------------------------------- 写云端：一次两百行，断网就排队

async function tdWrite(rows) {
  if (!rows.length) return;
  try {
    for (let i = 0; i < rows.length; i += 200) {
      await api('POST', '/rest/v1/records?on_conflict=user_id,kind,id', rows.slice(i, i + 200).map((r) => ({ user_id: state.session.user, ...r })), { prefer: 'resolution=merge-duplicates,return=minimal' });
    }
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    const keys = new Set(rows.map((r) => `${r.kind}:${r.id}`));
    store.set('hl.outbox', [...outbox.list().filter((r) => !keys.has(`${r.kind}:${r.id}`)), ...rows]);
  }
  for (const r of rows) { if (r.deleted) state.data[r.kind].delete(r.id); else state.data[r.kind].set(r.id, r.data); }
  saveSnapshot();
}

/** applyFixes：合并的留下对上的那笔并带上备注和标签，删掉多出来的；改成转账的换类型和两头账户。 */
async function tdApplyFixes(fixes) {
  const rows = [], put = (t) => rows.push({ kind: 'tx', id: t.id, data: t, deleted: false }), del = (t) => rows.push({ kind: 'tx', id: t.id, data: {}, deleted: true });
  for (const f of fixes) {
    if (f.kind === TD_KIND.DUP_TRANSFER || f.kind === TD_KIND.DUPLICATE) {
      const keep = f.b;
      const note = tdMergeNote(keep.note, f.a.note), tags = [...new Set([...tdTagList(keep), ...tdTagList(f.a)])].join(' ');
      if (note !== String(keep.note ?? '') || tags !== String(keep.tags ?? '')) put({ ...keep, note, tags });
      del(f.a);
    } else if (f.kind === TD_KIND.MERGE) {
      const income = f.b;
      const note = [...new Set([f.a.note, income.note].map((x) => String(x ?? '')).filter((x) => x.trim()))].join(' / ');
      const tags = [...new Set([...tdTagList(f.a), ...tdTagList(income)])].join(' ');
      put({ ...f.a, kind: KIND.TRANSFER, categoryId: 0, toAccountId: income.accountId, note, tags, reimburse: 0, excluded: false });
      del(income);
    } else if (f.kind === TD_KIND.CONVERT) {
      // 支出是从这个账户转去另一个账户，收入则反过来
      put(f.a.kind === KIND.EXPENSE
        ? { ...f.a, kind: KIND.TRANSFER, categoryId: 0, toAccountId: f.toAccount, reimburse: 0, excluded: false }
        : { ...f.a, kind: KIND.TRANSFER, categoryId: 0, accountId: f.toAccount, toAccountId: f.a.accountId, reimburse: 0, excluded: false });
    }
  }
  await tdWrite(rows);
}

// ---------------------------------------------------------------- 整理分类：规则（CategoryRules.kt）

const TD_TOP = { 日常: '居住', 居家: '居住', 住房: '居住', 装修: '居住', 家居: '居住', 旅游: '旅行', 出行: '交通', 饮食: '餐饮', 吃喝: '餐饮', 医药: '医疗',
  教育: '学习', 人情: '社交', 通信: '通讯', 话费: '通讯', 美容: '美妆' };
const TD_SUB = {
  '餐饮/咖啡': '咖啡饮料', '餐饮/饮料': '咖啡饮料', '餐饮/奶茶': '咖啡饮料',
  '交通/公交车': '公交地铁', '交通/公交': '公交地铁', '交通/地铁': '公交地铁',
  '交通/出租车': '打车', '交通/的士': '打车', '交通/共享单车': '自行车', '交通/机票': '飞机',
  '旅行/酒店住宿': '住宿', '旅行/酒店': '住宿',
  '居住/电费': '水电燃气', '居住/水费': '水电燃气', '居住/燃气': '水电燃气', '居住/暖气': '水电燃气',
  '居住/宽带': '网费', '居住/装修材料': '装修', '居住/软装': '家具', '居住/灯具': '家具',
  '医疗/药': '药品',
};
const TD_HOME = { 通讯: ['通讯', ''], 运动: ['运动', ''], 居家: ['居住', ''], 理发: ['美妆', '理发'], 日用品: ['购物', '日用品'] };
const tdOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** CategoryRules.expense：意思相同的支出分类归到同一个「一级 · 子」上。 */
function tdRule(top, sub) {
  const t = tdOwn(TD_TOP, top) ? TD_TOP[top] : top;
  if (!sub.trim() || sub === t) return [t, ''];
  if (tdOwn(TD_HOME, sub)) return TD_HOME[sub];
  const s = tdOwn(TD_SUB, `${t}/${sub}`) ? TD_SUB[`${t}/${sub}`] : sub;
  return [t, s === t ? '' : s];
}

/** categoryCleanupPlan：要合并或挪动的支出分类，按原来所在的一级分类分组。 */
function tdCatPlan() {
  tdFresh();
  if (TD.plan) return TD.plan;
  const cats = tdOrdered(state.data.category).filter((c) => !c.isIncome);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const counts = new Map();
  for (const t of state.data.tx.values()) counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
  const moves = [];
  for (const c of cats) {
    const parent = tdPid(c) ? byId.get(c.parentId) : null, top = parent ?? c;
    const cur = [String(top.name ?? ''), parent ? String(c.name ?? '') : ''];
    const target = tdRule(cur[0], cur[1]);
    if (target[0] !== cur[0] || target[1] !== cur[1]) moves.push([top, { category: c, top: target[0], sub: target[1], count: counts.get(c.id) ?? 0 }]);
  }
  // 同一个上级下的重名分类，后出现的并入先出现的
  const seen = new Set();
  for (const c of cats) {
    if (moves.some(([, m]) => m.category.id === c.id)) continue;
    const k = `${tdPid(c)}|${c.name}`;
    if (seen.has(k)) {
      const top = byId.get(c.parentId) ?? c;
      moves.push([top, { category: c, top: top.name, sub: tdPid(c) ? c.name : '', count: counts.get(c.id) ?? 0 }]);
    } else seen.add(k);
  }
  const groups = new Map();
  for (const [top, m] of moves) { if (!groups.has(top.id)) groups.set(top.id, { top, moves: [] }); groups.get(top.id).moves.push(m); }
  TD.plan = [...groups.values()];
  return TD.plan;
}

/** applyCategoryCleanup：先挪子分类再挪一级分类；账单跟着走，一级分类整个并走时它下面的子分类挂到新的一级分类下。 */
async function tdApplyCats(groups) {
  const cats = [...state.data.category.values()].map((c) => ({ ...c }));
  const txs = new Map([...state.data.tx.values()].map((t) => [t.id, t]));
  const changedTx = new Map(), changedCat = new Map(), deletedCat = new Set();
  let seq = 0;
  const create = (c) => { const n = { id: newId() + seq++, ...c }; cats.push(n); changedCat.set(n.id, n); return n; };
  const target = (topName, sub, exclude) => {
    const top = cats.find((c) => !tdPid(c) && !c.isIncome && c.name === topName && c.id !== exclude)
      ?? create({ name: topName, icon: iconKey(topName), isIncome: false, sortOrder: cats.length, parentId: 0 });
    if (!sub.trim()) return top.id;
    const child = cats.find((c) => tdPid(c) === top.id && c.name === sub && c.id !== exclude);
    if (child) return child.id;
    const icon = iconKey(sub);
    return create({ name: sub, icon: icon !== 'tag' ? icon : top.icon, isIncome: false, sortOrder: cats.length, parentId: top.id }).id;
  };
  for (const g of groups) {
    for (const m of [...g.moves].sort((a, b) => (tdPid(a.category) ? 0 : 1) - (tdPid(b.category) ? 0 : 1))) {
      const from = m.category.id, to = target(m.top, m.sub, from);
      for (const t of txs.values()) if (t.categoryId === from) { const n = { ...t, categoryId: to }; txs.set(t.id, n); changedTx.set(t.id, n); }
      if (!tdPid(m.category)) {
        const dest = cats.find((c) => c.id === to), newTop = tdPid(dest) || dest.id;
        for (const c of cats) if (tdPid(c) === from) { c.parentId = newTop; changedCat.set(c.id, c); }
      }
      const i = cats.findIndex((c) => c.id === from);
      if (i >= 0) cats.splice(i, 1);
      changedCat.delete(from); deletedCat.add(from);
    }
  }
  const json = (c) => ({ id: c.id, name: c.name, icon: c.icon ?? 'tag', isIncome: !!c.isIncome, sortOrder: c.sortOrder ?? 0, parentId: tdPid(c) });
  await tdWrite([
    ...[...changedCat.values()].filter((c) => !deletedCat.has(c.id)).map((c) => ({ kind: 'category', id: c.id, data: json(c), deleted: false })),
    ...[...changedTx.values()].map((t) => ({ kind: 'tx', id: t.id, data: t, deleted: false })),
    ...[...deletedCat].map((id) => ({ kind: 'category', id, data: {}, deleted: true })),
  ]);
}

// ---------------------------------------------------------------- "我的"页红点

/** 两个整理工具各有几条待处理（数据没变就用上次算好的）。 */
function tidyCounts() {
  return { transfers: tdFindFixes().length, cats: tdCatPlan().reduce((s, g) => s + g.moves.length, 0) };
}

// ---------------------------------------------------------------- 界面

const tdCheck = (on, act, v) => `<button class="td-ck${on ? ' on' : ''}" role="checkbox" aria-checked="${on}" aria-label="${tr('选择', 'Select')}" data-act="${act}" data-v="${h(v)}">${hmSvg(ICONS.check.d)}</button>`;
const tdBar = (page, title, right = '') => `<div class="subbar" data-tdp="${page}"><button class="round" data-act="tab" data-v="me" aria-label="${tr('返回', 'Back')}">‹</button><b>${title}</b>${right ? `<span class="td-acts">${right}</span>` : ''}</div>`;
/** 上一次画的就是这一页吗？不是就是刚进来，勾选回到默认（和手机端一样，离开再进来重新算）。 */
const tdEntered = (page) => !document.querySelector(`#app [data-tdp="${page}"]`);

function tdTransfersView() {
  if (tdEntered('transfers')) TD.picked.clear();
  const fixes = tdFindFixes(), ignored = tdIgnored();
  const on = (f) => TD.picked.get(f.a.id) ?? f.likely;
  const chosen = fixes.filter(on);
  const acc = state.data.account, name = (id) => acc.get(id)?.name ?? '?';
  const right = (ignored.length ? `<button class="td-tb" data-act="td-restore">${tr(`恢复已忽略 ${ignored.length}`, `Restore ${ignored.length}`)}</button>` : '')
    + `<button class="td-tb" data-act="td-rescan">${tr('重新识别', 'Scan again')}</button>`;
  const bar = tdBar('transfers', tr('整理转账', 'Tidy transfers'), right);
  if (!fixes.length) return `${bar}<p class="td-empty">${tr('未发现需要整理的账单。', 'Nothing to tidy.')}</p>`;
  const L = computeLookup();
  const all = chosen.length === fixes.length;
  const card = (f) => {
    // 转账的两头：从哪个账户到哪个账户
    const [from, to] = f.kind === TD_KIND.MERGE ? [f.a.accountId, f.b.accountId]
      : f.kind === TD_KIND.CONVERT ? (f.a.kind === KIND.EXPENSE ? [f.a.accountId, f.toAccount] : [f.toAccount, f.a.accountId])
        : f.kind === TD_KIND.DUP_TRANSFER ? [f.b.accountId, f.b.toAccountId] : [f.a.accountId, f.a.toAccountId];
    const action = {
      DUP_TRANSFER: tr('与已有转账重复，合并后仅保留转账', 'Repeats a transfer: merge and keep the transfer'),
      CONVERT: tr('实为转账，改为转账', 'Really a transfer: convert it'),
      MERGE: tr('一出一进，合并为转账', 'Out and in: merge into a transfer'),
      DUPLICATE: tr('重复录入，合并为一笔', 'Recorded twice: merge into one'),
    }[f.kind];
    const both = [f.a, f.b].filter(Boolean).map((t) => `<div class="td-date">${dayISO(t.date)}</div>${txRow(t, L)}`).join('');
    return `<div class="card td-card">
      <div class="td-r1">${tdCheck(on(f), 'td-pick', f.a.id)}${accountTile(acc.get(from), 'td-logo')}${to ? `<span class="td-arrow">→</span>${accountTile(acc.get(to), 'td-logo')}` : ''}
        <span class="td-name">${h(to ? `${name(from)} → ${name(to)}` : name(from))}</span><b class="num td-amt">${money(f.a.amountCents)}</b></div>
      <div class="td-r2"><span class="td-what">${action}</span><button class="td-ign" data-act="td-ignore" data-v="${h(f.key)}">${f.kind === TD_KIND.CONVERT ? tr('无需修改', 'Leave it') : tr('不是重复', 'Not a duplicate')}</button></div>
      <div class="td-txs">${both}</div>
    </div>`;
  };
  return `${bar}
    <div class="td-sum"><span>${tr(`共 ${fixes.length} 条，已选 ${chosen.length} 条`, `${fixes.length} found, ${chosen.length} selected`)}</span><button class="td-tb" data-act="td-all">${all ? tr('全不选', 'Select none') : tr('全选', 'Select all')}</button></div>
    <div class="grid td-list" data-tdp-list="transfers">${fixes.map(card).join('')}</div>
    <div class="td-foot"><button class="btn primary td-go" data-act="td-apply" ${chosen.length && !TD.busy ? '' : 'disabled'}>${tr(`合并所选（${chosen.length}）`, `Merge selected (${chosen.length})`)}</button></div>`;
}

function tdCatsView() {
  if (tdEntered('cats')) TD.skipped.clear();
  const groups = tdCatPlan();
  const bar = tdBar('cats', tr('整理分类', 'Tidy categories'));
  if (!groups.length) return `${bar}<p class="td-empty">${tr('分类已整齐，无需合并。', 'Categories are tidy. Nothing to merge.')}</p>`;
  const chosen = groups.filter((g) => !TD.skipped.get(g.top.id)), n = chosen.reduce((s, g) => s + g.moves.length, 0);
  const card = (g) => `<div class="card td-card">
    <div class="td-r1">${tdCheck(!TD.skipped.get(g.top.id), 'td-skip', g.top.id)}${iconTile(g.top.icon ?? 'tag', 'td-ctile')}<b class="td-cname">${h(tdCat(g.top.name))}</b></div>
    ${g.moves.map((m) => {
      const from = tdPid(m.category) ? m.category.name : tr(`「${m.category.name}」整个分类`, `All of “${m.category.name}”`);
      const to = m.top + (m.sub.trim() ? ` · ${m.sub}` : '');
      return `<div class="td-mv"><span>${h(from)}  →  ${h(to)}</span><span class="td-cnt">${tr(`${m.count} 笔`, `${m.count}`)}</span></div>`;
    }).join('')}
  </div>`;
  return `${bar}<div class="grid td-list">${groups.map(card).join('')}</div>
    <div class="td-foot"><button class="btn primary td-go" data-act="td-cats-apply" ${n && !TD.busy ? '' : 'disabled'}>${tr(`合并所选（${n} 项）`, `Merge selected (${n})`)}</button></div>`;
}

MOD.pages['tidy-transfers'] = () => tdTransfersView();
MOD.pages['tidy-cats'] = () => tdCatsView();

MOD.actions.push(async (act, v) => {
  if (!act.startsWith('td-')) return false;
  switch (act) {
    case 'td-pick': { const f = tdFindFixes().find((x) => String(x.a.id) === v); if (f) TD.picked.set(f.a.id, !(TD.picked.get(f.a.id) ?? f.likely)); break; }
    case 'td-all': {
      const fixes = tdFindFixes(), all = fixes.every((f) => TD.picked.get(f.a.id) ?? f.likely);
      for (const f of fixes) TD.picked.set(f.a.id, !all);
      break;
    }
    // 标过之后这条建议不再出现
    case 'td-ignore': store.set('hl.ignoredFixes', [...new Set([...tdIgnored(), v])]); tdReset(); break;
    case 'td-restore': store.set('hl.ignoredFixes', []); tdReset(); break;
    case 'td-rescan': {
      tdReset();
      const n = tdFindFixes().length;
      tdToast(tr(`识别完成，发现 ${n} 条`, `Scan done: ${n} found`));
      break;
    }
    case 'td-apply': case 'td-cats-apply': {
      if (TD.busy) return true;
      const transfers = act === 'td-apply';
      const list = transfers ? tdFindFixes().filter((f) => TD.picked.get(f.a.id) ?? f.likely) : tdCatPlan().filter((g) => !TD.skipped.get(g.top.id));
      if (!list.length) return true;
      TD.busy = true; render();
      try {
        if (transfers) await tdApplyFixes(list); else await tdApplyCats(list);
        tdReset();
        tdToast(transfers ? tr(`已整理 ${list.length} 条`, `${list.length} tidied`) : tr('分类已整理', 'Categories tidied'));
      } catch (e) { tdToast(e.message); }
      TD.busy = false;
      break;
    }
    case 'td-skip': { const id = Number(v); TD.skipped.set(id, !TD.skipped.get(id)); break; }
    default: return false;
  }
  render();
  return true;
});
