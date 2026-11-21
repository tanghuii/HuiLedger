// 借款：和手机端 LoanScreen 一样。借出和借入分开看，每个人一张卡——借了多少、还了多少、还剩多少；点进去看每一笔、记还款、设到期日。
// 记法和手机端 LedgerViewModel.addLoan 一样：每一笔都是和"借款"账户之间的转账，账单上带 loanPerson（对方）和 loanSide（1 借出，2 借入）。
//   借出 / 我还钱：从我的账户转进借款账户；收到还款 / 借入：从借款账户转到我的账户。
// 到期日是和手机共享的设置 loanDue = { "对方名字": epochDay }。
'use strict';

const LOAN = {
  side: 1, open: null, loose: false, showDone: false,
  /** 正在记的那一笔：{ person, repay }；person 为空表示新的人。 */
  add: null,
  /** 正在归属的那笔账单 id。 */
  assign: null, assignSide: 1, err: '',
};
const LOAN_AVATARS = ['#D9C9A3', '#E6E59A', '#F2C4CE', '#C4D4F7', '#DCC4EC', '#BFE3D0'];

/** 借款账户：和手机端 loanAccount() 同样的找法。 */
function loanAccount() {
  const all = [...state.data.account.values()];
  return all.find((a) => a.name === '借款') ?? all.find((a) => a.name === '借钱' || a.name.toLowerCase() === 'loans') ?? null;
}
/** 没有借款账户就建一个（储蓄类，和手机端一样）。 */
async function ensureLoanAccount() {
  const found = loanAccount();
  if (found) return found;
  const a = { id: newId(), name: '借款', type: 0, initialCents: 0, sortOrder: state.data.account.size, currency: '', archived: false, checkedAt: 0 };
  await saveRecord('account', a);
  return a;
}
const loanDues = () => { const o = shared.get('loanDue', {}); return o && typeof o === 'object' ? o : {}; };
const loanPeople = () => [...new Set(allTxs().map((t) => (t.loanPerson ?? '').trim()).filter(Boolean))];
/** Java 的 String.hashCode，头像颜色和手机上一样。 */
const javaHash = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = (Math.imul(31, x) + s.charCodeAt(i)) | 0; return x; };

/** 和一个人的往来：total 是本金，back 是已还的（主货币）。 */
function loanOf(person, list, side, acc) {
  const moves = list.map((t) => effect(acc, t));
  const paid = moves.filter((x) => x > 0).reduce((s, x) => s + x, 0), got = -moves.filter((x) => x < 0).reduce((s, x) => s + x, 0);
  const total = side === 1 ? paid : got, back = side === 1 ? got : paid;
  return { person, list, total, back, left: total - back, done: total > 0 && total - back <= 0, last: Math.max(...list.map((t) => t.date)) };
}

function loanData() {
  const acc = loanAccount();
  const inAccount = acc ? allTxs().filter((t) => effect(acc, t) !== 0) : [];
  const groups = new Map();
  for (const t of inAccount) {
    const p = (t.loanPerson ?? '').trim();
    if (t.loanSide !== LOAN.side || !p) continue;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(t);
  }
  const loans = [...groups.entries()].map(([p, l]) => loanOf(p, l.sort(byNewest), LOAN.side, acc))
    .sort((a, b) => (a.done - b.done) || b.last - a.last);
  const loose = inAccount.filter((t) => !t.loanSide || !(t.loanPerson ?? '').trim()).sort(byNewest);
  return { acc, loans, loose };
}

/** 借款账户里的一笔：从我的钱包看，钱出去是 -，回来是 +。点开看详情、能改能删。 */
function loanTxRow(t, acc, side, act = "view") {
  const e = effect(acc, t), other = state.data.account.get(t.accountId === acc.id ? t.toAccountId : t.accountId);
  const label = e > 0 ? (side === 2 ? tr('我还款', 'I repaid') : tr('借出', 'Lent')) : (side === 2 ? tr('借入', 'Borrowed') : tr('收到还款', 'Repayment'));
  const foreign = t.currency && t.origCents > 0 && t.currency !== HOME;
  const sub = [dayISO(t.date), other?.name, t.note].filter(Boolean).map(h).join(' · ');
  return `<div class="row click" data-act="${act}" data-v="${t.id}">${accountTile(other)}
    <div class="main"><div class="title">${side ? label : (e > 0 ? tr('转入借款', 'Into loans') : tr('转出借款', 'Out of loans'))}</div><div class="sub">${sub}</div></div>
    <div class="right"><div class="num ${e > 0 ? 'out' : 'in'}">${e > 0 ? '-' : '+'}${foreign ? money(t.origCents, t.currency) : money(Math.abs(e), acctCur(acc))}</div>${foreign ? `<div class="small muted">≈ ${money(t.amountCents)}</div>` : ''}</div></div>`;
}

function loanAvatar(name) {
  return `<span class="ln-av" style="background:${LOAN_AVATARS[(javaHash(name) & 0x7fffffff) % LOAN_AVATARS.length]}">${h(([...name][0] ?? '?').toUpperCase())}</span>`;
}

function loansView() {
  const { acc, loans, loose } = loanData(), lend = LOAN.side === 1, dues = loanDues(), now = today();
  const current = LOAN.open != null ? loans.find((l) => l.person === LOAN.open) : null;
  let body;
  if (current) {
    // 一个人的明细
    const due = dues[current.person];
    body = `<div class="cols"><div class="grid sticky"><div><button class="btn" data-act="loan-back">${tr('‹ 借款', '‹ Loans')}</button></div>
      <div class="card grid"><div class="row" style="padding:0">${loanAvatar(current.person)}<b style="font-size:18px;min-width:0;overflow:hidden;text-overflow:ellipsis">${h(current.person)}</b></div>
        <div><div class="muted small">${current.done ? tr('已还清', 'Paid off') : tr('剩余未还', 'Outstanding')}</div>
          <div class="big ${current.done ? 'in' : 'amber'}">${money(Math.max(0, current.left))}</div>
          <div class="muted small">${lend ? tr('借出', 'Lent') : tr('借入', 'Borrowed')} ${money(current.total)} · ${tr('已还', 'Repaid')} ${money(current.back)}</div></div>
        <div class="ln-btns"><button class="btn primary" data-act="loan-add" data-v="repay">${lend ? tr('＋ 收到还款', '＋ Repayment') : tr('＋ 我还了一笔', '＋ I repaid')}</button><button class="btn" data-act="loan-add" data-v="more">${lend ? tr('＋ 再借出', '＋ Lend more') : tr('＋ 再借入', '＋ Borrow more')}</button></div>
        <div class="ln-due">${due == null ? `<button class="btn link" style="padding:0" data-act="loan-due-add">${tr('＋ 到期日', '＋ Due date')}</button>`
          : `<span class="muted small">${tr('到期日', 'Due')}</span><input type="date" data-change="loan-due" value="${dayISO(due)}" aria-label="${tr('到期日', 'Due date')}">${!current.done && now > due ? `<span class="small out">${tr(`逾期 ${now - due} 天`, `${now - due} days overdue`)}</span>` : ''}<button class="btn link danger" data-act="loan-due-clear">${tr('清除', 'Clear')}</button>`}</div></div></div>
      <div class="card">${current.list.map((t) => loanTxRow(t, acc, LOAN.side)).join('')}</div></div>`;
  } else if (LOAN.loose && loose.length) {
    body = `<div class="grid" style="max-width:760px;width:100%;margin:0 auto"><div class="between"><button class="btn" data-act="loan-back">${tr('‹ 借款', '‹ Loans')}</button><span class="muted small">${tr('点击一笔，将其指定给某人', 'Tap one to assign it')}</span></div>
      <div class="card">${loose.map((t) => loanTxRow(t, acc, 0, "loan-assign")).join("")}</div></div>`;
  } else {
    const total = loans.reduce((s, l) => s + l.total, 0), back = loans.reduce((s, l) => s + l.back, 0);
    const p = total > 0 ? Math.min(1, Math.max(0, back / total)) : 0, r = 34;
    // 第一次看这一边（借出 / 借入）时圆环和每人的进度条长出来（同手机端 ProgressRing 800ms）
    const grow = pgGrow(`loans:${LOAN.side}`);
    const ring = `<div class="ln-ring"><svg viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="${r}" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="9"/>
      ${pgArc(42, 42, r, p, '#fff', 9, grow)}</svg>
      <div><b class="num">${Math.round(p * 100)}%</b><div class="muted" style="font-size:10px">${tr('已还', 'repaid')}</div></div></div>`;
    const sumCard = `<div class="card cc" style="--cc:${lend ? '#1FA98A' : '#7B6CF6'}">
      <div class="row" style="padding:0"><div class="main"><div class="muted small">${tr('剩余未还', 'Outstanding')}</div><div class="big">${money(Math.max(0, total - back))}</div><div class="muted small">${tr(`共 ${loans.length} 人`, `${loans.length} ${loans.length === 1 ? 'person' : 'people'}`)}</div></div>${ring}</div>
      <div class="between" style="margin-top:10px">${[[lend ? tr('总借出', 'Total lent') : tr('总借入', 'Total borrowed'), total], [tr('已还', 'Repaid'), back], [tr('剩余', 'Left'), Math.max(0, total - back)]].map(([k, c]) => `<div><div class="muted small">${k}</div><div class="num">${money(c)}</div></div>`).join('')}</div>
      <div style="margin-top:12px"><button class="pill" data-act="loan-add" data-v="new">${lend ? tr('＋ 借出', '＋ Lend') : tr('＋ 借入', '＋ Borrow')}</button></div></div>`;
    const looseCard = loose.length ? `<div class="card click" data-act="loan-loose"><div class="between"><div><b style="font-weight:500">${tr('未归属', 'Unassigned')}</b><div class="muted small">${tr(`${loose.length} 笔未指定对方`, `${loose.length} without a person`)}</div></div>
      <span class="num">${money(loose.reduce((s, t) => s + effect(acc, t), 0), acctCur(acc))}</span></div></div>` : '';
    const active = loans.filter((l) => !l.done), settled = loans.filter((l) => l.done);
    const card = (l) => {
      const late = dues[l.person] != null ? now - dues[l.person] : 0;
      const status = l.done ? `<div class="num muted" style="text-decoration:line-through">${money(l.total)}</div><div class="small in">${tr('已还清', 'Paid off')}</div>`
        : `<div class="num">${money(l.left)}</div>${late > 0 ? `<div class="small out">${tr(`已逾期 ${late} 天`, `${late} days overdue`)}</div>` : `<div class="small muted">${dues[l.person] != null ? tr(dayISO(dues[l.person]) + ' 到期', 'Due ' + dayISO(dues[l.person])) : tr('剩余未还', 'Outstanding')}</div>`}`;
      return `<div class="card click ln-card" data-act="loan-open" data-v="${h(l.person)}"><div class="row" style="padding:0">${loanAvatar(l.person)}
        <div class="main"><div class="title">${h(l.person)}</div>
          ${l.total > 0 ? `<div class="bar ln-bar"><i${pgGx(grow)} style="width:${(Math.min(1, l.back / l.total) * 100).toFixed(1)}%"></i></div>` : ''}
          <div class="sub">${lend ? tr('借出', 'Lent') : tr('借入', 'Borrowed')} ${money(l.total)} · ${dayISO(l.last)}</div></div>
        <div class="right">${status}</div></div></div>`;
    };
    body = `<div class="cols"><div class="grid sticky"><div class="card" style="padding:8px">${seg('loan-side', [[1, tr('借出', 'Lent')], [2, tr('借入', 'Borrowed')]], LOAN.side)}</div>${sumCard}</div>
      <div class="grid">${looseCard}${!loans.length && !loose.length ? pgEmpty('piggy', tr('暂无借款，点击 ＋ 记一笔', 'No loans yet. Tap ＋ to add.')) : ''}
        ${active.map(card).join('')}
        ${settled.length ? `<button class="btn link ln-done" data-act="loan-done">${tr(`已结清 ${settled.length} 人`, `Settled (${settled.length})`)} ${LOAN.showDone ? '▴' : '▾'}</button>` : ''}
        ${LOAN.showDone ? settled.map(card).join('') : ''}</div></div>`;
  }
  return body + loanAddDialog(acc) + loanAssignDialog();
}

/** 记一笔：借出 / 借入 / 收到还款 / 我还了一笔。 */
function loanAddDialog(acc) {
  const a = LOAN.add;
  if (!a) return '';
  const lend = LOAN.side === 1;
  const title = a.repay && lend ? tr('收到还款', 'Repayment') : a.repay ? tr('我还了一笔', 'I repaid') : lend ? tr('借出', 'Lend') : tr('借入', 'Borrow');
  const accounts = [...state.data.account.values()].filter((x) => x.id !== acc?.id && !x.archived).sort((x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0) || x.id - y.id);
  const sel = accounts.some((x) => x.id === a.accountId) ? a.accountId : accounts[0]?.id;
  const cur = acctCur(state.data.account.get(sel) ?? {});
  const people = loanPeople();
  return `<div class="modal bl-modal"><div class="bl-back" data-act="loan-cancel"></div><div class="card grid" role="dialog" aria-label="${title}">
    <b style="font-size:18px">${title}${a.person ? ` · ${h(a.person)}` : ''}</b>
    ${a.person ? '' : `<label class="f">${tr('对方', 'Person')}<input id="ln-name" list="ln-people" autocomplete="off" value="${h(a.name ?? '')}"><datalist id="ln-people">${people.map((p) => `<option value="${h(p)}">`).join('')}</datalist></label>
      ${people.length ? `<div class="chips" style="margin:0">${people.slice(0, 12).map((p) => `<button class="chip" data-act="loan-pick" data-v="${h(p)}">${h(p)}</button>`).join('')}</div>` : ''}`}
    <label class="f">${tr(`金额（${cur}）`, `Amount (${cur})`)}<input id="ln-amount" inputmode="decimal" placeholder="0.00" value="${h(a.amount ?? '')}" style="font-size:22px;font-weight:700" autocomplete="off"></label>
    <div class="two"><label class="f">${tr('账户', 'Account')}<select id="ln-account" data-change="loan-account">${accounts.map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${h(x.name)}</option>`).join('')}</select></label>
      <label class="f">${tr('日期', 'Date')}<input id="ln-date" type="date" value="${dayISO(a.date ?? today())}"></label></div>
    <label class="f">${tr('备注（可空）', 'Note (optional)')}<input id="ln-note" autocomplete="off" value="${h(a.note ?? '')}"></label>
    ${LOAN.err ? `<p class="err" style="margin:0">${h(LOAN.err)}</p>` : ''}
    <div class="between"><button class="btn" data-act="loan-cancel">${tr('取消', 'Cancel')}</button><button class="btn primary" data-act="loan-save">${tr('保存', 'Save')}</button></div>
  </div></div>`;
}

/** 把"未归属"的一笔指给某个人。 */
function loanAssignDialog() {
  if (LOAN.assign == null) return '';
  const people = loanPeople();
  return `<div class="modal bl-modal"><div class="bl-back" data-act="loan-cancel"></div><div class="card grid" role="dialog" aria-label="${tr('归属人', 'Assign to')}">
    <b style="font-size:18px">${tr('归属人', 'Assign to')}</b>
    ${seg('loan-assign-side', [[1, tr('借出', 'Lent')], [2, tr('借入', 'Borrowed')]], LOAN.assignSide)}
    <label class="f">${tr('对方', 'Person')}<input id="ln-name" list="ln-people" autocomplete="off"><datalist id="ln-people">${people.map((p) => `<option value="${h(p)}">`).join('')}</datalist></label>
    ${people.length ? `<div class="chips" style="margin:0">${people.slice(0, 12).map((p) => `<button class="chip" data-act="loan-pick" data-v="${h(p)}">${h(p)}</button>`).join('')}</div>` : ''}
    ${LOAN.err ? `<p class="err" style="margin:0">${h(LOAN.err)}</p>` : ''}
    <div class="between"><button class="btn" data-act="loan-cancel">${tr('取消', 'Cancel')}</button><button class="btn primary" data-act="loan-assign-save">${tr('保存', 'Save')}</button></div>
  </div></div>`;
}

/** 和手机端 addLoan 一样的一笔转账。金额按所选账户的币种填，外币记下原币金额再折成主货币。 */
async function addLoan(person, side, repay, cents, account, date, note) {
  const loan = await ensureLoanAccount();
  if (loan.id === account.id) return;
  const paying = (side === 1) !== repay;
  const cur = acctCur(account), foreign = cur !== HOME;
  await saveRecord('tx', {
    id: newId(), amountCents: foreign ? convert(cents, cur, HOME) ?? cents : cents, kind: KIND.TRANSFER, categoryId: 0,
    accountId: paying ? account.id : loan.id, toAccountId: paying ? loan.id : account.id, ledgerId: state.ledgerId, date, note: note.trim(), tags: '',
    reimburse: 0, createdAt: Date.now(), currency: foreign ? cur : '', origCents: foreign ? cents : 0, excluded: false, offsetOf: 0, offsetParts: '',
    project: '', fund: '', loanPerson: person.trim(), loanSide: side,
  });
}

async function setLoanDue(person, day) {
  const next = { ...loanDues() };
  if (day == null) delete next[person]; else next[person] = day;
  await shared.set('loanDue', next);
}

/** 记账小窗里填到一半的内容收回来（换账户会重画，金额的币种跟着变）。 */
function loanCollect() {
  const v = (id) => document.getElementById(id)?.value;
  const a = LOAN.add;
  if (!a) return;
  if (v('ln-name') != null) a.name = v('ln-name');
  a.amount = v('ln-amount') ?? a.amount;
  if (v('ln-account')) a.accountId = Number(v('ln-account'));
  if (v('ln-date')) a.date = isoToDay(v('ln-date'));
  a.note = v('ln-note') ?? a.note;
}

MOD.pages.loans = () => loansView();
MOD.me.push({ key: 'loans', get name() { return tr('借款', 'Loans'); }, icon: 'people', order: 11 });

MOD.actions.push(async (act, v) => {
  if (!act.startsWith('loan-')) return false;
  const focus = (id) => setTimeout(() => document.getElementById(id)?.focus());
  switch (act) {
    case 'loan-side': LOAN.side = Number(v); LOAN.open = null; break;
    case 'loan-open': LOAN.open = v; scrollTo(0, 0); break;
    case 'loan-back': LOAN.open = null; LOAN.loose = false; break;
    case 'loan-loose': LOAN.loose = true; scrollTo(0, 0); break;
    case 'loan-done': LOAN.showDone = !LOAN.showDone; break;
    case 'loan-add':
      LOAN.err = '';
      LOAN.add = { person: v === 'new' ? '' : LOAN.open ?? '', repay: v === 'repay', accountId: store.get('hl.lastAccount', 0), date: today() };
      focus(LOAN.add.person ? 'ln-amount' : 'ln-name');
      break;
    case 'loan-pick': { const el = document.getElementById('ln-name'); if (el) el.value = v; document.getElementById('ln-amount')?.focus(); return true; }
    case 'loan-cancel': LOAN.add = null; LOAN.assign = null; LOAN.err = ''; break;
    case 'loan-save': {
      loanCollect();
      const a = LOAN.add, person = (a.person || a.name || '').trim(), cents = parseCents(a.amount ?? ''), account = state.data.account.get(a.accountId) ?? state.data.account.get(Number(document.getElementById('ln-account')?.value));
      if (!person) { LOAN.err = tr('请输入对方', 'Enter a person'); break; }
      if (cents == null) { LOAN.err = tr('请输入金额', 'Enter an amount'); break; }
      if (!account) { LOAN.err = tr('请选择账户', 'Choose an account'); break; }
      try {
        await addLoan(person, LOAN.side, a.repay, cents, account, a.date ?? today(), a.note ?? '');
        store.set('hl.lastAccount', account.id);
        LOAN.add = null; LOAN.err = '';
      } catch (e) { LOAN.err = e.message; }
      break;
    }
    case 'loan-assign': LOAN.assign = Number(v); LOAN.assignSide = LOAN.side; LOAN.err = ''; focus('ln-name'); break;
    case 'loan-assign-side': LOAN.assignSide = Number(v); { const keep = document.getElementById('ln-name')?.value ?? ''; render(); const el = document.getElementById('ln-name'); if (el) el.value = keep; } return true;
    case 'loan-assign-save': {
      const name = (document.getElementById('ln-name')?.value ?? '').trim(), t = state.data.tx.get(LOAN.assign);
      if (!name) { LOAN.err = tr('请输入对方', 'Enter a person'); break; }
      try { if (t) await saveRecord('tx', { ...t, loanPerson: name, loanSide: LOAN.assignSide }); LOAN.assign = null; LOAN.err = ''; } catch (e) { LOAN.err = e.message; }
      break;
    }
    case 'loan-due-add': try { await setLoanDue(LOAN.open, today() + 30); } catch (e) { state.error = e.message; } break;
    case 'loan-due-clear': try { await setLoanDue(LOAN.open, null); } catch (e) { state.error = e.message; } break;
    default: return true;
  }
  render();
  return true;
});

MOD.changes.push(async (ev) => {
  const c = ev.target.dataset?.change;
  if (c === 'loan-account') { loanCollect(); render(); return true; }
  if (c === 'loan-due') {
    if (ev.target.value && LOAN.open != null) { try { await setLoanDue(LOAN.open, isoToDay(ev.target.value)); } catch (e) { state.error = e.message; } render(); }
    return true;
  }
  return false;
});

// 回车 = 保存
document.addEventListener('keydown', (ev) => {
  if (!['ln-name', 'ln-amount', 'ln-note'].includes(ev.target.id) || ev.key !== 'Enter' || ev.isComposing) return;
  ev.preventDefault();
  document.querySelector('[data-act="loan-save"], [data-act="loan-assign-save"]')?.click();
});
// 从别的页进来时回到列表
document.addEventListener('click', (ev) => { if (ev.target.closest?.('[data-act="tab"]')) { LOAN.open = null; LOAN.loose = false; LOAN.add = null; LOAN.assign = null; LOAN.err = ''; } }, true);
