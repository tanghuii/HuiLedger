// 导入账单：截图、PDF、CSV、Excel → AI 识别 → 核对 → 记进账本。
// 和手机端同一套：ImportScreen.kt（核对页）、BillParser.kt（提示词、分段、重试）、Xlsx.kt（读 Excel、其他记账软件的表格）、
// Merge.kt（和已有账单查重、合并）、Counterparty.kt（认出自己账户之间的转账）、LedgerViewModel.parseBills / importDrafts。
// 修正文件（第一列是"操作"）在这里选也行，交给 app.js 的 readPatch / state.patch。
'use strict';

const IMP = {
  /** idle：选文件；loading：识别中；paused：断网停下了（已识别的留着，等点"继续"）；review：核对；saving：正在写入 */
  phase: 'idle', error: '', done: 0, total: 0, found: 0,
  /** 正在识别的这一批（impPrepare 准备的）：断网暂停（phase 'paused'）后点"继续识别"接着跑剩下的段 */
  run: null,
  drafts: [], skipped: 0, missed: 0, dropped: 0,
  /** 正在看原文、改详情的那一条（下标），-1 表示没打开 */
  detail: -1, detailErr: '', detailForm: null,
  /** 手动填的汇率（币种 → 文字），没填就用汇率表里的 */
  rates: {},
  /** 缺账户的记到哪个账户；不预选（以前默认第一个，没留意就把银行流水记进了现金） */
  account: 0,
  saveDone: 0, saveTotal: 0,
  /** "iPhone 导入微信账单"说明开着 */
  guide: false,
  /** 快捷指令传进来的账单文件（还没开始识别） */
  incoming: null,
  /** 正在从本机读回上次没做完的导入（读完之前不自动刷新页面） */
  hold: false,
  /** 这个导入任务已经自动开始过（读完云端数据会触发好几次，只自动开始一次） */
  autoStarted: false,
};

// ---------------------------------------------------------------- 导入任务存在本机
// 快捷指令传来的文件、识别到一半的进度、核对页的草稿，都存在浏览器的本地数据库（IndexedDB）里：
// 页面刷新（包括自动更新）、Safari 被关掉、手机锁屏，回来都能接着做；导入完成或点"放弃"才删掉。超过一天的不要了。
const IMP_TASK_TTL = 24 * 3600 * 1000;
function impDb() {
  return new Promise((ok, no) => {
    try {
      const req = indexedDB.open('hl-import', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('task');
      req.onsuccess = () => ok(req.result);
      req.onerror = () => no(req.error);
    } catch (e) { no(e); }
  });
}
async function impTaskIo(mode, fn) {
  const db = await impDb();
  try {
    return await new Promise((ok, no) => {
      const tx = db.transaction('task', mode), st = tx.objectStore('task');
      const req = fn(st);
      tx.oncomplete = () => ok(req?.result);
      tx.onerror = () => no(tx.error);
    });
  } finally { db.close(); }
}
/** 读上次存下的任务；没有或太旧返回 null。 */
async function impTaskLoad() {
  try {
    const t = await impTaskIo('readonly', (st) => st.get('cur'));
    return t && Date.now() - (t.at ?? 0) < IMP_TASK_TTL ? t : null;
  } catch { return null; }
}
/** 合并写入（file / run / review）。 */
async function impTaskSave(patch) {
  try {
    const cur = (await impTaskIo('readonly', (st) => st.get('cur'))) ?? {};
    await impTaskIo('readwrite', (st) => st.put({ ...cur, ...patch, at: Date.now() }, 'cur'));
  } catch { /* 存不了（隐私模式等）：只在内存里 */ }
}
function impTaskClear() { impTaskIo('readwrite', (st) => st.delete('cur')).catch(() => {}); }
/** 识别中、核对中频繁变化：停一下再存。 */
function impTaskSaveSoon() {
  clearTimeout(impTaskSaveSoon.t);
  impTaskSaveSoon.t = setTimeout(() => {
    if (IMP.phase === 'review' || IMP.phase === 'saving') impTaskSave({ run: null, review: { drafts: IMP.drafts, skipped: IMP.skipped, missed: IMP.missed, dropped: IMP.dropped, account: IMP.account, rates: IMP.rates } });
    else if (IMP.run) {
      // 存的时候把正在识别的、等着重试的段放回待识别里
      const r = IMP.run, w = r.inWave;
      impTaskSave({ run: { ...r, inWave: null, jobs: w ? [...w.pending, ...w.again, ...w.failed, ...r.jobs] : r.jobs }, review: null });
    }
  }, 800);
}
/** 有导入任务在等、在识别或在核对：这时不自动刷新页面，也先不弹更新公告。 */
const impBusy = () => !!(IMP.incoming || IMP.hold || (IMP.phase && IMP.phase !== 'idle'));

// ---------------------------------------------------------------- 快捷指令直传
// iPhone 的快捷指令"导入行星记账"在分享菜单里：把文件转成 base64，打开 …/#imp=<base64>&n=<文件名>。
// # 后面的内容不会发到服务器；这里读出来就把地址栏抹掉（要在 app.js 处理登录回跳之前，所以放在这个文件的顶层）。
/**
 * 快捷指令的 iCloud 分享链接：iPhone 上点开直接进「快捷指令」App 添加（不用下载文件）。
 * 快捷指令本身是 tools/make_shortcut.py 生成、签过名的那个（web/shortcuts/ 里留了一份）。为空时不显示"添加快捷指令"。
 */
const IMP_SHORTCUT_URL = 'https://www.icloud.com/shortcuts/69b107c96fbc430682755dd124cf49a8';
/** 看文件开头猜类型：pdf / xls / xlsx / zip / csv。 */
function impSniff(b) {
  const at = (s, o = 0) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (at('%PDF')) return 'pdf';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'xls';
  if (at('PK')) {
    // 第一个文件名（明文，加密的 zip 也是）：xlsx 打开是 [Content_Types].xml / _rels/ / docProps/ / xl/
    const first = new TextDecoder('latin1').decode(b.subarray(30, 30 + (b[26] | (b[27] << 8))));
    return /^(\[Content_Types\]\.xml|_rels\/|docProps\/|xl\/)/.test(first) ? 'xlsx' : 'zip';
  }
  return 'csv';
}
/**
 * 地址栏里有快捷指令传来的账单（#imp=…）：读出来、抹掉地址栏，返回文件；没有返回 null。
 * 网页打开时读一次；网页已经开着时（Safari 停在别的页面，快捷指令只改了 # 后面），hashchange 时再读。
 */
function impTakeHash() {
  const m = location.hash.match(/^#imp=([^&]+)(?:&n=([^&]*))?/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const b64 = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    let name = ''; try { name = decodeURIComponent(m[2] ?? ''); } catch { /* 名字坏了就不要 */ }
    // 快捷指令给的名字常常不带扩展名：按内容猜。xlsx 也是 PK 开头，要看里面有没有 xl/ 目录
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) name = (name || tr('账单', 'statement')) + '.' + impSniff(bytes);
    const ext = name.split('.').pop().toLowerCase();
    const type = { zip: 'application/zip', csv: 'text/csv', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel' }[ext] ?? '';
    return new File([bytes], name, { type });
  } catch { return null; /* 数据不完整：当没收到 */ }
}

/** 收下一份账单作为当前任务：马上存到本机（之后页面刷新、Safari 被关掉都不会丢；存好之前先不让页面自动刷新）。 */
function impKeep(file) {
  IMP.incoming = file; IMP.autoStarted = false;
  IMP.hold = true;
  return file.arrayBuffer().then((buf) => impTaskIo('readwrite', (st) => st.put({ file: { name: file.name, type: file.type, buf }, run: null, review: null, at: Date.now() }, 'cur')))
    .catch(() => {}).finally(() => { IMP.hold = false; });
}

(() => {
  const f = impTakeHash();
  // 不是快捷指令打开的：看看本机有没有上次没做完的导入
  if (!f) { impRestore(); return; }
  impKeep(f);
})();

// ---------------------------------------------------------------- 网页开着时收到账单

/** 一个小确认框：标题、说明、几个按钮（第一个是主按钮）。返回点了第几个；点背景不关（必须选一个）。 */
function impConfirm(title, text, buttons) {
  return new Promise((done) => {
    const box = document.createElement('div');
    box.className = 'wn imp-cf';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', title);
    box.innerHTML = `<div class="wn-card"><div class="wn-in"><b class="wn-title">${h(title)}</b>${text ? `<p class="wn-lead">${h(text)}</p>` : ''}
      ${buttons.map((b, i) => `<button class="btn ${i === 0 ? 'primary' : i === 1 ? '' : 'link'} imp-cf-b" type="button" data-i="${i}">${h(b)}</button>`).join('')}</div></div>`;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('.imp-cf-b');
      if (!b) return;
      box.classList.add('out'); setTimeout(() => box.remove(), 200);
      done(Number(b.dataset.i));
    });
    document.body.appendChild(box);
    box.querySelector('.imp-cf-b')?.focus();
  });
}

/** 打开着的弹窗里有没有改过的输入框（和刚打开时不一样）。 */
function impModalDirty() {
  return [...document.querySelectorAll('.modal input, .modal textarea, .modal select')].some((el) =>
    (el.type === 'checkbox' || el.type === 'radio') ? el.checked !== el.defaultChecked : el.tagName === 'SELECT' ? [...el.options].some((o) => o.selected !== o.defaultSelected) : el.value !== el.defaultValue);
}

/** 记账页（state.editing）里有没有没存的改动。 */
function impEditDirty() {
  const e = state.editing;
  if (!e) return false;
  try { if (typeof collect === 'function') collect(); } catch { /* 读不了输入框就按当前状态比 */ }
  const v = (x) => String(x ?? '').trim();
  if (e._isNew) return !!(v(e._amount) || v(e.note) || v(e.tags));
  const t = state.data.tx.get(e.id);
  if (!t) return true;
  const amount = typeof edInput === 'function' ? edInput(typeof edForeign === 'function' && edForeign(t) ? t.origCents : t.amountCents) : e._amount;
  return v(e._amount) !== v(amount) || ['kind', 'categoryId', 'accountId', 'toAccountId', 'date', 'note', 'tags', 'reimburse', 'ledgerId', 'project', 'fund', 'currency', 'excluded'].some((k) => v(e[k]) !== v(t[k]));
}

/** 不管现在在哪一页：关掉记账页、账单详情、搜索、弹窗、更新公告，切到导入页。 */
function impShowPage() {
  // 弹窗：点它的背景关掉（和用户点空白处一样，各自的状态也跟着清掉）
  for (let i = 0; i < 4; i++) {
    const m = document.querySelector('.modal');
    if (!m) break;
    m.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
  document.querySelectorAll('.wn:not(.imp-cf)').forEach((x) => x.remove());
  Object.assign(state, { editing: null, view: null, searching: false, q: '', error: '', aiSettings: false, aiDraft: null });
  state.tab = 'import';
  scrollTo(0, 0);
  render();
}

/** 收下账单、切到导入页、开始识别（没登录、数据没读完时先留着，读完后 impAutoStart 接着做）。 */
function impBegin(file, toast = true) {
  impKeep(file);
  if (toast && typeof edToast === 'function') edToast(tr(`已收到「${file.name}」，正在为您导入`, `Got “${file.name}”. Importing…`));
  if (!state.session) { render(); return; }
  impShowPage();
  if (state.data.category.size) impAutoStart();
}

/** 等着的账单：记账页、弹窗、初始设置还开着（用户选了先继续编辑），关掉后自动开始。 */
let impWaiting = null;
function impWaitCheck() {
  if (!impWaiting) return;
  const busyUi = state.editing || document.querySelector('.modal') || (typeof ob !== 'undefined' && ob.open);
  if (busyUi) return;
  const f = impWaiting; impWaiting = null;
  impBegin(f);
}
setInterval(impWaitCheck, 700);

/**
 * 网页开着时快捷指令又传来一份账单。按当前在做什么分情况：
 * 1. 正在导入（识别中、核对中、断网停着）：问改为导入新的，还是先做完当前的（新的排在后面，做完自动开始）；
 * 2. 记账页有没存的改动：问保存并导入、不保存直接导入，或继续编辑（存好或关掉后自动导入）；
 * 3. 弹窗里改过东西：问放弃修改并导入，或继续编辑（关掉后自动导入）；
 * 4. 正在做初始设置：设置完自动导入；
 * 5. 别的情况（看详情、翻统计、没改过的弹窗…）：提示一句，直接去导入。
 */
async function impArrive(file) {
  const name = file.name;
  // 应用锁着：解锁后再问
  while (typeof lk !== 'undefined' && lk.locked) await new Promise((r) => setTimeout(r, 500));
  // 1
  if (IMP.phase === 'saving') { impQueue(file); return; }
  if (IMP.phase && IMP.phase !== 'idle') {
    const i = await impConfirm(tr(`已收到新账单「${name}」`, `New statement: “${name}”`), tr('当前导入尚未完成，请选择：', 'The current import is not finished yet.'),
      [tr('先完成当前导入', 'Finish the current one first'), tr('放弃当前导入，改为导入新账单', 'Discard it and import the new one')]);
    if (i === 0) { impQueue(file); return; }
    IMP.next = null; impTaskIo('readwrite', (st) => st.delete('next')).catch(() => {});
    impReset();
    impBegin(file, false);
    return;
  }
  // 2
  if (state.editing && impEditDirty()) {
    const i = await impConfirm(tr(`已收到账单「${name}」`, `Got “${name}”`), tr('当前记账尚未保存，是否保存？', 'This entry is not saved yet. Save it?'),
      [tr('保存并导入', 'Save and import'), tr('不保存，直接导入', 'Import without saving'), tr('继续编辑，稍后导入', 'Keep editing, import after')]);
    if (i === 0) {
      await saveEditing();
      // 没存成（比如金额没填）：留在记账页显示原因，存好或关掉后自动导入
      if (state.editing) { impWaiting = file; impKeep(file); edToast(tr('请先完成本笔记账，保存后将自动导入', 'Finish this entry; importing right after')); return; }
      impBegin(file);
      return;
    }
    if (i === 1) { state.editing = null; impBegin(file); return; }
    impWaiting = file; impKeep(file);
    return;
  }
  // 3
  if (document.querySelector('.modal') && impModalDirty()) {
    const i = await impConfirm(tr(`已收到账单「${name}」`, `Got “${name}”`), tr('当前窗口中的修改尚未保存。', 'Changes in this window are not saved.'),
      [tr('放弃修改并导入', 'Discard and import'), tr('继续编辑，稍后导入', 'Keep editing, import after')]);
    if (i === 0) { impBegin(file); return; }
    impWaiting = file; impKeep(file);
    return;
  }
  // 4
  if (typeof ob !== 'undefined' && ob.open) {
    impWaiting = file; impKeep(file);
    edToast(tr('已收到账单，完成初始设置后将自动导入', 'Got it. Importing after setup.'));
    return;
  }
  // 5
  impBegin(file);
}

/** 先做完当前的：新的排在后面（也存到本机），当前的做完或放弃后自动开始。 */
function impQueue(file) {
  IMP.next = file;
  file.arrayBuffer().then((buf) => impTaskIo('readwrite', (st) => st.put({ name: file.name, type: file.type, buf, at: Date.now() }, 'next'))).catch(() => {});
  edToast(tr(`「${file.name}」将在当前导入完成后自动开始`, `“${file.name}” will start after this one`));
}
/** 当前导入做完或放弃了：有排着的就开始。 */
async function impNext() {
  let f = IMP.next;
  if (!f) {
    try {
      const n = await impTaskIo('readonly', (st) => st.get('next'));
      if (n?.buf && Date.now() - (n.at ?? 0) < IMP_TASK_TTL) f = new File([n.buf], n.name, { type: n.type ?? '' });
    } catch { /* 没有 */ }
  }
  if (!f || (IMP.phase && IMP.phase !== 'idle') || IMP.incoming) return;
  IMP.next = null;
  impTaskIo('readwrite', (st) => st.delete('next')).catch(() => {});
  setTimeout(() => impBegin(f), 400);
}

window.addEventListener('hashchange', () => {
  const f = impTakeHash();
  if (f) impArrive(f);
});

/** 打开网页时读回上次没做完的导入：核对中的回到核对页，识别到一半的接着识别，还没开始的自动开始。 */
async function impRestore() {
  IMP.hold = true;
  try {
    const t = await impTaskLoad();
    if (!t) { impNext(); return; }
    if (IMP.phase !== 'idle' || IMP.incoming) return;
    if (t.review?.drafts?.length) {
      Object.assign(IMP, { phase: 'review', drafts: t.review.drafts, skipped: t.review.skipped ?? 0, missed: t.review.missed ?? 0, dropped: t.review.dropped ?? 0, account: t.review.account ?? 0, rates: t.review.rates ?? {}, detail: -1 });
    } else if (t.run?.jobs) {
      Object.assign(IMP, { phase: 'paused', run: t.run, error: tr('已恢复上次未完成的识别', 'Picked up where you left off') });
    } else if (t.file?.buf) {
      IMP.incoming = new File([t.file.buf], t.file.name, { type: t.file.type ?? '' });
    } else return;
    if (state.session && state.data.category.size) impAutoStart();
  } finally { IMP.hold = false; }
}

/**
 * 有导入任务时：切到导入页，并自动开始（登录了、有 API 密钥才自动；没有密钥就停在导入页提示去设置，任务留着）。
 * 读完云端数据（登录后的第一次也算）再做，识别要用到分类和账户。
 */
function impAutoStart() {
  // 用户选了"继续编辑，稍后导入"：等记账页、弹窗关掉（impWaitCheck）
  if (impWaiting || !impBusy() || !state.session) return;
  if (state.tab !== 'import') { state.tab = 'import'; setTimeout(render, 0); }
  if (IMP.autoStarted) return;
  // 没有能用的密钥（或账单是 PDF / 截图却只有 DeepSeek 的）：直接打开图文向导，保存后回到这里自动开始
  if (typeof akReady === 'function' ? !akReady() : !aiKey()) {
    if (typeof akOpen === 'function' && !AK.shown) { AK.shown = true; akOpen('import'); setTimeout(render, 0); }
    return;
  }
  // PDF、截图要用 Claude：有 Claude 的密钥就切过去
  if (typeof akNeedsClaude === 'function' && akNeedsClaude() && aiKey('claude') && aiProvider() !== 'claude') store.set('hl.aiProvider', 'claude');
  if (IMP.incoming && IMP.phase === 'idle') { IMP.autoStarted = true; impStart([IMP.incoming]); }
  else if (IMP.phase === 'paused' && IMP.run) { IMP.autoStarted = true; impGo(); }
}
MOD.onLoad.push(async () => { impAutoStart(); });

const IMP_MAX_TEXT = 400000, IMP_MAX_PDF = 20 * 1024 * 1024;
const IMP_SLICE_W = 1200, IMP_SLICE_H = 1600, IMP_OVERLAP = 160;
/** 每段多少行数据。银行的备注很长，一行要输出一百多个词元，20 行一段比较稳。 */
const IMP_ROWS = 20;
const IMP_XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------------------------------------------------------------- 小工具

const impToCents = (v) => Math.round(Math.abs(v) * 100 + 1e-7);
/** YYYY-MM-DD → 天数；不是真实存在的日期返回 null */
function impDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  if (!m) return null;
  const day = epochDay(+m[1], +m[2], +m[3]);
  return dayISO(day) === `${m[1]}-${m[2]}-${m[3]}` ? day : null;
}
const impCats = () => [...state.data.category.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
const impAccounts = () => [...state.data.account.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
/** "其他"分类的名字：网页版的英文账号里叫 Other */
function impOther(income) {
  const c = impCats().find((x) => !x.parentId && !!x.isIncome === income && (x.name === '其他' || x.name === 'Other'));
  return c ? c.name : '其他';
}
const impIsOther = (name) => name === '其他' || name === 'Other';
const impB64 = (bytes) => { let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const impRender = () => { if (state.tab === 'import') render(); };

/** 国内银行和支付宝导出的 CSV 常用 GBK 编码；按 UTF-8 解出乱码时改用 GBK。 */
async function impText(file) {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('�')) return utf8;
  try { return new TextDecoder('gbk').decode(buf); } catch { return utf8; }
}

// ---------------------------------------------------------------- Excel（.xlsx 是一个 zip，里面是 XML）

/** 解开 zip 里想要的那些文件，返回 名字 → 文字。 */
async function impUnzip(buf, want) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder();
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (!want(name)) continue;
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const raw = u8.subarray(start, start + size);
    let bytes;
    if (method === 0) bytes = raw;
    else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error('zip method ' + method);
    out.set(name, dec.decode(bytes));
  }
  return out;
}

// ---------------------------------------------------------------- 加密压缩包（微信、支付宝导出的账单）
// 微信、支付宝导出的账单是带密码的 .zip：在本机输入密码解开，取出里面的 Excel / CSV，再按普通账单文件识别。
// 密码只在这台设备上用来解压，不保存、不上传。支持传统 ZipCrypto 和 AES（WinZip AE-1 / AE-2）两种加密。

const IMP_ZIP_ACCEPT = '.zip,application/zip,application/x-zip-compressed';
/**
 * "文件"按钮能选的类型：只列文档，不带 image/*。
 * 安卓 Chrome 只要 accept 里有 image/*，就只给"拍照 / 照片和视频"，打不开文件管理器；截图另有按钮。
 */
const IMP_FILE_ACCEPT = `.pdf,.csv,.xlsx,.xls,.txt,.zip,application/pdf,text/csv,text/comma-separated-values,text/plain,application/vnd.ms-excel,${IMP_XLSX_MIME},application/zip,application/x-zip-compressed`;
const impIsZip = (f) => /\.zip$/i.test(f.name ?? '') || /zip/.test(f.type ?? '');
const IMP_INNER = /\.(csv|xlsx|xls|pdf|txt|png|jpe?g|webp|heic)$/i;
const IMP_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const impCrcByte = (crc, b) => (IMP_CRC[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
const impCrc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = impCrcByte(c, u8[i]); return (c ^ 0xffffffff) >>> 0; };

/** 压缩包的目录：每个文件的名字、压缩方式、在包里的位置。 */
function impZipEntries(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = dv.getUint16(eocd + 10, true), out = [];
  let p = dv.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), time = dv.getUint16(p + 12, true), crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const rawName = u8.subarray(p + 46, p + 46 + nlen);
    // 国内软件打的包，文件名常常是 GBK（没有 UTF-8 标记）
    let name = new TextDecoder().decode(rawName);
    if (!(flags & 0x800) && name.includes('�')) try { name = new TextDecoder('gbk').decode(rawName); } catch { /* 保留 */ }
    let aes = null;
    for (let q = p + 46 + nlen; q + 4 <= p + 46 + nlen + elen;) {
      const id = dv.getUint16(q, true), len = dv.getUint16(q + 2, true);
      if (id === 0x9901 && len >= 7) aes = { version: dv.getUint16(q + 4, true), strength: u8[q + 8], method: dv.getUint16(q + 9, true) };
      q += 4 + len;
    }
    out.push({ name, flags, method, time, crc, csize, off, aes, encrypted: !!(flags & 1) });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

/** 传统 ZipCrypto 解密；密码不对返回 null。 */
function impZipCrypto(data, pw, checks) {
  let k0 = 0x12345678, k1 = 0x23456789, k2 = 0x34567890;
  const upd = (c) => { k0 = impCrcByte(k0, c); k1 = (Math.imul((k1 + (k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0; k2 = impCrcByte(k2, k1 >>> 24); };
  for (const c of pw) upd(c);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) { const t = (k2 | 2) & 0xffff; const d = data[i] ^ ((Math.imul(t, t ^ 1) >>> 8) & 0xff); out[i] = d; upd(d); }
  return checks.includes(out[11]) ? out.subarray(12) : null;
}

/** AES 加密（WinZip AE-1 / AE-2）：PBKDF2-SHA1 派生密钥，AES-CTR（小端计数器）解密；密码不对返回 null。 */
async function impZipAes(data, pw, strength) {
  const keyLen = [0, 16, 24, 32][strength];
  if (!keyLen) throw new Error('aes strength');
  const saltLen = keyLen / 2, salt = data.subarray(0, saltLen), verify = data.subarray(saltLen, saltLen + 2);
  const base = await crypto.subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-1' }, base, (keyLen * 2 + 2) * 8));
  if (bits[keyLen * 2] !== verify[0] || bits[keyLen * 2 + 1] !== verify[1]) return null;
  const enc = data.subarray(saltLen + 2, data.length - 10);
  // 计数器是小端的，浏览器的 AES-CTR 是大端：每 16 字节单独算一块密钥流（AES-CBC、零 IV 的第一块就是 AES(计数器)）
  const key = await crypto.subtle.importKey('raw', bits.subarray(0, keyLen), 'AES-CBC', false, ['encrypt']);
  const blocks = Math.ceil(enc.length / 16), out = new Uint8Array(enc.length), iv = new Uint8Array(16);
  for (let start = 0; start < blocks; start += 512) {
    const n = Math.min(512, blocks - start);
    const streams = await Promise.all(Array.from({ length: n }, (_, j) => {
      const ctr = new Uint8Array(16); let v = start + j + 1;
      for (let b = 0; b < 8 && v > 0; b++) { ctr[b] = v & 0xff; v = Math.floor(v / 256); }
      return crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, ctr);
    }));
    streams.forEach((ks, j) => {
      const k = new Uint8Array(ks, 0, 16), o = (start + j) * 16;
      for (let i = 0; i < 16 && o + i < enc.length; i++) out[o + i] = enc[o + i] ^ k[i];
    });
  }
  return out;
}

/** 解开压缩包里的一个文件；加密的要给密码（Uint8Array）。密码不对返回 null。 */
async function impZipRead(buf, e, pw) {
  const dv = new DataView(buf), start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
  let data = new Uint8Array(buf, start, e.csize), method = e.method;
  if (e.encrypted) {
    if (method === 99 && e.aes) { data = await impZipAes(data, pw, e.aes.strength); method = e.aes.method; }
    else data = impZipCrypto(data, pw, e.flags & 8 ? [(e.time >>> 8) & 0xff, e.crc >>> 24] : [e.crc >>> 24, (e.time >>> 8) & 0xff]);
    if (!data) return null;
  }
  let bytes;
  if (method === 0) bytes = data;
  else if (method === 8) {
    try { bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()); } catch { if (e.encrypted) return null; throw new Error('inflate'); }
  } else throw new AiError(tr(`压缩包「${e.name}」使用了不支持的压缩方式。`, `“${e.name}” uses an unsupported compression method.`));
  // 校验 CRC（AE-2 不带 CRC）：对不上多半是密码错了
  if (e.encrypted && !(e.aes?.version === 2) && impCrc32(bytes) !== e.crc) return null;
  return bytes;
}

const IMP_MIME_BY_EXT = { csv: 'text/csv', txt: 'text/plain', pdf: 'application/pdf', xlsx: IMP_XLSX_MIME, xls: 'application/vnd.ms-excel', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic' };

/** 把选中的压缩包换成里面的账单文件；要密码时弹窗问。用户取消返回 null。 */
async function impExpandZips(files) {
  const out = [];
  for (const f of files) {
    if (!impIsZip(f)) { out.push(f); continue; }
    const buf = await f.arrayBuffer();
    let entries;
    try { entries = impZipEntries(buf); } catch { throw new AiError(tr(`「${f.name}」不是有效的压缩包。`, `“${f.name}” isn't a valid zip file.`)); }
    entries = entries.filter((e) => !e.name.endsWith('/') && !e.name.startsWith('__MACOSX/') && IMP_INNER.test(e.name));
    if (!entries.length) throw new AiError(tr(`压缩包「${f.name}」中未找到账单文件。`, `No statement files in “${f.name}”.`));
    let pw = null, title = tr('请输入解压密码', 'Enter the zip password');
    for (const e of entries) {
      let bytes = null;
      for (;;) {
        if (e.encrypted && !pw) {
          const typed = await uiPrompt(title, '', { ok: tr('解压', 'Unzip'), placeholder: tr('导出账单时收到的密码', 'Sent with the export'), max: 64, secret: true });
          if (typed == null) return null;
          pw = new TextEncoder().encode(typed.trim());
        }
        bytes = await impZipRead(buf, e, pw);
        if (bytes) break;
        pw = null; title = tr('密码错误，请重新输入', 'Wrong password. Try again.');
      }
      const base = e.name.split('/').pop(), ext = base.split('.').pop().toLowerCase();
      out.push(new File([bytes], base, { type: IMP_MIME_BY_EXT[ext] ?? '' }));
    }
  }
  return out;
}

const impXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const impTags = (node, name) => [...node.getElementsByTagNameNS('*', name)];
const impKids = (node, name) => [...node.children].filter((c) => c.localName === name);

/** 读取 .xlsx 第一个工作表，返回按行、按列排好的单元格文本（和手机端 XlsxReader 一样）。 */
async function impReadXlsx(file) {
  // 压缩包内文件顺序不固定（工作表可能排在共享字符串之前），先全部读进内存
  const entries = await impUnzip(await file.arrayBuffer(), (n) => n.startsWith('xl/') && n.endsWith('.xml'));
  const sheetName = [...entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')))[0];
  if (!sheetName) throw new AiError(tr('该 Excel 文件中无工作表。', 'This Excel file has no sheets.'));
  const strings = [];
  if (entries.has('xl/sharedStrings.xml')) {
    for (const si of impTags(impXml(entries.get('xl/sharedStrings.xml')), 'si')) {
      // 注音（rPh）里的字不要
      strings.push(impTags(si, 't').filter((t) => { for (let n = t.parentNode; n && n !== si; n = n.parentNode) if (n.localName === 'rPh') return false; return true; }).map((t) => t.textContent).join(''));
    }
  }
  // 哪些单元格样式是日期格式，这些单元格里存的是"自 1899-12-30 起的天数"
  const dateStyles = new Set();
  if (entries.has('xl/styles.xml')) {
    const doc = impXml(entries.get('xl/styles.xml')), custom = new Set();
    for (const f of impTags(doc, 'numFmt')) {
      const code = (f.getAttribute('formatCode') ?? '').toLowerCase();
      if (code.includes('y') || (code.includes('d') && code.includes('m'))) { const id = parseInt(f.getAttribute('numFmtId'), 10); if (Number.isFinite(id)) custom.add(id); }
    }
    const xfs = impTags(doc, 'cellXfs')[0];
    if (xfs) impKids(xfs, 'xf').forEach((xf, i) => {
      const id = parseInt(xf.getAttribute('numFmtId') ?? '0', 10) || 0;
      if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58) || custom.has(id)) dateStyles.add(i);
    });
  }
  const colIndex = (ref) => { const m = /^[A-Za-z]+/.exec(ref ?? ''); return m ? [...m[0].toUpperCase()].reduce((s, c) => s * 26 + c.charCodeAt(0) - 64, 0) - 1 : null; };
  const rows = [];
  for (const r of impTags(impXml(entries.get(sheetName)), 'row')) {
    const row = [];
    for (const c of impKids(r, 'c')) {
      const col = colIndex(c.getAttribute('r')) ?? row.length, type = c.getAttribute('t'), style = parseInt(c.getAttribute('s') ?? '0', 10) || 0;
      const value = (impKids(c, 'v')[0]?.textContent ?? '') + impTags(c, 't').map((t) => t.textContent).join(''); // 内联字符串 <is><t>
      let text = value;
      if (type === 's') text = strings[parseInt(value, 10)] ?? '';
      else if ((type == null || type === 'n') && dateStyles.has(style) && value.trim() !== '' && Number.isFinite(Number(value))) text = dayISO(epochDay(1899, 12, 30) + Math.trunc(Number(value)));
      while (row.length < col) row.push('');
      row.push(text.trim());
    }
    if (row.some((x) => x !== '')) rows.push(row);
  }
  return rows;
}

const impToCsv = (rows) => rows.map((row) => row.map((cell) => (/[,"\n]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell)).join(',')).join('\n');

/**
 * 其他记账软件导出的表格（如木木记账）：表头里有日期、金额等固定列。
 * 这类数据本身就是结构化的，直接逐行读取，不经过 AI。表头不像记账表格时返回 null。
 */
function impLedgerSheet(rows) {
  if (!rows.length) return null;
  const header = rows[0].map((x) => x.toLowerCase());
  const find = (names) => { const i = header.findIndex((x) => names.includes(x)); return i >= 0 ? i : null; };
  const dateCol = find(['时间', '日期', '交易时间', '交易日期', 'date']), amountCol = find(['金额', 'amount']), categoryCol = find(['分类', '类别', '一级分类', 'category']);
  if (dateCol == null || amountCol == null || categoryCol == null) return null;
  const typeCol = find(['类型', '收支类型', '收支', 'type']), subCol = find(['二级分类', '子分类']), noteCol = find(['备注', '说明', 'note']), ledgerCol = find(['账本']);
  const accountCol = find(['转出账户', '账户', 'account']), toAccountCol = find(['转入账户']), tagsCol = find(['标签']), reimburseCol = find(['报销']);
  const transactions = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const cell = (i) => (i == null ? '' : row[i] ?? '');
    const type = cell(typeCol);
    const dm = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(cell(dateCol));
    const date = dm ? impDay(`${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`) : null;
    const text = cell(amountCol).replace(/,/g, '').replace(/€/g, '').replace(/¥/g, '').trim();
    const amount = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text) ? Number(text) : null;
    const cents = amount == null ? 0 : impToCents(amount);
    if (date == null || amount == null || cents === 0) { skipped++; continue; }
    // 转账、还款是钱在自己的账户之间移动：需要转出和转入两个账户
    const transfer = type.includes('转账') || type.includes('还款');
    const from = cell(accountCol), to = cell(toAccountCol);
    if (transfer && (!from.trim() || !to.trim())) { skipped++; continue; }
    const kind = transfer ? KIND.TRANSFER : type.includes('收入') ? KIND.INCOME : type.includes('支出') ? KIND.EXPENSE : amount > 0 ? KIND.INCOME : KIND.EXPENSE;
    const sub = cell(subCol), reimburse = cell(reimburseCol), note = cell(noteCol);
    transactions.push({
      date, amountCents: cents, kind, currency: 'EUR', note: note !== sub ? note : '',
      category: transfer ? '' : cell(categoryCol), sub: transfer ? '' : sub,
      // 收入记在"转出账户"那一列时照用；只填了转入账户时用转入账户
      account: from.trim() ? from : to, toAccount: transfer ? to : '', ledger: cell(ledgerCol),
      tags: cell(tagsCol).split(/[#,，;；\s]+/).filter((x) => x.trim()).join(' '),
      reimburse: reimburse.includes('已报销') ? 2 : reimburse.includes('待报销') ? 1 : 0,
      fromAi: false, counterparty: '', iban: '', source: '',
    });
  }
  return { transactions, skipped };
}

// ---------------------------------------------------------------- 账单行的原文、备注、分类名（BillParser 的小函数）

/** 把 CSV 的一行按表头拆成"列名: 值"，一列一行，空列不要。分隔符看表头里逗号多还是分号多。 */
function impDescribeRow(header, line) {
  const sep = (header.match(/;/g) ?? []).length > (header.match(/,/g) ?? []).length ? ';' : ',';
  const cells = (s) => {
    const out = []; let cur = '', quoted = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"' && quoted && s[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = !quoted;
      else if (c === sep && !quoted) { out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  };
  const names = cells(header);
  return cells(line).map((v, i) => (v ? `${names[i] ?? '#' + (i + 1)}: ${v}` : null)).filter(Boolean).join('\n');
}

/** 用账单这一行里的文字栏拼出备注。日期、金额、币种和长串的流水号不要；一栏已经包含在另一栏里的也不重复。 */
function impNoteFromRow(header, line) {
  const values = [...new Set(impDescribeRow(header, line).split('\n').map((x) => { const k = x.indexOf(': '); return (k >= 0 ? x.slice(k + 2) : x).trim(); })
    .filter((v) => v && !/^[-+]?[\d.,\s]+$/.test(v) && !/^\d{4}[-/]?\d{2}[-/]?\d{2}.*$/.test(v) && !/^[A-Z]{3}$/.test(v) && !/^[0-9a-fA-F-]{16,}$/.test(v)))];
  return values.filter((v) => !values.some((o) => o !== v && o.toLowerCase().includes(v.toLowerCase()))).join(', ').slice(0, 500);
}

/** 备注 = 商户名 + 银行流水上的原始说明；对方账号没出现在说明里时补在最后。 */
function impNoteOf(merchant, details, iban) {
  const parts = [];
  if (merchant && !details.toLowerCase().includes(merchant.toLowerCase())) parts.push(merchant);
  if (details) parts.push(details);
  if (iban && !details.replace(/ /g, '').toLowerCase().includes(iban.replace(/ /g, '').toLowerCase())) parts.push(iban);
  return parts.join(', ').slice(0, 500);
}

/** AI 有时把一级和子分类写在一起（"餐饮（买菜）"、"餐饮 / 买菜"），拆开来，不然对不上分类名。 */
function impSplitCategory(category, sub) {
  const bits = category.split(/[（(/／·>→\-：:]/).map((x) => x.trim().replace(/^[）)]+|[）)]+$/g, '')).filter(Boolean);
  const top = bits[0] ?? '其他';
  const child = sub.trim().replace(/^[（）()]+|[（）()]+$/g, '') || (bits[1] ?? '');
  return [top, child === top ? '' : child];
}

/** 支出分类的归一规则（手机端 CategoryRules）：意思相同的分类只留一个。 */
const IMP_RULE_TOP = { 日常: '居住', 居家: '居住', 住房: '居住', 装修: '居住', 家居: '居住', 旅游: '旅行', 出行: '交通', 饮食: '餐饮', 吃喝: '餐饮', 医药: '医疗', 教育: '学习', 人情: '社交', 通信: '通讯', 话费: '通讯', 美容: '美妆' };
const IMP_RULE_SUB = {
  '餐饮/咖啡': '咖啡饮料', '餐饮/饮料': '咖啡饮料', '餐饮/奶茶': '咖啡饮料', '交通/公交车': '公交地铁', '交通/公交': '公交地铁', '交通/地铁': '公交地铁',
  '交通/出租车': '打车', '交通/的士': '打车', '交通/共享单车': '自行车', '交通/机票': '飞机', '旅行/酒店住宿': '住宿', '旅行/酒店': '住宿',
  '居住/电费': '水电燃气', '居住/水费': '水电燃气', '居住/燃气': '水电燃气', '居住/暖气': '水电燃气', '居住/宽带': '网费', '居住/装修材料': '装修', '居住/软装': '家具', '居住/灯具': '家具', '医疗/药': '药品',
};
const IMP_RULE_HOME = { 通讯: ['通讯', ''], 运动: ['运动', ''], 居家: ['居住', ''], 理发: ['美妆', '理发'], 日用品: ['购物', '日用品'] };
function impExpenseRule(top, sub) {
  const t = IMP_RULE_TOP[top] ?? top;
  if (!sub.trim() || sub === t) return [t, ''];
  if (IMP_RULE_HOME[sub]) return IMP_RULE_HOME[sub];
  const s = IMP_RULE_SUB[`${t}/${sub}`] ?? sub;
  return [t, s === t ? '' : s];
}

// ---------------------------------------------------------------- 认出自己账户之间的转账（Counterparty.kt）

const IMP_LETTER_CODES = { INGB: 'ing', ABNA: 'abn', RABO: 'rabo', BUNQ: 'bunq', ASNB: 'asn', SNSB: 'sns', TRIO: 'triodos', KNAB: 'knab', REVO: 'revolut', TRWI: 'wise', MONZ: 'monzo', NNBA: 'nn' };
const IMP_NUMBER_CODES = [['DE', '10011001', 'n26'], ['DE', '10012345', 'trade republic'], ['LT', '32500', 'revolut'], ['BE', '967', 'wise']];
const IMP_TITLES = new Set(['HR', 'MR', 'MRS', 'MS', 'MW', 'DHR', 'MEVR', 'HEER', 'MEVROUW', 'DE']);
const IMP_BROKERS = ['trading 212', 'trading212', 'kraken', 'coinbase', 'bitvavo', 'robinhood', 'trade republic', 'finst', 'degiro', 'binance', 'scalable capital'];

/** IBAN 属于哪家银行；认不出返回 null。 */
function impBankOf(iban) {
  const s = String(iban ?? '').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (s.length < 15 || !/\p{L}/u.test(s[0]) || !/\p{L}/u.test(s[1])) return null;
  return IMP_LETTER_CODES[s.slice(4, 8)] ?? IMP_NUMBER_CODES.find(([cc, num]) => s.startsWith(cc) && s.startsWith(num, 4))?.[2] ?? null;
}
const impTokens = (name) => String(name ?? '').toUpperCase().split(/[^\p{L}]+/u).filter((x) => x && !IMP_TITLES.has(x));
/** 两个名字是不是同一个人（"Hui Tang" ↔ "HR H TANG"）：每个词要么原样出现、要么以首字母出现，并且至少有一个长词原样出现。 */
function impSameName(owner, other) {
  const mine = impTokens(owner), theirs = impTokens(other);
  if (!mine.length || !theirs.length) return false;
  let full = false;
  for (const w of mine) {
    if (theirs.includes(w)) { if (w.length >= 3) full = true; } else if (!theirs.includes(w.slice(0, 1))) return false;
  }
  return full;
}
const impSameBrand = (a, b) => !!a && !!b && (a.logo ? a.logo === b.logo : !b.logo && a.text === b.text && a.bg === b.bg);

/** 用对方名称和 IBAN 把 AI 的结果补准（Counterparty.resolve）。 */
function impResolve(p, known, statementAccount, other, owner, broker) {
  let tx = p;
  if (tx.kind !== KIND.TRANSFER && !known.has(tx.account) && statementAccount != null) tx = { ...tx, account: statementAccount };
  const own = impSameName(owner, tx.counterparty);
  const pool = [other, statementAccount].filter((x) => x != null);
  if (tx.kind === KIND.TRANSFER) {
    const a = known.has(tx.account) ? tx.account : null, b = known.has(tx.toAccount) ? tx.toAccount : null;
    // 缺的那头：先用对方 IBAN 对出来的账户，再用这份账单自己的账户
    const fill = pool.find((x) => x !== a && x !== b);
    if (a == null && fill != null) tx = { ...tx, account: fill };
    else if (b == null && fill != null) tx = { ...tx, toAccount: fill };
    if (!known.has(tx.account) || !known.has(tx.toAccount)) {
      const rest = pool.find((x) => x !== tx.account && x !== tx.toAccount);
      if (rest != null) tx = !known.has(tx.account) ? { ...tx, account: rest } : { ...tx, toAccount: rest };
    }
    return tx;
  }
  // 对方就是本人、IBAN 又对得上名单里另一个账户；或者对方是自己开户的券商：自己账户之间的转账
  for (const target of [own ? other : null, broker]) {
    if (target != null && target !== tx.account && known.has(tx.account)) {
      return tx.kind === KIND.INCOME ? { ...tx, kind: KIND.TRANSFER, category: '', account: target, toAccount: tx.account } : { ...tx, kind: KIND.TRANSFER, category: '', toAccount: target };
    }
  }
  return tx;
}

// ---------------------------------------------------------------- 查重、合并（Merge.kt）

/** 在金额相同的已有账单里找草稿对应的那一笔。AI 识别的：3 天内、类型相同或有一方是转账；表格导入的：同一天、同类型。 */
function impFindMatch(p, candidates, used) {
  let best = null, bestKey = null;
  for (const e of candidates) {
    if (used.has(e.id)) continue;
    const ok = p.fromAi ? Math.abs(e.date - p.date) <= 3 && (e.kind === p.kind || e.kind === KIND.TRANSFER || p.kind === KIND.TRANSFER) : e.date === p.date && e.kind === p.kind;
    if (!ok) continue;
    const key = [e.kind === p.kind ? 0 : 1, Math.abs(e.date - p.date)];
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) { best = e; bestKey = key; }
  }
  return best;
}

/** 两段备注合成一段：一段已经包含另一段就取长的，否则拼起来。 */
function impMergeNote(old, neu) {
  old = old ?? ''; neu = neu ?? '';
  const out = !neu.trim() || old.toLowerCase().includes(neu.toLowerCase()) ? old : !old.trim() || neu.toLowerCase().includes(old.toLowerCase()) ? neu : `${old} · ${neu}`;
  return out.slice(0, 500);
}

/** 把草稿 p 的信息并进已有账单 e。日期、金额、标签、报销状态以已有的为准。 */
function impMerged(e, p, fromId, toId, newCategoryId) {
  const tags = [...new Set([...(e.tags ?? '').split(' '), ...(p.tags ?? '').split(' ')].filter((x) => x.trim()))].join(' ');
  const base = { ...e, note: impMergeNote(e.note, p.note), tags };
  if (p.kind === KIND.TRANSFER && e.kind !== KIND.TRANSFER) {
    let from, to;
    if (fromId && toId && fromId !== toId) { from = fromId; to = toId; }
    else if (e.kind === KIND.INCOME) { from = [fromId, toId].find((x) => x && x !== e.accountId); if (!from) return base; to = e.accountId; }
    else { from = e.accountId; to = [toId, fromId].find((x) => x && x !== e.accountId); if (!to) return base; }
    return { ...base, kind: KIND.TRANSFER, categoryId: 0, accountId: from, toAccountId: to, reimburse: 0, excluded: false };
  }
  if (e.kind === KIND.TRANSFER) {
    // 已有的转账缺少或认错了一头，而草稿两头都认得出时，用草稿的
    return p.kind === KIND.TRANSFER && fromId && toId && fromId !== toId ? { ...base, accountId: fromId, toAccountId: toId } : base;
  }
  return newCategoryId && (e.kind === KIND.EXPENSE || e.kind === KIND.INCOME) ? { ...base, categoryId: newCategoryId } : base;
}

const IMP_MONTHS = [['jan'], ['feb'], ['mrt', 'maa', 'mar'], ['apr'], ['mei', 'may'], ['jun'], ['jul'], ['aug'], ['sep'], ['okt', 'oct'], ['nov'], ['dec']];
/** 补贴的说明里写的是哪个月的（"MAAND NOV."、"11月"），没写返回 null；年份取离到账日最近的那一个。 */
function impMonthOf(note, received) {
  const n = String(note ?? '').toLowerCase();
  let month = null;
  const a = /(?:maand|month|premie|voor|for)[\s.:]+([a-z]{3})/.exec(n);
  if (a) { const i = IMP_MONTHS.findIndex((x) => x.includes(a[1])) + 1; if (i > 0) month = i; }
  if (!month) { const b = /(\d{1,2})\s*月/.exec(n); if (b && +b[1] >= 1 && +b[1] <= 12) month = +b[1]; }
  if (!month) return null;
  const d = dayToDate(received), base = d.getUTCFullYear() * 12 + d.getUTCMonth();
  let best = null;
  for (const k of [-1, 0, 1]) { const c = { y: d.getUTCFullYear() + k, m: month }; if (!best || Math.abs(c.y * 12 + c.m - 1 - base) < Math.abs(best.y * 12 + best.m - 1 - base)) best = c; }
  return best;
}
/** 这笔支出的说明里有没有提到这个月（"nov"、"2026-11"、"11月"）。 */
function impMentions(note, ym) {
  const n = String(note ?? '').toLowerCase();
  return IMP_MONTHS[ym.m - 1].some((x) => new RegExp('\\b' + x).test(n)) || n.includes(`${ym.y}-${String(ym.m).padStart(2, '0')}`) || new RegExp(`(?<!\\d)${ym.m}\\s*月`).test(n);
}

// ---------------------------------------------------------------- 发给 AI 的内容（BillParser.kt）

const IMP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['transactions', 'account_holder', 'statement_iban'],
  properties: {
    account_holder: { type: 'string' }, statement_iban: { type: 'string' },
    transactions: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['date', 'amount', 'type', 'currency', 'merchant', 'category', 'subcategory', 'account', 'to_account', 'row', 'source', 'details', 'counterparty', 'counterparty_iban'],
      properties: {
        date: { type: 'string' }, amount: { type: 'number' }, type: { type: 'string', enum: ['expense', 'income', 'transfer'] }, currency: { type: 'string' },
        merchant: { type: 'string' }, category: { type: 'string' }, subcategory: { type: 'string' }, account: { type: 'string' }, to_account: { type: 'string' },
        row: { type: 'integer' }, source: { type: 'string' }, details: { type: 'string' }, counterparty: { type: 'string' }, counterparty_iban: { type: 'string' },
      },
    } },
  },
};

function impSystemPrompt(expense, income, accounts, ownerName, habits) {
  return `你是记账助手。用户会提供银行或支付应用的账单：手机截图、PDF 对账单，或导出的 CSV 文本。
账单可能来自中国的银行、支付宝、微信，也可能来自荷兰或其他欧洲银行（中文、荷兰语或英语）。
请逐笔提取其中的交易，要求：
- date：交易日期，格式 YYYY-MM-DD。账单只写了月和日时，年份按今天（${dayISO(today())}）往前推断，不要得出未来的日期。
- amount：金额的绝对值，正数。注意欧洲写法 1.234,56 表示 1234.56。
- type：钱流出账户是 expense，流入是 income；用户在自己的两个账户之间挪钱是 transfer（见下）。
- currency：ISO 货币代码（EUR、CNY、USD 等），按账单上的符号或银行所在地判断。
- merchant：商户或交易对方的简短名称；没有就用交易摘要。
- details：银行流水上这笔交易的原始说明，照抄成一行，不超过 300 个字符（收入、支出、转账都要写）；只有长串的流水号、卡号、哈希值可以省略，"MAAND NOV."、"PREMIE nov. 2026" 这类说明是哪个月的字样一定保留，账单上各栏的文字（交易类型、商户、商户类别等）都写上：摘要、附言/备注（Reference、Omschrijving、Mededeling）、From / To 行、卡号尾号等，用逗号分开；没有就填空字符串。
- row：账单是表格文本（CSV）时，这笔交易在本段数据里是第几行（表头不算，从 1 开始）；截图和 PDF 填 0。
- source：截图和 PDF 里这笔交易在账单上的原文，各栏照抄、用逗号分开；账单是表格文本时填空字符串。
- counterparty：交易对方的名称，照账单原样填（如 "HR H TANG"）；没有填空字符串。
- counterparty_iban：对方的账号 / IBAN（如 From: 或 To: 后面的 NL65INGB…），照抄，不要改动；没有填空字符串。
政府或单位发的补贴、津贴（如荷兰税务局 Belastingdienst 的 zorgtoeslag、huurtoeslag）是 income，category 选"补贴"（名单里有的话），并在 details 里保留 ZORGTOESLAG / HUURTOESLAG 这样的字样。
券商、信用卡 App 导出的流水（如 Trading 212）里：Card debit 是刷卡消费（expense，按商户归类）；Card credit 是商户退回的钱（income，category 选"退款"）；
Deposit / Top-up / 入金是从用户别的账户转进来的钱（transfer，to_account 是这份账单的账户）；Withdrawal / 出金反过来。
表里有商户名（Merchant name）和商户类别（Merchant category）两列时，两列都要用来判断分类，不要因为没有文字说明就选"其他"。常见的对应：
超市和食品店（Albert Heijn、Jumbo、Lidl、Aldi、Plus、Dirk、Dunya、亚超）→ 买菜；餐馆快餐（KFC、McDonald's、RESTAURANTS）→ 餐饮；
ovpay / "NLOV" 开头的一串字符 / NS / GVB / Arriva / Qbuzz → 公共交通；Ryanair、KLM、Transavia、easyJet、eDreams、AIRLINES → 飞机；
Airbnb、Booking、Hostelworld → 住宿；Joybuy、Action、Amazon、Bol、Temu、SHEIN → 购物（日用品或服饰）；JD Sports、Decathlon → 运动或服饰。
消费返现（Spending cashback、Cashback、刷卡返现、返利）是 income，category 选"消费返现"（名单里有的话）。
- category：一级分类。支出只能从这些里选一个（括号里是它的子分类）：${expense.join('；')}。收入只能从这些里选一个：${income.join('；')}。填括号前面的名字，拿不准时选"其他"。
- subcategory：所选一级分类括号里的一个子分类，原样填；没有合适的填空字符串。
AI 服务和工具（Anthropic、Claude、OpenAI、ChatGPT、Cursor、Midjourney、Perplexity 等）的订阅和充值，归到名单里带"AI"字样的子分类所在的分类（如 学习 / AI工具），不要归到"工作"。
${habits.length ? '用户以往的归类习惯（商户或备注 → 分类 / 子分类），遇到相同或相似的商户照此归类：' + habits.join('；') + '。' : ''}
- account：这笔交易发生在用户的哪个账户，只能从用户的账户名单里原样选一个；认不出这份账单属于哪个账户就填空字符串。
- to_account：仅 transfer 使用，其余填空字符串。
用户自己的账户名单：${accounts.join('、') || '（无）'}。
${ownerName.trim() ? `用户本人的姓名是「${ownerName.trim()}」（账单上可能是拼音、大写或姓和名颠倒的写法）。` : '账单抬头上的户主姓名就是用户本人。'}交易对方的名字就是用户本人时，一定是用户自己账户之间的转账。
另外在最外层填 account_holder（账单抬头上的户主姓名）和 statement_iban（这份账单自己的账号 / IBAN），没有就填空字符串。
IBAN 能看出是哪家银行：荷兰 IBAN 第 5–8 位是银行代码，INGB=ING、ABNA=ABN AMRO、RABO=Rabobank、BUNQ=bunq、ASNB=ASN、REVO=Revolut；
对方是户主本人、且对方 IBAN 属于用户名单里的另一家银行时，这笔就是从那个账户转来（或转去）的 transfer。
转账的判断：交易对方是用户自己的另一个账户（对方名称、IBAN 备注或摘要能对应到名单里的某个账户，
或摘要写明是本人账户互转、转入储蓄/投资账户、给支付宝/微信/Revolut/Wise 等自己的钱包充值或提现、信用卡还款、券商或交易所出入金），
就记为 transfer：account 填钱转出的账户，to_account 填钱转入的账户，category 填空字符串。
转账两头里只认得出一头时，认不出的那头填空字符串；两头都认不出、或对方是别人，就按普通的 expense / income 处理。
同一笔转账在转出方和转入方的账单里各出现一次时，只输出一笔。大额的整数转出转入要特别留意是不是自己账户之间的转账。
一笔交易里单独列出了手续费（Fee、Fees、Kosten）时拆成两笔：一笔是不含手续费的本金，另一笔是手续费，type 为 expense、merchant 写"手续费"、category 选最接近的（没有就选"其他"）。
只提取已完成的真实交易：忽略余额、小计、合计行，忽略失败、已撤销或待处理的交易。
长截图会被切成上下相邻且有少量重叠的多张图片，同一笔交易出现在两张图的重叠处时只算一笔。
如果内容里没有任何交易，返回空列表。不要编造看不清的内容。`;
}

/** 「餐饮（三餐、买菜…）」：一级分类带上它的子分类，给 AI 选。 */
function impWithSubs(top, cats) {
  const subs = cats.filter((c) => c.parentId === top.id).map((c) => c.name);
  return subs.length ? `${top.name}（${subs.join('、')}）` : top.name;
}

/** 从已有账单里总结归类习惯：最近一千笔里，同一个短备注最常归到哪个分类，取出现最多的六十条。 */
function impHabits() {
  const cats = state.data.category, groups = new Map();
  allTxs().sort(byNewest).filter((t) => t.kind !== KIND.TRANSFER && (t.note ?? '').length >= 2 && t.note.length <= 24 && !t.note.includes('·')).slice(0, 1000)
    .forEach((t) => { const k = t.note.trim().toLowerCase(); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
  const out = [];
  for (const [note, list] of groups) {
    const count = new Map(); let bestId = null, best = 0;
    for (const t of list) { const c = (count.get(t.categoryId) ?? 0) + 1; count.set(t.categoryId, c); }
    for (const [id, c] of count) if (c > best) { best = c; bestId = id; }
    const leaf = cats.get(bestId);
    if (!leaf) continue;
    const parent = cats.get(leaf.parentId);
    if (impIsOther((parent ?? leaf).name)) continue;
    out.push([list.length, note, parent ? `${parent.name} / ${leaf.name}` : leaf.name]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, 60).map((x) => `${x[1]} → ${x[2]}`);
}

// 一次请求要识别的内容。文字账单带着表头和这一段的数据行，装不下时可以再拆；图片和 PDF 没有 lines，不能拆。
const impTextBlock = (text) => ({ type: 'text', text });
const impTextJob = (name, header, lines) => ({ blocks: [impTextBlock(`以下是账单文件「${name}」的一部分（第一行是表头）：\n\n${header}\n${lines.join('\n')}`)], name, header, lines, fallback: null });
function impTextJobs(name, content) {
  const lines = content.split(/\r\n|\r|\n/).filter((l) => l.trim());
  if (lines.length < 2) return [{ blocks: [impTextBlock(`以下是账单文件「${name}」的内容：\n\n${content}`)], name, header: '', lines: [], fallback: null }];
  const jobs = [];
  for (let i = 1; i < lines.length; i += IMP_ROWS) jobs.push(impTextJob(name, lines[0], lines.slice(i, i + IMP_ROWS)));
  return jobs;
}

/** 缩到统一宽度；长截图按高度切片（上下重叠一点），避免整张被压缩到看不清。 */
async function impImageBlocks(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const sw = img.naturalWidth, sh = img.naturalHeight;
    if (!sw || !sh) throw new Error('empty');
    const W = Math.min(sw, IMP_SLICE_W), H = sw > IMP_SLICE_W ? Math.floor(sh * IMP_SLICE_W / sw) : sh, k = sw / W;
    const blocks = [];
    for (let top = 0; top < H;) {
      const hh = Math.min(IMP_SLICE_H, H - top);
      const c = document.createElement('canvas'); c.width = W; c.height = hh;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, hh);
      g.drawImage(img, 0, top * k, sw, hh * k, 0, 0, W, hh);
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.88).split(',')[1] } });
      if (top + hh >= H) break;
      top += IMP_SLICE_H - IMP_OVERLAP;
    }
    return blocks;
  } catch { throw new AiError(tr('无法读取所选图片。', "Couldn't read the selected image.")); } finally { URL.revokeObjectURL(url); }
}

async function impJobsFor(file, name) {
  const lower = name.toLowerCase(), mime = file.type ?? '';
  if (mime.startsWith('image/')) {
    aiCheckFiles('image'); // DeepSeek 只有 deepseek-flash 能读图片：别的模型发之前就停
    // 一张长截图切出来的几片相邻且有重叠，尽量放在同一次请求里
    const blocks = await impImageBlocks(file), jobs = [];
    for (let i = 0; i < blocks.length; i += 6) jobs.push({ blocks: blocks.slice(i, i + 6), name: '', header: '', lines: [], fallback: null });
    return jobs;
  }
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
    if (file.size > IMP_MAX_PDF) throw new AiError(tr(`「${name}」超过 20 MB，请拆分后再导入。`, `“${name}” is over 20 MB. Split it and import again.`));
    const bytes = new Uint8Array(await file.arrayBuffer());
    // DeepSeek 不收 PDF 文件：先在本机读出文字，和 CSV 一样分段交给它（扫描件读不出文字，转成图片）
    if (aiProvider() === 'deepseek') return impPdfJobs(bytes, name);
    const data = impB64(bytes);
    return [{ blocks: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: name }], name: '', header: '', lines: [], fallback: null, pdf: true, pages: impPdfPages(bytes) }];
  }
  if (lower.endsWith('.xls') || mime.includes('excel')) {
    throw new AiError(tr(`暂不支持旧版 Excel 文件「${name}」（.xls），请另存为 .xlsx 或导出为 PDF、CSV。`, `Old Excel files like “${name}” (.xls) aren't supported. Save as .xlsx, or export a PDF or CSV.`));
  }
  const content = await impText(file);
  if (content.length > IMP_MAX_TEXT) throw new AiError(tr(`「${name}」内容过长，请按月份拆分后再导入。`, `“${name}” is too long. Split it by month and import again.`));
  return impTextJobs(name, content);
}

// ---------------------------------------------------------------- PDF 读文字（pdf.js，放在 vendor/pdfjs/，第一次用到时才加载）

const IMP_PDFJS = 'vendor/pdfjs/';
/** 每段最多多少行文字（和表格账单一样分段，多段同时识别）。 */
const IMP_PDF_LINES = 40;
/** 有的 PDF 把汉字映射成长得一样的"康熙部首"（⾏ ⼈ ⺠），换回普通汉字，免得搜不到。 */
const IMP_RADICALS = {'⺠':'民','⻓':'长','⻔':'门','⻢':'马','⻜':'飞','⻛':'风','⻅':'见','⻆':'角','⻋':'车','⻉':'贝','⻝':'食','⻚':'页','⻥':'鱼','⺟':'母','⻄':'西','⻘':'青','⻨':'麦','⻩':'黄','⻬':'齐','⻰':'龙','⻳':'龟','⻮':'齿','⻈':'讠','⻊':'足','⻦':'鸟','⺁':'厂','⻌':'辶','⻍':'辶','⺮':'竹','⻂':'衤','⺨':'犭','⺩':'王','⺼':'月','⺾':'艹','⻖':'阝','⻗':'雨','⺪':'疋','⻣':'骨','⻤':'鬼','⻡':'鼎','⺧':'牛','⺝':'月','⻟':'食'};
const impPdfChars = (t) => t.replace(/[\u2E80-\u2FDF]/g, (c) => IMP_RADICALS[c] ?? c.normalize('NFKC'));
let impPdfLib = null;
function impLoadPdfJs() {
  impPdfLib ??= new Promise((ok, bad) => {
    const fail = () => { impPdfLib = null; bad(new AiError(tr('无法加载 PDF 读取组件，请检查网络后重试。', "Couldn't load the PDF reader. Check your network and try again."))); };
    const el = document.createElement('script');
    el.src = IMP_PDFJS + 'pdf.min.js';
    el.onload = () => {
      const lib = window.pdfjsLib;
      if (!lib) { fail(); return; }
      lib.GlobalWorkerOptions.workerSrc = IMP_PDFJS + 'pdf.worker.min.js';
      ok(lib);
    };
    el.onerror = fail;
    document.head.appendChild(el);
  });
  return impPdfLib;
}

/**
 * 读出 PDF 每一页的文字：y 坐标相近的算同一行，行内按 x 排好；隔得远的两栏之间用 " | " 隔开，像表格一样。
 * 中文银行账单常用不嵌入的宋体（UniGB 编码），要 cmaps 才能还原成文字。
 */
async function impPdfRead(bytes, name) {
  const lib = await impLoadPdfJs();
  let doc;
  try {
    doc = await lib.getDocument({ data: bytes, cMapUrl: IMP_PDFJS + 'cmaps/', cMapPacked: true, isEvalSupported: false }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new AiError(tr(`「${name}」设有密码，请先去除密码后再导入。`, `“${name}” is password-protected. Remove the password and import again.`));
    throw new AiError(tr(`无法读取 PDF 文件「${name}」。`, `Couldn't read the PDF “${name}”.`));
  }
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p), tc = await page.getTextContent(), rows = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const [, , , d, x, y] = it.transform, hgt = Math.abs(d) || it.height || 10;
      let r = rows.find((q) => Math.abs(q.y - y) < Math.min(q.h, hgt) * 0.5);
      if (!r) rows.push(r = { y, h: hgt, cells: [] });
      r.cells.push({ x, w: it.width || 0, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    const lines = rows.map((r) => {
      r.cells.sort((a, b) => a.x - b.x);
      let out = '', end = null;
      for (const c of r.cells) {
        if (end != null) { const gap = c.x - end; out += gap > r.h * 1.5 ? ' | ' : gap > r.h * 0.2 ? ' ' : ''; }
        out += c.s; end = c.x + c.w;
      }
      return impPdfChars(out).replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
    pages.push({ page, lines });
  }
  return { doc, pages };
}

/** PDF 的一段文字（第 from–to 页）。和表格一样交给 AI；装不下时按行对半拆（impSplit）。 */
const impPdfTextJob = (name, from, to, textLines) => ({
  blocks: [impTextBlock(`以下是 PDF 账单「${name}」${from === to ? `第 ${from} 页` : `第 ${from}–${to} 页`}的文字（已在本机按行读出，同一行里相隔较远的栏用 " | " 隔开）：\n\n${textLines.join('\n')}`)],
  name, header: '', lines: [], fallback: null, textLines, pfrom: from, pto: to,
});

/** PDF → 一段一段的文字（每段一到几页、不超过 IMP_PDF_LINES 行）。扫描件（几乎没有文字）每页转成图片，交给能看图的模型。 */
async function impPdfJobs(bytes, name) {
  const { doc, pages } = await impPdfRead(bytes, name);
  try {
    const chars = pages.reduce((a, p) => a + p.lines.join('').length, 0);
    if (chars < 30 * Math.max(1, pages.length)) {
      aiCheckFiles('image');
      const blocks = [];
      for (const [i, { page }] of pages.entries()) {
        const vp = page.getViewport({ scale: 1 }), v = page.getViewport({ scale: Math.min(2.5, 1800 / Math.max(vp.width, vp.height)) });
        const c = document.createElement('canvas');
        c.width = Math.floor(v.width); c.height = Math.floor(v.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
        const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.88));
        blocks.push(...await impImageBlocks(new File([blob], `${name}-${i + 1}.jpg`, { type: 'image/jpeg' })));
      }
      const jobs = [];
      for (let i = 0; i < blocks.length; i += 4) jobs.push({ blocks: blocks.slice(i, i + 4), name: '', header: '', lines: [], fallback: null });
      return jobs;
    }
    // 按行切段，每段不超过 IMP_PDF_LINES 行，记下是第几页到第几页
    const groups = [];
    pages.forEach(({ lines }, i) => {
      for (const line of lines) {
        let g = groups[groups.length - 1];
        if (!g || g.lines.length >= IMP_PDF_LINES) groups.push(g = { from: i + 1, to: i + 1, lines: [] });
        g.to = i + 1; g.lines.push(line);
      }
    });
    return groups.map((g) => impPdfTextJob(name, g.from, g.to, g.lines));
  } finally { doc.destroy(); }
}

/** PDF 有几页（数 /Type /Page；压缩过的读 /Count）。数不出来是 0。 */
function impPdfPages(bytes) {
  try {
    const s = new TextDecoder('latin1').decode(bytes);
    const n = (s.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
    if (n) return n;
    const counts = [...s.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
    return counts.length ? Math.max(...counts) : 0;
  } catch { return 0; }
}
/** 这一段要 AI 提取什么：整份，或 PDF 的某几页。 */
function impAsk(job) {
  if (!job.pdf || !job.from) return '请提取以上账单中的全部交易记录。';
  if (job.to < 0) return `请只提取 PDF 第 ${job.from} 页及之后各页中的交易记录，之前的页不要输出。`;
  if (job.to === job.from) return `请只提取 PDF 第 ${job.from} 页中的交易记录，其他页不要输出。`;
  return `请只提取 PDF 第 ${job.from}–${job.to} 页中的交易记录，其他页不要输出。`;
}
/**
 * 一段的结果太长、AI 没写完：拆小再识别。表格按行对半；PDF 按页对半（页数不知道就两页两页往后）；
 * 多张截图按张对半。已经拆到一页 / 一张 / 一行还装不下，返回空（这一段跳过，最后提醒）。
 */
function impSplit(job) {
  if (job.textLines?.length >= 2) {
    const half = Math.floor(job.textLines.length / 2);
    return [impPdfTextJob(job.name, job.pfrom, job.pto, job.textLines.slice(0, half)), impPdfTextJob(job.name, job.pfrom, job.pto, job.textLines.slice(half))];
  }
  if (job.lines.length >= 2) {
    const half = Math.floor(job.lines.length / 2);
    return [impTextJob(job.name, job.header, job.lines.slice(0, half)), impTextJob(job.name, job.header, job.lines.slice(half))];
  }
  if (job.pdf) {
    const a = job.from || 1, b = job.from ? job.to : (job.pages || -1);
    const part = (from, to) => ({ ...job, fallback: null, from, to });
    if (b < 0) return [part(a, a + 1), part(a + 2, -1)];
    if (b > a) { const mid = Math.floor((a + b) / 2); return [part(a, mid), part(mid + 1, b)]; }
    return [];
  }
  if (job.blocks.length > 1) {
    const half = Math.floor(job.blocks.length / 2);
    return [{ ...job, blocks: job.blocks.slice(0, half), fallback: null }, { ...job, blocks: job.blocks.slice(half), fallback: null }];
  }
  return [];
}

/**
 * 边收 AI 的回答边数：transactions 数组里已经完整写出的交易有几笔（不用等整段写完）。和手机端 LiveCount 一样。
 * 回答是 {"transactions":[{…},{…}…], …}：数"根对象 → 数组 → 对象"这一层收尾的 }，跳过字符串里的括号。
 */
function impLiveCount() {
  let i = 0, inStr = false, esc = false, stack = '', n = 0;
  return (t) => {
    if (t.length < i) { i = 0; inStr = false; esc = false; stack = ''; n = 0; }
    for (; i < t.length; i++) {
      const c = t[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') stack += c;
      else if ((c === '}' || c === ']') && stack) { stack = stack.slice(0, -1); if (c === '}' && stack === '{[') n++; }
    }
    return n;
  };
}

/** 发一次请求。返回 AI 给出的 JSON；输出被截断（装不下）时返回 null。onLive(n)：AI 每写完一笔调用一次。 */
async function impCall(system, job, onLive = () => {}) {
  const count = impLiveCount();
  let n = 0;
  onLive(0);
  try {
    return await aiJson(system, [...job.blocks, impTextBlock(impAsk(job))], IMP_SCHEMA, 16000, (t) => { const k = count(t); if (k !== n) { n = k; onLive(n); } });
  } catch (e) {
    if (e instanceof AiError && (e.tooLong || ['内容太长，AI 没写完。', 'Too long; the AI ran out of space.'].includes(e.message))) return null;
    throw e;
  }
}

function impParseJson(json, job) {
  const arr = json?.transactions;
  if (!Array.isArray(arr)) throw new AiError(tr('AI 返回的结果无法解析，请重试。', "Couldn't parse the AI's answer. Try again."));
  const str = (v) => (v == null ? '' : String(v)).trim();
  const out = [];
  for (const o of arr) {
    const date = impDay(o?.date);
    if (date == null) continue;
    const amount = Number(o.amount);
    if (!Number.isFinite(amount)) continue;
    const cents = impToCents(amount);
    if (cents <= 0) continue;
    const account = str(o.account), toAccount = str(o.to_account), [cat, sub] = impSplitCategory(str(o.category), str(o.subcategory));
    const rowLine = job.lines.length && Number.isInteger(o.row) ? job.lines[o.row - 1] : undefined;
    // 转账至少要认出一头的账户，且两头不能是同一个；否则按普通收支处理
    const transfer = o.type === 'transfer' && account !== toAccount;
    const fromRow = rowLine != null ? impNoteFromRow(job.header, rowLine) : '';
    out.push({
      date, amountCents: cents, kind: transfer ? KIND.TRANSFER : o.type === 'income' ? KIND.INCOME : KIND.EXPENSE,
      currency: str(o.currency).toUpperCase() || HOME,
      // 表格账单的备注直接用那一行里的文字栏；截图和 PDF 用 AI 抄下来的说明
      note: fromRow || impNoteOf(str(o.merchant), str(o.details), str(o.counterparty_iban)),
      counterparty: str(o.counterparty), iban: str(o.counterparty_iban),
      category: transfer ? '' : cat, sub: transfer ? '' : sub, account, toAccount: transfer ? toAccount : '', ledger: '', tags: '', reimburse: 0, fromAi: true,
      // 账单原文：表格文本按行号取那一行（比让 AI 抄一遍准），截图和 PDF 用 AI 抄下来的
      source: rowLine != null ? impDescribeRow(job.header, rowLine) : str(o.source),
    });
  }
  return out;
}

/**
 * 把选好的文件准备成一次"识别"：表格本机直接读完，其余切成一段一段等着交给 AI。
 * 返回的 run 记着还没识别的段和已经识别出来的记录，断网暂停后可以接着跑（impRunJobs）。
 */
async function impPrepare(files) {
  const local = [], jobs = [];
  let skipped = 0;
  for (const f of files) {
    const name = f.name || tr('文件', 'file');
    if (name.toLowerCase().endsWith('.xlsx') || f.type === IMP_XLSX_MIME) {
      let rows;
      try { rows = await impReadXlsx(f); } catch (e) { if (e instanceof AiError) throw e; throw new AiError(tr(`无法读取 Excel 文件「${name}」。`, `Couldn't read the Excel file “${name}”.`)); }
      const ledger = impLedgerSheet(rows);
      if (ledger) { local.push(...ledger.transactions); skipped += ledger.skipped; } else {
        const csv = impToCsv(rows);
        if (csv.length > IMP_MAX_TEXT) throw new AiError(tr(`「${name}」内容过长，请按月份拆分后再导入。`, `“${name}” is too long. Split it by month and import again.`));
        jobs.push(...impTextJobs(name, csv));
      }
    } else jobs.push(...await impJobsFor(f, name));
  }
  const run = { jobs, found: [...local], skipped, holder: '', statementIban: '', done: 0, missed: 0, dropped: 0, system: '' };
  if (!jobs.length) return run;
  if (!aiKey()) throw new AiError(tr('识别截图与银行账单需先设置 Claude / DeepSeek API 密钥，请先至「我的」页面设置。', 'Reading screenshots and statements needs an API key. Set one on the Me tab first.'));
  const cats = impCats(), tops = cats.filter((c) => !c.parentId);
  run.system = impSystemPrompt(tops.filter((c) => !c.isIncome).map((c) => impWithSubs(c, cats)), tops.filter((c) => c.isIncome).map((c) => impWithSubs(c, cats)),
    impAccounts().map((a) => a.name), store.get('hl.ownerName', '') ?? '', impHabits());
  return run;
}

/** 等到页面回到前台（切走、锁屏时 iPhone 会掐断请求，回来再发）。 */
const impWhenVisible = () => (document.hidden ? new Promise((ok) => {
  const f = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', f); ok(); } };
  document.addEventListener('visibilitychange', f);
}) : Promise.resolve());
/** 一段失败后最多再试几次、每次等多久（毫秒）。 */
const IMP_RETRY_WAIT = [2000, 5000, 12000];

/** 发一段；连接断了、服务繁忙就等一会儿再发（切走了就等回到前台再发，不算次数）。 */
async function impCallRetry(system, job, onLive) {
  for (let attempt = 0; ; attempt++) {
    try { return await impCall(system, job, onLive); } catch (e) {
      if (!aiRetryable(e)) throw e;
      if (document.hidden) { await impWhenVisible(); attempt--; continue; }
      if (attempt >= IMP_RETRY_WAIT.length) throw e;
      await new Promise((ok) => setTimeout(ok, IMP_RETRY_WAIT[attempt]));
      await impWhenVisible();
    }
  }
}

/**
 * 把 run 里剩下的段交给 AI（最多三段同时）。识别好的段马上记进 run.found；
 * 某段重试几次还是连不上，就把它（和没轮到的段）留在 run.jobs 里，抛出带 net 的错误——调用方显示"继续识别"。
 */
async function impRunJobs(run, onProgress) {
  const jobs = run.jobs;
  // 等着重试的段：至少算上次识别出的笔数，数字不往回掉
  const fb = (list) => list.reduce((a, j) => a + (j.fallback?.length ?? 0), 0);
  onProgress(run.done, run.done + jobs.length, run.found.length + fb(jobs), 0);
  while (jobs.length) {
    const wave = jobs.splice(0, 3), again = [], failed = [];
    // 正在识别的这几段也要算进存下来的进度里（页面这时被刷新，回来要重新识别它们）
    run.inWave = { pending: [...wave], again, failed };
    let netErr = null, otherErr = null, inflight = wave.length;
    // 每段正在写的回答里已经写完了几笔（-1：这段已经结束）
    const live = wave.map(() => 0);
    // liveOnly：只是 AI 又写完了一笔（数字和圆环跟着动，不用整页重画、不用存进度）
    const prog = (liveOnly = false) => {
      let running = 0, part = 0;
      wave.forEach((j, k) => {
        if (live[k] < 0) return;
        running += Math.max(live[k], j.fallback?.length ?? 0);
        // 表格按数据行数算；PDF 文字按读出的行数估（里面还有表头、合计等几行，所以打九折）
        const rows = j.lines.length || Math.floor((j.textLines?.length ?? 0) * 0.9);
        if (rows) part += Math.min(0.95, live[k] / rows);
      });
      onProgress(run.done, run.done + jobs.length + again.length + failed.length + inflight, run.found.length + fb(jobs) + fb(again) + running, part, liveOnly);
    };
    // 谁先识别完就先报进度、先记下来
    await Promise.all(wave.map(async (job, k) => {
      let json;
      const settle = () => { run.inWave.pending = run.inWave.pending.filter((j) => j !== job); live[k] = -1; };
      try { json = await impCallRetry(run.system, job, (n) => { if (live[k] >= 0 && live[k] !== n) { live[k] = n; prog(true); } }); } catch (e) {
        inflight--; settle();
        if (aiRetryable(e)) { failed.push(job); netErr ??= e; return; }
        // 别的错（AI 拒绝、返回看不懂）：放回去，点"继续识别"再试一次；再错就跳过这一段，最后提醒
        if (job.errored) { run.dropped++; run.done++; prog(); return; }
        failed.push({ ...job, errored: true }); otherErr ??= e;
        return;
      }
      inflight--; settle();
      try {
        if (json == null) {
          const parts = impSplit(job);
          if (parts.length) again.push(...parts); else { run.dropped++; run.done++; }
        } else {
          let list = impParseJson(json, job);
          // 核对行数：这一段有几行数据，识别出来的却更少，就再识别一次，取多的那次；还是少就记下来提醒
          if (job.lines.length && list.length < job.lines.length) {
            if (!job.fallback) { again.push({ ...job, fallback: list }); prog(); return; }
            if (job.fallback.length > list.length) list = job.fallback;
            run.missed += job.lines.length - list.length;
          }
          run.found.push(...list);
          if (!run.holder) run.holder = String(json.account_holder ?? '').trim();
          if (!run.statementIban) run.statementIban = String(json.statement_iban ?? '').trim();
          run.done++;
        }
        prog();
      } catch (e) { otherErr ??= e; }
    }));
    jobs.unshift(...again, ...failed);
    run.inWave = null;
    if (otherErr) throw otherErr;
    if (netErr) throw netErr;
  }
  return { transactions: run.found, skipped: run.skipped, holder: run.holder, statementIban: run.statementIban, missed: run.missed, dropped: run.dropped };
}

/** 识别结果 → 核对页的草稿：补准账户和转账、只认已有的分类和账户、和已有账单查重（LedgerViewModel.parseBills）。 */
function impToDrafts(result) {
  const cats = impCats(), tops = cats.filter((c) => !c.parentId), accounts = impAccounts();
  const known = new Set(accounts.map((a) => a.name));
  // 查重用内存里的全部账单一次比对
  const byAmount = new Map();
  for (const t of allTxs().sort(byNewest)) { if (!byAmount.has(t.amountCents)) byAmount.set(t.amountCents, []); byAmount.get(t.amountCents).push(t); }
  const matched = new Set();
  // 按 IBAN 认银行：对上名单里同一家银行的账户
  const accountOf = (iban) => {
    const bank = impBankOf(iban);
    if (!bank) return null;
    const brand = brandOf({ name: bank });
    return accounts.find((a) => (brand && impSameBrand(brandOf(a), brand)) || a.name.toLowerCase().split(/[^a-z0-9]+/).includes(bank))?.name ?? null;
  };
  // 对方是券商或交易所、而名单里正好有这家的账户：钱是转进（或转出）自己的投资账户
  const brokerOf = (name) => {
    const n = String(name ?? '').toLowerCase(), probe = IMP_BROKERS.find((b) => n.includes(b));
    const brand = probe && brandOf({ name: probe });
    return brand ? accounts.find((a) => impSameBrand(brandOf(a), brand))?.name ?? null : null;
  };
  const statementAccount = accountOf(result.statementIban);
  // 本人的名字用设置里填的，没填就用账单抬头上的户主
  const owner = (store.get('hl.ownerName', '') ?? '').trim() || result.holder;
  // 同一份账单里，AI 有的行写了账户、有的没写：没写的跟着多数走，免得落进默认账户
  const votes = new Map();
  for (const p of result.transactions) if (p.fromAi && p.kind !== KIND.TRANSFER && known.has(p.account)) votes.set(p.account, (votes.get(p.account) ?? 0) + 1);
  let majority = null, most = 0;
  for (const [a, n] of votes) if (n > most) { most = n; majority = a; }
  return result.transactions.map((p) => {
    // AI 偶尔会给出列表之外的分类名或账户名，分类归入"其他"，账户留空由用户指定，不凭空新建
    let tx = p;
    if (p.fromAi) {
      tx = impResolve(tx, known, statementAccount ?? majority, accountOf(p.iban), owner, brokerOf(p.counterparty || p.note));
      const income = tx.kind === KIND.INCOME;
      if (tx.kind !== KIND.TRANSFER && !tops.some((c) => c.name === tx.category && !!c.isIncome === income)) tx = { ...tx, category: impOther(income), sub: '' };
      // 子分类也只认已有的
      if (tx.sub) {
        const parent = tops.find((c) => c.name === tx.category && !!c.isIncome === income);
        if (!parent || !cats.some((c) => c.parentId === parent.id && c.name === tx.sub)) tx = { ...tx, sub: '' };
      }
      if (!known.has(tx.account)) tx = { ...tx, account: '' };
      if (!known.has(tx.toAccount)) tx = { ...tx, toAccount: '' };
    }
    // 只有本币金额才能直接和已有账单比对重复
    const match = tx.currency === HOME ? impFindMatch(tx, byAmount.get(tx.amountCents) ?? [], matched) : null;
    if (match) matched.add(match.id);
    // 对上了已有账单：银行流水默认合并进去（补备注、转账来源）；表格重复导入的默认不动
    return { tx, selected: !match || tx.fromAi, duplicate: !!match, matchId: match?.id ?? 0, merge: !!match };
  });
}

// ---------------------------------------------------------------- 开始识别

/** 修正文件（第一行以"操作,"开头）：交给 app.js 的修正流程，不经过 AI。 */
async function impTryPatch(file) {
  const lower = (file.name ?? '').toLowerCase();
  if ((file.type ?? '').startsWith('image/') || /\.(pdf|xlsx|xls)$/.test(lower) || file.size > 20 * 1024 * 1024) return false;
  const text = await impText(file);
  if (!(text.replace(/^﻿/, '').split(/\r?\n/)[0] ?? '').startsWith('操作,')) return false;
  state.patch = readPatch(text); state.error = '';
  return true;
}

async function impStart(files) {
  if (!files.length || IMP.phase === 'loading' || IMP.phase === 'saving') return;
  // 加密压缩包（微信、支付宝账单）：先问密码、解开，换成里面的文件
  if (files.some(impIsZip)) {
    try { files = await impExpandZips(files); } catch (e) { IMP.phase = 'idle'; IMP.error = e instanceof AiError ? e.message : tr('无法解开压缩包。', "Couldn't open the zip file."); render(); return; }
    if (!files) return;
  }
  Object.assign(IMP, { phase: 'loading', error: '', done: 0, total: 0, found: 0, part: 0, shown: 0, detail: -1, finished: false, run: null });
  impRender();
  try {
    if (files.length === 1 && await impTryPatch(files[0])) { IMP.phase = 'idle'; render(); return; }
    IMP.run = await impPrepare(files);
    // 文件已经读成一段一段的了：任务里存进度，不再存原文件；准备失败时文件还留着，可以再点"开始识别"
    IMP.incoming = null;
    impTaskSave({ file: null, run: IMP.run, review: null });
  } catch (e) {
    IMP.phase = 'idle';
    IMP.error = e instanceof AiError ? e.message : tr('识别失败：', 'Reading failed: ') + (e?.message || e?.name || '');
    render(); return;
  }
  await impGo();
}

/**
 * 跑 IMP.run 里剩下的段（第一次和点"继续识别"都走这里）。
 * 连接断了、重试几次还不行：停在"已识别 n 条 · 继续识别"（phase 'paused'），识别好的不丢。
 */
async function impGo() {
  const run = IMP.run;
  if (!run || IMP.phase === 'saving') return;
  Object.assign(IMP, { phase: 'loading', error: '', finished: false, done: run.done, found: run.found.length, part: 0, shown: run.found.length });
  impRender();
  impWakeOn();
  try {
    const result = await impRunJobs(run, (done, total, found, part, liveOnly) => {
      Object.assign(IMP, { done, total, found, part: part || 0 });
      if (!liveOnly) { impRender(); impTaskSaveSoon(); }
    });
    if (!result.transactions.length) throw new AiError(tr('未识别到交易记录。', 'No transactions were found.'));
    // 识别完了：进度圈先走满、报告读出几笔，停一下再进列表（和手机端一样）
    Object.assign(IMP, { finished: true, found: result.transactions.length });
    impRender();
    await new Promise((r) => setTimeout(r, 1100));
    IMP.finished = false; IMP.run = null;
    Object.assign(IMP, { phase: 'review', drafts: impSortDrafts(impToDrafts(result)), skipped: result.skipped, missed: result.missed, dropped: result.dropped, rates: {}, account: 0, detail: -1 });
    impTaskSaveSoon();
  } catch (e) {
    // 还有没识别的段：停在"继续识别"（任务留着，可以重试或放弃）；全部跑完却出错（例如一笔都没认出）才结束
    if (IMP.run && IMP.run.jobs.length) { IMP.phase = 'paused'; IMP.error = e.net ? tr('网络已断开', 'Connection lost') : e.message; } else {
      IMP.phase = 'idle'; IMP.run = null;
      IMP.error = e instanceof AiError ? e.message : tr('识别失败：', 'Reading failed: ') + (e?.message || e?.name || '');
    }
  } finally { impWakeOff(); }
  if (IMP.phase === 'paused') impTaskSaveSoon();
  if (IMP.phase === 'idle' && !IMP.run) { impTaskClear(); impNext(); }
  render();
}

// 识别时屏幕常亮：iPhone 自动锁屏会掐断正在等的请求。切走再回来要重新申请（浏览器切走时会自动放掉）。
let impWake = null;
async function impWakeOn() {
  try {
    if (impWake || !navigator.wakeLock || document.hidden) return;
    impWake = await navigator.wakeLock.request('screen');
    impWake.addEventListener('release', () => { impWake = null; });
  } catch { /* 不支持或不让：算了 */ }
}
function impWakeOff() { try { impWake?.release(); } catch { /* 已经放掉了 */ } impWake = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && IMP.phase === 'loading') impWakeOn(); });

/** 点"粘贴截图"：读剪贴板里的图片。 */
async function impPaste() {
  const files = [];
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) files.push(new File([await item.getType(type)], `paste-${files.length + 1}.${type.split('/')[1]}`, { type }));
    }
  } catch { /* 没给权限或剪贴板里不是图片 */ }
  if (!files.length) { IMP.error = tr('剪贴板中无截图', 'No screenshot on the clipboard'); render(); return; }
  await impStart(files.slice(0, 10));
}

// ---------------------------------------------------------------- 写入（LedgerViewModel.importDrafts）

/** 1 单位外币折合多少主货币；汇率表里没有返回 null。 */
function impFxRate(c) {
  const f = c === 'EUR' ? 1 : fx.rates[c], t = HOME === 'EUR' ? 1 : fx.rates[HOME];
  return f && t ? Math.round((t / f) * 1e6) / 1e6 : null;
}

/** 已选几笔、要哪些汇率、缺不缺账户、能不能导入。 */
function impStatus() {
  const selected = IMP.drafts.filter((d) => d.selected);
  const foreign = [...new Set(selected.map((d) => d.tx.currency).filter((c) => c !== HOME))];
  const rates = {};
  for (const c of foreign) {
    // 没手动填（或填得不对）就用汇率表里的
    const typed = String(IMP.rates[c] ?? '').trim().replace(',', '.');
    const v = typed && /^\d*\.?\d+$/.test(typed) ? Number(typed) : impFxRate(c);
    rates[c] = v > 0 ? v : null;
  }
  const lacks = (d) => !d.merge && (!d.tx.account || (d.tx.kind === KIND.TRANSFER && !d.tx.toAccount));
  const missing = selected.filter(lacks).length;
  const ready = selected.length > 0 && Object.values(rates).every((r) => r != null) && (!missing || state.data.account.has(IMP.account));
  return { selected, foreign, rates, missing, ready };
}

function impGuessAccountType(name) {
  const n = name.toLowerCase();
  if (['信用', 'credit', 'master', 'visa', '花呗', '白条'].some((x) => n.includes(x))) return 2;
  if (['trading', '投资', '基金', '股票', '证券', '理财', 'degiro'].some((x) => n.includes(x))) return 1;
  return 0;
}

async function impImport() {
  const st = impStatus();
  if (!st.ready || IMP.phase !== 'review') return;
  Object.assign(IMP, { phase: 'saving', error: '', saveDone: 0, saveTotal: st.selected.length });
  render();
  let last = 0;
  const nid = () => { let id = newId(); if (id <= last) id = last + 1; last = id; return id; };
  const cats = impCats(), accts = impAccounts(), books = [...state.data.ledger.values()];
  const defaultAccount = state.data.account.get(IMP.account) ?? null;
  const ledger = async (name) => {
    if (!name.trim()) return state.ledgerId;
    const hit = books.find((l) => l.name === name);
    if (hit) return hit.id;
    const l = { id: nid(), name }; await saveRecord('ledger', l); books.push(l); return l.id;
  };
  // 表格里出现而这边没有的账户按名字新建；空的用"记入"那个账户
  const account = async (name) => {
    if (!name.trim()) return defaultAccount?.id ?? null;
    const hit = accts.find((a) => a.name === name);
    if (hit) return hit.id;
    const a = { id: nid(), name, type: impGuessAccountType(name), initialCents: 0, sortOrder: accts.length, currency: '', archived: false, checkedAt: 0 };
    await saveRecord('account', a); accts.push(a); return a.id;
  };
  const category = async (name, sub, income) => {
    // 支出分类先按合并规则归一（如"日常"并入"居住"），免得导入后又出现重复分类
    let topName = name.trim() || impOther(income);
    if (!income) [topName, sub] = impExpenseRule(topName, sub);
    let top = cats.find((c) => !c.parentId && !!c.isIncome === income && c.name === topName);
    if (!top) { top = { id: nid(), name: topName, icon: iconKey(topName), isIncome: income, sortOrder: cats.length, parentId: 0 }; await saveRecord('category', top); cats.push(top); }
    if (!sub.trim() || sub === topName) return top.id;
    const hit = cats.find((c) => c.parentId === top.id && c.name === sub);
    if (hit) return hit.id;
    const icon = iconKey(sub);
    const child = { id: nid(), name: sub, icon: icon !== 'tag' ? icon : top.icon, isIncome: income, sortOrder: cats.length, parentId: top.id };
    await saveRecord('category', child); cats.push(child); return child.id;
  };
  const rows = [];
  const step = () => { IMP.saveDone++; impRender(); };
  try {
    for (const d of IMP.drafts) {
      if (!d.selected) continue;
      const p = d.tx;
      const e = d.merge && d.matchId ? state.data.tx.get(d.matchId) : null;
      if (e) {
        // 草稿里认不出的那头记 0，不拿默认账户去填
        const fromId = p.account ? (await account(p.account)) ?? 0 : 0, toId = p.toAccount ? (await account(p.toAccount)) ?? 0 : 0;
        const leaf = cats.find((c) => c.id === e.categoryId), top = leaf && leaf.parentId ? cats.find((c) => c.id === leaf.parentId) ?? leaf : leaf;
        // 原来记在"其他"下，或只有一级分类而这次认出了子分类：换成这次更具体的分类
        const vague = impIsOther(top?.name) || (leaf && !leaf.parentId && !!p.sub);
        const better = p.kind === e.kind && p.kind !== KIND.TRANSFER && vague && p.category && !impIsOther(p.category) ? await category(p.category, p.sub, p.kind === KIND.INCOME) : 0;
        const merged = impMerged(e, p, fromId, toId, better);
        if (JSON.stringify(merged) !== JSON.stringify(e)) await saveRecord('tx', merged);
        d.selected = false; step();
        continue;
      }
      const from = await account(p.account);
      const to = p.kind === KIND.TRANSFER ? await account(p.toAccount) : 0;
      if (from == null || to == null || (p.kind === KIND.TRANSFER && to === from)) { d.selected = false; step(); continue; }
      const foreign = p.currency !== HOME;
      const t = {
        id: nid(), amountCents: foreign ? Math.round(p.amountCents * st.rates[p.currency]) : p.amountCents, kind: p.kind,
        categoryId: p.kind === KIND.TRANSFER ? 0 : await category(p.category, p.sub, p.kind === KIND.INCOME),
        accountId: from, toAccountId: to, ledgerId: await ledger(p.ledger ?? ''), date: p.date, note: p.note, tags: p.tags ?? '', reimburse: p.reimburse ?? 0,
        createdAt: Date.now(), currency: foreign ? p.currency : '', origCents: foreign ? p.amountCents : 0,
        excluded: false, offsetOf: 0, offsetParts: '', project: '', fund: '', loanPerson: '', loanSide: 0,
      };
      await saveRecord('tx', t);
      rows.push(t); d.selected = false; step();
    }
    await impLinkSubsidies();
  } catch (e) {
    // 已经写进去的那几笔取消了勾选，再点一次只写剩下的
    IMP.phase = 'review'; IMP.error = tr('未完成，可再次点击：', 'Not finished, try again: ') + (e?.message ?? '');
    render(); return;
  }
  // 导入的账单都在别的账本里时（表格自带账本名），切到笔数最多的那个，免得首页看起来是空的
  if (rows.length && !rows.some((t) => t.ledgerId === state.ledgerId)) {
    const count = new Map(); for (const t of rows) count.set(t.ledgerId, (count.get(t.ledgerId) ?? 0) + 1);
    state.ledgerId = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0]; store.set('hl.ledger', state.ledgerId);
  }
  if (rows.length) { const d = dayToDate(Math.max(...rows.map((t) => t.date))); state.month = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; }
  impReset();
  state.tab = (typeof hm !== 'undefined' && hm.back?.import) || 'me';
  scrollTo(0, 0);
  render();
}

/**
 * 自动把补贴关联到它抵扣的支出（LedgerViewModel.linkSubsidies）：备注里写明是医保补贴（zorgtoeslag）或住房补贴（huurtoeslag）的收入，
 * 归到"补贴"分类，并连到日期最近的那笔医保 / 房租支出。
 */
async function impLinkSubsidies() {
  const all = allTxs(), cats = state.data.category;
  const names = (id) => { const c = cats.get(id); return c ? [c.name, cats.get(c.parentId)?.name].filter(Boolean) : []; };
  const offsetIds = (t) => (t.offsetParts ? t.offsetParts.split(',').map((x) => Number(x.split(':')[0])).filter(Boolean) : t.offsetOf > 0 ? [t.offsetOf] : []);
  const taken = new Set(all.filter((t) => t.kind === KIND.INCOME).flatMap(offsetIds));
  const HEALTH = ['医保', '保险', 'Insurance'], RENT = ['房租', 'Rent'];
  const rules = [[['zorgtoeslag', '医保补贴', '医疗补贴', '保险补贴'], HEALTH], [['huurtoeslag', '住房补贴', '房租补贴', '房补'], RENT]];
  const nearest = (list, day) => list.reduce((b, e) => (!b || Math.abs(e.date - day) < Math.abs(b.date - day) ? e : b), null);
  let subsidy = 0;
  const subsidyId = async () => {
    if (subsidy) return subsidy;
    let c = [...cats.values()].find((x) => !x.parentId && x.isIncome && (x.name === '补贴' || x.name === 'Allowance'));
    if (!c) { const name = tr('补贴', 'Allowance'); c = { id: newId(), name, icon: iconKey('补贴'), isIncome: true, sortOrder: cats.size, parentId: 0 }; await saveRecord('category', c); }
    return (subsidy = c.id);
  };
  const link = async (income, expense) => { taken.add(expense.id); await saveRecord('tx', { ...income, offsetOf: expense.id, categoryId: await subsidyId() }); };
  for (const income of all.filter((t) => t.kind === KIND.INCOME && !t.offsetOf && (t.note ?? '').trim()).sort((a, b) => a.date - b.date)) {
    const note = income.note.toLowerCase();
    const targets = rules.find(([words]) => words.some((w) => note.includes(w)))?.[1];
    if (!targets) continue;
    const pool = all.filter((e) => e.kind === KIND.EXPENSE && !taken.has(e.id) && e.ledgerId === income.ledgerId && names(e.categoryId).some((n) => targets.includes(n)));
    // 说明里写了是哪个月的补贴：找那个月的支出（说明里也提到这个月的优先，其次是上个月初到这个月底之间、离到账日最近的）
    const month = impMonthOf(income.note, income.date);
    let expense;
    if (month) {
      const from = epochDay(month.y, month.m - 1, 1), to = epochDay(month.y, month.m + 1, 0), inRange = pool.filter((e) => e.date >= from && e.date <= to);
      expense = inRange.find((e) => impMentions(e.note, month)) ?? nearest(inRange, income.date);
    } else expense = nearest(pool.filter((e) => e.date - income.date >= -10 && e.date - income.date <= 35), income.date);
    if (expense) await link(income, expense);
  }
  // 没写备注的也认两种很有规律的：记在"退款"或"补贴"下、前后 5 天内，金额和一笔医保几乎相等，或者是一笔房租的四成到六成五
  const linkedNow = new Set(allTxs().filter((t) => t.kind === KIND.INCOME && t.offsetOf).map((t) => t.id));
  for (const income of all.filter((t) => t.kind === KIND.INCOME && !t.offsetOf && !linkedNow.has(t.id) && names(t.categoryId).some((n) => ['退款', '补贴', 'Refund', 'Allowance'].includes(n))).sort((a, b) => a.date - b.date)) {
    const near = all.filter((e) => e.kind === KIND.EXPENSE && !taken.has(e.id) && e.ledgerId === income.ledgerId && Math.abs(e.date - income.date) <= 5);
    const expense = near.find((e) => names(e.categoryId).some((n) => HEALTH.includes(n)) && Math.abs(e.amountCents - income.amountCents) * 50 <= e.amountCents)
      ?? near.find((e) => names(e.categoryId).some((n) => RENT.includes(n)) && income.amountCents * 100 >= e.amountCents * 40 && income.amountCents * 100 <= e.amountCents * 65);
    if (expense) await link(income, expense);
  }
}

function impReset() {
  impTaskClear(); IMP.autoStarted = false;
  Object.assign(IMP, { phase: 'idle', error: '', done: 0, total: 0, found: 0, run: null, drafts: [], skipped: 0, missed: 0, dropped: 0, detail: -1, detailErr: '', detailForm: null, rates: {}, account: 0, saveDone: 0, saveTotal: 0 });
  // 排着的下一份账单（导入进行中又收到的）：接着开始
  impNext();
}

// ---------------------------------------------------------------- 页面

/** 看起来是一段文字、点开是系统自带的选择器（iPhone 上是底部滚轮）。 */
function impDropdown(text, attrs, options, cls = '') {
  return `<label class="imp-dd ${cls}"><span>${text}</span><select ${attrs}><option value="" selected disabled hidden></option>${options}</select></label>`;
}

function impIcon(p) {
  if (p.kind === KIND.TRANSFER) return 'transfer';
  const cats = impCats(), income = p.kind === KIND.INCOME;
  const top = cats.find((c) => !c.parentId && !!c.isIncome === income && c.name === p.category), sub = top && p.sub ? cats.find((c) => c.parentId === top.id && c.name === p.sub) : null;
  if (sub?.icon || top?.icon) return sub?.icon ?? top.icon;
  const k = iconKey(p.sub || '');
  return k !== 'tag' ? k : iconKey(p.category || '');
}

/** 核对列表的顺序：还不知道是哪个账户的排最上面，先让用户选；其余保持原来的顺序。 */
function impSortDrafts(drafts) {
  const lacks = (d) => !d.duplicate && (!d.tx.account || (d.tx.kind === KIND.TRANSFER && !d.tx.toAccount));
  return [...drafts.filter(lacks), ...drafts.filter((d) => !lacks(d))];
}

function impRow(d, i, accounts, tops) {
  const p = d.tx, transfer = p.kind === KIND.TRANSFER, income = p.kind === KIND.INCOME;
  const accountOptions = accounts.map((a) => `<option value="${h(a.name)}">${h(a.name)}</option>`).join('');
  let title;
  if (transfer) {
    // 转账两头都可以点开改；认不出来的那头显示"待指定"
    const end = (name, key) => impDropdown(name ? h(name) + ' ▾' : `<i class="imp-need">${tr('待指定', 'to be set')} ▾</i>`, `data-imp="${key}" data-i="${i}" aria-label="${key === 'from' ? tr('转出账户', 'From account') : tr('转入账户', 'To account')}"`, accountOptions);
    title = `<div class="imp-tr">${end(p.account, 'from')}<span class="muted">→</span>${end(p.toAccount, 'to')}</div>`;
  } else {
    const name = (p.category || impOther(income)) + (p.sub ? ' · ' + p.sub : '');
    title = impDropdown(h(name) + ' ▾', `data-imp="cat" data-i="${i}" aria-label="${tr('分类', 'Category')}"`,
      tops.filter((c) => !!c.isIncome === income).map((c) => `<option value="${h(c.name)}">${h(c.name)}</option>`).join(''));
  }
  const detail = [dayISO(p.date), p.note, (p.tags ?? '').split(' ').filter(Boolean).map((x) => '#' + x).join(' ')].filter(Boolean).map(h).join('  ');
  // 记到哪个账户：银行标志 + 名字，点开可以换；认不出来的显示"选择账户"
  const acc = transfer ? null : accounts.find((a) => a.name === p.account);
  const accChip = transfer ? '' : impDropdown(acc ? `${accountTile(acc, 'imp-acctile')}<span>${h(acc.name)}</span> ▾` : `<i class="imp-need">${tr('选择账户', 'Choose account')} ▾</i>`,
    `data-imp="acc" data-i="${i}" aria-label="${tr('账户', 'Account')}"`, accountOptions, 'imp-accdd');
  let dup = '';
  if (d.duplicate) {
    // 对上了已有账单：点一下在"合并进去"和"另存为新的一笔"之间切换
    const e = state.data.tx.get(d.matchId);
    dup = `<button class="imp-dup${d.merge ? '' : ' new'}" data-act="imp-merge" data-v="${i}">${d.merge ? tr('合并到已有账单', 'Merge into existing') : tr('另存为新账单', 'Save as new')}  ▾${e ? `  ${dayISO(e.date)} ${h(e.note ?? '')}` : ''}</button>`;
  }
  const sign = income ? '+' : p.kind === KIND.EXPENSE ? '-' : '';
  return `<div class="card imp-row${d.selected ? '' : ' off'}">
    <input type="checkbox" class="imp-ck" data-imp="sel" data-i="${i}" ${d.selected ? 'checked' : ''} aria-label="${tr('选择', 'Select')}">
    ${iconTile(impIcon(p), 'imp-tile')}
    <div class="imp-main">${title}${accChip}<div class="imp-sub" data-act="imp-detail" data-v="${i}" role="button" tabindex="0">${detail}</div>${dup}</div>
    <button class="imp-amt num ${income ? 'in' : p.kind === KIND.EXPENSE ? 'out' : ''}" data-act="imp-flip" data-v="${i}" ${transfer ? 'disabled' : ''}>${sign}${money(p.amountCents, p.currency)}</button>
  </div>`;
}

function impDetailView() {
  const d = IMP.drafts[IMP.detail];
  if (!d) return '';
  const p = d.tx, f = IMP.detailForm ?? { date: dayISO(p.date), amt: (p.amountCents / 100).toFixed(2), note: p.note };
  return `<div class="modal imp-modal" data-act="imp-detail-x"><div class="card grid" role="dialog" aria-modal="true" aria-label="${tr('核对该笔账单', 'Check this entry')}">
    <b style="font-size:17px">${tr('核对该笔账单', 'Check this entry')}</b>
    ${p.source ? `<div><div class="muted small">${tr('账单原文', 'From the statement')}</div><div class="imp-src">${h(p.source)}</div></div>` : ''}
    <div class="two"><label class="f">${tr('日期', 'Date')}<input id="imp-d-date" type="date" value="${h(f.date)}"></label>
      <label class="f">${tr('金额', 'Amount')} ${h(p.currency)}<input id="imp-d-amt" inputmode="decimal" autocomplete="off" value="${h(f.amt)}"></label></div>
    <label class="f">${tr('备注', 'Note')}<textarea id="imp-d-note" rows="3">${h(f.note)}</textarea></label>
    ${IMP.detailErr ? `<div class="err">${h(IMP.detailErr)}</div>` : ''}
    <div class="between"><button class="btn" data-act="imp-detail-x">${tr('取消', 'Cancel')}</button><button class="btn primary" data-act="imp-detail-ok">${tr('保存', 'Save')}</button></div>
  </div></div>`;
}

function impReviewView() {
  impTaskSaveSoon();
  const st = impStatus(), accounts = impAccounts(), tops = impCats().filter((c) => !c.parentId);
  const saving = IMP.phase === 'saving', all = IMP.drafts.every((d) => d.selected);
  const summary = tr(`识别到 ${IMP.drafts.length} 笔，已选 ${st.selected.length} 笔`, `${IMP.drafts.length} found, ${st.selected.length} selected`)
    + (IMP.skipped > 0 ? tr(`，另有 ${IMP.skipped} 行因信息不全跳过`, `, ${IMP.skipped} incomplete rows skipped`) : '')
    + (IMP.missed > 0 ? tr(`，账单中还有 ${IMP.missed} 行未被识别，请您对照原文件`, `, ${IMP.missed} statement rows were not read — check the file`) : '')
    + (IMP.dropped > 0 ? tr(`，另有 ${IMP.dropped} 部分内容无法识别，已跳过，请您对照原文件`, `, ${IMP.dropped} part(s) couldn't be read and were skipped — check the file`) : '');
  const def = state.data.account.get(IMP.account);
  const accPick = st.missing ? `<div class="imp-acc"><span>${tr(`${st.missing} 笔缺少账户信息，记入`, `${st.missing} without an account, put in`)}</span>
    ${accounts.length ? impDropdown(`${def ? accountTile(def, 'sm') : ''}<b>${h(def?.name ?? tr('选择账户', 'Choose account'))}</b> ▾`, `data-imp="acct" aria-label="${tr('选择账户', 'Choose account')}"`,
      accounts.map((a) => `<option value="${a.id}">${h(a.name)}</option>`).join(''), `chip${def ? ' lead' : ''}`) : `<span class="err">${tr('请先至「账户」页添加账户', 'Add an account on the Accounts tab first')}</span>`}</div>` : '';
  const rates = st.foreign.map((c) => `<label class="f">${tr(`汇率：1 ${c} = ? ${HOME}`, `Rate: 1 ${c} = ? ${HOME}`)}<input data-imp="rate" data-c="${h(c)}" inputmode="decimal" autocomplete="off" value="${h(IMP.rates[c] ?? impFxRate(c)?.toFixed(4) ?? '')}"></label>`).join('');
  return `<div class="imp-top"><span class="imp-sum">${summary}</span><button class="btn link" data-act="imp-all" ${saving ? 'disabled' : ''}>${all ? tr('全不选', 'Select none') : tr('全选', 'Select all')}</button></div>
    <div class="imp-list${saving ? ' busy' : ''}">${IMP.drafts.map((d, i) => impRow(d, i, accounts, tops)).join('')}</div>
    <div class="card imp-foot">${accPick}${rates}${IMP.error ? `<div class="err">${h(IMP.error)}</div>` : ''}
      <div class="imp-btns"><button class="btn" data-act="imp-discard" ${saving ? 'disabled' : ''}>${tr('放弃', 'Discard')}</button>
        <button class="btn primary" id="imp-go" data-act="imp-go" ${st.ready && !saving ? '' : 'disabled'}>${saving ? tr(`正在导入 ${IMP.saveDone} / ${IMP.saveTotal}`, `Importing ${IMP.saveDone} / ${IMP.saveTotal}`) : tr(`导入 ${st.selected.length} 笔`, `Import ${st.selected.length}`)}</button></div></div>
    ${impDetailView()}`;
}

/**
 * AI 识别账单时的进度（和手机端 AiProgress 一样）：一个会动的圆环，中间百分比，下面"已分析 n 条记录"。
 * 分段识别时按段数走；每段里面（以及只有一段时）按时间慢慢往前挪，越来越慢、停在九成，识别完一段就跳上去。
 * 圆环由 impRingTick 每一帧更新（整页重画时接着画，不会从 0 开始）。
 */
function impLoadingView() {
  const p = IMP.ringP ?? 0, seg = IMP.finished ? tr('即将为您列出', 'Opening the list…') : IMP.total > 1 ? tr(`已完成 ${Math.min(IMP.done, IMP.total)} / ${IMP.total} 段`, `${Math.min(IMP.done, IMP.total)} of ${IMP.total} parts done`) : tr('AI 正在识别账单…', 'AI is reading your bill…');
  setTimeout(impRingTick, 0);
  return `<div class="imp-load"><div class="imp-ring"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="trk" cx="60" cy="60" r="52"/><circle class="arc" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="${(p * 100).toFixed(2)} 100"/><circle class="tip" cx="60" cy="8" r="4"/></svg>${impRingPlanet()}</div>
    <b class="num imp-pct">${Math.floor(p * 100)}%</b><b class="imp-found">${IMP.finished ? tr('识别完成，共 ', 'Done: ') : tr('已识别 ', 'Read ')}<span class="num imp-n">${impOdoHtml(IMP.shown ?? IMP.found)}</span>${tr(' 笔', ' records')}</b><div class="muted small">${seg}</div></div>`;
}
/** 里程表式的数字：每一位是一个只露一格的窗口。 */
const impOdoHtml = (v) => [...String(v)].map((d) => `<span class="odo-d"><span class="odo-s"><i>${d}</i></span></span>`).join('');
/**
 * 从 from 变成 to：变了的位往上滚一格（1→2；19→20 时十位 1→2、个位 9→0 同时滚），没变的不动；多出来的最高位从空白滚出来。
 * ms 是滚动用时（比下一次变化的间隔短一点，滚完再变）。
 */
function impOdoSet(el, from, to, ms) {
  const a = String(from), b = String(to), n = Math.max(a.length, b.length), pa = a.padStart(n, ' '), pb = b.padStart(n, ' ');
  el.style.setProperty('--odo-t', `${ms}ms`);
  el.innerHTML = [...pb].map((d, i) => {
    if (d === ' ') return '';
    const o = pa[i];
    return o === d ? `<span class="odo-d"><span class="odo-s"><i>${d}</i></span></span>`
      : `<span class="odo-d"><span class="odo-s roll"><i>${o === ' ' ? '&nbsp;' : o}</i><i>${d}</i></span></span>`;
  }).join('');
}

/** 断网停下了：已经识别出几条、完成几段，点"继续识别"接着跑剩下的。 */
function impPausedView() {
  const run = IMP.run, n = run?.found.length ?? 0, done = run?.done ?? 0, total = done + (run?.jobs.length ?? 0);
  return `<div class="imp-load imp-pause"><div class="imp-pause-pl">${impRingPlanet()}</div>
    <b class="imp-found">${tr(`已识别 ${n} 笔`, `${n} records read`)}</b>
    <div class="muted small">${tr(`完成 ${done} / ${total} 段`, `${done} of ${total} parts done`)} · ${h(IMP.error)}</div>
    <button class="btn primary imp-cont" data-act="imp-continue">${tr('继续识别', 'Continue')}</button>
    <button class="btn link" data-act="imp-discard">${tr('放弃', 'Discard')}</button></div>`;
}
/** 圆环中间：这个月的主题行星（和手机端一样）。 */
function impRingPlanet() {
  const d = new Date();
  return typeof plOfMonth === 'function' && typeof planetSvg === 'function' ? planetSvg(plOfMonth(d.getFullYear(), d.getMonth() + 1), { px: 96, cls: 'imp-planet' }) : '';
}
let impRingRaf = 0;
function impRingTick() {
  if (impRingRaf) return;
  const step = () => {
    const ring = document.querySelector('.imp-ring');
    if (!ring || IMP.phase !== 'loading') { impRingRaf = 0; if (IMP.phase !== 'loading') { IMP.ringP = 0; IMP.ringDone = null; } return; }
    const now = performance.now();
    if (IMP.ringDone !== IMP.done) { IMP.ringDone = IMP.done; IMP.segAt = now; }
    const segs = Math.max(1, IMP.total), creep = 0.9 * (1 - Math.exp(-(now - (IMP.segAt ?? now)) / 1000 / 18));
    // 正在识别的段：按已写完的行数走（表格账单知道一共几行），不知道行数的按时间慢慢挪
    const target = IMP.finished ? 1 : Math.min(0.99, (Math.min(IMP.done, segs) + Math.max(creep, IMP.part ?? 0)) / segs);
    const p = IMP.ringP = (IMP.ringP ?? 0) + (target - (IMP.ringP ?? 0)) * (IMP.finished ? 0.16 : 0.08);
    ring.querySelector('.arc').setAttribute('stroke-dasharray', `${(p * 100).toFixed(2)} 100`);
    const a = (-90 + 360 * p) * Math.PI / 180, tip = ring.querySelector('.tip');
    tip.setAttribute('cx', (60 + 52 * Math.cos(a)).toFixed(2)); tip.setAttribute('cy', (60 + 52 * Math.sin(a)).toFixed(2));
    const pct = document.querySelector('.imp-pct'); if (pct) pct.textContent = `${Math.floor(p * 100)}%`;
    // "已识别 n 笔"：一笔一笔往上加，变了的那几位各自往上滚（差得多时加得快些）
    const shown = IMP.shown ?? IMP.found, gap = IMP.found - shown, wait = Math.abs(gap) > 12 ? 80 : 190;
    if (gap && now - (IMP.bumpAt ?? 0) > wait) {
      IMP.shown = shown + (gap > 0 ? Math.max(1, Math.floor(gap / 8)) : gap);
      IMP.bumpAt = now;
      const el = document.querySelector('.imp-n');
      if (el) impOdoSet(el, shown, IMP.shown, wait - 20);
    }
    impRingRaf = requestAnimationFrame(step);
  };
  impRingRaf = requestAnimationFrame(step);
}

function impPickView() {
  const canPaste = !!navigator.clipboard?.read;
  const inc = IMP.incoming;
  return `${IMP.error ? `<div class="card"><div class="err" style="font-size:15px">${h(IMP.error)}</div></div>` : ''}
    ${inc ? `<div class="card imp-inc">${iconTile('document', 'imp-tile38')}<div class="imp-inc-t"><b>${tr('已收到账单文件', 'Received a statement')}</b><span class="muted small">${h(inc.name)}</span></div>
      <button class="btn primary" data-act="imp-inc-go">${tr('开始识别', 'Read it')}</button><button class="ed-x" data-act="imp-inc-x" aria-label="${tr('放弃', 'Discard')}">✕</button></div>` : ''}
    <div class="card">
      <div class="imp-head">${iconTile('sparkle', 'imp-tile38')}<span>${tr('截图和银行账单', 'Screenshots and bank statements')}</span></div>
      ${aiKey() ? '' : `<div class="imp-key"><span class="err" style="font-size:14px">${tr('需要 API 密钥，当前尚未填写。', 'This needs an API key, and none is set yet.')}</span><button class="btn link" data-act="ak-open" data-v="import">${tr('前往设置密钥', 'Set the key')}</button></div>`}
      <label class="btn primary imp-pick">${tr('选择截图（可多选）', 'Choose screenshots')}<input type="file" data-imp="pick" accept="image/*" multiple hidden></label>
      ${canPaste ? `<button class="btn imp-pick" data-act="imp-paste">${tr('粘贴截图', 'Paste screenshot')}</button>` : ''}
      <div class="muted small imp-note">${tr(`文件将发送至 ${AI_PROVIDERS[aiProvider()].name} 识别。`, `Files are sent to ${AI_PROVIDERS[aiProvider()].name}.`)}</div>
    </div>
    <div class="card">
      <div class="imp-head">${iconTile('document', 'imp-tile38')}<span>${tr('账单文件', 'Statement files')}</span></div>
      <label class="btn imp-pick">${tr('选择文件（Excel / PDF / CSV / ZIP）', 'Choose file (Excel / PDF / CSV / ZIP)')}<input type="file" data-imp="files" accept="${IMP_FILE_ACCEPT}" multiple hidden></label>
      <button class="btn link imp-gd-open" data-act="imp-guide">${tr('iPhone 如何导入微信账单？', 'Importing WeChat bills on iPhone')}</button>
    </div>${IMP.guide ? impGuideView() : ''}`;
}

/** iPhone 导入微信账单：四步说明 +（发布了的话）添加快捷指令。 */
function impGuideView() {
  const step = (n, title, path) => `<li><i>${n}</i><div><b>${title}</b><span>${path.map(h).join('<em>›</em>')}</span></div></li>`;
  return `<div class="modal imp-gd-bg" data-act="imp-guide-x"><div class="card imp-gd" data-act="imp-noop">
    <div class="between"><b class="imp-gd-h">${tr('iPhone 导入微信账单', 'WeChat bills on iPhone')}</b><button class="ed-x" data-act="imp-guide-x" aria-label="${tr('关闭', 'Close')}">✕</button></div>
    <ol class="imp-steps">
      ${step(1, tr('微信导出账单', 'Export in WeChat'), [tr('我', 'Me'), tr('服务', 'Services'), tr('钱包', 'Wallet'), tr('账单', 'Bills'), tr('常见问题', 'FAQ'), tr('下载账单', 'Download')])}
      ${step(2, tr('存到「文件」', 'Save to Files'), [tr('打开收到的 zip', 'Open the zip'), tr('分享', 'Share'), tr('存储到「文件」', 'Save to Files')])}
      ${step(3, tr('返回此处选择文件', 'Pick it here'), [tr('记一笔', 'Add'), tr('文件', 'File'), tr('最近使用', 'Recents')])}
      ${step(4, tr('请输入解压密码', 'Enter the password'), [tr('微信支付消息中的 6 位数字', 'From the WeChat Pay message')])}
    </ol>
    ${IMP_SHORTCUT_URL ? `<div class="imp-gd-sc"><div><b>${tr('更快：快捷指令', 'Faster: a Shortcut')}</b><span class="muted small">${tr('安装一次，之后在账单上点击 分享 › 导入行星记账', 'Install once, then Share › Planet Ledger import')}</span></div>
      <button class="btn primary" data-act="imp-sc">${tr('前往设置', 'Set up')}</button></div>` : ''}
  </div></div>`;
}

function importView() {
  const bar = `<div class="subbar"><button class="round" data-act="tab" data-v="me" aria-label="${tr('返回', 'Back')}">‹</button><b>${IMP.phase === 'loading' ? tr('AI 识别', 'AI import') : tr('导入账单', 'Import')}</b></div>`;
  const body = IMP.phase === 'loading' ? impLoadingView() : IMP.phase === 'paused' ? impPausedView() : IMP.phase === 'review' || IMP.phase === 'saving' ? impReviewView() : impPickView();
  return `${bar}<div class="imp-page">${body}</div>`;
}

MOD.pages.import = () => importView();

// ---------------------------------------------------------------- iPhone 快捷导入（设置里的页面；使用向导里也用这一套）

const scStep = (n, title, path) => `<li><i>${n}</i><div><b>${title}</b><span>${path.map(h).join('<em>›</em>')}</span></div></li>`;
/** 三步：添加 → 在账单上分享 → 开始识别。 */
function scSteps() {
  return `<ol class="imp-steps">
    ${scStep(1, tr('添加快捷指令', 'Add the Shortcut'), [tr('点击下方按钮', 'Tap the button below'), tr('添加快捷指令', 'Add Shortcut')])}
    ${scStep(2, tr('在账单上点击「分享」', 'Share a statement'), [tr('在微信、邮件或「文件」中打开账单', 'Open it in WeChat, Mail or Files'), tr('分享', 'Share'), tr('导入行星记账', 'Planet Ledger import')])}
    ${scStep(3, tr('开始识别', 'Read it'), [tr('自动打开网页版', 'The web app opens'), tr('开始识别', 'Read it')])}
  </ol>`;
}
/** 添加按钮：iCloud 链接，在新窗口打开（主屏幕上的网页 App 里也不会把自己关掉）。 */
const scButton = () => `<a class="btn primary sc-add" href="${IMP_SHORTCUT_URL}" target="_blank" rel="noopener">${hmSvg(ICONS.plus.d)}${tr('添加快捷指令', 'Add Shortcut')}</a>`;
const scTips = () => `<ul class="sc-tips muted small">
    <li>${tr('首次将询问是否打开网页：请点击「允许」', 'First time it asks to open the page: tap Allow')}</li>
    <li>${tr('分享菜单中未找到：请滑至底部，点击「编辑操作」添加', 'Not in the Share menu? Scroll down › Edit Actions')}</li>
    <li>${tr('将以 Safari 打开：需在 Safari 中登录', 'It opens in Safari: sign in there too')}</li></ul>`;

function scView() {
  return `<div class="subbar"><button class="round" data-act="tab" data-v="settings" aria-label="${tr('返回', 'Back')}">‹</button><b>${tr('iPhone 快捷导入', 'iPhone quick import')}</b></div>
    <div class="grid sc-page">
      <div class="card sc-hero">${iconTile('bolt')}<div><b>${tr('账单一键导入', 'One-tap statement import')}</b><span class="muted small">${tr('支持各银行、微信、支付宝账单（PDF、CSV、Excel、zip）', 'Bank, WeChat and Alipay statements (PDF, CSV, Excel, zip)')}</span></div></div>
      <div class="card grid">${scSteps()}${scButton()}</div>
      <div class="card">${scTips()}</div>
    </div>`;
}
MOD.pages.shortcut = () => scView();

// ---------------------------------------------------------------- 点击、选择、输入

MOD.actions.push(async (act, v, el) => {
  if (!act.startsWith('imp-')) return false;
  const i = Number(v), d = IMP.drafts[i];
  if (IMP.phase === 'saving' && act !== 'imp-detail-x') return true;
  switch (act) {
    case 'imp-all': { const target = !IMP.drafts.every((x) => x.selected); IMP.drafts.forEach((x) => { x.selected = target; }); break; }
    case 'imp-flip':
      // 点金额切换收入/支出；换了类型后原分类不再适用
      if (d && d.tx.kind !== KIND.TRANSFER) { const kind = d.tx.kind === KIND.INCOME ? KIND.EXPENSE : KIND.INCOME; d.tx = { ...d.tx, kind, category: impOther(kind === KIND.INCOME), sub: '' }; }
      break;
    case 'imp-merge': if (d) d.merge = !d.merge; break;
    case 'imp-detail': IMP.detail = i; IMP.detailErr = ''; IMP.detailForm = null; break;
    case 'imp-detail-x': if (el.classList.contains('modal') && lastClickTarget !== el) return true; IMP.detail = -1; IMP.detailErr = ''; IMP.detailForm = null; break;
    case 'imp-detail-ok': {
      const cur = IMP.drafts[IMP.detail];
      if (!cur) break;
      const val = (id) => document.getElementById(id)?.value ?? '';
      const form = { date: val('imp-d-date'), amt: val('imp-d-amt'), note: val('imp-d-note') };
      const date = impDay(form.date), cents = parseCents(form.amt);
      // 填错了：留着刚填的内容，只提示哪里不对
      if (date == null || cents == null) { IMP.detailForm = form; IMP.detailErr = date == null ? tr('日期无效', 'Invalid date') : tr('金额不正确', 'Invalid amount'); break; }
      cur.tx = { ...cur.tx, date, amountCents: cents, note: form.note.trim() };
      IMP.detail = -1; IMP.detailErr = ''; IMP.detailForm = null;
      break;
    }
    case 'imp-discard': impReset(); break;
    case 'imp-continue': await impGo(); return true;
    case 'imp-go': await impImport(); return true;
    case 'imp-paste': await impPaste(); return true;
    case 'imp-guide': IMP.guide = true; break;
    case 'imp-guide-x': IMP.guide = false; break;
    case 'imp-sc': IMP.guide = false; state.tab = 'shortcut'; scrollTo(0, 0); break;
    case 'imp-noop': return true;
    case 'imp-inc-x': IMP.incoming = null; IMP.autoStarted = false; impTaskClear(); impNext(); break;
    case 'imp-inc-go': { if (IMP.incoming) await impStart([IMP.incoming]); return true; }
    default: return true;
  }
  render();
  return true;
});

MOD.changes.push(async (ev) => {
  const t = ev.target, k = t.dataset?.imp;
  if (!k) return false;
  if (k === 'pick' || k === 'files') {
    const files = [...(t.files ?? [])];
    t.value = '';
    // 截图一次最多 10 张（和手机端的相册选择器一样）
    await impStart(k === 'pick' ? files.slice(0, 10) : files);
    return true;
  }
  // 汇率框不重画：输入时已经更新过按钮；离开输入框时重画会吞掉紧接着的那一下点击
  if (k === 'rate') { IMP.rates[t.dataset.c] = t.value; return true; }
  if (k === 'acct') { IMP.account = Number(t.value); render(); return true; }
  const d = IMP.drafts[Number(t.dataset.i)];
  if (!d || IMP.phase !== 'review') return true;
  if (k === 'sel') d.selected = t.checked;
  else if (k === 'cat' && t.value) d.tx = { ...d.tx, category: t.value, sub: '' };
  else if ((k === 'from' || k === 'acc') && t.value) d.tx = { ...d.tx, account: t.value };
  else if (k === 'to' && t.value) d.tx = { ...d.tx, toAccount: t.value };
  render();
  return true;
});

// 汇率边打字边算"导入"按钮能不能点（不重画，免得键盘收起来）
document.addEventListener('input', (ev) => {
  if (ev.target.dataset?.imp !== 'rate') return;
  IMP.rates[ev.target.dataset.c] = ev.target.value;
  const go = document.getElementById('imp-go');
  if (go && IMP.phase === 'review') go.disabled = !impStatus().ready;
});

// 详情行用键盘也能打开
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.dataset?.act === 'imp-detail') { ev.preventDefault(); ev.target.click(); }
});

// 在导入页直接粘贴截图（电脑上 Ctrl/⌘+V，iPhone 上长按"粘贴"）
document.addEventListener('paste', (ev) => {
  if (state.tab !== 'import' || IMP.phase !== 'idle' || /^(INPUT|TEXTAREA)$/.test(ev.target?.tagName ?? '')) return;
  const files = [...(ev.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  ev.preventDefault();
  impStart(files.slice(0, 10));
});
