// 管理：分类 / 账本 / 账户，规则和手机端一样（SettingsScreen 的 CategoriesScreen、LedgersScreen，AccountsScreen 的 AccountDialog）。
// 写进云端的格式和手机端同步写的一样（见 backup.js 里的 HL_JSON）；账本颜色、信用卡还款日是和手机共享的设置。
'use strict';

const mgTypes = () => [[0, tr('储蓄', 'Savings')], [1, tr('投资', 'Investments')], [2, tr('信用', 'Credit')], [3, tr('现金', 'Cash')]];
const MG_CODES = ['EUR', 'CNY', 'USD', 'GBP', 'JPY', 'HKD', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN', 'CZK', 'HUF', 'TRY', 'AUD', 'CAD', 'SGD', 'KRW', 'THB', 'MYR', 'INR', 'NZD', 'ISK', 'RON'];
const MG_COLORS = ['#6C5CE7', '#3B82F6', '#0EA5A4', '#22A06B', '#84A93A', '#E0A100', '#F07C2B', '#E5484D', '#E0569B', '#8A6A4F'];
const mgState = () => (state.mg ??= { tab: 'category', income: false, open: 0, color: 0, edit: null, error: '' });
const mgOrder = (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id;
/** 手机端分类图标里能选的那些（图标表里排在 list 前面的）。 */
const mgIcons = () => { const keys = Object.keys(ICONS), end = keys.indexOf('list'); return end > 0 ? keys.slice(0, end) : keys; };
/** 账本颜色：手机端存的是 ARGB 整数（有符号）。 */
const argbToHex = (v) => '#' + ((Number(v) >>> 0) & 0xFFFFFF).toString(16).padStart(6, '0');
const hexToArgb = (hex) => (0xFF000000 | parseInt(hex.slice(1), 16)) | 0;
const ledgerColor = (id) => { const v = shared.get('ledgerColors', {})?.[String(id)]; return v == null ? null : argbToHex(v); };

/** 一次写很多条（排序、并分类、删账本）：两百条一批；断网就排队，联网后补传。 */
async function mgPutMany(kind, list, deleted = false) {
  if (!list.length) return;
  const rows = list.map((o) => ({ kind, id: deleted ? o : o.id, data: deleted ? {} : o, deleted }));
  try {
    for (let i = 0; i < rows.length; i += 200) {
      await api('POST', '/rest/v1/records?on_conflict=user_id,kind,id', rows.slice(i, i + 200).map((r) => ({ user_id: state.session.user, ...r })), { prefer: 'resolution=merge-duplicates,return=minimal' });
    }
  } catch (e) { if (!isNetworkError(e)) throw e; for (const r of rows) outbox.add(r); }
  for (const r of rows) { if (r.deleted) state.data[kind].delete(r.id); else state.data[kind].set(r.id, r.data); }
  saveSnapshot();
}
/**
 * 一组（同类型的账户、同收支的一级分类）拖成了新顺序 ids：这组占的那几个位置按新顺序填回去，
 * 所有顺序号从 0 重新编，只写变了的（同手机端 LedgerViewModel.reorderAccounts / reorderCategories）。
 */
async function mgReorder(kind, ids) {
  const map = state.data[kind], all = [...map.values()].sort(mgOrder), want = new Set(ids);
  const group = ids.map((id) => map.get(id)).filter(Boolean);
  if (group.length !== ids.length) return;
  const next = [...all];
  all.map((x, i) => (want.has(x.id) ? i : -1)).filter((i) => i >= 0).forEach((slot, n) => { next[slot] = group[n]; });
  await mgPutMany(kind, next.map((x, n) => ((x.sortOrder ?? 0) === n ? null : HL_JSON[kind]({ ...x, sortOrder: n }))).filter(Boolean));
}

// ---------------------------------------------------------------- 长按拖动排序（同手机端 Gestures.kt 的 ReorderColumn）
// 用法：一列的容器带 data-ro="account" / "category"，里面每一项带 data-ro-id="id"（容器的直接子元素）。
// 长按约半秒，这一项浮起来（放大 1.02、半透明、带阴影）跟着手指走，别的项让开；松手按新顺序存。
// 没到时间就移动 = 正常滚动；短按 = 正常点开。拖到屏幕上下边缘时页面自己滚。

const RO = { cand: null, drag: null, swallow: 0, raf: 0 };
const RO_HOLD = 480;
/** 轻轻震一下（开始拖、放下时，同手机端 buzz）；iPhone 网页没有震动就算了。 */
const roBuzz = () => { try { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(10); } catch { /* 没有震动 */ } };

/** 往上找第一个能竖着滚的；没有就是整页。 */
function roScroller(el) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return document.scrollingElement || document.documentElement;
}
const roTop = (sc) => (sc === document.scrollingElement || sc === document.documentElement ? scrollY : sc.scrollTop);

function roCancelCand() { if (RO.cand) { clearTimeout(RO.cand.timer); RO.cand = null; } }

function roStart() {
  const c = RO.cand;
  RO.cand = null;
  if (!c || !c.item.isConnected) return;
  const items = [...c.box.children].filter((el) => el.matches('[data-ro-id]'));
  if (items.length < 2) return;
  const rects = items.map((el) => el.getBoundingClientRect());
  const sc = roScroller(c.box), from = items.indexOf(c.item), isPage = sc === document.scrollingElement || sc === document.documentElement;
  RO.drag = { box: c.box, item: c.item, items, heights: rects.map((r) => r.height), gap: Math.max(0, rects[1].top - rects[0].bottom),
    from, y0: c.y, y: c.y, sc, isPage, top0: roTop(sc), off: 0,
    // 只在这一列的范围里拖；页面最多滚到拖之前的底（拖着的那一项往下移会把页面撑长）
    min: rects[0].top - rects[from].top, max: rects[items.length - 1].bottom - rects[from].bottom,
    maxTop: isPage ? document.documentElement.scrollHeight - innerHeight : sc.scrollHeight - sc.clientHeight };
  c.box.classList.add('ro-on');
  c.item.classList.add('ro-lift');
  c.item.style.touchAction = 'none';
  RO.swallow = Infinity;
  roBuzz();
  roLoop();
}

/** 现在落在第几个位置（同 ReorderColumn.target：越过相邻项一半高度就换位）。 */
function roTarget(d) {
  let t = d.from, left = d.off;
  if (left > 0) while (t < d.items.length - 1) { const hh = d.heights[t + 1] + d.gap; if (left > hh / 2) { left -= hh; t++; } else break; }
  else while (t > 0) { const hh = d.heights[t - 1] + d.gap; if (-left > hh / 2) { left += hh; t--; } else break; }
  return t;
}

function roPaint() {
  const d = RO.drag;
  if (!d) return;
  d.off = Math.min(d.max, Math.max(d.min, d.y - d.y0 + (roTop(d.sc) - d.top0)));
  const to = roTarget(d), dragH = d.heights[d.from] + d.gap;
  d.items.forEach((el, i) => {
    const shift = el === d.item ? d.off : i > d.from && i <= to ? -dragH : i >= to && i < d.from ? dragH : 0;
    el.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

/** 拖着的时候：手指靠近上下边缘，页面跟着滚（越靠边越快）。 */
function roLoop() {
  cancelAnimationFrame(RO.raf);
  const d = RO.drag;
  if (!d) return;
  if (!d.item.isConnected) { roEnd(false); return; }
  const r = d.isPage ? { top: 0, bottom: innerHeight } : d.sc.getBoundingClientRect();
  // 手机上顶部有贴着的标题栏、底部有底栏，边缘区留宽一点
  const zoneTop = r.top + 96, zoneBottom = r.bottom - 110, top = roTop(d.sc);
  let speed = d.y < zoneTop ? -Math.min(18, (zoneTop - d.y) / 5) : d.y > zoneBottom ? Math.min(18, (d.y - zoneBottom) / 5) : 0;
  // 到了这一列的头 / 尾，或者页面滚到头了，就不再滚
  if ((speed < 0 && (d.off <= d.min || top <= 0)) || (speed > 0 && (d.off >= d.max || top >= d.maxTop))) speed = 0;
  if (speed) { speed = Math.max(-top, Math.min(d.maxTop - top, speed)); if (d.isPage) scrollBy(0, speed); else d.sc.scrollTop += speed; roPaint(); }
  RO.raf = requestAnimationFrame(roLoop);
}

async function roEnd(commit = true) {
  cancelAnimationFrame(RO.raf);
  const d = RO.drag;
  RO.drag = null;
  // 长按之后跟着来的那一下点击不算（不然松手就打开了这一项）
  RO.swallow = Date.now() + 450;
  if (!d) return;
  const to = commit ? roTarget(d) : d.from;
  d.box.classList.remove('ro-on');
  d.item.classList.remove('ro-lift');
  d.item.style.touchAction = '';
  for (const el of d.items) el.style.transform = '';
  if (to === d.from || !d.item.isConnected) return;
  // 先在页面上按新顺序摆好（不闪回原位），再存，存完重画
  const order = d.items.filter((el) => el !== d.item);
  order.splice(to, 0, d.item);
  d.box.insertBefore(d.item, to < d.items.length - 1 ? order[to + 1] : d.items[d.items.length - 1].nextSibling);
  roBuzz();
  try { await mgReorder(d.box.dataset.ro, order.map((el) => Number(el.dataset.roId))); } catch (e) { state.error = e.message; }
  render();
}

document.addEventListener('pointerdown', (ev) => {
  if (RO.drag || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
  const item = ev.target.closest?.('[data-ro-id]'), box = item?.parentElement;
  roCancelCand();
  if (!item || !box?.matches('[data-ro]') || ev.target.closest('input, select, textarea') || item.closest('.modal')) return;
  RO.cand = { item, box, x: ev.clientX, y: ev.clientY, pid: ev.pointerId, timer: setTimeout(roStart, RO_HOLD) };
}, true);
document.addEventListener('pointermove', (ev) => {
  if (RO.drag) { RO.drag.y = ev.clientY; roPaint(); ev.preventDefault(); return; }
  // 还没到时间就挪开了：是在滚动或者滑动，不排序
  if (RO.cand && ev.pointerId === RO.cand.pid && Math.hypot(ev.clientX - RO.cand.x, ev.clientY - RO.cand.y) > 8) roCancelCand();
}, { passive: false });
document.addEventListener('pointerup', () => { roCancelCand(); if (RO.drag) roEnd(true); });
document.addEventListener('pointercancel', () => { roCancelCand(); if (RO.drag) roEnd(false); });
// 拖着的时候不让页面跟着手指滚（touch-action 在按下时就定了，只能在这里拦）
document.addEventListener('touchmove', (ev) => { if (RO.drag) ev.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (ev) => { if (RO.cand || RO.drag) ev.preventDefault(); });
document.addEventListener('click', (ev) => {
  if (Date.now() < RO.swallow && ev.target.closest?.('[data-ro-id]')) { ev.stopPropagation(); ev.preventDefault(); RO.swallow = 0; }
}, true);

// ---------------------------------------------------------------- 分类

function mgCategoriesView() {
  // 紧凑的列表（和手机端一样）：一行一个分类，子分类是名字下面的小胶囊；点分类或子分类弹出"修改 / 合并 / 删除"
  const m = mgState(), cats = [...state.data.category.values()].sort(mgOrder);
  const tops = cats.filter((c) => !c.parentId && !!c.isIncome === m.income);
  const chip = (s) => `<button class="mg-chip" data-act="mg-cat-act" data-v="${s.id}">${hmSvg((ICONS[s.icon] ?? ICONS.tag).d)}<span>${h(catName(s))}</span></button>`;
  const rows = tops.map((c) => {
    const subs = cats.filter((s) => s.parentId === c.id);
    return `<div class="mg-crow" data-ro-id="${c.id}"><button class="mg-chead" data-act="mg-cat-act" data-v="${c.id}">${iconTile(c.icon, 'sm')}<b>${h(catName(c))}</b><span class="mg-more">${hmSvg(ICONS.more.d)}</span></button>
      <div class="mg-chips">${subs.map(chip).join('')}<button class="mg-chip add" data-act="mg-cat-new" data-v="${c.id}">＋ ${tr('子分类', 'Sub')}</button></div></div>`;
  }).join('');
  return `<div class="card grid mg-cbar">${seg('mg-income', [[0, tr('支出', 'Expense')], [1, tr('收入', 'Income')]], m.income ? 1 : 0)}
    <div class="between"><span class="muted small">${tr(`${tops.length} 个分类 · 长按拖动排序`, `${tops.length} ${tops.length === 1 ? 'category' : 'categories'} · long-press to reorder`)}</span><button class="btn link" data-act="mg-cat-new" data-v="0">${tr('＋ 新建', '＋ New')}</button></div></div>
    <div class="card mg-clist">${rows ? `<div data-ro="category">${rows}</div>` : `<span class="muted">${tr('暂无分类', 'No categories yet')}</span>`}</div>`;
}

/** 点了一个分类：修改 / 合并到… / 删除。 */
function mgCatActDialog(e) {
  const c = state.data.category.get(e.id);
  if (!c) return '';
  const tops = [...state.data.category.values()].filter((x) => !x.parentId && !!x.isIncome === !!c.isIncome);
  const item = (act, icon, label, cls = '') => `<button class="mg-act ${cls}" data-act="${act}" data-v="${c.id}">${hmSvg(ICONS[icon].d)}<span>${label}</span></button>`;
  return `<div class="mg-acthead">${iconTile(c.icon, 'sm')}<b>${h(catName(c))}</b></div>
    ${item('mg-cat-edit', 'pencil', tr('修改名称和图标', 'Rename / icon'))}${item('mg-cat-merge', 'transfer', tr('合并到其他分类', 'Merge into…'))}
    ${c.parentId || tops.length > 1 ? item('mg-cat-del', 'trash', tr('删除', 'Delete'), 'danger') : ''}`;
}
/** 合并：选要并进哪个分类（同为支出或收入；不能并进自己和自己的子分类）。 */
function mgMergeDialog(e) {
  const from = state.data.category.get(e.id);
  if (!from) return '';
  const cats = [...state.data.category.values()].sort(mgOrder);
  const opt = (c, sub) => `<button class="mg-mopt ${sub ? 'sub' : ''}" data-act="mg-merge-to" data-v="${c.id}">${iconTile(c.icon, 'sm')}<span>${h(catName(c))}</span></button>`;
  const list = cats.filter((c) => !c.parentId && !!c.isIncome === !!from.isIncome && c.id !== from.id)
    .map((t) => opt(t, false) + cats.filter((s) => s.parentId === t.id && s.id !== from.id).map((s) => opt(s, true)).join('')).join('');
  return `<b style="font-size:17px">${tr(`将「${h(catName(from))}」合并至`, `Merge “${h(catName(from))}” into`)}</b><div class="mg-mlist">${list}</div>`;
}

/** 合并分类（同手机端 mergeCategory）：from 的账单都改记到 into，然后删掉 from；from 的子分类挪到 into 下面（into 是子分类时连账单一起并进去）。 */
async function mgMergeCategory(from, into) {
  if (!from || !into || from.id === into.id || into.parentId === from.id || !!from.isIncome !== !!into.isIncome) return;
  const cats = [...state.data.category.values()], move = new Map([[from.id, into.id]]), gone = [from.id], moved = [];
  if (!from.parentId) {
    for (const s of cats.filter((x) => x.parentId === from.id)) {
      if (!into.parentId) moved.push(HL_JSON.category({ ...s, parentId: into.id }));
      else { move.set(s.id, into.id); gone.push(s.id); }
    }
  }
  await mgPutMany('tx', allTxs().filter((t) => move.has(t.categoryId)).map((t) => ({ ...t, categoryId: move.get(t.categoryId) })));
  if (moved.length) await mgPutMany('category', moved);
  await mgPutMany('category', gone, true);
}

function mgCategoryDialog(e) {
  const c = e.obj, isSub = !!c.parentId, tops = [...state.data.category.values()].filter((x) => !x.parentId && !!x.isIncome === !!c.isIncome);
  const title = isSub ? (e.isNew ? tr('新增子分类', 'New subcategory') : tr('修改子分类', 'Edit subcategory')) : e.isNew ? tr('新增分类', 'New category') : tr('修改分类', 'Edit category');
  const canDelete = !e.isNew && (isSub || tops.length > 1);
  return `<div class="between"><b style="font-size:18px">${title}</b>${canDelete ? `<button class="btn link danger" data-act="mg-cat-delete">${tr('删除', 'Delete')}</button>` : ''}</div>
    ${isSub ? `<div class="muted small">${h(state.data.category.get(c.parentId)?.name ?? '')}</div>` : ''}
    <label class="f">${tr('名称', 'Name')}<input id="mg-name" value="${h(c.name)}"></label>
    ${mgIconPicker(c.icon)}`;
}

/** 图标的名字（中文 / 英文），没有名字时返回 key。 */
const mgIconName = (k) => { const n = typeof ICON_NAMES !== 'undefined' ? ICON_NAMES[k] : null; return n ? (LANG === 'en' ? n[1] : n[0]) : k; };
/** 选图标：最上面一排大类名，点哪个就只显示那一类的图标（默认是选中的图标所在的那一类）；
 * 再上面一行显示选中的图标和名字（点哪个就显示哪个，和手机端一样）。 */
function mgIconPicker(cur) {
  const groups = typeof ICON_GROUPS !== 'undefined' ? ICON_GROUPS : [['图标', 'Icons', mgIcons()]];
  const e = mgState().edit;
  // 新建从第一类（餐饮）开始；修改时打开它现在图标所在的那一类，并把那个大类名滚到看得见的地方
  if (e && e.ig == null) {
    e.ig = e.isNew ? 0 : Math.max(0, groups.findIndex((g) => g[2].includes(cur)));
    setTimeout(() => document.querySelector('.mg-igs .on')?.scrollIntoView({ inline: 'center', block: 'nearest' }), 0);
  }
  const gi = Math.min(e?.ig ?? 0, groups.length - 1);
  const btn = (k) => `<button class="${k === cur ? 'on' : ''}" data-act="mg-icon" data-v="${k}" aria-label="${h(mgIconName(k))}" title="${h(mgIconName(k))}">${iconTile(k)}</button>`;
  const rows = Math.max(...groups.map((g) => Math.ceil(g[2].length / 6)));
  return `<div class="mg-icon-cur"><span class="muted small">${tr('图标', 'Icon')}</span>${iconTile(cur, 'sm')}<b>${h(mgIconName(cur))}</b></div>
    <div class="mg-igs" role="tablist">${groups.map(([zh, en], i) => `<button class="${i === gi ? 'on' : ''}" role="tab" aria-selected="${i === gi}" data-act="mg-ig" data-v="${i}">${h(LANG === 'en' ? en : zh)}</button>`).join('')}</div>
    <div class="mg-icons" style="min-height:${rows * 50}px">${groups[gi][2].filter((k) => ICONS[k]).map(btn).join('')}</div>`;
}

/** 删分类（同手机端 deleteCategory）：子分类的账单并回上级；一级分类连同子分类一起删，账单并入同类的"其他"。 */
async function mgDeleteCategory(c) {
  const cats = [...state.data.category.values()].sort(mgOrder), move = new Map(), gone = [];
  if (c.parentId) { move.set(c.id, c.parentId); gone.push(c.id); }
  else {
    const rest = cats.filter((x) => !x.parentId && !!x.isIncome === !!c.isIncome && x.id !== c.id);
    const fallback = rest.find((x) => x.name.startsWith('其他')) ?? rest[rest.length - 1];
    if (!fallback) return;
    for (const s of cats.filter((x) => x.parentId === c.id)) { move.set(s.id, fallback.id); gone.push(s.id); }
    move.set(c.id, fallback.id); gone.push(c.id);
  }
  await mgPutMany('tx', allTxs().filter((t) => move.has(t.categoryId)).map((t) => ({ ...t, categoryId: move.get(t.categoryId) })));
  await mgPutMany('category', gone, true);
}

// ---------------------------------------------------------------- 账本

function mgLedgersView() {
  const m = mgState(), ledgers = [...state.data.ledger.values()].sort((a, b) => a.id - b.id), count = new Map();
  for (const t of state.data.tx.values()) count.set(t.ledgerId, (count.get(t.ledgerId) ?? 0) + 1);
  const rows = ledgers.map((l) => {
    const color = ledgerColor(l.id), on = l.id === state.ledgerId;
    return `<div class="mg-item"><div class="row click" data-act="mg-ledger-pick" data-v="${l.id}">
        <button class="tile mg-ltile ${color ? 'set' : ''}" style="${color ? `background:${color}` : ''}" data-act="mg-color" data-v="${l.id}" aria-label="${tr('颜色', 'Color')}"><svg viewBox="0 0 24 24"><path d="${ICONS.layers.d}"/></svg></button>
        <div class="main"><div class="title">${h(l.name)}${on ? ` <span class="badge">${tr('当前', 'Current')}</span>` : ''}</div><div class="sub">${count.get(l.id) ?? 0} ${tr('笔', count.get(l.id) === 1 ? 'entry' : 'entries')}</div></div>
        <button class="btn link small" data-act="mg-ledger-edit" data-v="${l.id}">${tr('改名', 'Rename')}</button>
        ${ledgers.length > 1 ? `<button class="btn link small danger" data-act="mg-ledger-delete" data-v="${l.id}">${tr('删除', 'Delete')}</button>` : ''}</div>
      ${m.color === l.id ? `<div class="mg-colors">${MG_COLORS.map((c) => `<button style="background:${c}" class="${c === color?.toUpperCase() ? 'on' : ''}" data-act="mg-color-set" data-v="${c}" aria-label="${c}"></button>`).join('')}
        <button class="btn link small" data-act="mg-color-set" data-v="">${tr('跟随外观', 'Follow theme')}</button></div>` : ''}</div>`;
  }).join('');
  return `<div class="card"><div class="between"><span class="muted small">${tr(`${ledgers.length} 个账本`, `${ledgers.length} ledger${ledgers.length === 1 ? '' : 's'}`)}</span><button class="btn link" data-act="mg-ledger-new">${tr('＋ 新建', '＋ New')}</button></div>${rows}</div>`;
}

// ---------------------------------------------------------------- 账户

function mgAccountsView() {
  const accounts = [...state.data.account.values()].sort(mgOrder), due = shared.get('cardDue', {}) ?? {};
  const row = (a) => {
    const sub = [acctCur(a), due[String(a.id)] && a.type === 2 ? tr(`${due[String(a.id)]} 号还款`, `Due day ${due[String(a.id)]}`) : ''].filter(Boolean).join(' · ');
    return `<div class="row click" data-act="mg-acc-edit" data-v="${a.id}" data-ro-id="${a.id}">${accountTile(a)}<div class="main"><div class="title ${a.archived ? 'muted' : ''}">${h(a.name)}</div><div class="sub">${sub}</div></div><span class="muted">›</span></div>`;
  };
  // 同一类、同样归没归档的账户之间长按拖动排序
  const list = (g) => `<div data-ro="account">${g.map(row).join('')}</div>`;
  const groups = mgTypes().map(([type, label]) => {
    const g = accounts.filter((a) => (a.type ?? 0) === type && !a.archived);
    return g.length ? `<div class="card"><div class="dayhead"><span>${label}</span><span>${g.length}</span></div>${list(g)}</div>` : '';
  }).join('');
  const old = accounts.filter((a) => a.archived);
  const archived = old.length ? `<div class="card"><div class="dayhead"><span>${tr('已归档', 'Archived')}</span><span>${old.length}</span></div>${list(old)}</div>` : '';
  return `<div class="card"><div class="between"><span class="muted small">${tr(`${accounts.length} 个账户`, `${accounts.length} account${accounts.length === 1 ? '' : 's'}`)}</span><button class="btn link" data-act="mg-acc-new">${tr('＋ 新建', '＋ New')}</button></div></div>
    ${accounts.length > 1 ? `<div class="muted small mg-hint">${tr('长按拖动排序', 'Long-press to reorder')}</div>` : ''}${groups}${archived}`;
}

function mgAccountDialog(e) {
  const a = e.obj;
  return `<div class="between"><b style="font-size:18px">${e.isNew ? tr('添加账户', 'Add account') : tr('账户设置', 'Account settings')}</b>${e.isNew ? '' : `<button class="btn link danger" data-act="mg-acc-delete">${tr('删除', 'Delete')}</button>`}</div>
    <label class="f">${tr('名称', 'Name')}<input id="mg-name" value="${h(a.name)}" placeholder="${tr('如 ING、支付宝', 'e.g. ING, PayPal')}"></label>
    ${seg('mg-type', mgTypes(), a.type ?? 0)}
    <div class="mg-accicon"><span class="muted">${tr('图标', 'Icon')}</span>
      <button class="chip${a.icon ? '' : ' on'}" data-act="mg-acc-icon" data-v="" aria-pressed="${!a.icon}">${tr('自动', 'Auto')}</button>
      ${BANK_ICONS.map(([k]) => `<button class="ob-icon${a.icon === k ? ' on' : ''}" data-act="mg-acc-icon" data-v="${k}" aria-pressed="${a.icon === k}" aria-label="${k}">${iconTile(k, 'sm')}</button>`).join('')}</div>
    <div class="two"><label class="f">${tr('币种', 'Currency')}<select id="mg-cur">${[...new Set([...MG_CODES, a._cur])].map((c) => `<option value="${c}" ${c === a._cur ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="f">${tr('初始余额', 'Opening balance')}<input id="mg-init" inputmode="decimal" value="${h(a._init)}" placeholder="${tr('0.00，欠款请填负数', '0.00, negative if owed')}"></label></div>
    ${a.type === 2 ? `<label class="f">${tr('还款日（每月几号）', 'Due day (of month)')}<input id="mg-due" inputmode="numeric" value="${h(a._due)}" placeholder="1–31"></label>` : ''}
    ${e.isNew ? '' : `<label class="sc-check"><input type="checkbox" id="mg-arch" ${a.archived ? 'checked' : ''}> ${tr('归档', 'Archived')}</label>`}`;
}

/** 有账单的账户不能删，最后一个账户也不删（同手机端）。 */
const mgAccountUsed = (id) => allTxs().some((t) => t.accountId === id || t.toAccountId === id) || state.data.account.size <= 1;

// ---------------------------------------------------------------- 弹窗（新建 / 修改）

function mgDialog() {
  const e = mgState().edit;
  if (!e) return '';
  // 只有选项、没有表单的弹窗（分类操作、合并）：下面只放一个"取消"
  if (e.kind === 'catact' || e.kind === 'merge') {
    return `<div class="modal" data-bg="mg"><div class="card grid mg-sheet" role="dialog" aria-label="${tr('分类', 'Category')}">${e.kind === 'catact' ? mgCatActDialog(e) : mgMergeDialog(e)}
      ${mgState().error ? `<p class="err" style="margin:0">${h(mgState().error)}</p>` : ''}
      <button class="btn" data-act="mg-cancel">${tr('取消', 'Cancel')}</button></div></div>`;
  }
  const body = e.kind === 'category' ? mgCategoryDialog(e) : e.kind === 'account' ? mgAccountDialog(e)
    : `<b style="font-size:18px">${e.isNew ? tr('新建账本', 'New ledger') : tr('账本改名', 'Rename ledger')}</b><label class="f">${tr('名称', 'Name')}<input id="mg-name" value="${h(e.obj.name)}"></label>`;
  return `<div class="modal" data-bg="mg"><div class="card grid" role="dialog" aria-label="${tr('管理', 'Manage')}">${body}
    ${mgState().error ? `<p class="err" style="margin:0">${h(mgState().error)}</p>` : ''}
    <div class="between"><button class="btn" data-act="mg-cancel">${tr('取消', 'Cancel')}</button><button class="btn primary" data-act="mg-save">${tr('保存', 'Save')}</button></div></div></div>`;
}

function mgCollect() {
  const e = mgState().edit, v = (id) => document.getElementById(id);
  if (!e) return;
  if (v('mg-name')) e.obj.name = v('mg-name').value;
  if (v('mg-cur')) e.obj._cur = v('mg-cur').value;
  if (v('mg-init')) e.obj._init = v('mg-init').value;
  if (v('mg-due')) e.obj._due = v('mg-due').value;
  if (v('mg-arch')) e.obj.archived = v('mg-arch').checked;
}

async function mgSave() {
  mgCollect();
  const m = mgState(), e = m.edit, o = e.obj, name = o.name.trim();
  if (!name) { m.error = tr('请输入名称', 'Enter a name'); return; }
  if (e.kind === 'category') await saveRecord('category', HL_JSON.category({ ...o, name }));
  else if (e.kind === 'ledger') {
    await saveRecord('ledger', HL_JSON.ledger({ ...o, name }));
    if (e.isNew) { state.ledgerId = o.id; store.set('hl.ledger', o.id); }
  } else {
    const text = String(o._init ?? '').trim().replace(',', '.'), init = text ? Number(text) : 0;
    if (!Number.isFinite(init)) { m.error = tr('初始余额不正确', 'Invalid opening balance'); return; }
    const dueText = String(o._due ?? '').trim(), day = Number(dueText);
    if (o.type === 2 && dueText && !(Number.isInteger(day) && day >= 1 && day <= 31)) { m.error = tr('还款日请填写 1–31', 'Due day must be 1–31'); return; }
    await saveRecord('account', HL_JSON.account({ ...o, name, initialCents: Math.round(init * 100), currency: o._cur === HOME ? '' : o._cur }));
    // 信用卡还款日：和手机端共享（cardDue），不是信用卡就去掉
    const due = { ...(shared.get('cardDue', {}) ?? {}) }, key = String(o.id), want = o.type === 2 && dueText ? day : null;
    if ((due[key] ?? null) !== want) { if (want == null) delete due[key]; else due[key] = want; await shared.set('cardDue', due); }
  }
  m.edit = null; m.error = '';
}

// ---------------------------------------------------------------- 页面和动作

function manageView() {
  const m = mgState();
  const body = m.tab === 'ledger' ? mgLedgersView() : m.tab === 'account' ? mgAccountsView() : mgCategoriesView();
  return `<div class="grid mg">${seg('mg-tab', [['category', tr('分类', 'Categories')], ['ledger', tr('账本', 'Ledgers')], ['account', tr('账户', 'Accounts')]], m.tab)}${body}</div>${mgDialog()}`;
}
MOD.pages.manage = () => manageView();
MOD.me.push({ key: 'manage', get name() { return tr('管理', 'Manage'); }, icon: 'blocks', order: 40 });

MOD.actions.push(async (act, v) => {
  if (!act.startsWith('mg-')) return false;
  const m = mgState(), id = Number(v);
  const cats = () => [...state.data.category.values()].sort(mgOrder), accs = () => [...state.data.account.values()].sort(mgOrder);
  try {
    switch (act) {
      case 'mg-tab': m.tab = v; m.open = 0; m.color = 0; break;
      case 'mg-income': m.income = v === '1'; m.open = 0; break;
      case 'mg-open': m.open = m.open === id ? 0 : id; break;
      case 'mg-cat-new': {
        const parent = state.data.category.get(id);
        m.edit = { kind: 'category', isNew: true, obj: { id: newId(), name: '', icon: parent?.icon ?? 'tag', isIncome: parent ? !!parent.isIncome : m.income, sortOrder: state.data.category.size, parentId: parent?.id ?? 0 } };
        break;
      }
      case 'mg-cat-edit': m.edit = { kind: 'category', isNew: false, obj: { ...state.data.category.get(id) } }; break;
      case 'mg-cat-act': m.edit = { kind: 'catact', id }; break;
      case 'mg-cat-merge': m.edit = { kind: 'merge', id }; break;
      case 'mg-merge-to': {
        const from = state.data.category.get(m.edit?.id), into = state.data.category.get(id);
        if (!from || !into) break;
        const n = allTxs().filter((t) => t.categoryId === from.id || state.data.category.get(t.categoryId)?.parentId === from.id).length;
        const subsMove = !from.parentId && !into.parentId && [...state.data.category.values()].some((x) => x.parentId === from.id);
        if (!await uiConfirm(tr(`合并至「${catName(into)}」？`, `Merge into “${catName(into)}”?`), { ok: tr('合并', 'Merge'),
          detail: h(tr(`${n ? `「${catName(from)}」的 ${n} 笔账单将改记至「${catName(into)}」${subsMove ? '，子分类一并移入' : ''}，随后` : subsMove ? `子分类将移至「${catName(into)}」下，随后` : ''}删除「${catName(from)}」。`,
            `${n ? `${n} ${n === 1 ? 'entry moves' : 'entries move'} to “${catName(into)}”${subsMove ? ', with its subcategories' : ''}, then ` : subsMove ? `Its subcategories move to “${catName(into)}”, then ` : ''}“${catName(from)}” is removed.`)) })) return true;
        await mgMergeCategory(from, into); m.edit = null;
        break;
      }
      case 'mg-cat-del': {
        const c = state.data.category.get(id), n = allTxs().filter((t) => t.categoryId === c.id || state.data.category.get(t.categoryId)?.parentId === c.id).length;
        if (!await uiConfirm(tr(`删除「${catName(c)}」？`, `Delete "${catName(c)}"?`), { ok: tr('删除', 'Delete'), danger: true,
          detail: n ? h(tr(`${n} 笔账单并入${c.parentId ? '上级分类' : '「其他」'}`, `${n} ${n === 1 ? 'entry moves' : 'entries move'} to ${c.parentId ? 'the parent' : '"Other"'}`)) : '' })) return true;
        await mgDeleteCategory(c); m.edit = null;
        break;
      }
      case 'mg-icon': mgCollect(); m.edit.obj.icon = v; break;
      case 'mg-ig': mgCollect(); m.edit.ig = id; break;
      case 'mg-cat-delete': {
        const c = m.edit.obj, n = allTxs().filter((t) => t.categoryId === c.id || state.data.category.get(t.categoryId)?.parentId === c.id).length;
        if (!await uiConfirm(tr(`删除「${c.name}」？`, `Delete "${c.name}"?`), { ok: tr('删除', 'Delete'), danger: true,
          detail: n ? h(tr(`${n} 笔账单并入${c.parentId ? '上级分类' : '「其他」'}`, `${n} ${n === 1 ? 'entry moves' : 'entries move'} to ${c.parentId ? 'the parent' : '"Other"'}`)) : '' })) return true;
        await mgDeleteCategory(state.data.category.get(c.id)); m.edit = null;
        break;
      }
      case 'mg-ledger-pick': state.ledgerId = id; store.set('hl.ledger', id); break;
      case 'mg-ledger-new': m.edit = { kind: 'ledger', isNew: true, obj: { id: newId(), name: '' } }; break;
      case 'mg-ledger-edit': m.edit = { kind: 'ledger', isNew: false, obj: { ...state.data.ledger.get(id) } }; break;
      case 'mg-ledger-delete': {
        const l = state.data.ledger.get(id), txs = allTxs().filter((t) => t.ledgerId === id);
        if (state.data.ledger.size <= 1 || !await uiConfirm(tr(`删除账本「${l.name}」？`, `Delete ledger "${l.name}"?`), { ok: tr('删除', 'Delete'), danger: true,
          detail: h(tr(`${txs.length} 笔账单一并删除，无法恢复`, `Its ${txs.length} ${txs.length === 1 ? 'entry' : 'entries'} go too. Can't be undone.`)) })) return true;
        await mgPutMany('tx', txs.map((t) => t.id), true);
        await deleteRecord('ledger', id);
        if (state.ledgerId === id) { state.ledgerId = [...state.data.ledger.keys()][0]; store.set('hl.ledger', state.ledgerId); }
        break;
      }
      case 'mg-color': m.color = m.color === id ? 0 : id; break;
      case 'mg-color-set': {
        const colors = { ...(shared.get('ledgerColors', {}) ?? {}) };
        if (v) colors[String(m.color)] = hexToArgb(v); else delete colors[String(m.color)];
        await shared.set('ledgerColors', colors); m.color = 0;
        break;
      }
      case 'mg-acc-new': {
        const all = accs();
        m.edit = { kind: 'account', isNew: true, obj: { id: newId(), name: '', type: 0, initialCents: 0, sortOrder: all.length ? Math.max(...all.map((a) => a.sortOrder ?? 0)) + 1 : 0, currency: '', archived: false, checkedAt: 0, _cur: HOME, _init: '', _due: '' } };
        break;
      }
      case 'mg-acc-edit': {
        const a = state.data.account.get(id);
        m.edit = { kind: 'account', isNew: false, obj: { ...a, _cur: acctCur(a), _init: a.initialCents ? (a.initialCents / 100).toFixed(2) : '', _due: String(shared.get('cardDue', {})?.[String(id)] ?? '') } };
        break;
      }
      case 'mg-type': mgCollect(); m.edit.obj.type = Number(v); break;
      case 'mg-acc-icon': mgCollect(); m.edit.obj.icon = v || ''; break;
      case 'mg-acc-delete': {
        const a = m.edit.obj;
        if (mgAccountUsed(a.id)) { m.error = tr('仍有账单，无法删除', "Has entries, can't delete"); break; }
        if (!await uiConfirm(tr(`删除账户「${a.name}」？`, `Delete account "${a.name}"?`), { ok: tr('删除', 'Delete'), danger: true })) return true;
        await deleteRecord('account', a.id);
        const due = { ...(shared.get('cardDue', {}) ?? {}) };
        if (String(a.id) in due) { delete due[String(a.id)]; await shared.set('cardDue', due); }
        m.edit = null;
        break;
      }
      case 'mg-cancel': m.edit = null; m.error = ''; break;
      case 'mg-save': await mgSave(); break;
      default: return false;
    }
  } catch (e) { if (m.edit) m.error = e.message; else state.error = e.message; }
  render();
  return true;
});
document.addEventListener('click', (ev) => {
  if (ev.target?.dataset?.bg !== 'mg') return;
  mgState().edit = null; mgState().error = ''; render();
});
