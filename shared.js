// 辉记账本网页版的公共底座：最先加载，只放定义，不碰页面。
// 1. 和手机端共享的设置（预算、自动记账……）：云端 records 表里 kind = 'setting' 的那几行
// 2. 功能模块的登记处：各个模块文件把自己的页面、按钮动作、"我的"页入口登记到 MOD 里，app.js 统一分发
// 3. 离线：数据快照存在 IndexedDB，断网时的修改先排队，联网后自动补传
'use strict';

/** 和手机端约定好的固定 id（手机端 Sync.SHARED 同一张表），value 的格式也和手机端存的一样。 */
const SHARED_IDS = { budget: 1, catBudgets: 2, schedules: 3, loanDue: 4, ledgerColors: 5, projects: 6, funds: 7, tagColors: 8, recurring: 9, cardDue: 10 };

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
