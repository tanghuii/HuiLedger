// 辉记账本网页版：和手机端对齐的那些页面（详情、搜索、日历、统计、报销项目、补贴、周期性收支、账户明细、导出）。
// 这个文件在 app.js 之前加载，只放函数；用到的 state、money、txRow 等都在 app.js 里，调用时才去找。
'use strict';

const byNewest = (a, b) => b.date - a.date || (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id - a.id;
const allTxs = () => [...state.data.tx.values()];
const catOf = (t) => state.data.category.get(t.categoryId);
const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);
const seg = (act, options, current) => `<div class="seg">${options.map(([v, n]) => `<button class="${String(current) === String(v) ? 'on' : ''}" data-act="${act}" data-v="${v}">${n}</button>`).join('')}</div>`;
const rowsOf = (list, L, showDate = true) => list.map((t) => txRow(t, L, showDate)).join('');
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
  const sub = { calendar: '日历', ask: '问账本', ...Object.fromEntries(MOD.me.map((m) => [m.key, m.name])) }[state.tab];
  const back = sub ? `<div class="subbar"><button class="round" data-act="tab" data-v="me" aria-label="返回">‹</button><b>${h(sub)}</b></div>` : '';
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

/** 资产页：账户，加上对账、报销、补贴、周期性收支这几个和钱有关的专题。 */
function assetsView() {
  const tab = state.assetTab;
  const bar = `<div class="card" style="padding:8px">${seg('asset-tab', [['accounts', '账户'], ['reconcile', '对账'], ['reimburse', '报销'], ['subsidy', '补贴'], ['recurring', '周期性']], tab)}</div>`;
  return `<div class="grid">${bar}${tab === 'reconcile' ? reconcileView() : tab === 'reimburse' ? reimburseView() : tab === 'subsidy' ? subsidyView() : tab === 'recurring' ? recurringView() : accountsView()}</div>`;
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
  const title = transfer ? `${h(from?.name ?? '?')} → ${h(to?.name ?? '?')}` : !leaf ? '未分类' : leaf.parentId ? `${h(top?.name)} · ${h(leaf.name)}` : h(leaf.name);
  // 顶部一张彩色卡：颜色取自分类图标，转账用主题色
  const tint = transfer ? 'var(--card-tint)' : cardColor((ICONS[leaf?.icon] ?? ICONS.tag).c);
  const badges = [t.reimburse === 1 ? '待报销' : t.reimburse === 2 ? '已报销' : '', t.excluded ? '不计入收支' : ''].filter(Boolean);
  const tags = (t.tags ?? '').split(' ').filter(Boolean);
  const cell = (k, v) => `<div class="cell"><div class="muted">${k}</div><div class="v">${v}</div></div>`;
  const cells = [
    transfer ? '' : cell('账户', `${accountTile(from)}<span>${h(from?.name ?? '?')}</span>`),
    cell('日期', `${dayISO(t.date)} · ${WEEK[dayToDate(t.date).getUTCDay()]}`),
    tags.length ? cell('标签', tags.map((x) => `<span class="badge gray" style="margin:0">#${h(x)}</span>`).join('')) : '',
    t.project ? cell('项目', h(t.project)) : '', t.fund ? cell('资金来源', h(t.fund)) : '',
    t.loanPerson ? cell(t.loanSide === 1 ? '借出给' : '借自', h(t.loanPerson)) : '',
    cell('账本', h(state.data.ledger.get(t.ledgerId)?.name ?? '')),
  ].filter(Boolean).join('');
  return `<div class="modal" data-act="close-view"><div class="card grid" role="dialog" aria-label="账单详情">
    <div class="card cc hero" style="--cc:${tint}"><button class="x" data-act="close-view-btn" aria-label="关闭">✕</button>
      <div class="halo">${transfer ? accountTile(to) : iconTile(leaf?.icon ?? 'tag')}</div>
      <div class="muted" style="font-weight:600">${title}</div>
      <div class="big amt ${t.kind === KIND.INCOME ? 'in' : t.kind === KIND.EXPENSE ? 'out' : ''}">${t.kind === KIND.INCOME ? '+' : t.kind === KIND.EXPENSE ? '-' : ''}${foreign ? money(t.origCents, t.currency) : money(t.amountCents)}</div>
      ${foreign ? `<div class="muted small">≈ ${money(t.amountCents)}</div>` : ''}${offset > 0 ? `<div class="muted small">抵扣 ${money(offset)} 后实际 ${money(L.net(t))}</div>` : ''}
      ${badges.length ? `<div class="tags">${badges.map((b) => `<span>${b}</span>`).join('')}</div>` : ''}
    </div>
    <div class="cell"><div class="muted">备注</div><div class="note ${t.note ? '' : 'muted'}">${h(t.note) || '无'}</div></div>
    <div class="cells">${cells}</div>
    ${linked.length ? `<div><div class="muted small">它抵扣的支出</div>${rowsOf(linked, L)}</div>` : ''}
    ${offsetBy.length ? `<div><div class="muted small">抵扣它的补贴、退款</div>${rowsOf(offsetBy, L)}</div>` : ''}
    <div class="btns3"><button class="btn danger" data-act="view-delete">删除</button><button class="btn" data-act="view-copy">复制</button><button class="btn primary" data-act="edit" data-v="${t.id}">修改</button></div>
  </div></div>`;
}

// ---------------------------------------------------------------- 搜索：所有账本、所有时间

function searchView() {
  const L = computeLookup(), acc = state.data.account, cat = state.data.category;
  const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  const text = (t) => {
    const leaf = cat.get(t.categoryId), top = L.top(t.categoryId), iso = dayISO(t.date), d = dayToDate(t.date);
    return [t.note, t.tags, leaf?.name, top?.name, acc.get(t.accountId)?.name, acc.get(t.toAccountId)?.name, state.data.ledger.get(t.ledgerId)?.name, t.project, t.fund,
      (t.amountCents / 100).toFixed(2), t.origCents ? (t.origCents / 100).toFixed(2) : '', t.currency, iso, `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`, `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`,
      ['支出', '收入', '转账'][t.kind], L.isReimburse(t) ? '报销' : '', t.excluded ? '不计' : ''].filter(Boolean).join(' ').toLowerCase();
  };
  // 胶囊形的搜索框：左边放大镜，有字时右边一个清除
  const box = `<div class="between"><div class="sbox">${SEARCH_SVG}<input id="q" value="${h(state.q)}" placeholder="备注、分类、账户、标签、金额、日期" autocomplete="off" enterkeyhint="search" aria-label="搜索">
      ${state.q ? '<button class="x" data-act="search-clear" aria-label="清除">✕</button>' : ''}</div><button class="btn" data-act="search-close">取消</button></div>`;
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
      recent.length ? block(['最近搜索', '<button class="btn link small" style="padding:0" data-act="search-recent-clear">清空</button>'], recent.map((w) => chip(w)).join('')) : '',
      cats.length ? block(['常用分类'], cats.map((c) => chip(c.name, iconTile(c.icon ?? 'tag'), true)).join('')) : '',
      tags.length ? block(['常用标签'], tags.map((x) => chip(x, `<span class="tile" style="background:var(--primary)">${h(x.slice(0, 2).toUpperCase())}</span>`, true)).join('')) : '',
    ].filter(Boolean);
    return wrap(parts.length ? `<div class="card grid">${parts.join('')}</div>` : '');
  }
  const hits = allTxs().filter((t) => { const s = text(t); return words.every((w) => s.includes(w)); }).sort(byNewest);
  if (!hits.length) return wrap('<div class="card muted">没找到</div>');
  const out = sum(hits.filter((t) => t.kind === KIND.EXPENSE), (t) => t.amountCents), inc = sum(hits.filter((t) => t.kind === KIND.INCOME), (t) => t.amountCents);
  // 结果：顶上一张合计卡片，下面按月分组
  const months = new Map();
  for (const t of hits.slice(0, 500)) { const d = dayToDate(t.date), k = `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月`; if (!months.has(k)) months.set(k, []); months.get(k).push(t); }
  return wrap(`<div class="card sum3"><div><div class="muted small">笔数</div><div class="num">${hits.length}</div></div><div><div class="muted small">支出</div><div class="num out">${money(out)}</div></div><div><div class="muted small">收入</div><div class="num in">${money(inc)}</div></div></div>
    ${[...months.entries()].map(([k, l]) => `<div class="card"><div class="dayhead"><span>${k}</span><span>${l.length} 笔</span></div>${rowsOf(l, L)}</div>`).join('')}
    ${hits.length > 500 ? '<p class="muted small" style="margin:0">只显示前 500 笔</p>' : ''}`);
}
const SEARCH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';
/** 最近搜过的词存在这个浏览器里，最多 10 个。 */
function rememberSearch(q) {
  const w = String(q ?? '').trim();
  if (w) store.set('hl.recentSearches', [w, ...store.get('hl.recentSearches', []).filter((x) => x !== w)].slice(0, 10));
}

// ---------------------------------------------------------------- 日历

function calendarView() {
  const L = computeLookup(), { y, m } = state.month, txs = monthTxs();
  const days = new Map();
  for (const t of txs) { if (!days.has(t.date)) days.set(t.date, []); days.get(t.date).push(t); }
  const first = epochDay(y, m, 1), count = new Date(y, m, 0).getDate();
  const lead = (dayToDate(first).getUTCDay() + 6) % 7; // 周一开头
  const now = today();
  const selected = state.calDay != null && state.calDay >= first && state.calDay < first + count ? state.calDay : (now >= first && now < first + count ? now : first);
  // 每天的进和出分开：退款算在"收"里
  const dayNums = (items) => { const t = L.totals(items ?? []); return { out: t.expense + t.refund, inc: t.income + t.refund }; };
  const compact = (c) => (c >= 100000 ? (c / 100000).toFixed(1) + 'k' : c >= 10000 ? Math.round(c / 100) : (c / 100).toFixed(c % 100 ? 1 : 0));
  // 热力：这个月花得最多的那天最深，其余按比例（开根号，小额也看得出来）
  const nums = Array.from({ length: count }, (_, d) => dayNums(days.get(first + d)));
  const peak = Math.max(1, ...nums.map((x) => x.out));
  const heat = (a) => `color-mix(in srgb, var(--expense) ${(a * 100).toFixed(1)}%, transparent)`;
  let cells = '<i></i>'.repeat(lead);
  for (let d = 0; d < count; d++) {
    const day = first + d, n = nums[d], isToday = day === now;
    const bg = n.out > 0 && day !== selected ? ` style="background:${heat(0.07 + 0.38 * Math.sqrt(n.out / peak))}"` : '';
    cells += `<button class="cal ${day === selected ? 'on' : ''} ${isToday ? 'today' : ''}" data-act="cal-day" data-v="${day}"${bg}><b>${d + 1}</b>${n.out > 0 ? `<span class="out">-${compact(n.out)}</span>` : ''}${n.inc > 0 ? `<span class="in">+${compact(n.inc)}</span>` : ''}${!n.out && !n.inc && isToday ? '<i class="dot"></i>' : !n.out && !n.inc && days.has(day) ? '<span class="muted">·</span>' : ''}</button>`;
  }
  const t = L.totals(txs), items = days.get(selected) ?? [], n = dayNums(items);
  return `<div class="cols wide">
    <div class="card">${monthBar()}
      <div class="between small" style="margin:10px 2px"><span class="out">支出 ${money(t.expense)}</span><span class="in">收入 ${money(t.income)}</span><span>结余 ${money(t.income - t.expense)}</span></div>
      <div class="calgrid head">${['一', '二', '三', '四', '五', '六', '日'].map((x, i) => `<i class="${i >= 5 ? 'we' : ''}">${x}</i>`).join('')}</div><div class="calgrid">${cells}</div>
      <div class="legend">少${[0.07, 0.17, 0.29, 0.45].map((a) => `<i style="background:${heat(a)}"></i>`).join('')}多</div></div>
    <div class="card"><div class="dayhead"><span>${dayLabel(selected)}</span><span>支 ${money(n.out)}  收 ${money(n.inc)}</span></div>${items.length ? rowsOf(items, L, false) : '<p class="muted">这天没有账单</p>'}</div></div>`;
}

// ---------------------------------------------------------------- 统计：总览 / 分类 / 标签

function rangeTxs() {
  const { y, m } = state.month;
  const [from, to] = state.period === 'y' ? [epochDay(y, 1, 1), epochDay(y, 12, 31)] : state.period === 'a' ? [-1e9, 1e9] : [epochDay(y, m, 1), epochDay(y, m + 1, 0)];
  return allTxs().filter((t) => t.ledgerId === state.ledgerId && t.date >= from && t.date <= to).sort(byNewest);
}

function trendChart(shown, L, color) {
  const { y, m } = state.month, year = state.period === 'y';
  const n = year ? 12 : new Date(y, m, 0).getDate(), v = new Array(n).fill(0);
  for (const t of shown) { const d = dayToDate(t.date); v[(year ? d.getUTCMonth() + 1 : d.getUTCDate()) - 1] += L.net(t); }
  const max = Math.max(1, ...v), W = 600, H = 150, slot = W / n;
  let body;
  if (state.line) {
    const pts = v.map((c, i) => [i * slot + slot / 2, H - (H - 6) * c / max]);
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) { const [ax, ay] = pts[i - 1], [bx, by] = pts[i], mid = (ax + bx) / 2; d += ` C${mid},${ay} ${mid},${by} ${bx},${by}`; }
    body = `<path d="${d} L${pts[n - 1][0]},${H} L${pts[0][0]},${H} Z" fill="${color}" opacity=".18"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`;
  } else body = v.map((c, i) => { const hh = (H - 6) * c / max; return hh > 0 ? `<rect x="${i * slot + slot * 0.18}" y="${H - hh}" width="${slot * 0.64}" height="${hh}" rx="${Math.min(6, slot * 0.3)}" fill="${color}"><title>${year ? i + 1 + '月' : i + 1 + '日'} ${money(c)}</title></rect>` : ''; }).join('');
  return `<div class="card"><div class="between"><b class="muted">${year ? '每月趋势' : '每日趋势'}</b><div style="width:140px">${seg('chart', [[0, '柱状'], [1, '曲线']], state.line ? 1 : 0)}</div></div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin-top:10px" role="img" aria-label="趋势图">${body}</svg>
    <div class="between small muted"><span>1</span><span>最高 ${money(max)}</span><span>${n}</span></div></div>`;
}

function statsView2() {
  const L = computeLookup(), kind = state.statsIncome ? KIND.INCOME : KIND.EXPENSE;
  const inRange = rangeTxs(), totals = L.totals(inRange);
  const shown = inRange.filter((t) => t.kind === kind && L.counts(t));
  const total = sum(shown, (t) => L.net(t));
  const { y, m } = state.month, step = state.period === 'y' ? 12 : 1;
  const side = `<div class="card sticky grid">
    ${seg('period', [['m', '月'], ['y', '年'], ['a', '全部']], state.period)}
    ${state.period === 'a' ? '' : `<div class="month"><button class="round" data-act="month" data-v="${-step}" aria-label="上一段">‹</button><b>${state.period === 'y' ? y + '年' : y + '年' + m + '月'}</b><button class="round" data-act="month" data-v="${step}" aria-label="下一段">›</button></div>`}
    ${seg('stats-kind', [[0, '支出'], [1, '收入']], state.statsIncome ? 1 : 0)}
    ${seg('section', [['overview', '总览'], ['category', '分类'], ['tag', '标签'], ['review', '复盘']], state.section)}
    <div><div class="muted small">${state.statsIncome ? '总收入' : '总支出'}</div><div class="big num">${money(total)}</div></div>
  </div>`;
  let main;
  if (state.section === 'review') main = state.period === 'm' ? reviewView() : '<div class="card muted">复盘按月看，先把上面切到"月"。</div>';
  else if (state.section === 'overview') {
    const leftOut = inRange.filter((t) => L.isReimburse(t) || L.isRefund(t) || t.excluded);
    main = `<div class="card cc"><div class="between">
        <div><div class="muted small">支出</div><div class="num out" style="font-size:19px">${money(totals.expense)}</div></div>
        <div><div class="muted small">收入</div><div class="num in" style="font-size:19px">${money(totals.income)}</div></div>
        <div class="right"><div class="muted small">结余</div><div class="num" style="font-size:19px">${money(totals.income - totals.expense)}</div></div></div>
        <div class="muted small" style="margin-top:8px">共 ${inRange.length} 笔</div></div>
      ${state.period === 'a' ? '' : trendChart(shown, L, state.statsIncome ? 'var(--income)' : 'var(--primary)')}
      ${leftOut.length ? `<div class="card"><div class="row click" data-act="left-out" style="padding:0"><div class="main"><div class="muted small">不参与分类统计的部分 ${state.openLeftOut ? '▴' : '▾'}</div>
        <div class="small amber">可报销支出 ${money(totals.reimbursable)} · 报销收入 ${money(totals.reimbursed)}</div><div class="small muted">退款 ${money(totals.refund)}${totals.excluded ? ' · 不计 ' + money(totals.excluded) : ''}</div></div></div>
        ${state.openLeftOut ? rowsOf(leftOut, L) : ''}</div>` : ''}`;
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
        return `<div class="row click indent" data-act="open-sub" data-v="${id}">${iconTile(leaf?.icon ?? g.top?.icon ?? 'tag', 'sm')}<div class="main muted">${leaf && leaf.parentId ? h(leaf.name) : '（未细分）'} · ${l.length} 笔 ${o ? '▴' : '▾'}</div><div class="num muted">${money(c)}</div></div>${o ? `<div class="indent2">${rowsOf(l, L)}</div>` : ''}`;
      }).join('');
      // 和上期比：支出多了红、少了绿；收入反过来；涨十倍以上写"×倍数"
      let change = '';
      if (state.period !== 'a') {
        const p = prev.get(key) ?? 0, diff = g.cents - p, worse = state.statsIncome ? diff < 0 : diff > 0;
        const pct = p ? Math.round(Math.abs(diff) * 100 / p) : 0;
        const label = !p ? '新增' : !diff ? '—' : (diff > 0 ? '▲ ' : '▼ ') + (pct >= 1000 ? '×' + Math.round(g.cents / p) : pct + '%');
        change = `<span class="chg ${!p || !diff ? '' : worse ? 'out' : 'in'}">${label}</span>`;
      }
      // 排名：前三名实心圆，其余淡色数字；占比条以最多的那一类为满
      const badge = rank < 3 ? `<b style="background:color-mix(in srgb, ${def.c} ${90 - rank * 20}%, transparent)">${rank + 1}</b>` : rank + 1;
      return `<div class="row click crow" data-act="open-top" data-v="${key}"><span class="rank">${badge}</span>${iconTile(g.top?.icon ?? 'tag')}
        <div class="main"><div class="line1"><span class="title">${h(g.top?.name ?? '未分类')} <span class="small muted">${open ? '▴' : '▾'}</span></span><span class="num">${money(g.cents)}</span></div>
          <div class="bar thin" style="background:color-mix(in srgb, ${def.c} 12%, transparent)"><i style="width:${Math.max(1, g.cents * 100 / first).toFixed(1)}%;background:linear-gradient(90deg, color-mix(in srgb, ${def.c} 60%, transparent), ${def.c})"></i></div>
          <div class="line2"><span>${total > 0 ? Math.round(g.cents * 100 / total) : 0}% · ${g.items.length} 笔</span>${change}</div></div></div>${inner}`;
    }).join('');
    main = `<div class="card">${rows || '<span class="muted">这段时间没有记录</span>'}</div>`;
  } else {
    const tags = new Map();
    for (const t of shown) for (const tag of (t.tags ?? '').split(' ').filter(Boolean)) { if (!tags.has(tag)) tags.set(tag, []); tags.get(tag).push(t); }
    const rows = [...tags.entries()].map(([tag, l]) => [tag, l, sum(l, (t) => L.net(t))]).sort((a, b) => b[2] - a[2]).map(([tag, l, c]) => {
      const o = state.openTag === tag;
      return `<div class="row click" data-act="open-tag" data-v="${h(tag)}"><span class="tile" style="background:var(--primary)">${h(tag.slice(0, 2).toUpperCase())}</span>
        <div class="main"><div class="title">${h(tag)} ${o ? '▴' : '▾'}</div><div class="sub">${dayISO(Math.min(...l.map((t) => t.date)))} – ${dayISO(Math.max(...l.map((t) => t.date)))} · ${l.length} 笔</div></div><div class="num">${money(c)}</div></div>${o ? `<div class="indent">${rowsOf(l, L)}</div>` : ''}`;
    }).join('');
    main = `<div class="card">${rows || '<span class="muted">这段时间没有带标签的账单</span>'}</div>`;
  }
  return `<div class="cols">${side}<div class="grid">${main}</div></div>`;
}

// ---------------------------------------------------------------- 账户明细

function accountDetailView() {
  const a = state.data.account.get(state.accountId), L = computeLookup(), cur = acctCur(a);
  const list = allTxs().filter((t) => t.accountId === a.id || t.toAccountId === a.id).sort(byNewest);
  const balance = balanceOf(a, list);
  const effects = list.map((t) => effect(a, t));
  const inflow = sum(effects.filter((x) => x > 0), (x) => x), outflow = -sum(effects.filter((x) => x < 0), (x) => x);
  const months = new Map();
  for (const t of list) { const d = dayToDate(t.date), k = `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月`; if (!months.has(k)) months.set(k, []); months.get(k).push(t); }
  // 像一张银行卡：卡面颜色取自这家银行的品牌色，白字
  const notes = [cur !== HOME ? `≈ ${money(toHome(a, balance))}` : '', a.checkedAt > 0 ? `上次核对 ${dayISO(a.checkedAt)}` : '', a.archived ? '已归档' : ''].filter(Boolean).join('  ·  ');
  const stat = (label, cents) => `<div><div class="small muted">${label}</div><div class="num">${money(cents, cur)}</div></div>`;
  return `<div class="cols">
    <div class="grid sticky"><div><button class="btn" data-act="account-back">‹ 全部账户</button></div>
      <div class="card cc acard" style="--cc:${accountFace(a)}">
        <div class="row" style="padding:0"><span class="logo-w lg">${accountTile(a)}</span><div class="main"><div class="title" style="font-weight:600;font-size:16px">${h(a.name)}</div><div class="small muted">${['储蓄', '投资', '信用', '现金'][a.type] ?? ''}账户 · ${list.length} 笔</div></div>
          <span class="small muted" style="display:flex;align-items:center;gap:6px"><span class="flag">${flagOf(cur)}</span>${cur}</span></div>
        <div class="small muted" style="margin-top:22px">余额</div>
        <div class="big bal">${money(balance, cur)}</div>
        ${notes ? `<div class="small muted">${notes}</div>` : ''}
        <div class="stats3">${stat('初始余额', a.initialCents ?? 0)}${stat('累计流入', inflow)}${stat('累计流出', outflow)}</div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="pill" data-act="acc-settings" data-v="${a.id}">账户设置</button><button class="pill" data-act="fix-balance" data-v="${a.id}">修正当前余额</button></div>
      </div></div>
    <div class="grid">${[...months.entries()].map(([k, l]) => `<div class="card"><div class="dayhead"><span>${k}</span><span>${money(sum(l, (t) => effect(a, t)), cur)}</span></div>${rowsOf(l, L)}</div>`).join('') || '<div class="card muted">这个账户还没有账单</div>'}</div></div>`;
}

// ---------------------------------------------------------------- 报销：按项目看

function projectStats(name, L) {
  const list = allTxs().filter((t) => (t.project ?? '') === name && L.isReimburse(t)).sort(byNewest);
  return { list, claim: sum(list.filter((t) => t.kind === KIND.EXPENSE), (t) => t.amountCents), back: sum(list.filter((t) => t.kind === KIND.INCOME), (t) => t.amountCents) };
}
function projectNumbers(p) {
  const gap = p.claim - p.back;
  return `<div class="between" style="margin-top:8px"><div><div class="num" style="font-size:17px">${money(p.claim)}</div><div class="muted small">报销总额</div></div>
    <div><div class="num in" style="font-size:17px">${money(p.back)}</div><div class="muted small">已报销</div></div>
    <div class="right"><div class="num ${gap > 0 ? 'amber' : 'muted'}" style="font-size:17px">${money(Math.abs(gap))}</div><div class="muted small">${gap >= 0 ? '还差' : '多报回'}</div></div></div>`;
}
/** 进度环：报回来的占要报的多少，中间写百分比；全报回来变绿。 */
function progressRing(p) {
  const ratio = p.claim > 0 ? p.back / p.claim : p.back > 0 ? 1 : 0, color = ratio >= 1 ? 'var(--income)' : 'var(--primary)';
  const r = 27.5, len = 2 * Math.PI * r, f = Math.min(1, Math.max(0, ratio));
  return `<div class="ring"><svg viewBox="0 0 62 62" aria-hidden="true"><circle cx="31" cy="31" r="${r}" fill="none" stroke="${color}" stroke-opacity=".14" stroke-width="7"/>
    ${f > 0 ? `<circle cx="31" cy="31" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(len * f).toFixed(2)} ${len.toFixed(2)}"/>` : ''}</svg>
    <b style="color:${color}">${Math.round(Math.min(ratio, 9.99) * 100)}%</b></div>`;
}
function projectCard(name, p) {
  const gap = p.claim - p.back;
  return `<div class="card click" data-act="project" data-v="${h(name)}"><div class="row" style="padding:0;gap:14px">${progressRing(p)}
    <div class="main"><div class="between"><b style="font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(name || '未归项目')}</b><span class="muted small">${p.list.length} 笔</span></div>
      <div class="small muted">已报 <span class="num" style="font-weight:500">${money(p.back)} / ${money(p.claim)}</span></div>
      <div class="num ${gap > 0 ? 'amber' : 'in'}" style="font-size:14px">${gap > 0 ? '还差 ' + money(gap) : gap < 0 ? '多报回 ' + money(-gap) : '已结清'}</div></div></div></div>`;
}
function reimburseView() {
  const L = computeLookup();
  if (state.project != null) {
    const p = projectStats(state.project, L), funds = new Map();
    for (const t of p.list) if (t.fund) { if (!funds.has(t.fund)) funds.set(t.fund, []); funds.get(t.fund).push(t); }
    return `<div class="cols"><div class="grid sticky"><div><button class="btn" data-act="project-back">‹ 全部项目</button></div><div class="card cc grid"><b style="font-size:18px">${h(state.project || '未归项目')}</b>${projectNumbers(p)}</div>
      ${funds.size ? `<div class="card"><div class="muted small">资金来源</div>${[...funds.entries()].map(([f, l]) => `<div class="between small"><span>${h(f)}</span><span class="muted">支 ${money(sum(l.filter((t) => t.kind === KIND.EXPENSE), (t) => t.amountCents))} · 回 ${money(sum(l.filter((t) => t.kind === KIND.INCOME), (t) => t.amountCents))}</span></div>`).join('')}</div>` : ''}</div>
      <div class="card">${p.list.length ? rowsOf(p.list, L) : '<span class="muted">这里还没有账单。在账单的"修改"里填上报销项目即可。</span>'}</div></div>`;
  }
  const head = `<div class="card">${seg('rmode', [['projects', '项目'], ['pending', '待报销'], ['done', '已报销']], state.rmode)}</div>`;
  if (state.rmode === 'projects') {
    const cards = [...projectNames(), ''].map((name) => { const p = projectStats(name, L); return name || p.list.length ? projectCard(name, p) : ''; }).join('');
    return `<div class="grid">${head}<div class="grid three">${cards}</div></div>`;
  }
  const want = state.rmode === 'done' ? 2 : 1;
  const list = allTxs().filter((t) => t.reimburse === want).sort(byNewest);
  const options = (cur) => ['', ...projectNames()].map((n) => `<option value="${h(n)}" ${n === (cur ?? '') ? 'selected' : ''}>${h(n || '（未归项目）')}</option>`).join('');
  return `<div class="grid">${head}<div class="card cc" style="--cc:${want === 1 ? '#E8962E' : '#21A67A'}"><div class="small muted">${want === 1 ? '还没报回来的钱' : '已报销合计'}</div><div class="big">${money(sum(list, (t) => t.amountCents))}</div><div class="small muted">${list.length} 笔</div></div>
    <div class="card">${list.map((t) => `${txRow(t, L, true)}<div class="between small" style="margin:-4px 0 8px 52px"><select class="mini" data-change="set-project" data-v="${t.id}" aria-label="报销项目">${options(t.project)}</select><button class="btn link" data-act="toggle-reimburse" data-v="${t.id}">${want === 1 ? '标为已报销' : '改回待报销'}</button></div>`).join('') || '<span class="muted">没有账单。</span>'}</div></div>`;
}

// ---------------------------------------------------------------- 补贴

function subsidyView() {
  const L = computeLookup();
  const list = allTxs().filter((t) => t.kind === KIND.INCOME && L.top(t.categoryId)?.name === '补贴').sort(byNewest);
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
  return `<div class="cols"><div class="card sticky"><div class="muted small">收到补贴（全部时间）</div><div class="big num">${money(sum(list, (t) => t.amountCents))}</div>
      <div class="between small" style="margin-top:8px"><span class="muted">已抵扣支出 ${money(used)}</span>${loose ? `<span class="amber">${loose} 笔未关联</span>` : ''}</div></div>
    <div class="grid">${[...groups.entries()].map(([k, l]) => { const o = state.openKey === k; return `<div class="card"><div class="row click" data-act="open-key" data-v="${k}" style="padding:0">${iconTile('coins')}<div class="main"><div class="title">${k} ${o ? '▴' : '▾'}</div><div class="sub">${l.length} 笔</div></div><div class="num">${money(sum(l, (t) => t.amountCents))}</div></div>${o ? rowsOf(l, L) : ''}</div>`; }).join('') || '<div class="card muted">还没有补贴记录</div>'}</div></div>`;
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
    const bars = it.per.map((c, i) => { const hh = c > 0 ? Math.max(3, 34 * c / max) : 2; return `<rect x="${i * 20 + 4}" y="${36 - hh}" width="12" height="${hh}" rx="3" fill="${color}" opacity="${c > 0 ? 1 : 0.2}"><title>${months[i].replace('-', '年')}月 ${money(c)}</title></rect>`; }).join('');
    return `<div class="card"><div class="row click" data-act="open-key" data-v="r${idx}" style="padding:0">${iconTile(state.data.category.get([...state.data.category.values()].find((c) => (it.r.categories ?? []).includes(c.name))?.id)?.icon ?? 'calendar')}
      <div class="main"><div class="title">${h(it.r.name)} ${o ? '▴' : '▾'}</div><div class="sub ${it.cur > 0 ? '' : 'amber'}">${it.cur > 0 ? '本月 ' + money(it.cur) : '本月还没有'}</div></div>
      <div class="right"><div class="num ${it.r.income ? 'in' : ''}">${it.r.income ? '+' : ''}${money(it.avg)}</div><div class="muted small">月均</div></div></div>
      <svg viewBox="0 0 240 36" style="width:100%;height:36px;margin-top:8px" role="img" aria-label="近 12 个月">${bars}</svg>
      <div class="muted small">近 12 个月 ${money(sum(it.per, (x) => x))}</div>
      ${o ? `${rowsOf(it.list.slice(0, 200), L)}<button class="btn link danger" data-act="rule-remove" data-v="${idx}">移除这一项</button>` : ''}</div>`;
  }).join('');
  const out = items.filter((i) => !i.r.income), inc = items.filter((i) => i.r.income);
  return `<div class="cols"><div class="card sticky grid"><div><div class="muted small">每月固定支出约</div><div class="big num">${money(sum(out, (i) => i.avg))}</div></div>
      <div class="between small muted"><span>固定收入约 ${money(sum(inc, (i) => i.avg))}</span><span>本月已有 ${items.filter((i) => i.cur > 0).length}/${items.length}</span></div>
      ${state.addingRule ? `<label class="f">名称<input id="r-name"></label><label class="f">类型<select id="r-income"><option value="0">支出</option><option value="1">收入</option></select></label>
        <label class="f">分类<select id="r-cat"><option value="">（不按分类）</option>${cats.map((c) => `<option>${h(c)}</option>`).join('')}</select></label><label class="f">或备注里含<input id="r-kw"></label>
        <div class="between"><button class="btn" data-act="rule-cancel">取消</button><button class="btn primary" data-act="rule-save">保存</button></div>` : '<button class="btn" data-act="rule-add">＋ 添加项目</button>'}
      <p class="muted small" style="margin:0">这里的项目只存在这个浏览器里。</p></div>
    <div class="grid">${cards}</div></div>`;
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
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
  a.download = `辉记账本-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------- 这些页面的点击和选择

async function moreAction(act, v, el) {
  const toggle = (key, value) => { state[key] = state[key] === value ? null : value; };
  switch (act) {
    case 'view': if (state.q.trim()) rememberSearch(state.q); state.view = Number(v); break;
    case 'view-copy': {
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
    case 'acc-settings': state.tab = 'manage'; mgState().tab = 'account'; state.accountId = null; for (const f of MOD.actions) if (await f('mg-acc-edit', v, el)) break; break;
    case 'close-view-btn': state.view = null; break;
    case 'view-delete': if (!confirm('删除这笔账单？')) return true; try { await deleteRecord('tx', state.view); state.view = null; } catch (e) { state.error = e.message; } break;
    case 'period': state.period = v; break;
    case 'section': state.section = v; state.openTop = null; state.openSub = null; state.openTag = null; break;
    case 'chart': state.line = v === '1'; break;
    case 'open-sub': toggle('openSub', Number(v)); break;
    case 'open-tag': toggle('openTag', v); break;
    case 'left-out': state.openLeftOut = !state.openLeftOut; break;
    case 'cal-day': state.calDay = Number(v); break;
    case 'account': state.accountId = Number(v); break;
    case 'account-back': state.accountId = null; break;
    case 'rmode': state.rmode = v; break;
    case 'project': state.project = v; break;
    case 'project-back': state.project = null; break;
    case 'open-key': toggle('openKey', v); break;
    case 'toggle-reimburse': { const t = state.data.tx.get(Number(v)); try { await saveRecord('tx', { ...t, reimburse: t.reimburse === 1 ? 2 : 1 }); } catch (e) { state.error = e.message; } break; }
    case 'rule-add': state.addingRule = true; break;
    case 'rule-cancel': state.addingRule = false; break;
    case 'rule-save': {
      const name = document.getElementById('r-name').value.trim(), cat = document.getElementById('r-cat').value, kw = document.getElementById('r-kw').value.trim();
      if (name && (cat || kw)) { await shared.set('recurring', [...shared.get('recurring', store.get('hl.recurring', RECURRING_DEFAULT)).filter((r) => r.name !== name), { name, categories: cat ? [cat] : [], keywords: kw ? [kw] : [], income: document.getElementById('r-income').value === '1' }]); state.addingRule = false; }
      break;
    }
    case 'rule-remove': { const rules = shared.get('recurring', store.get('hl.recurring', RECURRING_DEFAULT)); if (confirm(`移除「${rules[Number(v)].name}」？账单不会被删除。`)) { rules.splice(Number(v), 1); await shared.set('recurring', rules); state.openKey = null; } break; }
    case 'export': exportCsv(); return true;
    default: return false;
  }
  render();
  return true;
}

async function moreChange(ev) {
  if (ev.target.dataset.change !== 'set-project') return false;
  const t = state.data.tx.get(Number(ev.target.dataset.v));
  try { await saveRecord('tx', { ...t, project: ev.target.value }); } catch (e) { state.error = e.message; }
  render();
  return true;
}
