// 辉记账本网页版。没有构建步骤：纯 JS，直接连 Supabase。
// 数据和手机端同一套：云端 records 表里每行一条账单 / 分类 / 账户 / 账本，内容在 data 里。
// 这里把全部数据读进内存，统计口径和手机端保持一致（见 computeLookup）。
'use strict';

const KIND = { EXPENSE: 0, INCOME: 1, TRANSFER: 2 };
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式下存不了就算了 */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
};

const state = {
  // 网页里内置了云端地址（config.js）时就用它，登录页只要邮箱和密码
  cfg: CLOUD.url ? CLOUD : store.get('hl.cfg', { url: '', key: '' }),
  session: store.get('hl.session', null),
  data: { tx: new Map(), category: new Map(), account: new Map(), ledger: new Map() },
  tab: 'ledger',
  month: monthOf(new Date()),
  ledgerId: store.get('hl.ledger', 0),
  loading: false, error: '', editing: null, statsIncome: false, openTop: null,
};

// ---------------------------------------------------------------- 小工具

const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function monthOf(d) { return { y: d.getFullYear(), m: d.getMonth() + 1 }; }
function epochDay(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / 86400000); }
function dayToDate(day) { return new Date(day * 86400000); }
function dayISO(day) { return dayToDate(day).toISOString().slice(0, 10); }
function isoToDay(iso) { const [y, m, d] = iso.split('-').map(Number); return epochDay(y, m, d); }
const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
function dayLabel(day) { const d = dayToDate(day); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEK[d.getUTCDay()]}`; }
const SYMBOL = { EUR: '€', CNY: '¥', USD: '$', GBP: '£', JPY: 'JP¥', HKD: 'HK$' };
const HOME = 'EUR';
function money(cents, cur = HOME) {
  const v = Math.abs(cents) / 100;
  return (cents < 0 ? '-' : '') + (SYMBOL[cur] ?? cur + ' ') + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function parseCents(text) { const v = Number(String(text).trim().replace(',', '.')); return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null; }
/** 新建记录的 id：毫秒时间戳乘 1024 再加随机数。手机端的 id 是从 1 往上数的小数字，不会撞上。 */
function newId() { return Date.now() * 1024 + Math.floor(Math.random() * 1024); }

function iconKey(name) { const hit = ICON_KEYWORDS.find(([words]) => words.some((w) => name.includes(w))); return hit ? hit[1] : 'tag'; }
function iconTile(key, cls = '') {
  const def = ICONS[key] ?? ICONS.tag;
  return `<span class="tile ${cls}" style="background:${def.c}"><svg viewBox="0 0 24 24"><path d="${def.d}"/></svg></span>`;
}
/** 账户的标志：认得出银行就用它的 logo，否则用通用图标。规则和手机端一样：三个字母以内的英文缩写要是独立的词。 */
function accountTile(account, cls = '') {
  if (!account) return iconTile('wallet', cls);
  const n = account.name.toLowerCase();
  const words = new Set(n.split(/[^a-z0-9]+/));
  const brand = BRANDS.find(([keys]) => keys.some((k) => (k.length <= 3 && /^[\x00-\x7f]+$/.test(k) ? words.has(k) : n.includes(k))));
  if (brand) return `<span class="tile ${cls}"><img src="logos/${brand[1]}.png" alt=""></span>`;
  const generic = n.includes('押金') ? 'key' : n.includes('借') ? 'people' : (n.includes('现金') || n.includes('cash')) ? 'coins' : ['bank', 'chart', 'card', 'wallet'][account.type] ?? 'wallet';
  return iconTile(generic, cls);
}

// ---------------------------------------------------------------- 云端

async function api(method, path, body, { auth = true, prefer } = {}) {
  const { url, key } = state.cfg;
  const headers = { apikey: key, 'Content-Type': 'application/json', Authorization: `Bearer ${auth ? await accessToken() : key}` };
  if (prefer) headers.Prefer = prefer;
  let res;
  try {
    res = await fetch(url.replace(/\/+$/, '') + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error('连不上云端，请检查网络和项目地址。'); }
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
  if (!res.ok) {
    const msg = json?.msg || json?.error_description || json?.message || text.slice(0, 200);
    if (/invalid login/i.test(msg)) throw new Error('邮箱或密码不对。');
    if (/not confirmed/i.test(msg)) throw new Error('邮箱还没验证，请先点邮件里的确认链接。');
    if (res.status === 401) { signOut(); throw new Error('登录已失效，请重新登录。'); }
    throw new Error(`云端返回错误（${res.status}）：${msg}`);
  }
  return json;
}

function saveSession(o) {
  state.session = { access: o.access_token, refresh: o.refresh_token, expires: Date.now() + (o.expires_in ?? 3600) * 1000, user: o.user.id, email: o.user.email };
  store.set('hl.session', state.session);
}
async function accessToken() {
  const s = state.session;
  if (!s) throw new Error('还没有登录。');
  if (Date.now() < s.expires - 60000) return s.access;
  saveSession(await api('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh }, { auth: false }));
  return state.session.access;
}
function signOut() { state.session = null; store.del('hl.session'); for (const m of Object.values(state.data)) m.clear(); render(); }

async function loadAll() {
  state.loading = true; state.error = ''; render();
  try {
    for (const m of Object.values(state.data)) m.clear();
    let from = 0;
    for (;;) {
      const rows = await api('GET', `/rest/v1/records?select=kind,id,data&deleted=is.false&kind=neq.setting&order=kind.asc,id.asc&offset=${from}&limit=1000`);
      for (const r of rows) state.data[r.kind]?.set(Number(r.id), r.data);
      if (rows.length < 1000) break;
      from += 1000;
    }
    const ledgers = [...state.data.ledger.values()];
    if (!state.data.ledger.has(state.ledgerId)) {
      // 默认打开账单最多的那个账本
      const count = new Map();
      for (const t of state.data.tx.values()) count.set(t.ledgerId, (count.get(t.ledgerId) ?? 0) + 1);
      state.ledgerId = ledgers.sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0))[0]?.id ?? 1;
    }
  } catch (e) { state.error = e.message; }
  state.loading = false; render();
}

async function saveRecord(kind, obj) {
  await api('POST', '/rest/v1/records?on_conflict=user_id,kind,id', [{ user_id: state.session.user, kind, id: obj.id, data: obj, deleted: false }], { prefer: 'resolution=merge-duplicates,return=minimal' });
  state.data[kind].set(obj.id, obj);
}
async function deleteRecord(kind, id) {
  await api('POST', '/rest/v1/records?on_conflict=user_id,kind,id', [{ user_id: state.session.user, kind, id, data: {}, deleted: true }], { prefer: 'resolution=merge-duplicates,return=minimal' });
  state.data[kind].delete(id);
}

// ---------------------------------------------------------------- 统计口径（和手机端的 Lookup 一致）

function computeLookup() {
  const cat = state.data.category, txs = state.data.tx;
  const top = (id) => { const c = cat.get(id); return c ? (c.parentId ? cat.get(c.parentId) ?? c : c) : null; };
  // 这笔收入抵扣了哪些支出：分摊写在 offsetParts 里，否则 offsetOf 指向的那笔吃掉全部
  const parts = (t) => {
    if (t.kind !== KIND.INCOME) return [];
    const list = t.offsetParts
      ? t.offsetParts.split(',').map((p) => p.split(':').map(Number)).filter(([id, c]) => id && c > 0)
      : t.offsetOf > 0 ? [[t.offsetOf, t.amountCents]] : [];
    return list.filter(([id]) => txs.get(id)?.kind === KIND.EXPENSE);
  };
  const offsets = new Map();
  for (const t of txs.values()) for (const [id, c] of parts(t)) offsets.set(id, (offsets.get(id) ?? 0) + c);
  const rest = (t) => Math.max(0, t.amountCents - parts(t).reduce((s, p) => s + p[1], 0));
  const net = (t) => (t.kind === KIND.EXPENSE ? t.amountCents - (offsets.get(t.id) ?? 0) : t.kind === KIND.INCOME ? rest(t) : t.amountCents);
  const isReimburse = (t) => (t.kind === KIND.EXPENSE ? t.reimburse !== 0 : t.kind === KIND.INCOME && top(t.categoryId)?.name === '报销');
  const isRefund = (t) => t.kind === KIND.INCOME && top(t.categoryId)?.name === '退款';
  const isOffset = (t) => parts(t).length > 0;
  const counts = (t) => !t.excluded && !isReimburse(t) && !isRefund(t) && (!isOffset(t) || rest(t) > 0);
  const totals = (list) => {
    const r = { expense: 0, income: 0, reimbursable: 0, reimbursed: 0, refund: 0, excluded: 0 };
    for (const t of list) {
      if (t.kind === KIND.TRANSFER) continue;
      if (t.excluded) { r.excluded += t.amountCents; continue; }
      if (isOffset(t) && rest(t) === 0) continue;
      const re = isReimburse(t);
      if (t.kind === KIND.EXPENSE) { if (re) r.reimbursable += net(t); else r.expense += net(t); }
      else if (re) r.reimbursed += net(t);
      else if (isRefund(t)) r.refund += net(t);
      else r.income += net(t);
    }
    r.expense -= r.refund;
    return r;
  };
  return { top, parts, offsets, net, isReimburse, isRefund, isOffset, counts, totals };
}

function monthTxs() {
  const { y, m } = state.month;
  const from = epochDay(y, m, 1), to = epochDay(y, m + 1, 0);
  return [...state.data.tx.values()].filter((t) => t.ledgerId === state.ledgerId && t.date >= from && t.date <= to)
    .sort((a, b) => b.date - a.date || (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id - a.id);
}

// ---------------------------------------------------------------- 界面

const app = document.getElementById('app');

function render() {
  if (!state.session) { app.innerHTML = loginView(); return; }
  const tabs = [['ledger', '明细'], ['stats', '统计'], ['accounts', '账户']];
  const ledgers = [...state.data.ledger.values()];
  app.innerHTML = `<div class="wrap">
    <div class="top">
      <h1>辉记账本</h1>
      ${ledgers.length > 1 ? `<select style="width:auto" data-act="ledger">${ledgers.map((l) => `<option value="${l.id}" ${l.id === state.ledgerId ? 'selected' : ''}>${h(l.name)}</option>`).join('')}</select>` : ''}
      <div class="tabs">${tabs.map(([k, n]) => `<button class="${state.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${n}</button>`).join('')}</div>
      <button class="btn" data-act="reload">刷新</button>
      <button class="btn" data-act="signout">退出</button>
    </div>
    ${state.error ? `<p class="err">${h(state.error)}</p>` : ''}
    ${state.loading ? '<p class="muted">正在读取…</p>' : state.tab === 'ledger' ? ledgerView() : state.tab === 'stats' ? statsView() : accountsView()}
  </div>
  ${state.tab === 'ledger' && !state.loading ? '<button class="fab" data-act="new" aria-label="记一笔">+</button>' : ''}
  ${state.editing ? editorView() : ''}`;
}

function loginView() {
  const c = state.cfg;
  return `<div class="wrap"><div class="card login grid">
    <h1 style="margin:0">辉记账本</h1>
    ${CLOUD.url ? '' : `<label class="f">Supabase 项目地址<input id="l-url" value="${h(c.url)}" placeholder="https://xxxx.supabase.co" autocomplete="off"></label>
    <label class="f">公开密钥（anon / publishable）<input id="l-key" type="password" value="${h(c.key)}" autocomplete="off"></label>`}
    <label class="f">邮箱<input id="l-email" type="email" autocomplete="username"></label>
    <label class="f">密码<input id="l-pass" type="password" autocomplete="current-password"></label>
    ${state.error ? `<p class="err">${h(state.error)}</p>` : ''}
    <button class="btn primary" data-act="login" ${state.loading ? 'disabled' : ''}>${state.loading ? '请稍候…' : '登录'}</button>
    <button class="btn link" data-act="register" ${state.loading ? 'disabled' : ''}>还没有账号？注册</button>
  </div></div>`;
}

function monthBar() {
  const { y, m } = state.month;
  return `<div class="month"><button class="round" data-act="month" data-v="-1" aria-label="上个月">‹</button><b>${y}年${m}月</b><button class="round" data-act="month" data-v="1" aria-label="下个月">›</button></div>`;
}

function txRow(t, L) {
  const cat = state.data.category, acc = state.data.account;
  const leaf = cat.get(t.categoryId), top = L.top(t.categoryId), from = acc.get(t.accountId), to = acc.get(t.toAccountId);
  const transfer = t.kind === KIND.TRANSFER;
  const title = transfer ? `${h(from?.name ?? '?')} → ${h(to?.name ?? '?')}` : !leaf ? '未分类' : leaf.parentId ? `${h(top?.name)} · ${h(leaf.name)}` : h(leaf.name);
  const offset = t.kind === KIND.EXPENSE ? L.offsets.get(t.id) ?? 0 : 0;
  const foreign = t.currency && t.origCents > 0 && t.currency !== HOME;
  const net = L.net(t);
  const over = offset > 0 && net < 0;
  const sign = over ? '+' : t.kind === KIND.INCOME ? '+' : t.kind === KIND.EXPENSE ? '-' : '';
  const amount = offset > 0 && !foreign ? money(Math.abs(net)) : foreign ? money(t.origCents, t.currency) : money(t.amountCents);
  const cls = over || t.kind === KIND.INCOME ? 'in' : t.kind === KIND.EXPENSE ? 'out' : '';
  const details = [t.note, transfer ? '' : from?.name, ...(t.tags ? t.tags.split(' ').filter(Boolean).map((x) => '#' + x) : [])].filter(Boolean).map(h).join('  ');
  const targets = L.parts(t);
  const extra = [
    offset > 0 ? `原 ${money(t.amountCents)} · 抵 ${money(offset)}` : '',
    foreign ? `≈ ${money(t.amountCents)}` : '',
    targets.length ? `抵扣 ${targets.length > 1 ? targets.length + ' 笔支出' : h(cat.get(state.data.tx.get(targets[0][0])?.categoryId)?.name ?? '')}` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="row click" data-act="edit" data-v="${t.id}">
    ${transfer ? accountTile(to) : iconTile(leaf?.icon ?? 'tag')}
    <div class="main"><div class="title">${title}${t.excluded ? '<span class="badge gray">不计</span>' : ''}${t.reimburse === 1 ? '<span class="badge">待报销</span>' : t.reimburse === 2 ? '<span class="badge gray">已报销</span>' : ''}</div>
      ${details ? `<div class="sub">${details}</div>` : ''}</div>
    <div class="right"><div class="num ${cls}">${sign}${amount}</div>${extra ? `<div class="small muted">${extra}</div>` : ''}</div>
  </div>`;
}

function summaryCard(t) {
  return `<div class="card sticky">
    ${monthBar()}
    <div class="muted small" style="margin-top:14px">本月结余</div>
    <div class="big num">${money(t.income - t.expense)}</div>
    <div class="between" style="margin-top:10px">
      <div><div class="muted small">支出</div><div class="num out" style="font-size:18px">${money(t.expense)}</div></div>
      <div class="right"><div class="muted small">收入</div><div class="num in" style="font-size:18px">${money(t.income)}</div></div>
    </div>
    ${t.reimbursable || t.reimbursed ? `<div class="between small amber" style="margin-top:10px"><span>可报销支出 ${money(t.reimbursable)}</span><span>报销收入 ${money(t.reimbursed)}</span></div>` : ''}
    ${t.refund || t.excluded ? `<div class="between small muted" style="margin-top:4px"><span>${t.refund ? '退款 ' + money(t.refund) : ''}</span><span>${t.excluded ? '不计 ' + money(t.excluded) : ''}</span></div>` : ''}
  </div>`;
}

function ledgerView() {
  const L = computeLookup(), txs = monthTxs(), totals = L.totals(txs);
  const days = new Map();
  for (const t of txs) { if (!days.has(t.date)) days.set(t.date, []); days.get(t.date).push(t); }
  const list = [...days.entries()].map(([day, items]) => {
    const d = L.totals(items);
    const head = [d.income > 0 ? `收 ${money(d.income)}` : '', d.expense > 0 ? `支 ${money(d.expense)}` : ''].filter(Boolean).join('  ');
    return `<div class="card"><div class="dayhead"><span>${dayLabel(day)}</span><span>${head}</span></div>${items.map((t) => txRow(t, L)).join('')}</div>`;
  }).join('');
  return `<div class="cols">${summaryCard(totals)}<div class="grid">${list || '<div class="card muted">这个月还没有账单</div>'}</div></div>`;
}

function statsView() {
  const L = computeLookup();
  const kind = state.statsIncome ? KIND.INCOME : KIND.EXPENSE;
  const all = monthTxs();
  const shown = all.filter((t) => t.kind === kind && L.counts(t));
  const total = shown.reduce((s, t) => s + L.net(t), 0);
  const groups = new Map();
  for (const t of shown) { const top = L.top(t.categoryId); const k = top?.id ?? 0; if (!groups.has(k)) groups.set(k, { top, cents: 0, items: [] }); const g = groups.get(k); g.cents += L.net(t); g.items.push(t); }
  const rows = [...groups.values()].sort((a, b) => b.cents - a.cents).map((g) => {
    const def = ICONS[g.top?.icon] ?? ICONS.tag;
    const open = state.openTop === (g.top?.id ?? 0);
    const subs = new Map();
    for (const t of g.items) subs.set(t.categoryId, (subs.get(t.categoryId) ?? 0) + L.net(t));
    const subRows = open ? [...subs.entries()].sort((a, b) => b[1] - a[1]).map(([id, c]) => {
      const leaf = state.data.category.get(id);
      return `<div class="row" style="padding:4px 0 4px 12px">${iconTile(leaf?.icon ?? g.top?.icon ?? 'tag', 'sm')}<div class="main muted">${leaf && leaf.parentId ? h(leaf.name) : '（未细分）'}</div><div class="num muted">${money(c)}</div></div>`;
    }).join('') : '';
    return `<div class="row click" data-act="open-top" data-v="${g.top?.id ?? 0}">${iconTile(g.top?.icon ?? 'tag')}
      <div class="main"><div class="title">${h(g.top?.name ?? '未分类')}</div>
        <div class="bar" style="margin:5px 0 3px"><i style="width:${total > 0 ? Math.max(2, Math.round(g.cents * 100 / total)) : 0}%;background:${def.c}"></i></div>
        <div class="sub">${total > 0 ? Math.round(g.cents * 100 / total) : 0}% · ${g.items.length} 笔</div></div>
      <div class="num">${money(g.cents)}</div></div>${subRows}`;
  }).join('');
  return `<div class="cols">
    <div class="card sticky grid">
      ${monthBar()}
      <div class="seg"><button class="${!state.statsIncome ? 'on' : ''}" data-act="stats-kind" data-v="0">支出</button><button class="${state.statsIncome ? 'on' : ''}" data-act="stats-kind" data-v="1">收入</button></div>
      <div><div class="muted small">${state.statsIncome ? '总收入' : '总支出'}</div><div class="big num">${money(total)}</div></div>
    </div>
    <div class="card">${rows || '<span class="muted">这段时间没有记录</span>'}</div>
  </div>`;
}

/** 账单对账户余额的影响（主货币，流入为正）。 */
function effect(account, t) {
  if (t.kind === KIND.INCOME && t.accountId === account.id) return t.amountCents;
  if (t.kind === KIND.EXPENSE && t.accountId === account.id) return -t.amountCents;
  if (t.kind === KIND.TRANSFER && t.toAccountId === account.id) return t.amountCents;
  if (t.kind === KIND.TRANSFER && t.accountId === account.id) return -t.amountCents;
  return 0;
}

function accountsView() {
  const accounts = [...state.data.account.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const txs = [...state.data.tx.values()];
  // 外币账户的初始余额是按它自己的币种记的；网页版暂时没有汇率，这类账户的余额只算账单部分并标出来
  const bal = new Map(accounts.map((a) => [a.id, (a.currency && a.currency !== HOME ? 0 : a.initialCents ?? 0) + txs.reduce((s, t) => s + effect(a, t), 0)]));
  const assets = [...bal.values()].filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const debts = -[...bal.values()].filter((v) => v < 0).reduce((s, v) => s + v, 0);
  const types = [[0, '储蓄账户'], [1, '投资账户'], [2, '信用账户'], [3, '现金账户']];
  const groups = types.map(([type, label]) => {
    const g = accounts.filter((a) => a.type === type);
    if (!g.length) return '';
    return `<div class="card"><div class="dayhead"><span>${label}</span><span>${money(g.reduce((s, a) => s + bal.get(a.id), 0))}</span></div>
      ${g.map((a) => `<div class="row">${accountTile(a)}<div class="main"><div class="title">${h(a.name)}</div>${a.currency && a.currency !== HOME ? `<div class="sub">${h(a.currency)} 账户，这里按欧元显示，不含初始余额</div>` : ''}</div><div class="num ${bal.get(a.id) < 0 ? 'out' : ''}">${money(bal.get(a.id))}</div></div>`).join('')}</div>`;
  }).join('');
  return `<div class="cols">
    <div class="card sticky"><div class="muted small">净资产</div><div class="big num">${money(assets - debts)}</div>
      <div class="between" style="margin-top:10px"><div><div class="muted small">资产</div><div class="num in">${money(assets)}</div></div><div class="right"><div class="muted small">负债</div><div class="num out">${money(debts)}</div></div></div></div>
    <div class="grid">${groups}</div></div>`;
}

// ---------------------------------------------------------------- 记账 / 修改

function startEdit(t) {
  const accounts = [...state.data.account.values()];
  state.editing = t ? { ...t, _amount: (t.amountCents / 100).toFixed(2), _isNew: false } : {
    id: newId(), kind: KIND.EXPENSE, amountCents: 0, categoryId: 0, accountId: store.get('hl.lastAccount', accounts[0]?.id ?? 0), toAccountId: 0,
    ledgerId: state.ledgerId, date: epochDay(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate()), note: '', tags: '',
    reimburse: 0, createdAt: Date.now(), currency: '', origCents: 0, excluded: false, offsetOf: 0, offsetParts: '', _amount: '', _isNew: true,
  };
  render();
}

function editorView() {
  const e = state.editing;
  const cats = [...state.data.category.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const isIncome = e.kind === KIND.INCOME;
  const tops = cats.filter((c) => !c.parentId && !!c.isIncome === isIncome);
  const chosen = state.data.category.get(e.categoryId);
  const topId = chosen && !!chosen.isIncome === isIncome ? (chosen.parentId || chosen.id) : tops[0]?.id ?? 0;
  const subs = cats.filter((c) => c.parentId === topId);
  const subId = chosen && chosen.parentId === topId ? chosen.id : 0;
  const accounts = [...state.data.account.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const accOpts = (sel, skip) => accounts.filter((a) => a.id !== skip).map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${h(a.name)}</option>`).join('');
  const transfer = e.kind === KIND.TRANSFER;
  const foreign = e.currency && e.origCents > 0 && e.currency !== HOME;
  return `<div class="modal" data-act="close-backdrop"><div class="card grid" role="dialog" aria-label="账单">
    <div class="between"><b style="font-size:18px">${e._isNew ? '记一笔' : '修改账单'}</b>${e._isNew ? '' : '<button class="btn link danger" data-act="delete">删除</button>'}</div>
    <div class="seg">${['支出', '收入', '转账'].map((n, i) => `<button class="${e.kind === i ? 'on' : ''}" data-act="e-kind" data-v="${i}">${n}</button>`).join('')}</div>
    <label class="f">金额（${HOME}）<input id="e-amount" inputmode="decimal" value="${h(e._amount)}" placeholder="0.00" style="font-size:22px;font-weight:700"></label>
    ${foreign ? `<p class="muted small" style="margin:0">这笔原本是 ${money(e.origCents, e.currency)}，这里改的是折合 ${HOME} 的金额。</p>` : ''}
    ${transfer ? '' : `<div class="two">
      <label class="f">分类<select id="e-top">${tops.map((c) => `<option value="${c.id}" ${c.id === topId ? 'selected' : ''}>${h(c.name)}</option>`).join('')}</select></label>
      <label class="f">子分类<select id="e-sub"><option value="0">（不细分）</option>${subs.map((c) => `<option value="${c.id}" ${c.id === subId ? 'selected' : ''}>${h(c.name)}</option>`).join('')}</select></label></div>`}
    <div class="two">
      <label class="f">${transfer ? '转出账户' : '账户'}<select id="e-account">${accOpts(e.accountId)}</select></label>
      ${transfer ? `<label class="f">转入账户<select id="e-to">${accOpts(e.toAccountId, e.accountId)}</select></label>` : `<label class="f">日期<input id="e-date" type="date" value="${dayISO(e.date)}"></label>`}
    </div>
    ${transfer ? `<label class="f">日期<input id="e-date" type="date" value="${dayISO(e.date)}"></label>` : `<div class="two">
      ${e.kind === KIND.EXPENSE ? `<label class="f">报销<select id="e-reimburse">${['不报销', '待报销', '已报销'].map((n, i) => `<option value="${i}" ${e.reimburse === i ? 'selected' : ''}>${n}</option>`).join('')}</select></label>` : '<span></span>'}
      <label class="f">收支统计<select id="e-excluded"><option value="0" ${!e.excluded ? 'selected' : ''}>计入收支</option><option value="1" ${e.excluded ? 'selected' : ''}>不计入收支</option></select></label></div>`}
    <label class="f">备注<textarea id="e-note">${h(e.note)}</textarea></label>
    <label class="f">标签（空格分隔）<input id="e-tags" value="${h(e.tags)}"></label>
    ${state.error ? `<p class="err">${h(state.error)}</p>` : ''}
    <div class="between"><button class="btn" data-act="close">取消</button><button class="btn primary" data-act="save">保存</button></div>
  </div></div>`;
}

/** 把表单里现在的内容收回到 state.editing（切换类型、换一级分类会重画表单，先收一下）。 */
function collect() {
  const e = state.editing, v = (id) => document.getElementById(id)?.value;
  e._amount = v('e-amount') ?? e._amount;
  if (v('e-date')) e.date = isoToDay(v('e-date'));
  if (v('e-account')) e.accountId = Number(v('e-account'));
  if (v('e-to')) e.toAccountId = Number(v('e-to'));
  if (v('e-top')) { const sub = Number(v('e-sub') ?? 0); const top = Number(v('e-top')); e.categoryId = sub && state.data.category.get(sub)?.parentId === top ? sub : top; }
  if (v('e-reimburse') != null) e.reimburse = Number(v('e-reimburse'));
  if (v('e-excluded') != null) e.excluded = v('e-excluded') === '1';
  e.note = v('e-note') ?? e.note;
  e.tags = (v('e-tags') ?? e.tags).split(/[\s#,，]+/).filter(Boolean).join(' ');
}

async function saveEditing() {
  collect();
  const e = state.editing, cents = parseCents(e._amount);
  if (cents == null) { state.error = '请填写金额。'; return render(); }
  const transfer = e.kind === KIND.TRANSFER;
  if (transfer && (!e.toAccountId || e.toAccountId === e.accountId)) { state.error = '请选择两个不同的账户。'; return render(); }
  const { _amount, _isNew, ...t } = e;
  t.amountCents = cents;
  if (transfer) { t.categoryId = 0; t.reimburse = 0; t.excluded = false; } else t.toAccountId = 0;
  if (t.kind !== KIND.EXPENSE) t.reimburse = 0;
  if (t.kind !== KIND.INCOME) { t.offsetOf = 0; t.offsetParts = ''; }
  try {
    await saveRecord('tx', t);
    store.set('hl.lastAccount', t.accountId);
    state.editing = null; state.error = '';
  } catch (err) { state.error = err.message; }
  render();
}

// ---------------------------------------------------------------- 事件

app.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, v = el.dataset.v;
  if (act === 'close-backdrop' && ev.target !== el) return;
  switch (act) {
    case 'login': case 'register': {
      if (!CLOUD.url) {
        state.cfg = { url: document.getElementById('l-url').value.trim(), key: document.getElementById('l-key').value.trim() };
        store.set('hl.cfg', state.cfg);
      }
      state.loading = true; state.error = ''; const email = document.getElementById('l-email').value.trim(), pass = document.getElementById('l-pass').value; render();
      try {
        if (pass.length < 6) throw new Error('密码至少 6 位。');
        const o = act === 'register'
          ? await api('POST', '/auth/v1/signup', { email, password: pass }, { auth: false })
          : await api('POST', '/auth/v1/token?grant_type=password', { email, password: pass }, { auth: false });
        // 开着邮箱验证时，注册不会直接给登录凭证
        if (!o.access_token) throw new Error('注册成功，请到邮箱点确认链接，然后回来登录。');
        saveSession(o); state.loading = false; await loadAll();
      } catch (e) { state.loading = false; state.error = e.message; render(); }
      break;
    }
    case 'signout': signOut(); break;
    case 'reload': await loadAll(); break;
    case 'tab': state.tab = v; render(); break;
    case 'month': { const d = new Date(state.month.y, state.month.m - 1 + Number(v), 1); state.month = monthOf(d); render(); break; }
    case 'stats-kind': state.statsIncome = v === '1'; state.openTop = null; render(); break;
    case 'open-top': state.openTop = state.openTop === Number(v) ? null : Number(v); render(); break;
    case 'new': state.error = ''; startEdit(null); break;
    case 'edit': state.error = ''; startEdit(state.data.tx.get(Number(v))); break;
    case 'e-kind': collect(); state.editing.kind = Number(v); state.editing.categoryId = 0; render(); break;
    case 'close': case 'close-backdrop': state.editing = null; state.error = ''; render(); break;
    case 'save': await saveEditing(); break;
    case 'delete':
      if (confirm('删除这笔账单？')) { try { await deleteRecord('tx', state.editing.id); state.editing = null; } catch (e) { state.error = e.message; } render(); }
      break;
  }
});
app.addEventListener('change', (ev) => {
  if (ev.target.dataset.act === 'ledger') { state.ledgerId = Number(ev.target.value); store.set('hl.ledger', state.ledgerId); render(); }
  // 换了一级分类，子分类的下拉要跟着换
  if (ev.target.id === 'e-top') { collect(); state.editing.categoryId = Number(ev.target.value); render(); }
  if (ev.target.id === 'e-account' && state.editing?.kind === KIND.TRANSFER) { collect(); render(); }
});

render();
if (state.session) loadAll();
