// 辉记账本网页版的公共底座：最先加载，只放定义，不碰页面。
// 1. 和手机端共享的设置（预算、自动记账……）：云端 records 表里 kind = 'setting' 的那几行
// 2. 功能模块的登记处：各个模块文件把自己的页面、按钮动作、"我的"页入口登记到 MOD 里，app.js 统一分发
// 3. 离线：数据快照存在 IndexedDB，断网时的修改先排队，联网后自动补传
'use strict';

/** 和手机端约定好的固定 id（手机端 Sync.SHARED 同一张表），value 的格式也和手机端存的一样。 */
// ---------------------------------------------------------------- 语言：中文 / English
// 界面文字一律写成 tr('中文', 'English')。选择存在浏览器里：'zh' / 'en' / 'auto'（跟随系统，和手机端"跟随系统"一样）；没选过也是跟随系统。
const sysLang = () => (/^zh/i.test(navigator.language) ? 'zh' : 'en');
/** 用户选的语言：'auto'（跟随系统）、'zh'、'en'。 */
let LANG_MODE = (() => { try { const v = JSON.parse(localStorage.getItem('hl.lang')); if (v === 'zh' || v === 'en') return v; } catch { /* 读不到就跟随系统 */ } return 'auto'; })();
let LANG = LANG_MODE === 'auto' ? sysLang() : LANG_MODE;
document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN';
const tr = (zh, en) => (LANG === 'en' ? en : zh);
function setLang(l) {
  LANG_MODE = l === 'en' || l === 'zh' ? l : l === 'auto' ? 'auto' : 'zh';
  LANG = LANG_MODE === 'auto' ? sysLang() : LANG_MODE;
  try { localStorage.setItem('hl.lang', JSON.stringify(LANG_MODE)); } catch { /* 隐私模式存不了 */ }
  document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN';
  document.title = tr('辉记账本', 'HuiLedger');
  // 旧的提示是按旧语言写的，换语言就清掉
  if (typeof state !== 'undefined') { state.error = ''; state.notice = ''; }
  render();
}
// 跟随系统时，系统语言改了就跟着换
addEventListener('languagechange', () => { if (LANG_MODE === 'auto' && sysLang() !== LANG) setLang('auto'); });
/** 语言切换的小开关（登录页右上角、"我的"页都用它）。 */
const langSwitch = () => `<div class="lang-sw" role="group" aria-label="Language"><button class="${LANG === 'zh' ? 'on' : ''}" data-act="lang" data-v="zh">中</button><button class="${LANG === 'en' ? 'on' : ''}" data-act="lang" data-v="en">EN</button></div>`;

const SHARED_IDS = { budget: 1, catBudgets: 2, schedules: 3, loanDue: 4, ledgerColors: 5, projects: 6, funds: 7, tagColors: 8, recurring: 9, cardDue: 10, home: 11 };

const shared = {
  /** 读一项共享设置；云端还没有就用 def。 */
  get(key, def) {
    const row = state.data.setting?.get(SHARED_IDS[key]);
    return row && row.value !== undefined && row.value !== null ? row.value : def;
  },
  /** 写一项共享设置：立刻生效，同时传到云端（手机下次同步就能拿到）。 */
  async set(key, value) {
    await saveRecord('setting', { id: SHARED_IDS[key], key, value });
  },
};

/**
 * 模块登记处。每个模块文件这样用：
 *   MOD.pages.budget = () => budgetView();                    // state.tab === 'budget' 时显示
 *   MOD.actions.push(async (act, v, el) => { ...; return true });  // 认领了这个 data-act 就返回 true
 *   MOD.changes.push(async (ev) => { ...; return true });         // 处理 change 事件
 *   MOD.me.push({ key: 'budget', name: '预算', icon: 'chart', order: 10 });  // "我的"页上的入口
 *   MOD.onLoad.push(async () => {});                           // 每次读完云端数据后跑一次（自动记账等）
 *   MOD.homeCards.push(() => '<div class="card">…</div>');      // 明细页月度卡片下面加的卡片
 */
const MOD = { pages: {}, actions: [], changes: [], me: [], onLoad: [], homeCards: [] };

// ---------------------------------------------------------------- 离线快照（IndexedDB）

const snap = {
  _db: null,
  open() {
    if (this._db) return this._db;
    this._db = new Promise((ok, bad) => {
      const r = indexedDB.open('huiledger', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => bad(r.error);
    });
    return this._db;
  },
  async get(key) {
    try {
      const db = await this.open();
      return await new Promise((ok, bad) => { const q = db.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => ok(q.result); q.onerror = () => bad(q.error); });
    } catch { return undefined; }
  },
  async put(key, value) {
    try {
      const db = await this.open();
      await new Promise((ok, bad) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(value, key); t.oncomplete = ok; t.onerror = () => bad(t.error); });
    } catch { /* 存不了快照不影响在线使用 */ }
  },
};

/** 把内存里的全部数据存成快照（下次打开先显示它，再去云端刷新）。 */
function saveSnapshot() {
  if (!state.session) return;
  const rows = {};
  for (const [kind, m] of Object.entries(state.data)) rows[kind] = [...m.values()];
  snap.put('data:' + state.session.user, rows);
}
async function loadSnapshot() {
  const rows = state.session && await snap.get('data:' + state.session.user);
  if (!rows) return false;
  for (const [kind, list] of Object.entries(rows)) { if (!state.data[kind]) continue; state.data[kind].clear(); for (const o of list) state.data[kind].set(Number(o.id), o); }
  return true;
}

// ---------------------------------------------------------------- 断网时的修改排队

const outbox = {
  list: () => store.get('hl.outbox', []),
  add(row) { store.set('hl.outbox', [...this.list().filter((r) => !(r.kind === row.kind && r.id === row.id)), row]); },
  /** 联网后把排着的修改补传上去；成功一批删一批。 */
  async flush() {
    const rows = this.list();
    if (!rows.length || !state.session || !navigator.onLine) return;
    try {
      for (let i = 0; i < rows.length; i += 200) {
        await api('POST', '/rest/v1/records?on_conflict=user_id,kind,id', rows.slice(i, i + 200).map((r) => ({ ...r, user_id: state.session.user })), { prefer: 'resolution=merge-duplicates,return=minimal' });
      }
      store.set('hl.outbox', this.list().slice(rows.length));
    } catch { /* 还是连不上：留着下次再传 */ }
  },
};
const isNetworkError = (e) => !!e?.offline || e instanceof TypeError || !navigator.onLine;

// ---------------------------------------------------------------- 装成主屏幕 App 时的小细节

// 最近一次点击落在哪个元素上：点弹窗外面的遮罩才关弹窗，点里面不关（事件处理里 await 之后拿不到 event 了）
let lastClickTarget = null;
document.addEventListener('click', (e) => { lastClickTarget = e.target; }, true);

const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ---------------------------------------------------------------- 新账号的默认数据
// 和手机端第一次安装时一模一样（Database.kt 的 seed）：同样的 id、顺序、图标，
// 这样以后在手机上登录同一个账号，两边的分类能对上，不会出现两份。名字按当前语言。
const DEFAULT_EXPENSE = [
  ['餐饮', 'Food', [['三餐', 'Meals'], ['买菜', 'Groceries'], ['水果', 'Fruit'], ['零食', 'Snacks'], ['咖啡饮料', 'Coffee & drinks'], ['外卖', 'Takeout']]],
  ['交通', 'Transport', [['公交地铁', 'Bus & metro'], ['火车', 'Train'], ['打车', 'Taxi'], ['飞机', 'Flights'], ['加油', 'Fuel'], ['自行车', 'Bike']]],
  ['购物', 'Shopping', [['服饰', 'Clothes'], ['数码', 'Electronics'], ['日用品', 'Daily goods'], ['快递', 'Shipping']]],
  ['居住', 'Housing', [['房租', 'Rent'], ['水电燃气', 'Utilities'], ['网费', 'Internet'], ['家具', 'Furniture'], ['维修', 'Repairs']]],
  ['通讯', 'Phone', []],
  ['娱乐', 'Fun', [['电影', 'Movies'], ['游戏', 'Games'], ['音乐', 'Music'], ['付费会员', 'Subscriptions']]],
  ['运动', 'Sport', []],
  ['旅行', 'Travel', [['住宿', 'Lodging'], ['机票', 'Air tickets'], ['门票', 'Tickets']]],
  ['医疗', 'Health', [['看病', 'Doctor'], ['药品', 'Medicine'], ['保健', 'Wellness']]],
  ['学习', 'Learning', [['书籍', 'Books'], ['课程', 'Courses']]],
  ['社交', 'Social', [['聚餐', 'Dining out'], ['礼物', 'Gifts'], ['红包', 'Red packets']]],
  ['美妆', 'Beauty', [['理发', 'Haircut'], ['护肤', 'Skincare']]],
  ['宠物', 'Pets', []], ['孩子', 'Kids', []], ['保险', 'Insurance', []], ['税费', 'Taxes', []], ['工作', 'Work', []],
  ['代付还款', 'Paid for others', []], ['其他', 'Other', []],
];
const DEFAULT_INCOME = [['工资', 'Salary'], ['奖金', 'Bonus'], ['外快兼职', 'Side jobs'], ['投资收益', 'Investments'], ['利息', 'Interest'], ['补贴', 'Allowance'],
  ['消费返现', 'Cashback'], ['代付收回', 'Paid back'], ['报销', 'Reimbursement'], ['退款', 'Refund'], ['礼金', 'Gift money'], ['其他', 'Other']];

/** 新账号（云端什么都没有）时写入默认账本、现金账户和全部分类。 */
async function seedDefaults() {
  const rows = [], add = (kind, data) => rows.push({ kind, id: data.id, data, deleted: false });
  add('ledger', { id: 1, name: tr('日常账本', 'Daily') });
  add('account', { id: 1, name: tr('现金', 'Cash'), type: 3, initialCents: 0, sortOrder: 0, currency: '', archived: false, checkedAt: 0 });
  let id = 0, order = 0;
  const cat = (zh, en, isIncome, parentId) => { id++; add('category', { id, name: tr(zh, en), icon: iconKey(zh), isIncome, sortOrder: order++, parentId }); return id; };
  for (const [zh, en, subs] of DEFAULT_EXPENSE) { const p = cat(zh, en, false, 0); for (const [z, e] of subs) cat(z, e, false, p); }
  for (const [zh, en] of DEFAULT_INCOME) cat(zh, en, true, 0);
  for (let i = 0; i < rows.length; i += 200) {
    await api('POST', '/rest/v1/records?on_conflict=user_id,kind,id', rows.slice(i, i + 200).map((r) => ({ ...r, user_id: state.session.user })), { prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  for (const r of rows) state.data[r.kind].set(r.id, r.data);
  state.ledgerId = 1;
}

// ---------------------------------------------------------------- 应用内确认框（代替 iPhone 上难看的系统 confirm 弹窗）
/**
 * await uiConfirm('删除这笔？', { ok: '删除', danger: true, detail: '可以撤销' }) → true / false
 * 画在 #app 外面的一层，不受 render() 影响。
 */
function uiConfirm(title, { ok = tr('确定', 'OK'), cancel = tr('取消', 'Cancel'), danger = false, detail = '' } = {}) {
  return new Promise((done) => {
    const box = document.createElement('div');
    box.className = 'modal ui-confirm';
    box.innerHTML = `<div class="card grid" role="alertdialog" aria-modal="true">
      <b style="font-size:17px">${h(title)}</b>${detail ? `<div class="muted small">${detail}</div>` : ''}
      <div class="between"><button class="btn" data-v="0">${h(cancel)}</button><button class="btn ${danger ? 'danger-fill' : 'primary'}" data-v="1">${h(ok)}</button></div></div>`;
    const close = (v) => { box.remove(); done(v); };
    box.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) close(b.dataset.v === '1'); else if (e.target === box) close(false); });
    document.body.appendChild(box);
    box.querySelector('button[data-v="1"]').focus();
  });
}
