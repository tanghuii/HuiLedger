// 记账页和账单行，和手机端对齐：
// 1. 记一笔 / 修改（EditScreen.kt）：标题栏里切支出收入转账、大金额、一行六个分类图标、小胶囊、备注、自带数字键盘（能算 + −，再记 / 保存）
// 2. 账单行侧滑（Gestures.kt SwipeRow）：左滑删除、右滑复制，拉过一半多才生效，都能撤销
// 3. 多选：长按一行或点"多选"，批量改项目、资金来源、分类、报销状态，或者一起删
// app.js 的 render() 在 state.editing 不为空时画 editorView()；txRow() 也在这里。
// 撤销提示、多选操作条、删除确认画在 #app 外面的一层（#ed-layer），整页重画不影响它们。
'use strict';

const ed = { layer: null, toast: null, toastTimer: 0, bulk: null, bulkPick: null, busy: '', confirm: null };
const edReimburse = () => [tr('不报销', 'Not reimbursable'), tr('待报销', 'To reimburse'), tr('已报销', 'Reimbursed')];

const edSvg = (key, color) => `<svg class="ed-ic" viewBox="0 0 24 24"${color ? ` style="stroke:${color}"` : ''}><path d="${(ICONS[key] ?? ICONS.tag).d}"/></svg>`;
/** 分 → 输入框里的字：整数不带小数点。 */
const edInput = (cents) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
const edIsFormula = (s) => /\d\s*[+\-−×÷*/]\s*[\d.]/.test(s);

/** 金额里可以写算式（12.5+3.2、3×4）：先乘除后加减，结果是分；不是正数就返回 null。 */
function edCalc(text) {
  const s = String(text ?? '').replace(/\s/g, '').replace(/,/g, '.').replace(/−/g, '-').replace(/×/g, '*').replace(/÷/g, '/').replace(/[+\-*/]+$/, '');
  if (!s) return null;
  if (!edIsFormula(s)) return parseCents(s);
  const nums = [], ops = [];
  let i = 0;
  while (i < s.length) {
    const start = i;
    if (s[i] === '-' && nums.length === ops.length) i++;
    while (i < s.length && /[\d.]/.test(s[i])) i++;
    const part = s.slice(start, i), n = Number(part);
    if (!part || !Number.isFinite(n)) return null;
    nums.push(n);
    if (i < s.length) { if (!'+-*/'.includes(s[i])) return null; ops.push(s[i]); i++; }
  }
  if (nums.length !== ops.length + 1) return null;
  const terms = [nums[0]], signs = [];
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k], n = nums[k + 1];
    if (o === '*') terms[terms.length - 1] *= n;
    else if (o === '/') { if (!n) return null; terms[terms.length - 1] /= n; }
    else { signs.push(o); terms.push(n); }
  }
  let v = terms[0];
  signs.forEach((o, k) => { v = o === '+' ? v + terms[k + 1] : v - terms[k + 1]; });
  const c = Math.round(Number((v * 100).toFixed(6)));
  return c > 0 ? c : null;
}

// ---------------------------------------------------------------- 记一笔 / 修改

const edForeign = (e) => !!(e.currency && e.origCents > 0 && e.currency !== HOME);
/** 金额按什么币种输入：新记的跟着账户走；改外币账单时改原币金额；其余是主货币。 */
const edCur = (e) => (e._isNew ? acctCur(state.data.account.get(e.accountId) ?? {}) : edForeign(e) ? e.currency : HOME);
/** 输入的金额折成主货币。改已有的外币账单时按它原来的汇率折，免得旧账跟着今天的汇率变。 */
function edHomeCents(e, cents) {
  const cur = edCur(e);
  if (cur === HOME) return cents;
  if (!e._isNew && edForeign(e)) return cents === e.origCents ? e.amountCents : Math.round(cents * e.amountCents / e.origCents);
  return convert(cents, cur, HOME);
}

function edAccounts(keep) {
  return [...state.data.account.values()].filter((a) => !a.archived || a.id === keep).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
}
/** 转入账户：选了的（且和转出不同），否则第一个别的账户（和手机端一样）。 */
function edTo(e) {
  const t = state.data.account.get(e.toAccountId);
  return t && t.id !== e.accountId ? t : edAccounts().find((a) => a.id !== e.accountId) ?? null;
}
/** 分类：选中的可能是子分类；换了收支类型后原来的不适用，退回这一类的第一个。 */
function edCats(e) {
  const cats = [...state.data.category.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const isIncome = e.kind === KIND.INCOME;
  const tops = cats.filter((c) => !c.parentId && !!c.isIncome === isIncome);
  const chosen = state.data.category.get(e.categoryId), ok = chosen && !!chosen.isIncome === isIncome;
  const top = ok ? (chosen.parentId ? tops.find((c) => c.id === chosen.parentId) ?? tops[0] : chosen) : tops[0];
  const leafId = ok && chosen.parentId && top && chosen.parentId === top.id ? chosen.id : top?.id ?? 0;
  return { tops, top, leafId, subs: top ? cats.filter((c) => c.parentId === top.id) : [] };
}
function edDayName(day) {
  const t = today();
  if (day === t) return tr('今天', 'Today');
  if (day === t - 1) return tr('昨天', 'Yesterday');
  const d = dayToDate(day), y = d.getUTCFullYear(), other = y !== new Date().getFullYear();
  return tr(`${other ? y + '年' : ''}${d.getUTCMonth() + 1}月${d.getUTCDate()}日`, `${MONTH_EN[d.getUTCMonth()]} ${d.getUTCDate()}${other ? ', ' + y : ''}`);
}
const edTags = (e) => String(e.tags ?? '').split(/[\s#,，]+/).filter(Boolean);
function edKnownTags() {
  const last = new Map();
  for (const t of state.data.tx.values()) for (const x of String(t.tags ?? '').split(' ').filter(Boolean)) last.set(x, Math.max(last.get(x) ?? 0, t.date));
  return [...last.entries()].sort((a, b) => b[1] - a[1]).map(([x]) => x).slice(0, 30);
}

function startEdit(t) {
  if (t) {
    state.editing = { ...t, _amount: edInput(edForeign(t) ? t.origCents : t.amountCents), _isNew: false };
  } else {
    const accs = edAccounts(), last = store.get('hl.lastAccount', 0);
    state.editing = {
      id: newId(), kind: KIND.EXPENSE, amountCents: 0, categoryId: 0, accountId: accs.some((a) => a.id === last) ? last : accs[0]?.id ?? 0, toAccountId: 0,
      ledgerId: state.ledgerId, date: today(), note: '', tags: '', reimburse: 0, createdAt: Date.now(), currency: '', origCents: 0, excluded: false,
      offsetOf: 0, offsetParts: '', project: '', fund: '', _amount: '', _isNew: true,
    };
  }
  render();
}

function edAmountCard(e) {
  const a = e._amount ?? '', cur = edCur(e), cents = edCalc(a);
  const cls = !a ? 'zero' : cents == null ? 'bad' : e.kind === KIND.INCOME ? 'in' : e.kind === KIND.EXPENSE ? 'out' : '';
  const home = cents != null && cur !== HOME ? edHomeCents(e, cents) : null;
  const lines = [
    cents != null && edIsFormula(a) ? `= ${edInput(cents)}` : '',
    cur !== HOME && cents != null ? (home != null ? `≈ ${money(home)}` : tr('无汇率', 'No rate')) : '',
  ].filter(Boolean);
  return `<div class="ed-amount"><span class="ed-cur">${flagOf(cur)} ${h(cur)}</span>
    <div class="ed-amt-w"><div class="ed-amt num ${cls} ${a.length > 12 ? 'long' : ''}">${h(a || '0.00')}</div>${lines.length ? `<div class="ed-amt-sub">${lines.join('　')}</div>` : ''}</div></div>`;
}

function editorView() {
  const e = state.editing;
  if (e._amount == null) e._amount = e.amountCents ? edInput(e.amountCents) : '';
  const acc = state.data.account, transfer = e.kind === KIND.TRANSFER;
  const { tops, top, leafId, subs } = edCats(e);
  const from = acc.get(e.accountId), to = edTo(e), tags = edTags(e);
  const accChip = (a, which) => `<button class="chip lead" data-act="ed-pick" data-v="${which}">${a ? accountTile(a) : ''}<span>${h(a?.name ?? tr('选择账户', 'Choose account'))}</span></button>`;
  const head = transfer
    ? `<div class="ed-box ed-move"><div class="muted small">${tr('从 → 到', 'From → To')}</div><div class="ed-chips">${accChip(from, 'acc')}${edSvg('forward')}${accChip(to, 'to')}</div>${edAccounts().length < 2 ? `<div class="err">${tr('至少要两个账户', 'Needs two accounts')}</div>` : ''}</div>`
    : `<div class="ed-box">${tops.length ? `<div class="ed-cats">${tops.map((c) => `<button class="ed-cat ${c.id === top?.id ? 'on' : ''}" data-act="ed-cat" data-v="${c.id}">${iconTile(c.icon ?? 'tag')}<span>${h(c.name)}</span></button>`).join('')}</div>` : `<div class="muted small">${tr('还没有分类', 'No categories yet')}</div>`}
      ${subs.length ? `<div class="ed-subs">${subs.map((s) => `<button class="ed-sub ${s.id === leafId ? 'on' : ''}" data-act="ed-sub" data-v="${s.id}">${edSvg(s.icon ?? 'tag', s.id === leafId ? '' : (ICONS[s.icon] ?? ICONS.tag).c)}${h(s.name)}</button>`).join('')}</div>` : ''}</div>`;
  // 可报销的支出、报销收入才问项目和资金来源（已经填了的照样显示）
  const pf = !transfer && (e.kind === KIND.EXPENSE && e.reimburse || e.kind === KIND.INCOME && top?.name === '报销' || e.project || e.fund);
  const chips = [
    transfer ? '' : accChip(from, 'acc'),
    `<label class="chip ed-datechip">${edSvg('calendar')}<span>${edDayName(e.date)}</span><input type="date" id="e-date" value="${dayISO(e.date)}" aria-label="${tr('日期', 'Date')}"></label>`,
    `<button class="chip ${tags.length ? 'on' : ''}" data-act="ed-pick" data-v="tags">${edSvg('tag')}<span>${tags.length ? tags.map((x) => '#' + h(x)).join(' ') : tr('标签', 'Tags')}</span></button>`,
    e.kind === KIND.EXPENSE ? `<button class="chip ${e.reimburse ? 'on' : ''}" data-act="ed-pick" data-v="reimburse">${edSvg('receipt')}<span>${edReimburse()[e.reimburse ?? 0]}</span></button>` : '',
    pf ? `<button class="chip ${e.project ? 'on' : ''}" data-act="ed-pick" data-v="project">${edSvg('target')}<span>${e.project ? tr('项目 · ', 'Project · ') + h(e.project) : tr('项目', 'Project')}</span></button>` : '',
    pf ? `<button class="chip ${e.fund ? 'on' : ''}" data-act="ed-pick" data-v="fund">${edSvg('coins')}<span>${e.fund ? tr('资金 · ', 'Funding · ') + h(e.fund) : tr('资金来源', 'Funding')}</span></button>` : '',
    transfer ? '' : `<button class="chip ${e.excluded ? 'on' : ''}" data-act="ed-pick" data-v="excluded"><span>${e.excluded ? tr('不计入收支', 'Excluded') : tr('计入收支', 'Included')}</span></button>`,
    e._isNew ? '' : `<button class="chip danger" data-act="delete"><span>${tr('删除', 'Delete')}</span></button>`,
  ].filter(Boolean).join('');
  const valid = edCalc(e._amount) != null;
  const key = (k) => k === 'SAVE' ? `<button class="ed-key save ${valid ? '' : 'dim'}" data-act="save">${tr('保存', 'Save')}</button>`
    : k === 'AGAIN' ? `<button class="ed-key op txt" data-act="ed-again">${tr('再记', 'Next')}</button>`
    : k === 'C' ? `<button class="ed-key op txt" data-act="ed-key" data-v="C">${tr('清空', 'Clear')}</button>`
    : `<button class="ed-key ${'⌫+−'.includes(k) ? 'op' : ''}" data-act="ed-key" data-v="${k}" ${k === '⌫' ? `aria-label="${tr('退格', 'Backspace')}"` : ''}>${k}</button>`;
  const keys = ['1', '2', '3', '⌫', '4', '5', '6', '+', '7', '8', '9', '−', e._isNew ? 'AGAIN' : 'C', '0', '.', 'SAVE'];
  const heading = e._isNew ? tr('记一笔', 'New entry') : tr('修改', 'Edit');
  return `<div class="modal ed-modal" data-act="close-backdrop"><div class="card ed-sheet" role="dialog" aria-label="${heading}">
    <div class="ed-head"><button class="ed-x" data-act="close" aria-label="${tr('关闭', 'Close')}">✕</button><b>${heading}</b>${seg('e-kind', [[0, tr('支出', 'Expense')], [1, tr('收入', 'Income')], [2, tr('转账', 'Transfer')]], e.kind)}</div>
    ${edAmountCard(e)}
    <div class="ed-scroll">
      ${head}
      <div class="ed-chips">${chips}</div>
      <label class="ed-note">${edSvg('pencil')}<textarea id="e-note" rows="${Math.min(4, String(e.note ?? '').split('\n').length)}" placeholder="${tr('备注', 'Note')}">${h(e.note)}</textarea></label>
      ${state.error ? `<p class="err" style="margin:0">${h(state.error)}</p>` : ''}
    </div>
    <div class="ed-keys">${keys.map(key).join('')}</div>
    ${edPop(e)}
  </div></div>`;
}

/** 点了某个小胶囊后弹出来的选择面板（盖在记账页下半截）。 */
function edPop(e) {
  const p = e._pick;
  if (!p) return '';
  const opt = (k, v, label, on, lead = '') => `<button class="ed-opt ${on ? 'on' : ''}" data-act="ed-set" data-k="${k}" data-v="${h(v)}">${lead}<span>${label}</span>${on ? edSvg('check') : ''}</button>`;
  let title = '', body = '';
  if (p === 'acc' || p === 'to') {
    const k = p === 'to' ? 'toAccountId' : 'accountId', sel = p === 'to' ? edTo(e)?.id : e.accountId;
    title = p === 'to' ? tr('转入账户', 'To account') : e.kind === KIND.TRANSFER ? tr('转出账户', 'From account') : tr('账户', 'Account');
    body = edAccounts(sel).filter((a) => p !== 'to' || a.id !== e.accountId)
      .map((a) => opt(k, a.id, `${h(a.name)}${acctCur(a) !== HOME ? ` <small class="muted">${h(acctCur(a))}</small>` : ''}`, a.id === sel, accountTile(a))).join('');
  } else if (p === 'reimburse') {
    title = tr('报销', 'Reimburse'); body = edReimburse().map((n, i) => opt('reimburse', i, n, (e.reimburse ?? 0) === i)).join('');
  } else if (p === 'excluded') {
    title = tr('收支统计', 'In totals'); body = opt('excluded', 0, tr('计入收支', 'Included'), !e.excluded) + opt('excluded', 1, tr('不计入收支', 'Excluded'), !!e.excluded);
  } else if (p === 'project' || p === 'fund') {
    title = p === 'project' ? tr('报销项目', 'Project') : tr('资金来源', 'Funding');
    body = opt(p, '', tr('（不填）', '(None)'), !e[p]) + (p === 'project' ? projectNames() : fundNames()).map((n) => opt(p, n, h(n), e[p] === n)).join('')
      + `<div class="ed-new"><input id="ed-newname" placeholder="${tr('新建', 'New')}" enterkeyhint="done" autocomplete="off"><button class="btn" data-act="ed-newname" data-v="${p}">${tr('添加', 'Add')}</button></div>`;
  } else if (p === 'tags') {
    const on = edTags(e), all = [...on.filter((x) => !edKnownTags().includes(x)), ...edKnownTags()];
    title = tr('标签', 'Tags');
    body = `<div class="ed-chips">${all.map((x) => `<button class="chip ${on.includes(x) ? 'on' : ''}" data-act="ed-tag" data-v="${h(x)}">#${h(x)}</button>`).join('') || `<span class="muted small">${tr('还没有标签', 'No tags yet')}</span>`}</div>
      <div class="ed-new"><input id="ed-newtag" placeholder="${tr('新标签', 'New tag')}" enterkeyhint="done" autocomplete="off"><button class="btn primary" data-act="ed-tags-done">${tr('好', 'Done')}</button></div>`;
  }
  return `<div class="ed-pop" data-act="ed-pick-close"><div class="ed-popcard" data-act="noop"><div class="between"><b>${title}</b><button class="ed-x" data-act="ed-pick-x" aria-label="${tr('关闭', 'Close')}">✕</button></div><div class="ed-opts">${body}</div></div></div>`;
}

/** 以前的表单要先把输入框里的字收回来；现在只剩备注是输入框（边打边存），留着这个名字给别处调用。 */
function collect() {
  const n = document.getElementById('e-note');
  if (n && state.editing) state.editing.note = n.value;
}

/** 整个页面重画，但记账页里滚到哪儿还停在哪儿。 */
function edRefresh() {
  const top = document.querySelector('.ed-scroll')?.scrollTop ?? 0;
  render();
  const s = document.querySelector('.ed-scroll');
  if (s) s.scrollTop = top;
}

/** 自带数字键盘按下一个键（规则和手机端一样：最多两位小数，开头的 0 会被替换）。 */
function edPress(k) {
  const e = state.editing;
  if (!e) return;
  let a = e._amount ?? '';
  const last = a.split(/[+−×÷]/).pop();
  if (k === '⌫') a = a.slice(0, -1);
  else if (k === 'C') a = '';
  else if ('+−×÷'.includes(k)) a = a ? a.replace(/[+−×÷]+$/, '') + k : a;
  else if (k === '.') { if (!last.includes('.') && a.length <= 20) a += last ? '.' : '0.'; }
  else if (a.length <= 20 && !(last.includes('.') && last.length - last.indexOf('.') > 2)) a = last === '0' ? a.slice(0, -1) + k : a + k;
  e._amount = a;
  const box = document.querySelector('.ed-amount');
  if (!box) return render();
  box.outerHTML = edAmountCard(e);
  document.querySelector('.ed-key.save')?.classList.toggle('dim', edCalc(a) == null);
}

function edKind(k) {
  const e = state.editing;
  if (!e) return;
  e.kind = k; e._pick = null; state.error = '';
  edRefresh();
}

/** 保存。again：存完留在记账页接着记下一笔（类型、分类、账户、日期不变，金额和备注清空）。 */
async function saveEditing(again = false) {
  const e = state.editing;
  if (!e) return;
  collect();
  const cents = edCalc(e._amount);
  if (cents == null) { state.error = tr('请输入金额', 'Enter an amount'); return edRefresh(); }
  const transfer = e.kind === KIND.TRANSFER;
  if (!state.data.account.get(e.accountId)) { state.error = tr('请选择账户', 'Choose an account'); return edRefresh(); }
  const to = transfer ? edTo(e) : null;
  if (transfer && !to) { state.error = tr('请选择两个不同的账户', 'Choose two different accounts'); return edRefresh(); }
  const t = {};
  for (const [k, v] of Object.entries(e)) if (!k.startsWith('_')) t[k] = v;
  // 新记的一笔按账户的币种填：外币账户存下原币金额，再折成主货币
  const cur = edCur(e), home = edHomeCents(e, cents) ?? cents;
  if (cur === HOME) { t.amountCents = cents; if (e._isNew) { t.currency = ''; t.origCents = 0; } }
  else { t.currency = cur; t.origCents = cents; t.amountCents = home; }
  if (transfer) { t.toAccountId = to.id; t.categoryId = 0; t.reimburse = 0; t.excluded = false; t.project = ''; t.fund = ''; }
  else { t.toAccountId = 0; t.categoryId = edCats(e).leafId; }
  if (t.kind !== KIND.EXPENSE) t.reimburse = 0;
  if (t.kind !== KIND.INCOME) { t.offsetOf = 0; t.offsetParts = ''; }
  t.note = String(t.note ?? '').trim();
  t.tags = edTags(e).join(' ');
  try {
    await saveRecord('tx', t);
    store.set('hl.lastAccount', t.accountId);
    if (t.project) rememberName('hl.projects', t.project);
    if (t.fund) rememberName('hl.funds', t.fund);
    state.error = '';
    if (again && e._isNew) {
      state.editing = { ...e, id: newId(), createdAt: Date.now(), _amount: '', note: '', _pick: null };
      render();
      edToast(tr('已保存', 'Saved'));
      return;
    }
    state.editing = null;
  } catch (err) { state.error = err.message; }
  render();
}

/** 记账页里的"删除"：直接删，底部给几秒撤销。 */
async function edDeleteEditing() {
  const e = state.editing, t = e && state.data.tx.get(e.id);
  state.editing = null; state.error = '';
  if (t) await edRemove(t); else render();
}

// ---------------------------------------------------------------- 账单行

function txRow(t, L, showDate = false) {
  const cat = state.data.category, acc = state.data.account;
  const leaf = cat.get(t.categoryId), top = L.top(t.categoryId), from = acc.get(t.accountId), to = acc.get(t.toAccountId);
  const transfer = t.kind === KIND.TRANSFER;
  const title = transfer ? `${h(from?.name ?? '?')} → ${h(to?.name ?? '?')}` : !leaf ? tr('未分类', 'Uncategorized') : leaf.parentId ? `${h(top?.name)} · ${h(leaf.name)}` : h(leaf.name);
  const offset = t.kind === KIND.EXPENSE ? L.offsets.get(t.id) ?? 0 : 0;
  const foreign = t.currency && t.origCents > 0 && t.currency !== HOME;
  const net = L.net(t);
  const over = offset > 0 && net < 0;
  const sign = over ? '+' : t.kind === KIND.INCOME ? '+' : t.kind === KIND.EXPENSE ? '-' : '';
  const amount = offset > 0 && !foreign ? money(Math.abs(net)) : foreign ? money(t.origCents, t.currency) : money(t.amountCents);
  const cls = over || t.kind === KIND.INCOME ? 'in' : t.kind === KIND.EXPENSE ? 'out' : '';
  const details = [showDate ? dayISO(t.date) : '', t.note, ...(t.tags ? t.tags.split(' ').filter(Boolean).map((x) => '#' + x) : [])].filter(Boolean).map(h).join('  ');
  // 付款账户做成带小标志的彩色小签，放在备注前面
  const face = !transfer && from ? accountFace(from) : null;
  const payer = face ? `<span class="payer" style="--pc:${face}">${accountTile(from, 'mini')}${h(from.name)}</span>` : '';
  const targets = L.parts(t);
  const extra = [
    offset > 0 ? `${tr('原', 'Orig.')} ${money(t.amountCents)} · ${tr('抵', 'offset')} ${money(offset)}` : '',
    foreign ? `≈ ${money(t.amountCents)}` : '',
    targets.length ? `${tr('抵扣', 'Offsets')} ${targets.length > 1 ? tr(targets.length + ' 笔支出', targets.length + ' expenses') : h(cat.get(state.data.tx.get(targets[0][0])?.categoryId)?.name ?? '')}` : '',
  ].filter(Boolean).join(' · ');
  // 多选时前面多一个勾；"row click" 和 data-act="view" 这两段别处（txRowStatic）会替换，不要改写法
  return `<div class="row click ed-tx${state.sel?.has(t.id) ? ' sel-on' : ''}" data-act="view" data-v="${t.id}">
    <span class="ed-check" aria-hidden="true"></span>
    ${transfer ? accountTile(to) : iconTile(leaf?.icon ?? 'tag')}
    <div class="main"><div class="title">${title}${t.excluded ? `<span class="badge gray">${tr('不计', 'Excluded')}</span>` : ''}${t.reimburse === 1 ? `<span class="badge">${tr('待报销', 'To reimburse')}</span>` : t.reimburse === 2 ? `<span class="badge gray">${tr('已报销', 'Reimbursed')}</span>` : ''}</div>
      ${details || payer ? `<div class="sub">${payer}${details}</div>` : ''}</div>
    <div class="right"><div class="num ${cls}">${sign}${amount}</div>${extra ? `<div class="small muted">${extra}</div>` : ''}</div>
  </div>`;
}

/** 删一笔，底部给几秒撤销（撤销 = 原样存回去）。 */
async function edRemove(t) {
  try { await deleteRecord('tx', t.id); } catch (e) { state.error = e.message; render(); return; }
  if (state.view === t.id) state.view = null;
  render();
  edToast(tr('已删除', 'Deleted'), async () => { await saveRecord('tx', t); });
}
/** 复制一笔到今天（抵扣关系不带，报销回到"待报销"），可撤销。 */
async function edCopy(t) {
  const copy = { ...t, id: newId(), date: today(), createdAt: Date.now(), offsetOf: 0, offsetParts: '', reimburse: t.reimburse ? 1 : 0 };
  try { await saveRecord('tx', copy); } catch (e) { state.error = e.message; render(); return; }
  render();
  edToast(tr('已复制到今天', 'Copied to today'), async () => { await deleteRecord('tx', copy.id); });
}

// ---------------------------------------------------------------- #app 外面的一层：撤销提示、多选操作条、删除确认

function edLayerEl() {
  if (!ed.layer) {
    ed.layer = document.createElement('div');
    ed.layer.id = 'ed-layer';
    ed.layer.innerHTML = '<div class="ed-ui"></div><div class="ed-toastbox"></div>';
    document.body.appendChild(ed.layer);
    ed.layer.addEventListener('click', edLayerClick);
    ed.layer.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.id === 'ed-bnew') { ev.preventDefault(); ed.layer.querySelector('[data-ed="bnew"]')?.click(); } });
  }
  return ed.layer;
}
function edPaintLayer() {
  document.body.classList.toggle('ed-selecting', !!state.sel);
  edLayerEl().querySelector('.ed-ui').innerHTML = (state.sel ? edSelBar() : '') + (ed.bulkPick ? edBulkPop() : '') + (ed.confirm ? edConfirmView() : '');
}
function edPaintToast() {
  const t = ed.toast;
  edLayerEl().querySelector('.ed-toastbox').innerHTML = t
    ? `<div class="ed-toast ${state.editing ? 'top' : ''}"><span>${h(t.text)}</span>${t.undo ? `<button data-ed="undo">${tr('撤销', 'Undo')}</button>` : ''}</div>` : '';
}
function edToast(text, undo = null) {
  clearTimeout(ed.toastTimer);
  ed.toast = { text, undo };
  edPaintToast();
  ed.toastTimer = setTimeout(() => { ed.toast = null; edPaintToast(); }, undo ? 5000 : 2000);
}

/** 侧滑删除 / 复制都要先确认：标题、日期、这一笔本身、会发生什么。 */
function edConfirmView() {
  const t = ed.confirm, L = computeLookup(), copy = ed.confirmCopy;
  const d = dayToDate(t.date);
  return `<div class="modal ed-lmodal" data-ed="cf-no-bg"><div class="card ed-bcard ed-confirm" data-ed="noop">
    <b style="font-size:17px">${copy ? tr('确认复制此笔账目？', 'Copy this entry?') : tr('确认删除此笔账目？', 'Delete this entry?')}</b>
    <div class="small muted">${tr(`${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEK[d.getUTCDay()]}`, `${WEEK[d.getUTCDay()]}, ${MONTH_EN[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`)}</div>
    <div class="ed-cfrow">${txRow(t, L).replace('data-act="view"', '').replace('row click', 'row')}</div>
    <div class="small" style="color:${copy ? '#5B8DEF' : 'var(--expense)'}">${copy ? tr('会复制一笔到今天', 'A copy will be added today') : tr('删除后可在底部撤销', 'You can undo after deleting')}</div>
    <div class="ed-selbtns"><button class="btn" data-ed="cf-no">${tr('取消', 'Cancel')}</button><button class="btn ${copy ? 'primary' : 'ed-redbtn'}" data-ed="cf-yes">${copy ? tr('复制', 'Copy') : tr('删除', 'Delete')}</button></div>
  </div></div>`;
}

// ---- 多选

/** 页面上现在看得见的账单行（详情弹窗里的不算）。 */
const edVisibleIds = () => [...new Set([...document.querySelectorAll('#app .row.click.ed-tx')].filter((r) => !r.closest('.modal')).map((r) => Number(r.dataset.v)))];
function edPaintRows() {
  for (const r of document.querySelectorAll('#app .row.click.ed-tx')) r.classList.toggle('sel-on', !!state.sel?.has(Number(r.dataset.v)));
}
function edSelect(set) {
  state.sel = set; ed.bulk = { project: null, fund: null, categoryId: null, reimburse: null }; ed.bulkPick = null;
  edPaintLayer(); edPaintRows();
}
function edExitSelect() { state.sel = null; ed.bulk = null; ed.bulkPick = null; ed.busy = ''; edPaintLayer(); edPaintRows(); }
function edToggleSel(id) {
  if (state.sel.has(id)) state.sel.delete(id); else state.sel.add(id);
  edPaintRows(); edPaintLayer();
}

/** 每一笔改完是什么样；没变的不列。null 表示这一项不改，空串表示清空。 */
function edBulkPlan() {
  const b = ed.bulk, cat = b.categoryId != null ? state.data.category.get(b.categoryId) : null, out = [];
  for (const id of state.sel) {
    const t = state.data.tx.get(id);
    if (!t) continue;
    const n = { ...t };
    if (t.kind !== KIND.TRANSFER) {
      if (b.project != null) n.project = b.project;
      if (b.fund != null) n.fund = b.fund;
      if (cat && !!cat.isIncome === (t.kind === KIND.INCOME)) n.categoryId = cat.id;
    }
    if (b.reimburse != null && t.kind === KIND.EXPENSE) n.reimburse = b.reimburse;
    if (['project', 'fund', 'categoryId', 'reimburse'].some((k) => String(n[k] ?? '') !== String(t[k] ?? ''))) out.push({ old: t, now: n });
  }
  return out;
}

function edSelBar() {
  const n = state.sel.size, b = ed.bulk, vis = edVisibleIds();
  const all = vis.length > 0 && vis.every((id) => state.sel.has(id));
  const lab = (name, val) => (val == null ? name : `${name} · ${val === '' ? tr('清空', 'Cleared') : h(val)}`);
  const cat = b.categoryId != null ? state.data.category.get(b.categoryId) : null;
  const plan = edBulkPlan().length;
  return `<div class="ed-selbar">
    <div class="ed-selhead"><button class="ed-x" data-ed="exit" aria-label="${tr('退出多选', 'Exit selection')}">✕</button><b>${tr(`已选 ${n} 笔`, `${n} selected`)}</b><button class="btn link" data-ed="all">${all ? tr('全不选', 'Select none') : tr('全选', 'Select all')}</button></div>
    <div class="ed-chips">
      <button class="chip ${b.project != null ? 'on' : ''}" data-ed="pick" data-v="project">${edSvg('target')}${lab(tr('项目', 'Project'), b.project)}</button>
      <button class="chip ${b.fund != null ? 'on' : ''}" data-ed="pick" data-v="fund">${edSvg('coins')}${lab(tr('资金来源', 'Funding'), b.fund)}</button>
      <button class="chip ${cat ? 'on' : ''}" data-ed="pick" data-v="categoryId">${edSvg('layers')}${cat ? tr('分类 · ', 'Category · ') + h(cat.name) : tr('分类', 'Category')}</button>
      <button class="chip ${b.reimburse != null ? 'on' : ''}" data-ed="pick" data-v="reimburse">${edSvg('receipt')}${b.reimburse != null ? tr('报销 · ', 'Reimburse · ') + edReimburse()[b.reimburse] : tr('报销', 'Reimburse')}</button>
    </div>
    <div class="ed-selbtns"><button class="btn danger" data-ed="del" ${n && !ed.busy ? '' : 'disabled'}>${tr('删除', 'Delete')}</button>
      <button class="btn primary" data-ed="apply" ${plan && !ed.busy ? '' : 'disabled'}>${ed.busy || (plan ? tr(`应用 ${plan} 笔`, `Apply to ${plan}`) : tr('应用多笔', 'Apply'))}</button></div>
  </div>`;
}

function edBulkPop() {
  const p = ed.bulkPick, b = ed.bulk;
  const opt = (v, label, on, lead = '') => `<button class="ed-opt ${on ? 'on' : ''}" data-ed="bset" data-k="${p}" ${v == null ? 'data-none="1"' : `data-v="${h(v)}"`}>${lead}<span>${label}</span>${on ? edSvg('check') : ''}</button>`;
  let title = '', body = opt(null, tr('（不改）', '(Keep)'), b[p] == null);
  if (p === 'project' || p === 'fund') {
    title = p === 'project' ? tr('报销项目', 'Project') : tr('资金来源', 'Funding');
    body += opt('', tr('（清空）', '(Clear)'), b[p] === '') + (p === 'project' ? projectNames() : fundNames()).map((n) => opt(n, h(n), b[p] === n)).join('')
      + `<div class="ed-new"><input id="ed-bnew" placeholder="${tr('新建', 'New')}" enterkeyhint="done" autocomplete="off"><button class="btn" data-ed="bnew" data-v="${p}">${tr('添加', 'Add')}</button></div>`;
  } else if (p === 'reimburse') {
    title = tr('报销', 'Reimburse');
    body += edReimburse().map((n, i) => opt(i, n, b.reimburse === i)).join('');
  } else if (p === 'categoryId') {
    title = tr('分类', 'Category');
    const cats = [...state.data.category.values()].sort((x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0) || x.id - y.id);
    for (const [inc, name] of [[false, tr('支出', 'Expense')], [true, tr('收入', 'Income')]]) {
      body += `<div class="muted small ed-grp">${name}</div>`;
      for (const top of cats.filter((c) => !c.parentId && !!c.isIncome === inc)) {
        body += opt(top.id, h(top.name), b.categoryId === top.id, iconTile(top.icon ?? 'tag', 'sm'));
        for (const s of cats.filter((c) => c.parentId === top.id)) body += `<div class="ed-indent">${opt(s.id, h(s.name), b.categoryId === s.id, iconTile(s.icon ?? top.icon ?? 'tag', 'sm'))}</div>`;
      }
    }
  }
  return `<div class="modal ed-lmodal" data-ed="pop-close"><div class="card ed-bcard" data-ed="noop"><div class="between"><b>${title}</b><button class="ed-x" data-ed="pop-x" aria-label="${tr('关闭', 'Close')}">✕</button></div><div class="ed-opts">${body}</div></div></div>`;
}

async function edBulkApply() {
  const plan = edBulkPlan(), b = ed.bulk;
  if (!plan.length || ed.busy) return;
  for (let i = 0; i < plan.length; i++) {
    ed.busy = tr(`保存中 ${i + 1}/${plan.length}`, `Saving ${i + 1}/${plan.length}`); edPaintLayer();
    try { await saveRecord('tx', plan[i].now); } catch (e) { ed.busy = ''; edPaintLayer(); render(); edToast(tr('没存完：', 'Not all saved: ') + e.message); return; }
  }
  if (b.project) rememberName('hl.projects', b.project);
  if (b.fund) rememberName('hl.funds', b.fund);
  edExitSelect(); render();
  edToast(tr(`已改 ${plan.length} 笔`, `Updated ${plan.length}`), async () => { for (const p of plan) await saveRecord('tx', p.old); });
}

async function edBulkDelete() {
  const list = [...state.sel].map((id) => state.data.tx.get(id)).filter(Boolean);
  if (!list.length || ed.busy || !confirm(tr(`删除 ${list.length} 笔？`, `Delete ${list.length} ${list.length === 1 ? 'entry' : 'entries'}?`))) return;
  for (let i = 0; i < list.length; i++) {
    ed.busy = tr(`删除中 ${i + 1}/${list.length}`, `Deleting ${i + 1}/${list.length}`); edPaintLayer();
    try { await deleteRecord('tx', list[i].id); } catch (e) { ed.busy = ''; edPaintLayer(); render(); edToast(tr('没删完：', 'Not all deleted: ') + e.message); return; }
  }
  edExitSelect(); render();
  edToast(tr(`已删除 ${list.length} 笔`, `Deleted ${list.length}`), async () => { for (const t of list) await saveRecord('tx', t); });
}

async function edLayerClick(ev) {
  const el = ev.target.closest('[data-ed]');
  if (!el) return;
  const a = el.dataset.ed, v = el.dataset.v;
  switch (a) {
    case 'noop': return;
    case 'undo': {
      const u = ed.toast?.undo;
      clearTimeout(ed.toastTimer); ed.toast = null; edPaintToast();
      if (u) { try { await u(); } catch (e) { state.error = e.message; } render(); }
      return;
    }
    case 'exit': edExitSelect(); return;
    case 'all': {
      const vis = edVisibleIds(), all = vis.length > 0 && vis.every((id) => state.sel.has(id));
      for (const id of vis) { if (all) state.sel.delete(id); else state.sel.add(id); }
      edPaintRows(); break;
    }
    case 'pick': ed.bulkPick = v; break;
    case 'pop-close': if (ev.target !== el) return; ed.bulkPick = null; break;
    case 'pop-x': ed.bulkPick = null; break;
    case 'bset': { const k = el.dataset.k; ed.bulk[k] = el.dataset.none ? null : k === 'categoryId' || k === 'reimburse' ? Number(v) : v; ed.bulkPick = null; break; }
    case 'bnew': { const name = ed.layer.querySelector('#ed-bnew')?.value.trim(); if (!name) return; ed.bulk[v] = name; ed.bulkPick = null; break; }
    case 'apply': edBulkApply(); return;
    case 'del': edBulkDelete(); return;
    case 'cf-no-bg': if (ev.target !== el) return; ed.confirm = null; break;
    case 'cf-no': ed.confirm = null; break;
    case 'cf-yes': { const t = ed.confirm, copy = ed.confirmCopy; ed.confirm = null; edPaintLayer(); if (t) await (copy ? edCopy(t) : edRemove(t)); return; }
    default: return;
  }
  edPaintLayer();
}

// ---------------------------------------------------------------- 侧滑和长按（只管手指，鼠标用"多选"按钮）
// 左滑删除、右滑复制。前 64px 跟手，之后像橡皮筋（只走 0.32 倍）；手指拉过行宽 55% 才"上膛"，
// 没上膛松手就弹回去什么都不做。上膛松手：复制直接做，删除先确认；两种都能撤销。

const sw = { row: null, x0: 0, y0: 0, dx: 0, mode: '', armed: false, lp: 0, swallow: 0, strip: null };
const SW_FOLLOW = 64, SW_RUBBER = 0.32, SW_ARM = 0.55;
function swRowAt(target) {
  const r = target?.closest?.('.row.click.ed-tx');
  return r && r.closest('#app') && !r.closest('.modal') ? r : null;
}
const swOffset = (d) => Math.sign(d) * (Math.abs(d) <= SW_FOLLOW ? Math.abs(d) : SW_FOLLOW + (Math.abs(d) - SW_FOLLOW) * SW_RUBBER);
function swPaint(row, d) {
  const x = swOffset(d), left = d < 0, armed = Math.abs(d) >= row.offsetWidth * SW_ARM;
  row.style.transition = 'none';
  row.style.transform = `translateX(${x}px)`;
  let s = sw.strip;
  if (!s || s.parentElement !== row) {
    s = sw.strip = document.createElement('div');
    s.className = 'ed-swstrip';
    s.innerHTML = '<span></span>';
    row.appendChild(s);
    (row.closest('.card') ?? row.parentElement)?.classList.add('ed-clip');
  }
  s.className = `ed-swstrip ${left ? 'del' : 'copy'}${armed ? ' armed' : ''}`;
  s.style.width = Math.abs(x) + 'px';
  s.querySelector('span').textContent = armed ? (left ? tr('松手删除', 'Release to delete') : tr('松手复制', 'Release to copy')) : tr('继续拉', 'Keep pulling');
  sw.armed = armed;
}
function swRelease(row) {
  row.style.transition = 'transform .45s cubic-bezier(.34, 1.56, .64, 1)';
  row.style.transform = '';
  const strip = sw.strip, box = row.closest('.card') ?? row.parentElement;
  sw.strip = null;
  if (strip) { strip.style.transition = 'width .45s cubic-bezier(.34, 1.56, .64, 1), opacity .3s'; strip.style.width = '0px'; strip.style.opacity = '0'; }
  setTimeout(() => { strip?.remove(); if (!sw.strip) box?.classList.remove('ed-clip'); if (row.isConnected) row.style.transition = ''; }, 460);
}

document.addEventListener('touchstart', (ev) => {
  if (ev.touches.length !== 1 || state.editing) { sw.row = null; return; }
  const row = swRowAt(ev.target);
  sw.row = row;
  if (!row) return;
  const t = ev.touches[0];
  sw.x0 = t.clientX; sw.y0 = t.clientY; sw.dx = 0; sw.mode = ''; sw.armed = false;
  clearTimeout(sw.lp);
  // 长按进多选（已经在多选里就是勾上 / 取消）
  sw.lp = setTimeout(() => {
    if (sw.row !== row || sw.mode) return;
    sw.mode = 'lp'; sw.swallow = Date.now() + 900;
    const id = Number(row.dataset.v);
    if (!state.sel) edSelect(new Set([id])); else edToggleSel(id);
  }, 500);
}, { passive: true });

document.addEventListener('touchmove', (ev) => {
  const row = sw.row;
  if (!row || sw.mode === 'v' || sw.mode === 'lp') return;
  const t = ev.touches[0], dx = t.clientX - sw.x0, dy = t.clientY - sw.y0;
  if (!sw.mode) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    clearTimeout(sw.lp);
    // 横向走得明显比竖向多才算侧滑，否则交给页面滚动
    sw.mode = !state.sel && Math.abs(dx) >= 14 && Math.abs(dx) > Math.abs(dy) * 1.6 ? 'h' : Math.abs(dy) >= 10 ? 'v' : '';
    if (sw.mode !== 'h') return;
    sw.x0 = t.clientX - Math.sign(dx) * 2;
  }
  ev.preventDefault();
  sw.dx = t.clientX - sw.x0;
  swPaint(row, sw.dx);
}, { passive: false });

function swEnd() {
  clearTimeout(sw.lp);
  const row = sw.row, mode = sw.mode, armed = sw.armed, d = sw.dx;
  sw.row = null; sw.mode = ''; sw.armed = false;
  if (!row || mode !== 'h') return;
  sw.swallow = Date.now() + 450;
  swRelease(row);
  if (!armed) return;
  const t = state.data.tx.get(Number(row.dataset.v));
  if (!t) return;
  // 删除和复制都要再确认一次，弹窗里把这一笔原样给你看
  ed.confirm = t; ed.confirmCopy = d > 0; edPaintLayer();
}
document.addEventListener('touchend', swEnd);
document.addEventListener('touchcancel', swEnd);
document.addEventListener('contextmenu', (ev) => { if (sw.mode === 'lp' || (sw.row && swRowAt(ev.target))) ev.preventDefault(); });

// 侧滑、长按之后跟着来的那一下点击不算；多选时点一行 = 勾上 / 取消
document.addEventListener('click', (ev) => {
  if (Date.now() < sw.swallow && swRowAt(ev.target)) { ev.stopPropagation(); ev.preventDefault(); sw.swallow = 0; return; }
  if (state.sel && !state.editing) {
    const row = swRowAt(ev.target);
    if (row) { ev.stopPropagation(); ev.preventDefault(); edToggleSel(Number(row.dataset.v)); }
  }
}, true);

// ---------------------------------------------------------------- 记账页里的输入

document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'e-note' || !state.editing) return;
  state.editing.note = ev.target.value;
  ev.target.style.height = 'auto'; ev.target.style.height = ev.target.scrollHeight + 'px';
});
// 打备注时收起自带键盘，让系统键盘上来（和手机端一样）
document.addEventListener('focusin', (ev) => { if (ev.target.id === 'e-note') ev.target.closest('.ed-sheet')?.classList.add('typing'); });
document.addEventListener('focusout', (ev) => { if (ev.target.id === 'e-note') setTimeout(() => document.querySelector('.ed-sheet')?.classList.remove('typing'), 120); });
// 电脑上点日期胶囊直接弹出日历
document.addEventListener('click', (ev) => { if (ev.target.id === 'e-date') { try { ev.target.showPicker(); } catch { /* 不支持就用浏览器自己的 */ } } });
// 电脑上也能直接用键盘打金额：回车保存，Esc 关掉
document.addEventListener('keydown', (ev) => {
  const e = state.editing;
  if (!e || ev.isComposing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === 'Enter' && (ev.target.id === 'ed-newname' || ev.target.id === 'ed-newtag')) {
    ev.preventDefault(); document.querySelector(ev.target.id === 'ed-newname' ? '[data-act="ed-newname"]' : '[data-act="ed-tags-done"]')?.click(); return;
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName)) return;
  const k = /^[0-9]$/.test(ev.key) ? ev.key : ev.key === '.' || ev.key === ',' ? '.' : ev.key === '+' ? '+' : ev.key === '-' ? '−'
    : ev.key === '*' ? '×' : ev.key === '/' ? '÷' : ev.key === 'Backspace' ? '⌫' : null;
  if (k) { ev.preventDefault(); edPress(k); }
  else if (ev.key === 'Enter') { ev.preventDefault(); saveEditing(); }
  else if (ev.key === 'Escape') { if (e._pick) e._pick = null; else { state.editing = null; state.error = ''; } edRefresh(); }
});
// 长按退格 = 清空
{
  let t = 0;
  document.addEventListener('pointerdown', (ev) => {
    const b = ev.target.closest?.('.ed-key[data-v="⌫"]');
    if (!b) return;
    clearTimeout(t);
    t = setTimeout(() => { edPress('C'); sw.swallowKey = Date.now() + 600; }, 550);
  });
  for (const n of ['pointerup', 'pointercancel', 'pointerleave']) document.addEventListener(n, () => clearTimeout(t));
}

// ---------------------------------------------------------------- 登记

MOD.homeCards.push(() => `<div class="ed-listbar"><button class="btn ed-selbtn" data-act="ed-sel-start">${edSvg('check')}${tr('多选', 'Select')}</button></div>`);

MOD.changes.push(async (ev) => {
  if (ev.target.id !== 'e-date' || !state.editing) return false;
  if (ev.target.value) state.editing.date = isoToDay(ev.target.value);
  // 不整页重画：iPhone 上日期面板还开着，只改胶囊上的字
  const label = ev.target.parentElement?.querySelector('span');
  if (label) label.textContent = edDayName(state.editing.date);
  return true;
});

MOD.actions.push(async (act, v, el) => {
  if (act === 'ed-sel-start') { edSelect(new Set()); return true; }
  if (!act.startsWith('ed-')) return false;
  const e = state.editing;
  if (!e) return true;
  switch (act) {
    case 'ed-key': if (v === '⌫' && Date.now() < (sw.swallowKey ?? 0)) return true; edPress(v); return true;
    case 'ed-again': await saveEditing(true); return true;
    case 'ed-cat': e.categoryId = Number(v); break;
    case 'ed-sub': { const { top, leafId } = edCats(e); e.categoryId = leafId === Number(v) ? top.id : Number(v); break; }
    case 'ed-pick': e._pick = v; break;
    case 'ed-pick-close': e._pick = null; break; // 面板里面的点击会先碰到 data-act="noop"，到这里的只有背景
    case 'ed-pick-x': e._pick = null; break;
    case 'ed-set': {
      const k = el.dataset.k;
      e[k] = k === 'excluded' ? v === '1' : k === 'project' || k === 'fund' ? v : Number(v);
      e._pick = null; break;
    }
    case 'ed-tag': { const on = edTags(e); e.tags = (on.includes(v) ? on.filter((x) => x !== v) : [...on, v]).join(' '); break; }
    case 'ed-tags-done': {
      const add = (document.getElementById('ed-newtag')?.value ?? '').split(/[\s#,，]+/).filter(Boolean);
      e.tags = [...new Set([...edTags(e), ...add])].join(' '); e._pick = null; break;
    }
    case 'ed-newname': { const name = document.getElementById('ed-newname')?.value.trim(); if (!name) return true; e[v] = name; e._pick = null; break; }
    default: return false;
  }
  edRefresh();
  return true;
});
