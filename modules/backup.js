// 备份与恢复：文件格式和手机端 Sync.dump() 一样（账单、分类、账户、账本；共享设置不在里面），两边的备份可以互相恢复。
// 网页没法每天自动备份，只能手动下载；恢复 = 把云端的这四类数据整体换成备份里的样子。
'use strict';

/** 和手机端 Sync.kt 里 json(...) 一样的字段、顺序和默认值。 */
const HL_JSON = {
  tx: (o) => ({
    id: Number(o.id), amountCents: Number(o.amountCents) || 0, kind: Number(o.kind) || 0, categoryId: Number(o.categoryId) || 0, accountId: Number(o.accountId) || 0,
    toAccountId: Number(o.toAccountId) || 0, ledgerId: o.ledgerId == null ? 1 : Number(o.ledgerId) || 0, date: Number(o.date) || 0, note: String(o.note ?? ''), tags: String(o.tags ?? ''),
    reimburse: Number(o.reimburse) || 0, createdAt: Number(o.createdAt) || 0, currency: String(o.currency ?? ''), origCents: Number(o.origCents) || 0, excluded: !!o.excluded,
    offsetOf: Number(o.offsetOf) || 0, offsetParts: String(o.offsetParts ?? ''), project: String(o.project ?? ''), fund: String(o.fund ?? ''), loanPerson: String(o.loanPerson ?? ''), loanSide: Number(o.loanSide) || 0,
  }),
  category: (o) => ({ id: Number(o.id), name: String(o.name ?? ''), icon: o.icon || 'tag', isIncome: !!o.isIncome, sortOrder: Number(o.sortOrder) || 0, parentId: Number(o.parentId) || 0 }),
  account: (o) => ({
    id: Number(o.id), name: String(o.name ?? ''), type: Number(o.type) || 0, initialCents: Number(o.initialCents) || 0, sortOrder: Number(o.sortOrder) || 0,
    currency: String(o.currency ?? ''), archived: !!o.archived, checkedAt: Number(o.checkedAt) || 0,
  }),
  ledger: (o) => ({ id: Number(o.id), name: String(o.name ?? '') }),
};
const BK_KINDS = ['tx', 'category', 'account', 'ledger'];

/** 现在的全部数据打成备份文本（同 Sync.dump）。 */
function bkDump() {
  const o = { app: 'HuiLedger', format: 1, time: Date.now() };
  for (const k of BK_KINDS) o[k] = [...state.data[k].values()].sort((a, b) => a.id - b.id).map(HL_JSON[k]);
  return JSON.stringify(o);
}

/** 读备份文件：不是辉记账本的备份就抛错；返回规范化后的数据和条数（同 Sync.peek）。 */
function bkPeek(text) {
  let o;
  try { o = JSON.parse(text); } catch { o = null; }
  if (!o || o.app !== 'HuiLedger' || !BK_KINDS.every((k) => Array.isArray(o[k]))) throw new Error(tr('不是辉记账本的备份', 'Not a HuiLedger backup'));
  const data = {};
  for (const k of BK_KINDS) {
    data[k] = o[k].map(HL_JSON[k]);
    if (data[k].some((r) => !Number.isSafeInteger(r.id))) throw new Error(tr('备份文件已损坏', 'Backup file is damaged'));
  }
  return { time: Number(o.time) || 0, data, counts: { tx: data.tx.length, account: data.account.length, category: data.category.length, ledger: data.ledger.length } };
}

async function bkDownload() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const name = `HuiLedger-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
  const blob = new Blob([bkDump()], { type: 'application/json' });
  // 装在 iPhone 主屏幕上时，下载链接不好用：走系统分享，存到"文件"
  const file = typeof File === 'function' ? new File([blob], name, { type: 'application/json' }) : null;
  let shared = false;
  if (IS_IOS && file && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); shared = true; } catch (e) { if (e?.name === 'AbortError') return false; }
  }
  if (!shared) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  store.set('hl.backupLast', Date.now());
  return true;
}

/** 用备份整体替换云端的账单、分类、账户、账本：备份里有的写上去，备份里没有的标成已删除。 */
async function bkRestore(peek) {
  const user = state.session.user, inFile = new Set(), rows = [];
  for (const k of BK_KINDS) for (const r of peek.data[k]) { inFile.add(k + ':' + r.id); rows.push({ user_id: user, kind: k, id: r.id, data: r, deleted: false }); }
  // 云端现在有的（必须联网才能恢复）
  for (let from = 0; ; from += 1000) {
    const page = await api('GET', `/rest/v1/records?select=kind,id&deleted=is.false&kind=in.(tx,category,account,ledger)&order=kind.asc,id.asc&offset=${from}&limit=1000`);
    for (const r of page) if (!inFile.has(r.kind + ':' + Number(r.id))) rows.push({ user_id: user, kind: r.kind, id: Number(r.id), data: {}, deleted: true });
    if (page.length < 1000) break;
  }
  // 还没传上去的旧修改作废，免得之后盖掉恢复的数据
  store.set('hl.outbox', outbox.list().filter((r) => !BK_KINDS.includes(r.kind)));
  bkState().total = rows.length; bkState().done = 0; render();
  for (let i = 0; i < rows.length; i += 200) {
    await api('POST', '/rest/v1/records?on_conflict=user_id,kind,id', rows.slice(i, i + 200), { prefer: 'resolution=merge-duplicates,return=minimal' });
    bkState().done = Math.min(rows.length, i + 200); render();
  }
  await loadAll();
}

/** 这个页面的状态（state 在 app.js 里，模块加载时还没有，用到时再建）。 */
const bkState = () => (state.bk ??= { peek: null, busy: false, done: 0, total: 0, error: '', ok: '' });

function bkView() {
  const b = bkState(), last = store.get('hl.backupLast', 0);
  const c = (o) => tr(`${o.tx} 笔账单 · ${o.account} 个账户 · ${o.category} 个分类 · ${o.ledger} 个账本`, `${o.tx} ${o.tx === 1 ? 'entry' : 'entries'} · ${o.account} account${o.account === 1 ? '' : 's'} · ${o.category} ${o.category === 1 ? 'category' : 'categories'} · ${o.ledger} ledger${o.ledger === 1 ? '' : 's'}`);
  const loc = tr('zh-CN', 'en-GB');
  const now = { tx: state.data.tx.size, account: state.data.account.size, category: state.data.category.size, ledger: state.data.ledger.size };
  const peek = b.peek ? `<div class="modal" data-bg="bk"><div class="card grid" role="dialog" aria-label="${tr('恢复备份', 'Restore backup')}">
      <b style="font-size:18px">${tr('恢复备份？', 'Restore backup?')}</b>
      <div class="cell"><div class="muted">${tr('备份', 'Backup')}${b.peek.time ? ' · ' + h(new Date(b.peek.time).toLocaleString(loc, { hour12: false })) : ''}</div><div class="v">${c(b.peek.counts)}</div></div>
      <div class="cell"><div class="muted">${tr('现在', 'Now')}</div><div class="v">${c(now)}</div></div>
      <p class="err" style="margin:0">${tr('云端和所有设备的数据都会换成这个备份', 'Cloud data on all devices will be replaced')}</p>
      ${b.error ? `<p class="err" style="margin:0">${h(b.error)}</p>` : ''}
      <div class="between"><button class="btn" data-act="bk-cancel" ${b.busy ? 'disabled' : ''}>${tr('取消', 'Cancel')}</button>
        <button class="btn primary bk-danger" data-act="bk-restore" ${b.busy ? 'disabled' : ''}>${b.busy ? `${tr('正在恢复', 'Restoring')} ${b.done}/${b.total}` : tr('恢复', 'Restore')}</button></div>
    </div></div>` : '';
  return `<div class="cols">
    <div class="card cc sticky"><div class="muted small">${tr('备份与恢复', 'Backup & restore')}</div><div style="font-size:20px;font-weight:700;margin-top:4px">${last ? tr('上次下载 ', 'Last download ') + new Date(last).toLocaleDateString(loc) : tr('还没下载过', 'Never downloaded')}</div>
      <div class="muted small" style="margin-top:4px">${c(now)}</div></div>
    <div class="grid">
      <div class="card grid"><div class="row" style="padding:0">${iconTile('upload')}<div class="main"><div class="title">${tr('下载备份', 'Download backup')}</div><div class="sub">${tr('手机和网页通用', 'Works on phone and web')}</div></div></div>
        <button class="btn primary" data-act="bk-download">${tr('下载', 'Download')}</button></div>
      <div class="card grid"><div class="row" style="padding:0">${iconTile('document')}<div class="main"><div class="title">${tr('从备份恢复', 'Restore from backup')}</div><div class="sub">${tr('选一个 .json 备份文件', 'Pick a .json backup file')}</div></div></div>
        <label class="btn" style="text-align:center;cursor:pointer">${tr('选择文件', 'Choose file')}<input type="file" id="bk-file" accept=".json,application/json" hidden></label>
        ${b.error && !b.peek ? `<p class="err" style="margin:0">${h(b.error)}</p>` : ''}${b.ok ? `<p class="ok">${h(b.ok)}</p>` : ''}</div>
    </div></div>${peek}`;
}

MOD.pages.backup = () => bkView();
MOD.me.push({ key: 'backup', get name() { return tr('备份与恢复', 'Backup & restore'); }, icon: 'shield', order: 80 });

MOD.actions.push(async (act) => {
  if (!act.startsWith('bk-')) return false;
  const b = bkState();
  switch (act) {
    case 'bk-download': b.error = ''; b.ok = ''; try { if (await bkDownload()) b.ok = tr('已下载', 'Downloaded'); } catch (e) { b.error = e.message; } break;
    case 'bk-cancel': if (b.busy) return true; b.peek = null; b.error = ''; break;
    case 'bk-restore':
      if (b.busy || !b.peek) return true;
      b.busy = true; b.error = ''; render();
      try { await bkRestore(b.peek); b.peek = null; b.ok = tr('已恢复', 'Restored'); } catch (e) { b.error = (isNetworkError(e) ? tr('需要联网才能恢复：', 'Restore needs a connection: ') : tr('没有恢复完，可以再点一次：', 'Restore incomplete, tap again: ')) + e.message; }
      b.busy = false; break;
    default: return false;
  }
  render();
  return true;
});
MOD.changes.push(async (ev) => {
  if (ev.target.id !== 'bk-file') return false;
  const f = ev.target.files?.[0], b = bkState();
  b.error = ''; b.ok = ''; b.peek = null;
  if (f) { try { b.peek = bkPeek(await f.text()); } catch (e) { b.error = e.message; } }
  render();
  return true;
});
document.addEventListener('click', (ev) => {
  if (ev.target?.dataset?.bg !== 'bk' || bkState().busy) return;
  bkState().peek = null; bkState().error = ''; render();
});
