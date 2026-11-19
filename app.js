// 辉记账本网页版。没有构建步骤：纯 JS，直接连 Supabase。
// 数据和手机端同一套：云端 records 表里每行一条账单 / 分类 / 账户 / 账本，内容在 data 里。
// 这里把全部数据读进内存，统计口径和手机端保持一致（见 computeLookup）。
'use strict';

const KIND = { EXPENSE: 0, INCOME: 1, TRANSFER: 2 };
// 邮件里的链接点开后回到这个页面
const HERE = encodeURIComponent(location.origin + location.pathname);
const IS_ANDROID = /Android/i.test(navigator.userAgent);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式下存不了就算了 */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* 同上 */ } },
};

const state = {
  // 网页里内置了云端地址（config.js）时就用它，登录页只要邮箱和密码
  cfg: CLOUD.url ? CLOUD : store.get('hl.cfg', { url: '', key: '' }),
  session: store.get('hl.session', null),
  data: { tx: new Map(), category: new Map(), account: new Map(), ledger: new Map(), setting: new Map() },
  tab: 'ledger',
  month: monthOf(new Date()),
  ledgerId: store.get('hl.ledger', 0),
  loading: false, error: '', editing: null, statsIncome: false, openTop: null,
  // 以下是和手机端对齐的那些页面用的
  view: null, q: '', searching: false, period: 'm', section: 'overview', line: false, openSub: null, openTag: null, openLeftOut: false,
  calDay: null, rmode: 'projects', project: null, accountId: null, openKey: null, addingRule: false,
  // AI 和资产页
  chat: [], asking: false, aiSettings: false, worthAll: false, assetTab: 'accounts', reviewText: {}, reviewBusy: false,
  rec: { accountId: 0, busy: false, done: 0, total: 1, error: '', result: null, showSame: false },
};

// ---------------------------------------------------------------- 小工具

const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function monthOf(d) { return { y: d.getFullYear(), m: d.getMonth() + 1 }; }
function epochDay(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / 86400000); }
function dayToDate(day) { return new Date(day * 86400000); }
function dayISO(day) { return dayToDate(day).toISOString().slice(0, 10); }
function isoToDay(iso) { const [y, m, d] = iso.split('-').map(Number); return epochDay(y, m, d); }
const WEEK_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'], WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// 用的时候再按当前语言取（切换语言后不用刷新页面）
const WEEK = new Proxy([], { get: (_, k) => (LANG === 'en' ? WEEK_EN : WEEK_ZH)[k] });
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 年月：2026年11月 / Nov 2026 */
const ymLabel = (y, m) => tr(`${y}年${m}月`, `${MONTH_EN[m - 1]} ${y}`);
function dayLabel(day) { const d = dayToDate(day); return tr(`${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEK[d.getUTCDay()]}`, `${WEEK[d.getUTCDay()]}, ${MONTH_EN[d.getUTCMonth()]} ${d.getUTCDate()}`); }
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
/** 品牌底色和前景色（和手机端 BankLogos.kt 一致），按 logo 名查。 */
const BRAND_COLORS = {
  logo_boc: ['#B5122B'], logo_icbc: ['#C4161C'], logo_abc: ['#00907A'], logo_cmbc: ['#1B60AE'], logo_citic: ['#C8102E'], logo_alipay: ['#1677FF'],
  logo_wechat: ['#07C160'], logo_ing: ['#FF6200'], logo_revolut: ['#FFFFFF'], logo_paypal: ['#003087'], logo_bunq: ['#1A1A1A'], logo_asn: ['#FFFFFF'],
  logo_kraken: ['#7132F5'], logo_wise: ['#9FE870', '#163300'], logo_abn: ['#FFFFFF', '#FFD200'], logo_n26: ['#202020'], logo_traderepublic: ['#FFFFFF'],
  logo_trading212: ['#000000'], logo_bitvavo: ['#0033FF'], logo_coinbase: ['#0052FF'], logo_rabobank: ['#000099'], logo_pingan: ['#FF3300'],
  logo_guilin: ['#FFFFFF'], logo_zhongtai: ['#E60012'], logo_scalable: ['#101214'], logo_lemfi: ['#C5F57A'], logo_robinhood: ['#00C805'], logo_finst: ['#10162F'],
};
/** 手机端那几家没有原图的：品牌色加一个字标。 */
const TEXT_BRANDS = [
  [['建设银行', '建行', 'ccb'], '#0066B3', '#FFFFFF', '建'], [['招商', '招行', 'cmb'], '#C8152D', '#FFFFFF', '招'], [['交通银行', '交行', 'bocom'], '#1D3F8F', '#FFFFFF', '交'],
  [['邮储', '邮政'], '#007F3E', '#FFFFFF', '邮'], [['degiro'], '#009FDF', '#FFFFFF', 'DG'], [['binance', '币安'], '#1E2026', '#F0B90B', 'B'],
];
/** 按账户名找品牌。规则和手机端一样：三个字母以内的英文缩写要是独立的词。 */
function brandOf(account) {
  if (!account) return null;
  const n = account.name.toLowerCase(), words = new Set(n.split(/[^a-z0-9]+/));
  const hit = (keys) => keys.some((k) => (k.length <= 3 && /^[\x00-\x7f]+$/.test(k) ? words.has(k) : n.includes(k)));
  const img = BRANDS.find(([keys]) => hit(keys));
  if (img) { const [bg, fg = '#FFFFFF'] = BRAND_COLORS[img[1]] ?? ['#4A5068']; return { logo: img[1], bg, fg }; }
  const text = TEXT_BRANDS.find(([keys]) => hit(keys));
  return text ? { bg: text[1], fg: text[2], text: text[3] } : null;
}
function genericIcon(account) {
  const n = (account?.name ?? '').toLowerCase();
  if (!account) return 'wallet';
  return n.includes('押金') ? 'key' : n.includes('借') ? 'people' : (n.includes('现金') || n.includes('cash')) ? 'coins' : ['bank', 'chart', 'card', 'wallet'][account.type] ?? 'wallet';
}
/** 账户的标志：认得出银行就用它的 logo，否则用通用图标。 */
function accountTile(account, cls = '') {
  const brand = brandOf(account);
  if (brand?.logo) return `<span class="tile ${cls}"><img src="logos/${brand.logo}.png" alt=""></span>`;
  if (brand) return `<span class="tile ${cls}" style="background:${brand.bg};color:${brand.fg}">${h(brand.text)}</span>`;
  return iconTile(genericIcon(account), cls);
}
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const lumOf = (hex) => { const [r, g, b] = rgbOf(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const mixHex = (hex, to, f) => '#' + rgbOf(hex).map((c, i) => Math.round((c + (rgbOf(to)[i] - c) * f) * 255).toString(16).padStart(2, '0')).join('');
/** 彩色卡片的底色：太白的换成前景色或深灰，太亮的压暗三成，免得白字看不清（和手机端 accountFaceColor 一样）。 */
function cardColor(base, fg) {
  const l = lumOf(base);
  if (l > 0.85) return fg && lumOf(fg) < 0.6 ? fg : '#4A5068';
  return l > 0.62 ? mixHex(base, '#000000', 0.3) : base;
}
/** 账户卡面的颜色：有品牌的用品牌色，没有的用它图标的颜色。 */
function accountFace(account) { const b = brandOf(account); return cardColor(b?.bg ?? (ICONS[genericIcon(account)] ?? ICONS.wallet).c, b?.fg); }
/** 币种的国旗（表情字符）。只给认得的法币，其余不显示。 */
function flagOf(cur) {
  if (cur !== 'EUR' && !(cur in SYMBOL) && !(cur in fx.rates)) return '';
  const cc = cur === 'EUR' ? 'EU' : cur.slice(0, 2);
  return /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65)) : '';
}

// ---------------------------------------------------------------- 云端

async function api(method, path, body, { auth = true, prefer } = {}) {
  const { url, key } = state.cfg;
  const headers = { apikey: key, 'Content-Type': 'application/json', Authorization: `Bearer ${auth ? await accessToken() : key}` };
  if (prefer) headers.Prefer = prefer;
  let res;
  try {
    res = await fetch(url.replace(/\/+$/, '') + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch { throw Object.assign(new Error(tr('连不上云端，请检查网络。', 'Can\'t reach the cloud. Check your connection.')), { offline: true }); }
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
  if (!res.ok) {
    const msg = json?.msg || json?.error_description || json?.message || text.slice(0, 200);
    if (/invalid login/i.test(msg)) throw new Error(tr('邮箱或密码不对。', 'Wrong email or password.'));
    if (/not confirmed/i.test(msg)) throw Object.assign(new Error(tr('邮箱还没验证，请点邮件里的确认链接。', 'Email not confirmed yet. Click the link in the email.')), { unconfirmed: true });
    if (/rate limit|too many|security purposes/i.test(msg)) throw new Error(tr('操作太频繁，请过几分钟再试。', 'Too many attempts. Try again in a few minutes.'));
    if (/already registered|already exists/i.test(msg)) throw new Error(tr('这个邮箱已经注册过，直接登录或找回密码。', 'This email is already registered. Sign in or reset your password.'));
    if (/weak|at least/i.test(msg) && /password/i.test(msg)) throw new Error(tr('密码太简单，换一个长一点的。', 'Password too weak. Try a longer one.'));
    if (res.status === 401 && auth) { signOut(); throw new Error(tr('登录已失效，请重新登录。', 'Session expired. Please sign in again.')); }
    throw new Error(tr(`云端返回错误（${res.status}）：${msg}`, `Cloud error (${res.status}): ${msg}`));
  }
  return json;
}

function saveSession(o) {
  state.session = { access: o.access_token, refresh: o.refresh_token, expires: Date.now() + (o.expires_in ?? 3600) * 1000, user: o.user.id, email: o.user.email };
  store.set('hl.session', state.session);
}
async function accessToken() {
  const s = state.session;
  if (!s) throw new Error(tr('还没有登录。', 'Not signed in.'));
  if (Date.now() < s.expires - 60000) return s.access;
  saveSession(await api('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh }, { auth: false }));
  return state.session.access;
}
function signOut() { state.session = null; store.del('hl.session'); for (const m of Object.values(state.data)) m.clear(); render(); }

async function loadAll() {
  // 先把上次存在手机上的快照摆出来（秒开、断网也能看），再去云端拿最新的
  const hadSnap = !state.data.tx.size && await loadSnapshot();
  state.loading = !hadSnap && !state.data.tx.size; state.error = ''; render();
  try {
    await outbox.flush();
    const fresh = { tx: new Map(), category: new Map(), account: new Map(), ledger: new Map(), setting: new Map() };
    let from = 0;
    for (;;) {
      const rows = await api('GET', `/rest/v1/records?select=kind,id,data&deleted=is.false&order=kind.asc,id.asc&offset=${from}&limit=1000`);
      for (const r of rows) fresh[r.kind]?.set(Number(r.id), r.data);
      if (rows.length < 1000) break;
      from += 1000;
    }
    // 还没传上去的修改盖在云端数据上面
    for (const r of outbox.list()) { if (!fresh[r.kind]) continue; if (r.deleted) fresh[r.kind].delete(r.id); else fresh[r.kind].set(r.id, r.data); }
    state.data = fresh;
    saveSnapshot();
    for (const f of MOD.onLoad) { try { await f(); } catch (e) { console.warn(e); } }
    const ledgers = [...state.data.ledger.values()];
    if (!state.data.ledger.has(state.ledgerId)) {
      // 默认打开账单最多的那个账本
      const count = new Map();
      for (const t of state.data.tx.values()) count.set(t.ledgerId, (count.get(t.ledgerId) ?? 0) + 1);
      state.ledgerId = ledgers.sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0))[0]?.id ?? 1;
    }
  } catch (e) { if (!(hadSnap && isNetworkError(e))) state.error = e.message; else state.notice = tr('离线中，显示的是上次的数据', 'Offline: showing last saved data'); }
  state.loading = false; render();
}

// 写云端；断网时先改本地、排进队列，联网后自动补传
async function putRow(row) {
  try {
    await api('POST', '/rest/v1/records?on_conflict=user_id,kind,id', [{ user_id: state.session.user, ...row }], { prefer: 'resolution=merge-duplicates,return=minimal' });
  } catch (e) { if (!isNetworkError(e)) throw e; outbox.add(row); }
  if (row.deleted) state.data[row.kind].delete(row.id); else state.data[row.kind].set(row.id, row.data);
  clearTimeout(putRow.t); putRow.t = setTimeout(saveSnapshot, 1500);
}
async function saveRecord(kind, obj) { await putRow({ kind, id: obj.id, data: obj, deleted: false }); }
async function deleteRecord(kind, id) { await putRow({ kind, id, data: {}, deleted: true }); }
addEventListener('online', () => outbox.flush());

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
  const isRefund = (t) => t.kind === KIND.INCOME && ['退款', '代付收回', '代付退还'].includes(top(t.categoryId)?.name);
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
  // 和手机端一样的分法：报销、补贴、周期性收支、对账都收在资产里
  const tabs = [['ledger', tr('明细', 'Ledger')], ['calendar', tr('日历', 'Calendar')], ['stats', tr('统计', 'Stats')], ['accounts', tr('资产', 'Assets')], ['ask', tr('问账本', 'Ask')], ['me', tr('我的', 'Me')]];
  const navOn = (k) => (state.tab === k || (k === 'me' && !['ledger', 'stats', 'accounts'].includes(state.tab)) ? 'on' : '');
  const ledgers = [...state.data.ledger.values()];
  app.innerHTML = `<div class="wrap">
    <div class="top">
      <h1>${tr('辉记账本', 'HuiLedger')}</h1>
      ${ledgers.length > 1 ? `<select style="width:auto" data-act="ledger">${ledgers.map((l) => `<option value="${l.id}" ${l.id === state.ledgerId ? 'selected' : ''}>${h(l.name)}</option>`).join('')}</select>` : ''}
      <div class="tabs">${tabs.map(([k, n]) => `<button class="${state.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}">${n}</button>`).join('')}</div>
      <button class="search" data-act="search-open">${SEARCH_SVG}<span>${tr('搜索全部账单', 'Search all')}</span></button>
      <label class="btn" style="cursor:pointer">${tr('导入修正文件', 'Import fixes')}<input type="file" id="patch-file" accept=".csv,text/csv" hidden></label>
      <button class="btn" data-act="ai-settings">${tr('AI 设置', 'AI settings')}</button>
      <button class="btn" data-act="export">${tr('导出', 'Export')}</button>
      <button class="btn" data-act="reload">${tr('刷新', 'Refresh')}</button>
      ${langSwitch()}
      <button class="btn" data-act="signout">${tr('退出', 'Sign out')}</button>
    </div>
    ${state.error ? `<p class="err">${h(state.error)}</p>` : ''}${state.notice ? `<p class="ok small" data-act="notice-x">${h(state.notice)}</p>` : ''}
    ${state.loading ? `<p class="muted">${tr('正在读取…', 'Loading…')}</p>` : state.searching || state.q.trim() ? searchView() : pageView()}
  </div>
  ${state.tab === 'ledger' && !state.loading ? `<button class="fab" data-act="new" aria-label="${tr('记一笔', 'Add')}">+</button>` : ''}
  <nav class="bottom-nav">
    ${[['ledger', tr('明细', 'Ledger'), 'list'], ['stats', tr('统计', 'Stats'), 'pie']].map(([k, n, i]) => `<button class="${navOn(k)}" data-act="tab" data-v="${k}">${navIcon(i)}<span>${n}</span></button>`).join('')}
    <button class="nav-add" data-act="new" aria-label="${tr('记一笔', 'Add')}">+</button>
    ${[['accounts', tr('资产', 'Assets'), 'wallet'], ['me', tr('我的', 'Me'), 'user']].map(([k, n, i]) => `<button class="${navOn(k)}" data-act="tab" data-v="${k}">${navIcon(i)}<span>${n}</span></button>`).join('')}
  </nav>
  ${state.aiSettings ? aiSettingsView() : ''}${state.view != null && !state.editing ? detailView() : ''}${state.editing ? editorView() : ''}${state.patch ? patchView() : ''}`;
}

const navIcon = (k) => `<svg viewBox="0 0 24 24"><path d="${(ICONS[k] ?? ICONS.tag).d}"/></svg>`;

/** "我的"页：所有不在底栏上的功能都从这里进。模块用 MOD.me 登记自己的入口。 */
function meView() {
  const items = [
    { key: 'calendar', name: tr('日历', 'Calendar'), icon: 'calendar', order: 1 },
    { key: 'ask', name: tr('问账本', 'Ask'), icon: 'sparkle', order: 2 },
    ...MOD.me,
    { act: 'ai-settings', name: tr('AI 设置', 'AI settings'), icon: 'chip', order: 90 },
    { act: 'export', name: tr('导出 CSV', 'Export CSV'), icon: 'upload', order: 92 },
    { file: true, name: tr('导入修正文件', 'Import fixes'), icon: 'document', order: 91 },
  ].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  const tile = (it) => it.file
    ? `<label class="me-item">${iconTile(it.icon)}<span>${h(it.name)}</span><input type="file" id="patch-file" accept=".csv,text/csv" hidden></label>`
    : `<button class="me-item" data-act="${it.act ?? 'tab'}" data-v="${h(it.key ?? '')}">${iconTile(it.icon)}<span>${h(it.name)}</span></button>`;
  const install = STANDALONE ? '' : `<div class="card small muted">${IS_IOS ? tr('在 Safari 点 分享 → 添加到主屏幕，就能像 App 一样用', 'In Safari: Share → Add to Home Screen to use it like an app') : tr('浏览器菜单里选"安装应用 / 添加到主屏幕"，就能像 App 一样用', 'Use "Install app / Add to Home Screen" in the browser menu')}</div>`;
  const pending = outbox.list().length;
  return `<div class="grid">
    <div class="card cc"><div class="between"><div><div style="font-size:20px;font-weight:700">${tr('辉记账本', 'HuiLedger')}</div><div class="muted small">${h(state.session?.email ?? '')}</div><div class="muted small">${pending ? tr(`${pending} 条修改等联网后上传`, `${pending} changes waiting to upload`) : tr('已和云端同步', 'Synced')}</div></div>
      <button class="pill" data-act="reload">${tr('刷新', 'Refresh')}</button></div></div>
    <div class="card between"><span>${tr('语言', 'Language')}</span>${langSwitch()}</div>
    ${install}
    <div class="card"><div class="me-grid">${items.map(tile).join('')}</div></div>
    <button class="btn" data-act="signout">${tr('退出登录', 'Sign out')}</button>
  </div>`;
}

function loginView() {
  const c = state.cfg, mode = state.authMode || 'login', dis = state.loading ? 'disabled' : '';
  const pass = (id, label) => `<label class="f pw">${label}<input id="${id}" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"><button type="button" class="eye" data-act="pw-eye" data-v="${id}">${tr('显示', 'Show')}</button></label>`;
  const title = { login: tr('登录', 'Sign in'), register: tr('注册', 'Create account'), forgot: tr('发送重设邮件', 'Send reset link'), reset: tr('保存新密码', 'Save new password'), sent: '' }[mode];
  const heading = { login: tr('登录', 'Sign in'), register: tr('注册新账号', 'Create an account'), forgot: tr('找回密码', 'Reset password'), reset: tr('设置新密码', 'Set a new password'), sent: tr('查收邮件', 'Check your email') }[mode];
  const email = `<label class="f">${tr('邮箱', 'Email')}<input id="l-email" type="email" autocomplete="username" inputmode="email" value="${h(state.authEmail || '')}"></label>`;
  // 邮件已发出：告诉用户发到哪了、接下来点什么，并能重发
  const sentBox = mode === 'sent' ? `<p style="margin:0">${state.sentKind === 'recovery'
      ? tr(`重设密码的链接已发到 <b>${h(state.authEmail)}</b>。点邮件里的链接，会回到这里设置新密码。`, `A reset link was sent to <b>${h(state.authEmail)}</b>. Open it to come back here and set a new password.`)
      : tr(`确认邮件已发到 <b>${h(state.authEmail)}</b>。点邮件里的链接，会回到这里并自动登录。`, `A confirmation email was sent to <b>${h(state.authEmail)}</b>. Open the link to come back here signed in.`)}</p>
    <p class="hint">${tr('没收到？看看垃圾邮件，或者过一分钟再重发。', 'Nothing yet? Check spam, or resend in a minute.')}</p>
    <button class="btn" data-act="auth-resend" ${dis}>${tr('重发邮件', 'Resend email')}</button>` : '';
  return `<div class="wrap"><div class="card login grid" style="position:relative">
    ${langSwitch()}
    <h1 style="margin:0">${tr('辉记账本', 'HuiLedger')}</h1>
    <div class="muted">${heading}</div>
    ${state.notice ? `<p class="ok">${h(state.notice)}</p>` : ''}
    ${CLOUD.url ? '' : `<label class="f">${tr('Supabase 项目地址', 'Supabase project URL')}<input id="l-url" value="${h(c.url)}" placeholder="https://xxxx.supabase.co" autocomplete="off"></label>
    <label class="f">${tr('公开密钥（anon / publishable）', 'Public key (anon / publishable)')}<input id="l-key" type="password" value="${h(c.key)}" autocomplete="off"></label>`}
    ${sentBox}
    ${mode === 'reset' || mode === 'sent' ? '' : email}
    ${mode === 'reset' ? `<p class="hint">${h(state.authEmail || '')}</p>` : ''}
    ${mode === 'forgot' || mode === 'sent' ? '' : pass('l-pass', mode === 'reset' ? tr('新密码（至少 6 位）', 'New password (6+ characters)') : mode === 'register' ? tr('密码（至少 6 位）', 'Password (6+ characters)') : tr('密码', 'Password'))}
    ${mode === 'register' || mode === 'reset' ? pass('l-pass2', tr('再输一遍密码', 'Repeat password')) : ''}
    ${mode === 'forgot' ? `<p class="hint">${tr('输入注册时的邮箱，我们会发一个重设密码的链接。', 'Enter your account email and we\'ll send a reset link.')}</p>` : ''}
    ${state.error ? `<p class="err">${h(state.error)}</p>` : ''}
    ${state.unconfirmed && mode === 'login' ? `<button class="btn" data-act="auth-resend" ${dis}>${tr('重发确认邮件', 'Resend confirmation email')}</button>` : ''}
    ${title ? `<button class="btn primary" data-act="auth" ${dis}>${state.loading ? tr('请稍候…', 'Please wait…') : title}</button>` : ''}
    <div class="between" style="justify-content:center">
      ${mode === 'login' ? `<button class="btn link" data-act="mode" data-v="register" ${dis}>${tr('还没有账号？注册', 'No account? Sign up')}</button><button class="btn link" data-act="mode" data-v="forgot" ${dis}>${tr('忘记密码', 'Forgot password')}</button>`
        : `<button class="btn link" data-act="mode" data-v="login" ${dis}>${tr('返回登录', 'Back to sign in')}</button>`}
    </div>
    ${IS_ANDROID ? `<a class="btn open-app" href="intent://open#Intent;scheme=huiledger;package=app.jizhang;end">${tr('在 App 中打开', 'Open in app')}</a>` : ''}
  </div></div>`;
}

function monthBar() {
  const { y, m } = state.month;
  return `<div class="month"><button class="round" data-act="month" data-v="-1" aria-label="${tr('上个月', 'Previous month')}">‹</button><b>${ymLabel(y, m)}</b><button class="round" data-act="month" data-v="1" aria-label="${tr('下个月', 'Next month')}">›</button></div>`;
}

// 账单行 txRow() 在 modules/editor.js（侧滑、多选都在那边）

function summaryCard(t) {
  return `<div class="card cc">
    ${monthBar()}
    <div class="muted small" style="margin-top:14px">${tr('本月结余', 'Balance this month')}</div>
    <div class="big num">${money(t.income - t.expense)}</div>
    <div class="between" style="margin-top:10px">
      <div><div class="muted small">${tr('支出', 'Expense')}</div><div class="num out" style="font-size:18px">${money(t.expense)}</div></div>
      <div class="right"><div class="muted small">${tr('收入', 'Income')}</div><div class="num in" style="font-size:18px">${money(t.income)}</div></div>
    </div>
    ${t.reimbursable || t.reimbursed ? `<div class="between small amber" style="margin-top:10px"><span>${tr('可报销支出', 'Reimbursable')} ${money(t.reimbursable)}</span><span>${tr('报销收入', 'Reimbursed')} ${money(t.reimbursed)}</span></div>` : ''}
    ${t.refund || t.excluded ? `<div class="between small muted" style="margin-top:4px"><span>${t.refund ? tr('退款 ', 'Refunds ') + money(t.refund) : ''}</span><span>${t.excluded ? tr('不计 ', 'Excluded ') + money(t.excluded) : ''}</span></div>` : ''}
  </div>`;
}

function ledgerView() {
  const L = computeLookup(), txs = monthTxs(), totals = L.totals(txs);
  const days = new Map();
  for (const t of txs) { if (!days.has(t.date)) days.set(t.date, []); days.get(t.date).push(t); }
  const list = [...days.entries()].map(([day, items]) => {
    const d = L.totals(items);
    const head = [d.income > 0 ? `${tr('收', 'In')} ${money(d.income)}` : '', d.expense > 0 ? `${tr('支', 'Out')} ${money(d.expense)}` : ''].filter(Boolean).join('  ');
    return `<div class="card"><div class="dayhead"><span>${dayLabel(day)}</span><span>${head}</span></div>${items.map((t) => txRow(t, L)).join('')}</div>`;
  }).join('');
  return `<div class="cols"><div class="grid sticky">${summaryCard(totals)}${MOD.homeCards.map((f) => f()).join('')}${quickBar()}</div><div class="grid">${list || `<div class="card muted">${tr('这个月还没有账单', 'No entries this month')}</div>`}</div></div>`;
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
      return `<div class="row" style="padding:4px 0 4px 12px">${iconTile(leaf?.icon ?? g.top?.icon ?? 'tag', 'sm')}<div class="main muted">${leaf && leaf.parentId ? h(leaf.name) : tr('（未细分）', '(none)')}</div><div class="num muted">${money(c)}</div></div>`;
    }).join('') : '';
    return `<div class="row click" data-act="open-top" data-v="${g.top?.id ?? 0}">${iconTile(g.top?.icon ?? 'tag')}
      <div class="main"><div class="title">${h(g.top?.name ?? tr('未分类', 'Uncategorized'))}</div>
        <div class="bar" style="margin:5px 0 3px"><i style="width:${total > 0 ? Math.max(2, Math.round(g.cents * 100 / total)) : 0}%;background:${def.c}"></i></div>
        <div class="sub">${total > 0 ? Math.round(g.cents * 100 / total) : 0}% · ${g.items.length} ${tr('笔', 'entries')}</div></div>
      <div class="num">${money(g.cents)}</div></div>${subRows}`;
  }).join('');
  return `<div class="cols">
    <div class="card sticky grid">
      ${monthBar()}
      <div class="seg"><button class="${!state.statsIncome ? 'on' : ''}" data-act="stats-kind" data-v="0">${tr('支出', 'Expense')}</button><button class="${state.statsIncome ? 'on' : ''}" data-act="stats-kind" data-v="1">${tr('收入', 'Income')}</button></div>
      <div><div class="muted small">${state.statsIncome ? tr('总收入', 'Total income') : tr('总支出', 'Total expense')}</div><div class="big num">${money(total)}</div></div>
    </div>
    <div class="card">${rows || `<span class="muted">${tr('这段时间没有记录', 'Nothing in this period')}</span>`}</div>
  </div>`;
}

// ---- 汇率：和手机端同一个来源（欧洲央行每日参考汇率，以欧元为基准），存在浏览器里，打开页面时更新一次
const fx = { rates: store.get('hl.rates', {}), date: store.get('hl.ratesDate', '') };
async function refreshRates() {
  try {
    const r = await (await fetch('https://api.frankfurter.dev/v1/latest?base=EUR')).json();
    if (r?.rates) { fx.rates = r.rates; fx.date = r.date; store.set('hl.rates', r.rates); store.set('hl.ratesDate', r.date); if (state.session) render(); }
  } catch { /* 取不到就用上次存的 */ }
}
/** 把金额从一种货币折成另一种；没有汇率时返回 null。 */
function convert(cents, from, to) {
  if (from === to) return cents;
  const a = from === 'EUR' ? 1 : fx.rates[from], b = to === 'EUR' ? 1 : fx.rates[to];
  return a && b ? Math.round(cents * b / a) : null;
}
const acctCur = (a) => a.currency || HOME;
/** 账户币种的金额折合主货币（取不到汇率就按 1:1，和手机端一样）。 */
const toHome = (a, cents) => convert(cents, acctCur(a), HOME) ?? cents;

/**
 * 一笔账单让这个账户的钱变了多少：按账户自己的币种算，流入为正；和这个账户无关时是 0。
 * 和手机端同一套规则：账单本来就是用账户币种付的，用原金额；否则把主货币金额按汇率折成账户币种。
 */
function effect(account, t) {
  const sign = t.kind === KIND.INCOME && t.accountId === account.id ? 1 : t.kind === KIND.EXPENSE && t.accountId === account.id ? -1
    : t.kind === KIND.TRANSFER && t.toAccountId === account.id ? 1 : t.kind === KIND.TRANSFER && t.accountId === account.id ? -1 : 0;
  if (!sign) return 0;
  const cur = acctCur(account);
  const amount = cur === HOME ? t.amountCents : t.currency === cur && t.origCents > 0 ? t.origCents : convert(t.amountCents, HOME, cur) ?? t.amountCents;
  return sign * amount;
}
/** 账户余额（账户币种）= 初始余额 + 所有账单的影响。 */
const balanceOf = (a, txs) => (a.initialCents ?? 0) + txs.reduce((s, t) => s + effect(a, t), 0);

function accountsView() {
  if (state.accountId != null && state.data.account.has(state.accountId)) return accountDetailView();
  const accounts = [...state.data.account.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const txs = [...state.data.tx.values()];
  // 每个账户按自己的币种算余额，合计时再折成主货币（和手机端一样）
  const own = new Map(accounts.map((a) => [a.id, balanceOf(a, txs)]));
  const bal = new Map(accounts.map((a) => [a.id, toHome(a, own.get(a.id))]));
  // 垫出去还没报销回来的钱是应收款，也算资产（和手机端一样）
  const pending = pendingReimburse(txs);
  const assets = [...bal.values()].filter((v) => v > 0).reduce((s, v) => s + v, 0) + pending;
  const debts = -[...bal.values()].filter((v) => v < 0).reduce((s, v) => s + v, 0);
  const receivable = pending > 0 ? `<div class="card"><div class="dayhead"><span>${tr('应收', 'Receivable')}</span><span>${money(pending)}</span></div>
      <div class="row click" data-act="asset-tab" data-v="reimburse">${iconTile('receipt')}<div class="main"><div class="title">${tr('待报销', 'To reimburse')}</div></div><div class="right"><div class="num">${money(pending)}</div></div></div></div>` : '';
  const types = [[0, tr('储蓄账户', 'Savings')], [1, tr('投资账户', 'Investments')], [2, tr('信用账户', 'Credit')], [3, tr('现金账户', 'Cash')]];
  // 每个账户一张迷你卡面，颜色取自银行品牌色；列表里不放币种和国旗，详情页再看
  const face = (a) => {
    const b = own.get(a.id), notes = [acctCur(a) !== HOME ? `≈ ${money(bal.get(a.id))}` : '', b < 0 ? tr('欠款', 'Owed') : ''].filter(Boolean).join(' · ');
    return `<div class="face" style="--cc:${accountFace(a)}" data-act="account" data-v="${a.id}"><span class="logo-w">${accountTile(a)}</span><span class="name">${h(a.name)}</span>
      <div class="right"><div class="num">${b < 0 ? '−' : ''}${money(Math.abs(b), acctCur(a))}</div>${notes ? `<div class="small">${notes}</div>` : ''}</div></div>`;
  };
  const groups = types.map(([type, label]) => {
    const g = accounts.filter((a) => a.type === type && !a.archived);
    if (!g.length) return '';
    return `<div class="card"><div class="dayhead"><span>${label}</span><span>${money(g.reduce((s, a) => s + bal.get(a.id), 0))}</span></div>
      <div class="faces">${g.map(face).join('')}</div></div>`;
  }).join('');
  // 归档的账户收在最下面（余额照样算进净资产）
  const old = accounts.filter((a) => a.archived);
  const archivedCard = old.length ? `<div class="card"><div class="dayhead"><span>${tr(`已归档 ${old.length} 个`, `Archived (${old.length})`)}</span><span>${money(old.reduce((s, a) => s + bal.get(a.id), 0))}</span></div>
      ${old.map((a) => `<div class="row click" data-act="account" data-v="${a.id}">${accountTile(a)}<div class="main"><div class="title muted">${h(a.name)}</div></div><div class="right"><div class="num muted">${money(own.get(a.id), acctCur(a))}</div></div></div>`).join('')}</div>` : '';
  return `<div class="cols">
    <div class="card sticky"><div class="muted small">${tr('净资产', 'Net worth')}</div><div class="big num">${money(assets - debts)}</div>
      <div class="between" style="margin-top:10px"><div><div class="muted small">${tr('资产', 'Assets')}</div><div class="num in">${money(assets)}</div></div><div class="right"><div class="muted small">${tr('负债', 'Debts')}</div><div class="num out">${money(debts)}</div></div></div>
      ${assets + debts > 0 ? `<div class="ratio">${assets > 0 ? `<i style="flex:${assets};background:var(--income)"></i>` : ''}${debts > 0 ? `<i style="flex:${debts};background:var(--expense)"></i>` : ''}</div>
      <div class="small muted" style="margin-top:4px">${tr('负债率', 'Debt ratio')} ${Math.round(debts * 100 / Math.max(assets, 1))}%</div>` : ''}</div>
    <div class="grid">${netWorthCard()}${receivable}${groups}${archivedCard}</div></div>`;
}

function pendingReimburse(txs, upTo = Infinity) { return txs.filter((t) => t.reimburse === 1 && t.date <= upTo).reduce((s, t) => s + t.amountCents, 0); }

// ---------------------------------------------------------------- 记账 / 修改
// startEdit、editorView、saveEditing 在 modules/editor.js（自带数字键盘，和手机端一样）

// ---------------------------------------------------------------- 修正文件（和手机端同一种格式）
// 表头：操作,时间,类型,分类,二级分类,金额,账本,转出账户,转入账户,备注,报销,标签,币种,原币金额[,新备注]；操作是 删除 / 新增 / 改备注

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === ',') { row.push(cell); cell = ''; }
    else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; if (row.some((x) => x !== '')) rows.push(row); row = [];
    } else cell += c;
  }
  row.push(cell); if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

function readPatch(text) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const head = (rows[0] ?? []).map((x) => x.trim());
  if (head[0] !== '操作') throw new Error(tr('这不是修正文件：第一列应该是"操作"。', 'Not a fix file: the first column should be "操作".'));
  const col = (r, name) => (r[head.indexOf(name)] ?? '').trim();
  const accountByName = new Map([...state.data.account.values()].map((a) => [a.name, a]));
  const used = new Set();
  const all = [...state.data.tx.values()];
  const patch = { deletes: [], adds: [], notes: [], moves: [], lost: 0, bad: 0 };
  for (const r of rows.slice(1)) {
    const op = col(r, '操作');
    if (!['删除', '新增', '改备注', '改账户'].includes(op)) continue;
    const cents = Math.round(Math.abs(Number(col(r, '金额').replace(/,/g, ''))) * 100);
    const iso = col(r, '时间');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(cents)) { patch.bad++; continue; }
    const kind = col(r, '类型') === '收入' ? KIND.INCOME : col(r, '类型') === '转账' ? KIND.TRANSFER : KIND.EXPENSE;
    const row = {
      op, date: isoToDay(iso), iso, kind, cents, category: kind === KIND.TRANSFER ? '' : col(r, '分类'), sub: col(r, '二级分类'), ledger: col(r, '账本'),
      account: col(r, '转出账户'), toAccount: col(r, '转入账户'), note: col(r, '备注'), newNote: col(r, '新备注'), newAccount: col(r, '新账户'),
      tags: col(r, '标签').split(' ').map((x) => x.trim().replace(/^#/, '')).filter(Boolean).join(' '),
      reimburse: col(r, '报销') === '待报销' ? 1 : col(r, '报销') === '已报销' ? 2 : 0,
    };
    if (op === '新增') {
      // 账户必须是已有的，免得打错名字凭空多出一个账户
      if (!accountByName.has(row.account) || kind === KIND.TRANSFER && !accountByName.has(row.toAccount)) { patch.bad++; continue; }
      patch.adds.push(row); continue;
    }
    if (op === '改账户' && !accountByName.has(row.newAccount)) { patch.bad++; continue; }
    const name = (id) => state.data.account.get(id)?.name ?? '';
    const tx = all.find((t) => !used.has(t.id) && t.date === row.date && t.kind === kind && t.amountCents === cents && name(t.accountId) === row.account &&
      (kind !== KIND.TRANSFER || name(t.toAccountId) === row.toAccount) && (t.note ?? '').trim() === row.note);
    if (!tx) { patch.lost++; continue; }
    used.add(tx.id);
    if (op === '删除') patch.deletes.push({ row, tx }); else if (op === '改账户') patch.moves.push({ tx, account: accountByName.get(row.newAccount) }); else patch.notes.push({ tx, note: row.newNote });
  }
  return patch;
}

function patchView() {
  const p = state.patch;
  const line = (r) => `<div class="between small"><span>${r.iso} ${r.kind === KIND.TRANSFER ? h(r.account) + ' → ' + h(r.toAccount) : h([r.category, r.sub].filter(Boolean).join(' · ')) + ' ' + h(r.account)} <span class="muted">${h(r.note.slice(0, 40))}</span></span><span class="num">${money(r.cents)}</span></div>`;
  return `<div class="modal"><div class="card grid">
    <h2 style="margin:0">${tr('修正文件', 'Fix file')}</h2>
    <p class="muted" style="margin:0">${tr(`删除 ${p.deletes.length} 笔，新增 ${p.adds.length} 笔，改备注 ${p.notes.length} 笔，改账户 ${p.moves.length} 笔`, `Delete ${p.deletes.length}, add ${p.adds.length}, edit notes ${p.notes.length}, move ${p.moves.length}`)}${p.lost ? tr(`，${p.lost} 笔没找到`, `, ${p.lost} not found`) : ''}${p.bad ? tr(`，${p.bad} 行无效（日期、金额或账户不对）`, `, ${p.bad} invalid rows`) : ''}</p>
    ${p.deletes.length ? `<div><b class="out">${tr('删除', 'Delete')}</b>${p.deletes.map((d) => line(d.row)).join('')}</div>` : ''}
    ${p.adds.length ? `<div><b class="in">${tr('新增', 'Add')}</b>${p.adds.map(line).join('')}</div>` : ''}
    ${p.moves.length ? `<div><b>${tr('改账户', 'Move')}</b>${p.moves.slice(0, 40).map((m) => `<div class="small">${dayISO(m.tx.date)} ${money(m.tx.amountCents)} → ${h(m.account.name)} <span class="muted">${h((m.tx.note ?? '').slice(0, 50))}</span></div>`).join('')}</div>` : ''}
    ${p.notes.length ? `<div><b>${tr('改备注', 'Edit notes')}</b>${p.notes.slice(0, 20).map((n) => `<div class="small">${dayISO(n.tx.date)} ${money(n.tx.amountCents)} <span class="muted">${h(n.note.slice(0, 70))}</span></div>`).join('')}${p.notes.length > 20 ? '<div class="muted">…</div>' : ''}</div>` : ''}
    ${state.error ? `<p class="err">${h(state.error)}</p>` : ''}
    <div class="between"><button class="btn" data-act="patch-cancel">${tr('取消', 'Cancel')}</button><button class="btn primary" data-act="patch-apply" ${state.loading || !(p.deletes.length + p.adds.length + p.notes.length + p.moves.length) ? 'disabled' : ''}>${state.loading ? tr('正在写入…', 'Writing…') : tr('应用修正', 'Apply')}</button></div>
  </div></div>`;
}

async function applyPatch() {
  const p = state.patch, user = state.session.user, records = [];
  const cats = [...state.data.category.values()];
  let seq = 0;
  // 分类按名字找，没有就新建（和手机端导入表格时一样）
  const category = (name, sub, income) => {
    name = name || '其他';
    let top = cats.find((c) => !c.parentId && !!c.isIncome === income && c.name === name);
    if (!top) { top = { id: newId() + seq++, name, icon: iconKey(name), isIncome: income, sortOrder: cats.length, parentId: 0 }; cats.push(top); records.push({ user_id: user, kind: 'category', id: top.id, data: top, deleted: false }); }
    if (!sub || sub === name) return top.id;
    let leaf = cats.find((c) => c.parentId === top.id && c.name === sub);
    if (!leaf) { const icon = iconKey(sub); leaf = { id: newId() + seq++, name: sub, icon: icon === 'tag' ? top.icon : icon, isIncome: income, sortOrder: cats.length, parentId: top.id }; cats.push(leaf); records.push({ user_id: user, kind: 'category', id: leaf.id, data: leaf, deleted: false }); }
    return leaf.id;
  };
  const account = (name) => [...state.data.account.values()].find((a) => a.name === name)?.id ?? 0;
  const ledger = (name) => [...state.data.ledger.values()].find((l) => l.name === name)?.id ?? state.ledgerId;
  for (const d of p.deletes) records.push({ user_id: user, kind: 'tx', id: d.tx.id, data: {}, deleted: true });
  for (const n of p.notes) if ((n.tx.note ?? '') !== n.note) records.push({ user_id: user, kind: 'tx', id: n.tx.id, data: { ...n.tx, note: n.note }, deleted: false });
  for (const m of p.moves) if (m.tx.accountId !== m.account.id && m.tx.toAccountId !== m.account.id) records.push({ user_id: user, kind: 'tx', id: m.tx.id, data: { ...m.tx, accountId: m.account.id }, deleted: false });
  for (const r of p.adds) {
    const transfer = r.kind === KIND.TRANSFER;
    const t = {
      id: newId() + seq++, amountCents: r.cents, kind: r.kind, categoryId: transfer ? 0 : category(r.category, r.sub, r.kind === KIND.INCOME),
      accountId: account(r.account), toAccountId: transfer ? account(r.toAccount) : 0, ledgerId: ledger(r.ledger), date: r.date, note: r.note, tags: r.tags,
      reimburse: r.kind === KIND.EXPENSE ? r.reimburse : 0, createdAt: Date.now(), currency: '', origCents: 0, excluded: false, offsetOf: 0, offsetParts: '',
    };
    records.push({ user_id: user, kind: 'tx', id: t.id, data: t, deleted: false });
  }
  // 一次写两百行，全部成功后再更新页面上的数据
  for (let i = 0; i < records.length; i += 200) {
    await api('POST', '/rest/v1/records?on_conflict=user_id,kind,id', records.slice(i, i + 200), { prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  for (const r of records) { if (r.deleted) state.data[r.kind].delete(r.id); else state.data[r.kind].set(r.id, r.data); }
}

// ---------------------------------------------------------------- 事件

app.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, v = el.dataset.v;
  if (act === 'close-backdrop' && ev.target !== el) return;
  switch (act) {
    case 'mode': state.authEmail = document.getElementById('l-email')?.value.trim() || state.authEmail; state.authMode = v; state.error = ''; state.notice = ''; render(); break;
    case 'lang': setLang(v); break;
    case 'pw-eye': { const inp = document.getElementById(v); if (inp) { inp.type = inp.type === 'password' ? 'text' : 'password'; el.textContent = inp.type === 'password' ? tr('显示', 'Show') : tr('隐藏', 'Hide'); } break; }
    case 'auth-resend': {
      // 重发确认邮件 / 重设邮件：发信频率有限制，失败时给出能看懂的提示
      const email = (document.getElementById('l-email')?.value.trim() || state.authEmail || '').trim();
      if (!email.includes('@')) { state.error = tr('请填写邮箱。', 'Please enter your email.'); render(); break; }
      state.loading = true; state.error = ''; render();
      try {
        if (state.sentKind === 'recovery' && state.authMode === 'sent') await api('POST', '/auth/v1/recover?redirect_to=' + HERE, { email }, { auth: false });
        else await api('POST', '/auth/v1/resend?redirect_to=' + HERE, { type: 'signup', email }, { auth: false });
        state.authEmail = email; state.sentKind = state.sentKind === 'recovery' && state.authMode === 'sent' ? 'recovery' : 'signup';
        state.authMode = 'sent'; state.unconfirmed = false; state.notice = tr('已重新发送。', 'Sent again.');
      } catch (e) { state.error = e.message; }
      state.loading = false; render(); break;
    }
    case 'auth': {
      const mode = state.authMode || 'login', val = (id) => document.getElementById(id)?.value ?? '';
      if (!CLOUD.url) {
        state.cfg = { url: val('l-url').trim(), key: val('l-key').trim() };
        store.set('hl.cfg', state.cfg);
      }
      const email = val('l-email').trim(), pass = val('l-pass'), pass2 = val('l-pass2');
      if (mode !== 'reset') state.authEmail = email;
      state.loading = true; state.error = ''; state.notice = ''; state.unconfirmed = false; render();
      try {
        if (mode !== 'reset' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(tr('请填写正确的邮箱。', 'Please enter a valid email.'));
        if (mode !== 'forgot' && pass.length < 6) throw new Error(tr('密码至少 6 位。', 'Password needs at least 6 characters.'));
        if ((mode === 'register' || mode === 'reset') && pass !== pass2) throw new Error(tr('两次输入的密码不一样。', 'The passwords don\'t match.'));
        if (mode === 'forgot') {
          await api('POST', '/auth/v1/recover?redirect_to=' + HERE, { email }, { auth: false });
          state.loading = false; state.authMode = 'sent'; state.sentKind = 'recovery'; render(); break;
        }
        if (mode === 'reset') {
          // 邮件链接带来的临时登录：改好密码就直接进去，不用再输一遍
          const res = await fetch(state.cfg.url.replace(/\/+$/, '') + '/auth/v1/user', { method: 'PUT', headers: { apikey: state.cfg.key, 'Content-Type': 'application/json', Authorization: `Bearer ${state.recover.access_token}` }, body: JSON.stringify({ password: pass }) });
          if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(/same|different/i.test(j.msg || '') ? tr('新密码不能和旧密码一样。', 'New password must differ from the old one.') : res.status === 401 || res.status === 403 ? tr('链接已失效，请重新点"忘记密码"。', 'The link has expired. Use "Forgot password" again.') : `${res.status} ${j.msg || ''}`); }
          const user = await res.json().catch(() => null);
          saveSession({ ...state.recover, user: user ?? state.recover.user });
          state.recover = null; state.loading = false; state.authMode = 'login'; state.notice = tr('密码已改好，已登录。', 'Password changed. You\'re signed in.');
          await loadAll(); break;
        }
        const o = mode === 'register'
          ? await api('POST', '/auth/v1/signup?redirect_to=' + HERE, { email, password: pass }, { auth: false })
          : await api('POST', '/auth/v1/token?grant_type=password', { email, password: pass }, { auth: false });
        // 开着邮箱验证时，注册不会直接给登录凭证；已注册过的邮箱 Supabase 也会假装成功（identities 为空）
        if (!o.access_token) {
          state.loading = false;
          if (mode === 'register' && Array.isArray(o.identities) && o.identities.length === 0) { state.authMode = 'login'; state.error = tr('这个邮箱已经注册过，直接登录或找回密码。', 'This email is already registered. Sign in or reset your password.'); }
          else { state.authMode = 'sent'; state.sentKind = 'signup'; }
          render(); break;
        }
        saveSession(o); state.loading = false; state.authMode = 'login'; await loadAll();
      } catch (e) { state.loading = false; state.error = e.message; state.unconfirmed = !!e.unconfirmed; render(); }
      break;
    }
    case 'patch-cancel': state.patch = null; state.error = ''; render(); break;
    case 'patch-apply':
      state.loading = true; state.error = ''; render();
      try { await applyPatch(); state.patch = null; state.notice = ''; } catch (e) { state.error = tr('没有写完，可以再点一次：', 'Not finished, try again: ') + e.message; }
      state.loading = false; render(); break;
    case 'signout': if (confirm(tr('退出登录？', 'Sign out?'))) signOut(); break;
    case 'notice-x': state.notice = ''; render(); break;
    default: if (await aiAction(act, v) || await moreAction(act, v, el)) break;
      for (const f of MOD.actions) { if (await f(act, v, el)) break; }
      break; // 没人认领的按钮什么也不做（以前会掉下去刷新全部数据）
    case 'reload': await loadAll(); break;
    case 'tab': state.tab = v; scrollTo(0, 0); state.q = ''; state.searching = false; state.accountId = null; state.project = null; state.openKey = null; render(); break;
    case 'month': { const d = new Date(state.month.y, state.month.m - 1 + Number(v), 1); state.month = monthOf(d); state.calDay = null; render(); break; }
    case 'stats-kind': state.statsIncome = v === '1'; state.openTop = null; render(); break;
    case 'open-top': state.openTop = state.openTop === Number(v) ? null : Number(v); render(); break;
    case 'new': state.error = ''; startEdit(null); break;
    case 'edit': state.error = ''; startEdit(state.data.tx.get(Number(v))); break;
    case 'e-kind': edKind(Number(v)); break;
    case 'close': case 'close-backdrop': state.editing = null; state.error = ''; render(); break;
    case 'save': await saveEditing(); break;
    case 'delete': await edDeleteEditing(); break;
  }
});
// 一句话记账的输入条：回车或点箭头就发出去
app.addEventListener('submit', (ev) => {
  if (ev.target.dataset.form !== 'ask') return;
  ev.preventDefault();
  const input = ev.target.querySelector('input'); const text = input.value; input.value = '';
  sendAsk(text);
});
app.addEventListener('input', (ev) => {
  // 搜索框：边打字边搜；重画之后把光标放回去
  // 用拼音输入法打字时，选字之前不重画，不然字会被打断
  if (ev.target.id !== 'q' || ev.isComposing) return;
  state.q = ev.target.value; render();
  const q = document.getElementById('q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length);
});
app.addEventListener('compositionend', (ev) => {
  if (ev.target.id !== 'q' || ev.target.value === state.q) return;
  state.q = ev.target.value; render();
  const q = document.getElementById('q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length);
});
// 搜索框：回车记进"最近搜索"，Esc 关掉搜索页
app.addEventListener('keydown', (ev) => {
  if (ev.target.id !== 'q' || ev.isComposing) return;
  if (ev.key === 'Enter') { rememberSearch(ev.target.value); ev.preventDefault(); }
  else if (ev.key === 'Escape') { state.searching = false; state.q = ''; render(); }
});
app.addEventListener('change', async (ev) => {
  if (await aiChange(ev) || await moreChange(ev)) return;
  for (const f of MOD.changes) if (await f(ev)) return;
  if (ev.target.id === 'patch-file' && ev.target.files[0]) {
    try { state.patch = readPatch(await ev.target.files[0].text()); state.error = ''; } catch (e) { state.error = e.message; }
    render(); return;
  }
  if (ev.target.dataset.act === 'ledger') { state.ledgerId = Number(ev.target.value); store.set('hl.ledger', state.ledgerId); render(); }
});

// 点了邮件里的链接会带着一串参数跳回这里（Supabase 把结果放在 # 后面，出错时有时放在 ? 后面）：
// 确认注册 → 直接登录；重设密码 → 进入"设置新密码"；链接过期 → 说清楚并让用户重发。处理完把地址栏抹干净。
(async () => {
  const p = new URLSearchParams(location.hash.slice(1)), q = new URLSearchParams(location.search);
  const err = p.get('error_description') || q.get('error_description'), code = p.get('error_code') || q.get('error_code');
  if (location.hash || q.has('error') || q.has('code')) history.replaceState(null, '', location.pathname);
  if (err) {
    state.authMode = 'login';
    state.error = code === 'otp_expired' || /expired|invalid/i.test(err)
      ? tr('邮件里的链接已过期或已用过。可以重发确认邮件，或点"忘记密码"重新获取。', 'That email link has expired or was already used. Resend the confirmation, or use "Forgot password".')
      : err;
    state.unconfirmed = true; render(); return;
  }
  const access = p.get('access_token');
  if (!access) return;
  const tokens = { access_token: access, refresh_token: p.get('refresh_token'), expires_in: Number(p.get('expires_in')) || 3600 };
  try {
    // 用链接带来的凭证问一下是谁
    const res = await fetch(state.cfg.url.replace(/\/+$/, '') + '/auth/v1/user', { headers: { apikey: state.cfg.key, Authorization: `Bearer ${access}` } });
    if (!res.ok) throw new Error(String(res.status));
    const user = await res.json();
    if (p.get('type') === 'recovery') {
      state.session = null; state.recover = { ...tokens, user }; state.authEmail = user.email; state.authMode = 'reset'; render(); return;
    }
    saveSession({ ...tokens, user });
    state.notice = tr('邮箱已确认，已登录。', 'Email confirmed. You\'re signed in.');
    await loadAll();
  } catch {
    state.authMode = 'login'; state.notice = tr('邮箱已确认，请登录。', 'Email confirmed. Please sign in.'); render();
  }
})();
render();
refreshRates();
if (state.session) loadAll();
// 从后台切回来时顺手刷新一次（手机上改的账这边也能看到）
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.session && !state.editing && Date.now() - (loadAll.at ?? 0) > 60000) { loadAll.at = Date.now(); loadAll(); } });
