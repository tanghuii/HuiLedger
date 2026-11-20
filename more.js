// 行星记账网页版：和手机端对齐的那些页面（详情、搜索、日历、统计、报销项目、补贴、周期性收支、账户明细、导出）。
// 这个文件在 app.js 之前加载，只放函数；用到的 state、money、txRow 等都在 app.js 里，调用时才去找。
'use strict';

const byNewest = (a, b) => b.date - a.date || (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id - a.id;
const allTxs = () => [...state.data.tx.values()];
const catOf = (t) => state.data.category.get(t.categoryId);
const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);
const seg = (act, options, current) => `<div class="seg">${options.map(([v, n]) => `<button class="${String(current) === String(v) ? 'on' : ''}" data-act="${act}" data-v="${v}">${n}</button>`).join('')}</div>`;
const rowsOf = (list, L, showDate = true) => list.map((t) => txRow(t, L, showDate)).join('');
/** 笔数：3 笔 / 3 entries */
const nTx = (n) => tr(`${n} 笔`, `${n} ${n === 1 ? 'entry' : 'entries'}`);
const today = () => { const d = new Date(); return epochDay(d.getFullYear(), d.getMonth() + 1, d.getDate()); };

/** 名单（报销项目、资金来源）：存在浏览器里的，加上账单上用过的。 */
// 名单和手机端共享（云端 setting），以前存在浏览器里的也带上
const nameKey = (key) => (key === 'hl.projects' ? 'projects' : 'funds');
function names(key, defaults, field) {
  return [...new Set([...shared.get(nameKey(key), defaults), ...store.get(key, []), ...allTxs().map((t) => t[field] ?? '')].filter(Boolean))];
}
const projectNames = () => names('hl.projects', ['ITB', 'China2026', 'PKUvisit'], 'project');
const fundNames = () => names('hl.funds', [], 'fund');
function rememberName(key, name) {
  const list = shared.get(nameKey(key), key === 'hl.projects' ? ['ITB', 'China2026', 'PKUvisit'] : []);
  if (!list.includes(name)) shared.set(nameKey(key), [...list, name]).catch(() => {});
}

function pageView() {
  // 从"我的"进去的页面：顶上一条返回栏
  const sub = { calendar: tr('日历', 'Calendar'), ask: tr('问账本', 'Ask'), ...Object.fromEntries(MOD.me.map((m) => [m.key, m.name])) }[state.tab];
  // 模块可以在返回栏右边放一个按钮（MOD.me 里的 barRight，比如预算页的"设置预算"）
  const entry = MOD.me.find((m) => m.key === state.tab), right = typeof entry?.barRight === 'function' ? entry.barRight() : '';
  const back = sub ? `<div class="subbar"><button class="round" data-act="tab" data-v="me" aria-label="${tr('返回', 'Back')}">‹</button><b>${h(sub)}</b>${right ? `<span class="sb-r">${right}</span>` : ''}</div>` : '';
  return back + pageBody();
}
function pageBody() {
  if (MOD.pages[state.tab]) return MOD.pages[state.tab]();
  switch (state.tab) {
    case 'me': return meView();
    case 'calendar': return calendarView();
    case 'stats': return statsView2();
    case 'accounts': return assetsView();
    case 'ask': return askView();
    default: return ledgerView();
  }
}

// ---------------------------------------------------------------- 统计页、资产页共用的小零件（样式在 css/stats.css）

/** 线条小图标（取 icons.js 里的路径）。 */
const pgIcon = (k) => `<svg class="pg-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${(ICONS[k] ?? ICONS.tag).d}"/></svg>`;
/** 页面顶上的标题栏：可选的返回按钮、标题、右边的按钮。手机上贴在顶部。 */
const pgBar = (title, { back = null, right = '' } = {}) => `<div class="pg-bar">${back ? `<button class="round pg-round" data-act="${back[0]}" data-v="${back[1] ?? ''}" aria-label="${tr('返回', 'Back')}">${pgIcon('back')}</button>` : ''}
  <h2 class="${back ? 'sm' : ''}">${title}</h2>${right}</div>`;
/** 别的模块（tags.js、art.js、shared.js、editor.js）给的公共小工具；还没加载到时退回简单写法。 */
const cn = (c, fb = tr('未分类', 'Uncategorized')) => {
  if (!c) return fb;
  if (typeof catName === 'function') { try { const r = catName(c); if (typeof r === 'string' && r) return r; } catch { /* 用原名 */ } }
  return c.name;
};
const pgEmpty = (kind, text) => (typeof emptyState === 'function' ? emptyState(kind, text) : `<div class="card muted">${text}</div>`);
const pgConfirm = (title, opts = {}) => uiConfirm(title, opts);

/**
 * "长出来"的动画（同手机端：圆环 800ms、条 600–700ms、环形图 750ms）只在第一次画这一页时放，
 * 同一页因为别的操作重画时不再放。key 是"哪一页"（换月份、换收支算新的一页）；同一次 render 里多处调用都拿到 true。
 */
const pgAnim = { seen: '', live: '', hit: false };
function pgGrow(key) {
  pgAnim.hit = true;
  if (pgAnim.seen !== key) { pgAnim.seen = key; pgAnim.live = key; queueMicrotask(() => { pgAnim.live = ''; }); }
  return pgAnim.live === key;
}
// 整页重画了（render 换掉 #app 的内容）却没有页面要动画：说明去了别的页，回来时算第一次画
new MutationObserver(() => { if (!pgAnim.hit) pgAnim.seen = ''; pgAnim.hit = false; }).observe(document.getElementById('app'), { childList: true });
/** 圆环上的那段弧：stroke-dashoffset 从整圈长度退到最终位置（grow 时放动画）。 */
function pgArc(cx, cy, r, f, color, width, grow) {
  const len = 2 * Math.PI * r, frac = Math.min(1, Math.max(0, f));
  if (frac <= 0) return '';
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${len.toFixed(2)} ${len.toFixed(2)}" stroke-dashoffset="${(len * (1 - frac)).toFixed(2)}"${grow ? ` class="pg-ring-in" style="--len:${len.toFixed(2)}"` : ''}/>`;
}
/** 条形的填充部分：grow 时从左边长出来。 */
const pgGx = (grow) => (grow ? ' class="pg-gx"' : '');
/** 管理模块的新建 / 修改账户弹窗，直接盖在资产页上。 */
const pgAccountDialog = () => (typeof mgDialog === 'function' ? mgDialog() : '');

/** 资产页：净资产、对账借款报销这些专题的入口、账户卡面（和手机端一样）。专题点进去顶上有返回。 */
const ASSET_SUBS = () => [['reconcile', 'check', tr('对账', 'Reconcile')], ['loans', 'people', tr('借款', 'Loans')], ['reimburse', 'receipt', tr('报销', 'Reimbursement')],
  ['subsidy', 'coins', tr('补贴', 'Subsidies')], ['recurring', 'calendar', tr('周期性收支', 'Recurring')]];
function assetsView() {
  const tab = state.assetTab, sub = ASSET_SUBS().find(([k]) => k === tab);
  if (!sub) return assetsAccounts();
  const body = tab === 'reconcile' ? reconcileView() : tab === 'loans' ? (MOD.pages.loans?.() ?? '') : tab === 'reimburse' ? reimburseView() : tab === 'subsidy' ? subsidyView() : recurringView();
  return `<div class="pg as-sub">${pgBar(sub[2], { back: ['asset-back'] })}${body}</div>`;
}

const ACCOUNT_TYPE_NAMES = () => [tr('储蓄', 'Savings'), tr('投资', 'Investment'), tr('信用', 'Credit'), tr('现金', 'Cash')];

function assetsAccounts() {
  if (state.accountId != null && state.data.account.has(state.accountId)) return accountDetailView() + pgAccountDialog();
  const accounts = [...state.data.account.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const txs = allTxs();
  // 每个账户按自己的币种算余额，合计时再折成主货币；垫出去还没报销回来的钱是应收款，也算资产（和手机端一样）
  const own = new Map(accounts.map((a) => [a.id, balanceOf(a, txs)]));
  const home = new Map(accounts.map((a) => [a.id, toHome(a, own.get(a.id))]));
  const pending = pendingReimburse(txs);
  const assets = [...home.values()].filter((v) => v > 0).reduce((s, v) => s + v, 0) + pending;
  const debts = -[...home.values()].filter((v) => v < 0).reduce((s, v) => s + v, 0);
  const grow = pgGrow('assets');
  const worth = `<div class="card as-worth"><div class="muted as-lbl">${tr('净资产', 'Net worth')}</div><div class="as-big num">${money(assets - debts)}</div>
    <div class="between as-ad"><div><div class="muted small">${tr('资产', 'Assets')}</div><div class="num in">${money(assets)}</div></div><div class="right"><div class="muted small">${tr('负债', 'Debts')}</div><div class="num out">${money(debts)}</div></div></div>
    ${assets + debts > 0 ? `<div class="as-ratio${grow ? ' pg-gx' : ''}">${assets > 0 ? `<i style="flex:${assets}"></i>` : ''}${debts > 0 ? `<b style="flex:${debts}"></b>` : ''}</div>
      <div class="muted as-rate">${assets > 0 ? `${tr('负债率', 'Debt ratio')} ${Math.round(debts * 100 / assets)}%` : ''}</div>` : ''}</div>`;
  const chart = netWorthCard();
  const menu = `<div class="card as-menu">${ASSET_SUBS().map(([k, icon, name]) => `<button class="as-row" data-act="asset-go" data-v="${k}">${iconTile(icon)}<span>${name}</span>${pgIcon('forward')}</button>`).join('')}</div>`;
  const receivable = pending > 0 ? `<div class="card as-recv"><div class="as-gh"><span>${tr('应收', 'Receivable')}</span></div>
    <button class="as-row" data-act="asset-go" data-v="reimburse">${iconTile('receipt')}<span>${tr('待报销', 'To claim')}</span><b class="num">${money(pending)}</b></button></div>` : '';
  // 每个账户一张卡面，颜色取自银行品牌色；外币账户小字折合主货币，欠款的写"欠款"
  const face = (a) => {
    const b = own.get(a.id), note = acctCur(a) !== HOME ? `≈ ${money(home.get(a.id))}` : b < 0 ? tr('欠款', 'Owed') : '';
    return `<div class="face" style="--cc:${accountFace(a)}" data-act="account" data-v="${a.id}" data-ro-id="${a.id}" role="button" tabindex="0"><span class="logo-w">${accountTile(a)}</span><span class="name">${h(a.name)}</span>
      <div class="right"><div class="num">${b < 0 ? '−' : ''}${money(Math.abs(b), acctCur(a))}</div>${note ? `<div class="small">${note}</div>` : ''}</div></div>`;
  };
  const names = ACCOUNT_TYPE_NAMES();
  const groups = [0, 1, 2, 3].map((type) => {
    const g = accounts.filter((a) => (a.type ?? 0) === type && !a.archived);
    if (!g.length) return '';
    return `<div class="card as-grp"><div class="as-gh"><span>${tr(`${names[type]}账户`, `${names[type]} accounts`)}</span><span>${money(g.reduce((s, a) => s + home.get(a.id), 0))}</span></div>
      <div class="faces" data-ro="account">${g.map(face).join('')}</div></div>`;
  }).join('');
  // 归档的账户收在最下面，点开才看得到（余额照样算进净资产）
  const old = accounts.filter((a) => a.archived);
  const archived = old.length ? `<div class="card as-grp as-old"><button class="as-gh as-toggle" data-act="acc-archived"><span>${tr(`已归档 ${old.length} 个`, `${old.length} archived`)} ${state.showArchived ? '▴' : '▾'}</span><span>${money(old.reduce((s, a) => s + home.get(a.id), 0))}</span></button>
      ${state.showArchived ? old.map((a) => `<div class="row click" data-act="account" data-v="${a.id}">${accountTile(a)}<div class="main"><div class="title muted">${h(a.name)}</div></div><div class="num muted">${money(own.get(a.id), acctCur(a))}</div></div>`).join('') : ''}</div>` : '';
  const add = `<button class="round pg-round" data-act="mg-acc-new" aria-label="${tr('添加账户', 'Add account')}">${pgIcon('plus')}</button>`;
  return `<div class="pg as">${pgBar(tr('资产', 'Assets'), { right: add })}
    <div class="as-cols"><div class="as-side">${worth}${menu}${receivable}</div><div class="as-main">${chart ? `<div class="as-chart">${chart}</div>` : ''}${groups}${archived}</div></div></div>${pgAccountDialog()}`;
}

// ---------------------------------------------------------------- 账单详情：先看，再决定改不改

function detailView() {
  const t = state.data.tx.get(state.view);
  if (!t) return '';
  const L = computeLookup(), acc = state.data.account, leaf = catOf(t), top = L.top(t.categoryId);
  const transfer = t.kind === KIND.TRANSFER, from = acc.get(t.accountId), to = acc.get(t.toAccountId);
  const foreign = t.currency && t.origCents > 0 && t.currency !== HOME;
  const offset = L.offsets.get(t.id) ?? 0;
  const linked = L.parts(t).map(([id]) => state.data.tx.get(id)).filter(Boolean);
  const offsetBy = t.kind === KIND.EXPENSE ? allTxs().filter((x) => L.parts(x).some(([id]) => id === t.id)) : [];
  const title = transfer ? `${h(from?.name ?? '?')} → ${h(to?.name ?? '?')}` : !leaf ? tr('未分类', 'Uncategorized') : leaf.parentId ? `${h(cn(top))} · ${h(cn(leaf))}` : h(cn(leaf));
  // 顶部一张彩色卡：颜色取自分类图标，转账用主题色
  const tint = transfer ? 'var(--card-tint)' : cardColor((ICONS[leaf?.icon] ?? ICONS.tag).c);
  const badges = [t.reimburse === 1 ? tr('待报销', 'To reimburse') : t.reimburse === 2 ? tr('已报销', 'Reimbursed') : '', t.excluded ? tr('不计入收支', 'Excluded') : ''].filter(Boolean);
  const tags = (t.tags ?? '').split(' ').filter(Boolean);
  const cell = (k, v) => `<div class="cell"><div class="muted">${k}</div><div class="v">${v}</div></div>`;
  const cells = [
    transfer ? '' : cell(tr('账户', 'Account'), `${accountTile(from)}<span>${h(from?.name ?? '?')}</span>`),
    cell(tr('日期', 'Date'), `${dayISO(t.date)} · ${WEEK[dayToDate(t.date).getUTCDay()]}`),
    tags.length ? cell(tr('标签', 'Tags'), tags.map((x) => (typeof tagLogo === 'function' ? `<span class="dt-tag">${tagLogo(x, 20)}${h(x)}</span>` : `<span class="badge gray" style="margin:0">#${h(x)}</span>`)).join('')) : '',
    t.project ? cell(tr('项目', 'Project'), h(t.project)) : '', t.fund ? cell(tr('资金来源', 'Funding'), h(t.fund)) : '',
    t.loanPerson ? cell(t.loanSide === 1 ? tr('借出给', 'Lent to') : tr('借自', 'Borrowed from'), h(t.loanPerson)) : '',
    cell(tr('账本', 'Ledger'), h(state.data.ledger.get(t.ledgerId)?.name ?? '')),
  ].filter(Boolean).join('');
  // 和 App 一样是一整页（不是弹窗）：顶上返回栏，中间可以滚，底下三个按钮贴着底边
  return `<div class="pg dt" role="region" aria-label="${tr('账单详情', 'Entry details')}">${pgBar(tr('账单详情', 'Entry details'), { back: ['close-view-btn'] })}
    <div class="dt-body">
    <div class="card cc hero" style="--cc:${tint}">
      <div class="halo">${transfer ? accountTile(to) : iconTile(leaf?.icon ?? 'tag')}</div>
      <div class="muted" style="font-weight:600">${title}</div>
      <div class="big amt ${t.kind === KIND.INCOME ? 'in' : t.kind === KIND.EXPENSE ? 'out' : ''}">${t.kind === KIND.INCOME ? '+' : t.kind === KIND.EXPENSE ? '-' : ''}${foreign ? money(t.origCents, t.currency) : money(t.amountCents)}</div>
      ${foreign ? `<div class="muted small">≈ ${money(t.amountCents)}</div>` : ''}${offset > 0 ? `<div class="muted small">${tr(`抵扣 ${money(offset)} 后实际 ${money(L.net(t))}`, `Net ${money(L.net(t))} after ${money(offset)} offset`)}</div>` : ''}
      ${badges.length ? `<div class="tags">${badges.map((b) => `<span>${b}</span>`).join('')}</div>` : ''}
    </div>
    <div class="cell"><div class="muted">${tr('备注', 'Note')}</div><div class="note ${t.note ? '' : 'muted'}">${h(t.note) || tr('无', 'None')}</div></div>
    <div class="cells">${cells}</div>
    ${linked.length ? `<div><div class="muted small">${tr('它抵扣的支出', 'Expenses it offsets')}</div>${rowsOf(linked, L)}</div>` : ''}
    ${offsetBy.length ? `<div><div class="muted small">${tr('抵扣它的补贴、退款', 'Offset by')}</div>${rowsOf(offsetBy, L)}</div>` : ''}
    ${t.kind === KIND.EXPENSE && typeof startOffset === 'function' ? `<div class="dt-offs">${[['补贴', tr('＋ 补贴', '＋ Subsidy')], ['退款', tr('＋ 退款', '＋ Refund')], ['代付收回', tr('＋ 代付收回', '＋ Paid back')]].map(([k, n]) => `<button class="btn link" data-act="view-offset" data-v="${k}">${n}</button>`).join('')}</div>` : ''}
    </div>
    <div class="dt-foot"><div class="btns3"><button class="btn danger" data-act="view-delete">${tr('删除', 'Delete')}</button><button class="btn" data-act="view-copy">${tr('复制', 'Copy')}</button><button class="btn primary" data-act="edit" data-v="${t.id}">${tr('修改', 'Edit')}</button></div></div>
  </div>`;
}
/** 正在看的这笔账（state.view 指的那笔还在）。 */
const viewingTx = () => state.view != null && !state.loading && state.data.tx.has(state.view);
/** 详情页的返回：回到上一笔的详情（从详情里点进来的），没有就回到原来的页面。 */
function viewBack() {
  let prev = state.viewStack?.pop();
  while (prev != null && !state.data.tx.has(prev)) prev = state.viewStack.pop();
  state.view = prev ?? null;
  if (state.view == null) state.viewStack = [];
}
// 电脑上按 Esc 也能从详情页退回去
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || !viewingTx() || state.editing || document.querySelector('.modal, .ui-confirm')) return;
  viewBack(); render();
});

// ---------------------------------------------------------------- 搜索：所有账本、所有时间

function searchView() {
  const L = computeLookup(), acc = state.data.account, cat = state.data.category;
  const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  const text = (t) => {
    const leaf = cat.get(t.categoryId), top = L.top(t.categoryId), iso = dayISO(t.date), d = dayToDate(t.date);
    return [t.note, t.tags, leaf?.name, top?.name, cn(leaf, ''), cn(top, ''), acc.get(t.accountId)?.name, acc.get(t.toAccountId)?.name, state.data.ledger.get(t.ledgerId)?.name, t.project, t.fund,
      (t.amountCents / 100).toFixed(2), t.origCents ? (t.origCents / 100).toFixed(2) : '', t.currency, iso, `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`, `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`,
      ['支出 expense', '收入 income', '转账 transfer'][t.kind], L.isReimburse(t) ? '报销 reimburse' : '', t.excluded ? '不计 excluded' : '',
      `${MONTH_EN[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`].filter(Boolean).join(' ').toLowerCase();
  };
  // 胶囊形的搜索框：左边放大镜，有字时右边一个清除
  const box = `<div class="between"><div class="sbox">${SEARCH_SVG}<input id="q" value="${h(state.q)}" placeholder="${tr('备注、分类、账户、标签、金额、日期', 'Note, category, account, tag, amount, date')}" autocomplete="off" enterkeyhint="search" aria-label="${tr('搜索', 'Search')}">
      ${state.q ? `<button class="x" data-act="search-clear" aria-label="${tr('清除', 'Clear')}">✕</button>` : ''}</div><button class="btn" data-act="search-close">${tr('取消', 'Cancel')}</button></div>`;
  const wrap = (body) => `<div class="grid" style="max-width:760px;width:100%;margin:0 auto">${box}${body}</div>`;
  if (!words.length) {
    // 还没输入：最近搜索、常用分类、常用标签（最近 90 天），点一下就搜
    const recent = store.get('hl.recentSearches', []), since = today() - 90;
    const recentTx = allTxs().filter((t) => t.date >= since);
    const catCount = new Map();
    for (const t of recentTx) { if (t.kind === KIND.TRANSFER) continue; const c = L.top(t.categoryId); if (c) catCount.set(c, (catCount.get(c) ?? 0) + 1); }
    const seen = new Set(), cats = [...catCount.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).filter((c) => !seen.has(c.name) && seen.add(c.name)).slice(0, 8);
    const tagCount = new Map();
    for (const t of recentTx) for (const x of (t.tags ?? '').split(' ').filter(Boolean)) tagCount.set(x, (tagCount.get(x) ?? 0) + 1);
    const tags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([x]) => x);
    const chip = (label, lead = '', remember = false) => `<button class="chip ${lead ? 'lead' : ''}" data-act="search-pick" data-v="${h(label)}" ${remember ? 'data-r="1"' : ''}>${lead}${h(label)}</button>`;
    const block = (head, chips) => `<div><div class="dayhead"><span>${head[0]}</span>${head[1] ?? ''}</div><div class="chips">${chips}</div></div>`;
    const parts = [
      recent.length ? block([tr('最近搜索', 'Recent'), `<button class="btn link small" style="padding:0" data-act="search-recent-clear">${tr('清空', 'Clear')}</button>`], recent.map((w) => chip(w)).join('')) : '',
      cats.length ? block([tr('常用分类', 'Top categories')], cats.map((c) => chip(cn(c), iconTile(c.icon ?? 'tag'), true)).join('')) : '',
      tags.length ? block([tr('常用标签', 'Top tags')], tags.map((x) => chip(x, `<span class="tile" style="background:var(--primary)">${h(x.slice(0, 2).toUpperCase())}</span>`, true)).join('')) : '',
    ].filter(Boolean);
    return wrap(parts.length ? `<div class="card grid">${parts.join('')}</div>` : '');
  }
  const hits = allTxs().filter((t) => { const s = text(t); return words.every((w) => s.includes(w)); }).sort(byNewest);
  if (!hits.length) return wrap(pgEmpty('search', tr('没找到', 'No results')));
  const out = sum(hits.filter((t) => t.kind === KIND.EXPENSE), (t) => t.amountCents), inc = sum(hits.filter((t) => t.kind === KIND.INCOME), (t) => t.amountCents);
  // 结果：顶上一张合计卡片，下面按月分组
  const months = new Map();
  for (const t of hits.slice(0, 500)) { const d = dayToDate(t.date), k = ymLabel(d.getUTCFullYear(), d.getUTCMonth() + 1); if (!months.has(k)) months.set(k, []); months.get(k).push(t); }
  return wrap(`<div class="card sum3"><div><div class="muted small">${tr('笔数', 'Entries')}</div><div class="num">${hits.length}</div></div><div><div class="muted small">${tr('支出', 'Expense')}</div><div class="num out">${money(out)}</div></div><div><div class="muted small">${tr('收入', 'Income')}</div><div class="num in">${money(inc)}</div></div></div>
    ${[...months.entries()].map(([k, l]) => `<div class="card"><div class="dayhead"><span>${k}</span><span>${nTx(l.length)}</span></div>${rowsOf(l, L)}</div>`).join('')}
    ${hits.length > 500 ? `<p class="muted small" style="margin:0">${tr('只显示前 500 笔', 'Showing first 500')}</p>` : ''}`);
}
const SEARCH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';
/** 最近搜过的词存在这个浏览器里，最多 10 个。 */
function rememberSearch(q) {
  const w = String(q ?? '').trim();
  if (w) store.set('hl.recentSearches', [w, ...store.get('hl.recentSearches', []).filter((x) => x !== w)].slice(0, 10));
}

// ---------------------------------------------------------------- 日历

/** 报销、退款、不计入的那几行小字（同手机端 ReimburseLine）。 */
function reimburseLine(t) {
  const a = t.reimbursable > 0 || t.reimbursed > 0 ? `<div class="between small amber"><span>${tr('可报销支出', 'Claimable')} ${money(t.reimbursable)}</span><span>${tr('报销收入', 'Reimbursed')} ${money(t.reimbursed)}</span></div>` : '';
  const b = t.refund > 0 || t.excluded > 0 ? `<div class="between small muted"><span>${t.refund > 0 ? `${tr('退款', 'Refunds')} ${money(t.refund)}` : ''}</span><span>${t.excluded > 0 ? `${tr('不计', 'Not counted')} ${money(t.excluded)}` : ''}</span></div>` : '';
  return a + b;
}
/** 格子里放不下完整金额（同手机端）：≥1 万写 12k，≥1000 写 1.2k，不到 10 块带一位小数，不到 1 分钱写 <1。 */
function calCompact(c) {
  const v = c / 100;
  if (v >= 10000) return Math.floor(v / 1000) + 'k';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  if (v < 10) { const s = v.toFixed(1).replace(/\.0$/, ''); return s === '0' && c > 0 ? '<1' : s; }
  return String(Math.round(v));
}

/** 月历（同手机端）：每天的支出和收入，点某一天在下方看明细、给这天记一笔。转账不计入收支。 */
function calendarView() {
  const L = computeLookup(), { y, m } = state.month, txs = monthTxs();
  const days = new Map();
  for (const t of txs) { if (!days.has(t.date)) days.set(t.date, []); days.get(t.date).push(t); }
  const first = epochDay(y, m, 1), count = new Date(y, m, 0).getDate();
  const lead = (dayToDate(first).getUTCDay() + 6) % 7; // 周一开头
  const now = today();
  const selected = state.calDay != null && state.calDay >= first && state.calDay < first + count ? state.calDay : (now >= first && now < first + count ? now : first);
  // 每天的进和出分开：当天收到的退款算在"收"里，不拿去冲当天的支出
  const dayNums = (items) => { const t = L.totals(items ?? []); return { out: t.expense + t.refund, inc: t.income + t.refund }; };
  // 热力：这个月花得最多的那天最深，其余按比例（开根号，小额也看得出来）
  const nums = Array.from({ length: count }, (_, d) => dayNums(days.get(first + d)));
  const peak = Math.max(1, ...nums.map((x) => x.out));
  const heat = (a) => `color-mix(in srgb, var(--expense) ${(a * 100).toFixed(1)}%, transparent)`;
  let cells = '<i></i>'.repeat(lead);
  for (let d = 0; d < count; d++) {
    const day = first + d, n = nums[d], isToday = day === now, we = (lead + d) % 7 >= 5, none = !n.out && !n.inc;
    const bg = n.out > 0 && day !== selected ? ` style="background:${heat(0.07 + 0.38 * Math.sqrt(n.out / peak))}"` : '';
    cells += `<button class="cal${day === selected ? ' on' : ''}${isToday ? ' today' : ''}${we ? ' we' : ''}" data-act="cal-day" data-v="${day}"${bg}><b>${d + 1}</b>${n.out > 0 ? `<span class="out">-${calCompact(n.out)}</span>` : ''}${n.inc > 0 ? `<span class="in">+${calCompact(n.inc)}</span>` : ''}${none && isToday ? '<i class="dot"></i>' : ''}${none && days.has(day) ? '<i class="tbar"></i>' : ''}</button>`;
  }
  const t = L.totals(txs), items = days.get(selected) ?? [], n = dayNums(items), dt = L.totals(items);
  const sub = !items.length ? tr('这天没有账单', 'Nothing on this day') : `${tr('支出', 'Out')} ${money(n.out)}   ${tr('收入', 'In')} ${money(n.inc)}${dt.reimbursable > 0 ? `   ${tr('可报销', 'Claimable')} ${money(dt.reimbursable)}` : ''}${dt.reimbursed > 0 ? `   ${tr('报销回', 'Reimbursed')} ${money(dt.reimbursed)}` : ''}`;
  return `<div class="cols wide calv">
    <div class="grid"><div class="cal-month">${monthBar({ planet: true })}</div><div class="card cal-card">
      <div class="cal-sum"><span class="out">${tr('支出', 'Out')} ${money(t.expense)}</span><span class="in">${tr('收入', 'In')} ${money(t.income)}</span><span>${tr('结余', 'Net')} ${money(t.income - t.expense)}</span></div>
      ${reimburseLine(t) ? `<div class="cal-re">${reimburseLine(t)}</div>` : ''}
      <div class="calgrid head">${(LANG === 'en' ? ['M', 'T', 'W', 'T', 'F', 'S', 'S'] : ['一', '二', '三', '四', '五', '六', '日']).map((x, i) => `<i class="${i >= 5 ? 'we' : ''}">${x}</i>`).join('')}</div><div class="calgrid">${cells}</div>
      <div class="legend">${tr('少', 'Less')}${[0.07, 0.17, 0.29, 0.45].map((a) => `<i style="background:${heat(a)}"></i>`).join('')}${tr('多', 'More')}</div></div></div>
    <div class="card cal-day"><div class="cal-dh"><div class="main"><b>${dayLabel(selected)}</b><div class="small muted">${sub}</div></div><button class="btn link" data-act="cal-add" data-v="${selected}">${tr('＋ 记一笔', '＋ Add')}</button></div>${rowsOf(items, L, false)}</div></div>`;
}

// ---------------------------------------------------------------- 统计：总览 / 分类 / 标签

function rangeTxs() {
  const { y, m } = state.month;
  const [from, to] = state.period === 'y' ? [epochDay(y, 1, 1), epochDay(y, 12, 31)] : state.period === 'a' ? [-1e9, 1e9] : [epochDay(y, m, 1), epochDay(y, m + 1, 0)];
  return allTxs().filter((t) => t.ledgerId === state.ledgerId && t.date >= from && t.date <= to).sort(byNewest);
}

/** 趋势图上点开的那一根，跟着当前看的这段时间；换了时间、收支就不算数。 */
const trendKey = () => `${state.period}:${state.month.y}-${state.month.m}:${state.statsIncome ? 1 : 0}`;

/**
 * 每日 / 每月趋势（和手机端一样）：柱子上浓下淡，没有数的日子留一个小点；或者一条曲线。
 * 点某一根，顶上弹出气泡写那天的数，再点一次收起。
 */
function trendChart(shown, L, color, grow = false) {
  const { y, m } = state.month, year = state.period === 'y';
  const n = year ? 12 : new Date(y, m, 0).getDate(), v = new Array(n).fill(0);
  for (const t of shown) { const d = dayToDate(t.date); v[(year ? d.getUTCMonth() + 1 : d.getUTCDate()) - 1] += L.net(t); }
  const max = Math.max(1, ...v), peak = Math.max(0, ...v);
  const label = (i) => (year ? tr(`${i + 1}月`, MONTH_EN[i]) : tr(`${m}月${i + 1}日`, `${MONTH_EN[m - 1]} ${i + 1}`));
  const pick = state.trendPick?.key === trendKey() && v[state.trendPick.i] > 0 ? state.trendPick.i : null;
  const x = (i) => ((i + 0.5) * 100 / n).toFixed(3), hgt = (c) => (c * 100 / max).toFixed(2);
  const hits = v.map((c, i) => `<button class="${c > 0 ? '' : 'z'}${pick === i ? ' on' : ''}" data-act="trend-pick" data-v="${i}" aria-label="${label(i)} ${money(c)}">${state.line ? '' : `<i${c > 0 ? ` style="height:${hgt(c)}%"` : ''}></i>`}</button>`).join('');
  let plot;
  if (state.line) {
    const pts = v.map((c, i) => [i + 0.5, +(100 - c * 100 / max).toFixed(2)]);
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < n; i++) { const [ax, ay] = pts[i - 1], [bx, by] = pts[i], mid = (ax + bx) / 2; d += ` C${mid},${ay} ${mid},${by} ${bx},${by}`; }
    plot = `<svg class="st-line${grow ? ' pg-wipe' : ''}" viewBox="0 0 ${n} 100" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="st-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".3"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      <path d="${d} L${pts[n - 1][0]},100 L${pts[0][0]},100 Z" fill="url(#st-fill)"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>
      ${v.map((c, i) => (c > 0 ? `<i class="st-dot${pick === i ? ' on' : ''}" style="left:${x(i)}%;bottom:${hgt(c)}%"></i>` : '')).join('')}<div class="st-hits">${hits}</div>`;
  } else plot = `<div class="st-bars${pick != null ? ' picking' : ''}${grow ? ' pg-gy' : ''}">${hits}</div>`;
  const bubble = pick == null ? '' : `<i class="st-pin" style="left:${x(pick)}%;bottom:${hgt(v[pick])}%"></i><div class="st-bub" style="left:${x(pick)}%;transform:translateX(-${x(pick)}%)"><span>${label(pick)}</span><b class="num">${money(v[pick])}</b></div>`;
  return `<div class="card st-trend"><div class="between"><b class="st-h">${year ? tr('每月趋势', 'By month') : tr('每日趋势', 'By day')}</b>${seg('chart', [[0, tr('柱状', 'Bars')], [1, tr('曲线', 'Line')]], state.line ? 1 : 0)}</div>
    <div class="st-plot" style="--c:${color}"><div class="st-area">${plot}${bubble}</div></div>
    <div class="st-axis"><span>1</span><span>${tr('最高', 'Peak')} ${money(peak)}</span><span>${n}</span></div></div>`;
}

/** 环形图（和手机端一样）：够宽的那几段上写白字的名字，点一段就展开它。slices: [{ label, name, color, cents, act, v }] */
function donutChart(slices, title, total, grow = false) {
  const S = 190, sw = 30, r = (S - sw) / 2, c = S / 2, gap = slices.filter((s) => s.cents > 0).length > 1 ? 2.5 : 0;
  const pt = (deg) => { const a = deg * Math.PI / 180; return `${(c + r * Math.cos(a)).toFixed(2)},${(c + r * Math.sin(a)).toFixed(2)}`; };
  const textW = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 11 : 7), 0);
  // 长出来（750ms，先快后慢）：整圈按 1-(1-t)³ 扫过去，每一段弧在扫到它的那段时间里匀速画完
  const at = (p) => 750 * (1 - Math.cbrt(1 - Math.min(1, Math.max(0, p))));
  const anim = (from, to, len) => (grow ? ` class="pg-arc" style="--len:${len.toFixed(2)};stroke-dasharray:${len.toFixed(2)} ${len.toFixed(2)};animation-delay:${at(from).toFixed(0)}ms;animation-duration:${Math.max(1, at(to) - at(from)).toFixed(0)}ms"` : '');
  let start = -90, arcs = '', labels = '';
  for (const s of slices) {
    const sweep = total > 0 && s.cents > 0 ? 360 * s.cents / total : 0;
    if (sweep > gap) {
      const a0 = start + gap / 2, a1 = start + sweep - gap / 2, p0 = (a0 + 90) / 360, p1 = (a1 + 90) / 360;
      const attrs = `fill="none" stroke="${s.color}" stroke-width="${sw}" data-act="${s.act}" data-v="${h(s.v)}"`, tip = `<title>${h(s.name)} ${money(s.cents)}</title>`;
      arcs += sweep >= 359.9 ? `<circle cx="${c}" cy="${c}" r="${r}" transform="rotate(-90 ${c} ${c})" ${attrs}${anim(0, 1, 2 * Math.PI * r)}>${tip}</circle>`
        : `<path d="M${pt(a0)} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${pt(a1)}" ${attrs}${anim(p0, p1, r * (a1 - a0) * Math.PI / 180)}>${tip}</path>`;
      // 这一段弧够放下名字才写
      if (s.label && sweep * Math.PI / 180 * r > textW(s.label) + 6) {
        const mid = (start + sweep / 2) * Math.PI / 180;
        labels += `<text x="${(c + r * Math.cos(mid)).toFixed(2)}" y="${(c + r * Math.sin(mid)).toFixed(2)}">${h(s.label)}</text>`;
      }
    }
    start += sweep;
  }
  return `<div class="st-donut"><svg viewBox="0 0 ${S} ${S}" role="img" aria-label="${h(title)}">${arcs}${grow ? `<g class="pg-fade">${labels}</g>` : labels}</svg><div class="mid"><div class="muted">${title}</div><div class="num">${money(total)}</div></div></div>`;
}

const hasTagPage = () => typeof openTagDetail === 'function';
/** 标签的颜色和缩写用 tags.js 的（和手机端同一套）；它还没加载时退回主题色和前两个字。 */
const stTagColor = (tag) => (typeof tagColor === 'function' ? tagColor(tag) : 'var(--primary)');
const stTagInitials = (tag) => (typeof tagInitials === 'function' ? tagInitials(tag) : tag.slice(0, 2).toUpperCase());

function statsView2() {
  const L = computeLookup(), kind = state.statsIncome ? KIND.INCOME : KIND.EXPENSE;
  const inRange = rangeTxs(), totals = L.totals(inRange);
  const shown = inRange.filter((t) => t.kind === kind && L.counts(t));
  const total = sum(shown, (t) => L.net(t));
  const { y, m } = state.month, step = state.period === 'y' ? 12 : 1, review = state.section === 'review';
  // 换内容、时间段、收支、柱状/曲线时才重放动画；点开某一类、点某根柱子不重放
  const grow = pgGrow(`stats:${state.ledgerId}:${state.section}:${state.period}:${y}-${m}:${state.statsIncome ? 1 : 0}:${state.line ? 1 : 0}`);
  // 上菜单：标题和看多长时间；下面是支出 / 收入、哪个月；最底下浮着 总览 / 分类 / 标签 / 复盘
  const nav = (dir) => `<button class="round pg-round sm" data-act="month" data-v="${dir * step}" aria-label="${dir < 0 ? tr('上一段', 'Previous') : tr('下一段', 'Next')}">${pgIcon(dir < 0 ? 'back' : 'forward')}</button>`;
  const side = `${pgBar(tr('统计', 'Stats'), { right: `<div class="st-per">${seg('period', [['m', tr('月', 'Month')], ['y', tr('年', 'Year')], ['a', tr('全部', 'All')]], state.period)}</div>` })}
    ${review ? '' : `<div class="st-kind">${seg('stats-kind', [[0, tr('支出', 'Expense')], [1, tr('收入', 'Income')]], state.statsIncome ? 1 : 0)}</div>`}
    ${state.period === 'a' || (review && state.period === 'm') ? '' : `<div class="st-month">${nav(-1)}<b>${state.period === 'y' ? tr(`${y}年`, `${y}`) : ymLabel(y, m)}</b>${nav(1)}</div>`}
    <nav class="st-sec" aria-label="${tr('统计内容', 'Sections')}">${seg('section', [['overview', tr('总览', 'Overview')], ['category', tr('分类', 'Categories')], ['tag', tr('标签', 'Tags')], ['review', tr('复盘', 'Review')]], state.section)}</nav>`;
  const empty = (text) => pgEmpty('receipt', text);
  const noData = empty(state.statsIncome ? tr('这段时间没有收入记录', 'No income in this period') : tr('这段时间没有支出记录', 'No expenses in this period'));
  let main;
  if (review) main = state.period === 'm' ? reviewView() : empty(tr('复盘按月看，先切到"月"。', 'Review is monthly. Switch to Month.'));
  else if (state.section === 'overview') {
    const leftOut = inRange.filter((t) => L.isReimburse(t) || L.isRefund(t) || t.excluded);
    const col = (label, cents, cls) => `<div><div class="muted">${label}</div><div class="num ${cls}">${money(cents)}</div></div>`;
    main = `<div class="card cc st-over"><div class="st-three">${col(tr('支出', 'Expense'), totals.expense, 'out')}${col(tr('收入', 'Income'), totals.income, 'in')}${col(tr('结余', 'Net'), totals.income - totals.expense, '')}</div>
        <div class="muted st-count">${tr(`共 ${inRange.length} 笔`, nTx(inRange.length))}</div></div>
      ${leftOut.length ? `<div class="card st-left"><div class="row click" data-act="left-out" style="padding:0"><div class="main"><div class="muted small">${tr('不参与分类统计的部分', 'Not in category stats')} ${state.openLeftOut ? '▴' : '▾'}</div>
        <div class="small amber">${tr('可报销支出', 'Reimbursable')} ${money(totals.reimbursable)} · ${tr('报销收入', 'Reimbursed')} ${money(totals.reimbursed)}</div><div class="small muted">${tr('退款', 'Refunds')} ${money(totals.refund)}${totals.excluded ? ` · ${tr('不计', 'Excluded')} ` + money(totals.excluded) : ''}</div></div></div>
        ${state.openLeftOut ? rowsOf(leftOut, L) : ''}</div>` : ''}
      ${total === 0 ? noData : state.period === 'a' ? '' : trendChart(shown, L, 'var(--primary)', grow)}`;
  } else if (state.section === 'category') {
    const groups = new Map();
    for (const t of shown) { const top = L.top(t.categoryId), k = top?.id ?? 0; if (!groups.has(k)) groups.set(k, { top, cents: 0, items: [] }); const g = groups.get(k); g.cents += L.net(t); g.items.push(t); }
    // 上一期（按月看是上个月，按年看是上一年）每个一级分类的数，用来标比上期多了还是少了
    const prev = new Map();
    if (state.period !== 'a') {
      const [pf, pt] = state.period === 'y' ? [epochDay(y - 1, 1, 1), epochDay(y - 1, 12, 31)] : [epochDay(y, m - 1, 1), epochDay(y, m, 0)];
      for (const t of allTxs()) if (t.ledgerId === state.ledgerId && t.date >= pf && t.date <= pt && t.kind === kind && L.counts(t)) { const k = L.top(t.categoryId)?.id ?? 0; prev.set(k, (prev.get(k) ?? 0) + L.net(t)); }
    }
    const sorted = [...groups.values()].sort((a, b) => b.cents - a.cents), first = Math.max(1, sorted[0]?.cents ?? 1);
    const rows = sorted.map((g, rank) => {
      const def = ICONS[g.top?.icon] ?? ICONS.tag, key = g.top?.id ?? 0, open = state.openTop === key;
      const subs = new Map();
      for (const t of g.items) { if (!subs.has(t.categoryId)) subs.set(t.categoryId, []); subs.get(t.categoryId).push(t); }
      const hasSubs = [...subs.keys()].some((id) => state.data.category.get(id)?.parentId);
      const inner = !open ? '' : !hasSubs ? `<div class="indent">${rowsOf(g.items, L)}</div>` : [...subs.entries()].map(([id, l]) => [id, l, sum(l, (t) => L.net(t))]).sort((a, b) => b[2] - a[2]).map(([id, l, c]) => {
        const leaf = state.data.category.get(id), o = state.openSub === id;
        return `<div class="row click indent" data-act="open-sub" data-v="${id}">${iconTile(leaf?.icon ?? g.top?.icon ?? 'tag', 'sm')}<div class="main muted">${leaf && leaf.parentId ? h(cn(leaf)) : tr('（未细分）', '(no subcategory)')} · ${nTx(l.length)} ${o ? '▴' : '▾'}</div><div class="num muted">${money(c)}</div></div>${o ? `<div class="indent2">${rowsOf(l, L)}</div>` : ''}`;
      }).join('');
      // 和上期比：支出多了红、少了绿；收入反过来；涨十倍以上写"×倍数"
      let change = '';
      if (state.period !== 'a') {
        const p = prev.get(key) ?? 0, diff = g.cents - p, worse = state.statsIncome ? diff < 0 : diff > 0;
        const pct = p ? Math.round(Math.abs(diff) * 100 / p) : 0;
        const label = !p ? tr('新增', 'New') : !diff ? '—' : (diff > 0 ? '▲ ' : '▼ ') + (pct >= 1000 ? '×' + Math.round(g.cents / p) : pct + '%');
        change = `<span class="chg ${!p || !diff ? '' : worse ? 'out' : 'in'}">${label}</span>`;
      }
      // 排名：前三名实心圆，其余淡色数字；占比条以最多的那一类为满
      const badge = rank < 3 ? `<b style="background:color-mix(in srgb, ${def.c} ${90 - rank * 20}%, transparent)">${rank + 1}</b>` : rank + 1;
      return `<div class="row click crow" data-act="open-top" data-v="${key}"><span class="rank">${badge}</span>${iconTile(g.top?.icon ?? 'tag')}
        <div class="main"><div class="line1"><span class="title">${h(cn(g.top))} <span class="tri">${open ? '▴' : '▾'}</span></span><span class="num">${money(g.cents)}</span></div>
          <div class="bar thin" style="background:color-mix(in srgb, ${def.c} 12%, transparent)"><i${pgGx(grow)} style="width:${Math.max(1, g.cents * 100 / first).toFixed(1)}%;background:linear-gradient(90deg, color-mix(in srgb, ${def.c} 60%, transparent), ${def.c})"></i></div>
          <div class="line2"><span>${total > 0 ? Math.round(g.cents * 100 / total) : 0}% · ${nTx(g.items.length)}</span>${change}</div></div></div>${inner}`;
    }).join('');
    const slices = sorted.map((g) => ({ label: [...cn(g.top, '?')].slice(0, 2).join(''), name: cn(g.top), color: (ICONS[g.top?.icon] ?? ICONS.tag).c, cents: g.cents, act: 'open-top', v: g.top?.id ?? 0 }));
    main = total > 0 ? `<div class="card st-dcard">${donutChart(slices, state.statsIncome ? tr('总收入', 'Total income') : tr('总支出', 'Total expenses'), total, grow)}</div><div class="card st-rank">${rows}</div>` : noData;
  } else {
    // 按标签：一笔账有几个标签就在每个标签下各算一次；没标签的不在这里
    const tags = new Map();
    for (const t of shown) for (const tag of (t.tags ?? '').split(' ').filter(Boolean)) { if (!tags.has(tag)) tags.set(tag, []); tags.get(tag).push(t); }
    const list = [...tags.entries()].map(([tag, l]) => [tag, l, sum(l, (t) => L.net(t))]).sort((a, b) => b[2] - a[2]);
    const rows = list.map(([tag, l, c]) => {
      const o = state.openTag === tag, ini = stTagInitials(tag), fs = [...ini].length >= 4 ? 11.5 : [...ini].length === 3 ? 13.5 : 16;
      // 有 tags.js 的标签详情页就点进去（同手机端），没有就在这里展开
      const logo = typeof tagLogo === 'function' ? tagLogo(tag, 38) : `<span class="tile" style="background:${stTagColor(tag)};font-size:${fs}px">${h(ini)}</span>`;
      return `<div class="row click st-tag" data-act="st-tag" data-v="${h(tag)}">${logo}
        <div class="main"><div class="title">${h(tag)} <span class="tri">${hasTagPage() ? '' : o ? '▴' : '▾'}</span></div><div class="sub">${dayISO(Math.min(...l.map((t) => t.date)))} – ${dayISO(Math.max(...l.map((t) => t.date)))} · ${nTx(l.length)}</div></div><div class="num">${money(c)}</div></div>${o && !hasTagPage() ? `<div class="indent">${rowsOf(l, L)}</div>` : ''}`;
    }).join('');
    const slices = list.map(([tag, , c]) => ({ label: stTagInitials(tag), name: tag, color: stTagColor(tag), cents: c, act: 'st-tag', v: tag }));
    main = list.length ? `<div class="card st-dcard">${donutChart(slices, tr('带标签的合计', 'Tagged total'), sum(list, (x) => x[2]), grow)}</div><div class="card st-rank">${rows}</div>`
      : empty(tr('这段时间没有带标签的账单', 'No tagged entries in this period'));
  }
  return `<div class="pg st"><div class="st-side">${side}</div><div class="st-main">${main}</div></div>`;
}

// ---------------------------------------------------------------- 账户明细（和手机端一样：银行卡样的头、按月分组的往来）

function accountDetailView() {
  const a = state.data.account.get(state.accountId), L = computeLookup(), cur = acctCur(a), show = (c) => money(c, cur);
  // 和这个账户有关的账单，全部账本，新的在前
  const list = allTxs().filter((t) => t.accountId === a.id || (t.kind === KIND.TRANSFER && t.toAccountId === a.id)).sort(byNewest);
  const eff = new Map(list.map((t) => [t.id, effect(a, t)]));
  const balance = (a.initialCents ?? 0) + sum(list, (t) => eff.get(t.id));
  const flow = (l, sign) => sign * sum(l, (t) => (sign > 0 ? Math.max(0, eff.get(t.id)) : Math.min(0, eff.get(t.id))));
  const months = new Map();
  for (const t of list) { const d = dayToDate(t.date), k = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`; if (!months.has(k)) months.set(k, { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, l: [] }); months.get(k).l.push(t); }
  // 像一张银行卡：卡面颜色取自这家银行的品牌色，白字
  const notes = [cur !== HOME ? `≈ ${money(toHome(a, balance))}` : '', a.checkedAt > 0 ? `${tr('上次核对', 'Checked')} ${dayISO(a.checkedAt)}` : '', a.archived ? tr('已归档', 'Archived') : ''].filter(Boolean).join('  ·  ');
  const type = ACCOUNT_TYPE_NAMES()[a.type ?? 0] ?? '';
  const stat = (label, cents) => `<div><div class="small muted">${label}</div><div class="num">${show(cents)}</div></div>`;
  const right = `<button class="pg-pill" data-act="acc-add" data-v="${a.id}">${pgIcon('plus')}<span>${tr('记一笔', 'Add')}</span></button><button class="round pg-round" data-act="acc-settings" data-v="${a.id}" aria-label="${tr('账户设置', 'Account settings')}">${pgIcon('wrench')}</button>`;
  const card = `<div class="card cc acard" style="--cc:${accountFace(a)}">
      <div class="row" style="padding:0"><span class="logo-w lg">${accountTile(a)}</span><div class="main"><div class="title acard-name">${h(a.name)}</div><div class="small muted">${tr(`${type}账户`, `${type} account`)}</div></div>
        <span class="small muted acard-cur"><span class="flag">${flagOf(cur)}</span>${cur}</span></div>
      <div class="small muted acard-lbl">${tr('余额', 'Balance')}</div>
      <div class="big bal">${show(balance)}</div>
      ${notes ? `<div class="small muted">${notes}</div>` : ''}
      <div class="stats3">${stat(tr('初始余额', 'Opening'), a.initialCents ?? 0)}${stat(tr('累计流入', 'Total in'), flow(list, 1))}${stat(tr('累计流出', 'Total out'), flow(list, -1))}</div>
      <div class="acard-btns"><button class="pill" data-act="acc-settings" data-v="${a.id}">${tr('账户设置', 'Settings')}</button><button class="pill" data-act="acc-fix" data-v="${a.id}">${tr('修正当前余额', 'Correct balance')}</button></div></div>`;
  const monthCards = [...months.values()].map(({ y, m, l }) => {
    let day = null, rows = '';
    for (const t of l) { if (t.date !== day) { day = t.date; rows += `<div class="acc-day">${dayLabel(day)}</div>`; } rows += txRow(t, L, false, a); }
    return `<div class="card acc-month"><div class="acc-mh"><b>${ymLabel(y, m)}</b><span class="in">${tr('入', 'In')} ${show(flow(l, 1))}</span><span class="out">${tr('出', 'Out')} ${show(flow(l, -1))}</span></div>${rows}</div>`;
  }).join('');
  return `<div class="pg acc">${pgBar(h(a.name), { back: ['account-back'], right })}
    <div class="cols"><div class="sticky">${card}</div><div class="grid">${monthCards || pgEmpty('receipt', tr('这个账户还没有账单', 'No entries in this account yet'))}</div></div></div>`;
}

// 点底栏（或别处的 data-act="tab"）离开时：资产页回到最上层，弹出的东西收起来
document.addEventListener('click', (ev) => {
  if (!ev.target.closest?.('[data-act="tab"]') || typeof state === 'undefined') return;
  state.assetTab = 'accounts'; state.trendPick = null;
}, true);

// ---------------------------------------------------------------- 报销：按项目看

function projectStats(name, L) {
  const list = allTxs().filter((t) => (t.project ?? '') === name && L.isReimburse(t)).sort(byNewest);
  return { list, claim: sum(list.filter((t) => t.kind === KIND.EXPENSE), (t) => t.amountCents), back: sum(list.filter((t) => t.kind === KIND.INCOME), (t) => t.amountCents) };
}
function projectNumbers(p) {
  const gap = p.claim - p.back;
  return `<div class="between" style="margin-top:8px"><div><div class="num" style="font-size:17px">${money(p.claim)}</div><div class="muted small">${tr('报销总额', 'Claimed')}</div></div>
    <div><div class="num in" style="font-size:17px">${money(p.back)}</div><div class="muted small">${tr('已报销', 'Reimbursed')}</div></div>
    <div class="right"><div class="num ${gap > 0 ? 'amber' : 'muted'}" style="font-size:17px">${money(Math.abs(gap))}</div><div class="muted small">${gap >= 0 ? tr('还差', 'Outstanding') : tr('多报回', 'Overpaid')}</div></div></div>`;
}
/** 进度环：报回来的占要报的多少，中间写百分比；全报回来变绿。 */
function progressRing(p, grow = false) {
  const ratio = p.claim > 0 ? p.back / p.claim : p.back > 0 ? 1 : 0, color = ratio >= 1 ? 'var(--income)' : 'var(--primary)';
  const r = 27.5;
  return `<div class="ring"><svg viewBox="0 0 62 62" aria-hidden="true"><circle cx="31" cy="31" r="${r}" fill="none" stroke="${color}" stroke-opacity=".14" stroke-width="7"/>
    ${pgArc(31, 31, r, ratio, color, 7, grow)}</svg>
    <b style="color:${color}">${Math.round(Math.min(ratio, 9.99) * 100)}%</b></div>`;
}
function projectCard(name, p, grow = false) {
  const gap = p.claim - p.back;
  return `<div class="card click" data-act="project" data-v="${h(name)}"><div class="row" style="padding:0;gap:14px">${progressRing(p, grow)}
    <div class="main"><div class="between"><b style="font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(name || tr('未归项目', 'No project'))}</b><span class="muted small">${nTx(p.list.length)}</span></div>
      <div class="small muted">${tr('已报', 'Reimbursed')} <span class="num" style="font-weight:500">${money(p.back)} / ${money(p.claim)}</span></div>
      <div class="num ${gap > 0 ? 'amber' : 'in'}" style="font-size:14px">${gap > 0 ? tr('还差 ', 'Outstanding ') + money(gap) : gap < 0 ? tr('多报回 ', 'Overpaid ') + money(-gap) : tr('已结清', 'Settled')}</div></div></div></div>`;
}
/**
 * 疑似已报销（同手机端 findReimbursed）：没标报销的支出，和之后 180 天内一笔金额相同的"报销"收入对上了；
 * 同账本、优先同标签、日期最近的那笔。点过"不是"的不再提示（记在这个浏览器里）。
 */
function findReimbursed(L) {
  const ignored = new Set(store.get('hl.ignoredReimb', [])), used = new Set(), out = [];
  const byAmount = new Map();
  for (const t of allTxs()) if (t.kind === KIND.EXPENSE && !t.reimburse && !t.excluded) { if (!byAmount.has(t.amountCents)) byAmount.set(t.amountCents, []); byAmount.get(t.amountCents).push(t); }
  const tagsOf = (t) => (t.tags ?? '').split(' ').filter(Boolean);
  for (const inc of allTxs().filter((t) => t.kind === KIND.INCOME && L.top(t.categoryId)?.name === '报销')) {
    const it = tagsOf(inc);
    const match = (byAmount.get(inc.amountCents) ?? []).filter((e) => !used.has(e.id) && e.ledgerId === inc.ledgerId && e.date <= inc.date && inc.date - e.date <= 180)
      .sort((x, y) => (tagsOf(x).some((g) => it.includes(g)) ? 0 : 1) - (tagsOf(y).some((g) => it.includes(g)) ? 0 : 1) || (inc.date - x.date) - (inc.date - y.date))[0];
    if (!match) continue;
    used.add(match.id);
    if (!ignored.has(`${match.id}:${inc.id}`)) out.push([match, inc]);
  }
  return out;
}

/** 报销款到账（同手机端 reimburseIn）：选收款账户、金额、日期，记一笔"报销"收入（带上项目、资金来源、标签），原账单标成已报销。 */
function reimburseInDialog() {
  const r = state.rIn, t = r && state.data.tx.get(r.id);
  if (!t) return '';
  const accs = [...state.data.account.values()].filter((a) => !a.archived).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const acc = state.data.account.get(r.account), cur = acc ? acctCur(acc) : HOME;
  return `<div class="modal" data-act="r-in-x"><div class="card grid" role="dialog" aria-label="${tr('报销入账', 'Reimbursement received')}"><b style="font-size:18px">${tr('报销入账', 'Reimbursement received')}</b>
    <label class="f">${tr('收款账户', 'Account')}<select id="r-in-acc" data-change="r-in-acc"><option value="0">${tr('选择账户', 'Choose account')}</option>${accs.map((a) => `<option value="${a.id}" ${a.id === r.account ? 'selected' : ''}>${h(a.name)}</option>`).join('')}</select></label>
    <div class="two"><label class="f">${tr(`金额（${cur}）`, `Amount (${cur})`)}<input id="r-in-amt" inputmode="decimal" autocomplete="off" value="${h(r.amount)}" placeholder="${(reimburseDefault(t, cur) / 100).toFixed(2)}"></label>
      <label class="f">${tr('日期', 'Date')}<input id="r-in-date" type="date" value="${dayISO(r.date)}"></label></div>
    ${r.err ? `<p class="err" style="margin:0">${h(r.err)}</p>` : ''}
    <div class="between"><button class="btn" data-act="r-in-cancel">${tr('取消', 'Cancel')}</button><button class="btn primary" data-act="r-in-save">${tr('入账', 'Save')}</button></div></div></div>`;
}
/** 没填金额就按原账单的数：收款账户和原账单同币种用原币金额，否则用折合主货币的金额。 */
const reimburseDefault = (t, cur) => (t.currency && t.origCents > 0 && t.currency === cur ? t.origCents : cur === HOME ? t.amountCents : convert(t.amountCents, HOME, cur) ?? t.amountCents);
async function reimburseInSave() {
  const r = state.rIn, t = state.data.tx.get(r.id), acc = state.data.account.get(Number(document.getElementById('r-in-acc')?.value));
  const text = (document.getElementById('r-in-amt')?.value ?? '').trim(), date = document.getElementById('r-in-date')?.value;
  r.amount = text;
  if (!acc) { r.err = tr('请选择收款账户', 'Choose an account'); return; }
  const cur = acctCur(acc), cents = text ? Math.round(Number(text.replace(',', '.')) * 100) : reimburseDefault(t, cur);
  if (!(cents > 0)) { r.err = tr('金额不对', 'Invalid amount'); return; }
  let cat = [...state.data.category.values()].find((c) => !c.parentId && c.isIncome && c.name === '报销');
  if (!cat) { cat = { id: newId(), name: '报销', icon: 'receipt', isIncome: true, sortOrder: state.data.category.size, parentId: 0 }; await saveRecord('category', cat); }
  const foreign = cur !== HOME, what = (t.note ?? '').trim() || catOf(t)?.name || '';
  await saveRecord('tx', { id: newId(), kind: KIND.INCOME, amountCents: foreign ? convert(cents, cur, HOME) ?? cents : cents, categoryId: cat.id, accountId: acc.id, toAccountId: 0, ledgerId: t.ledgerId,
    date: date ? isoToDay(date) : today(), note: `报销到账：${what}`.slice(0, 120), tags: t.tags ?? '', reimburse: 0, createdAt: Date.now(), currency: foreign ? cur : '', origCents: foreign ? cents : 0,
    excluded: false, offsetOf: 0, offsetParts: '', project: t.project ?? '', fund: t.fund ?? '' });
  await saveRecord('tx', { ...t, reimburse: 2 });
  state.rIn = null;
}

function reimburseView() {
  const L = computeLookup();
  if (state.project != null) {
    const p = projectStats(state.project, L), funds = new Map(), f = state.rFilter ?? 0;
    for (const t of p.list) if (t.fund) { if (!funds.has(t.fund)) funds.set(t.fund, []); funds.get(t.fund).push(t); }
    // 全部 / 待报销 / 已报销 / 报销收入（同手机端）
    const shown = p.list.filter((t) => (f === 1 ? t.reimburse === 1 : f === 2 ? t.reimburse === 2 : f === 3 ? t.kind === KIND.INCOME : true));
    return `<div class="cols"><div class="grid sticky"><div><button class="btn" data-act="project-back">‹ ${tr('全部项目', 'All projects')}</button></div><div class="card cc grid"><b style="font-size:18px">${h(state.project || tr('未归项目', 'No project'))}</b>${projectNumbers(p)}</div>
      ${funds.size ? `<div class="card"><div class="muted small">${tr('资金来源', 'Funding')}</div>${[...funds.entries()].map(([fd, l]) => `<div class="between small"><span>${h(fd)}</span><span class="muted">${tr('支', 'Out')} ${money(sum(l.filter((t) => t.kind === KIND.EXPENSE), (t) => t.amountCents))} · ${tr('回', 'Back')} ${money(sum(l.filter((t) => t.kind === KIND.INCOME), (t) => t.amountCents))}</span></div>`).join('')}</div>` : ''}</div>
      <div class="grid">${seg('r-filter', [[0, tr('全部', 'All')], [1, tr('待报销', 'To claim')], [2, tr('已报销', 'Done')], [3, tr('报销收入', 'Paid back')]], f)}
        ${shown.length ? `<div class="card">${rowsOf(shown, L)}</div>` : pgEmpty('receipt', tr('还没有账单', 'No entries yet'))}</div></div>`;
  }
  const matched = findReimbursed(L);
  const head = seg('rmode', [['projects', tr('项目', 'Projects')], ['pending', tr('待报销', 'To claim')], ['done', tr('已报销', 'Done')], ['likely', tr(`疑似 ${matched.length}`, `Likely ${matched.length}`)]], state.rmode);
  if (state.rmode === 'projects') {
    const grow = pgGrow('reimburse:projects');
    const cards = [...projectNames(), ''].map((name) => { const p = projectStats(name, L); return name || p.list.length ? projectCard(name, p, grow) : ''; }).join('');
    return `<div class="grid">${head}<div class="grid three">${cards}</div></div>`;
  }
  if (state.rmode === 'likely') {
    const total = sum(matched, ([e]) => e.amountCents);
    return `<div class="grid">${head}<div class="between rb-likely"><span class="muted">${tr(`共 ${money(total)}`, `${money(total)} in total`)}</span>${matched.length ? `<button class="btn link" data-act="r-mark-all">${tr('全部标为已报销', 'Mark all reimbursed')}</button>` : ''}</div>
      ${matched.length ? matched.map(([e, inc]) => `<div class="card rb-pair"><div class="small muted">${dayISO(e.date)}</div>${txRow(e, L)}<div class="small muted">${dayISO(inc.date)}</div>${txRow(inc, L)}
        <div class="rb-btns"><button class="btn link muted" data-act="r-ignore" data-v="${e.id}:${inc.id}">${tr('不是', 'No')}</button><button class="btn link" data-act="r-mark" data-v="${e.id}">${tr('标为已报销', 'Mark reimbursed')}</button></div></div>`).join('')
        : pgEmpty('piggy', tr('没有疑似已报销的支出', 'Nothing here'))}</div>`;
  }
  const want = state.rmode === 'done' ? 2 : 1;
  const list = allTxs().filter((t) => t.reimburse === want).sort(byNewest);
  const options = (cur) => ['', ...projectNames()].map((n) => `<option value="${h(n)}" ${n === (cur ?? '') ? 'selected' : ''}>${h(n || tr('（未归项目）', '(no project)'))}</option>`).join('');
  return `<div class="grid">${head}<div class="card cc" style="--cc:${want === 1 ? '#E8962E' : '#21A67A'}"><div class="small muted">${want === 1 ? tr('还没报回来的钱', 'Still to be reimbursed') : tr('已报销合计', 'Reimbursed in total')}</div><div class="big">${money(sum(list, (t) => t.amountCents))}</div><div class="small muted">${nTx(list.length)}</div></div>
    ${list.length ? list.map((t) => `<div class="card rb-item">${txRow(t, L)}<div class="rb-btns"><span class="small muted">${dayISO(t.date)}</span><select class="mini" data-change="set-project" data-v="${t.id}" aria-label="${tr('报销项目', 'Project')}">${options(t.project)}</select><span class="sp"></span>
      ${want === 1 ? `<button class="btn link" data-act="r-in" data-v="${t.id}">${tr('入账', 'Paid in')}</button>` : ''}<button class="btn link" data-act="toggle-reimburse" data-v="${t.id}">${want === 1 ? tr('已报销', 'Done') : tr('改回待报销', 'Back to claim')}</button></div></div>`).join('')
      : pgEmpty('piggy', want === 1 ? tr('没有待报销的账单', 'Nothing to claim') : tr('没有已报销的账单', 'Nothing reimbursed yet'))}${reimburseInDialog()}</div>`;
}

// ---------------------------------------------------------------- 补贴

/** 补贴分组的英文显示名（分组键保持中文） */
const SUBSIDY_EN = { '医保补贴': 'Health subsidy', '住房补贴': 'Housing subsidy', '其他补贴': 'Other subsidies' };

function subsidyView() {
  const L = computeLookup(), year = new Date().getFullYear(), all = state.subsidyAll;
  // 今年 / 全部（同手机端）
  const list = allTxs().filter((t) => t.kind === KIND.INCOME && L.top(t.categoryId)?.name === '补贴' && (all || dayToDate(t.date).getUTCFullYear() === year)).sort(byNewest);
  const type = (t) => {
    const n = (t.note ?? '').toLowerCase();
    const linked = L.parts(t).flatMap(([id]) => { const e = state.data.tx.get(id); return e ? [catOf(e)?.name, L.top(e.categoryId)?.name] : []; });
    if (linked.some((x) => x === '医保' || x === '保险') || ['zorgtoeslag', '医保', '医疗', '保险'].some((w) => n.includes(w))) return '医保补贴';
    if (linked.some((x) => x === '房租' || x === '居住') || ['huurtoeslag', '住房', '房租', '房补'].some((w) => n.includes(w))) return '住房补贴';
    return '其他补贴';
  };
  const groups = new Map();
  for (const t of list) { const k = type(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  const used = sum(list, (t) => Math.min(t.amountCents, sum(L.parts(t), (p) => p[1])));
  const loose = list.filter((t) => !L.isOffset(t)).length;
  const head = `<div class="grid sticky">${seg('subsidy-range', [[0, tr(`${year} 年`, `${year}`)], [1, tr('全部', 'All')]], all ? 1 : 0)}
    <div class="card sb-sum"><div class="muted small">${tr('收到补贴', 'Received')}</div><div class="big num">${money(sum(list, (t) => t.amountCents))}</div>
      <div class="between small" style="margin-top:6px"><span class="muted">${tr('已抵扣支出', 'Offset')} ${money(used)}</span>${loose ? `<span class="amber">${tr(`${loose} 笔未关联`, `${loose} unlinked`)}</span>` : ''}</div>
      ${loose ? `<button class="btn link sb-link" data-act="subsidy-link">${tr('自动关联', 'Link automatically')}</button>` : ''}</div></div>`;
  const cards = [...groups.entries()].map(([k, l]) => {
    const o = state.openKey === k, missing = l.filter((t) => !L.isOffset(t)).length;
    return `<div class="card sb-grp"><div class="row click" data-act="open-key" data-v="${k}" style="padding:0">${iconTile('coins')}<div class="main"><div class="title">${tr(k, SUBSIDY_EN[k] ?? k)} <span class="tri">${o ? '▴' : '▾'}</span></div>
      <div class="sub ${missing ? 'amber' : ''}">${nTx(l.length)}${missing ? tr(` · ${missing} 笔未关联`, ` · ${missing} unlinked`) : ''}</div></div><div class="num">${money(sum(l, (t) => t.amountCents))}</div></div>${o ? rowsOf(l, L) : ''}</div>`;
  }).join('');
  return `<div class="cols">${head}<div class="grid">${cards || pgEmpty('piggy', tr('还没有补贴记录', 'No subsidies yet'))}</div></div>`;
}

/** 月份缩写（荷兰语 / 英语），同手机端 Merge.MONTHS。 */
const SB_MONTHS = [['jan'], ['feb'], ['mrt', 'maa', 'mar'], ['apr'], ['mei', 'may'], ['jun'], ['jul'], ['aug'], ['sep'], ['okt', 'oct'], ['nov'], ['dec']];
/**
 * 补贴的说明里写的是哪个月的（"MAAND NOV."、"PREMIE nov. 2026"、"11月"），没写返回 null（同手机端 Merge.monthOf）。
 * 年份取离到账日最近的那一个：十月底发的"一月"补贴是明年一月的。返回 { y, m }。
 */
function sbMonthOf(note, received) {
  const n = String(note ?? '').toLowerCase();
  let month = 0;
  const w = /(?:maand|month|premie|voor|for)[\s.:]+([a-z]{3})/.exec(n);
  if (w) month = SB_MONTHS.findIndex((l) => l.includes(w[1])) + 1;
  if (month <= 0) { const d = /(\d{1,2})\s*月/.exec(n), v = d ? Number(d[1]) : 0; month = v >= 1 && v <= 12 ? v : 0; }
  if (!month) return null;
  const d = dayToDate(received), y = d.getUTCFullYear(), base = y * 12 + d.getUTCMonth();
  let best = null;
  for (const k of [-1, 0, 1]) { const idx = (y + k) * 12 + month - 1; if (!best || Math.abs(idx - base) < Math.abs(best.idx - base)) best = { idx, y: y + k, m: month }; }
  return { y: best.y, m: best.m };
}
/** 这笔支出的说明里有没有提到这个月（"nov"、"2026-11"、"11月"），同手机端 Merge.mentions。 */
function sbMentions(note, ym) {
  const n = String(note ?? '').toLowerCase();
  // 前面紧挨着的字符：\b 前面不能是字母数字（含中文，同 Android 的 Unicode 规则）；"11月" 前面不能是数字
  const hits = (word, bad) => { for (let i = n.indexOf(word); i >= 0; i = n.indexOf(word, i + 1)) if (i === 0 || !bad.test(n[i - 1])) return true; return false; };
  const wordChar = /[\p{L}\p{N}_]/u, digit = /\d/;
  if (SB_MONTHS[ym.m - 1].some((w) => hits(w, wordChar))) return true;
  if (n.includes(`${ym.y}-${String(ym.m).padStart(2, '0')}`)) return true;
  for (const m of n.matchAll(new RegExp(`${ym.m}\\s*月`, 'g'))) if (m.index === 0 || !digit.test(n[m.index - 1])) return true;
  return false;
}

/**
 * 自动把补贴关联到它抵扣的支出（同手机端 linkSubsidies）：
 * 备注写明是医保 / 住房补贴的收入：说明里写了是哪个月的（MAAND NOV.），就在那个月的上个月初到那个月底之间找——
 * 说明里也提到这个月的优先，其次离到账日最近的；没写月份就找到账前 10 天到后 35 天之内、离得最近的。都只找还没被抵扣过的医保 / 房租支出。
 * 没写备注、记在"退款"或"补贴"下的，前后 5 天内金额和一笔医保几乎相等，或者是一笔房租的四成到六成五，也连上。
 */
async function linkSubsidies() {
  // 和手机端 dao.allTxs() 同样的顺序（新的在前），"离得一样近"时挑中的是同一笔
  const all = allTxs().sort(byNewest), cats = state.data.category;
  const names = (id) => { const c = cats.get(id); return c ? [c.name, cats.get(c.parentId)?.name].filter(Boolean) : []; };
  const L = computeLookup(), taken = new Set(all.flatMap((t) => L.parts(t).map(([id]) => id)));
  const RULES = [[['zorgtoeslag', '医保补贴', '医疗补贴', '保险补贴'], ['医保', '保险']], [['huurtoeslag', '住房补贴', '房租补贴', '房补'], ['房租']]];
  let subsidyCat = [...cats.values()].find((c) => !c.parentId && c.isIncome && c.name === '补贴');
  const ensureCat = async () => {
    if (!subsidyCat) { subsidyCat = { id: newId(), name: '补贴', icon: iconKey('补贴'), isIncome: true, sortOrder: cats.size, parentId: 0 }; await saveRecord('category', subsidyCat); }
    return subsidyCat.id;
  };
  const linked = new Set();
  const link = async (income, expense) => { taken.add(expense.id); linked.add(income.id); await saveRecord('tx', { ...income, offsetOf: expense.id, offsetParts: '', categoryId: await ensureCat() }); };
  const free = (income) => income.kind === KIND.INCOME && !(income.offsetOf > 0) && !income.offsetParts;
  for (const income of all.filter((t) => free(t) && (t.note ?? '').trim()).sort((a, b) => a.date - b.date)) {
    const note = income.note.toLowerCase(), rule = RULES.find(([words]) => words.some((w) => note.includes(w)));
    if (!rule) continue;
    const pool = all.filter((e) => e.kind === KIND.EXPENSE && !taken.has(e.id) && e.ledgerId === income.ledgerId && names(e.categoryId).some((n) => rule[1].includes(n)));
    const nearest = (list) => list.reduce((b, e) => (!b || Math.abs(e.date - income.date) < Math.abs(b.date - income.date) ? e : b), null);
    const month = sbMonthOf(income.note, income.date);
    let best;
    if (month) {
      const from = epochDay(month.y, month.m - 1, 1), to = epochDay(month.y, month.m + 1, 0);
      const inRange = pool.filter((e) => e.date >= from && e.date <= to);
      best = inRange.find((e) => sbMentions(e.note, month)) ?? nearest(inRange);
    } else best = nearest(pool.filter((e) => e.date - income.date >= -10 && e.date - income.date <= 35));
    if (best) await link(income, best);
  }
  for (const income of all.filter((t) => free(t) && !linked.has(t.id) && names(t.categoryId).some((n) => n === '退款' || n === '补贴')).sort((a, b) => a.date - b.date)) {
    const near = all.filter((e) => e.kind === KIND.EXPENSE && !taken.has(e.id) && e.ledgerId === income.ledgerId && Math.abs(e.date - income.date) <= 5);
    const best = near.find((e) => names(e.categoryId).some((n) => n === '医保' || n === '保险') && Math.abs(e.amountCents - income.amountCents) * 50 <= e.amountCents)
      ?? near.find((e) => names(e.categoryId).includes('房租') && income.amountCents * 100 >= e.amountCents * 40 && income.amountCents * 100 <= e.amountCents * 65);
    if (best) await link(income, best);
  }
  return linked.size;
}

// ---------------------------------------------------------------- 周期性收支

const RECURRING_DEFAULT = [
  { name: '房租', categories: ['房租'], keywords: [], income: false }, { name: '保险', categories: ['保险', '医保'], keywords: [], income: false },
  { name: '补贴', categories: ['补贴'], keywords: [], income: true }, { name: 'AI订阅', categories: ['AI工具'], keywords: [], income: false },
  { name: '话费', categories: ['通讯', '话费'], keywords: [], income: false },
];
function recurringView() {
  const L = computeLookup(), rules = shared.get('recurring', store.get('hl.recurring', RECURRING_DEFAULT));
  const now = new Date(), months = [];
  for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(`${d.getFullYear()}-${d.getMonth() + 1}`); }
  const key = (t) => { const d = dayToDate(t.date); return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`; };
  const items = rules.map((r) => {
    const list = allTxs().filter((t) => !t.excluded && t.kind === (r.income ? KIND.INCOME : KIND.EXPENSE) && ((r.categories ?? []).some((c) => c === catOf(t)?.name || c === L.top(t.categoryId)?.name) || (r.keywords ?? []).some((k) => k && (t.note ?? '').toLowerCase().includes(k.toLowerCase())))).sort(byNewest);
    const per = months.map((mm) => sum(list.filter((t) => key(t) === mm), (t) => t.amountCents)), paid = per.filter((x) => x > 0);
    return { r, list, per, avg: paid.length ? Math.round(sum(paid, (x) => x) / paid.length) : 0, cur: per[11] };
  });
  const cats = [...state.data.category.values()].map((c) => c.name).filter((v, i, a) => a.indexOf(v) === i).sort();
  const cards = items.map((it, idx) => {
    const o = state.openKey === 'r' + idx, max = Math.max(1, ...it.per), color = it.r.income ? 'var(--income)' : 'var(--primary)';
    const bars = it.per.map((c, i) => { const hh = c > 0 ? Math.max(3, 34 * c / max) : 2; return `<rect x="${i * 20 + 4}" y="${36 - hh}" width="12" height="${hh}" rx="3" fill="${color}" opacity="${c > 0 ? 1 : 0.2}"><title>${ymLabel(...months[i].split('-').map(Number))} ${money(c)}</title></rect>`; }).join('');
    return `<div class="card"><div class="row click" data-act="open-key" data-v="r${idx}" style="padding:0">${iconTile(state.data.category.get([...state.data.category.values()].find((c) => (it.r.categories ?? []).includes(c.name))?.id)?.icon ?? 'calendar')}
      <div class="main"><div class="title">${h(it.r.name)} ${o ? '▴' : '▾'}</div><div class="sub ${it.cur > 0 ? '' : 'amber'}">${it.cur > 0 ? tr('本月 ', 'This month ') + money(it.cur) : tr('本月还没有', 'None this month')}</div></div>
      <div class="right"><div class="num ${it.r.income ? 'in' : ''}">${it.r.income ? '+' : ''}${money(it.avg)}</div><div class="muted small">${tr('月均', 'Avg/mo')}</div></div></div>
      <svg viewBox="0 0 240 36" style="width:100%;height:36px;margin-top:8px" role="img" aria-label="${tr('近 12 个月', 'Last 12 months')}">${bars}</svg>
      <div class="rc-axis"><span>${ymLabel(...months[0].split('-').map(Number))}</span><span>${tr('近 12 个月', 'Last 12 months')} ${money(sum(it.per, (x) => x))}</span><span>${ymLabel(...months[11].split('-').map(Number))}</span></div>
      ${o ? `${rowsOf(it.list.slice(0, 200), L)}<button class="btn link danger" data-act="rule-remove" data-v="${idx}">${tr('移除这一项', 'Remove')}</button>` : ''}</div>`;
  }).join('');
  const out = items.filter((i) => !i.r.income), inc = items.filter((i) => i.r.income);
  // 自动记账（schedules.js）：和手机端一样放在这页的汇总卡下面
  const auto = typeof schedRecurringCard === 'function' ? schedRecurringCard() : '';
  return `<div class="cols"><div class="grid sticky"><div class="card grid"><div><div class="muted small">${tr('每月固定支出约', 'Fixed spending / mo ≈')}</div><div class="big num">${money(sum(out, (i) => i.avg))}</div></div>
      <div class="between small muted"><span>${tr('固定收入约', 'Fixed income ≈')} ${money(sum(inc, (i) => i.avg))}</span><span>${tr('本月已有', 'This month')} ${items.filter((i) => i.cur > 0).length}/${items.length}</span></div>
      ${state.addingRule ? `<label class="f">${tr('名称', 'Name')}<input id="r-name"></label><label class="f">${tr('类型', 'Type')}<select id="r-income"><option value="0">${tr('支出', 'Expense')}</option><option value="1">${tr('收入', 'Income')}</option></select></label>
        <label class="f">${tr('分类', 'Category')}<select id="r-cat"><option value="">${tr('（不按分类）', '(any)')}</option>${cats.map((c) => `<option>${h(c)}</option>`).join('')}</select></label><label class="f">${tr('或备注里含', 'Or note contains')}<input id="r-kw"></label>
        <div class="between"><button class="btn" data-act="rule-cancel">${tr('取消', 'Cancel')}</button><button class="btn primary" data-act="rule-save">${tr('保存', 'Save')}</button></div>` : `<button class="btn" data-act="rule-add">＋ ${tr('添加项目', 'Add item')}</button>`}
</div>${auto}</div>
    <div class="grid">${cards}</div></div>${auto && state.schedEdit ? schedDialog() : ''}`;
}

// ---------------------------------------------------------------- 导出（和手机端同一种表格）

function exportCsv() {
  const L = computeLookup(), q = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  const lines = ['﻿时间,类型,分类,二级分类,金额,账本,转出账户,转入账户,备注,报销,标签,币种,原币金额'];
  for (const t of allTxs().sort(byNewest)) {
    const leaf = catOf(t), top = L.top(t.categoryId), foreign = t.currency && t.origCents > 0 && t.currency !== HOME;
    lines.push([dayISO(t.date), ['支出', '收入', '转账'][t.kind], t.kind === KIND.TRANSFER ? '转账' : top?.name ?? '', leaf && leaf.parentId ? leaf.name : '',
      (t.kind === KIND.EXPENSE ? '-' : '') + (t.amountCents / 100).toFixed(2), q(state.data.ledger.get(t.ledgerId)?.name), q(state.data.account.get(t.accountId)?.name), q(state.data.account.get(t.toAccountId)?.name),
      q(t.note), ['', '待报销', '已报销'][t.reimburse ?? 0], q((t.tags ?? '').split(' ').filter(Boolean).map((x) => '#' + x).join(' ')), foreign ? t.currency : HOME, ((foreign ? t.origCents : t.amountCents) / 100).toFixed(2)].join(','));
  }
  const name = `${tr('行星记账', 'PlanetLedger')}-${new Date().toISOString().slice(0, 10)}.csv`, blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  // iPhone 上装成主屏幕 App 时下载链接没反应：用系统的分享面板（存到"文件"、发给别人）
  const file = typeof File === 'function' ? new File([blob], name, { type: 'text/csv' }) : null;
  if (IS_IOS && file && navigator.canShare?.({ files: [file] })) { navigator.share({ files: [file] }).catch(() => { /* 用户取消了 */ }); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- 这些页面的点击和选择

async function moreAction(act, v, el) {
  const toggle = (key, value) => { state[key] = state[key] === value ? null : value; };
  switch (act) {
    // 详情里点它抵扣的那几笔：一页一页往里走，返回时一页一页回来（和 App 的页面栈一样）
    case 'view': if (state.q.trim()) rememberSearch(state.q); if (state.view != null && state.view !== Number(v)) (state.viewStack ??= []).push(state.view); state.view = Number(v); break;
    // 给这笔支出记一笔补贴、退款或代付收回（editor.js 的 startOffset 带好抵扣关系）
    case 'view-offset': {
      const t = state.data.tx.get(state.view);
      if (t && typeof startOffset === 'function') { startOffset(t, v); return true; }
      return true;
    }
    case 'view-copy': {
      // 同样一笔记到今天，留在这页，底部可以撤销（editor.js 的 edCopy）
      if (typeof edCopy === 'function') { await edCopy(state.data.tx.get(state.view)); return true; }
      // 同样一笔记到今天；报销状态回到"待报销"，抵扣关系不带过去
      const t = state.data.tx.get(state.view);
      const copy = { ...t, id: newId(), date: today(), createdAt: Date.now(), offsetOf: 0, offsetParts: '', reimburse: t.reimburse ? 1 : 0 };
      try { await saveRecord('tx', copy); state.view = copy.id; } catch (e) { state.error = e.message; }
      break;
    }
    case 'search-open': state.searching = true; setTimeout(() => document.getElementById('q')?.focus()); break;
    case 'search-close': state.searching = false; state.q = ''; break;
    case 'search-clear': state.q = ''; setTimeout(() => document.getElementById('q')?.focus()); break;
    case 'search-pick': state.q = v; if (el.dataset.r) rememberSearch(v); break;
    case 'search-recent-clear': store.del('hl.recentSearches'); break;
    case 'close-view': if (el !== lastClickTarget) return true; state.view = null; break;
    // 账户设置：管理模块的账户弹窗直接盖在账户详情上（里面能改名、币种、初始余额、归档、删除）
    case 'acc-settings': for (const f of MOD.actions) if (await f('mg-acc-edit', v, el)) return true; break;
    // 在这个账户里直接记一笔：记账页默认就是这个账户（币种也跟着它）
    case 'acc-add':
      if (typeof startEditWith === 'function') { startEditWith({ accountId: Number(v) }); return true; }
      startEdit(null); if (state.editing) state.editing.accountId = Number(v); break;
    case 'acc-archived': state.showArchived = !state.showArchived; break;
    // 修正当前余额：ai.js 的 fixBalance（同手机端 checkBalance），弹窗画在页面外面，保存了再重画
    case 'acc-fix': try { if (await fixBalance(Number(v))) render(); } catch (e) { state.error = e.message; render(); } return true;
    // 资产页的专题入口、返回：记住列表滚到哪了，回来时还在那
    case 'asset-go': state.assetsY = scrollY; state.assetTab = v; state.accountId = null; state.project = null; state.openKey = null; render(); scrollTo(0, 0); return true;
    case 'asset-back':
      if (typeof LOAN !== 'undefined') Object.assign(LOAN, { open: null, loose: false, add: null, assign: null, err: '' });
      state.assetTab = 'accounts'; state.project = null; state.openKey = null; render(); scrollTo(0, state.assetsY ?? 0); return true;
    case 'trend-pick': { const i = Number(v), k = trendKey(); state.trendPick = state.trendPick?.key === k && state.trendPick.i === i ? null : { key: k, i }; break; }
    case 'close-view-btn': viewBack(); break;
    case 'view-delete': if (!await pgConfirm(tr('删除这笔账单？', 'Delete this entry?'), { ok: tr('删除', 'Delete'), danger: true })) return true;
      if (typeof edRemove === 'function') { const t = state.data.tx.get(state.view); viewBack(); await edRemove(t); return true; } try { await deleteRecord('tx', state.view); viewBack(); } catch (e) { state.error = e.message; } break;
    case 'period': state.period = v; break;
    case 'section': state.section = v; state.openTop = null; state.openSub = null; state.openTag = null; break;
    case 'chart': state.line = v === '1'; break;
    case 'open-sub': toggle('openSub', Number(v)); break;
    case 'open-tag': toggle('openTag', v); break;
    case 'st-tag': if (hasTagPage()) { openTagDetail(v); break; } toggle('openTag', v); break;
    case 'left-out': state.openLeftOut = !state.openLeftOut; break;
    case 'cal-day': state.calDay = Number(v); break;
    case 'subsidy-range': state.subsidyAll = v === '1'; state.openKey = null; break;
    case 'subsidy-link': {
      try { const n = await linkSubsidies(); if (typeof edToast === 'function') edToast(n ? tr(`关联了 ${n} 笔`, `Linked ${n}`) : tr('没有找到能关联的', 'Nothing to link')); } catch (e) { state.error = e.message; }
      break;
    }
    // 给选中的那天记一笔
    case 'cal-add':
      if (typeof startEditWith === 'function') { startEditWith({ date: Number(v) }); return true; }
      startEdit(null); if (state.editing) state.editing.date = Number(v); break;
    case 'account': state.assetsY = scrollY; state.accountId = Number(v); render(); scrollTo(0, 0); return true;
    case 'account-back': state.accountId = null; render(); scrollTo(0, state.assetsY ?? 0); return true;
    case 'rmode': state.rmode = v; break;
    case 'project': state.project = v; break;
    case 'project-back': state.project = null; state.rFilter = 0; break;
    case 'r-filter': state.rFilter = Number(v); break;
    case 'r-mark': { const t = state.data.tx.get(Number(v)); if (t) try { await saveRecord('tx', { ...t, reimburse: 2 }); } catch (e) { state.error = e.message; } break; }
    case 'r-mark-all': try { for (const [e] of findReimbursed(computeLookup())) await saveRecord('tx', { ...e, reimburse: 2 }); } catch (e) { state.error = e.message; } break;
    case 'r-ignore': store.set('hl.ignoredReimb', [...store.get('hl.ignoredReimb', []), v]); break;
    case 'r-in': { const t = state.data.tx.get(Number(v)); state.rIn = { id: t.id, account: 0, amount: '', date: today(), err: '' }; break; }
    case 'r-in-x': if (el !== lastClickTarget) return true; state.rIn = null; break;
    case 'r-in-cancel': state.rIn = null; break;
    case 'r-in-save': try { await reimburseInSave(); } catch (e) { state.rIn.err = e.message; } break;
    case 'open-key': toggle('openKey', v); break;
    case 'toggle-reimburse': { const t = state.data.tx.get(Number(v)); try { await saveRecord('tx', { ...t, reimburse: t.reimburse === 1 ? 2 : 1 }); } catch (e) { state.error = e.message; } break; }
    case 'rule-add': state.addingRule = true; break;
    case 'rule-cancel': state.addingRule = false; break;
    case 'rule-save': {
      const name = document.getElementById('r-name').value.trim(), cat = document.getElementById('r-cat').value, kw = document.getElementById('r-kw').value.trim();
      if (name && (cat || kw)) { await shared.set('recurring', [...shared.get('recurring', store.get('hl.recurring', RECURRING_DEFAULT)).filter((r) => r.name !== name), { name, categories: cat ? [cat] : [], keywords: kw ? [kw] : [], income: document.getElementById('r-income').value === '1' }]); state.addingRule = false; }
      break;
    }
    case 'rule-remove': { const rules = shared.get('recurring', store.get('hl.recurring', RECURRING_DEFAULT)); if (await pgConfirm(tr(`移除「${rules[Number(v)].name}」？`, `Remove "${rules[Number(v)].name}"?`), { ok: tr('移除', 'Remove'), danger: true, detail: tr('账单不会被删除', 'Entries stay') })) { rules.splice(Number(v), 1); await shared.set('recurring', rules); state.openKey = null; } break; }
    case 'export': exportCsv(); return true;
    default: return false;
  }
  render();
  return true;
}

async function moreChange(ev) {
  if (ev.target.dataset.change === 'r-in-acc' && state.rIn) {
    // 换了收款账户：金额的币种跟着变，已填的金额、日期留着
    state.rIn.account = Number(ev.target.value); state.rIn.amount = document.getElementById('r-in-amt')?.value ?? '';
    const d = document.getElementById('r-in-date')?.value; if (d) state.rIn.date = isoToDay(d);
    render(); return true;
  }
  if (ev.target.dataset.change !== 'set-project') return false;
  const t = state.data.tx.get(Number(ev.target.dataset.v));
  try { await saveRecord('tx', { ...t, project: ev.target.value }); } catch (e) { state.error = e.message; }
  render();
  return true;
}
