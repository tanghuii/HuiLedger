// 辉记账本网页版：要用到 AI 的那些功能（一句话记账 / 问账本、月度复盘的总结、对账时读银行账单），以及净资产曲线、修正余额。
// 这个页面没有服务器，所以是浏览器直接连 Claude API：密钥只存在这台电脑这个浏览器的本地存储里，
// 请求直接发给 api.anthropic.com，不经过任何别的地方。这个文件在 app.js 之前加载，只放函数。
'use strict';

const AI_MODEL_DEFAULT = 'claude-opus-5-5';
const aiKey = () => store.get('hl.apiKey', '');
const aiModel = () => store.get('hl.model', '') || AI_MODEL_DEFAULT;

class AiError extends Error {}

/**
 * 发一次请求，让模型按 schema 返回 JSON。content 可以是字符串，也可以是内容块数组（带 PDF 时）。
 * 被安全策略拒绝时开了服务端的备用模型（fallbacks），仍然被拒就报错。
 */
async function aiJson(system, content, schema, maxTokens = 16000) {
  if (!aiKey()) throw new AiError('还没有填 Claude API 密钥，点右上角的"AI 设置"。');
  const body = {
    model: aiModel(), max_tokens: maxTokens, system,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema } },
    fallbacks: 'default',
  };
  const send = (b, beta) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-api-key': aiKey(), 'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true', ...(beta ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
    },
    body: JSON.stringify(b),
  });
  let res;
  try {
    res = await send(body, true);
    // 这个模型或账号不支持备用模型参数时，去掉它再发一次
    if (res.status === 400) {
      const text = await res.clone().text();
      if (/fallback/i.test(text)) { const { fallbacks, ...plain } = body; res = await send(plain, false); }
    }
  } catch { throw new AiError('连不上 Claude，请检查网络。'); }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new AiError('API 密钥不对。');
    if (res.status === 429) throw new AiError('请求太频繁或额度用完了，稍后再试。');
    if (res.status === 529 || res.status >= 500) throw new AiError('Claude 暂时繁忙，稍后再试。');
    throw new AiError('请求失败：' + msg);
  }
  if (json.stop_reason === 'refusal') throw new AiError('AI 拒绝处理这段内容。');
  if (json.stop_reason === 'max_tokens') throw new AiError('内容太长，AI 没写完。');
  const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text); } catch { throw new AiError('AI 返回的结果读不懂，请重试。'); }
}

function aiSettingsView() {
  return `<div class="modal" data-act="ai-close"><div class="card grid" role="dialog" aria-label="AI 设置">
    <b style="font-size:18px">AI 设置</b>
    <label class="f">Claude API 密钥<input id="ai-key" type="password" autocomplete="off" placeholder="${aiKey() ? '已保存，留空表示不改' : 'sk-ant-…'}"></label>
    <label class="f">模型<input id="ai-model" value="${h(aiModel())}" autocomplete="off"></label>
    <p class="muted small" style="margin:0">密钥只存在这个浏览器里，请求直接发给 Anthropic。问账本时会把近 24 个月的账单文字发过去。公用电脑上不要保存密钥。</p>
    <div class="between"><span>${aiKey() ? '<button class="btn danger" data-act="ai-clear">清除密钥</button>' : ''}</span><span><button class="btn" data-act="ai-close-btn">取消</button> <button class="btn primary" data-act="ai-save">保存</button></span></div>
  </div></div>`;
}

// ---------------------------------------------------------------- 一句话记账 / 问账本

const stripIban = (s) => String(s ?? '').replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, '…');

function ledgerText(L) {
  const now = today(), from = now - 730;
  const rows = allTxs().filter((t) => t.ledgerId === state.ledgerId && t.date >= from).sort(byNewest);
  const acc = state.data.account, cat = state.data.category;
  const lines = rows.map((t, i) => [
    i + 1, dayISO(t.date), ['支出', '收入', '转账'][t.kind], (L.net(t) / 100).toFixed(2), L.top(t.categoryId)?.name ?? '', cat.get(t.categoryId)?.parentId ? cat.get(t.categoryId).name : '',
    acc.get(t.accountId)?.name ?? '', acc.get(t.toAccountId)?.name ?? '', t.tags ?? '', L.isReimburse(t) ? '报销' : '', t.excluded ? '不计' : '', stripIban(t.note).replace(/[\n,]/g, ' ').slice(0, 40),
  ].join(','));
  return { rows, text: '行号,日期,类型,净额,一级分类,子分类,账户,转入账户,标签,报销,不计,备注\n' + lines.join('\n') };
}

const ASK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['intent', 'answer', 'related', 'date', 'amount', 'currency', 'type', 'category', 'subcategory', 'account', 'to_account', 'note', 'tags'],
  properties: {
    intent: { type: 'string', enum: ['record', 'answer'] }, answer: { type: 'string' }, related: { type: 'array', items: { type: 'integer' } },
    date: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' }, type: { type: 'string', enum: ['expense', 'income', 'transfer'] },
    category: { type: 'string' }, subcategory: { type: 'string' }, account: { type: 'string' }, to_account: { type: 'string' }, note: { type: 'string' }, tags: { type: 'string' },
  },
};

async function askLedger(question) {
  const L = computeLookup(), data = ledgerText(L);
  const cats = [...state.data.category.values()];
  const names = (income) => cats.filter((c) => !c.parentId && !!c.isIncome === income).map((c) => { const subs = cats.filter((s) => s.parentId === c.id).map((s) => s.name); return subs.length ? `${c.name}（${subs.join('、')}）` : c.name; }).join('；');
  const accounts = [...state.data.account.values()];
  const txs = allTxs();
  const system = `你是一个记账应用里的助手。用户会说一句话，你要判断他是想记一笔账，还是在问账本里的事。

一、如果是记一笔账（比如"昨天在超市买菜 12.5 用 ING""收到工资 2000 进 ING""从 ING 转 200 到 Revolut"）：
intent 填 "record"，并填好 date、amount、currency、type、category、subcategory、account、to_account、note、tags。
- 今天是 ${dayISO(today())}。"昨天""上周五"这类说法换算成具体日期，格式 YYYY-MM-DD；没说日期就是今天。
- amount 是正数。currency 没说就是 ${HOME}。
- type 是 expense、income 或 transfer。自己账户之间挪钱是 transfer，这时 account 是转出账户，to_account 是转入账户，category 留空。
- category 必须从下面的名单里选一级分类的名字；括号里是它的子分类，合适的话 subcategory 填其中一个，否则留空。
  支出分类：${names(false)}
  收入分类：${names(true)}
- account、to_account 必须是下面账户名单里的名字，一字不差；用户没说或对不上就留空，不要猜。
  账户：${accounts.map((a) => a.name).join('、')}
- note 写商户或事由，简短；tags 是空格分隔的标签，用户没提就留空。answer 留空，related 给空数组。

二、如果是在问账本（比如"今年在 AI 工具上花了多少""上个月买菜比前一个月多多少"）：
intent 填 "answer"，answer 用和用户同一种语言写，简短：先给数字，再用一句话说是怎么算的（哪段时间、哪些分类、几笔）。
related 给出最相关的账单的行号，最多 8 个，没有就给空数组。其余字段：amount 填 0，文字字段留空，type 填 expense。
- 只根据下面的账本数据回答，算不出来就直说，不要编。金额单位是 ${HOME}。
- 口径：标了"报销"的是替别人垫付再拿回来的钱，标了"不计"的是借还款之类，这两种都不算进收入和支出，除非用户专门问它们。
  转账不是收支。一级分类是"退款"或"代付收回"的收入不算收入，要从同期的支出里扣掉。
  "净额"一列已经是扣掉补贴、退款抵扣之后的数。
- 数据只有当前账本最近 24 个月的。问到更早的，说明这一点。

各账户现在的余额：${accounts.map((a) => `${a.name} ${money(balanceOf(a, txs), acctCur(a))}`).join('；')}

账本数据（一行一笔）：
${data.text}`;
  const r = await aiJson(system, question, ASK_SCHEMA);
  if (r.intent === 'answer') return { kind: 'answer', text: r.answer, related: (r.related ?? []).map((n) => data.rows[n - 1]).filter(Boolean).slice(0, 8) };
  // 记账：分类、账户按名字找；找不到分类归"其他"，找不到账户留给用户在修改页里选
  const income = r.type === 'income', transfer = r.type === 'transfer';
  const top = cats.find((c) => !c.parentId && !!c.isIncome === income && c.name === r.category) ?? cats.find((c) => !c.parentId && !!c.isIncome === income && c.name === '其他');
  const sub = top && r.subcategory ? cats.find((c) => c.parentId === top.id && c.name === r.subcategory) : null;
  const account = accounts.find((a) => a.name === r.account), to = accounts.find((a) => a.name === r.to_account);
  const cents = Math.round(Math.abs(Number(r.amount)) * 100);
  if (!cents) throw new AiError('没听出金额，换个说法试试。');
  if (r.currency && r.currency.toUpperCase() !== HOME) throw new AiError('网页版暂时只能记 ' + HOME + '，外币请在手机上记。');
  return { kind: 'record', saved: false, tx: {
    id: newId(), kind: transfer ? KIND.TRANSFER : income ? KIND.INCOME : KIND.EXPENSE, amountCents: cents, categoryId: transfer ? 0 : (sub ?? top)?.id ?? 0,
    accountId: account?.id ?? 0, toAccountId: transfer ? to?.id ?? 0 : 0, ledgerId: state.ledgerId, date: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? isoToDay(r.date) : today(),
    note: r.note ?? '', tags: (r.tags ?? '').split(/[\s#,，]+/).filter(Boolean).join(' '), reimburse: 0, createdAt: Date.now(), currency: '', origCents: 0, excluded: false, offsetOf: 0, offsetParts: '', project: '', fund: '',
  } };
}

/** 首页那条"说一句话记账"。 */
function quickBar() {
  return `<form class="quick" data-form="ask"><span class="spark">✦</span><input id="quick" placeholder="说一句话记账，或者问账本" autocomplete="off"><button class="send" aria-label="发送">›</button></form>`;
}

function askView() {
  const L = computeLookup();
  const hints = ['今天买菜 12.5 用 ING', '从 ING 转 200 到 Revolut', '今年在 AI 工具上花了多少', '上个月买菜比前一个月多多少'];
  const bubbles = state.chat.map((m, i) => {
    if (m.kind === 'q') return `<div class="bubble me">${h(m.text)}</div>`;
    if (m.kind === 'error') return `<div class="card"><span class="err">${h(m.text)}</span></div>`;
    if (m.kind === 'answer') return `<div class="card"><div style="white-space:pre-wrap">${h(m.text)}</div>${m.related.length ? `<div style="margin-top:8px">${rowsOf(m.related, L)}</div>` : ''}</div>`;
    const t = m.tx, ok = t.accountId && (t.kind !== KIND.TRANSFER || (t.toAccountId && t.toAccountId !== t.accountId));
    return `<div class="card">${txRowStatic(t, L)}
      ${m.saved ? '<div class="in small">已记下</div>' : `${ok ? '' : '<div class="amber small">还没认出账户，点"修改"选一下。</div>'}
      <div class="between"><span></span><span><button class="btn" data-act="ask-edit" data-v="${i}">修改</button> <button class="btn primary" data-act="ask-save" data-v="${i}" ${ok ? '' : 'disabled'}>记下</button></span></div>`}</div>`;
  }).join('');
  return `<div class="grid" style="max-width:720px;margin:0 auto">
    ${state.chat.length ? bubbles : `<div class="card"><b>问账本</b><div class="muted small">说一句话，记账或提问</div><div class="grid" style="margin-top:10px">${hints.map((x) => `<button class="btn" style="text-align:left" data-act="ask-hint" data-v="${h(x)}">${h(x)}</button>`).join('')}</div></div>`}
    ${state.asking ? '<div class="muted">正在想…</div>' : ''}
    ${aiKey() ? '' : '<div class="card amber small">还没有填 Claude API 密钥，点右上角的"AI 设置"。</div>'}
    <form class="quick" data-form="ask"><span class="spark">✦</span><input id="quick" placeholder="记一笔，或者问一句" autocomplete="off" ${state.asking ? 'disabled' : ''}><button class="send" aria-label="发送" ${state.asking ? 'disabled' : ''}>›</button></form>
  </div>`;
}

/** 还没入库的账单也用同一种行来显示，只是点了没反应。 */
function txRowStatic(t, L) { return txRow(t, L, true).replace('data-act="view"', 'data-act="noop"').replace('row click', 'row'); }

async function sendAsk(text) {
  const q = text.trim();
  if (!q || state.asking) return;
  state.tab = 'ask'; state.q = ''; state.chat.push({ kind: 'q', text: q }); state.asking = true; render();
  try { state.chat.push(await askLedger(q)); } catch (e) { state.chat.push({ kind: 'error', text: e instanceof AiError ? e.message : '出错了：' + e.message }); }
  state.asking = false; render();
  document.getElementById('quick')?.focus();
}

// ---------------------------------------------------------------- 净资产曲线、修正余额

function netWorthSeries() {
  const accounts = [...state.data.account.values()], txs = allTxs();
  if (!txs.length) return [];
  const first = dayToDate(Math.min(...txs.map((t) => t.date))), now = new Date();
  const out = [];
  for (let y = first.getUTCFullYear(), m = first.getUTCMonth() + 1; y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1); m === 12 ? (y++, m = 1) : m++) {
    const end = epochDay(y, m + 1, 0);
    // 每个账户按自己的币种算到月末的余额，再按现在的汇率折成主货币（和手机端一样）
    const upTo = txs.filter((t) => t.date <= end);
    const total = accounts.reduce((s, a) => s + toHome(a, balanceOf(a, upTo)), 0) + pendingReimburse(upTo);
    out.push({ label: `${y}年${m}月`, cents: total });
  }
  return out;
}

function netWorthCard() {
  const all = netWorthSeries();
  if (all.length < 2) return '';
  const s = state.worthAll ? all : all.slice(-12);
  const min = Math.min(...s.map((p) => p.cents)), max = Math.max(...s.map((p) => p.cents)), span = Math.max(1, max - min);
  const W = 600, H = 160, pts = s.map((p, i) => [i * (W - 20) / Math.max(1, s.length - 1) + 10, H - 12 - (H - 30) * (p.cents - min) / span]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) { const [ax, ay] = pts[i - 1], [bx, by] = pts[i], mid = (ax + bx) / 2; d += ` C${mid},${ay} ${mid},${by} ${bx},${by}`; }
  const last = s[s.length - 1].cents, prev = s[s.length - 2].cents, diff = last - prev;
  return `<div class="card"><div class="between"><div><div class="muted small">净资产</div><div class="num" style="font-size:22px">${money(last)}</div><div class="small ${diff >= 0 ? 'in' : 'out'}">比上月 ${diff >= 0 ? '+' : ''}${money(diff)}</div></div>
      <div style="width:150px">${seg('worth', [[0, '12 个月'], [1, '全部']], state.worthAll ? 1 : 0)}</div></div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin-top:8px" role="img" aria-label="净资产曲线"><path d="${d} L${pts[pts.length - 1][0]},${H} L${pts[0][0]},${H} Z" fill="var(--primary)" opacity=".16"/><path d="${d}" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round"/>
      ${pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="7" fill="transparent"><title>${s[i].label} ${money(s[i].cents)}</title></circle>`).join('')}<circle cx="${pts[pts.length - 1][0]}" cy="${pts[pts.length - 1][1]}" r="4" fill="var(--primary)"/></svg>
    <div class="between small muted"><span>${s[0].label}</span><span>最高 ${money(max)} · 最低 ${money(min)}</span><span>${s[s.length - 1].label}</span></div></div>`;
}

async function fixBalance(accountId) {
  const a = state.data.account.get(accountId);
  const flows = allTxs().reduce((s, t) => s + effect(a, t), 0), current = (a.initialCents ?? 0) + flows;
  const input = prompt(`「${a.name}」现在实际有多少？（${acctCur(a)}）\n账本里现在是 ${(current / 100).toFixed(2)}，差额会记到初始余额里，账单不动。`, (current / 100).toFixed(2));
  if (input == null) return;
  const v = Number(String(input).trim().replace(',', '.'));
  if (!Number.isFinite(v)) { state.error = '请输入数字。'; return; }
  await saveRecord('account', { ...a, initialCents: Math.round(v * 100) - flows });
}

// ---------------------------------------------------------------- 月度复盘

function reviewNumbers(y, m, L) {
  const range = (yy, mm) => { const from = epochDay(yy, mm, 1), to = epochDay(yy, mm + 1, 0); return allTxs().filter((t) => t.ledgerId === state.ledgerId && t.date >= from && t.date <= to); };
  const cur = range(y, m), prevDate = new Date(y, m - 2, 1), prev = range(prevDate.getFullYear(), prevDate.getMonth() + 1);
  const byTop = (list) => { const map = new Map(); for (const t of list) if (t.kind === KIND.EXPENSE && L.counts(t)) { const n = L.top(t.categoryId)?.name ?? '未分类'; map.set(n, (map.get(n) ?? 0) + L.net(t)); } return map; };
  const a = byTop(cur), b = byTop(prev), names = new Set([...a.keys(), ...b.keys()]);
  const cats = [...names].map((n) => ({ name: n, cents: a.get(n) ?? 0, diff: (a.get(n) ?? 0) - (b.get(n) ?? 0) }));
  const spend = cur.filter((t) => t.kind === KIND.EXPENSE && L.counts(t));
  const perDay = new Map(); for (const t of spend) perDay.set(t.date, (perDay.get(t.date) ?? 0) + L.net(t));
  const days = new Date(y, m, 0).getDate(), now = new Date(), passed = y === now.getFullYear() && m === now.getMonth() + 1 ? now.getDate() : (epochDay(y, m, 1) > today() ? 0 : days);
  const top = [...perDay.entries()].sort((x, z) => z[1] - x[1])[0];
  return { t: L.totals(cur), p: L.totals(prev), top5: cats.filter((c) => c.cents > 0).sort((x, z) => z.cents - x.cents).slice(0, 5), up: cats.slice().sort((x, z) => z.diff - x.diff)[0], down: cats.slice().sort((x, z) => x.diff - z.diff)[0],
    biggest: spend.slice().sort((x, z) => L.net(z) - L.net(x)).slice(0, 3), passed, daily: passed ? Math.round(sum(spend, (t) => L.net(t)) / passed) : 0, maxDay: top, quiet: Math.max(0, passed - perDay.size), count: cur.length };
}

function reviewView() {
  const L = computeLookup(), { y, m } = state.month, r = reviewNumbers(y, m, L);
  const delta = (now, before, goodUp) => { const d = now - before; if (!before && !now) return ''; const cls = d === 0 ? 'muted' : (d > 0) === goodUp ? 'in' : 'out'; return `<div class="small ${cls}">${d >= 0 ? '+' : ''}${money(d)}${before ? ` (${d >= 0 ? '+' : ''}${Math.round(d * 100 / Math.abs(before))}%)` : ''}</div>`; };
  const key = `${y}-${m}`;
  return `<div class="card"><div class="between"><div><div class="muted small">支出</div><div class="num out" style="font-size:19px">${money(r.t.expense)}</div>${delta(r.t.expense, r.p.expense, false)}</div>
      <div><div class="muted small">收入</div><div class="num in" style="font-size:19px">${money(r.t.income)}</div>${delta(r.t.income, r.p.income, true)}</div>
      <div class="right"><div class="muted small">结余</div><div class="num" style="font-size:19px">${money(r.t.income - r.t.expense)}</div>${delta(r.t.income - r.t.expense, r.p.income - r.p.expense, true)}</div></div>
      <div class="muted small" style="margin-top:6px">小字是和上月比</div></div>
    <div class="card"><div class="between"><b>AI 总结</b><button class="btn" data-act="review-ai" ${state.reviewBusy ? 'disabled' : ''}>${state.reviewBusy ? '正在写…' : state.reviewText[key] ? '重写' : '写一段'}</button></div>
      ${state.reviewText[key] ? `<div style="white-space:pre-wrap;margin-top:8px">${h(state.reviewText[key])}</div>` : ''}</div>
    <div class="card"><b>钱花在哪了</b>${r.top5.map((c) => `<div class="between" style="padding:5px 0"><span>${h(c.name)} <span class="small muted">${c.diff === 0 ? '' : c.diff > 0 ? '比上月多 ' + money(c.diff) : '比上月少 ' + money(-c.diff)}</span></span><span class="num">${money(c.cents)}</span></div>`).join('') || '<div class="muted">这个月没有支出</div>'}
      ${r.up && r.up.diff > 0 ? `<div class="small muted">涨得最多：${h(r.up.name)} +${money(r.up.diff)}</div>` : ''}${r.down && r.down.diff < 0 ? `<div class="small muted">降得最多：${h(r.down.name)} ${money(r.down.diff)}</div>` : ''}</div>
    ${r.biggest.length ? `<div class="card"><b>最大的几笔</b>${rowsOf(r.biggest, L)}</div>` : ''}
    ${r.passed ? `<div class="card"><div class="between"><div><div class="muted small">日均支出</div><div class="num">${money(r.daily)}</div></div><div><div class="muted small">花得最多的一天</div><div class="num">${r.maxDay ? dayISO(r.maxDay[0]).slice(5) + ' ' + money(r.maxDay[1]) : '—'}</div></div><div class="right"><div class="muted small">没花钱</div><div class="num">${r.quiet} 天</div></div></div></div>` : ''}`;
}

async function writeReview() {
  const L = computeLookup(), { y, m } = state.month, r = reviewNumbers(y, m, L);
  // 只发分类名和金额，不发备注、对方名字这些原文
  const facts = [`月份：${y}年${m}月`, `支出 ${money(r.t.expense)}（上月 ${money(r.p.expense)}）`, `收入 ${money(r.t.income)}（上月 ${money(r.p.income)}）`, `结余 ${money(r.t.income - r.t.expense)}`,
    '支出最多的分类：' + r.top5.map((c) => `${c.name} ${money(c.cents)}（比上月${c.diff >= 0 ? '多' : '少'} ${money(Math.abs(c.diff))}）`).join('；'),
    '最大的几笔：' + r.biggest.map((t) => `${L.top(t.categoryId)?.name ?? '未分类'} ${money(L.net(t))}`).join('；'), `日均支出 ${money(r.daily)}，没花钱的天数 ${r.quiet}`,
    `可报销支出 ${money(r.t.reimbursable)}，报销收入 ${money(r.t.reimbursed)}`].join('\n');
  const out = await aiJson('你是记账应用里的助手。根据给出的这个月的数字，用 3 到 5 句中文写一段复盘：钱主要花在哪、和上月比有什么变化、有没有值得注意的地方，最后给一条具体可行的建议。语气平实，不要夸张，不要重复罗列所有数字。',
    facts, { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } }, 4000);
  state.reviewText[`${y}-${m}`] = out.summary;
}

// ---------------------------------------------------------------- 对账：银行账单对账本

const REC_SCHEMA = { type: 'object', additionalProperties: false, required: ['rows'], properties: { rows: { type: 'array', items: {
  type: 'object', additionalProperties: false, required: ['date', 'amount', 'text'], properties: { date: { type: 'string' }, amount: { type: 'number' }, text: { type: 'string' } } } } } };
const REC_SYSTEM = `把这份银行账单里的每一笔交易读出来，一笔一行，不要合并也不要遗漏。
date 是记账日期，格式 YYYY-MM-DD。amount 是这个账户的金额变化：进账为正，出账为负，用账单上的币种，不要换算。
text 是对方名称加上摘要，简短，不要带 IBAN、卡号。余额行、合计行、表头不是交易，不要输出。`;

async function readStatement(file, onProgress) {
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  if (isPdf) {
    if (file.size > 20 * 1024 * 1024) throw new AiError('PDF 超过 20 MB，请拆开再试。');
    const bytes = new Uint8Array(await file.arrayBuffer()); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    onProgress(0, 1);
    const r = await aiJson(REC_SYSTEM, [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: btoa(bin) } }, { type: 'text', text: '读出全部交易。' }], REC_SCHEMA, 32000);
    onProgress(1, 1);
    return r.rows;
  }
  const lines = (await file.text()).split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new AiError('文件里没有内容。');
  // 文字账单一段 25 行，一段一段读；每段都带上表头
  const chunks = []; for (let i = 1; i < lines.length; i += 25) chunks.push(lines.slice(i, i + 25));
  const rows = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress(i, chunks.length);
    const r = await aiJson(REC_SYSTEM, `以下是账单文件的一部分（第一行是表头）：\n\n${lines[0]}\n${chunks[i].join('\n')}`, REC_SCHEMA);
    rows.push(...r.rows);
  }
  onProgress(chunks.length, chunks.length);
  return rows;
}

/** 和手机端同一套算法：先逐笔配对，再找记错账户的，最后把"只是记法不同"的成组标出来。 */
function reconcile(bankRows, accountId) {
  const account = state.data.account.get(accountId);
  const bank = bankRows.map((r) => ({ date: isoToDay(r.date), cents: Math.round(Number(r.amount) * 100), text: r.text })).filter((b) => Number.isFinite(b.date) && Number.isFinite(b.cents) && b.cents !== 0);
  if (!bank.length) throw new AiError('没有读出任何交易。');
  const from = Math.min(...bank.map((b) => b.date)), to = Math.max(...bank.map((b) => b.date));
  const mine = allTxs().filter((t) => (t.accountId === accountId || t.toAccountId === accountId) && t.date >= from - 8 && t.date <= to + 8).map((t) => ({ tx: t, cents: effect(account, t) })).filter((x) => x.cents !== 0);
  const usedB = new Set(), usedL = new Set();
  for (const tol of [0, 1, 2, 3, 5, 8]) mine.forEach((l, li) => {
    if (usedL.has(li)) return;
    let best = -1;
    bank.forEach((b, bi) => { if (!usedB.has(bi) && b.cents === l.cents && Math.abs(b.date - l.tx.date) <= tol && (best < 0 || Math.abs(b.date - l.tx.date) < Math.abs(bank[best].date - l.tx.date))) best = bi; });
    if (best >= 0) { usedB.add(best); usedL.add(li); }
  });
  let loneBank = bank.filter((_, i) => !usedB.has(i));
  const loneLedger = mine.filter((l, i) => !usedL.has(i) && l.tx.date >= from && l.tx.date <= to);
  // 记错账户：别的账户里有同一天前后、同样金额的收入或支出
  const taken = new Set(), misplaced = [];
  loneBank = loneBank.filter((b) => {
    const hit = allTxs().find((t) => !taken.has(t.id) && t.kind !== KIND.TRANSFER && t.accountId !== accountId && (t.kind === KIND.INCOME ? t.amountCents : -t.amountCents) === b.cents && Math.abs(t.date - b.date) <= 3);
    if (!hit) return true;
    taken.add(hit.id); misplaced.push({ row: b, tx: hit }); return false;
  });
  // 成组抵消：十天之内银行多出来的和账本多出来的合计相等，就是同一笔钱的不同记法
  const days = new Map();
  const day = (d) => { if (!days.has(d)) days.set(d, { date: d, b: [], l: [], net: 0 }); return days.get(d); };
  loneBank.forEach((b) => { const x = day(b.date); x.b.push(b); x.net += b.cents; });
  loneLedger.forEach((l) => { const x = day(l.tx.date); x.l.push(l); x.net -= l.cents; });
  const list = [...days.values()].sort((a, b) => a.date - b.date);
  for (let i = 0; i < list.length;) {
    let s = 0, hb = false, hl = false, end = -1;
    for (let j = i; j < list.length && list[j].date - list[i].date <= 10; j++) { s += list[j].net; hb = hb || list[j].b.length > 0; hl = hl || list[j].l.length > 0; if (s === 0 && hb && hl) { end = j; break; } }
    if (end >= 0) { for (let k = i; k <= end; k++) { list[k].b.forEach((x) => { x.same = true; }); list[k].l.forEach((x) => { x.same = true; }); } i = end + 1; } else i++;
  }
  const bankTotal = sum(bank, (b) => b.cents), ledgerTotal = sum(mine.filter((l) => l.tx.date >= from && l.tx.date <= to), (l) => l.cents);
  return { accountId, from, to, count: bank.length, bankTotal, ledgerTotal, misplaced, bankOnly: loneBank, ledgerOnly: loneLedger };
}

function reconcileView() {
  const rec = state.rec, L = computeLookup();
  const accounts = [...state.data.account.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const pick = `<div class="card grid">
    <label class="f">账户<select id="rec-account"><option value="0">选择账户</option>${accounts.map((a) => `<option value="${a.id}" ${a.id === rec.accountId ? 'selected' : ''}>${h(a.name)}</option>`).join('')}</select></label>
    <label class="btn ${rec.accountId && !rec.busy ? 'primary' : ''}" style="cursor:pointer;text-align:center">${rec.busy ? `正在读账单 ${rec.done}/${rec.total} 段…` : '选择银行账单（CSV 或 PDF）'}<input type="file" id="rec-file" accept=".csv,.txt,.pdf,text/csv,application/pdf" hidden ${rec.accountId && !rec.busy ? '' : 'disabled'}></label>
    ${rec.error ? `<p class="err">${h(rec.error)}</p>` : ''}${aiKey() ? '' : '<p class="amber small" style="margin:0">读账单要用 Claude API，先在右上角"AI 设置"里填密钥。</p>'}
    <p class="muted small" style="margin:0">账单内容会发给 Anthropic 识别。</p></div>`;
  const r = rec.result;
  if (!r) return `<div class="grid" style="max-width:720px">${pick}</div>`;
  const a = state.data.account.get(r.accountId);
  const bankLine = (b, extra) => `<div class="between" style="padding:6px 0"><div class="main"><div class="small muted">${dayISO(b.date)}</div><div class="small" style="overflow-wrap:anywhere">${h(b.text)}</div></div><span class="num ${b.cents > 0 ? 'in' : 'out'}">${b.cents > 0 ? '+' : ''}${money(b.cents)}</span>${extra}</div>`;
  const real = (x) => !x.same;
  const diff = r.bankTotal - r.ledgerTotal;
  const same = r.bankOnly.filter((x) => x.same).length + r.ledgerOnly.filter((x) => x.same).length;
  return `<div class="cols"><div class="grid">${pick}
      <div class="card"><b>${h(a?.name ?? '')}</b><div class="muted small">${dayISO(r.from)} 至 ${dayISO(r.to)} · 银行 ${r.count} 笔</div>
        <div class="between" style="margin-top:8px"><div><div class="muted small">银行净额</div><div class="num">${money(r.bankTotal)}</div></div><div><div class="muted small">账本净额</div><div class="num">${money(r.ledgerTotal)}</div></div><div class="right"><div class="muted small">相差</div><div class="num ${diff === 0 ? 'in' : 'amber'}">${money(diff)}</div></div></div></div></div>
    <div class="grid">
      ${r.misplaced.length ? `<div class="card"><div class="between"><b>记错账户的 ${r.misplaced.length}</b><button class="btn" data-act="rec-move-all">全部改到 ${h(a?.name ?? '')}</button></div>
        ${r.misplaced.map((m, i) => `${txRow(m.tx, L, true)}<div class="right" style="margin:-4px 0 6px"><button class="btn link" data-act="rec-move" data-v="${i}">改到这个账户</button></div>`).join('')}</div>` : ''}
      ${r.bankOnly.filter(real).length ? `<div class="card"><b>银行有、账本没有 ${r.bankOnly.filter(real).length}</b>${r.bankOnly.map((b, i) => (b.same ? '' : bankLine(b, ` <button class="btn link" data-act="rec-add" data-v="${i}">补记</button>`))).join('')}</div>` : ''}
      ${r.ledgerOnly.filter(real).length ? `<div class="card"><b>账本有、银行没有 ${r.ledgerOnly.filter(real).length}</b><div class="muted small">点开可以修改或删除</div>${rowsOf(r.ledgerOnly.filter(real).map((x) => x.tx), L)}</div>` : ''}
      ${!r.misplaced.length && !r.bankOnly.filter(real).length && !r.ledgerOnly.filter(real).length ? '<div class="card in">这段时间对得上，没有要处理的。</div>' : ''}
      ${same ? `<div class="card"><div class="row click" data-act="rec-same" style="padding:0"><div class="main muted">只是记法不同 ${same} 笔 ${rec.showSame ? '▴' : '▾'}</div></div>
        ${rec.showSame ? r.bankOnly.filter((x) => x.same).map((b) => bankLine(b, '')).join('') + rowsOf(r.ledgerOnly.filter((x) => x.same).map((x) => x.tx), L) : ''}</div>` : ''}
    </div></div>`;
}

// ---------------------------------------------------------------- 这些功能的点击、提交、选文件

async function aiAction(act, v) {
  const rec = state.rec;
  switch (act) {
    case 'ai-settings': state.aiSettings = true; break;
    case 'ai-close': if (event?.target?.dataset?.act !== 'ai-close') return true; state.aiSettings = false; break;
    case 'ai-close-btn': state.aiSettings = false; break;
    case 'ai-clear': store.del('hl.apiKey'); state.aiSettings = false; break;
    case 'ai-save': { const k = document.getElementById('ai-key').value.trim(); if (k) store.set('hl.apiKey', k); store.set('hl.model', document.getElementById('ai-model').value.trim()); state.aiSettings = false; break; }
    case 'ask-hint': sendAsk(v); return true;
    case 'ask-save': { const m = state.chat[Number(v)]; try { await saveRecord('tx', m.tx); m.saved = true; } catch (e) { state.error = e.message; } break; }
    case 'ask-edit': { const m = state.chat[Number(v)]; state.editing = { ...m.tx, _amount: (m.tx.amountCents / 100).toFixed(2), _isNew: true }; m.saved = true; break; }
    case 'noop': return true;
    case 'worth': state.worthAll = v === '1'; break;
    case 'asset-tab': state.assetTab = v; state.accountId = null; state.project = null; state.openKey = null; break;
    case 'fix-balance': try { await fixBalance(Number(v)); } catch (e) { state.error = e.message; } break;
    case 'review-ai': state.reviewBusy = true; render(); try { await writeReview(); } catch (e) { state.error = e instanceof AiError ? e.message : '出错了：' + e.message; } state.reviewBusy = false; break;
    case 'rec-same': rec.showSame = !rec.showSame; break;
    case 'rec-move': { const m = rec.result.misplaced[Number(v)]; try { await saveRecord('tx', { ...m.tx, accountId: rec.result.accountId }); rec.result.misplaced.splice(Number(v), 1); } catch (e) { state.error = e.message; } break; }
    case 'rec-move-all': try { for (const m of [...rec.result.misplaced]) { await saveRecord('tx', { ...m.tx, accountId: rec.result.accountId }); rec.result.misplaced.shift(); } } catch (e) { state.error = e.message; } break;
    case 'rec-add': {
      // 补记：带着日期、金额、账户和账单原文去记账页，分类由你选；点了就从这张单子上划掉
      const b = rec.result.bankOnly.splice(Number(v), 1)[0];
      state.editing = { id: newId(), kind: b.cents > 0 ? KIND.INCOME : KIND.EXPENSE, amountCents: Math.abs(b.cents), categoryId: 0, accountId: rec.result.accountId, toAccountId: 0, ledgerId: state.ledgerId, date: b.date, note: b.text, tags: '',
        reimburse: 0, createdAt: Date.now(), currency: '', origCents: 0, excluded: false, offsetOf: 0, offsetParts: '', project: '', fund: '', _amount: (Math.abs(b.cents) / 100).toFixed(2), _isNew: true };
      break;
    }
    default: return false;
  }
  render();
  return true;
}

async function aiChange(ev) {
  const rec = state.rec;
  if (ev.target.id === 'rec-account') { rec.accountId = Number(ev.target.value); rec.result = null; rec.error = ''; render(); return true; }
  if (ev.target.id !== 'rec-file' || !ev.target.files[0]) return false;
  rec.busy = true; rec.error = ''; rec.result = null; rec.done = 0; rec.total = 1; render();
  try {
    const rows = await readStatement(ev.target.files[0], (done, total) => { rec.done = done; rec.total = total; render(); });
    rec.result = reconcile(rows, rec.accountId);
  } catch (e) { rec.error = e instanceof AiError ? e.message : '出错了：' + e.message; }
  rec.busy = false; render();
  return true;
}
