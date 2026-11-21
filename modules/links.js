// 关联：退款 / 补贴 / 代付收回 / 报销 ⇄ 支出，以及信用卡还款（和手机端同一套规则，改这里要两边一起改）
// 1. 智能推荐：本地打分，最多 5 条，每条一个小理由（金额相同、同一商家、3 天前…）
// 2. 搜索全部：所有账本、所有时间，用全局搜索同一套匹配（more.js 的 searchText）
// 3. 关联关系照旧写在收入那一笔的 offsetOf / offsetParts 上；"报销"收入关联的支出标成已报销，取消关联时改回待报销
// 4. 信用卡账户详情的"还款"：打开记账页，转账到这张卡，金额是现在欠的钱
// 记账页里的两个面板（edPop 的 'offset' / 'links'）和账单详情页的面板（state.lk）都用 lkSheet() 画。
'use strict';

const LK_DAYS = 120, LK_MAX = 5;
/** 能拿来抵扣 / 关联支出的收入分类（一级分类名，中文或默认英文名）。 */
const LK_INCOME_CATS = ['退款', '代付收回', '代付退还', '补贴', '消费返现', '报销'];
const lkCatOk = (name) => LK_INCOME_CATS.includes(name) || LK_INCOME_CATS.some((zh) => DEFAULT_INCOME.find(([z]) => z === zh)?.[1] === name);

const lkTopName = (t) => { const c = state.data.category.get(t.categoryId); const top = c?.parentId ? state.data.category.get(c.parentId) ?? c : c; return top?.name ?? ''; };
/** "报销"收入（关联的支出不抵扣，只标已报销）。 */
const lkIsClaim = (t) => t.kind === KIND.INCOME && lkTopName(t) === '报销';
/** 这笔收入关联了哪些支出、各多少分（只认还存在的支出；和 Lookup.parts 一样）。 */
function lkList(t) {
  if (t.kind !== KIND.INCOME) return [];
  const list = t.offsetParts
    ? String(t.offsetParts).split(',').map((p) => p.split(':').map(Number)).filter(([id, c]) => id && c > 0)
    : t.offsetOf > 0 ? [[t.offsetOf, t.amountCents]] : [];
  return list.filter(([id]) => state.data.tx.get(id)?.kind === KIND.EXPENSE);
}
/** 这笔支出还有多少没被同一类收入盖住（claim：只算报销收入，否则只算退款补贴这类），不算 except 那一笔收入。 */
const lkOpen = (exp, claim, except = 0, cover = lkCoverMap(claim, except)) => exp.amountCents - (cover.get(exp.id) ?? 0);
/** 支出 id → 被同一类收入（claim 或不是）盖住了多少，不算 except 那一笔收入。 */
function lkCoverMap(claim, except = 0) {
  const m = new Map();
  for (const t of state.data.tx.values()) {
    if (t.kind !== KIND.INCOME || t.id === except || lkIsClaim(t) !== claim) continue;
    for (const [id, c] of lkList(t)) m.set(id, (m.get(id) ?? 0) + c);
  }
  return m;
}
/** 这笔收入还没分给支出的钱。 */
const lkFree = (inc) => inc.amountCents - lkList(inc).reduce((s, [, c]) => s + c, 0);

// ---------------------------------------------------------------- 打分

/** 分词：中文按相邻两个字（只有一个字时就是这个字），拉丁字母按单词（两个字母以上，小写）。数字不算。 */
function lkTokens(text) {
  const s = String(text ?? '').toLowerCase(), out = new Set();
  for (const run of s.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  for (const w of s.match(/[a-z]{2,}/g) ?? []) out.add(w);
  return out;
}
/** 一笔账拿来比的字：备注 + 标签（"商家"那部分），分类名（中文名和显示名）。按对象缓存。 */
const lkTokCache = new WeakMap();
function lkWords(t) {
  let w = lkTokCache.get(t);
  if (!w) {
    const c = state.data.category.get(t.categoryId), top = c?.parentId ? state.data.category.get(c.parentId) : null;
    const names = [c, top].filter(Boolean).flatMap((x) => [x.name, typeof edCatName === 'function' ? edCatName(x) : x.name]).join(' ');
    const note = lkTokens(`${t.note ?? ''} ${t.tags ?? ''}`);
    w = { note, all: new Set([...note, ...lkTokens(names)]) };
    lkTokCache.set(t, w);
  }
  return w;
}
const lkCount = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

/**
 * 一对（收入 inc，支出 exp）的分数和理由；不合格返回 null。side = 'exp'：给收入找支出（理由里写"N 天前"），'inc'：给支出找收入（"N 天后"）。
 * 规则见文件末尾的说明（和手机端一致）。
 */
function lkScore(inc, exp, side) {
  const days = inc.date - exp.date;
  if (days < 0 || days > LK_DAYS) return null;
  const claim = lkIsClaim(inc);
  const exact = inc.amountCents === exp.amountCents || (!!inc.currency && inc.currency === exp.currency && inc.origCents > 0 && inc.origCents === exp.origCents);
  const below = !exact && inc.amountCents < exp.amountCents;
  const wi = lkWords(inc), we = lkWords(exp);
  const shared = lkCount(wi.all, we.all), sameNote = lkCount(wi.note, we.note) > 0;
  const project = claim && !!inc.project && inc.project === exp.project;
  const pending = claim && exp.reimburse === 1;
  if (!(exact || shared > 0 || project || pending || (below && days <= 14))) return null;
  let score = exact ? 100 : below ? 40 : 0;
  score += Math.min(3, shared) * 15;
  if (inc.accountId === exp.accountId) score += 10;
  score += Math.round(30 * (LK_DAYS - days) / LK_DAYS);
  if (claim) score += (exp.reimburse === 1 ? 30 : exp.reimburse === 2 ? -30 : 0) + (project ? 25 : 0);
  const reason = exact ? tr('金额相同', 'Same amount') : project ? tr('同一项目', 'Same project') : sameNote ? tr('同一商家', 'Same merchant')
    : shared ? tr('名称相近', 'Similar name') : pending ? tr('待报销', 'To claim')
    : days === 0 ? tr('当天', 'Same day') : side === 'exp' ? tr(`${days} 天前`, `${days}d before`) : tr(`${days} 天后`, `${days}d later`);
  return { score, reason, days };
}

/**
 * 智能推荐，最多 5 条：side 'exp' = 给收入 subj 找支出；'inc' = 给支出 subj 找收入。skip：已经关联 / 选了的 id。
 * 返回 [{ t, reason }]，分高的在前，同分时日期近的在前，再同就新记的在前。
 */
function lkSuggest(subj, side, skip = new Set()) {
  const out = [], claim = side === 'exp' && lkIsClaim(subj), cover = side === 'exp' ? lkCoverMap(claim, subj.id) : null;
  for (const t of state.data.tx.values()) {
    if (t.id === subj.id || skip.has(t.id) || t.excluded) continue;
    const days = side === 'exp' ? subj.date - t.date : t.date - subj.date;
    if (days < 0 || days > LK_DAYS) continue;
    if (side === 'exp') {
      if (t.kind !== KIND.EXPENSE || lkOpen(t, claim, subj.id, cover) <= 0) continue;
      const s = lkScore(subj, t, side);
      if (s) out.push({ t, ...s });
    } else {
      if (t.kind !== KIND.INCOME || !lkCatOk(lkTopName(t)) || lkFree(t) <= 0) continue;
      const s = lkScore(t, subj, side);
      if (s) out.push({ t, ...s });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.days - b.days || b.t.id - a.t.id).slice(0, LK_MAX);
}

/** 搜索全部：side 'exp' 搜支出，'inc' 搜收入；所有账本、所有时间，新的在前，最多 100 笔。没输入时给离这笔日期最近的 30 笔（新的在前）。 */
function lkSearch(subj, side, q) {
  const kind = side === 'exp' ? KIND.EXPENSE : KIND.INCOME, L = computeLookup();
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const pool = [...state.data.tx.values()].filter((t) => t.kind === kind && t.id !== subj.id);
  const order = (a, b) => b.date - a.date || (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id - a.id;
  if (!words.length) return pool.sort((a, b) => Math.abs(a.date - subj.date) - Math.abs(b.date - subj.date) || order(a, b)).slice(0, 30).sort(order);
  const text = typeof searchText === 'function' ? (t) => searchText(t, L) : (t) => `${t.note ?? ''} ${(t.amountCents / 100).toFixed(2)} ${dayISO(t.date)}`.toLowerCase();
  return pool.filter((t) => { const s = text(t); return words.every((w) => s.includes(w)); }).sort(order).slice(0, 100);
}

// ---------------------------------------------------------------- 面板

const lkRowHtml = (t, L, act, on, chip = '') => `<div class="ed-offpick lk-pick ${on ? 'on' : ''}" data-act="${act}" data-v="${t.id}"><div class="muted ed-offdate lk-date"><span>${dayISO(t.date)}</span>${chip ? `<span class="lk-chip">${h(chip)}</span>` : ''}</div>${txRow(t, L).replace('data-act="view"', '').replace('row click', 'row')}</div>`;

/** 搜索结果：按月分组。 */
function lkResults(o) {
  const L = computeLookup(), list = lkSearch(o.subj, o.side, o.q);
  if (!list.length) return `<div class="muted small ed-none">${tr('无匹配结果', 'No match')}</div>`;
  let ym = '', html = '';
  for (const t of list) {
    const d = dayToDate(t.date), k = ymLabel(d.getUTCFullYear(), d.getUTCMonth() + 1);
    if (k !== ym) { ym = k; html += `<div class="muted small ed-grp">${k}</div>`; }
    html += lkRowHtml(t, L, o.act, o.picked.has(t.id));
  }
  return html;
}

/**
 * 关联面板的内容：上面智能推荐，下面一条搜索框（搜全部），结果在它下面。
 * o = { side: 'exp' | 'inc', subj（这笔收入 / 支出，可以是记账页里还没存的样子）, picked: Set, q, act（点一行的 data-act）, qid（搜索框 id） }
 */
function lkSheet(o) {
  const L = computeLookup(), sug = lkSuggest(o.subj, o.side, o.picked);
  return `<div class="muted small lk-h">${tr('智能推荐', 'Suggested')}</div>
    ${sug.length ? sug.map((s) => lkRowHtml(s.t, L, o.act, false, s.reason)).join('') : `<div class="muted small ed-none">${tr('未找到相近账单', 'Nothing similar found')}</div>`}
    <div class="muted small lk-h">${tr('搜索全部', 'Search all')}</div>
    <label class="ed-search lk-search">${typeof ED_SEARCH_SVG === 'string' ? ED_SEARCH_SVG : ''}<input id="${o.qid}" value="${h(o.q ?? '')}" placeholder="${tr('备注、分类、账户、金额、日期', 'Note, category, account, amount, date')}" autocomplete="off" enterkeyhint="search" aria-label="${tr('搜索全部', 'Search all')}"></label>
    <div class="lk-res">${lkResults(o)}</div>`;
}

/** 记账页里的那笔（还没存）当成一笔账来打分。 */
function lkFromEditing(e) {
  const c = typeof edCheck === 'function' ? edCheck(e) : { cents: 0, cur: HOME, home: 0 };
  const foreign = c.cur !== HOME;
  return { ...e, amountCents: c.home ?? 0, currency: foreign ? c.cur : '', origCents: foreign ? c.cents ?? 0 : 0, categoryId: typeof edCats === 'function' ? edCats(e).leafId : e.categoryId };
}

/** 记账页里两个面板：收入选支出（点了先放进抵扣列表，保存时才写）、支出选收入（点了直接写到那笔收入上）。 */
function lkEditorSheet(e) {
  const subj = lkFromEditing(e);
  if (e._pick === 'offset') return lkSheet({ side: 'exp', subj, picked: new Set((e._offs ?? []).map(([id]) => id)), q: e._q, act: 'ed-off-add', qid: 'ed-q' });
  return lkSheet({ side: 'inc', subj, picked: lkLinkedIncomes(e.id), q: e._q, act: 'ed-lk-add', qid: 'ed-q' });
}
const lkLinkedIncomes = (expId) => new Set([...state.data.tx.values()].filter((t) => lkList(t).some(([id]) => id === expId)).map((t) => t.id));

/** 账单详情页上的面板（state.lk = { id, q }）。 */
function lkDetailSheet() {
  const t = state.lk && state.data.tx.get(state.lk.id);
  if (!t || state.view !== t.id) return '';
  const side = t.kind === KIND.INCOME ? 'exp' : 'inc';
  const picked = side === 'exp' ? new Set(lkList(t).map(([id]) => id)) : lkLinkedIncomes(t.id);
  const title = side === 'exp' ? tr('关联支出', 'Linked expenses') : tr('退款 · 报销 · 代付收回', 'Refund · claim · paid back');
  return `<div class="modal lk-modal" data-act="lk-bg"><div class="card lk-card" data-act="noop" role="dialog" aria-label="${h(title)}">
    <div class="between"><b>${title}</b><button class="ed-x" data-act="lk-x" aria-label="${tr('关闭', 'Close')}">✕</button></div>
    <div class="ed-opts">${lkSheet({ side, subj: t, picked, q: state.lk.q, act: 'lk-add', qid: 'lk-q' })}</div></div></div>`;
}

// ---------------------------------------------------------------- 写入

/** 把关联列表写回收入（和记账页保存时同一个规则）：一笔且是全额 → offsetOf；否则 offsetParts "id:分,id:分"；全去掉 → offsetOf = -1。 */
function lkEncode(inc, list) {
  const offs = list.filter(([, c]) => c > 0);
  return {
    ...inc,
    offsetOf: offs.length ? offs[0][0] : -1,
    offsetParts: !offs.length || (offs.length === 1 && offs[0][1] === inc.amountCents) ? '' : offs.map(([id, c]) => `${id}:${c}`).join(','),
  };
}

/**
 * 报销收入存好之后（before = 存之前的样子，没有就 null；after = 存之后的，删掉了就 null）：
 * 新关联上的支出标成已报销（2）；不再关联、现在是已报销、也没有别的报销收入关联它的，改回待报销（1）。返回改之前的那些支出（撤销用）。
 */
async function lkSyncClaims(before, after) {
  const ids = (t) => (t && lkIsClaim(t) ? new Set(lkList(t).map(([id]) => id)) : new Set());
  const was = ids(before), now = ids(after), old = [];
  for (const id of now) {
    const x = state.data.tx.get(id);
    if (!was.has(id) && x && x.reimburse !== 2) { old.push(x); await saveRecord('tx', { ...x, reimburse: 2 }); }
  }
  for (const id of was) {
    const x = state.data.tx.get(id);
    if (now.has(id) || !x || x.reimburse !== 2) continue;
    const other = [...state.data.tx.values()].some((t) => t.id !== (after?.id ?? before.id) && lkIsClaim(t) && lkList(t).some(([e]) => e === id));
    if (!other) { old.push(x); await saveRecord('tx', { ...x, reimburse: 1 }); }
  }
  return old;
}

/** 存一笔收入的新关联，连带报销标记；底部提示可以撤销。 */
async function lkWrite(before, after, text) {
  try {
    await saveRecord('tx', after);
    const old = await lkSyncClaims(before, after);
    const e = state.editing;
    if (e) { const x = old.find((t) => t.id === e.id); if (x) e.reimburse = state.data.tx.get(e.id)?.reimburse ?? e.reimburse; }
    render();
    edToast(text, async () => {
      await saveRecord('tx', before);
      for (const x of old) await saveRecord('tx', x);
      if (state.editing) { const x = old.find((t) => t.id === state.editing.id); if (x) state.editing.reimburse = x.reimburse; }
    });
  } catch (err) { state.error = err.message; render(); }
}

/**
 * 把收入 incId 关联到支出 expId（详情页、支出那边点了直接写）。分多少和记账页里"再加一笔支出"一样：
 * 还没关联 → 整笔给它；原来整笔给了一笔 → 先把那一笔定成它还没被盖住的部分（不超过整笔），新的拿剩下的、最多到它没被盖住的部分；
 * 原来已经分摊 → 新的拿没分完的、最多到它没被盖住的部分。拿到 0 就不连，提示"这笔已经分完了"。
 */
async function lkLink(incId, expId) {
  const inc = state.data.tx.get(incId), exp = state.data.tx.get(expId);
  if (!inc || !exp || inc.kind !== KIND.INCOME || exp.kind !== KIND.EXPENSE) return;
  const list = lkList(inc), total = inc.amountCents, claim = lkIsClaim(inc);
  if (list.some(([id]) => id === expId)) return;
  const want = Math.max(0, lkOpen(exp, claim, inc.id));
  let next;
  if (!list.length) next = [[expId, total]];
  else if (list.length === 1 && !inc.offsetParts) {
    const first = state.data.tx.get(list[0][0]), firstGive = Math.min(total, Math.max(0, lkOpen(first, claim, inc.id)));
    next = [[first.id, firstGive], [expId, Math.max(0, Math.min(total - firstGive, want))]];
  } else {
    const given = list.reduce((s, [, c]) => s + c, 0);
    next = [...list, [expId, Math.max(0, Math.min(total - given, want))]];
  }
  if (!(next[next.length - 1][1] > 0)) { edToast(tr('该笔已全部关联', 'Nothing left to link')); return; }
  await lkWrite(inc, lkEncode(inc, next), tr('已关联', 'Linked'));
}
/** 取消收入 incId 和支出 expId 的关联。 */
async function lkUnlink(incId, expId) {
  const inc = state.data.tx.get(incId);
  if (!inc) return;
  const list = lkList(inc);
  if (!list.some(([id]) => id === expId)) return;
  await lkWrite(inc, lkEncode(inc, list.filter(([id]) => id !== expId)), tr('已取消关联', 'Unlinked'));
}

// ---------------------------------------------------------------- 卡片（记账页、详情页）

/** 一行已关联的账单 + 右下角"移除"。open：点这一行做什么（data-act）。 */
const lkLinkedRow = (t, L, open, inc, exp) => `<div class="lk-linked">${txRow(t, L).replace('data-act="view"', `data-act="${open}"`)}
  <div class="lk-rmline"><button class="btn link muted" data-act="${open === 'ed-open' ? 'ed-lk-rm' : 'lk-rm'}" data-v="${inc}:${exp}">${tr('移除', 'Remove')}</button></div></div>`;

/** 支出下面那块：退款 · 报销 · 代付收回，已经关联的几笔、"选择"（推荐 + 搜索）、新建四种。inEditor：在记账页里。 */
function lkExpenseBox(exp, L, inEditor) {
  const linked = [...state.data.tx.values()].filter((t) => L.parts(t).some(([id]) => id === exp.id)).sort((a, b) => a.date - b.date);
  const off = L.offsets.get(exp.id) ?? 0;
  const n = lkSuggest(inEditor ? lkFromEditing(state.editing) : exp, 'inc', new Set(linked.map((t) => t.id))).length;
  const open = inEditor ? 'ed-open' : 'view';
  const add = (k, zh, en) => `<button class="btn link" data-act="${inEditor ? 'ed-offset' : 'view-offset'}" data-v="${k}">${tr(`＋ ${zh}`, `＋ ${en}`)}</button>`;
  return `<div class="${inEditor ? 'ed-box ed-offs' : 'dt-links'} lk-box"><div class="muted small">${tr('退款 · 报销 · 代付收回', 'Refund · claim · paid back')}${off > 0 ? `<span class="lk-net">${tr(`实际 ${money(exp.amountCents - off)}`, `Net ${money(exp.amountCents - off)}`)}</span>` : ''}</div>
    ${linked.map((t) => lkLinkedRow(t, L, open, t.id, exp.id)).join('')}
    <div class="lk-btns"><button class="btn lk-pickbtn" data-act="${inEditor ? 'ed-pick' : 'lk-open'}" data-v="links">${tr('选择', 'Choose')}${n ? `<span class="lk-n">${n}</span>` : ''}</button>
      <span class="muted small">${tr('新建', 'New')}</span>${add('补贴', '补贴', 'Subsidy')}${add('退款', '退款', 'Refund')}${add('代付收回', '代付收回', 'Paid back')}${add('报销', '报销', 'Claim')}</div></div>`;
}

/** 收入详情页：关联支出，"选择"打开面板。 */
function lkIncomeBox(inc, L) {
  const linked = L.parts(inc).map(([id]) => state.data.tx.get(id)).filter(Boolean);
  const n = lkSuggest(inc, 'exp', new Set(linked.map((t) => t.id))).length;
  return `<div class="dt-links lk-box"><div class="muted small">${tr('关联支出', 'Linked expenses')}</div>
    ${linked.map((t) => lkLinkedRow(t, L, 'view', inc.id, t.id)).join('')}
    <div class="lk-btns"><button class="btn lk-pickbtn" data-act="lk-open">${tr('选择', 'Choose')}${n ? `<span class="lk-n">${n}</span>` : ''}</button></div></div>`;
}

// ---------------------------------------------------------------- 信用卡还款

/** 还款从哪个账户出：最近一次还信用卡用的（非信用卡、没归档）；没有就用得最多的非信用卡账户；再没有就第一个别的账户。 */
function lkRepayFrom(card) {
  const accs = [...state.data.account.values()].filter((a) => !a.archived && a.id !== card.id).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const ok = accs.filter((a) => (a.type ?? 0) !== 2), byId = new Map(ok.map((a) => [a.id, a]));
  const txs = [...state.data.tx.values()];
  const last = txs.filter((t) => t.kind === KIND.TRANSFER && byId.has(t.accountId) && state.data.account.get(t.toAccountId)?.type === 2)
    .sort((a, b) => b.date - a.date || (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id - a.id)[0];
  if (last) return byId.get(last.accountId);
  const n = new Map();
  for (const t of txs) if (byId.has(t.accountId)) n.set(t.accountId, (n.get(t.accountId) ?? 0) + 1);
  return ok.slice().sort((a, b) => (n.get(b.id) ?? 0) - (n.get(a.id) ?? 0))[0] ?? accs[0] ?? null;
}

/** 打开记账页：转账，从 lkRepayFrom → 这张卡，金额 = 欠的钱（卡的币种），今天，备注"信用卡还款"。 */
function lkStartRepay(cardId) {
  const card = state.data.account.get(Number(cardId));
  if (!card || typeof startEditWith !== 'function') return;
  const bal = balanceOf(card, [...state.data.tx.values()]), debt = bal < 0 ? -bal : 0, from = lkRepayFrom(card);
  state.error = '';
  startEditWith({ kind: KIND.TRANSFER, accountId: from?.id ?? card.id, toAccountId: card.id, date: today(), note: tr('信用卡还款', 'Card repayment'),
    amount: debt || null, currency: from && acctCur(from) !== acctCur(card) ? acctCur(card) : null });
}
/** 还款日（共享设置 cardDue）。 */
const lkDueDay = (a) => Number((typeof shared !== 'undefined' ? shared.get('cardDue', {}) : {})?.[String(a.id)] ?? 0) || 0;

// ---------------------------------------------------------------- 事件

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.id === 'lk-q' && state.lk) {
    state.lk.q = el.value;
    const t = state.data.tx.get(state.lk.id), box = el.closest('.lk-card')?.querySelector('.lk-res');
    if (t && box) box.innerHTML = lkResults({ side: t.kind === KIND.INCOME ? 'exp' : 'inc', subj: t, picked: t.kind === KIND.INCOME ? new Set(lkList(t).map(([id]) => id)) : lkLinkedIncomes(t.id), q: el.value, act: 'lk-add' });
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.id === 'lk-q') { ev.preventDefault(); ev.target.blur(); }
  else if (ev.key === 'Escape' && state.lk && !state.editing) { state.lk = null; render(); }
});

MOD.actions.push(async (act, v, el) => {
  switch (act) {
    case 'acc-pay': lkStartRepay(v); return true;
    case 'lk-open': if (state.view == null) return true; state.lk = { id: state.view, q: '' }; break;
    case 'lk-x': state.lk = null; break;
    case 'lk-bg': if (el !== lastClickTarget) return true; state.lk = null; break;
    case 'lk-add': {
      const t = state.lk && state.data.tx.get(state.lk.id);
      state.lk = null;
      if (!t) break;
      if (t.kind === KIND.INCOME) await lkLink(t.id, Number(v)); else await lkLink(Number(v), t.id);
      return true;
    }
    case 'lk-rm': case 'ed-lk-rm': { const [inc, exp] = String(v).split(':').map(Number); await lkUnlink(inc, exp); return true; }
    case 'ed-lk-add': {
      const e = state.editing;
      if (!e) return true;
      e._pick = null;
      await lkLink(Number(v), e.id);
      return true;
    }
    default: return false;
  }
  render();
  return true;
});

/*
 * 打分规则（手机端照抄）：收入 I、支出 E，days = I.date − E.date，只看 0 ≤ days ≤ 120。
 *   金额：I 和 E 金额相同（或原币种相同且原币金额相同）+100；否则 I 比 E 少 +40；否则 0
 *   文字：两边（备注 + 标签 + 分类名）分词后相同的词，每个 +15，最多 3 个
 *   同一付款账户 +10；日期 round(30 × (120 − days) / 120)
 *   I 是报销收入：E 待报销 +30、已报销 −30；I 填了项目且 E 同项目 +25
 *   至少要有一条：金额相同 / 有相同的词 / 同项目（报销）/ 待报销（报销）/ 金额更少且 days ≤ 14，否则不推荐
 *   排除：标了"不计入收支"的；给收入找支出时，E 已经被同一类收入（报销 / 非报销分开算）盖满的；给支出找收入时，I 不在退款、代付收回、代付退还、补贴、消费返现、报销这几类，或者已经分完的
 *   理由（一个）：金额相同 > 同一项目 > 同一商家（备注标签里有相同的词）> 名称相近 > 待报销 > 当天 / N 天前（N 天后）
 */
