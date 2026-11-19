// 自动记账（定期账单）：和手机端 Schedules.kt 同一套规则、同一份数据（共享设置 schedules）。
// 每一期账单的 id 由"哪条规则、哪一天"算出来（occurrenceId），手机和网页都记了同一期，云端也只有一笔。
'use strict';

const schedFreqs = () => [['week', 1, tr('每周', 'Weekly')], ['week', 2, tr('每两周', 'Every 2 weeks')], ['month', 1, tr('每月', 'Monthly')], ['month', 3, tr('每季度', 'Quarterly')], ['year', 1, tr('每年', 'Yearly')]];

/** 和手机端 Schedule.of 一样补默认值。 */
function schedOf(o) {
  const n = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
  return {
    id: n(o.id), name: String(o.name ?? ''), kind: n(o.kind), cents: n(o.cents), categoryId: n(o.categoryId), accountId: n(o.accountId), toAccountId: n(o.toAccountId),
    unit: o.unit || 'month', every: Math.max(1, n(o.every, 1)), next: n(o.next), anchor: n(o.anchor, 1), paused: !!o.paused, ledgerId: n(o.ledgerId, 1),
  };
}
/** 存回去的格式和手机端 Schedule.json() 一样（字段和顺序都一样）。 */
const schedJson = (s) => ({ id: s.id, name: s.name, kind: s.kind, cents: s.cents, categoryId: s.categoryId, accountId: s.accountId, toAccountId: s.toAccountId,
  unit: s.unit, every: s.every, next: s.next, anchor: s.anchor, paused: s.paused, ledgerId: s.ledgerId });
const schedList = () => { const v = shared.get('schedules', []); return Array.isArray(v) ? v.map(schedOf) : []; };
const schedSave = (list) => shared.set('schedules', list.map(schedJson));

/** 一期账单的 id：1e14 + (规则 id 取后 9 位) × 1e5 + 日期，和手机端 Schedules.occurrenceId 完全一样。 */
function occurrenceId(scheduleId, day) { return 1e14 + (((scheduleId % 1e9) + 1e9) % 1e9) * 1e5 + day; }

/** 下一期是哪天（和手机端 Schedule.after 一样：31 号的在小月里记月底，下个月回到 31 号）。 */
function schedAfter(s, day) {
  const d = dayToDate(day), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dd = d.getUTCDate();
  const len = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  if (s.unit === 'week') return day + 7 * s.every;
  if (s.unit === 'year') { const ny = y + s.every; return epochDay(ny, m, Math.min(dd, len(ny, m))); }
  const t = new Date(Date.UTC(y, m - 1 + s.every, 1)), ny = t.getUTCFullYear(), nm = t.getUTCMonth() + 1;
  return epochDay(ny, nm, Math.min(Math.min(Math.max(s.anchor, 1), 31), len(ny, nm)));
}
function schedLabel(s) {
  if (s.unit === 'week') return s.every === 1 ? tr('每周', 'Weekly') : s.every === 2 ? tr('每两周', 'Every 2 weeks') : tr(`每 ${s.every} 周`, `Every ${s.every} weeks`);
  if (s.unit === 'year') return tr('每年', 'Yearly');
  return s.every === 1 ? tr('每月', 'Monthly') : s.every === 3 ? tr('每季度', 'Quarterly') : tr(`每 ${s.every} 个月`, `Every ${s.every} months`);
}

/** 把到期的都记上（落下几期补几期）；已有同一 id 的账单就跳过。返回新记了几笔。 */
async function runSchedules() {
  if (runSchedules.busy || !state.session) return 0;
  runSchedules.busy = true;
  let made = 0;
  try {
    const now = today(), list = schedList();
    let changed = false;
    for (const s of list) {
      const account = state.data.account.get(s.accountId);
      // 账户没了就先停着，不乱记
      if (s.paused || !account || s.cents <= 0) continue;
      const cur = acctCur(account), foreign = cur !== HOME, transfer = s.kind === KIND.TRANSFER;
      let guard = 0;
      while (s.next <= now && guard++ < 60) {
        const id = occurrenceId(s.id, s.next);
        if (!state.data.tx.has(id)) {
          await saveRecord('tx', {
            id, amountCents: foreign ? convert(s.cents, cur, HOME) ?? s.cents : s.cents, kind: s.kind, categoryId: transfer ? 0 : s.categoryId,
            accountId: s.accountId, toAccountId: transfer ? s.toAccountId : 0, ledgerId: s.ledgerId, date: s.next, note: s.name, tags: '', reimburse: 0,
            createdAt: Date.now(), currency: foreign ? cur : '', origCents: foreign ? s.cents : 0, excluded: false, offsetOf: 0, offsetParts: '', project: '', fund: '', loanPerson: '', loanSide: 0,
          });
          made++;
        }
        s.next = schedAfter(s, s.next);
        changed = true;
      }
    }
    if (changed) await schedSave(list);
  } finally { runSchedules.busy = false; }
  return made;
}
MOD.onLoad.push(async () => { await runSchedules(); });

// ---------------------------------------------------------------- 页面

function schedView() {
  const list = schedList().sort((a, b) => a.next - b.next), acc = state.data.account, cat = state.data.category;
  const rows = list.map((s) => {
    const a = acc.get(s.accountId), c = cat.get(s.categoryId);
    const sub = s.paused ? `<span class="amber">${tr('已暂停', 'Paused')}</span>` : `${schedLabel(s)} · ${tr('下次', 'Next')} ${dayISO(s.next)} · ${h(a?.name ?? '?')}`;
    const lead = s.kind === KIND.TRANSFER ? accountTile(acc.get(s.toAccountId)) : iconTile(c?.icon ?? 'calendar');
    return `<div class="row click" data-act="sc-edit" data-v="${s.id}">${lead}
      <div class="main"><div class="title">${h(s.name)}</div><div class="sub">${sub}</div></div>
      <div class="right"><div class="num ${s.kind === KIND.INCOME ? 'in' : ''}">${money(s.cents, a ? acctCur(a) : HOME)}</div>
        <button class="btn link small sc-pause" data-act="sc-pause" data-v="${s.id}">${s.paused ? tr('恢复', 'Resume') : tr('暂停', 'Pause')}</button></div></div>`;
  }).join('');
  const monthly = list.filter((s) => !s.paused && s.kind === KIND.EXPENSE).reduce((sum, s) => {
    const a = acc.get(s.accountId), home = a ? convert(s.cents, acctCur(a), HOME) ?? s.cents : s.cents;
    return sum + Math.round(home * (s.unit === 'week' ? 52 / 12 / s.every : s.unit === 'year' ? 1 / 12 / s.every : 1 / s.every));
  }, 0);
  return `<div class="cols">
    <div class="card cc sticky"><div class="muted small">${tr('自动记账', 'Recurring')}</div><div class="big num">${money(monthly)}</div><div class="muted small">${tr(`每月支出约 · ${list.filter((s) => !s.paused).length} 项进行中`, `Approx. monthly spend · ${list.filter((s) => !s.paused).length} active`)}</div>
      <div style="margin-top:12px"><button class="pill" data-act="sc-new">${tr('＋ 新建', '＋ New')}</button></div></div>
    <div class="card">${rows || `<span class="muted">${tr('房租、订阅这类，到期自动记', 'Rent, subscriptions… logged when due')}</span>`}</div>
  </div>${state.schedEdit ? schedDialog() : ''}`;
}

function schedDialog() {
  const e = state.schedEdit, accounts = [...state.data.account.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const usable = accounts.filter((a) => !a.archived || a.id === e.accountId || a.id === e.toAccountId);
  const account = state.data.account.get(e.accountId);
  const cats = [...state.data.category.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const tops = cats.filter((c) => !c.parentId && !!c.isIncome === (e.kind === KIND.INCOME));
  const catOpts = tops.map((t) => [t, ...cats.filter((c) => c.parentId === t.id)].map((c) => `<option value="${c.id}" ${c.id === e.categoryId ? 'selected' : ''}>${c.parentId ? '　· ' : ''}${h(c.name)}</option>`).join('')).join('');
  const accOpts = (sel, skip) => `<option value="0">${tr('选择账户', 'Choose account')}</option>` + usable.filter((a) => a.id !== skip).map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${h(a.name)}</option>`).join('');
  const base = schedFreqs(), freqs = base.some(([u, n]) => u === e.unit && n === e.every) ? base : [...base, [e.unit, e.every, schedLabel(e)]];
  const transfer = e.kind === KIND.TRANSFER;
  return `<div class="modal" data-bg="sc"><div class="card grid" role="dialog" aria-label="${tr('自动记账', 'Recurring')}">
    <div class="between"><b style="font-size:18px">${e._isNew ? tr('新建自动记账', 'New recurring') : tr('自动记账', 'Recurring')}</b>${e._isNew ? '' : `<button class="btn link danger" data-act="sc-delete">${tr('删除', 'Delete')}</button>`}</div>
    ${seg('sc-kind', [[0, tr('支出', 'Expense')], [1, tr('收入', 'Income')], [2, tr('转账', 'Transfer')]], e.kind)}
    <label class="f">${tr('名称', 'Name')}<input id="sc-name" value="${h(e.name)}" placeholder="${tr('如 房租', 'e.g. Rent')}"></label>
    <label class="f">${tr(`金额（${account ? acctCur(account) : HOME}）`, `Amount (${account ? acctCur(account) : HOME})`)}<input id="sc-amount" inputmode="decimal" value="${h(e._amount)}" placeholder="0.00"></label>
    ${transfer ? '' : `<label class="f">${tr('分类', 'Category')}<select id="sc-cat"><option value="0">${tr('选择分类', 'Choose category')}</option>${catOpts}</select></label>`}
    ${transfer ? `<div class="two"><label class="f">${tr('转出账户', 'From')}<select id="sc-account">${accOpts(e.accountId)}</select></label>
      <label class="f">${tr('转入账户', 'To')}<select id="sc-to">${accOpts(e.toAccountId, e.accountId)}</select></label></div>` : `<label class="f">${tr('账户', 'Account')}<select id="sc-account">${accOpts(e.accountId)}</select></label>`}
    <div class="two"><label class="f">${tr('频率', 'Frequency')}<select id="sc-freq">${freqs.map(([u, n, l]) => `<option value="${u}:${n}" ${u === e.unit && n === e.every ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f">${tr('下次', 'Next')}<input id="sc-next" type="date" value="${dayISO(e.next)}"></label></div>
    <label class="sc-check"><input type="checkbox" id="sc-paused" ${e.paused ? 'checked' : ''}> ${tr('暂停', 'Paused')}</label>
    ${state.schedError ? `<p class="err">${h(state.schedError)}</p>` : ''}
    <div class="between"><button class="btn" data-act="sc-cancel">${tr('取消', 'Cancel')}</button><button class="btn primary" data-act="sc-save">${tr('保存', 'Save')}</button></div>
  </div></div>`;
}

/** 表单里的内容收回 state.schedEdit（切换类型、换账户会重画）。 */
function schedCollect() {
  const e = state.schedEdit, v = (id) => document.getElementById(id);
  if (!e) return;
  if (v('sc-name')) e.name = v('sc-name').value;
  if (v('sc-amount')) e._amount = v('sc-amount').value;
  if (v('sc-cat')) e.categoryId = Number(v('sc-cat').value);
  if (v('sc-account')) e.accountId = Number(v('sc-account').value);
  if (v('sc-to')) e.toAccountId = Number(v('sc-to').value);
  if (v('sc-freq')) { const [u, n] = v('sc-freq').value.split(':'); e.unit = u; e.every = Number(n); }
  if (v('sc-next')?.value) e.next = isoToDay(v('sc-next').value);
  if (v('sc-paused')) e.paused = v('sc-paused').checked;
}

async function schedSaveEditing() {
  schedCollect();
  const e = state.schedEdit, cents = parseCents(e._amount), cat = state.data.category.get(e.categoryId), transfer = e.kind === KIND.TRANSFER;
  const err = !e.name.trim() ? tr('请填名称', 'Enter a name') : cents == null ? tr('请填金额', 'Enter an amount') : !state.data.account.has(e.accountId) ? tr('请选账户', 'Choose an account')
    : transfer ? (!state.data.account.has(e.toAccountId) || e.toAccountId === e.accountId ? tr('请选转入账户', 'Choose the "To" account') : '')
    : !cat || !!cat.isIncome !== (e.kind === KIND.INCOME) ? tr('请选分类', 'Choose a category') : '';
  if (err) { state.schedError = err; return; }
  const s = schedOf({ ...e, name: e.name.trim(), cents, categoryId: transfer ? 0 : e.categoryId, toAccountId: transfer ? e.toAccountId : 0, anchor: dayToDate(e.next).getUTCDate() });
  await schedSave([...schedList().filter((x) => x.id !== s.id), s]);
  state.schedEdit = null; state.schedError = '';
  await runSchedules();
}

MOD.pages.schedules = () => schedView();
MOD.me.push({ key: 'schedules', get name() { return tr('自动记账', 'Recurring'); }, icon: 'calendar', order: 30 });

MOD.actions.push(async (act, v) => {
  if (!act.startsWith('sc-')) return false;
  try {
    switch (act) {
      case 'sc-new': {
        const d = new Date();
        state.schedEdit = { ...schedOf({ id: Date.now(), next: today(), anchor: d.getDate(), ledgerId: state.ledgerId }), _amount: '', _isNew: true };
        state.schedError = '';
        break;
      }
      case 'sc-edit': { const s = schedList().find((x) => x.id === Number(v)); if (s) { state.schedEdit = { ...s, _amount: (s.cents / 100).toFixed(2), _isNew: false }; state.schedError = ''; } break; }
      case 'sc-kind': schedCollect(); state.schedEdit.kind = Number(v); state.schedEdit.categoryId = 0; break;
      case 'sc-cancel': state.schedEdit = null; state.schedError = ''; break;
      case 'sc-save': await schedSaveEditing(); break;
      case 'sc-delete': {
        const e = state.schedEdit;
        if (!confirm(tr(`删除「${e.name}」？已记的账单不会删。`, `Delete "${e.name}"? Past entries are kept.`))) return true;
        await schedSave(schedList().filter((x) => x.id !== e.id)); state.schedEdit = null;
        break;
      }
      case 'sc-pause': {
        const list = schedList(), s = list.find((x) => x.id === Number(v));
        if (s) { s.paused = !s.paused; await schedSave(list); if (!s.paused) await runSchedules(); }
        break;
      }
      default: return false;
    }
  } catch (e) { if (state.schedEdit) state.schedError = e.message; else state.error = e.message; }
  render();
  return true;
});
MOD.changes.push(async (ev) => {
  // 换了账户：金额的币种、转入账户的选项跟着变
  if (!state.schedEdit || (ev.target.id !== 'sc-account' && ev.target.id !== 'sc-to')) return false;
  schedCollect(); render(); return true;
});
// 点弹窗外面关掉
document.addEventListener('click', (ev) => {
  if (ev.target?.dataset?.bg !== 'sc') return;
  state.schedEdit = null; state.schedError = ''; render();
});
