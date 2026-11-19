// 管理：分类 / 账本 / 账户，规则和手机端一样（SettingsScreen 的 CategoriesScreen、LedgersScreen，AccountsScreen 的 AccountDialog）。
// 写进云端的格式和手机端同步写的一样（见 backup.js 里的 HL_JSON）；账本颜色、信用卡还款日是和手机共享的设置。
'use strict';

const MG_TYPES = [[0, '储蓄'], [1, '投资'], [2, '信用'], [3, '现金']];
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
/** 把这一组里的 id 和相邻的换位置，所有顺序号重新编一遍（同手机端 moveAccount / reorderCategories）。 */
async function mgSwap(kind, all, group, id, dir) {
  const at = group.findIndex((x) => x.id === id), other = group[at + dir];
  if (at < 0 || !other) return;
  const list = [...all], i = list.findIndex((x) => x.id === id), j = list.findIndex((x) => x.id === other.id);
  [list[i], list[j]] = [list[j], list[i]];
  await mgPutMany(kind, list.map((x, n) => ((x.sortOrder ?? 0) === n ? null : HL_JSON[kind]({ ...x, sortOrder: n }))).filter(Boolean));
}
const mgMoveBtns = (what, id, i, n) => `<span class="mg-mv"><button data-act="mg-${what}-up" data-v="${id}" ${i === 0 ? 'disabled' : ''} aria-label="上移">↑</button><button data-act="mg-${what}-down" data-v="${id}" ${i === n - 1 ? 'disabled' : ''} aria-label="下移">↓</button></span>`;

// ---------------------------------------------------------------- 分类

function mgCategoriesView() {
  const m = mgState(), cats = [...state.data.category.values()].sort(mgOrder);
  const tops = cats.filter((c) => !c.parentId && !!c.isIncome === m.income);
  const rows = tops.map((c, i) => {
    const subs = cats.filter((s) => s.parentId === c.id), open = m.open === c.id;
    return `<div class="mg-item"><div class="row click" data-act="mg-open" data-v="${c.id}">${iconTile(c.icon)}
        <div class="main"><div class="title">${h(c.name)} <span class="small muted">${open ? '▴' : '▾'}</span></div>${subs.length ? `<div class="sub">${subs.map((s) => h(s.name)).join('、')}</div>` : ''}</div>
        ${mgMoveBtns('cat', c.id, i, tops.length)}<button class="btn link small" data-act="mg-cat-edit" data-v="${c.id}">修改</button></div>
      ${open ? `<div class="indent">${subs.map((s) => `<div class="row click indent" data-act="mg-cat-edit" data-v="${s.id}">${iconTile(s.icon, 'sm')}<div class="main">${h(s.name)}</div><span class="muted">›</span></div>`).join('')}
        <button class="btn link small" data-act="mg-cat-new" data-v="${c.id}">＋ 子分类</button></div>` : ''}</div>`;
  }).join('');
  return `<div class="card grid">${seg('mg-income', [[0, '支出'], [1, '收入']], m.income ? 1 : 0)}
    <div class="between"><span class="muted small">${tops.length} 个分类</span><button class="btn link" data-act="mg-cat-new" data-v="0">＋ 新建</button></div></div>
    <div class="card">${rows || '<span class="muted">还没有分类</span>'}</div>`;
}

function mgCategoryDialog(e) {
  const c = e.obj, isSub = !!c.parentId, tops = [...state.data.category.values()].filter((x) => !x.parentId && !!x.isIncome === !!c.isIncome);
  const title = isSub ? (e.isNew ? '新增子分类' : '修改子分类') : e.isNew ? '新增分类' : '修改分类';
  const canDelete = !e.isNew && (isSub || tops.length > 1);
  return `<div class="between"><b style="font-size:18px">${title}</b>${canDelete ? '<button class="btn link danger" data-act="mg-cat-delete">删除</button>' : ''}</div>
    ${isSub ? `<div class="muted small">${h(state.data.category.get(c.parentId)?.name ?? '')}</div>` : ''}
    <label class="f">名称<input id="mg-name" value="${h(c.name)}"></label>
    <div class="mg-icons">${mgIcons().map((k) => `<button class="${k === c.icon ? 'on' : ''}" data-act="mg-icon" data-v="${k}" aria-label="${k}">${iconTile(k)}</button>`).join('')}</div>`;
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
        <button class="tile mg-ltile ${color ? 'set' : ''}" style="${color ? `background:${color}` : ''}" data-act="mg-color" data-v="${l.id}" aria-label="颜色"><svg viewBox="0 0 24 24"><path d="${ICONS.layers.d}"/></svg></button>
        <div class="main"><div class="title">${h(l.name)}${on ? ' <span class="badge">当前</span>' : ''}</div><div class="sub">${count.get(l.id) ?? 0} 笔</div></div>
        <button class="btn link small" data-act="mg-ledger-edit" data-v="${l.id}">改名</button>
        ${ledgers.length > 1 ? `<button class="btn link small danger" data-act="mg-ledger-delete" data-v="${l.id}">删除</button>` : ''}</div>
      ${m.color === l.id ? `<div class="mg-colors">${MG_COLORS.map((c) => `<button style="background:${c}" class="${c === color?.toUpperCase() ? 'on' : ''}" data-act="mg-color-set" data-v="${c}" aria-label="${c}"></button>`).join('')}
        <button class="btn link small" data-act="mg-color-set" data-v="">跟随外观</button></div>` : ''}</div>`;
  }).join('');
  return `<div class="card"><div class="between"><span class="muted small">${ledgers.length} 个账本</span><button class="btn link" data-act="mg-ledger-new">＋ 新建</button></div>${rows}</div>`;
}

// ---------------------------------------------------------------- 账户

function mgAccountsView() {
  const accounts = [...state.data.account.values()].sort(mgOrder), due = shared.get('cardDue', {}) ?? {};
  const row = (a, i, n) => {
    const sub = [acctCur(a), due[String(a.id)] && a.type === 2 ? `${due[String(a.id)]} 号还款` : ''].filter(Boolean).join(' · ');
    return `<div class="row click" data-act="mg-acc-edit" data-v="${a.id}">${accountTile(a)}<div class="main"><div class="title ${a.archived ? 'muted' : ''}">${h(a.name)}</div><div class="sub">${sub}</div></div>
      ${mgMoveBtns('acc', a.id, i, n)}</div>`;
  };
  const groups = MG_TYPES.map(([type, label]) => {
    const g = accounts.filter((a) => (a.type ?? 0) === type && !a.archived);
    return g.length ? `<div class="card"><div class="dayhead"><span>${label}</span><span>${g.length}</span></div>${g.map((a, i) => row(a, i, g.length)).join('')}</div>` : '';
  }).join('');
  const old = accounts.filter((a) => a.archived);
  const archived = old.length ? `<div class="card"><div class="dayhead"><span>已归档</span><span>${old.length}</span></div>${old.map((a) => row(a, 0, 1)).join('')}</div>` : '';
  return `<div class="card"><div class="between"><span class="muted small">${accounts.length} 个账户</span><button class="btn link" data-act="mg-acc-new">＋ 新建</button></div></div>${groups}${archived}`;
}

function mgAccountDialog(e) {
  const a = e.obj;
  return `<div class="between"><b style="font-size:18px">${e.isNew ? '添加账户' : '账户设置'}</b>${e.isNew ? '' : '<button class="btn link danger" data-act="mg-acc-delete">删除</button>'}</div>
    <label class="f">名称<input id="mg-name" value="${h(a.name)}" placeholder="如 ING、支付宝"></label>
    ${seg('mg-type', MG_TYPES, a.type ?? 0)}
    <div class="two"><label class="f">币种<select id="mg-cur">${[...new Set([...MG_CODES, a._cur])].map((c) => `<option value="${c}" ${c === a._cur ? 'selected' : ''}>${flagOf(c)} ${c}</option>`).join('')}</select></label>
      <label class="f">初始余额<input id="mg-init" inputmode="decimal" value="${h(a._init)}" placeholder="0.00，欠款填负数"></label></div>
    ${a.type === 2 ? `<label class="f">还款日（每月几号）<input id="mg-due" inputmode="numeric" value="${h(a._due)}" placeholder="1–31"></label>` : ''}
    ${e.isNew ? '' : `<label class="sc-check"><input type="checkbox" id="mg-arch" ${a.archived ? 'checked' : ''}> 归档</label>`}`;
}

/** 有账单的账户不能删，最后一个账户也不删（同手机端）。 */
const mgAccountUsed = (id) => allTxs().some((t) => t.accountId === id || t.toAccountId === id) || state.data.account.size <= 1;

// ---------------------------------------------------------------- 弹窗（新建 / 修改）

function mgDialog() {
  const e = mgState().edit;
  if (!e) return '';
  const body = e.kind === 'category' ? mgCategoryDialog(e) : e.kind === 'account' ? mgAccountDialog(e)
    : `<b style="font-size:18px">${e.isNew ? '新建账本' : '账本改名'}</b><label class="f">名称<input id="mg-name" value="${h(e.obj.name)}"></label>`;
  return `<div class="modal" data-bg="mg"><div class="card grid" role="dialog" aria-label="管理">${body}
    ${mgState().error ? `<p class="err" style="margin:0">${h(mgState().error)}</p>` : ''}
    <div class="between"><button class="btn" data-act="mg-cancel">取消</button><button class="btn primary" data-act="mg-save">保存</button></div></div></div>`;
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
  if (!name) { m.error = '请填名称'; return; }
  if (e.kind === 'category') await saveRecord('category', HL_JSON.category({ ...o, name }));
  else if (e.kind === 'ledger') {
    await saveRecord('ledger', HL_JSON.ledger({ ...o, name }));
    if (e.isNew) { state.ledgerId = o.id; store.set('hl.ledger', o.id); }
  } else {
    const text = String(o._init ?? '').trim().replace(',', '.'), init = text ? Number(text) : 0;
    if (!Number.isFinite(init)) { m.error = '初始余额不对'; return; }
    const dueText = String(o._due ?? '').trim(), day = Number(dueText);
    if (o.type === 2 && dueText && !(Number.isInteger(day) && day >= 1 && day <= 31)) { m.error = '还款日填 1–31'; return; }
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
  return `<div class="grid mg">${seg('mg-tab', [['category', '分类'], ['ledger', '账本'], ['account', '账户']], m.tab)}${body}</div>${mgDialog()}`;
}
MOD.pages.manage = () => manageView();
MOD.me.push({ key: 'manage', name: '管理', icon: 'blocks', order: 40 });

MOD.actions.push(async (act, v) => {
  if (!act.startsWith('mg-')) return false;
  const m = mgState(), id = Number(v);
  const cats = () => [...state.data.category.values()].sort(mgOrder), accs = () => [...state.data.account.values()].sort(mgOrder);
  try {
    switch (act) {
      case 'mg-tab': m.tab = v; m.open = 0; m.color = 0; break;
      case 'mg-income': m.income = v === '1'; m.open = 0; break;
      case 'mg-open': m.open = m.open === id ? 0 : id; break;
      case 'mg-cat-up': case 'mg-cat-down': {
        const c = state.data.category.get(id), all = cats();
        await mgSwap('category', all, all.filter((x) => !x.parentId && !!x.isIncome === !!c.isIncome), id, act.endsWith('up') ? -1 : 1);
        break;
      }
      case 'mg-cat-new': {
        const parent = state.data.category.get(id);
        m.edit = { kind: 'category', isNew: true, obj: { id: newId(), name: '', icon: parent?.icon ?? 'tag', isIncome: parent ? !!parent.isIncome : m.income, sortOrder: state.data.category.size, parentId: parent?.id ?? 0 } };
        break;
      }
      case 'mg-cat-edit': m.edit = { kind: 'category', isNew: false, obj: { ...state.data.category.get(id) } }; break;
      case 'mg-icon': mgCollect(); m.edit.obj.icon = v; break;
      case 'mg-cat-delete': {
        const c = m.edit.obj, n = allTxs().filter((t) => t.categoryId === c.id || state.data.category.get(t.categoryId)?.parentId === c.id).length;
        if (!confirm(`删除「${c.name}」？${n ? `${n} 笔账单并入${c.parentId ? '上级分类' : '「其他」'}` : ''}`)) return true;
        await mgDeleteCategory(state.data.category.get(c.id)); m.edit = null;
        break;
      }
      case 'mg-ledger-pick': state.ledgerId = id; store.set('hl.ledger', id); break;
      case 'mg-ledger-new': m.edit = { kind: 'ledger', isNew: true, obj: { id: newId(), name: '' } }; break;
      case 'mg-ledger-edit': m.edit = { kind: 'ledger', isNew: false, obj: { ...state.data.ledger.get(id) } }; break;
      case 'mg-ledger-delete': {
        const l = state.data.ledger.get(id), txs = allTxs().filter((t) => t.ledgerId === id);
        if (state.data.ledger.size <= 1 || !confirm(`删除账本「${l.name}」？其中 ${txs.length} 笔账单一并删除，无法恢复。`)) return true;
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
      case 'mg-acc-up': case 'mg-acc-down': {
        const a = state.data.account.get(id), all = accs();
        await mgSwap('account', all, all.filter((x) => (x.type ?? 0) === (a.type ?? 0) && !!x.archived === !!a.archived), id, act.endsWith('up') ? -1 : 1);
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
      case 'mg-acc-delete': {
        const a = m.edit.obj;
        if (mgAccountUsed(a.id)) { m.error = '还有账单，不能删'; break; }
        if (!confirm(`删除账户「${a.name}」？`)) return true;
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
