// 拆分：一笔银行流水拆成几笔（各自的金额、日期、分类、备注），合起来仍是银行账单上的那一笔（和 App 一样）。
// 例：一次收到 6000 元，其实是三个月的工资 → 拆成每月 1 号各 2000；花了 100 元，50 买菜、50 日用品。
// 每一笔都记着 splitOf（这一组的编号：拆之前那笔的 id）和 splitDate（银行流水上的日期）；
// 对账、导入查重时整组按一笔算（合计金额、银行日期），整理重复时同一组的不算重复。
'use strict';

const SP = { open: false, view: 0, gid: 0, bankDate: 0, kind: 0, cur: '', total: 0, orig: [], parts: [] };

/** 这一组的所有笔（含它自己），按日期排；没拆过就只有它。 */
function spGroup(t) {
  if (!t) return [];
  if (!(t.splitOf > 0)) return [t];
  return [...state.data.tx.values()].filter((x) => x.splitOf === t.splitOf).sort((a, b) => a.date - b.date || a.id - b.id);
}
const spForeign = (t) => !!(t.currency && t.currency !== HOME && t.origCents > 0);
/** 按账单上的币种算的金额（外币记的按外币拆）。 */
const spUnit = (t) => (spForeign(t) ? t.origCents : t.amountCents);
const spCents = (text) => { const v = Number(String(text ?? '').trim().replace(',', '.')); return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : 0; };

/** 打开拆分页：没拆过的默认分成两笔（各一半）；已拆过的把整组拿出来改。 */
function spOpen(id) {
  const t = state.data.tx.get(id);
  if (!t || t.kind === KIND.TRANSFER) return;
  const g = spGroup(t), cur = spForeign(t) ? t.currency : HOME;
  Object.assign(SP, { open: true, view: id, gid: t.splitOf > 0 ? t.splitOf : t.id, bankDate: t.splitOf > 0 && t.splitDate ? t.splitDate : t.date, kind: t.kind, cur, orig: g, total: g.reduce((s, x) => s + spUnit(x), 0) });
  SP.parts = g.map((x) => ({ id: x.id, cents: spUnit(x), date: dayISO(x.date), categoryId: x.categoryId, note: x.note ?? '' }));
  if (g.length === 1) { SP.parts.push({ id: 0, cents: 0, date: dayISO(t.date), categoryId: t.categoryId, note: '' }); spEven(); }
}
/** 均分：每笔一样多，除不尽的几分钱放在前面几笔。 */
function spEven() {
  const n = SP.parts.length, each = Math.floor(SP.total / n), rest = SP.total - each * n;
  SP.parts.forEach((p, i) => { p.cents = each + (i < rest ? 1 : 0); });
}
const spLeft = () => SP.total - SP.parts.reduce((s, p) => s + p.cents, 0);
const spOk = () => SP.parts.length >= 1 && SP.parts.every((p) => p.cents > 0 && p.date) && spLeft() === 0;

/** 分类下拉：同收支方向的一级分类，子分类缩进。 */
function spCatOptions(sel) {
  const income = SP.kind === KIND.INCOME;
  const cats = [...state.data.category.values()].filter((c) => !!c.isIncome === income).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const name = (c) => (typeof edCatName === 'function' ? edCatName(c) : cn(c));
  return cats.filter((c) => !c.parentId).map((top) => [top, ...cats.filter((c) => c.parentId === top.id)]
    .map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${c.parentId ? '　' : ''}${h(name(c))}</option>`).join('')).join('');
}

function spLeftHtml() {
  const left = spLeft();
  if (SP.parts.some((p) => !(p.cents > 0))) return `<span class="amber">${tr('请填写每一笔的金额', 'Enter an amount for each part')}</span>`;
  return left === 0 ? `<span class="in">${tr('✓ 合计与原金额一致', '✓ Adds up to the original')}</span>`
    : left > 0 ? `<span class="amber">${tr(`还差 ${money(left, SP.cur)} 未分配`, `${money(left, SP.cur)} left to assign`)}</span>`
      : `<span class="out">${tr(`超出 ${money(-left, SP.cur)}`, `${money(-left, SP.cur)} too much`)}</span>`;
}

function spView() {
  const first = state.data.tx.get(SP.view) ?? SP.orig[0], acc = state.data.account.get(first?.accountId);
  const parts = SP.parts.map((p, i) => `<div class="card sp-part">
      <div class="between"><b>${tr(`第 ${i + 1} 笔`, `Part ${i + 1}`)}</b>${SP.parts.length > 1 ? `<button class="ed-x" data-act="sp-del" data-v="${i}" aria-label="${tr('删除这一笔', 'Remove')}">✕</button>` : ''}</div>
      <div class="sp-row"><label class="f">${tr('金额', 'Amount')}<input data-sp="cents" data-i="${i}" inputmode="decimal" autocomplete="off" value="${p.cents ? (p.cents / 100).toFixed(2) : ''}" placeholder="0.00"></label>
        <label class="f">${tr('日期', 'Date')}<input type="date" data-sp="date" data-i="${i}" value="${h(p.date)}"></label></div>
      <label class="f">${tr('分类', 'Category')}<select data-sp="cat" data-i="${i}">${spCatOptions(p.categoryId)}</select></label>
      <label class="f">${tr('备注', 'Note')}<input data-sp="note" data-i="${i}" autocomplete="off" value="${h(p.note)}" placeholder="${tr('选填', 'Optional')}"></label></div>`).join('');
  return `<div class="pg dt sp" role="region" aria-label="${tr('拆分账单', 'Split entry')}">${pgBar(tr('拆分账单', 'Split entry'), { back: ['sp-close'] })}
    <div class="dt-body">
      <div class="card sp-head"><div class="muted small">${tr('银行账单', 'Bank entry')} · ${dayISO(SP.bankDate)}${acc ? ' · ' + h(acc.name) : ''}</div>
        <div class="num sp-total ${SP.kind === KIND.INCOME ? 'in' : 'out'}">${SP.kind === KIND.INCOME ? '+' : '-'}${money(SP.total, SP.cur)}</div>
        <div class="small muted">${tr('拆分后各笔合计须等于原金额', 'Parts must add up to the original amount')}</div></div>
      ${parts}
      <div class="sp-tools"><button class="btn" data-act="sp-add">${tr('＋ 添加一笔', '＋ Add a part')}</button><button class="btn" data-act="sp-even">${tr('均分', 'Split evenly')}</button></div>
    </div>
    <div class="dt-foot"><div class="sp-left small" id="sp-left">${spLeftHtml()}</div><button class="btn primary sp-save" data-act="sp-save" ${spOk() ? '' : 'disabled'}>${tr('保存拆分', 'Save split')}</button></div>
  </div>`;
}

/** 金额输入时不整页重画（光标不丢），只更新底下的合计提示和保存键。 */
function spPaintLeft() {
  const el = document.getElementById('sp-left');
  if (el) el.innerHTML = spLeftHtml();
  const b = document.querySelector('[data-act="sp-save"]');
  if (b) b.disabled = !spOk();
}

async function spSave() {
  if (!spOk()) return;
  const base = SP.orig.find((x) => x.id === SP.gid) ?? SP.orig[0], foreign = SP.cur !== HOME;
  const single = SP.parts.length === 1;
  // 外币：折合主货币的金额按比例分，最后一笔补齐，合计不变
  const homeTotal = SP.orig.reduce((s, x) => s + x.amountCents, 0);
  let homeUsed = 0;
  const rows = SP.parts.map((p, i) => {
    const old = p.id ? state.data.tx.get(p.id) : null, src = old ?? base;
    const home = !foreign ? p.cents : i === SP.parts.length - 1 ? homeTotal - homeUsed : Math.round(homeTotal * p.cents / SP.total);
    homeUsed += home;
    const row = { ...src, id: old ? old.id : newId(), amountCents: home, currency: foreign ? SP.cur : '', origCents: foreign ? p.cents : 0,
      date: isoToDay(p.date), categoryId: p.categoryId, note: p.note.trim(), splitOf: single ? 0 : SP.gid, splitDate: single ? 0 : SP.bankDate };
    // 新拆出来的：抵扣关系、心情评分不带
    if (!old) { Object.assign(row, { createdAt: Date.now() + i, offsetOf: 0, offsetParts: '' }); delete row.mood; delete row.score; }
    return row;
  });
  const keep = new Set(rows.map((r) => r.id)), removed = SP.orig.filter((x) => !keep.has(x.id)), before = SP.orig;
  try {
    for (const r of rows) await saveRecord('tx', r);
    for (const x of removed) await deleteRecord('tx', x.id);
  } catch (e) { state.error = e.message; render(); return; }
  SP.open = false;
  if (!state.data.tx.has(state.view)) state.view = rows[0].id;
  render();
  if (typeof edToast === 'function') edToast(single ? tr('已取消拆分', 'Split removed') : tr(`已拆分为 ${rows.length} 笔`, `Split into ${rows.length}`), async () => {
    const old = new Set(before.map((x) => x.id));
    for (const r of rows) if (!old.has(r.id)) await deleteRecord('tx', r.id);
    for (const x of before) await saveRecord('tx', x);
  });
}

/** 合并为一笔：金额相加，日期回到银行日期，备注取并集，分类用最早那笔的。 */
async function spJoin(id) {
  const t = state.data.tx.get(id), g = spGroup(t);
  if (g.length < 2) return;
  if (!await uiConfirm(tr(`将这 ${g.length} 笔合并为一笔？`, `Join these ${g.length} back into one?`), { ok: tr('合并', 'Join') })) return;
  const base = g.find((x) => x.id === t.splitOf) ?? g[0], rest = g.filter((x) => x.id !== base.id), foreign = spForeign(base);
  const note = typeof edMergeNote === 'function' ? edMergeNote(base, g) : base.note;
  const one = { ...base, amountCents: g.reduce((s, x) => s + x.amountCents, 0), origCents: foreign ? g.reduce((s, x) => s + x.origCents, 0) : 0,
    date: base.splitDate || base.date, note, splitOf: 0, splitDate: 0 };
  try {
    await saveRecord('tx', one);
    for (const x of rest) await deleteRecord('tx', x.id);
  } catch (e) { state.error = e.message; render(); return; }
  state.view = one.id;
  render();
  if (typeof edToast === 'function') edToast(tr('已合并为一笔', 'Joined into one'), async () => { for (const x of g) await saveRecord('tx', x); });
}

/** 详情页里的一块：没拆过是"拆分为多笔"，拆过的列出同组的几笔和"修改拆分 / 合并为一笔"。 */
function spDetailBox(t, L) {
  if (t.kind === KIND.TRANSFER) return '';
  const g = spGroup(t);
  if (g.length < 2) return `<button class="cell sp-go" data-act="sp-open" data-v="${t.id}"><span>${tr('拆分为多笔', 'Split into parts')}</span><span class="muted small">${tr('按月份或分类拆开', 'By month or category')}</span></button>`;
  const cur = spForeign(t) ? t.currency : HOME, total = g.reduce((s, x) => s + spUnit(x), 0);
  return `<div class="cell sp-box"><div class="muted">${tr('同一笔银行账单', 'One bank entry')} · ${dayISO(t.splitDate || t.date)} · ${tr('合计', 'Total')} ${money(total, cur)} · ${tr(`共 ${g.length} 笔`, `${g.length} parts`)}</div>
    ${g.map((x) => (x.id === t.id ? txRow(x, L, true).replace('row click', 'row sp-me').replace('data-act="view"', '') : txRow(x, L, true))).join('')}
    <div class="sp-acts"><button class="btn" data-act="sp-open" data-v="${t.id}">${tr('修改拆分', 'Edit split')}</button><button class="btn" data-act="sp-join" data-v="${t.id}">${tr('合并为一笔', 'Join into one')}</button></div></div>`;
}

MOD.actions.push(async (act, v) => {
  if (!act.startsWith('sp-')) return false;
  switch (act) {
    case 'sp-open': spOpen(Number(v)); scrollTo(0, 0); break;
    case 'sp-close': SP.open = false; break;
    case 'sp-add': SP.parts.push({ id: 0, cents: Math.max(0, spLeft()), date: SP.parts[SP.parts.length - 1]?.date ?? dayISO(SP.bankDate), categoryId: SP.parts[0]?.categoryId ?? 0, note: '' }); break;
    case 'sp-del': SP.parts.splice(Number(v), 1); break;
    case 'sp-even': spEven(); break;
    case 'sp-save': await spSave(); return true;
    case 'sp-join': await spJoin(Number(v)); return true;
    default: return false;
  }
  render();
  return true;
});
// 拆分页的输入：金额、日期、分类、备注直接记下来；金额变了只更新合计提示
document.addEventListener('input', (ev) => {
  const k = ev.target.dataset?.sp, p = k ? SP.parts[Number(ev.target.dataset.i)] : null;
  if (!p) return;
  if (k === 'cents') { p.cents = spCents(ev.target.value); spPaintLeft(); }
  else if (k === 'date') { p.date = ev.target.value; spPaintLeft(); }
  else if (k === 'note') p.note = ev.target.value;
});
document.addEventListener('change', (ev) => {
  const k = ev.target.dataset?.sp, p = k ? SP.parts[Number(ev.target.dataset.i)] : null;
  if (p && k === 'cat') p.categoryId = Number(ev.target.value);
  if (p && k === 'date') { p.date = ev.target.value; spPaintLeft(); }
});
