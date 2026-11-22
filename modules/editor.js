// 记账页和账单行，和手机端对齐：
// 1. 记一笔 / 修改（EditScreen.kt）：标题栏里切支出收入转账、大金额（能选币种、改折合金额）、一行六个分类图标、小胶囊、备注、
//    收入可以抵扣支出（补贴、退款）、支出下面列出抵扣它的补贴，自带数字键盘（能算 + −，再记 / 保存）
// 2. 账单行（TxRow.kt）：侧滑（Gestures.kt SwipeRow）左滑删除、右滑复制，拉过一半多才生效，都能撤销；账户明细里按账户的角度显示
// 3. 多选：长按一行（手指、鼠标都行，电脑上也可以右键），批量改项目、资金来源、分类、账户、报销状态，或者一起删
// app.js 的 render() 在 state.editing 不为空时画 editorView()；txRow() 也在这里。
// 撤销提示、多选操作条、删除确认画在 #app 外面的一层（#ed-layer），整页重画不影响它们。
// 关联支出 / 退款报销的面板和打分在 modules/links.js。
// 给别的页面用的：startEdit(tx)、startEditWith({ date, accountId, kind, categoryId, toAccountId, note, amount, currency, project, fund })、startOffset(expense, '补贴' | '退款' | '代付收回' | '报销')、
// txRow(t, L, showDate, viewAccount)、edToast(text, undo)。地址带 ?new 或 #new 打开时直接进记账页（主屏幕快捷方式用）。
'use strict';

const ed = { layer: null, toast: null, toastTimer: 0, bulk: null, bulkPick: null, busy: '', confirm: null };
const edReimburse = () => [tr('不报销', 'Not claimable'), tr('待报销', 'To claim'), tr('已报销', 'Reimbursed')];

const edSvg = (key, color) => `<svg class="ed-ic" viewBox="0 0 24 24"${color ? ` style="stroke:${color}"` : ''}><path d="${(ICONS[key] ?? ICONS.tag).d}"/></svg>`;
const ED_SEARCH_SVG = '<svg class="ed-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';
/** 分 → 输入框里的字：整数不带小数点。 */
const edInput = (cents) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
const edIsFormula = (s) => /\d\s*[+\-−×÷*/]\s*[\d.]/.test(s);
/** 分类名：tags.js 里有 catName() 时用它（英文界面显示英文名），否则就是存的名字。 */
const edCatName = (c) => { if (!c) return ''; if (typeof catName === 'function') { try { return catName(c) || c.name; } catch { /* 用存的名字 */ } } return c.name ?? ''; };
/** 标签的彩色小标志（tags.js 的 tagLogo）；没有就返回空串，调用的地方退回 #文字。 */
const edTagLogo = (tag, px) => { if (typeof tagLogo !== 'function') return ''; try { return tagLogo(tag, px) || ''; } catch { return ''; } };

/** 金额里可以写算式（12.5+3.2、3×4）：先乘除后加减，结果是分；不是正数就返回 null。 */
function edCalc(text) {
  const s = String(text ?? '').replace(/\s/g, '').replace(/,/g, '.').replace(/−/g, '-').replace(/×/g, '*').replace(/÷/g, '/').replace(/[+\-*/]+$/, '');
  if (!s) return null;
  if (!edIsFormula(s)) return parseCents(s);
  const nums = [], ops = [];
  let i = 0;
  while (i < s.length) {
    const start = i;
    if (s[i] === '-' && nums.length === ops.length) i++;
    while (i < s.length && /[\d.]/.test(s[i])) i++;
    const part = s.slice(start, i), n = Number(part);
    if (!part || !Number.isFinite(n)) return null;
    nums.push(n);
    if (i < s.length) { if (!'+-*/'.includes(s[i])) return null; ops.push(s[i]); i++; }
  }
  if (nums.length !== ops.length + 1) return null;
  const terms = [nums[0]], signs = [];
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k], n = nums[k + 1];
    if (o === '*') terms[terms.length - 1] *= n;
    else if (o === '/') { if (!n) return null; terms[terms.length - 1] /= n; }
    else { signs.push(o); terms.push(n); }
  }
  let v = terms[0];
  signs.forEach((o, k) => { v = o === '+' ? v + terms[k + 1] : v - terms[k + 1]; });
  const c = Math.round(Number((v * 100).toFixed(6)));
  return c > 0 ? c : null;
}

// ---------------------------------------------------------------- 币种和汇率（Fx.kt）

/** 可选的记账币种，常用的排前面（和手机端 Fx.CODES 一样）。 */
const ED_CODES = ['EUR', 'CNY', 'USD', 'GBP', 'JPY', 'HKD', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN', 'CZK', 'HUF', 'TRY', 'AUD', 'CAD', 'SGD', 'KRW', 'THB', 'MYR', 'INR', 'NZD', 'ISK', 'RON'];
const ED_SYM = { EUR: '€', CNY: '¥', USD: '$', GBP: '£', JPY: 'JP¥', HKD: 'HK$', CHF: 'CHF', AUD: 'A$', CAD: 'C$', SGD: 'S$', KRW: '₩', THB: '฿', INR: '₹', TRY: '₺', PLN: 'zł' };
const edSym = (c) => ED_SYM[c] ?? c;
/** 币种的国旗：和手机端一样的圆角矩形小旗（flags.js）。 */
const edFlag = (c) => flagSvg(c);

// 某一天的汇率表（1 EUR = ?）：今天和以后用最新的；过去的日期联网取那天的，取到的存在浏览器里；取不到先用最新的（和 Fx.ratesOn 一样）
// （app.js 比这个文件后加载，store 要用的时候再读）
const edFx = { byDay: null, asked: new Map() };
function edRatesOn(day) {
  if (day >= today()) return fx.rates;
  edFx.byDay ??= store.get('hl.ratesOn', {});
  const iso = dayISO(day);
  if (edFx.byDay[iso]) return edFx.byDay[iso];
  if (!(Date.now() - (edFx.asked.get(iso) ?? 0) < 60000)) {
    edFx.asked.set(iso, Date.now());
    fetch(`https://api.frankfurter.dev/v1/${iso}?base=EUR`).then((r) => r.json()).then((j) => {
      if (!j?.rates) return;
      edFx.byDay[iso] = j.rates;
      const keys = Object.keys(edFx.byDay);
      for (const k of keys.slice(0, Math.max(0, keys.length - 120))) delete edFx.byDay[k];
      store.set('hl.ratesOn', edFx.byDay);
      if (state.editing && dayISO(state.editing.date) === iso) edPaintAmount();
    }).catch(() => { /* 取不到就用最新的 */ });
  }
  return fx.rates;
}
/** 1 单位 from 折合多少主货币；没有汇率时 null。 */
function edRate(from, table) {
  if (from === HOME) return 1;
  const f = from === 'EUR' ? 1 : table?.[from], t = HOME === 'EUR' ? 1 : table?.[HOME];
  return f && t ? t / f : null;
}

// ---------------------------------------------------------------- 记一笔 / 修改

const edForeign = (e) => !!(e.currency && e.origCents > 0 && e.currency !== HOME);

// ---- 账户的币种和默认账户（和手机端 LedgerViewModel.accountCurrencies / takeDefaultAccount 一样）
const ED_CNY = /微信|支付宝|云闪付|财付通|余额宝|中国银行|工商银行|农业银行|建设银行|招商银行|民生银行|交通银行|中信银行|浦发|兴业银行|光大银行|平安银行|邮储|邮政储蓄|华夏银行|广发银行|wechat|alipay/i, ED_CNY_ABBR = /\b(BOC|ICBC|ABC|CCB|CMB|CMBC|BOCOM|PSBC|CNY|RMB)\b/;
/**
 * 账户实际用的币种（记账页选了账户，币种就跟着变）：账户上设了就用设的；没设的，名字是微信、支付宝、国内银行的算人民币；
 * 再不行看这个账户近一年的账单，过半（至少 3 笔）是同一种外币就用它；都没有就是主货币。
 */
function edAcctCur(a) {
  if (!a) return HOME;
  if (a.currency) return a.currency;
  // 记账时自己给这个账户选过的币种（比如中国银行选成欧元），比 AI 的判断优先
  const pin = edPins()[String(a.id)];
  if (pin) return pin;
  const ai = edProfile()?.currency?.[String(a.id)];
  if (ai) return ai;
  if ((ED_CNY.test(a.name ?? '') || ED_CNY_ABBR.test(a.name ?? '')) && HOME !== 'CNY') return 'CNY';
  const since = today() - 365, n = new Map();
  let all = 0;
  for (const t of state.data.tx.values()) {
    if (t.accountId !== a.id || t.date < since) continue;
    all++; const c = edForeign(t) ? t.currency : HOME; n.set(c, (n.get(c) ?? 0) + 1);
  }
  const [c, k] = [...n.entries()].sort((x, y) => y[1] - x[1])[0] ?? [HOME, 0];
  return c !== HOME && k >= 3 && k * 2 > all ? c : HOME;
}
// ---- AI 分析账户（和手机端 ai/AccountProfile.kt 一样）：每个账户平时用什么货币、默认用哪个账户。
// 结果存在共享设置 accountProfile 里：{ default, currency: { 账户 id: 'CNY' }, sig, at }。账户清单变了或超过 30 天，重新分析一次。
const edPins = () => { const p = shared.get('accountPins', null); return p && typeof p === 'object' ? p : {}; };
const edProfile = () => { const p = shared.get('accountProfile', null); return p && typeof p === 'object' ? p : null; };
const edSig = (accs) => [...accs].sort((a, b) => a.id - b.id).map((a) => `${a.id}:${a.name}:${a.currency ?? ''}:${!!a.archived}`).join('|') + '|' + HOME;
let edProfiling = false;
async function edRefreshProfile(force = false) {
  if (edProfiling || typeof aiKey !== 'function' || !aiKey() || !state.session) return;
  const accs = [...state.data.account.values()];
  if (!accs.some((a) => !a.archived)) return;
  const p = edProfile(), sig = edSig(accs);
  if (!force && p && p.sig === sig && Date.now() - (Number(p.at) || 0) < 30 * 86400000) return;
  edProfiling = true;
  try {
    const now = today(), year = [...state.data.tx.values()].filter((t) => t.date >= now - 365);
    const types = ACCOUNT_TYPE_NAMES();
    const lines = accs.filter((a) => !a.archived).map((a) => {
      const list = year.filter((t) => t.accountId === a.id), n = new Map();
      for (const t of list) { const c = edForeign(t) ? t.currency : HOME; n.set(c, (n.get(c) ?? 0) + 1); }
      const cur = [...n.entries()].sort((x, y) => y[1] - x[1]).map(([c, k]) => `${c}×${k}`).join(', ') || '无';
      const recent = list.filter((t) => t.date >= now - 90 && t.kind !== KIND.TRANSFER), last = Math.max(0, ...recent.map((t) => t.date));
      const notes = [...new Set(list.sort((x, y) => y.date - x.date).map((t) => stripIban(t.note).replace(/\n/g, ' ').trim().slice(0, 30)).filter(Boolean))].slice(0, 6);
      return `id=${a.id} | ${a.name} | 类型：${types[a.type] ?? ''} | 账户上设的币种：${a.currency || '没设'} | 近一年账单的币种：${cur} | 近90天记了 ${recent.length} 笔${last ? `，最近一次 ${dayISO(last)}` : ''} | 最近的备注：${notes.join('；') || '无'}`;
    }).join('\n');
    const system = `你在帮用户整理记账 App 的账户。用户的主货币是 ${HOME}。\n`
      + `1. 判断每个账户平时用什么货币记账（只能从这些代码里选：${FX_CODES.join(',')}）。依据账户名（银行、钱包、所在国家）、账户上设的币种、账单的币种和备注里的商户。`
      + '微信、支付宝和中国的银行默认是人民币，但中国的银行也可能开外币账户（比如欧元账户），账户名或账单显示是外币就按外币。用户过去可能把人民币误记成了主货币，所以主货币的账单只作参考。\n'
      + '2. 选出新记一笔时默认用的账户：主货币账户里日常花钱最常用的那个（看近90天的笔数和最近一次的日期，不选投资、借款、押金这类账户）。\n每个账户都要给出币种。只输出 JSON。';
    const schema = { type: 'object', properties: {
      accounts: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, currency: { type: 'string' } }, required: ['id', 'currency'], additionalProperties: false } },
      default_account: { type: 'integer' } }, required: ['accounts', 'default_account'], additionalProperties: false };
    const o = await aiJson(system, lines, schema, 2000);
    const ids = new Set(accs.map((a) => a.id)), currency = {};
    for (const r of o.accounts ?? []) { const c = String(r.currency ?? '').toUpperCase(); if (ids.has(Number(r.id)) && FX_CODES.includes(c)) currency[String(r.id)] = c; }
    const def = ids.has(Number(o.default_account)) ? Number(o.default_account) : 0;
    await shared.set('accountProfile', { default: def, currency, sig, at: Date.now() });
  } catch (e) { console.warn('account profile', e); }
  edProfiling = false;
}
// 打开网页几秒后（数据读完了）看一眼要不要分析
setTimeout(() => edRefreshProfile(), 8000);

/** 新记一笔默认用哪个账户：最近 90 天在这个账本里用得最多、币种是主货币的账户；最近没记过就用上次用的账户。 */
function edDefaultAccount(accs) {
  // AI 分析过就用它选的默认账户
  const ai = Number(edProfile()?.default) || 0;
  if (ai && accs.some((a) => a.id === ai)) return ai;
  const since = today() - 90, uses = new Map(), last = new Map();
  const recent = [...state.data.tx.values()].filter((t) => t.date >= since && t.kind !== KIND.TRANSFER);
  const mine = recent.filter((t) => t.ledgerId === state.ledgerId);
  for (const t of (mine.length ? mine : recent)) { uses.set(t.accountId, (uses.get(t.accountId) ?? 0) + 1); last.set(t.accountId, Math.max(last.get(t.accountId) ?? 0, t.date)); }
  const pick = accs.filter((a) => uses.get(a.id) > 0 && edAcctCur(a) === HOME)
    .sort((x, y) => uses.get(y.id) - uses.get(x.id) || (last.get(y.id) ?? 0) - (last.get(x.id) ?? 0))[0];
  const prev = store.get('hl.lastAccount', 0);
  return pick?.id ?? (accs.some((a) => a.id === prev) ? prev : accs[0]?.id ?? 0);
}
/** 金额按什么币种输入：自己选过的；新记的跟着账户走；改外币账单时是它原来的币种；其余是主货币。 */
function edCur(e) {
  if (e._curPicked && e._cur) return e._cur;
  if (e._isNew) return edAcctCur(state.data.account.get(e.accountId));
  return edForeign(e) ? e.currency : HOME;
}
/**
 * 输入的金额折成主货币。手动填过折合金额就用填的；改已有的外币账单时按它原来的汇率折（旧账不跟着今天的汇率变）；
 * 否则按账单那天的汇率算。没有汇率返回 null（这时不能保存，要手动填）。
 */
function edHomeCents(e, cents) {
  const cur = edCur(e);
  if (cents == null) return null;
  if (cur === HOME) return cents;
  if (String(e._equiv ?? '').trim()) return parseCents(e._equiv);
  if (e._keep && !e._isNew && edForeign(e) && cur === e.currency) return cents === e.origCents ? e.amountCents : Math.round(cents * e.amountCents / e.origCents);
  const r = edRate(cur, edRatesOn(e.date));
  return r ? Math.round(cents * r) : null;
}

function edAccounts(keep) {
  return [...state.data.account.values()].filter((a) => !a.archived || a.id === keep).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
}
/** 转入账户：选了的（且和转出不同），否则第一个别的账户（和手机端一样）。 */
function edTo(e) {
  const t = state.data.account.get(e.toAccountId);
  return t && t.id !== e.accountId ? t : edAccounts().find((a) => a.id !== e.accountId) ?? null;
}
/**
 * 换钱（两个账户币种不同的转账）：到账金额，按转入账户的币种。
 * 自己填过的用填的（e._recv）；否则按账单那天的汇率把转出金额折过去。不是换钱、或没有汇率时返回 null。
 */
function edRecv(e) {
  if (e.kind !== KIND.TRANSFER) return null;
  // 到账按转入账户记余额用的币种算（账户上设的币种，没设就是主货币；和 effect() 一致）
  const to = edTo(e), toCur = to ? acctCur(to) : HOME, cur = edCur(e);
  if (!to || toCur === cur) return null;
  if (String(e._recv ?? '').trim()) return { cur: toCur, cents: parseCents(e._recv), user: true };
  const cents = edCalc(e._amount), table = edRatesOn(e.date), a = edRate(cur, table), b = edRate(toCur, table);
  return { cur: toCur, cents: cents != null && a && b ? Math.round(cents * a / b) : null, user: false, rate: a && b ? a / b : null };
}
/** 分类：选中的可能是子分类；换了收支类型后原来的不适用，退回这一类的第一个。 */
function edCats(e) {
  const cats = [...state.data.category.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const isIncome = e.kind === KIND.INCOME;
  const tops = cats.filter((c) => !c.parentId && !!c.isIncome === isIncome);
  const chosen = state.data.category.get(e.categoryId), ok = chosen && !!chosen.isIncome === isIncome;
  const top = ok ? (chosen.parentId ? tops.find((c) => c.id === chosen.parentId) ?? tops[0] : chosen) : tops[0];
  const leafId = ok && chosen.parentId && top && chosen.parentId === top.id ? chosen.id : top?.id ?? 0;
  return { tops, top, leafId, subs: top ? cats.filter((c) => c.parentId === top.id) : [] };
}
function edDayName(day) {
  const t = today();
  if (day === t) return tr('今天', 'Today');
  if (day === t - 1) return tr('昨天', 'Yesterday');
  const d = dayToDate(day), y = d.getUTCFullYear(), other = y !== new Date().getFullYear();
  return tr(`${other ? y + '年' : ''}${d.getUTCMonth() + 1}月${d.getUTCDate()}日`, `${MONTH_EN[d.getUTCMonth()]} ${d.getUTCDate()}${other ? ', ' + y : ''}`);
}
const edTags = (e) => String(e.tags ?? '').split(/[\s#,，]+/).filter(Boolean);
function edKnownTags() {
  const last = new Map();
  for (const t of state.data.tx.values()) for (const x of String(t.tags ?? '').split(' ').filter(Boolean)) last.set(x, Math.max(last.get(x) ?? 0, t.date));
  return [...last.entries()].sort((a, b) => b[1] - a[1]).map(([x]) => x).slice(0, 30);
}
/** 一笔收入抵扣了哪些支出、各多少（和手机端 Tx.offsetList 一样：分摊写在 offsetParts，否则 offsetOf 指向的那笔吃掉全部）。 */
function edOffsetList(t) {
  if (t.offsetParts) return String(t.offsetParts).split(',').map((p) => p.split(':').map(Number)).filter(([id, c]) => id && c > 0);
  return t.offsetOf > 0 ? [[t.offsetOf, t.amountCents]] : [];
}

/** 记账页的状态里，手机端那些 remember 的东西（别处直接塞进来的 state.editing 也补齐）。 */
function edInit(e) {
  if (e._amount == null) e._amount = e.amountCents ? edInput(e.amountCents) : '';
  if (e._offs == null) {
    const list = e._isNew ? [] : edOffsetList(e);
    e._offs = list.map(([id, c]) => [id, e.offsetParts ? edInput(c) : '']);
    e._hadOffs = !e._isNew && list.length > 0;
  }
  if (e._equiv == null) e._equiv = '';
  if (e._keep == null) e._keep = !e._isNew && edForeign(e);
  if (e._origKind == null) e._origKind = e._isNew ? -1 : e.kind;
  // 换钱的到账金额：存过的当作自己填的（不跟着汇率变）
  if (e._recv == null) e._recv = e.toCents > 0 ? edInput(e.toCents) : '';
}

function startEdit(t, quiet = false) {
  if (t) {
    state.editing = { ...t, _amount: edInput(edForeign(t) ? t.origCents : t.amountCents), _isNew: false, _score: typeof txScore === 'function' ? txScore(t) : 0 };
  } else {
    const accs = edAccounts();
    state.editing = {
      id: newId(), kind: KIND.EXPENSE, amountCents: 0, categoryId: 0, accountId: edDefaultAccount(accs), toAccountId: 0,
      ledgerId: state.ledgerId, date: today(), note: '', tags: '', reimburse: 0, createdAt: Date.now(), currency: '', origCents: 0, excluded: false,
      offsetOf: 0, offsetParts: '', project: '', fund: '', _amount: '', _isNew: true,
    };
  }
  edInit(state.editing);
  if (!quiet) render();
  edRefreshProfile();
}

/**
 * 带着预设打开记账页：日历里某一天的"记一笔"、账户详情的"记一笔"、补贴 / 退款。
 * { date: 天数或 'YYYY-MM-DD', accountId, kind: 0/1/2 或 'expense'/'income'/'transfer', categoryId, ledgerId, offsetOf }
 */
function startEditWith(o = {}) {
  state.error = '';
  startEdit(null, true);
  const e = state.editing;
  e._preset = true;
  if (o.date != null && o.date !== '') e.date = typeof o.date === 'string' ? isoToDay(o.date) : Number(o.date);
  const cat = o.categoryId ? state.data.category.get(Number(o.categoryId)) : null;
  const kind = typeof o.kind === 'string' ? { expense: KIND.EXPENSE, income: KIND.INCOME, transfer: KIND.TRANSFER }[o.kind.toLowerCase()] ?? Number(o.kind) : o.kind;
  if (kind != null && !Number.isNaN(kind)) e.kind = Number(kind);
  else if (cat) e.kind = cat.isIncome ? KIND.INCOME : KIND.EXPENSE;
  if (cat) e.categoryId = cat.id;
  if (o.accountId && state.data.account.has(Number(o.accountId))) e.accountId = Number(o.accountId);
  if (o.ledgerId && state.data.ledger.has(Number(o.ledgerId))) e.ledgerId = Number(o.ledgerId);
  if (o.offsetOf) e._offs = [[Number(o.offsetOf), '']];
  // 信用卡还款（links.js）：转入账户、备注、金额（分，按 currency 或转出账户的币种）
  if (o.toAccountId && state.data.account.has(Number(o.toAccountId))) e.toAccountId = Number(o.toAccountId);
  if (o.note) e.note = String(o.note);
  if (o.currency) { e._cur = o.currency; e._curPicked = true; }
  if (o.amount > 0) e._amount = edInput(Math.round(o.amount));
  if (o.project) e.project = String(o.project);
  if (o.fund) e.fund = String(o.fund);
  render();
}

/**
 * 给这笔支出记一笔补贴 / 退款 / 代付收回（LedgerViewModel.startOffset）：没有这个收入分类就先建一个，
 * 然后打开记账页：收入、这个分类、同一个账户、同一天，已经连到这笔支出上。
 */
async function startOffset(expense, kindName = '补贴') {
  if (typeof expense !== 'object') expense = state.data.tx.get(Number(expense));
  if (!expense) return;
  const zh = { subsidy: '补贴', refund: '退款', paidback: '代付收回', claim: '报销', reimbursement: '报销' }[String(kindName).toLowerCase().replace(/[\s_-]/g, '')] ?? String(kindName);
  const en = DEFAULT_INCOME.find(([z]) => z === zh)?.[1];
  const cats = [...state.data.category.values()];
  let cat = cats.find((c) => !c.parentId && c.isIncome && c.name === zh) ?? (en ? cats.find((c) => !c.parentId && c.isIncome && c.name === en) : null);
  if (!cat) {
    cat = { id: newId(), name: zh, icon: zh === '报销' ? 'receipt' : iconKey(zh), isIncome: true, sortOrder: cats.length, parentId: 0 };
    try { await saveRecord('category', cat); } catch (err) { state.error = err.message; render(); return; }
  }
  // 报销：带上这笔支出的项目、资金来源（存好后支出标成已报销，见 links.js lkSyncClaims）
  const claim = zh === '报销';
  startEditWith({ kind: KIND.INCOME, categoryId: cat.id, accountId: expense.accountId, date: expense.date, ledgerId: expense.ledgerId, offsetOf: expense.id,
    project: claim ? expense.project : '', fund: claim ? expense.fund : '' });
}

/** 这笔收入每笔抵扣的金额（分）：填了的按填的，留空的拿剩下的全部（EditScreen offsetAmounts）。 */
function edOffAmounts(e, home) {
  const total = home ?? 0;
  const typed = (e._offs ?? []).filter(([id]) => state.data.tx.get(id)?.kind === KIND.EXPENSE)
    .map(([id, s]) => [id, String(s ?? '').trim() === '' ? null : parseCents(s) ?? 0]);
  const fixed = typed.reduce((s, [, c]) => s + (c ?? 0), 0);
  return typed.map(([id, c]) => [id, c ?? Math.max(0, total - fixed)]).filter(([, c]) => c > 0);
}
/** 现在能不能保存、为什么不能。 */
function edCheck(e) {
  const cents = edCalc(e._amount), cur = edCur(e), home = edHomeCents(e, cents);
  const transfer = e.kind === KIND.TRANSFER;
  const offs = e.kind === KIND.INCOME ? edOffAmounts(e, home) : [];
  const given = offs.reduce((s, [, c]) => s + c, 0);
  let why = '';
  if (cents == null) why = tr('请输入金额', 'Enter an amount');
  else if (home == null) why = tr('暂无汇率，请填写折合金额', 'No rate: enter the amount in ' + HOME);
  else if (!state.data.account.get(e.accountId)) why = tr('请选择账户', 'Choose an account');
  else if (transfer && !edTo(e)) why = tr('请选择两个不同的账户', 'Choose two different accounts');
  else if (!transfer && !edCats(e).leafId) why = tr('请选择分类', 'Choose a category');
  else if (given > home) why = tr('抵扣金额超过该笔收入', 'Offsets exceed this income');
  return { cents, cur, home, offs, given, why, ok: !why };
}

function edAmountCard(e) {
  const a = e._amount ?? '', cur = edCur(e), cents = edCalc(a), foreign = cur !== HOME;
  const cls = !a ? 'zero' : cents == null ? 'bad' : e.kind === KIND.INCOME ? 'in' : e.kind === KIND.EXPENSE ? 'out' : '';
  const home = foreign ? edHomeCents(e, cents ?? 0) : null;
  const formula = cents != null && edIsFormula(a) ? `= ${edInput(cents)}` : '';
  const equiv = !foreign ? '' : home != null ? `≈ ${money(home)}` : tr('暂无汇率，点击此处填写', 'No rate, tap to enter');
  return `<div class="ed-amount"><button class="ed-cur" data-act="ed-pick" data-v="cur" aria-label="${tr('币种', 'Currency')}">${edFlag(cur)}<span>${h(cur)}</span><i>▾</i></button>
    <div class="ed-amt-w"><div class="ed-amt num ${cls} ${a.length > 12 ? 'long' : ''}">${h(a || '0.00')}</div>${formula || equiv ? `<div class="ed-amt-sub">${formula ? `<span>${formula}</span>` : ''}${equiv ? `<button class="ed-equiv ${home == null ? 'bad' : ''}" data-act="ed-pick" data-v="equiv">${equiv}</button>` : ''}</div>` : ''}</div></div>`;
}

/** 收入：抵扣哪些支出（补贴、退款），每笔自己填金额。 */
function edOffsetCard(e, L) {
  const rows = (e._offs ?? []).map(([id, text], i) => {
    const t = state.data.tx.get(id);
    if (!t || t.kind !== KIND.EXPENSE) return '';
    const bad = String(text).trim() !== '' && parseCents(text) == null;
    return `<div class="ed-off"><div class="muted ed-offdate">${dayISO(t.date)}</div>
      <div class="ed-offrow">${txRow(t, L).replace('data-act="view"', '').replace('row click', 'row')}</div>
      <div class="ed-offline"><label class="ed-offamt ${bad ? 'bad' : ''}"><span>${h(edSym(HOME))}</span><input class="ed-offin" data-i="${i}" value="${h(text)}" inputmode="decimal" enterkeyhint="done" autocomplete="off" placeholder="${tr('留空 = 剩余全部', 'Empty = the rest')}" aria-label="${tr('抵扣金额', 'Amount')}"></label>
        <button class="btn link muted" data-act="ed-off-rm" data-v="${i}">${tr('移除', 'Remove')}</button></div></div>`;
  }).join('');
  // "选择"打开面板：智能推荐 + 搜索全部（links.js）；有推荐时按钮上带个数
  const n = typeof lkSuggest === 'function' ? lkSuggest(lkFromEditing(e), 'exp', new Set((e._offs ?? []).map(([id]) => id))).length : 0;
  return `<div class="ed-box ed-offs"><div class="muted small">${tr('关联支出', 'Linked expenses')}</div>${rows}
    <div class="small ed-offsum">${edOffSum(e)}</div>
    <button class="btn link ed-offadd" data-act="ed-pick" data-v="offset">${(e._offs ?? []).length ? tr('＋ 再添加一笔支出', '＋ Another expense') : tr('选择一笔支出', 'Choose an expense')}${n ? `<span class="lk-n">${n}</span>` : ''}</button></div>`;
}
/** 记账页里这笔收入是"报销"（关联的支出不抵扣，只标已报销）。 */
const edIsClaim = (e) => e.kind === KIND.INCOME && edCats(e).top?.name === '报销';
function edOffSum(e) {
  if (!(e._offs ?? []).length) return '';
  const { home, given } = edCheck(e);
  if (home == null) return '';
  if (edIsClaim(e)) return `<span class="${given > home ? 'ed-err' : 'muted'}">${tr(`已关联 ${money(given)}`, `${money(given)} linked`)}</span>`;
  return `<span class="${given > home ? 'ed-err' : 'muted'}">${tr(`已抵扣 ${money(given)}，剩余 ${money(Math.max(0, home - given))} 计入收入`, `${money(given)} offset, ${money(Math.max(0, home - given))} left as income`)}</span>`;
}

/** 支出：退款 · 报销 · 代付收回（已关联的、选择、新建），画法在 links.js 的 lkExpenseBox。 */
function edLinkedCard(e, L) {
  const orig = state.data.tx.get(e.id);
  if (!orig || orig.kind !== KIND.EXPENSE || typeof lkExpenseBox !== 'function') return '';
  return lkExpenseBox(orig, L, true);
}

function editorView() {
  const e = state.editing;
  edInit(e);
  const acc = state.data.account, transfer = e.kind === KIND.TRANSFER;
  const { tops, top, leafId, subs } = edCats(e);
  const from = acc.get(e.accountId), to = edTo(e), tags = edTags(e);
  const accChip = (a, which) => `<button class="chip lead" data-act="ed-pick" data-v="${which}">${a ? accountTile(a) : ''}<span>${h(a?.name ?? tr('选择账户', 'Choose account'))}</span></button>`;
  const head = transfer
    ? `<div class="ed-box ed-move"><div class="muted small">${tr('从 → 到', 'From → To')}</div><div class="ed-chips">${accChip(from, 'acc')}${edSvg('forward')}${accChip(to, 'to')}</div>${edAccounts().length < 2 ? `<div class="err">${tr('需至少两个账户', 'Needs two accounts')}</div>` : ''}${edRecvLine(e)}</div>`
    : `<div class="ed-box">${tops.length ? `<div class="ed-cats">${tops.map((c) => `<button class="ed-cat ${c.id === top?.id ? 'on' : ''}" data-act="ed-cat" data-v="${c.id}">${iconTile(c.icon ?? 'tag')}<span>${h(edCatName(c))}</span></button>`).join('')}</div>` : `<div class="muted small">${tr('暂无分类', 'No categories yet')}</div>`}
      ${subs.length ? `<div class="ed-subs">${subs.map((s) => `<button class="ed-sub ${s.id === leafId ? 'on' : ''}" data-act="ed-sub" data-v="${s.id}">${edSvg(s.icon ?? 'tag', s.id === leafId ? '' : (ICONS[s.icon] ?? ICONS.tag).c)}${h(edCatName(s))}</button>`).join('')}</div>` : ''}</div>`;
  // 可报销的支出、报销收入才问项目和资金来源（已经填了的照样显示）
  const pf = !transfer && (e.kind === KIND.EXPENSE && e.reimburse || e.kind === KIND.INCOME && top?.name === '报销' || e.project || e.fund);
  const tagLabel = tags.length ? tags.map((x) => { const logo = edTagLogo(x, 18); return logo ? `<span class="ed-tagin">${logo}${h(x)}</span>` : '#' + h(x); }).join(' ') : tr('标签', 'Tags');
  const chips = [
    transfer ? '' : accChip(from, 'acc'),
    `<label class="chip ed-datechip">${edSvg('calendar')}<span>${edDayName(e.date)}</span><input type="date" id="e-date" value="${dayISO(e.date)}" aria-label="${tr('日期', 'Date')}"></label>`,
    `<button class="chip ${tags.length ? 'on' : ''}" data-act="ed-pick" data-v="tags">${edSvg('tag')}<span>${tagLabel}</span></button>`,
    // 支出心情：五颗带表情的行星（modules/mood.js）
    e.kind === KIND.EXPENSE && typeof moodPlanet === 'function' ? `<button class="chip ${e._score ? 'on' : ''}" data-act="ed-pick" data-v="mood">${e._score ? moodPlanet(e._score, 20) : edSvg('heart')}<span>${e._score ? tr('心情 · ', 'Mood · ') + moodText(e._score) : tr('心情', 'Mood')}</span></button>` : '',
    e.kind === KIND.EXPENSE ? `<button class="chip ${e.reimburse ? 'on' : ''}" data-act="ed-pick" data-v="reimburse">${edSvg('receipt')}<span>${edReimburse()[e.reimburse ?? 0]}</span></button>` : '',
    pf ? `<button class="chip ${e.project ? 'on' : ''}" data-act="ed-pick" data-v="project">${edSvg('target')}<span>${e.project ? tr('项目 · ', 'Project · ') + h(e.project) : tr('项目', 'Project')}</span></button>` : '',
    pf ? `<button class="chip ${e.fund ? 'on' : ''}" data-act="ed-pick" data-v="fund">${edSvg('coins')}<span>${e.fund ? tr('资金 · ', 'Funding · ') + h(e.fund) : tr('资金来源', 'Funding')}</span></button>` : '',
    transfer ? '' : `<button class="chip ${e.excluded ? 'on' : ''}" data-act="ed-pick" data-v="excluded"><span>${e.excluded ? tr('不计入收支', 'Not counted') : tr('计入收支', 'Counted')}</span></button>`,
    e._isNew ? '' : `<button class="chip danger" data-act="delete"><span>${tr('删除', 'Delete')}</span></button>`,
  ].filter(Boolean).join('');
  const L = e.kind === KIND.INCOME || (!e._isNew && e._origKind === KIND.EXPENSE && e.kind === KIND.EXPENSE) ? computeLookup() : null;
  const extra = e.kind === KIND.INCOME ? edOffsetCard(e, L) : L ? edLinkedCard(e, L) : '';
  const valid = edCheck(e).ok;
  const key = (k) => k === 'SAVE' ? `<button class="ed-key save ${valid ? '' : 'dim'}" data-act="save">${tr('保存', 'Save')}</button>`
    : k === 'AGAIN' ? `<button class="ed-key op txt" data-act="ed-again">${tr('再记', 'Next')}</button>`
    : k === 'C' ? `<button class="ed-key op txt" data-act="ed-key" data-v="C">${tr('清空', 'Clear')}</button>`
    : `<button class="ed-key ${'⌫+−'.includes(k) ? 'op' : ''}" data-act="ed-key" data-v="${k}" ${k === '⌫' ? `aria-label="${tr('退格', 'Backspace')}"` : ''}>${k}</button>`;
  const keys = ['1', '2', '3', '⌫', '4', '5', '6', '+', '7', '8', '9', '−', e._isNew ? 'AGAIN' : 'C', '0', '.', 'SAVE'];
  const heading = e._isNew ? tr('记一笔', 'New') : tr('修改', 'Edit');
  return `<div class="modal ed-modal" data-act="close-backdrop"><div class="card ed-sheet" role="dialog" aria-label="${heading}">
    <div class="ed-head"><button class="ed-x" data-act="close" aria-label="${tr('关闭', 'Close')}">✕</button><b>${heading}</b>${seg('e-kind', [[0, tr('支出', 'Out')], [1, tr('收入', 'In')], [2, tr('转账', 'Move')]], e.kind)}</div>
    ${edImportStrip(e)}${edAmountCard(e)}
    <div class="ed-scroll">
      ${head}
      <div class="ed-chips">${chips}</div>
      <label class="ed-note">${edSvg('pencil')}<textarea id="e-note" rows="${Math.min(4, String(e.note ?? '').split('\n').length)}" placeholder="${tr('备注', 'Note')}">${h(e.note)}</textarea></label>
      ${extra}
      ${state.error ? `<p class="err" style="margin:0">${h(state.error)}</p>` : ''}
    </div>
    <div class="ed-keys">${keys.map(key).join('')}</div>
    ${edPop(e)}
  </div></div>`;
}

/** 换钱时转账框里的一行：到账多少（点开可以改成实际到账的金额）。 */
function edRecvLine(e) {
  const r = edRecv(e);
  if (!r) return '';
  const amt = r.cents != null ? money(r.cents, r.cur) : tr('暂无汇率', 'No rate');
  return `<button class="ed-recv ${r.cents == null ? 'bad' : ''}" data-act="ed-pick" data-v="recv"><span class="muted">${tr('到账', 'Received')}</span><b class="num">${amt}</b><span class="muted small">${r.user ? tr('已修改', 'Edited') : tr('按汇率', 'By rate')}</span>${edSvg('pencil')}</button>`;
}

/** 选项多的面板（账户、币种、抵扣哪笔支出）：一条搜索框，下面的列表随打字筛选。 */
function edPopList(e) {
  const p = e._pick, q = String(e._q ?? '').trim().toLowerCase();
  const opt = (k, v, label, on, lead = '') => `<button class="ed-opt ${on ? 'on' : ''}" data-act="ed-set" data-k="${k}" data-v="${h(v)}">${lead}<span>${label}</span>${on ? edSvg('check') : ''}</button>`;
  const none = `<div class="muted small ed-none">${tr('无匹配结果', 'No match')}</div>`;
  if (p === 'acc' || p === 'to') {
    const k = p === 'to' ? 'toAccountId' : 'accountId', sel = p === 'to' ? edTo(e)?.id : e.accountId;
    const list = edAccounts(sel).filter((a) => (p !== 'to' || a.id !== e.accountId) && (!q || a.name.toLowerCase().includes(q)));
    return list.map((a) => opt(k, a.id, `${h(a.name)}${edAcctCur(a) !== HOME ? ` <small class="muted">${h(edAcctCur(a))}</small>` : ''}`, a.id === sel, accountTile(a))).join('') || none;
  }
  if (p === 'cur') {
    const cur = edCur(e), codes = ED_CODES.includes(cur) ? ED_CODES : [cur, ...ED_CODES];
    const list = codes.filter((c) => !q || `${c}  ${edSym(c)}`.toLowerCase().includes(q));
    return list.map((c) => opt('cur', c, `${c}　<span class="muted">${h(edSym(c))}</span>`, c === cur, `<span class="ed-flag">${edFlag(c)}</span>`)).join('') || none;
  }
  // 关联支出 / 关联收入：智能推荐 + 搜索全部（links.js）
  if ((p === 'offset' || p === 'links') && typeof lkEditorSheet === 'function') return lkEditorSheet(e);
  return '';
}

/** 点了某个小胶囊后弹出来的选择面板（盖在记账页下半截）。 */
function edPop(e) {
  const p = e._pick;
  if (!p) return '';
  const opt = (k, v, label, on, lead = '') => `<button class="ed-opt ${on ? 'on' : ''}" data-act="ed-set" data-k="${k}" data-v="${h(v)}">${lead}<span>${label}</span>${on ? edSvg('check') : ''}</button>`;
  let title = '', body = '', search = false, cls = '';
  if (p === 'acc' || p === 'to') {
    const sel = p === 'to' ? edTo(e)?.id : e.accountId;
    title = p === 'to' ? tr('转入账户', 'To account') : e.kind === KIND.TRANSFER ? tr('转出账户', 'From account') : tr('账户', 'Account');
    // 账户多（几十个）时改成能搜索的列表（和手机端 ChipPicker 一样，超过 8 个）
    search = edAccounts(sel).filter((a) => p !== 'to' || a.id !== e.accountId).length > 8;
    body = edPopList(e);
  } else if (p === 'cur') {
    title = tr('币种', 'Currency'); search = true; body = edPopList(e);
  } else if (p === 'offset' || p === 'links') {
    // 推荐在上、搜索框在中间、结果在下面（搜索框不放标题栏）
    title = p === 'offset' ? tr('关联支出', 'Linked expenses') : tr('退款 · 报销 · 代付收回', 'Refund · claim · paid back'); cls = 'tall lk-pop'; body = edPopList(e);
  } else if (p === 'equiv') {
    // 折合主货币：留空就按账单那天的汇率算；没有汇率时必须自己填
    const cents = edCalc(e._amount), cur = edCur(e), r = edRate(cur, edRatesOn(e.date));
    const auto = cents != null && r ? Math.round(cents * r) : null;
    const now = String(e._equiv ?? '').trim() ? e._equiv : e._keep ? edInput(edHomeCents(e, cents ?? e.origCents) ?? 0) : '';
    title = tr(`折合 ${HOME}`, `In ${HOME}`);
    body = `<label class="ed-eqfield"><span>${h(edSym(HOME))}</span><input id="ed-equiv" value="${h(now)}" data-was="${h(now)}" inputmode="decimal" enterkeyhint="done" autocomplete="off" placeholder="${auto != null ? edInput(auto) : tr('暂无汇率，请手动填写', 'No rate available, enter it yourself')}"></label>
      <div class="muted small">${r ? `1 ${h(cur)} = ${r.toFixed(4)} ${HOME} · ${dayISO(e.date)}` : tr('暂无汇率，请手动填写', 'No rate available, enter it yourself')}</div>
      <div class="ed-eqbtns"><button class="btn" data-act="ed-eq-reset">${tr('按汇率计算', 'Use the rate')}</button><button class="btn primary" data-act="ed-eq-ok">${tr('好', 'OK')}</button></div>`;
  } else if (p === 'recv') {
    // 换钱的到账金额：默认按汇率折算，实际到账不一样时改成实际的
    const r = edRecv({ ...e, _recv: '' }) ?? { cur: HOME, cents: null }, now = String(e._recv ?? '').trim();
    title = tr(`到账金额（${r.cur}）`, `Received (${r.cur})`);
    body = `<label class="ed-eqfield"><span>${h(edSym(r.cur))}</span><input id="ed-recv" value="${h(now)}" inputmode="decimal" enterkeyhint="done" autocomplete="off" placeholder="${r.cents != null ? edInput(r.cents) : tr('暂无汇率，请手动填写', 'No rate available, enter it yourself')}"></label>
      <div class="muted small">${r.rate ? `1 ${h(edCur(e))} = ${r.rate.toFixed(4)} ${h(r.cur)} · ${dayISO(e.date)}` : tr('暂无汇率，请手动填写', 'No rate available, enter it yourself')}</div>
      <div class="ed-eqbtns"><button class="btn" data-act="ed-recv-reset">${tr('按汇率计算', 'Use the rate')}</button><button class="btn primary" data-act="ed-recv-ok">${tr('好', 'OK')}</button></div>`;
  } else if (p === 'mood') {
    title = tr('这笔花得值吗？', 'Worth it?');
    body = `<div class="mood-ed">${moodRater(e._score || 0, 'ed')}</div>` + (moodPercent() ? `<button class="btn primary mood-ok" data-act="ed-pick-x">${tr('完成', 'Done')}</button>` : '') + opt('_score', 0, tr('不打分', 'No rating'), !e._score);
  } else if (p === 'reimburse') {
    title = tr('报销', 'Reimburse'); body = edReimburse().map((n, i) => opt('reimburse', i, n, (e.reimburse ?? 0) === i)).join('');
  } else if (p === 'excluded') {
    title = tr('收支统计', 'In totals'); body = opt('excluded', 0, tr('计入收支', 'Counted'), !e.excluded) + opt('excluded', 1, tr('不计入收支（借还款、代付等）', 'Not counted (loans, paid for others…)'), !!e.excluded);
  } else if (p === 'project' || p === 'fund') {
    title = p === 'project' ? tr('报销项目', 'Project') : tr('资金来源', 'Funding');
    body = opt(p, '', tr('（不填）', '(None)'), !e[p]) + (p === 'project' ? projectNames() : fundNames()).map((n) => opt(p, n, h(n), e[p] === n)).join('')
      + `<div class="ed-new"><input id="ed-newname" placeholder="${tr('新建', 'New')}" enterkeyhint="done" autocomplete="off"><button class="btn" data-act="ed-newname" data-v="${p}">${tr('添加', 'Add')}</button></div>`;
  } else if (p === 'tags') {
    const on = edTags(e), all = [...on.filter((x) => !edKnownTags().includes(x)), ...edKnownTags()];
    title = tr('标签', 'Tags');
    body = `<div class="ed-chips">${all.map((x) => { const logo = edTagLogo(x, 24); return `<button class="chip ed-tagpick ${logo ? 'ed-tagchip' : ''} ${on.includes(x) ? 'on' : ''}" data-act="ed-tag" data-v="${h(x)}">${logo}<span>${logo ? '' : '#'}${h(x)}</span></button>`; }).join('') || `<span class="muted small">${tr('暂无标签', 'No tags yet')}</span>`}</div>
      <div class="ed-new"><input id="ed-newtag" placeholder="${tr('新标签', 'New tag')}" enterkeyhint="done" autocomplete="off"><button class="btn primary" data-act="ed-tags-done">${tr('好', 'Done')}</button></div>`;
  }
  const top = search
    ? `<div class="ed-pophead"><label class="ed-search">${ED_SEARCH_SVG}<input id="ed-q" value="${h(e._q ?? '')}" placeholder="${p === 'offset' ? tr('搜索分类或备注，如 医保、房租', 'Search category or note') : tr('搜索', 'Search')}" autocomplete="off" enterkeyhint="search" aria-label="${h(title)}"></label><button class="ed-x" data-act="ed-pick-x" aria-label="${tr('关闭', 'Close')}">✕</button></div>`
    : `<div class="between"><b>${title}</b><button class="ed-x" data-act="ed-pick-x" aria-label="${tr('关闭', 'Close')}">✕</button></div>`;
  return `<div class="ed-pop ${cls}${search ? ' search' : ''}" data-act="ed-pick-close"><div class="ed-popcard" data-act="noop">${top}<div class="ed-opts">${body}</div></div></div>`;
}

/** 以前的表单要先把输入框里的字收回来；现在只剩备注是输入框（边打边存），留着这个名字给别处调用。 */
function collect() {
  const n = document.getElementById('e-note');
  if (n && state.editing) state.editing.note = n.value;
}

/** 整个页面重画，但记账页里滚到哪儿还停在哪儿。 */
function edRefresh() {
  const top = document.querySelector('.ed-scroll')?.scrollTop ?? 0;
  render();
  const s = document.querySelector('.ed-scroll');
  if (s) s.scrollTop = top;
}

/**
 * 新记一笔时顶上的一行导入按钮（和手机端一样）：截图、文件、拍照三个小胶囊，选好就关掉记账页、去导入页让 AI 识别。
 * 一开始输金额就收起来。还没填 AI 密钥时点哪个都先去导入页，那里会提示去填密钥。
 */
function edImportStrip(e) {
  if (!e._isNew || e._preset) return '';
  // 点了直接打开选图 / 选文件 / 相机；选好进 AI 识别的进度页（没填密钥时那里会提示）
  const btn = (kind, icon, label, accept, extra = '') => `<label class="ed-imp-b">${hmSvg(ICONS[icon].d)}<span>${label}</span><input type="file" data-edimp="${kind}" accept="${accept}" ${extra} hidden></label>`;
  const files = typeof IMP_FILE_ACCEPT === 'string' ? IMP_FILE_ACCEPT : '.pdf,.csv,.xlsx,.xls,.txt,.zip';
  return `<div class="ed-imp${e._amount ? ' gone' : ''}"><div><span class="ed-imp-h">${hmSvg(ICONS.sparkle.d)}${tr('AI 识别', 'AI import')}</span>
    ${btn('pick', 'phone', tr('截图', 'Screenshot'), 'image/*', 'multiple')}${btn('files', 'document', tr('文件', 'File'), files, 'multiple')}${btn('camera', 'camera', tr('拍照', 'Photo'), 'image/*', 'capture="environment"')}</div></div>`;
}
/** 去导入页：关掉记账页（没保存的这笔不要了），切到导入页。 */
function edGoImport() { state.editing = null; state.error = ''; state.tab = 'import'; scrollTo(0, 0); render(); }
MOD.changes.push(async (ev) => {
  const k = ev.target.dataset?.edimp;
  if (!k) return false;
  const files = [...(ev.target.files ?? [])];
  ev.target.value = '';
  if (!files.length) return true;
  edGoImport();
  if (typeof impStart === 'function') await impStart(k === 'pick' ? files.slice(0, 10) : files);
  return true;
});
MOD.actions.push(async (act) => {
  if (act !== 'ed-imp-key') return false;
  edGoImport();
  return true;
});

/** 只重画金额卡片、抵扣合计和保存键（打字时不整页重画，输入框的光标不会丢）。 */
function edPaintAmount() {
  const e = state.editing;
  if (!e) return;
  const box = document.querySelector('.ed-amount');
  if (!box) return render();
  box.outerHTML = edAmountCard(e);
  document.querySelector('.ed-imp')?.classList.toggle('gone', !!e._amount);
  const sum = document.querySelector('.ed-offsum');
  if (sum) sum.innerHTML = edOffSum(e);
  document.querySelector('.ed-key.save')?.classList.toggle('dim', !edCheck(e).ok);
}

/** 自带数字键盘按下一个键（规则和手机端一样：最多两位小数，开头的 0 会被替换）。 */
function edPress(k) {
  const e = state.editing;
  if (!e) return;
  let a = e._amount ?? '';
  const last = a.split(/[+−×÷]/).pop();
  if (k === '⌫') a = a.slice(0, -1);
  else if (k === 'C') a = '';
  else if ('+−×÷'.includes(k)) a = a ? a.replace(/[+−×÷]+$/, '') + k : a;
  else if (k === '.') { if (!last.includes('.') && a.length <= 20) a += last ? '.' : '0.'; }
  else if (a.length <= 20 && !(last.includes('.') && last.length - last.indexOf('.') > 2)) a = last === '0' ? a.slice(0, -1) + k : a + k;
  e._amount = a;
  edPaintAmount();
}

function edKind(k) {
  const e = state.editing;
  if (!e) return;
  e.kind = k; e._pick = null; state.error = '';
  edRefresh();
}

/** 保存。again：存完留在记账页接着记下一笔（类型、分类、账户、日期不变，金额、备注、抵扣清空）。 */
async function saveEditing(again = false) {
  const e = state.editing;
  if (!e) return;
  collect();
  edInit(e);
  const c = edCheck(e);
  if (!c.ok) {
    state.error = c.why;
    // 没有汇率：直接打开折合金额让人填（不再悄悄按 1:1 存）
    if (c.cents != null && c.home == null) e._pick = 'equiv';
    return edRefresh();
  }
  const transfer = e.kind === KIND.TRANSFER, to = transfer ? edTo(e) : null;
  const t = {};
  for (const [k, v] of Object.entries(e)) if (!k.startsWith('_')) t[k] = v;
  const foreign = c.cur !== HOME;
  t.amountCents = c.home;
  t.currency = foreign ? c.cur : '';
  t.origCents = foreign ? c.cents : 0;
  if (transfer) { t.toAccountId = to.id; t.categoryId = 0; t.project = ''; t.fund = ''; }
  else { t.toAccountId = 0; t.categoryId = edCats(e).leafId; }
  // 换钱：记下实际到账多少（转入账户的币种）；到账的就是主货币时，折合主货币的金额也用它
  const recv = edRecv(e);
  if (recv?.cents > 0) { t.toCents = recv.cents; if (recv.cur === HOME) t.amountCents = recv.cents; } else delete t.toCents;
  t.excluded = !!e.excluded && !transfer;
  if (t.kind !== KIND.EXPENSE) t.reimburse = 0;
  // 抵扣（和手机端 build() 一样）：只抵扣一笔而且是全额时用 offsetOf；分摊时逐笔记在 offsetParts；
  // 原来有抵扣、现在全去掉了：offsetOf 记成 -1（"不抵扣"），免得自动关联又连回去
  const offs = c.offs;
  t.offsetOf = t.kind !== KIND.INCOME ? 0 : offs.length ? offs[0][0] : e._hadOffs ? -1 : e._isNew ? 0 : (e.offsetOf ?? 0);
  t.offsetParts = t.kind !== KIND.INCOME || !offs.length || (offs.length === 1 && offs[0][1] === c.home) ? '' : offs.map(([id, x]) => `${id}:${x}`).join(',');
  t.note = String(t.note ?? '').trim();
  t.tags = edTags(e).join(' ');
  if (typeof moodPut === 'function') moodPut(t, t.kind === KIND.EXPENSE ? Number(e._score) || 0 : 0);
  // 新记的一笔存好了：屏幕上沿划过一颗小流星（modules/cosmos.js）
  const star = () => { if (e._isNew && typeof plShootingStar === 'function') plShootingStar(); };
  try {
    const before = state.data.tx.get(t.id) ?? null;
    await saveRecord('tx', t);
    // 报销收入：新关联的支出标成已报销，不再关联的改回待报销（links.js）
    if (typeof lkSyncClaims === 'function') await lkSyncClaims(before, t);
    store.set('hl.lastAccount', t.accountId);
    // 自己选过币种：把这个账户记成这种货币，下次选它就默认这个币种（和手机同步）
    if (e._curUser) {
      const cur = edCur(e), acc = state.data.account.get(t.accountId);
      if (acc && cur !== edAcctCur(acc)) await shared.set('accountPins', { ...edPins(), [String(acc.id)]: cur }).catch(() => {});
    }
    if (t.project) rememberName('hl.projects', t.project);
    if (t.fund) rememberName('hl.funds', t.fund);
    state.error = '';
    if (again && e._isNew) {
      state.editing = { ...e, id: newId(), createdAt: Date.now(), _amount: '', note: '', _pick: null, _equiv: '', _offs: [], _q: '' };
      render();
      edToast(tr('已保存，可继续记下一笔', 'Saved. Next one.'));
      star();
      return;
    }
    state.editing = null;
    render();
    star();
    return;
  } catch (err) { state.error = err.message; }
  render();
}

/** 记账页里的"删除"：直接删，底部给几秒撤销。 */
async function edDeleteEditing() {
  const e = state.editing, t = e && state.data.tx.get(e.id);
  state.editing = null; state.error = '';
  if (t) await edRemove(t); else render();
}

// ---------------------------------------------------------------- 账单行（TxRow.kt）

/**
 * 一行账单。viewAccount：站在哪个账户的角度看（账户详情页，传账户或它的 id）：
 * 转账写成"来自 X / 转到 Y"并带正负号，金额按这个账户的币种，不显示付款账户小签，也不显示抵扣后的净额。
 */
function txRow(t, L, showDate = false, viewAccount = null) {
  const cat = state.data.category, acc = state.data.account;
  const view = viewAccount == null || viewAccount === false ? null : typeof viewAccount === 'object' ? viewAccount : acc.get(Number(viewAccount)) ?? null;
  const pid = view?.id ?? 0;
  const leaf = cat.get(t.categoryId), top = L.top(t.categoryId), from = acc.get(t.accountId), to = acc.get(t.toAccountId);
  const transfer = t.kind === KIND.TRANSFER;
  const incoming = !!pid && transfer && t.toAccountId === pid, outgoing = !!pid && transfer && t.accountId === pid;
  const title = incoming ? tr(`来自 ${h(from?.name ?? '?')}`, `From ${h(from?.name ?? '?')}`)
    : outgoing ? tr(`转到 ${h(to?.name ?? '?')}`, `To ${h(to?.name ?? '?')}`)
    : transfer ? `${h(from?.name ?? '?')} → ${h(to?.name ?? '?')}`
    : !leaf ? tr('未分类', 'Uncategorized') : leaf.parentId ? `${h(edCatName(top))} · ${h(edCatName(leaf))}` : h(edCatName(leaf));
  // 在账户明细里看的是这笔钱实际进出了多少，不显示抵扣后的净额
  const offset = !view && t.kind === KIND.EXPENSE ? L.offsets.get(t.id) ?? 0 : 0;
  const foreign = edForeign(t);
  const vcur = view ? acctCur(view) : HOME, inAcc = !!view && vcur !== HOME && !foreign;
  const net = L.net(t);
  const over = offset > 0 && net < 0;
  const sign = over || t.kind === KIND.INCOME || incoming ? '+' : t.kind === KIND.EXPENSE || outgoing ? '-' : '';
  const amount = offset > 0 && !foreign && !inAcc ? money(Math.abs(net)) : incoming && t.toCents > 0 ? money(t.toCents, vcur) : foreign ? money(t.origCents, t.currency) : inAcc ? money(Math.abs(effect(view, t)), vcur) : money(t.amountCents);
  const cls = over || t.kind === KIND.INCOME || incoming ? 'in' : t.kind === KIND.EXPENSE || outgoing ? 'out' : '';
  const tagHtml = (t.tags ? String(t.tags).split(' ').filter(Boolean) : []).map((x) => { const logo = edTagLogo(x, 14); return logo ? `<span class="ed-rtag">${logo}${h(x)}</span>` : '#' + h(x); });
  const details = [...[showDate ? dayISO(t.date) : '', t.loanPerson, t.note].filter(Boolean).map(h), ...tagHtml].join('  ');
  // 付款账户做成带小标志的彩色小签，放在备注前面；账户明细里不重复
  const face = !transfer && !view && from ? accountFace(from) : null;
  const payer = face ? `<span class="payer" style="--pc:${face}">${accountTile(from, 'mini')}${h(from.name)}</span>` : '';
  const targets = L.parts(t), linked = targets.length ? state.data.tx.get(targets[0][0]) : null;
  const linkedName = targets.length > 1 ? tr(`${targets.length} 笔支出`, `${targets.length} expenses`) : linked ? edCatName(cat.get(linked.categoryId)) || linked.note || '' : '';
  const extra = [
    offset > 0 ? tr(`原 ${money(t.amountCents)} · 抵 ${money(offset)}`, `${money(t.amountCents)} − ${money(offset)}`) : '',
    linked ? (L.claim?.(t) ? tr(`关联 ${h(linkedName)}`, `For ${h(linkedName)}`) : tr(`抵扣 ${h(linkedName)}`, `Offsets ${h(linkedName)}`)) : '',
    (foreign || inAcc) && !(incoming && t.toCents > 0) ? `≈ ${money(t.amountCents)}` : '',
  ].filter(Boolean).map((x) => `<div class="small muted ed-rx">${x}</div>`).join('');
  // 多选时前面多一个勾；"row click" 和 data-act="view" 这两段别处（txRowStatic）会替换，不要改写法
  return `<div class="row click ed-tx${state.sel?.has(t.id) ? ' sel-on' : ''}" data-act="view" data-v="${t.id}">
    <span class="ed-check" aria-hidden="true"></span>
    ${transfer ? accountTile(incoming ? from : to) : iconTile(leaf?.icon ?? 'tag')}
    <div class="main"><div class="title">${title}${t.kind === KIND.EXPENSE && typeof moodBadge === 'function' ? moodBadge(txScore(t)) : ''}${t.excluded ? `<span class="badge gray">${tr('不计', 'Not counted')}</span>` : ''}${t.reimburse === 1 ? `<span class="badge">${tr('待报销', 'To claim')}</span>` : t.reimburse === 2 ? `<span class="badge gray">${tr('已报销', 'Reimbursed')}</span>` : ''}</div>
      ${details || payer ? `<div class="sub">${payer}${details}</div>` : ''}</div>
    <div class="right"><div class="num ${cls}">${sign}${amount}</div>${extra}</div>
  </div>`;
}

/** 删一笔，底部给几秒撤销（撤销 = 原样存回去）。 */
async function edRemove(t) {
  try { await deleteRecord('tx', t.id); } catch (e) { state.error = e.message; render(); return; }
  if (state.view === t.id) state.view = null;
  render();
  edToast(tr('已删除', 'Deleted'), async () => { await saveRecord('tx', t); });
}
/** 复制一笔到今天（抵扣关系不带，报销回到"待报销"），可撤销。 */
async function edCopy(t) {
  const copy = { ...t, id: newId(), date: today(), createdAt: Date.now(), offsetOf: 0, offsetParts: '', reimburse: t.reimburse ? 1 : 0 };
  try { await saveRecord('tx', copy); } catch (e) { state.error = e.message; render(); return; }
  render();
  edToast(tr('已复制至今天', 'Copied to today'), async () => { await deleteRecord('tx', copy.id); });
}

// ---------------------------------------------------------------- #app 外面的一层：撤销提示、多选操作条、删除确认

function edLayerEl() {
  if (!ed.layer) {
    ed.layer = document.createElement('div');
    ed.layer.id = 'ed-layer';
    ed.layer.innerHTML = '<div class="ed-ui"></div><div class="ed-toastbox"></div>';
    document.body.appendChild(ed.layer);
    ed.layer.addEventListener('click', edLayerClick);
    ed.layer.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.id === 'ed-bnew') { ev.preventDefault(); ed.layer.querySelector('[data-ed="bnew"]')?.click(); } });
  }
  return ed.layer;
}
function edPaintLayer() {
  document.body.classList.toggle('ed-selecting', !!state.sel);
  edLayerEl().querySelector('.ed-ui').innerHTML = (state.sel ? edSelBar() : '') + (ed.bulkPick ? edBulkPop() : '') + (ed.merge && state.sel ? edMergeView() : '') + (ed.confirm ? edConfirmView() : '');
}
function edPaintToast() {
  const t = ed.toast;
  // 和手机端一样：深色条，"撤销"是浅蓝字；有底栏时浮在底栏上面，没有底栏的页面贴着底边
  const nav = !!document.querySelector('#app .bottom-nav');
  edLayerEl().querySelector('.ed-toastbox').innerHTML = t
    ? `<div class="ed-toast ${state.editing ? 'top' : nav ? '' : 'nonav'}" role="status">${typeof plNowPlanet === 'function' ? plNowPlanet(22, 0, 'ed-toast-pl') : ''}<span>${h(t.text)}</span>${t.undo ? `<button data-ed="undo">${tr('撤销', 'Undo')}</button>` : ''}</div>` : '';
}
/** 底部提示；带 undo 的 4 秒后消失（和手机端一样），只是告知的 2 秒。 */
function edToast(text, undo = null) {
  clearTimeout(ed.toastTimer);
  ed.toast = { text, undo };
  edPaintToast();
  ed.toastTimer = setTimeout(() => { ed.toast = null; edPaintToast(); }, undo ? 4000 : 2000);
}

/** 侧滑删除 / 复制都要先确认：标题、日期、这一笔本身、会发生什么。 */
function edConfirmView() {
  const t = ed.confirm, L = computeLookup(), copy = ed.confirmCopy;
  const d = dayToDate(t.date);
  return `<div class="modal ed-lmodal" data-ed="cf-no-bg"><div class="card ed-bcard ed-confirm" data-ed="noop">
    <b style="font-size:17px">${copy ? tr('确认复制此笔账目？', 'Copy this entry?') : tr('确认删除此笔账目？', 'Delete this entry?')}</b>
    <div class="small muted">${tr(`${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEK[d.getUTCDay()]}`, `${WEEK[d.getUTCDay()]}, ${MONTH_EN[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`)}</div>
    <div class="ed-cfrow">${txRow(t, L).replace('data-act="view"', '').replace('row click', 'row')}</div>
    <div class="small" style="color:${copy ? '#5B8DEF' : 'var(--expense)'}">${copy ? tr('将复制一笔至今天', 'A copy will be added today') : tr('删除后可在底部撤销', 'You can undo after deleting')}</div>
    <div class="ed-selbtns"><button class="btn" data-ed="cf-no">${tr('取消', 'Cancel')}</button><button class="btn ${copy ? 'primary' : 'ed-redbtn'}" data-ed="cf-yes">${copy ? tr('复制', 'Copy') : tr('删除', 'Delete')}</button></div>
  </div></div>`;
}

// ---- 多选

/** 页面上现在看得见的账单行（详情弹窗里的不算）。 */
const edVisibleIds = () => [...new Set([...document.querySelectorAll('#app .row.click.ed-tx')].filter((r) => !r.closest('.modal, .dt')).map((r) => Number(r.dataset.v)))];
function edPaintRows() {
  for (const r of document.querySelectorAll('#app .row.click.ed-tx')) r.classList.toggle('sel-on', !!state.sel?.has(Number(r.dataset.v)));
}
function edSelect(set) {
  state.sel = set; ed.bulk = { project: null, fund: null, categoryId: null, reimburse: null, accountId: null }; ed.bulkPick = null;
  edPaintLayer(); edPaintRows();
}
function edExitSelect() { state.sel = null; ed.bulk = null; ed.bulkPick = null; ed.merge = null; ed.busy = ''; edPaintLayer(); edPaintRows(); }
function edToggleSel(id) {
  if (state.sel.has(id)) state.sel.delete(id); else state.sel.add(id);
  edPaintRows(); edPaintLayer();
}

/** 每一笔改完是什么样；没变的不列。null 表示这一项不改，空串表示清空。 */
function edBulkPlan() {
  const b = ed.bulk, cat = b.categoryId != null ? state.data.category.get(b.categoryId) : null, out = [];
  for (const id of state.sel) {
    const t = state.data.tx.get(id);
    if (!t) continue;
    const n = { ...t };
    if (t.kind !== KIND.TRANSFER) {
      if (b.project != null) n.project = b.project;
      if (b.fund != null) n.fund = b.fund;
      if (cat && !!cat.isIncome === (t.kind === KIND.INCOME)) n.categoryId = cat.id;
    }
    if (b.reimburse != null && t.kind === KIND.EXPENSE) n.reimburse = b.reimburse;
    // 账户：支出、收入改记账账户；转账改转出账户（不能和转入的同一个）
    if (b.accountId != null && (t.kind !== KIND.TRANSFER || t.toAccountId !== b.accountId)) n.accountId = b.accountId;
    if (['project', 'fund', 'categoryId', 'reimburse', 'accountId'].some((k) => String(n[k] ?? '') !== String(t[k] ?? ''))) out.push({ old: t, now: n });
  }
  return out;
}

function edSelBar() {
  const n = state.sel.size, b = ed.bulk, vis = edVisibleIds();
  const all = vis.length > 0 && vis.every((id) => state.sel.has(id));
  const lab = (name, val) => (val == null ? name : `${name} · ${val === '' ? tr('清空', 'Cleared') : h(val)}`);
  const cat = b.categoryId != null ? state.data.category.get(b.categoryId) : null;
  const plan = edBulkPlan().length;
  return `<div class="ed-selbar">
    <div class="ed-selhead"><button class="ed-x" data-ed="exit" aria-label="${tr('退出多选', 'Exit selection')}">✕</button><b>${tr(`已选 ${n} 笔`, `${n} selected`)}</b><button class="btn link" data-ed="all">${all ? tr('全不选', 'Select none') : tr('全选', 'Select all')}</button></div>
    <div class="ed-chips">
      <button class="chip ${b.project != null ? 'on' : ''}" data-ed="pick" data-v="project">${edSvg('target')}${lab(tr('项目', 'Project'), b.project)}</button>
      <button class="chip ${b.fund != null ? 'on' : ''}" data-ed="pick" data-v="fund">${edSvg('coins')}${lab(tr('资金来源', 'Funding'), b.fund)}</button>
      <button class="chip ${cat ? 'on' : ''}" data-ed="pick" data-v="categoryId">${edSvg('layers')}${cat ? tr('分类 · ', 'Category · ') + h(edCatName(cat)) : tr('分类', 'Category')}</button>
      <button class="chip ${b.accountId != null ? 'on' : ''}" data-ed="pick" data-v="accountId">${edSvg('wallet')}${b.accountId != null ? tr('账户 · ', 'Account · ') + h(state.data.account.get(b.accountId)?.name ?? '') : tr('账户', 'Account')}</button>
      <button class="chip ${b.reimburse != null ? 'on' : ''}" data-ed="pick" data-v="reimburse">${edSvg('receipt')}${b.reimburse != null ? tr('报销 · ', 'Reimburse · ') + edReimburse()[b.reimburse] : tr('报销', 'Reimburse')}</button>
    </div>
    <div class="ed-selbtns three"><button class="btn danger" data-ed="del" ${n && !ed.busy ? '' : 'disabled'}>${tr('删除', 'Delete')}</button>
      <button class="btn" data-ed="merge" ${n >= 2 && !ed.busy ? '' : 'disabled'}>${tr('合并', 'Merge')}</button>
      <button class="btn primary" data-ed="apply" ${plan && !ed.busy ? '' : 'disabled'}>${ed.busy || (plan ? tr(`应用 ${plan} 笔`, `Apply to ${plan}`) : tr('应用多笔', 'Apply'))}</button></div>
  </div>`;
}

function edBulkPop() {
  const p = ed.bulkPick, b = ed.bulk;
  const opt = (v, label, on, lead = '') => `<button class="ed-opt ${on ? 'on' : ''}" data-ed="bset" data-k="${p}" ${v == null ? 'data-none="1"' : `data-v="${h(v)}"`}>${lead}<span>${label}</span>${on ? edSvg('check') : ''}</button>`;
  let title = '', body = opt(null, tr('（不修改）', '(Keep)'), b[p] == null);
  if (p === 'project' || p === 'fund') {
    title = p === 'project' ? tr('报销项目', 'Project') : tr('资金来源', 'Funding');
    body += opt('', tr('（清空）', '(Clear)'), b[p] === '') + (p === 'project' ? projectNames() : fundNames()).map((n) => opt(n, h(n), b[p] === n)).join('')
      + `<div class="ed-new"><input id="ed-bnew" placeholder="${tr('新建', 'New')}" enterkeyhint="done" autocomplete="off"><button class="btn" data-ed="bnew" data-v="${p}">${tr('添加', 'Add')}</button></div>`;
  } else if (p === 'reimburse') {
    title = tr('报销', 'Reimburse');
    body += edReimburse().map((n, i) => opt(i, n, b.reimburse === i)).join('');
  } else if (p === 'accountId') {
    title = tr('账户', 'Account');
    body += edAccounts().map((a) => opt(a.id, h(a.name), b.accountId === a.id, accountTile(a, 'sm'))).join('');
  } else if (p === 'categoryId') {
    title = tr('分类', 'Category');
    const cats = [...state.data.category.values()].sort((x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0) || x.id - y.id);
    for (const [inc, name] of [[false, tr('支出', 'Expense')], [true, tr('收入', 'Income')]]) {
      body += `<div class="muted small ed-grp">${name}</div>`;
      for (const top of cats.filter((c) => !c.parentId && !!c.isIncome === inc)) {
        body += opt(top.id, h(edCatName(top)), b.categoryId === top.id, iconTile(top.icon ?? 'tag', 'sm'));
        for (const s of cats.filter((c) => c.parentId === top.id)) body += `<div class="ed-indent">${opt(s.id, h(edCatName(s)), b.categoryId === s.id, iconTile(s.icon ?? top.icon ?? 'tag', 'sm'))}</div>`;
      }
    }
  }
  return `<div class="modal ed-lmodal" data-ed="pop-close"><div class="card ed-bcard" data-ed="noop"><div class="between"><b>${title}</b><button class="ed-x" data-ed="pop-x" aria-label="${tr('关闭', 'Close')}">✕</button></div><div class="ed-opts">${body}</div></div></div>`;
}

async function edBulkApply() {
  const plan = edBulkPlan(), b = ed.bulk;
  if (!plan.length || ed.busy) return;
  for (let i = 0; i < plan.length; i++) {
    ed.busy = tr(`保存中 ${i + 1}/${plan.length}`, `Saving ${i + 1}/${plan.length}`); edPaintLayer();
    try { await saveRecord('tx', plan[i].now); } catch (e) { ed.busy = ''; edPaintLayer(); render(); edToast(tr('未能全部保存：', 'Not all saved: ') + e.message); return; }
  }
  if (b.project) rememberName('hl.projects', b.project);
  if (b.fund) rememberName('hl.funds', b.fund);
  edExitSelect(); render();
  edToast(tr(`已修改 ${plan.length} 笔`, `Updated ${plan.length}`), async () => { for (const p of plan) await saveRecord('tx', p.old); });
}

async function edBulkDelete() {
  const list = [...state.sel].map((id) => state.data.tx.get(id)).filter(Boolean);
  if (!list.length || ed.busy) return;
  if (!await uiConfirm(tr(`删除 ${list.length} 笔？`, `Delete ${list.length} ${list.length === 1 ? 'entry' : 'entries'}?`), { ok: tr('删除', 'Delete'), danger: true, detail: tr('可撤销', 'You can undo') })) return;
  for (let i = 0; i < list.length; i++) {
    ed.busy = tr(`删除中 ${i + 1}/${list.length}`, `Deleting ${i + 1}/${list.length}`); edPaintLayer();
    try { await deleteRecord('tx', list[i].id); } catch (e) { ed.busy = ''; edPaintLayer(); render(); edToast(tr('未能全部删除：', 'Not all deleted: ') + e.message); return; }
  }
  edExitSelect(); render();
  edToast(tr(`已删除 ${list.length} 笔`, `Deleted ${list.length}`), async () => { for (const t of list) await saveRecord('tx', t); });
}

// ---- 合并：选中的几笔其实是同一笔（比如手动记过，银行账单又导入一次）。选一笔为准，其余删掉；备注可取并集。

/** 默认以哪一笔为准：转账优先，其次有分类（不是"其他"）的，再其次备注长的。 */
function edMergeDefault(list) {
  const score = (t) => {
    const c = state.data.category.get(t.categoryId);
    return (t.kind === KIND.TRANSFER ? 4 : 0) + (c && !/^(其他|Other)$/i.test(c.name) ? 2 : 0) + Math.min((t.note ?? '').trim().length, 60) / 100;
  };
  return [...list].sort((a, b) => score(b) - score(a) || a.createdAt - b.createdAt)[0];
}
/** 备注并集：以为准那笔的在前，相同或被包含的只留一份。 */
function edMergeNote(base, list) {
  const out = [];
  for (const t of [base, ...list.filter((x) => x.id !== base.id)]) {
    const n = String(t.note ?? '').trim();
    if (!n || out.some((o) => o.includes(n))) continue;
    for (let i = out.length - 1; i >= 0; i--) if (n.includes(out[i])) out.splice(i, 1);
    out.push(n);
  }
  return out.join('；');
}
function edMergeOpen() {
  const list = [...state.sel].map((id) => state.data.tx.get(id)).filter(Boolean);
  if (list.length < 2) return;
  ed.merge = { ids: list.map((t) => t.id), base: edMergeDefault(list).id, notes: true };
}
function edMergeView() {
  const m = ed.merge, L = computeLookup();
  const list = m.ids.map((id) => state.data.tx.get(id)).filter(Boolean);
  const base = list.find((t) => t.id === m.base) ?? list[0];
  const diff = new Set(list.map((t) => t.amountCents)).size > 1;
  const notes = new Set(list.map((t) => String(t.note ?? '').trim()).filter(Boolean)).size > 1;
  const merged = notes && m.notes ? edMergeNote(base, list) : String(base?.note ?? '').trim();
  const rows = list.map((t) => `<div class="ed-mg ${t.id === base.id ? 'on' : ''}" role="radio" aria-checked="${t.id === base.id}" tabindex="0" data-ed="mg-base" data-v="${t.id}">
      <span class="ed-mg-r"></span><div class="ed-cfrow">${txRow(t, L).replace('data-act="view"', '').replace('row click', 'row')}</div></div>`).join('');
  return `<div class="modal ed-lmodal" data-ed="mg-bg"><div class="card ed-bcard ed-merge" data-ed="noop">
    <b style="font-size:17px">${tr('合并为一笔', 'Merge into one')}</b>
    <div class="small muted">${tr('请选择以哪一笔为准', 'Keep the details of')}</div>
    <div class="ed-mgs" role="radiogroup">${rows}</div>
    ${diff ? `<div class="small" style="color:var(--amber)">${tr('金额不一致，以所选一笔为准', 'Amounts differ; the chosen one is kept')}</div>` : ''}
    ${notes ? `<label class="ed-mg-note" data-ed="mg-notes"><input type="checkbox" ${m.notes ? 'checked' : ''} tabindex="-1"><span>${tr('合并备注', 'Combine notes')}</span></label>` : ''}
    ${merged ? `<div class="small muted ed-mg-prev">${tr('备注：', 'Note: ')}${h(merged)}</div>` : ''}
    <div class="ed-selbtns"><button class="btn" data-ed="mg-no">${tr('取消', 'Cancel')}</button><button class="btn primary" data-ed="mg-yes" ${ed.busy ? 'disabled' : ''}>${ed.busy || tr(`合并 ${list.length} 笔`, `Merge ${list.length}`)}</button></div>
  </div></div>`;
}
async function edMergeApply() {
  const m = ed.merge;
  if (!m || ed.busy) return;
  const list = m.ids.map((id) => state.data.tx.get(id)).filter(Boolean);
  const base = list.find((t) => t.id === m.base);
  if (!base || list.length < 2) { ed.merge = null; edPaintLayer(); return; }
  const rest = list.filter((t) => t.id !== base.id), gone = new Set(rest.map((t) => t.id));
  const now = { ...base };
  if (m.notes) now.note = edMergeNote(base, list);
  // 标签也取并集（以为准那笔的在前）
  now.tags = [...new Set([base, ...rest].flatMap((t) => String(t.tags ?? '').split(' ').filter(Boolean)))].join(' ');
  // 别的收入抵扣了被合并掉的那几笔支出：改为抵扣留下的这笔
  const relinks = [];
  if (base.kind === KIND.EXPENSE) {
    for (const t of state.data.tx.values()) {
      if (gone.has(t.id) || t.id === base.id) continue;
      const n = { ...t };
      if (gone.has(t.offsetOf)) n.offsetOf = base.id;
      if (t.offsetParts) {
        // 分摊里两笔都在时，合到一起
        const parts = new Map();
        for (const p of t.offsetParts.split(',')) { const [id, c] = p.split(':').map(Number); const k = gone.has(id) ? base.id : id; parts.set(k, (parts.get(k) ?? 0) + (c || 0)); }
        n.offsetParts = [...parts].map(([id, c]) => `${id}:${c}`).join(',');
      }
      if (n.offsetOf !== t.offsetOf || n.offsetParts !== t.offsetParts) relinks.push({ old: t, now: n });
    }
  }
  ed.busy = tr('合并中…', 'Merging…'); edPaintLayer();
  try {
    await saveRecord('tx', now);
    for (const r of relinks) await saveRecord('tx', r.now);
    for (const t of rest) await deleteRecord('tx', t.id);
  } catch (e) { ed.busy = ''; edPaintLayer(); render(); edToast(tr('未能合并：', 'Merge failed: ') + e.message); return; }
  if (gone.has(state.view)) state.view = null;
  ed.merge = null;
  edExitSelect(); render();
  edToast(tr(`已合并为一笔`, 'Merged into one'), async () => {
    await saveRecord('tx', base);
    for (const r of relinks) await saveRecord('tx', r.old);
    for (const t of rest) await saveRecord('tx', t);
  });
}

async function edLayerClick(ev) {
  const el = ev.target.closest('[data-ed]');
  if (!el) return;
  const a = el.dataset.ed, v = el.dataset.v;
  switch (a) {
    case 'noop': return;
    case 'undo': {
      const u = ed.toast?.undo;
      clearTimeout(ed.toastTimer); ed.toast = null; edPaintToast();
      if (u) { try { await u(); } catch (e) { state.error = e.message; } render(); }
      return;
    }
    case 'exit': edExitSelect(); return;
    case 'all': {
      const vis = edVisibleIds(), all = vis.length > 0 && vis.every((id) => state.sel.has(id));
      for (const id of vis) { if (all) state.sel.delete(id); else state.sel.add(id); }
      edPaintRows(); break;
    }
    case 'pick': ed.bulkPick = v; break;
    case 'pop-close': if (ev.target !== el) return; ed.bulkPick = null; break;
    case 'pop-x': ed.bulkPick = null; break;
    case 'bset': { const k = el.dataset.k; ed.bulk[k] = el.dataset.none ? null : k === 'categoryId' || k === 'reimburse' || k === 'accountId' ? Number(v) : v; ed.bulkPick = null; break; }
    case 'bnew': { const name = ed.layer.querySelector('#ed-bnew')?.value.trim(); if (!name) return; ed.bulk[v] = name; ed.bulkPick = null; break; }
    case 'apply': edBulkApply(); return;
    case 'del': edBulkDelete(); return;
    case 'merge': edMergeOpen(); break;
    case 'mg-base': if (ed.busy) return; ed.merge.base = Number(v); break;
    case 'mg-notes': ev.preventDefault(); ed.merge.notes = !ed.merge.notes; break;
    case 'mg-bg': if (ev.target !== el || ed.busy) return; ed.merge = null; break;
    case 'mg-no': if (ed.busy) return; ed.merge = null; break;
    case 'mg-yes': edMergeApply(); return;
    case 'cf-no-bg': if (ev.target !== el) return; ed.confirm = null; break;
    case 'cf-no': ed.confirm = null; break;
    case 'cf-yes': { const t = ed.confirm, copy = ed.confirmCopy; ed.confirm = null; edPaintLayer(); if (t) await (copy ? edCopy(t) : edRemove(t)); return; }
    default: return;
  }
  edPaintLayer();
}

// ---------------------------------------------------------------- 侧滑和长按（侧滑只管手指；长按手指、鼠标都管）
// 左滑删除、右滑复制。前 64px 跟手，之后像橡皮筋（只走 0.32 倍）；手指拉过行宽 55% 才"上膛"，
// 没上膛松手就弹回去什么都不做。上膛松手：复制直接做，删除先确认；两种都能撤销。

const sw = { row: null, x0: 0, y0: 0, dx: 0, mode: '', armed: false, lp: 0, swallow: 0, strip: null };
const SW_FOLLOW = 64, SW_RUBBER = 0.32, SW_ARM = 0.55;
function swRowAt(target) {
  const r = target?.closest?.('.row.click.ed-tx');
  // 弹窗里、账单详情页里的那几行只能点开看，不能滑、不能多选（和 App 一样）
  return r && r.closest('#app') && !r.closest('.modal, .dt') ? r : null;
}
const swOffset = (d) => Math.sign(d) * (Math.abs(d) <= SW_FOLLOW ? Math.abs(d) : SW_FOLLOW + (Math.abs(d) - SW_FOLLOW) * SW_RUBBER);
function swPaint(row, d) {
  const x = swOffset(d), left = d < 0, armed = Math.abs(d) >= row.offsetWidth * SW_ARM;
  row.style.transition = 'none';
  row.style.transform = `translateX(${x}px)`;
  let s = sw.strip;
  if (!s || s.parentElement !== row) {
    s = sw.strip = document.createElement('div');
    s.className = 'ed-swstrip';
    s.innerHTML = '<span></span>';
    row.appendChild(s);
    (row.closest('.card') ?? row.parentElement)?.classList.add('ed-clip');
  }
  s.className = `ed-swstrip ${left ? 'del' : 'copy'}${armed ? ' armed' : ''}`;
  s.style.width = Math.abs(x) + 'px';
  s.querySelector('span').textContent = armed ? (left ? tr('松手删除', 'Release to delete') : tr('松手复制', 'Release to copy')) : tr('继续拉', 'Keep pulling');
  sw.armed = armed;
}
function swRelease(row) {
  row.style.transition = 'transform .45s cubic-bezier(.34, 1.56, .64, 1)';
  row.style.transform = '';
  const strip = sw.strip, box = row.closest('.card') ?? row.parentElement;
  sw.strip = null;
  if (strip) { strip.style.transition = 'width .45s cubic-bezier(.34, 1.56, .64, 1), opacity .3s'; strip.style.width = '0px'; strip.style.opacity = '0'; }
  setTimeout(() => { strip?.remove(); if (!sw.strip) box?.classList.remove('ed-clip'); if (row.isConnected) row.style.transition = ''; }, 460);
}

document.addEventListener('touchstart', (ev) => {
  if (ev.touches.length !== 1 || state.editing) { sw.row = null; return; }
  const row = swRowAt(ev.target);
  sw.row = row;
  if (!row) return;
  const t = ev.touches[0];
  sw.x0 = t.clientX; sw.y0 = t.clientY; sw.dx = 0; sw.mode = ''; sw.armed = false;
  clearTimeout(sw.lp);
  // 长按进多选（已经在多选里就是勾上 / 取消）
  sw.lp = setTimeout(() => {
    if (sw.row !== row || sw.mode) return;
    sw.mode = 'lp'; sw.swallow = Date.now() + 900;
    try { navigator.vibrate?.(12); } catch { /* 不支持震动（iPhone）就算了 */ }
    const id = Number(row.dataset.v);
    if (!state.sel) edSelect(new Set([id])); else edToggleSel(id);
  }, 500);
}, { passive: true });

document.addEventListener('touchmove', (ev) => {
  const row = sw.row;
  if (!row || sw.mode === 'v' || sw.mode === 'lp') return;
  const t = ev.touches[0], dx = t.clientX - sw.x0, dy = t.clientY - sw.y0;
  if (!sw.mode) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    clearTimeout(sw.lp);
    // 横向走得明显比竖向多才算侧滑，否则交给页面滚动
    sw.mode = !state.sel && Math.abs(dx) >= 14 && Math.abs(dx) > Math.abs(dy) * 1.6 ? 'h' : Math.abs(dy) >= 10 ? 'v' : '';
    if (sw.mode !== 'h') return;
    sw.x0 = t.clientX - Math.sign(dx) * 2;
  }
  ev.preventDefault();
  sw.dx = t.clientX - sw.x0;
  swPaint(row, sw.dx);
}, { passive: false });

function swEnd() {
  clearTimeout(sw.lp);
  const row = sw.row, mode = sw.mode, armed = sw.armed, d = sw.dx;
  sw.row = null; sw.mode = ''; sw.armed = false;
  if (!row || mode !== 'h') return;
  sw.swallow = Date.now() + 450;
  swRelease(row);
  if (!armed) return;
  const t = state.data.tx.get(Number(row.dataset.v));
  if (!t) return;
  // 删除和复制都要再确认一次，弹窗里把这一笔原样给你看
  ed.confirm = t; ed.confirmCopy = d > 0; edPaintLayer();
}
document.addEventListener('touchend', swEnd);
document.addEventListener('touchcancel', swEnd);
document.addEventListener('contextmenu', (ev) => { if (sw.mode === 'lp' || (sw.row && swRowAt(ev.target))) ev.preventDefault(); });

// 鼠标：按住一行半秒也进多选（按着时挪动了就不算）；右键一行 = 勾上 / 取消
{
  let t = 0, x = 0, y = 0;
  document.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType !== 'mouse') return;
    if (sw.swallow === Infinity) sw.swallow = 0;
    if (ev.button !== 0 || state.editing) return;
    const row = swRowAt(ev.target);
    if (!row) return;
    x = ev.clientX; y = ev.clientY;
    clearTimeout(t);
    t = setTimeout(() => {
      t = 0;
      if (!row.isConnected) return;
      sw.swallow = Infinity; // 松开鼠标后的那一下点击不算（下一次按下时作废）
      const id = Number(row.dataset.v);
      if (!state.sel) edSelect(new Set([id])); else edToggleSel(id);
    }, 500);
  });
  document.addEventListener('pointermove', (ev) => { if (t && ev.pointerType === 'mouse' && Math.hypot(ev.clientX - x, ev.clientY - y) > 6) { clearTimeout(t); t = 0; } });
  for (const n of ['pointerup', 'pointercancel']) document.addEventListener(n, (ev) => { if (ev.pointerType === 'mouse') { clearTimeout(t); t = 0; } });
  document.addEventListener('contextmenu', (ev) => {
    if (sw.row || state.editing || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const row = swRowAt(ev.target);
    if (!row) return;
    ev.preventDefault();
    const id = Number(row.dataset.v);
    if (!state.sel) edSelect(new Set([id])); else edToggleSel(id);
  });
}

// 侧滑、长按之后跟着来的那一下点击不算；多选时点一行 = 勾上 / 取消
document.addEventListener('click', (ev) => {
  if (Date.now() < sw.swallow && swRowAt(ev.target)) { ev.stopPropagation(); ev.preventDefault(); sw.swallow = 0; return; }
  if (state.sel && !state.editing) {
    const row = swRowAt(ev.target);
    if (row) { ev.stopPropagation(); ev.preventDefault(); edToggleSel(Number(row.dataset.v)); }
  }
}, true);

// ---------------------------------------------------------------- 记账页里的输入

document.addEventListener('input', (ev) => {
  const e = state.editing, el = ev.target;
  if (!e) return;
  if (el.id === 'e-note') {
    e.note = el.value;
    el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px';
  } else if (el.id === 'ed-q') {
    // 搜索框：只换下面的列表，输入框不动（拼音选字时也不打断）
    e._q = el.value;
    // 关联面板：只换搜索结果那一块（推荐和搜索框不动）
    const res = el.closest('.ed-popcard')?.querySelector('.lk-res');
    if (res && typeof lkResults === 'function') {
      const side = e._pick === 'offset' ? 'exp' : 'inc';
      res.innerHTML = lkResults({ side, subj: lkFromEditing(e), picked: side === 'exp' ? new Set((e._offs ?? []).map(([id]) => id)) : lkLinkedIncomes(e.id), q: e._q, act: side === 'exp' ? 'ed-off-add' : 'ed-lk-add' });
      return;
    }
    const box = el.closest('.ed-popcard')?.querySelector('.ed-opts');
    if (box) box.innerHTML = edPopList(e);
  } else if (el.classList.contains('ed-offin')) {
    const i = Number(el.dataset.i);
    if (e._offs?.[i]) e._offs[i][1] = el.value;
    el.closest('.ed-offamt')?.classList.toggle('bad', el.value.trim() !== '' && parseCents(el.value) == null);
    edPaintAmount();
  } else if (el.id === 'ed-equiv' || el.id === 'ed-recv') {
    el.closest('.ed-eqfield')?.classList.toggle('bad', el.value.trim() !== '' && parseCents(el.value) == null);
  }
});
// 打备注、填抵扣金额时收起自带键盘，让系统键盘上来（和手机端一样）
const edTyping = (el) => el.id === 'e-note' || el.classList?.contains('ed-offin');
document.addEventListener('focusin', (ev) => { if (edTyping(ev.target)) ev.target.closest('.ed-sheet')?.classList.add('typing'); });
document.addEventListener('focusout', (ev) => { if (edTyping(ev.target)) setTimeout(() => { if (!edTyping(document.activeElement ?? {})) document.querySelector('.ed-sheet')?.classList.remove('typing'); }, 120); });
// 电脑上点日期胶囊直接弹出日历
document.addEventListener('click', (ev) => { if (ev.target.id === 'e-date') { try { ev.target.showPicker(); } catch { /* 不支持就用浏览器自己的 */ } } });
// 电脑上也能直接用键盘打金额：回车保存，Esc 关掉
document.addEventListener('keydown', (ev) => {
  const e = state.editing;
  if (!e || ev.isComposing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === 'Enter' && ['ed-newname', 'ed-newtag', 'ed-equiv', 'ed-recv'].includes(ev.target.id)) {
    ev.preventDefault(); document.querySelector({ 'ed-newname': '[data-act="ed-newname"]', 'ed-newtag': '[data-act="ed-tags-done"]', 'ed-equiv': '[data-act="ed-eq-ok"]', 'ed-recv': '[data-act="ed-recv-ok"]' }[ev.target.id])?.click(); return;
  }
  if (ev.key === 'Enter' && (ev.target.id === 'ed-q' || ev.target.classList.contains('ed-offin'))) { ev.preventDefault(); ev.target.blur(); return; }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName)) return;
  const k = /^[0-9]$/.test(ev.key) ? ev.key : ev.key === '.' || ev.key === ',' ? '.' : ev.key === '+' ? '+' : ev.key === '-' ? '−'
    : ev.key === '*' ? '×' : ev.key === '/' ? '÷' : ev.key === 'Backspace' ? '⌫' : null;
  if (k) { ev.preventDefault(); edPress(k); }
  else if (ev.key === 'Enter') { ev.preventDefault(); saveEditing(); }
  else if (ev.key === 'Escape') { if (e._pick) e._pick = null; else { state.editing = null; state.error = ''; } edRefresh(); }
});
// 长按退格 = 清空
{
  let t = 0;
  document.addEventListener('pointerdown', (ev) => {
    const b = ev.target.closest?.('.ed-key[data-v="⌫"]');
    if (!b) return;
    clearTimeout(t);
    t = setTimeout(() => { edPress('C'); sw.swallowKey = Date.now() + 600; }, 550);
  });
  for (const n of ['pointerup', 'pointercancel', 'pointerleave']) document.addEventListener(n, () => clearTimeout(t));
}

// ---------------------------------------------------------------- 登记


MOD.changes.push(async (ev) => {
  if (ev.target.id !== 'e-date' || !state.editing) return false;
  if (ev.target.value) state.editing.date = isoToDay(ev.target.value);
  // 不整页重画：iPhone 上日期面板还开着，只改胶囊上的字
  const label = ev.target.parentElement?.querySelector('span');
  if (label) label.textContent = edDayName(state.editing.date);
  edPaintAmount(); // 外币按新日期的汇率折
  return true;
});

/** 抵扣列表里加一笔支出（EditScreen 选支出的那段逻辑）。 */
function edAddOffset(e, id) {
  const t = state.data.tx.get(id);
  if (!t || e._offs.some(([x]) => x === id)) return;
  const { home } = edCheck(e), total = home ?? 0, claim = edIsClaim(e);
  const given = edOffAmounts(e, home).reduce((s, [, c]) => s + c, 0);
  // 默认给它"还没被盖住的部分"（不算这笔收入自己存过的那份；报销和退款补贴分开算，links.js lkOpen），不超过这笔收入还没分出去的钱
  const want = Math.max(0, lkOpen(t, claim, e.id));
  if (e._offs.length === 1 && String(e._offs[0][1]).trim() === '') {
    // 第二笔加进来时，把第一笔的"留空"固定成它当时的金额，两笔才分得开
    const first = state.data.tx.get(e._offs[0][0]);
    const firstGive = Math.min(total, first ? Math.max(0, lkOpen(first, claim, e.id)) : 0);
    e._offs[0][1] = edInput(firstGive);
    e._offs.push([id, edInput(Math.max(0, Math.min(total - firstGive, want)))]);
  } else e._offs.push([id, e._offs.length ? edInput(Math.max(0, Math.min(total - given, want))) : '']);
}

// 地址带 ?new 或 #new 打开（主屏幕快捷方式）：数据读好后直接进记账页
const ED_OPEN_NEW = (() => {
  try {
    const q = new URLSearchParams(location.search), hash = /^#new(&|$)/.test(location.hash);
    if (!q.has('new') && !hash) return false;
    q.delete('new');
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + (hash ? '' : location.hash));
    return true;
  } catch { return false; }
})();
if (ED_OPEN_NEW) {
  let tries = 0;
  const tick = () => {
    if (typeof state !== 'undefined' && state.session && !state.loading && state.data.account.size && state.data.category.size) { if (!state.editing) { state.error = ''; startEdit(null); } return; }
    if (tries++ < 1200) setTimeout(tick, 250);
  };
  addEventListener('load', () => setTimeout(tick, 0));
}

MOD.actions.push(async (act, v, el) => {
  if (act === 'ed-sel-start') { edSelect(new Set()); return true; }
  if (!act.startsWith('ed-')) return false;
  const e = state.editing;
  if (!e) return true;
  switch (act) {
    case 'ed-key': if (v === '⌫' && Date.now() < (sw.swallowKey ?? 0)) return true; edPress(v); return true;
    case 'ed-again': await saveEditing(true); return true;
    case 'ed-cat': e.categoryId = Number(v); break;
    case 'ed-sub': { const { top, leafId } = edCats(e); e.categoryId = leafId === Number(v) ? top.id : Number(v); break; }
    case 'ed-pick': e._pick = v; e._q = ''; break;
    case 'ed-pick-close': e._pick = null; break; // 面板里面的点击会先碰到 data-act="noop"，到这里的只有背景
    case 'ed-pick-x': e._pick = null; break;
    case 'ed-set': {
      const k = el.dataset.k;
      if (k === 'cur') {
        // 自己选的币种：折合金额回到按汇率算
        e._cur = v; e._curPicked = true; e._curUser = true; e._equiv = ''; e._keep = false;
      } else {
        e[k] = k === 'excluded' ? v === '1' : k === 'project' || k === 'fund' ? v : Number(v);
        // 新记的一笔换了账户：币种跟着新账户走
        if (k === 'accountId') e._curUser = false;
        // 换了转出或转入账户：到账金额重新按汇率算
        if (k === 'accountId' || k === 'toAccountId') e._recv = '';
        if (k === 'accountId' && e._isNew) { e._curPicked = false; e._equiv = ''; }
      }
      e._pick = null; break;
    }
    case 'ed-eq-ok': {
      const inp = document.getElementById('ed-equiv'), val = inp?.value.trim() ?? '';
      if (val && parseCents(val) == null) { inp.closest('.ed-eqfield')?.classList.add('bad'); return true; }
      if (val !== (inp?.dataset.was ?? '')) { e._equiv = val; e._keep = false; }
      e._pick = null; state.error = ''; break;
    }
    case 'ed-eq-reset': e._equiv = ''; e._keep = false; e._pick = null; state.error = ''; break;
    case 'ed-recv-ok': {
      const inp = document.getElementById('ed-recv'), val = inp?.value.trim() ?? '';
      if (val && !(parseCents(val) > 0)) { inp.closest('.ed-eqfield')?.classList.add('bad'); return true; }
      e._recv = val; e._pick = null; state.error = ''; break;
    }
    case 'ed-recv-reset': e._recv = ''; e._pick = null; state.error = ''; break;
    case 'ed-off-rm': e._offs.splice(Number(v), 1); break;
    case 'ed-off-add': edAddOffset(e, Number(v)); e._pick = null; break;
    case 'ed-offset': { const t = state.data.tx.get(e.id); if (t) await startOffset(t, v); return true; }
    case 'ed-open': { const t = state.data.tx.get(Number(v)); if (t) { state.error = ''; startEdit(t); } return true; }
    case 'ed-tag': { const on = edTags(e); e.tags = (on.includes(v) ? on.filter((x) => x !== v) : [...on, v]).join(' '); break; }
    case 'ed-tags-done': {
      const add = (document.getElementById('ed-newtag')?.value ?? '').split(/[\s#,，]+/).filter(Boolean);
      e.tags = [...new Set([...edTags(e), ...add])].join(' '); e._pick = null; break;
    }
    case 'ed-newname': { const name = document.getElementById('ed-newname')?.value.trim(); if (!name) return true; e[v] = name; e._pick = null; break; }
    default: return false;
  }
  edRefresh();
  return true;
});
