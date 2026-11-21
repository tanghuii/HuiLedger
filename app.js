// 行星记账网页版。没有构建步骤：纯 JS，直接连 Supabase。
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
function dayLabel(day) {
  // 今天、昨天前面加个前缀（和 App 一样）
  const n = new Date(), td = epochDay(n.getFullYear(), n.getMonth() + 1, n.getDate());
  const pre = day === td ? tr('今天 · ', 'Today · ') : day === td - 1 ? tr('昨天 · ', 'Yesterday · ') : '';
  const d = dayToDate(day); return pre + tr(`${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEK[d.getUTCDay()]}`, `${WEEK[d.getUTCDay()]}, ${MONTH_EN[d.getUTCMonth()]} ${d.getUTCDate()}`); }
// 币种和符号：和手机端 Fx.kt 的 CODES、SYMBOLS 一样（没有符号的写成 "SEK 12.00"）
const FX_CODES = ['EUR', 'CNY', 'USD', 'GBP', 'JPY', 'HKD', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN', 'CZK', 'HUF', 'TRY', 'AUD', 'CAD', 'SGD', 'KRW', 'THB', 'MYR', 'INR', 'NZD', 'ISK', 'RON'];
const SYMBOL = { EUR: '€', CNY: '¥', USD: '$', GBP: '£', JPY: 'JP¥', HKD: 'HK$', CHF: 'CHF ', AUD: 'A$', CAD: 'C$', SGD: 'S$', KRW: '₩', THB: '฿', INR: '₹', TRY: '₺', PLN: 'zł ' };
/** 主货币：所有合计、余额、统计都用它。和手机共享（云端设置 home），每次读完数据后由 hmSyncHome() 更新。 */
let HOME = 'EUR';
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

// ---- 连云端：统一走我们自己的地址 planet.tanghui.app（Cloudflare Worker，见 cloudflare/worker.js，中国大陆也能连）；它不通时自动直连 supabase.co
const CLOUD_RELAY = 'https://planet.tanghui.app';
/** 依次要试的云端地址：上次能用的那个在前。只有内置的云端项目才有中转。 */
function cloudBases() {
  const direct = state.cfg.url.replace(/\/+$/, '');
  if (!CLOUD.url || direct !== CLOUD.url.replace(/\/+$/, '')) return [direct];
  // 平时都走 planet.tanghui.app；它连不上时才直连 supabase.co（并记住，下次先直连）
  return store.get('hl.apiBase', '') === 'direct' ? [direct, CLOUD_RELAY] : [CLOUD_RELAY, direct];
}
/** 和 fetch 一样，只是网络不通时换下一个地址再试；成功的那个记下来，下次先用它。 */
async function cloudFetch(path, init) {
  const bases = cloudBases();
  let lastErr;
  for (const base of bases) {
    try {
      const res = await fetch(base + path, init);
      if (bases.length > 1) store.set('hl.apiBase', base === CLOUD_RELAY ? 'relay' : 'direct');
      return res;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function api(method, path, body, { auth = true, prefer } = {}) {
  const { key } = state.cfg;
  const headers = { apikey: key, 'Content-Type': 'application/json', Authorization: `Bearer ${auth ? await accessToken() : key}` };
  if (prefer) headers.Prefer = prefer;
  let res;
  try {
    res = await cloudFetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
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
  // 手上已经有数据（之前读过，或者从快照读出来）就算"有底"：断网时只提示离线，不报错
  const hadSnap = state.data.tx.size > 0 || state.data.category.size > 0 || await loadSnapshot();
  pickLedger();
  hmSyncHome();
  state.loading = !hadSnap && !state.data.tx.size; state.error = ''; hm.syncing = true; render();
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
    // 全新的账号：先放好默认账本、账户和分类，打开就能记账
    if (!fresh.category.size && !fresh.ledger.size && !fresh.account.size && !fresh.tx.size) await seedDefaults();
    // 主货币跟着云端走（手机上改了，这边也跟着变），自动记账等模块用到金额之前先更新
    hmSyncHome();
    hm.syncedAt = Date.now();
    saveSnapshot();
    for (const f of MOD.onLoad) { try { await f(); } catch (e) { console.warn(e); } }
    pickLedger();
  } catch (e) { if (!(hadSnap && isNetworkError(e))) state.error = e.message; else state.notice = tr('离线中，显示的是上次的数据', 'Offline: showing last saved data'); }
  state.loading = false; hm.syncing = false; render();
}

/** 当前账本不存在（第一次打开、账本被删）时，默认打开账单最多的那个账本。 */
function pickLedger() {
  if (!state.data.ledger.size || state.data.ledger.has(state.ledgerId)) return;
  const count = new Map();
  for (const t of state.data.tx.values()) count.set(t.ledgerId, (count.get(t.ledgerId) ?? 0) + 1);
  state.ledgerId = [...state.data.ledger.values()].sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0))[0]?.id ?? 1;
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
  const isReimburse = (t) => (t.kind === KIND.EXPENSE ? t.reimburse !== 0 : t.kind === KIND.INCOME && top(t.categoryId)?.name === '报销');
  // "报销"收入关联的支出只是记一下是哪几笔报回来了，不抵扣：支出的净额不变，这笔收入也整笔算"报销收入"（两边本来就不进总收支）
  const claim = (t) => t.kind === KIND.INCOME && isReimburse(t);
  const offsets = new Map();
  for (const t of txs.values()) if (!claim(t)) for (const [id, c] of parts(t)) offsets.set(id, (offsets.get(id) ?? 0) + c);
  const rest = (t) => (claim(t) ? t.amountCents : Math.max(0, t.amountCents - parts(t).reduce((s, p) => s + p[1], 0)));
  const net = (t) => (t.kind === KIND.EXPENSE ? t.amountCents - (offsets.get(t.id) ?? 0) : t.kind === KIND.INCOME ? rest(t) : t.amountCents);
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
  return { top, parts, offsets, net, isReimburse, isRefund, isOffset, counts, totals, claim };
}

function monthTxs() {
  const { y, m } = state.month;
  const from = epochDay(y, m, 1), to = epochDay(y, m + 1, 0);
  return [...state.data.tx.values()].filter((t) => t.ledgerId === state.ledgerId && t.date >= from && t.date <= to)
    .sort((a, b) => b.date - a.date || (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id - a.id);
}

// ---------------------------------------------------------------- 界面

const app = document.getElementById('app');

// 手机上（装成主屏幕 App）和 App 一个样子：顶栏是账本名字 + 切换 / 搜索 / 日历，底栏选中的页签垫一块圆角底，
// 二级页面没有底栏、顶上一条返回栏，返回到从哪儿来的那一页。电脑宽屏仍是原来那一排按钮。
const HM_MAIN = ['ledger', 'stats', 'accounts', 'me'];
const hm = { prev: null, back: {}, nav: null, t: 0 };
const hmSvg = (d, cls = '') => `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

function render() {
  if (!state.session) { app.innerHTML = loginView(); return; }
  // 日历不再是单独的页面：它是"明细"的另一种看法（和 App 一样），state.tab = 'calendar' 只是个别名
  if (state.tab === 'calendar') { state.tab = 'ledger'; state.calendarMode = true; }
  // 账单详情是一整页（和 App 一样）：盖住当前页面，底栏收起；退回来时列表还停在原来的位置
  const viewing = viewingTx(), opening = viewing && hm.viewId !== state.view;
  if (viewing && hm.viewId == null) hm.viewY = window.scrollY;
  const leaving = !viewing && hm.viewId != null;
  hm.viewId = viewing ? state.view : null;
  // 画之前对一下滚动位置：换页时已经回到顶上了，卡片就直接画成展开的，不要先收着再弹开（看详情时列表的样子原样留着）
  const y = leaving ? hm.viewY ?? 0 : window.scrollY;
  if (!viewing && (y <= 24 || state.tab !== 'ledger' || state.calendarMode)) hm.mini = false;
  hm.scrolled = !viewing && state.tab === 'ledger' && hmNarrow.matches && y > 2;
  const entering = hm.prev != null && (hm.prev !== state.tab || (state.tab === 'ledger' && hm.prevCal !== !!state.calendarMode));
  hm.prevCal = !!state.calendarMode;
  hmTrack();
  // 和手机端一样的分法：报销、补贴、周期性收支、对账都收在资产里
  const tabs = [['ledger', tr('明细', 'Ledger')], ['calendar', tr('日历', 'Calendar')], ['stats', tr('统计', 'Stats')], ['accounts', tr('资产', 'Assets')], ['ask', tr('问账本', 'Ask')], ['me', tr('我的', 'Me')]];
  const ledgers = [...state.data.ledger.values()].sort((a, b) => a.id - b.id);
  const searching = state.searching || !!state.q.trim();
  const main = HM_MAIN.includes(state.tab) && !searching && !viewing;
  const cal = state.tab === 'ledger' && !!state.calendarMode;
  const title = cal ? tr('日历', 'Calendar') : state.tab === 'ledger' ? state.data.ledger.get(state.ledgerId)?.name ?? tr('记账本', 'Ledger')
    : { stats: tr('统计', 'Stats'), accounts: tr('资产', 'Assets'), me: tr('我的', 'Me') }[state.tab] ?? '';
  let body = state.loading ? `<p class="muted">${tr('正在读取…', 'Loading…')}</p>` : viewing ? detailView() : searching ? searchView() : pageView();
  // 二级页面自己没带返回栏的（比如别的模块新加的页面），补一条，免得手机上没有底栏时回不去
  if (!state.loading && !searching && !viewing && !HM_MAIN.includes(state.tab) && !body.includes('class="subbar"')) body = hmBackBar() + body;
  const navIdx = { ledger: 0, calendar: 0, stats: 1, accounts: 3, me: 4 }[state.tab];
  const navBtn = ([k, n, i]) => `<button class="${navIdx === { ledger: 0, stats: 1, accounts: 3, me: 4 }[k] ? 'on' : ''}" data-act="tab" data-v="${k}">${navIcon(i)}<span>${n}</span></button>`;
  // 电脑宽屏那一排页签：明细 / 日历 分开亮
  const tabOn = (k) => (k === 'ledger' ? state.tab === 'ledger' && !cal : k === 'calendar' ? cal : state.tab === k);
  app.innerHTML = `<div class="wrap hm-t-${h(state.tab)}${cal ? ' hm-cal' : ''}${hm.scrolled ? ' hm-scrolled' : ''}${entering && !viewing ? ' hm-enter' : ''}${opening ? ' dt-enter' : ''}${leaving ? ' dt-leave' : ''}${viewing ? ' dt-on' : ''}">
    <div class="top${main ? '' : ' hm-sub'}${state.tab === 'ledger' && !cal ? ' hm-shim' : ''}">
      <h1><span class="hm-d">${tr('行星记账', 'Planet Ledger')}</span><span class="hm-p">${h(title)}</span>${typeof plTwinkle === 'function' ? plTwinkle() : ''}</h1>
      ${ledgers.length > 1 ? `<select style="width:auto" data-act="ledger">${ledgers.map((l) => `<option value="${l.id}" ${l.id === state.ledgerId ? 'selected' : ''}>${h(l.name)}</option>`).join('')}</select>` : ''}
      <div class="tabs">${tabs.map(([k, n]) => `<button class="${tabOn(k) ? 'on' : ''}" data-act="tab" data-v="${k}"${k === 'ledger' ? ' data-list="1"' : ''}>${n}</button>`).join('')}</div>
      <button class="search" data-act="search-open">${SEARCH_SVG}<span>${tr('搜索全部账单', 'Search all')}</span></button>
      <label class="btn" style="cursor:pointer">${tr('导入修正文件', 'Import fixes')}<input type="file" id="patch-file" accept=".csv,text/csv" hidden></label>
      <button class="btn" data-act="ai-settings">${tr('AI 设置', 'AI settings')}</button>
      <button class="btn" data-act="export">${tr('导出', 'Export')}</button>
      <button class="btn" data-act="reload">${tr('刷新', 'Refresh')}</button>
      ${langSwitch()}
      <button class="btn" data-act="signout">${tr('退出', 'Sign out')}</button>
      ${state.tab === 'ledger' && main ? hmTopActions(ledgers, cal) : ''}
    </div>
    ${state.error ? `<p class="err">${h(state.error)}</p>` : ''}${state.notice ? `<p class="ok small" data-act="notice-x">${h(state.notice)}</p>` : ''}
    ${body}
  </div>
  ${state.tab === 'ledger' && !state.loading && !viewing ? `<button class="fab" data-act="new" aria-label="${tr('记一笔', 'Add')}">+</button>` : ''}
  ${navIdx != null && !searching && !viewing ? `<nav class="bottom-nav"><i class="hm-pill" style="--i:${navIdx}" data-i="${navIdx}"></i>
    ${[['ledger', tr('明细', 'Ledger'), 'list'], ['stats', tr('统计', 'Stats'), 'pie']].map(navBtn).join('')}
    <button class="nav-add" data-act="new" aria-label="${tr('记一笔', 'Add')}">${hmSvg(ICONS.plus.d)}${typeof plNavOrbit === 'function' ? plNavOrbit() : ''}</button>
    ${[['accounts', tr('资产', 'Assets'), 'wallet'], ['me', tr('我的', 'Me'), 'user']].map(navBtn).join('')}
  </nav>` : ''}
  ${state.aiSettings ? aiSettingsView() : ''}${state.editing ? editorView() : ''}${state.patch ? patchView() : ''}${typeof plSheet === 'function' ? plSheet() : ''}`;
  if (opening) window.scrollTo(0, 0);
  if (leaving) { hm.viewY = null; window.scrollTo(0, y); }
  hmAfter();
}

const navIcon = (k) => `<svg viewBox="0 0 24 24"><path d="${(ICONS[k] ?? ICONS.tag).d}"/></svg>`;

/** 记下每个二级页面是从哪一页进来的，返回栏就回到那里（回到底栏上的页面时清空）。 */
function hmTrack() {
  const cur = state.tab;
  if (cur !== hm.prev) {
    if (HM_MAIN.includes(cur)) hm.back = {};
    else if (hm.prev && hm.back[hm.prev] !== cur) hm.back[cur] = hm.prev;
    state.hmMenu = false; state.hmCurMenu = false; state.hmSwMsg = null; state.plMPick = false; state.plSheet = false;
    if (!state.hmFx?.busy) state.hmFx = null;
  }
  hm.prev = cur;
}

/** 返回栏：和"我的"进去的那些页面一样的样子。 */
function hmBackBar() {
  const name = { settings: tr('设置', 'Settings'), appearance: tr('外观', 'Appearance'), manage: tr('管理', 'Manage') }[state.tab] ?? MOD.me.find((m) => m.key === state.tab)?.name ?? '';
  return `<div class="subbar"><button class="round" data-act="tab" data-v="me" aria-label="${tr('返回', 'Back')}">‹</button><b>${h(name)}</b></div>`;
}

/** 首页顶栏右边：切换账本（不止一个账本时）、搜索、日历。日历模式下只有搜索和回到列表（和 App 的日历页一样）。 */
function hmTopActions(ledgers, cal = false) {
  if (cal) return `<div class="hm-acts">
    <button class="hm-ib" data-act="search-open" aria-label="${tr('搜索', 'Search')}">${SEARCH_SVG}</button>
    <button class="hm-ib" data-act="hm-cal" data-v="0" aria-label="${tr('列表', 'List')}">${hmSvg(ICONS.list.d)}</button>
  </div>`;
  const menu = state.hmMenu ? `<div class="hm-menu-bg" data-act="hm-menu-x"></div><div class="hm-menu" role="menu">${ledgers.map((l) => {
    const c = typeof ledgerColor === 'function' ? ledgerColor(l.id) : null;
    return `<button class="${l.id === state.ledgerId ? 'on' : ''}" role="menuitem" data-act="hm-ledger" data-v="${l.id}"><span class="hm-ld"${c ? ` style="background:${c}"` : ''}></span><span class="hm-ln">${h(l.name)}</span>${l.id === state.ledgerId ? hmSvg(ICONS.check.d, 'hm-ck') : ''}</button>`;
  }).join('')}</div>` : '';
  return `<div class="hm-acts">
    ${ledgers.length > 1 ? `<button class="hm-chip" data-act="hm-menu" aria-haspopup="menu" aria-expanded="${state.hmMenu ? 'true' : 'false'}">${hmSvg(ICONS.layers.d)}<span>${tr('切换', 'Switch')}</span><i>▾</i></button>${menu}` : ''}
    <button class="hm-ib" data-act="search-open" aria-label="${tr('搜索', 'Search')}">${SEARCH_SVG}</button>
    <button class="hm-ib" data-act="hm-cal" data-v="1" aria-label="${tr('日历', 'Calendar')}">${hmSvg(ICONS.calendar.d)}</button>
  </div>`;
}

/** 画完以后：汇总卡片翻回原来那一页、返回栏指向来的那一页、底栏的圆角底从上一个页签滑过来。 */
function hmAfter() {
  const p = app.querySelector('.hm-pager');
  if (p) {
    const i = Math.min(2, Math.max(0, state.hmPage ?? 0));
    if (i) p.scrollLeft = i * hmStride(p);
    hmPagerSize(p, i); hmDots(p, i);
  }
  // 主货币的下拉：卡片都是磨砂玻璃（各自一层），菜单放在外面、按按钮的位置摆
  const cm = app.querySelector('.hm-curmenu'), chip = app.querySelector('[data-act="hm-cur"]');
  if (cm && chip) {
    const r = chip.getBoundingClientRect(), below = innerHeight - r.bottom - 16, above = r.top - 16;
    cm.style.right = Math.max(8, innerWidth - r.right) + 'px';
    if (below >= 260 || below >= above) { cm.style.top = r.bottom + 8 + 'px'; cm.style.maxHeight = below - 8 + 'px'; }
    else { cm.style.bottom = innerHeight - r.top + 8 + 'px'; cm.style.maxHeight = above - 8 + 'px'; }
  }
  const back = app.querySelector('.wrap > .subbar [data-act="tab"]');
  if (back) {
    if (hm.back[state.tab]) back.dataset.v = hm.back[state.tab];
    if (back.textContent.trim() === '‹') back.innerHTML = hmSvg(ICONS.back.d);
  }
  const pill = app.querySelector('.hm-pill');
  if (pill) {
    const i = Number(pill.dataset.i);
    if (hm.nav != null && hm.nav !== i && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      pill.style.transition = 'none'; pill.style.setProperty('--i', hm.nav); pill.getBoundingClientRect();
      pill.style.transition = ''; pill.style.setProperty('--i', i);
      app.querySelector('.bottom-nav button.on')?.classList.add('hop');
    }
    hm.nav = i;
  }
}

// ---- 汇总卡片左右滑（本月收支 / 预算 / 净资产）：CSS 负责吸附，这里只管小圆点和卡片高度跟着当前页
const hmStride = (p) => p.clientWidth + (parseFloat(getComputedStyle(p).columnGap) || 0);
const hmPageOf = (p) => Math.min(2, Math.max(0, Math.round(p.scrollLeft / Math.max(1, hmStride(p)))));
function hmPagerSize(p, i) { const pg = p.children[i]; if (pg) p.style.height = pg.offsetHeight + 'px'; }
function hmDots(p, i) { p.parentElement?.querySelectorAll('.hm-dots button').forEach((b, k) => b.classList.toggle('on', k === i)); }
document.addEventListener('scroll', (ev) => {
  const p = ev.target;
  if (!(p instanceof Element) || !p.classList.contains('hm-pager')) return;
  const i = hmPageOf(p);
  if (i !== state.hmPage) { state.hmPage = i; hmDots(p, i); }
  clearTimeout(hm.t); hm.t = setTimeout(() => { if (p.isConnected) hmPagerSize(p, hmPageOf(p)); }, 90);
}, true);
// ---- 汇总卡片收放（和 App 一样）：列表往下滚超过 24px，卡片收成一行；回到顶上再展开。只在手机布局下（电脑上卡片在左边一栏）。
// 被动的滚动监听，每帧最多算一次，只在状态变的时候改 class；收放的动画交给 CSS。
const hmNarrow = matchMedia('(max-width: 720px)');
function hmFold() {
  hm.raf = 0;
  if (hm.viewId != null) return; // 在看账单详情：列表那边的样子不动，退回去时原样
  const card = app.querySelector('.hm-sum'), wrap = app.querySelector('.wrap.hm-t-ledger'), y = window.scrollY;
  let mini = false;
  if (card && hmNarrow.matches) {
    if (hm.mini) mini = y > 24;
    else {
      // 收起后页面会变矮：要是剩下的不够继续往下滚就不收，免得收了又被弹回顶上、来回闪
      const room = document.documentElement.scrollHeight - innerHeight - Math.max(0, card.offsetHeight - 52);
      mini = y > 24 && room > 64;
    }
  }
  const scrolled = !!wrap && hmNarrow.matches && y > 2;
  if (scrolled !== hm.scrolled) { hm.scrolled = scrolled; wrap?.classList.toggle('hm-scrolled', scrolled); }
  if (mini === hm.mini) return;
  hm.mini = mini;
  if (!card) return;
  card.classList.toggle('mini', mini);
  card.querySelector('.hm-mini')?.setAttribute('aria-hidden', String(!mini));
}
addEventListener('scroll', () => {
  if (!hm.raf) hm.raf = requestAnimationFrame(hmFold);
  // 主货币的下拉是按按钮位置摆的，页面一滚就收起来
  if (state.hmCurMenu) { state.hmCurMenu = false; render(); }
}, { passive: true });
addEventListener('resize', () => { const p = app.querySelector('.hm-pager'); if (p) { p.scrollLeft = (state.hmPage ?? 0) * hmStride(p); hmPagerSize(p, state.hmPage ?? 0); } });

/** 汇总卡片上的小金币：结余为正就笑，为负就撇嘴（和 App 画法一样）。 */
function hmFace(happy) {
  const ink = '#2B2140';
  return `<svg class="hm-face" viewBox="0 0 100 100" aria-hidden="true"><circle cx="54" cy="54" r="46" fill="${ink}"/>
    <circle cx="48" cy="48" r="44" fill="#FFD34D" stroke="${ink}" stroke-width="5"/><circle cx="48" cy="48" r="30" fill="none" stroke="#FFE89A" stroke-width="3"/>
    <circle cx="35" cy="42" r="4.5" fill="${ink}"/><circle cx="61" cy="42" r="4.5" fill="${ink}"/><circle cx="27" cy="54" r="5" fill="#FF8FA8"/><circle cx="69" cy="54" r="5" fill="#FF8FA8"/>
    <path d="${happy ? 'M59.28 53.42A12 10 0 0 1 36.72 53.42' : 'M36.72 62.58A12 10 0 0 1 59.28 62.58'}" fill="none" stroke="${ink}" stroke-width="5" stroke-linecap="round"/></svg>`;
}

/** 汇总卡片第二页：预算花了多少、还剩多少、每日可用多少。 */
function hmBudgetPage(t) {
  const total = typeof BUD !== 'undefined' ? BUD.total() : 0;
  const { y, m } = state.month, now = new Date(), current = now.getFullYear() === y && now.getMonth() + 1 === m;
  const label = `<div class="muted hm-lbl">${current ? tr('本月预算', 'Budget this month') : tr(`${m}月预算`, `${MONTH_EN[m - 1]} budget`)}</div>`;
  if (total <= 0) return `<section class="hm-page" data-act="tab" data-v="budget">${label}<div class="hm-nob">${tr('还没设预算', 'No budget yet')}</div><div class="muted hm-lbl">${tr('在 我的 → 预算 里设置', 'Set it in Me → Budget')}</div></section>`;
  const spent = t.expense, left = total - spent, over = left < 0, ratio = Math.min(1, Math.max(0, spent / total));
  const daysLeft = current ? new Date(y, m, 0).getDate() - now.getDate() + 1 : 0;
  const bar = over ? 'var(--on-card-out)' : ratio > 0.8 ? '#FFE3A3' : '#fff';
  // 超了预算的分类
  const L = computeLookup(), cb = BUD.cats(), byTop = new Map();
  for (const x of monthTxs()) if (x.kind === KIND.EXPENSE && L.counts(x)) { const k = L.top(x.categoryId)?.id ?? -1; byTop.set(k, (byTop.get(k) ?? 0) + L.net(x)); }
  const overCats = [...byTop.entries()].filter(([id, c]) => { const b = Number(cb[String(id)]) || 0; return b > 0 && b < c; }).map(([id]) => state.data.category.get(id)?.name).filter(Boolean);
  return `<section class="hm-page" data-act="tab" data-v="budget">${label}
    <div class="hm-big num${over ? ' out' : ''}" style="font-size:30px">${over ? tr('超支 ' + money(-left), 'Over by ' + money(-left)) : tr('剩余 ' + money(left), money(left) + ' left')}</div>
    <div class="hm-barw"><div class="hm-bar"><i style="width:${(ratio * 100).toFixed(1)}%;background:linear-gradient(90deg, color-mix(in srgb, ${bar} 70%, transparent), ${bar})"></i></div><b class="pl-bmoon" style="left:${(ratio * 100).toFixed(1)}%" aria-hidden="true"></b></div>
    <div class="hm-bl muted"><span>${tr(`花费 ${money(spent)} / ${money(total)}`, `${money(spent)} of ${money(total)}`)}</span>${daysLeft > 0 && !over ? `<span>${tr(`每日可用 ${money(Math.floor(left / daysLeft))}`, `${money(Math.floor(left / daysLeft))} / day`)}</span>` : ''}</div>
    ${overCats.length ? `<div class="hm-oc out">${tr('超支分类：', 'Over budget: ')}${h(overCats.join(tr('、', ', ')))}</div>` : ''}</section>`;
}

/** 汇总卡片第三页：净资产 = 资产 − 负债，待报销算资产（和资产页一致）。 */
function hmWorthPage() {
  const txs = allTxs(), bal = [...state.data.account.values()].map((a) => toHome(a, balanceOf(a, txs)));
  const pending = pendingReimburse(txs);
  const assets = bal.filter((v) => v > 0).reduce((s, v) => s + v, 0) + pending, debts = -bal.filter((v) => v < 0).reduce((s, v) => s + v, 0);
  return `<section class="hm-page"><div class="muted hm-lbl">${tr('净资产', 'Net worth')}</div><div class="hm-big num">${money(assets - debts)}</div>
    <div class="hm-cells"><div><div class="muted hm-lbl2">${tr('资产', 'Assets')}</div><div class="num in hm-val">${money(assets)}</div></div><div><div class="muted hm-lbl2">${tr('负债', 'Debts')}</div><div class="num out hm-val">${money(debts)}</div></div></div>
    ${pending > 0 ? `<div class="amber hm-rl">${tr(`其中待报销 ${money(pending)}`, `Incl. ${money(pending)} to claim`)}</div>` : ''}</section>`;
}

/** "我的"页：个人卡片（记了几天、几笔、本月结余），下面一格一个功能入口，四列，和 App 一样。 */
function meView() {
  // 显示用户名（点一下改，和手机同步），不显示邮箱和本人姓名
  const txs = allTxs(), name = String(shared.get('nickname', '') || '').trim() || tr('星际旅人', 'Stargazer');
  const now = new Date(), from = epochDay(now.getFullYear(), now.getMonth() + 1, 1), to = epochDay(now.getFullYear(), now.getMonth() + 2, 0);
  const mt = computeLookup().totals(txs.filter((t) => t.ledgerId === state.ledgerId && t.date >= from && t.date <= to));
  const stats = [[String(new Set(txs.map((t) => t.date)).size), tr('记账天数', 'Days')], [String(txs.length), tr('账单', 'Entries')], [money(mt.income - mt.expense), tr('本月结余', 'This month')]];
  // 整理转账 / 整理分类 上的红色小数字：还有几处可以整理
  let tidy = {};
  try { if (typeof tidyCounts === 'function') tidy = tidyCounts() ?? {}; } catch (e) { console.warn(e); }
  const items = [
    MOD.pages.manage && { icon: 'layers', name: tr('账本', 'Books'), act: 'hm-go', v: 'ledgers' },
    MOD.pages.manage && { icon: 'basket', name: tr('分类', 'Categories'), act: 'hm-go', v: 'categories' },
    MOD.pages.budget && { icon: 'target', name: tr('预算', 'Budget'), v: 'budget' },
    MOD.pages.tags ? { icon: 'tag', name: tr('标签', 'Tags'), v: 'tags' } : { icon: 'tag', name: tr('标签', 'Tags'), act: 'hm-go', v: 'tags' },
    { icon: 'sparkle', name: tr('问账本', 'Ask'), v: 'ask' },
    MOD.pages['tidy-transfers'] && { icon: 'transfer', name: tr('整理转账', 'Tidy up'), v: 'tidy-transfers', badge: tidy.transfers },
    MOD.pages['tidy-cats'] && { icon: 'blocks', name: tr('整理分类', 'Categories+'), v: 'tidy-cats', badge: tidy.cats },
    MOD.pages.import ? { icon: 'camera', name: tr('导入', 'Import'), v: 'import' } : { icon: 'camera', name: tr('导入', 'Import'), file: true },
    MOD.pages.mood && { icon: 'heart', name: tr('支出心情', 'Spending mood'), v: 'mood' },
    MOD.pages.monthly && { icon: 'receipt', name: tr('月度账单', 'Monthly bill'), v: 'monthly' },
    { icon: 'upload', name: tr('导出', 'Export'), act: 'export' },
    { icon: 'wrench', name: tr('设置', 'Settings'), v: 'settings' },
  ].filter(Boolean);
  const icon = (it) => `<span class="hm-tw">${iconTile(it.icon)}${Number(it.badge) > 0 ? `<b class="hm-badge">${Number(it.badge) > 99 ? '99+' : Number(it.badge)}</b>` : ''}</span>`;
  const cell = (it) => it.file
    ? `<label class="hm-cell">${icon(it)}<span class="hm-cl">${h(it.name)}</span><input type="file" id="patch-file" accept=".csv,text/csv" hidden></label>`
    : `<button class="hm-cell" data-act="${it.act ?? 'tab'}" data-v="${h(it.v ?? '')}">${icon(it)}<span class="hm-cl">${h(it.name)}</span></button>`;
  return `<div class="grid hm-me">
    <div class="card cc hm-prof">
      <div class="hm-prow">${typeof plAvatar === 'function' ? plAvatar() : `<div class="hm-av">${tr('我', 'Me')}</div>`}<div class="hm-grow"><button class="hm-name" data-act="hm-nick"><span>${h(name)}</span>${hmSvg(ICONS.pencil.d)}</button><div class="muted hm-lname">${h(state.data.ledger.get(state.ledgerId)?.name ?? '')}</div></div></div>
      <div class="hm-stats">${stats.map(([v, l]) => `<div><b class="num">${h(v)}</b><span class="muted">${l}</span></div>`).join('')}</div>
    </div>
    <div class="card hm-gridcard"><div class="hm-grid">${items.map(cell).join('')}</div></div>
  </div>`;
}

// 网页的版本：发布脚本给 app.js 的地址带上 ?v=时间戳（20261120143005），这里换成 2026-11-20 14:30 显示在设置里
const WEB_VERSION = (() => {
  let v = '';
  try { v = new URL(document.currentScript?.src ?? '', location.href).searchParams.get('v') ?? ''; } catch { /* 没有就算了 */ }
  const p = (n) => String(n).padStart(2, '0');
  if (/^\d{14}$/.test(v)) return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)} ${v.slice(8, 10)}:${v.slice(10, 12)}`;
  if (/^\d{10}$/.test(v)) { const d = new Date(Number(v) * 1000); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
  return v;
})();

/** 币种的国旗：和手机端一样的圆角矩形小旗（flags.js）。 */
const hmFlag = (c) => flagSvg(c);
const hmCurLabel = (c) => { const sym = (SYMBOL[c] ?? '').trim(); return sym && sym !== c ? `${c} ${sym}` : c; };

/** 设置：和 App 的设置页同样的几块——语言、数据安全、提醒、外观、货币、AI、云端同步、版本。 */
function settingsView() {
  const row = (icon, name, attrs, value = '') => `<button class="hm-li" ${attrs}>${iconTile(icon)}<span class="hm-li-t">${h(name)}</span>${value ? `<span class="hm-li-v">${h(value)}</span>` : ''}${hmSvg(ICONS.forward.d, 'hm-chev')}</button>`;
  const mod = (key) => MOD.me.find((m) => m.key === key);
  const covered = ['budget', 'manage', 'settings', 'appearance', 'loans', 'schedules', 'backup', 'monthly', 'mood'];
  const modRow = (m) => (m ? row(m.icon ?? 'tag', m.name, `data-act="tab" data-v="${h(m.key)}"`) : '');
  const extra = (f) => { try { return typeof f === 'function' ? f() ?? '' : ''; } catch (e) { console.warn(e); return ''; } };
  const head = (t) => `<div class="hm-sh">${t}</div>`;
  const note = (o) => (o?.msg ? `<div class="hm-note${o.bad ? ' err' : ''}">${h(o.msg)}</div>` : '');

  // 语言：跟随系统 / 中文 / English
  const lang = `<div class="card hm-sc">${head('语言 / Language')}
    <div class="seg hm-seg">${[['auto', tr('跟随系统', 'System')], ['zh', '中文'], ['en', 'English']].map(([v, n]) => `<button class="${LANG_MODE === v ? 'on' : ''}" data-act="lang" data-v="${v}">${n}</button>`).join('')}</div></div>`;

  // 数据安全：立即备份（下载文件）/ 从备份恢复（备份页），上次备份是几天前
  const last = Number(store.get('hl.backupLast', 0)) || 0, ago = last ? Math.max(0, Math.floor((Date.now() - last) / 86400000)) : -1;
  const lastText = ago < 0 ? tr('还没备份过', 'Never backed up') : ago === 0 ? tr('上次备份 今天', 'Last backup today') : tr(`上次备份 ${ago} 天前`, `Last backup ${ago} day${ago === 1 ? '' : 's'} ago`);
  const safety = MOD.pages.backup ? `<div class="card hm-sc">${head(tr('数据安全', 'Data safety'))}
    <div class="hm-sub2${ago < 0 || ago > 30 ? ' amber' : ''}">${lastText}</div>
    <div class="hm-btns"><button class="btn" data-act="bk-download">${tr('立即备份', 'Back up now')}</button><button class="btn" data-act="tab" data-v="backup">${tr('从备份恢复', 'Restore')}</button></div></div>` : '';

  // 货币：主货币（换的时候全部折算）、汇率
  const menu = state.hmCurMenu ? `<div class="hm-menu-bg" data-act="hm-menu-x"></div><div class="hm-menu hm-curmenu" role="menu">${FX_CODES.map((c) => `<button class="${c === HOME ? 'on' : ''}" role="menuitem" data-act="hm-cur-pick" data-v="${c}"><span class="hm-flag">${hmFlag(c)}</span><span class="hm-ln">${h(hmCurLabel(c))}</span>${c === HOME ? hmSvg(ICONS.check.d, 'hm-ck') : ''}</button>`).join('')}</div>` : '';
  const rateLines = ['CNY', 'USD', 'GBP'].filter((c) => c !== HOME).slice(0, 2).map((c) => { const r = convert(1e8, HOME, c); return r == null ? '' : `<div>1 ${HOME} = ${(r / 1e8).toFixed(4)} ${c}</div>`; }).join('');
  const busy = state.hmFx?.busy;
  const currency = `<div class="card hm-sc">${head(tr('货币', 'Currency'))}
    <div class="hm-li"><span class="hm-li-t">${tr('主货币', 'Main currency')}</span>
      <span class="hm-acts hm-curw"><button class="hm-chip" data-act="hm-cur" aria-haspopup="menu" aria-expanded="${state.hmCurMenu ? 'true' : 'false'}" ${busy ? 'disabled' : ''}><span class="hm-flag">${hmFlag(HOME)}</span><span>${h(hmCurLabel(HOME))}</span><i>▾</i></button></span></div>
    <div class="hm-li"><div class="hm-li-c"><div>${tr('汇率', 'Exchange rates')}</div><div class="muted hm-rates">${Object.keys(fx.rates).length ? `<div>${tr('欧洲央行参考汇率', 'ECB reference rates')}${fx.date ? ' · ' + h(fx.date) : ''}</div>${rateLines}` : tr('还没有取到汇率，需要联网', 'No rates yet. Needs a connection.')}</div></div>
      <button class="btn link" data-act="hm-rates" ${state.hmRateBusy ? 'disabled' : ''}>${state.hmRateBusy ? tr('更新中…', 'Updating…') : tr('更新', 'Update')}</button></div>
    ${note(state.hmFx)}</div>`;
  const progress = busy ? `<div class="modal hm-fxbusy"><div class="card grid" role="alertdialog" aria-busy="true">
    <b>${tr(`正在折算成 ${h(state.hmFx.code)}…`, `Converting to ${h(state.hmFx.code)}…`)}</b>
    <div class="hm-bar hm-pbar"><i style="width:${state.hmFx.total ? Math.round(state.hmFx.done * 100 / state.hmFx.total) : 0}%"></i></div>
    <div class="muted small num">${state.hmFx.done} / ${state.hmFx.total || '…'}</div></div></div>` : '';

  // 云端同步：账号、立即同步、状态、退出登录
  const pending = outbox.list().length, t = hm.syncedAt ? new Date(hm.syncedAt) : null;
  const status = !navigator.onLine ? tr('离线中，联网后自动上传', 'Offline. Will upload when online.')
    : pending ? tr(`${pending} 条待上传`, `${pending} to upload`)
    : t ? tr('已同步 · ', 'Synced · ') + `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '';
  const cloud = `<div class="card hm-sc">
    <div class="hm-cl2">${iconTile('layers')}<div class="hm-grow"><b>${tr('云端同步', 'Cloud sync')}</b><div class="muted hm-sub2">${state.session ? h(tr('已登录', 'Signed in') + (String(shared.get('nickname', '') || '').trim() ? ' · ' + String(shared.get('nickname', '')).trim() : '')) : ''}</div></div></div>
    <div class="hm-btns"><button class="btn primary" data-act="reload" ${hm.syncing ? 'disabled' : ''}>${hm.syncing ? tr('正在同步…', 'Syncing…') : tr('立即同步', 'Sync now')}</button><button class="btn link hm-outl" data-act="hm-signout">${tr('退出登录', 'Sign out')}</button></div>
    ${status ? `<div class="muted hm-sub2">${status}</div>` : ''}
    <div class="hm-delrow"><button class="btn link hm-outl hm-del" data-act="hm-delete">${tr('注销账户', 'Delete account')}</button></div></div>`;

  // 版本（App 的"软件更新"）：网页是打开时自动拿最新的，有新版本时顶上会弹一条"点击刷新"
  const canCheck = !!navigator.serviceWorker?.controller;
  const install = STANDALONE ? '' : `<div class="hm-sub2 muted">${IS_IOS ? tr('在 Safari 点 分享 → 添加到主屏幕', 'In Safari: Share → Add to Home Screen') : tr('浏览器菜单 → 添加到主屏幕', 'Browser menu → Add to Home Screen')}</div>`;
  const version = `<div class="card hm-sc">
    <div class="hm-cl2">${iconTile('upload')}<div class="hm-grow"><b>${tr('网页版本', 'Web version')}</b><div class="muted hm-sub2 num">${h(WEB_VERSION || tr('开发版', 'Dev build'))}</div></div>
      ${canCheck ? `<button class="btn link" data-act="hm-sw-check" ${state.hmSwBusy ? 'disabled' : ''}>${state.hmSwBusy ? tr('正在检查…', 'Checking…') : tr('检查更新', 'Check')}</button>` : ''}</div>
    ${note(state.hmSwMsg)}${install}</div>`;

  return `<div class="grid hm-set">
    ${lang}${safety}
    ${extra(typeof lockSettingsHtml === 'function' ? lockSettingsHtml : null)}${extra(typeof remindersSettingsHtml === 'function' ? remindersSettingsHtml : null)}
    <div class="card hm-list">
      ${MOD.pages.appearance ? row('paint', tr('外观', 'Appearance'), 'data-act="tab" data-v="appearance"') : ''}
      ${typeof obOpen === 'function' ? row('sparkle', tr('使用向导', 'Setup guide'), 'data-act="ob-open"') : ''}
      ${MOD.pages.manage ? row('bank', tr('账户', 'Accounts'), 'data-act="hm-go" data-v="accounts"') : ''}
      ${modRow(mod('schedules'))}${modRow(mod('loans'))}
      ${MOD.me.filter((m) => !covered.includes(m.key)).map(modRow).join('')}
    </div>
    ${currency}
    <div class="card hm-list">
      ${row('chip', tr('AI 设置', 'AI settings'), 'data-act="ai-settings"', aiKey() ? AI_PROVIDERS[aiProvider()].name : tr('未设置', 'Not set'))}
      <label class="hm-li"><span class="tile" style="background:#FF8A3D">${hmSvg(ICONS.user.d)}</span><span class="hm-li-t">${tr('本人姓名', 'Your name')}</span><input class="hm-in" id="hm-owner" value="${h(store.get('hl.ownerName', '') ?? '')}" placeholder="${tr('导入时认出本人', 'For imports')}" autocomplete="name" enterkeyhint="done"></label>
    </div>
    ${cloud}${version}${progress}${menu}
  </div>`;
}
MOD.pages.settings = () => settingsView();
// 本人姓名：存在这个浏览器里（AI 导入时用来认出"本人"）
MOD.changes.push(async (ev) => {
  if (ev.target.id !== 'hm-owner') return false;
  const v = ev.target.value.trim();
  if (v) store.set('hl.ownerName', v); else store.del('hl.ownerName');
  return true;
});
MOD.me.push({ key: 'settings', get name() { return tr('设置', 'Settings'); }, icon: 'wrench', order: 95 });

// ---- 注销账户：云端的数据和登录账号都删掉，这台设备上存的也全部清空
/** 确认框：要打出「注销」两个字（英文 DELETE）才能点。返回 true / false。 */
function hmDeleteConfirm() {
  const word = tr('注销', 'DELETE');
  return new Promise((done) => {
    const box = document.createElement('div');
    box.className = 'modal ui-confirm';
    box.innerHTML = `<div class="card grid" role="alertdialog" aria-modal="true">
      <b style="font-size:17px">${tr('注销账户？', 'Delete your account?')}</b>
      <div class="muted small">${tr('云端和这台设备上的所有账单、账户、设置都会永久删除，不能恢复。需要的话先在「数据安全」里备份。', 'Every entry, account and setting in the cloud and on this device is deleted for good. Back up first under Data safety if you need it.')}</div>
      <div class="small">${tr(`输入「${word}」确认`, `Type "${word}" to confirm`)}</div>
      <input id="hm-del-word" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done">
      <div class="between"><button class="btn" data-x="0">${tr('取消', 'Cancel')}</button><button class="btn danger-fill" data-x="1" disabled>${tr('永久注销', 'Delete forever')}</button></div></div>`;
    const input = box.querySelector('#hm-del-word'), ok = box.querySelector('[data-x="1"]');
    input.addEventListener('input', () => { ok.disabled = input.value.trim().toUpperCase() !== word.toUpperCase(); });
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-x]');
      if (!b && ev.target !== box) return;
      if (b && b.disabled) return;
      box.remove(); done(b?.dataset.x === '1');
    });
    document.body.appendChild(box);
    setTimeout(() => input.focus(), 50);
  });
}
/** 这台设备上存的全部清掉：本地存储里的所有设置和密钥、离线快照、待上传的修改。 */
async function hmWipeLocal() {
  try { Object.keys(localStorage).filter((k) => k.startsWith('hl.')).forEach((k) => localStorage.removeItem(k)); } catch { /* 隐私模式 */ }
  try { snap._db && (await snap._db).close(); } catch { /* 没开过 */ }
  snap._db = null;
  try { await new Promise((ok) => { const r = indexedDB.deleteDatabase('huiledger'); r.onsuccess = r.onerror = r.onblocked = () => ok(); }); } catch { /* 没有就算了 */ }
}
async function hmDeleteAccount() {
  if (!state.session || !await hmDeleteConfirm()) return;
  state.notice = ''; state.error = '';
  let partial = false;
  try {
    // 后台要先装好 delete_my_account()（supabase/delete-account.sql）；没装时退一步：至少把云端的数据删光
    try { await api('POST', '/rest/v1/rpc/delete_my_account', {}); } catch (e) {
      if (!/404|PGRST202|delete_my_account/i.test(e.message)) throw e;
      await api('DELETE', `/rest/v1/records?user_id=eq.${encodeURIComponent(state.session.user)}`, null, { prefer: 'return=minimal' });
      partial = true;
    }
  } catch (e) { state.error = tr('没能注销：', "Couldn't delete: ") + e.message; render(); return; }
  await hmWipeLocal();
  state.session = null;
  for (const m of Object.values(state.data)) m.clear();
  state.tab = 'ledger';
  state.notice = partial ? tr('数据已全部删除。登录账号还在，请联系管理员删除。', 'All data is deleted. The sign-in account still exists; ask the admin to remove it.')
    : tr('账户已注销，所有数据都已删除。', 'Account deleted. All data is gone.');
  render();
}

// 首页和"我的"上新加的按钮
MOD.actions.push(async (act, v) => {
  if (!act.startsWith('hm-')) return false;
  switch (act) {
    case 'hm-menu': state.hmMenu = !state.hmMenu; break;
    case 'hm-signout': {
      if (await uiConfirm(tr('退出登录？', 'Sign out?'), { ok: tr('退出', 'Sign out'), danger: true })) signOut();
      return true;
    }
    case 'hm-delete': hmDeleteAccount(); return true;
    case 'hm-nick': {
      const v = await uiPrompt(tr('用户名', 'Username'), String(shared.get('nickname', '') || ''), { placeholder: tr('星际旅人', 'Stargazer'), max: 20 });
      if (v === null) return true;
      try { await shared.set('nickname', v.trim().slice(0, 20)); } catch (e) { state.error = e.message; }
      break;
    }
    case 'hm-menu-x': state.hmMenu = false; state.hmCurMenu = false; break;
    // 设置 → 货币
    case 'hm-cur': if (!state.hmFx?.busy) state.hmCurMenu = !state.hmCurMenu; break;
    case 'hm-cur-pick': {
      state.hmCurMenu = false; render();
      const code = v;
      if (!FX_CODES.includes(code) || code === HOME || state.hmFx?.busy) return true;
      const ok = await uiConfirm(tr(`把主货币改成 ${code}？`, `Change main currency to ${code}?`), {
        ok: tr('折算并更改', 'Convert and change'),
        detail: tr(`所有账单、初始余额和预算按最新汇率折算成 ${code}。`, `All entries, opening balances and the budget are converted to ${code} at the latest rates.`),
      });
      if (!ok) return true;
      state.hmFx = { busy: true, code, done: 0, total: 0 }; render();
      try {
        const r = await hmSetHome(code, (done, total) => { Object.assign(state.hmFx, { done, total }); render(); });
        state.hmFx = { msg: tr(`主货币已改为 ${code}`, `Main currency is now ${code}`) + (r.queued ? tr(`，${r.queued} 条待上传`, `, ${r.queued} to upload`) : '') };
      } catch (e) { state.hmFx = { msg: e.message, bad: true }; }
      break;
    }
    case 'hm-rates': {
      state.hmRateBusy = true; render();
      const ok = await refreshRates();
      state.hmRateBusy = false; state.hmFx = { msg: ok ? tr('汇率已更新', 'Rates updated') : tr('更新失败，请检查网络', 'Update failed. Check your connection.'), bad: !ok };
      break;
    }
    case 'hm-sw-check': {
      state.hmSwBusy = true; state.hmSwMsg = null; render();
      let found = false;
      try { const reg = await navigator.serviceWorker.getRegistration(); await reg?.update(); found = !!(reg?.installing || reg?.waiting); } catch { /* 查不了就当没有 */ }
      state.hmSwBusy = false;
      if (found) hmShowUpdate(true); else state.hmSwMsg = { msg: navigator.onLine ? tr('已经是最新版本', 'You\'re up to date') : tr('离线中，联网后再查', 'Offline. Try again online.') };
      break;
    }
    // 列表 ⇄ 日历（同一个"明细"页的两种看法）
    case 'hm-cal': state.calendarMode = v === '1'; state.hmMenu = false; hm.mini = false; scrollTo(0, 0); break;
    case 'hm-ledger': state.ledgerId = Number(v); store.set('hl.ledger', state.ledgerId); state.hmMenu = false; break;
    case 'hm-dot': { const p = app.querySelector('.hm-pager'); if (p) p.scrollTo({ left: Number(v) * hmStride(p), behavior: 'smooth' }); return true; }
    case 'hm-go':
      // 账本 / 分类 / 账户 在管理页的不同分页；标签在统计页
      state.q = ''; state.searching = false; state.accountId = null; state.project = null; state.openKey = null;
      if (v === 'tags') { state.tab = 'stats'; state.section = 'tag'; state.openTag = null; }
      else if (typeof mgState === 'function') { state.tab = 'manage'; Object.assign(mgState(), { tab: { ledgers: 'ledger', categories: 'category', accounts: 'account' }[v] ?? 'category', open: 0, color: 0 }); }
      scrollTo(0, 0); break;
    default: return false;
  }
  render();
  return true;
});

function loginView() {
  const c = state.cfg, mode = state.authMode || 'login', dis = state.loading ? 'disabled' : '';
  const pass = (id, label) => `<label class="f pw">${label}<input id="${id}" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"><button type="button" class="eye" data-act="pw-eye" data-v="${id}">${tr('显示', 'Show')}</button></label>`;
  const title = { login: tr('登录', 'Sign in'), register: tr('注册', 'Create account'), forgot: tr('发送重设邮件', 'Send reset link'), reset: tr('保存新密码', 'Save new password'), sent: '' }[mode];
  const heading = { login: tr('登录', 'Sign in'), register: tr('注册新账号', 'Create an account'), forgot: tr('找回密码', 'Reset password'), reset: tr('设置新密码', 'Set a new password'), sent: tr('查收邮件', 'Check your email') }[mode];
  const email = `<label class="f">${tr('邮箱', 'Email')}<input id="l-email" type="email" autocomplete="username" inputmode="email" value="${h(state.authEmail || '')}"></label>`;
  // 邮件已发出：告诉用户发到哪了、接下来点什么，并能重发
  // 注册后的激活：和 App 一样——"账户激活邮件已发送"，点"已激活"用刚输的账号密码直接登录（密码只留在内存里）
  const sentBox = mode === 'sent' ? (state.sentKind === 'recovery'
    ? `<p style="margin:0">${tr(`重设密码的链接已发到 <b>${h(state.authEmail)}</b>。点邮件里的链接，会回到这里设置新密码。`, `A reset link was sent to <b>${h(state.authEmail)}</b>. Open it to come back here and set a new password.`)}</p>
    <p class="hint">${tr('没收到？看看垃圾邮件，或者过一分钟再重发。', 'Nothing yet? Check spam, or resend in a minute.')}</p>
    <button class="btn" data-act="auth-resend" ${dis}>${tr('重发邮件', 'Resend email')}</button>`
    : `<div class="act-box">${typeof iconTile === 'function' ? iconTile('mail') : ''}<b>${tr('账户激活邮件已发送', 'Activation email sent')}</b>
      <span class="muted">${tr('请您前往邮箱激活', 'Open your inbox to activate your account')}</span><span class="act-mail">${h(state.authEmail)}</span></div>
    <button class="btn primary" data-act="auth-activated" ${dis}>${state.loading ? tr('请稍候…', 'Please wait…') : tr('已激活', 'I\'ve activated it')}</button>
    <button class="btn" data-act="auth-resend" ${dis}>${tr('重新发送激活邮件', 'Resend activation email')}</button>`) : '';
  return `<div class="wrap"><div class="card login grid" style="position:relative">
    ${langSwitch()}
    <div class="pl-head">${typeof plLoginHero === 'function' ? plLoginHero() : ''}<h1 style="margin:0">${tr('行星记账', 'Planet Ledger')}</h1>
    <div class="muted">${heading}</div></div>
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

/** 月份切换。planet：首页用，年月旁边加这个月的星（"土星月"），点开能换。 */
function monthBar({ planet = false } = {}) {
  const { y, m } = state.month;
  const mid = planet && typeof plMonthTag === 'function' ? `<span class="pl-mc"><b>${ymLabel(y, m)}</b>${plMonthTag(y, m)}</span>` : `<b>${ymLabel(y, m)}</b>`;
  return `<div class="month"><button class="round" data-act="month" data-v="-1" aria-label="${tr('上个月', 'Previous month')}">${hmSvg(ICONS.back.d)}</button>${mid}<button class="round" data-act="month" data-v="1" aria-label="${tr('下个月', 'Next month')}">${hmSvg(ICONS.forward.d)}</button></div>`;
}

// 账单行 txRow() 在 modules/editor.js（侧滑、多选都在那边）

/** 首页汇总卡片：左右滑三页（本月收支 / 预算 / 净资产），下面一排小圆点。颜色用 --card-tint（外观里换账本色时跟着变）。 */
function summaryCard(t) {
  const reimb = (t.reimbursable || t.reimbursed ? `<div class="amber hm-rl"><span>${tr('可报销支出 ', 'Claimable ') + money(t.reimbursable)}</span><span>${tr('报销收入 ', 'Reimbursed ') + money(t.reimbursed)}</span></div>` : '')
    + (t.refund || t.excluded ? `<div class="muted hm-rl"><span>${t.refund ? tr('退款 ', 'Refunds ') + money(t.refund) : ''}</span><span>${t.excluded ? tr('不计 ', 'Not counted ') + money(t.excluded) : ''}</span></div>` : '');
  const month = `<section class="hm-page">
    <div class="hm-top1"><div class="hm-grow"><div class="muted hm-lbl">${tr('本月结余', 'Net this month')}</div><div class="hm-big num">${money(t.income - t.expense)}</div></div>${typeof plFace === 'function' ? plFace(t.income >= t.expense, 58) : typeof coinFace === 'function' ? coinFace(t.income >= t.expense, 58) : hmFace(t.income >= t.expense)}</div>
    <div class="hm-cells"><div><div class="muted hm-lbl2">${tr('支出', 'Expense')}</div><div class="num out hm-val">${money(t.expense)}</div></div><div><div class="muted hm-lbl2">${tr('收入', 'Income')}</div><div class="num in hm-val">${money(t.income)}</div></div></div>
    ${reimb}</section>`;
  const dots = [0, 1, 2].map((i) => `<button class="${i === (state.hmPage ?? 0) ? 'on' : ''}" data-act="hm-dot" data-v="${i}" aria-label="${i + 1} / 3"></button>`).join('');
  // 列表往下滚时卡片收成一行（本月结余 + 金额 + 小金币），回到顶上再展开；两套内容都在，CSS 负责收放
  const happy = t.income >= t.expense, face = (n) => (typeof plFace === 'function' ? plFace(happy, n) : typeof coinFace === 'function' ? coinFace(happy, n) : hmFace(happy));
  return `<div class="card cc hm-sum${hm.mini ? ' mini' : ''}">
    <div class="hm-fold hm-full"><div>
      <div class="hm-pager">${month}${hmBudgetPage(t)}${hmWorthPage()}</div>
      <div class="hm-dots">${dots}</div>
    </div></div>
    <div class="hm-fold hm-mini" aria-hidden="${hm.mini ? 'false' : 'true'}"><div><div class="hm-mrow">
      <span class="muted hm-lbl">${tr('本月结余', 'Net this month')}</span><b class="num">${money(t.income - t.expense)}</b>${face(28)}
    </div></div></div>
  </div>`;
}

/** 一句话记账的输入条，换成和 App 一样的星星和箭头图标。 */
const hmQuick = () => quickBar().replace('<span class="spark">✦</span>', `<span class="spark">${hmSvg(ICONS.sparkle.d)}</span>`).replace(/>›<\/button>/, `>${hmSvg(ICONS.forward.d)}</button>`);

function ledgerView() {
  if (state.calendarMode) return calendarView();
  const L = computeLookup(), txs = monthTxs(), totals = L.totals(txs);
  const days = new Map();
  for (const t of txs) { if (!days.has(t.date)) days.set(t.date, []); days.get(t.date).push(t); }
  const list = [...days.entries()].map(([day, items]) => {
    // 每天的进和出分开：退款算在"收"里，不拿去冲当天的支出（和 App 一样）
    const d = L.totals(items), out = d.expense + d.refund, inc = d.income + d.refund;
    const head = [inc > 0 ? `${tr('收', 'In')} ${money(inc)}` : '', out > 0 ? `${tr('支', 'Out')} ${money(out)}` : '',
      d.reimbursable > 0 ? `${tr('可报销', 'Claimable')} ${money(d.reimbursable)}` : '', d.reimbursed > 0 ? `${tr('报销回', 'Reimbursed')} ${money(d.reimbursed)}` : ''].filter(Boolean);
    return `<div class="card"><div class="dayhead"><span>${dayLabel(day)}</span><span class="hm-dh">${head.map((x) => `<span>${x}</span>`).join('')}</span></div>${items.map((t) => txRow(t, L)).join('')}</div>`;
  }).join('');
  // 预算已经是汇总卡片的第二页，不再单独放一张预算卡
  const extra = MOD.homeCards.map((f) => { try { return f(); } catch (e) { console.warn(e); return ''; } }).filter((x) => x && !x.includes('bud-home')).join('');
  return `<div class="cols hm-home"><div class="grid sticky hm-head">${monthBar({ planet: true })}${summaryCard(totals)}${hmQuick()}${extra}</div>
    <div class="grid hm-days">${list || (typeof emptyState === 'function' ? emptyState('receipt', tr('这个月还没有账单', 'Nothing this month yet')) : `<div class="hm-empty muted">${hmSvg(ICONS.receipt.d)}<span>${tr('这个月还没有账单', 'Nothing this month yet')}</span></div>`)}</div></div>`;
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
// 表里一律是"1 EUR = 多少该货币"（和 Fx.kt 一样），任意两种货币之间交叉换算。
// 主货币不是欧元时也按欧元取：frankfurter 用别的基准时会把交叉汇率四舍五入，折出来的数就和手机端对不上了；
// editor.js、import.js 也按欧元基准读这张表。主货币一变就重新取一次。
const fx = { rates: store.get('hl.rates', {}), date: store.get('hl.ratesDate', ''), home: null };
/** 联网更新最新汇率；成功返回 true。 */
async function refreshRates() {
  fx.home = HOME;
  try {
    const r = await (await fetch('https://api.frankfurter.dev/v1/latest?base=EUR')).json();
    if (!r?.rates) return false;
    fx.rates = r.rates; fx.date = r.date; store.set('hl.rates', r.rates); store.set('hl.ratesDate', r.date);
    if (state.session) render();
    return true;
  } catch { return false; /* 取不到就用上次存的 */ }
}
/** 主货币跟着云端的共享设置 home 走（手机上改了，网页读完数据就跟着变）。 */
function hmSyncHome() {
  const v = String(shared.get('home', 'EUR') ?? 'EUR').trim().toUpperCase();
  HOME = /^[A-Z]{3}$/.test(v) ? v : 'EUR';
  if (fx.home !== null && fx.home !== HOME) refreshRates();
}

/**
 * 更换主货币（和手机端 LedgerViewModel.setHomeCurrency 一样）：所有账单、跟着主货币走的账户的初始余额、预算按最新汇率折成新货币。
 * 外币账单从它原本的币种金额重新折算，所以来回切换不会越算越偏。先全部算好再写，有一笔没汇率就整个不做。
 * 每次写两百行；写到一半断网，剩下的排进待上传队列（本机数据照样全部换好），联网后自动补传。返回 { queued } 。
 */
async function hmSetHome(code, onProgress = () => {}) {
  const old = HOME;
  if (code === old) return { queued: 0 };
  if (!navigator.onLine) throw new Error(tr('需要联网才能更改主货币', 'Changing the currency needs a connection'));
  if (!Object.keys(fx.rates).length) await refreshRates();
  const noRate = () => new Error(tr('没有汇率，无法折算，请联网后再试', 'No rates available. Go online and try again.'));
  const conv = (c, from) => convert(c, from, code);
  if (conv(10000, old) == null) throw noRate();
  const norm = (kind, o) => (typeof HL_JSON !== 'undefined' && HL_JSON[kind] ? HL_JSON[kind](o) : o);
  const rows = [], put = (kind, data) => rows.push({ kind, id: data.id, data, deleted: false });
  for (const t of state.data.tx.values()) {
    // 原来以旧主货币记的账，从此变成一笔"外币"账单，保留当时实际支付的金额
    const cur = t.currency || old, orig = t.origCents > 0 ? t.origCents : t.amountCents;
    if (cur === code) put('tx', norm('tx', { ...t, amountCents: orig, currency: '', origCents: 0 }));
    else { const a = conv(orig, cur); if (a == null) throw noRate(); put('tx', norm('tx', { ...t, amountCents: a, currency: cur, origCents: orig })); }
  }
  // 跟着主货币走的账户，初始余额一起折算；有自己币种的账户不动
  for (const a of state.data.account.values()) if (!a.currency && a.initialCents) put('account', norm('account', { ...a, initialCents: conv(a.initialCents, old) }));
  const budget = Number(shared.get('budget', 0)) || 0;
  if (budget > 0) put('setting', { id: SHARED_IDS.budget, key: 'budget', value: conv(budget, old) });
  const cb = shared.get('catBudgets', {});
  if (cb && typeof cb === 'object' && Object.keys(cb).length) put('setting', { id: SHARED_IDS.catBudgets, key: 'catBudgets', value: Object.fromEntries(Object.entries(cb).map(([k, c]) => [k, conv(Number(c) || 0, old) ?? c])) });
  put('setting', { id: SHARED_IDS.home, key: 'home', value: code });
  let done = 0, queued = 0;
  onProgress(0, rows.length);
  for (; done < rows.length; done += 200) {
    const part = rows.slice(done, done + 200);
    try {
      await api('POST', '/rest/v1/records?on_conflict=user_id,kind,id', part.map((r) => ({ user_id: state.session.user, ...r })), { prefer: 'resolution=merge-duplicates,return=minimal' });
    } catch (e) {
      // 一行都没写进去就当没发生过；已经写了一部分的话，剩下的排队补传，免得云端一半新一半旧
      if (!done) throw isNetworkError(e) ? new Error(tr('需要联网才能更改主货币', 'Changing the currency needs a connection')) : e;
      const rest = rows.slice(done), key = (r) => r.kind + ':' + r.id, keys = new Set(rest.map(key));
      store.set('hl.outbox', [...outbox.list().filter((r) => !keys.has(key(r))), ...rest]);
      queued = rest.length; break;
    }
    onProgress(Math.min(rows.length, done + 200), rows.length);
  }
  for (const r of rows) state.data[r.kind].set(r.id, r.data);
  HOME = code;
  saveSnapshot();
  refreshRates();
  return { queued };
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
      <div class="small muted" style="margin-top:4px">${assets > 0 ? `${tr('负债率', 'Debt ratio')} ${Math.round(debts * 100 / assets)}%` : ''}</div>` : ''}</div>
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
    case 'mode': state.authEmail = document.getElementById('l-email')?.value.trim() || state.authEmail; state.authMode = v; state.authPass = null; state.error = ''; state.notice = ''; render(); break;
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
    case 'auth-activated': {
      // 用注册时输的账号密码直接登录；还没激活就留在这页提示
      const email = state.authEmail, pass = state.authPass ?? '';
      if (!pass) { state.authMode = 'login'; state.notice = tr('请输入密码登录。', 'Enter your password to sign in.'); render(); break; }
      state.loading = true; state.error = ''; state.notice = ''; render();
      try {
        const o = await api('POST', '/auth/v1/token?grant_type=password', { email, password: pass }, { auth: false });
        saveSession(o); state.authPass = null; state.loading = false; state.authMode = 'login'; await loadAll();
      } catch (e) { state.loading = false; state.error = e.unconfirmed ? tr('还没激活，请先点邮件里的链接。', 'Not activated yet. Open the link in the email first.') : e.message; render(); }
      break;
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
          const res = await cloudFetch('/auth/v1/user', { method: 'PUT', headers: { apikey: state.cfg.key, 'Content-Type': 'application/json', Authorization: `Bearer ${state.recover.access_token}` }, body: JSON.stringify({ password: pass }) });
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
          else { state.authMode = 'sent'; state.sentKind = 'signup'; state.authPass = pass; }
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
    case 'signout': if (await uiConfirm(tr('退出登录？', 'Sign out?'), { ok: tr('退出', 'Sign out'), danger: true })) signOut(); break;
    case 'notice-x': state.notice = ''; render(); break;
    default: if (await aiAction(act, v) || await moreAction(act, v, el)) break;
      for (const f of MOD.actions) { if (await f(act, v, el)) break; }
      break; // 没人认领的按钮什么也不做（以前会掉下去刷新全部数据）
    case 'reload': await loadAll(); break;
    case 'tab': if (v === 'ledger' && el.dataset.list) state.calendarMode = false; state.tab = v; scrollTo(0, 0); state.q = ''; state.searching = false; state.accountId = null; state.project = null; state.openKey = null; render(); break;
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
  // 首页的输入条什么都没打就点箭头 / 回车：和 App 一样直接进"问账本"
  if (!text.trim()) {
    if (state.tab === 'ask') return;
    state.tab = 'ask'; state.q = ''; state.searching = false; scrollTo(0, 0); render();
    document.querySelector('.ai-in input, #quick')?.focus();
    return;
  }
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
    const res = await cloudFetch('/auth/v1/user', { headers: { apikey: state.cfg.key, Authorization: `Bearer ${access}` } });
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

// ---- 新版本提示（代替 App 的软件更新）：离线缓存（sw.js）换成新版本时，顶上弹一条"有新版本 · 点击刷新"
function hmShowUpdate(force = false) {
  // 先弹窗问一声（"稍后更新"后 12 小时内不再弹，只留右下角的小按钮）
  const snoozed = Date.now() - (Number(store.get('hl.updSnooze')) || 0) < 12 * 3600e3;
  if ((force || (!snoozed && !hm.updAsked)) && typeof uiConfirm === 'function') {
    hm.updAsked = true;
    uiConfirm(tr('检测到您当前应用版本号低，请您更新', 'A newer version is available. Please update.'), { ok: tr('确认更新', 'Update'), cancel: tr('稍后更新', 'Later') })
      .then((yes) => { if (yes) location.reload(); else { store.set('hl.updSnooze', Date.now()); hmUpdButton(); } });
    return;
  }
  hmUpdButton();
}
function hmUpdButton() {
  if (document.querySelector('.hm-upd')) return;
  const b = document.createElement('button');
  b.className = 'hm-upd'; b.type = 'button';
  b.textContent = tr('有新版本 · 点击刷新', 'New version · Tap to reload');
  b.addEventListener('click', () => location.reload());
  document.body.appendChild(b);
}
if ('serviceWorker' in navigator) {
  const sw = navigator.serviceWorker, hadController = !!sw.controller;
  // sw.js 装好就接管页面：本来就有旧版本在管的话，接管 = 有新版本了（第一次装不算）
  sw.addEventListener('controllerchange', () => { if (hadController) hmShowUpdate(); });
  sw.ready.then((reg) => {
    hm.swReg = reg;
    if (reg.waiting && sw.controller) hmShowUpdate();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && sw.controller) hmShowUpdate(); });
    });
  }).catch(() => {});
  // 装在主屏幕上的 App 很少重新打开：每次切回前台顺手查一次
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') hm.swReg?.update().catch(() => {}); });
  // 断网后重新联网：查一次新版本
  addEventListener('online', () => hm.swReg?.update().catch(() => {}));
}
// 从后台切回来时顺手刷新一次（手机上改的账这边也能看到）
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.session && !state.editing && Date.now() - (loadAll.at ?? 0) > 60000) { loadAll.at = Date.now(); loadAll(); } });
