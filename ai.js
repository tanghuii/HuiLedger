// 行星账本网页版：要用到 AI 的那些功能（一句话记账 / 问账本、月度复盘、对账），以及净资产曲线、修正余额。
// 和手机端一一对应：AskScreen.kt、InsightScreens.kt（ReviewScreen / NetWorthCard）、ReconcileScreen.kt + ai/Reconcile.kt、
// AccountsScreen.kt 的修正余额弹窗 + LedgerViewModel.checkBalance。
// 这个页面没有服务器，所以是浏览器直接连 Claude API：密钥只存在这个浏览器的本地存储里，请求直接发给 api.anthropic.com。
// 这个文件在 app.js 之前加载，只放函数；别的页面会调用：askView、quickBar、sendAsk、reviewView、netWorthCard、fixBalance、reconcileView、aiAction、aiChange。
'use strict';

const AI_MODEL_DEFAULT = 'claude-opus-5-5';
const aiKey = () => store.get('hl.apiKey', '');
const aiModel = () => store.get('hl.model', '') || AI_MODEL_DEFAULT;

class AiError extends Error {}

/**
 * 发一次请求，让模型按 schema 返回 JSON。content 可以是字符串，也可以是内容块数组（带 PDF、图片时）。
 * 被安全策略拒绝时开了服务端的备用模型（fallbacks），仍然被拒就报错。输出被截断时错误带 tooLong，调用方可以拆小再试。
 */
async function aiJson(system, content, schema, maxTokens = 16000) {
  if (!aiKey()) throw new AiError(tr('还没有填 API 密钥。', 'No API key set.'));
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
  } catch { throw new AiError(tr('网络连接失败，请检查网络后重试。', 'Connection failed. Check your network and try again.')); }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new AiError(tr('API 密钥无效或没有权限，请检查设置。', 'The API key is invalid or lacks permission. Check the settings.'));
    if (res.status === 404) throw new AiError(tr(`找不到模型「${aiModel()}」，请检查设置里的模型名称。`, `Model "${aiModel()}" not found. Check the model name in settings.`));
    if (res.status === 413) throw new AiError(tr('内容太大，这次发不过去。', 'Too large to send.'));
    if (res.status === 429) throw new AiError(tr('请求太频繁或额度已用完，请稍后再试。', 'Rate limited or out of credit. Try again later.'));
    if (res.status >= 500) throw new AiError(tr('AI 服务暂时繁忙，请稍后再试。', 'The AI service is busy. Try again later.'));
    throw new AiError(tr(`没成功（${res.status}）：`, `Failed (${res.status}): `) + msg);
  }
  if (json.stop_reason === 'refusal') throw new AiError(tr('AI 拒绝处理这段内容。', 'The AI declined this content.'));
  if (json.stop_reason === 'max_tokens') throw Object.assign(new AiError(tr('内容太长，AI 没写完。', 'Too long; the AI ran out of space.')), { tooLong: true });
  const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text); } catch { throw new AiError(tr('AI 返回的结果无法解析，请重试。', "Couldn't parse the AI's answer. Try again.")); }
}

function aiSettingsView() {
  return `<div class="modal" data-act="ai-close"><div class="card grid" role="dialog" aria-label="${tr('AI 设置', 'AI settings')}">
    <b style="font-size:18px">${tr('AI 设置', 'AI settings')}</b>
    <label class="f">${tr('Claude API 密钥', 'Claude API key')}<input id="ai-key" type="password" autocomplete="off" placeholder="${aiKey() ? tr('已保存，留空表示不改', 'Saved; leave blank to keep') : 'sk-ant-…'}"></label>
    <label class="f">${tr('模型', 'Model')}<input id="ai-model" value="${h(aiModel())}" autocomplete="off"></label>
    <p class="muted small" style="margin:0">${tr('密钥只存在这个浏览器里。公用电脑上不要保存。', "The key stays in this browser. Don't save it on a shared computer.")}</p>
    <div class="between"><span>${aiKey() ? `<button class="btn danger" data-act="ai-clear">${tr('清除密钥', 'Remove key')}</button>` : ''}</span><span><button class="btn" data-act="ai-close-btn">${tr('取消', 'Cancel')}</button> <button class="btn primary" data-act="ai-save">${tr('保存', 'Save')}</button></span></div>
  </div></div>`;
}

// ---------------------------------------------------------------- 小零件

/** 分类显示名：有 tags.js 的 catName 就用它（英文界面翻译预置分类），否则原名。参数是分类对象。 */
function aiCat(c) {
  if (!c) return '';
  if (typeof catName === 'function') {
    for (const arg of [c, c.name]) {
      try { const r = catName(arg); if (typeof r === 'string' && r && r !== '[object Object]') return r; } catch { /* 换一种参数再试 */ }
    }
  }
  return c.name ?? '';
}
/** 空状态：有 art.js 的 emptyState 就用它的插画，否则一张灰字卡片。 */
function aiEmpty(kind, text) {
  if (typeof emptyState === 'function') { try { const r = emptyState(kind, text); if (r) return r; } catch { /* 用下面的 */ } }
  return `<div class="card muted ai-empty">${h(text)}</div>`;
}
/** 带正负号的金额：+€12.00 / -€3.40 */
const aiSigned = (c, cur) => (c > 0 ? '+' : '') + money(c, cur);
const aiIcon = (k) => `<svg class="ai-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${(ICONS[k] ?? ICONS.tag).d}"/></svg>`;
/** 输入框里的金额 → 分。空的是 null，不是数字是 NaN。 */
function aiCents(text) {
  const s = String(text ?? '').replace(/\s/g, '').replace(',', '.');
  if (!s) return null;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  const v = Number(s);
  return Number.isFinite(v) ? Math.round(v * 100) : NaN;
}
const aiAccounts = () => [...state.data.account.values()].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
const aiTops = (income) => [...state.data.category.values()].filter((c) => !c.parentId && !!c.isIncome === income).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
const aiMD = (day) => { const d = dayToDate(day); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };

/** 一个小签，点开往下弹出选项（和手机端的 ChipPicker 一样）。options: [{ v, name, lead, on }]，点选项触发 act。 */
function aiPicker(id, label, lead, options, act) {
  const open = state.aiPick === id;
  return `<div class="ai-pk"><button type="button" class="ai-chip${open ? ' open' : ''}" data-act="ai-pick" data-v="${h(id)}" aria-haspopup="listbox" aria-expanded="${open}">${lead}<span>${h(label)}</span><i aria-hidden="true">▾</i></button>
    ${open ? `<div class="ai-pop" role="listbox">${options.map((o) => `<button type="button" role="option" aria-selected="${!!o.on}" class="${o.on ? 'on' : ''}" data-act="${act}" data-v="${h(o.v)}">${o.lead ?? ''}<span>${h(o.name)}</span></button>`).join('') || `<div class="muted small ai-pop-none">${tr('没有可选的', 'Nothing to choose')}</div>`}</div>` : ''}</div>`;
}
// 点弹出框外面就收起
document.addEventListener('click', (ev) => {
  if (typeof state === 'undefined' || !state.aiPick || ev.target.closest?.('.ai-pk')) return;
  state.aiPick = null;
  if (!ev.target.closest?.('[data-act]')) render();
}, true);

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

/** 账户按名字找：先一字不差，再不分大小写（同手机端 Assistant.findAccount）。 */
function aiFindAccount(name) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  const all = aiAccounts();
  return all.find((a) => a.name === name) ?? all.find((a) => a.name.toLowerCase() === n.toLowerCase()) ?? null;
}
/** 这笔该记在哪个分类：名单里有就用它（子分类也对得上就用子分类），没有归"其他"（同手机端 Assistant.categoryId）。 */
function aiCategoryId(p) {
  if (p.kind === KIND.TRANSFER) return 0;
  const tops = aiTops(p.kind === KIND.INCOME);
  const top = tops.find((c) => c.name === p.category) ?? tops.find((c) => c.name === '其他') ?? tops[0];
  if (!top) return 0;
  if (top.name !== p.category || !p.sub) return top.id;
  return [...state.data.category.values()].find((c) => c.parentId === top.id && c.name === p.sub)?.id ?? top.id;
}
/** 卡片上现在选的账户、分类 → 可以入库的一笔；缺账户、转账两头相同、没有分类时是 null（同手机端 Assistant.toTx）。 */
function aiDraftTx(m) {
  const p = m.p, transfer = p.kind === KIND.TRANSFER, account = state.data.account.get(m.accountId), to = state.data.account.get(m.toAccountId);
  if (!account || p.currency !== HOME) return null;
  if (transfer && (!to || to.id === account.id)) return null;
  const categoryId = transfer ? 0 : m.categoryId || aiCategoryId(p);
  if (!transfer && !categoryId) return null;
  return {
    id: newId(), kind: p.kind, amountCents: p.cents, categoryId, accountId: account.id, toAccountId: transfer ? to.id : 0, ledgerId: state.ledgerId, date: p.date,
    note: p.note, tags: p.tags, reimburse: 0, createdAt: Date.now(), currency: '', origCents: 0, excluded: false, offsetOf: 0, offsetParts: '', project: '', fund: '',
  };
}

async function askLedger(question) {
  const L = computeLookup(), data = ledgerText(L);
  const cats = [...state.data.category.values()];
  const names = (income) => cats.filter((c) => !c.parentId && !!c.isIncome === income).map((c) => { const subs = cats.filter((s) => s.parentId === c.id).map((s) => s.name); return subs.length ? `${c.name}（${subs.join('、')}）` : c.name; }).join('；');
  const accounts = aiAccounts();
  const txs = allTxs();
  const system = `你是一个记账应用里的助手。用户会说一句话（中文或英文都可能），你要判断他是想记一笔账，还是在问账本里的事。
用户说英文时，category、subcategory、account、to_account 仍然要从下面的名单里选原样的名字（按意思对应，比如 groceries 对应买菜之类的分类），不要翻译名单里的名字。
${LANG === 'en' ? '界面现在是英文：answer 一律用英文写；note 用用户自己的说法。\n' : ''}
一、如果是记一笔账（比如"昨天在超市买菜 12.5 用 ING""收到工资 2000 进 ING""从 ING 转 200 到 Revolut"）：
intent 填 "record"，并填好 date、amount、currency、type、category、subcategory、account、to_account、note、tags。
- 今天是 ${dayISO(today())}。"昨天""上周五"这类说法换算成具体日期，格式 YYYY-MM-DD；没说日期就是今天。
- amount 是正数。currency 是 ISO 货币代码，没说就是 ${HOME}。
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
  const r = await aiJson(system, question, ASK_SCHEMA, 4000);
  if (r.intent !== 'record') {
    return { kind: 'answer', text: String(r.answer ?? '').trim() || tr('没有答案。', 'No answer.'), related: (r.related ?? []).map((n) => data.rows[n - 1]?.id).filter(Boolean).slice(0, 8) };
  }
  const cents = Math.round(Math.abs(Number(r.amount)) * 100);
  if (!cents) throw new AiError(tr('没听出金额，换个说法试试。', "Couldn't find an amount. Try rephrasing."));
  const account = String(r.account ?? '').trim(), toAccount = String(r.to_account ?? '').trim();
  const transfer = r.type === 'transfer' && !(account && account === toAccount);
  const p = {
    date: /^\d{4}-\d{2}-\d{2}$/.test(r.date ?? '') ? isoToDay(r.date) : today(), cents,
    kind: transfer ? KIND.TRANSFER : r.type === 'income' ? KIND.INCOME : KIND.EXPENSE,
    currency: String(r.currency ?? '').trim().toUpperCase() || HOME,
    category: transfer ? '' : String(r.category ?? '').trim(), sub: transfer ? '' : String(r.subcategory ?? '').trim(),
    account, toAccount: transfer ? toAccount : '', note: String(r.note ?? '').trim(),
    tags: String(r.tags ?? '').split(/[\s#,，]+/).filter(Boolean).join(' '),
  };
  return { kind: 'draft', p, accountId: aiFindAccount(account)?.id ?? 0, toAccountId: transfer ? aiFindAccount(toAccount)?.id ?? 0 : 0, categoryId: aiCategoryId(p), editing: false, savedId: 0 };
}

/** 首页那条"说一句话记账"（app.js 的 hmQuick 会把 ✦ 和 › 换成图标，这两个字别改）。 */
function quickBar() {
  return `<form class="quick" data-form="ask"><span class="spark">✦</span><input id="quick" placeholder="${tr('说一句话记账，或者问账本', 'Record or ask in one line')}" autocomplete="off" enterkeyhint="send"><button class="send" aria-label="${tr('发送', 'Send')}">›</button></form>`;
}

/** 待确认的一笔账：先给人看一眼，点"记下"才入账；账户没认出来时直接摆出选择，点"修改"可以换账户和分类。记下之后变成一行可以点开的账单。 */
function aiDraftCard(m, i, L) {
  if (m.savedId) {
    const saved = state.data.tx.get(m.savedId);
    return `<div class="card ai-msg ai-draft"><div class="ai-saved in">${tr('已记下', 'Recorded')}</div>${saved ? txRow(saved, L, true) : ''}</div>`;
  }
  const p = m.p, transfer = p.kind === KIND.TRANSFER, acc = state.data.account, cats = state.data.category;
  const account = acc.get(m.accountId), to = acc.get(m.toAccountId), cat = cats.get(m.categoryId);
  const top = cat ? (cat.parentId ? cats.get(cat.parentId) ?? cat : cat) : null;
  const title = transfer ? `${account?.name ?? '?'} → ${to?.name ?? '?'}` : !cat ? tr('未分类', 'Uncategorized') : cat.parentId ? `${aiCat(top)} · ${aiCat(cat)}` : aiCat(cat);
  const sub = [dayISO(p.date), transfer ? '' : account?.name ?? tr('未选账户', 'No account'), p.note].filter(Boolean).join('  ');
  const sign = p.kind === KIND.EXPENSE ? '-' : p.kind === KIND.INCOME ? '+' : '';
  const cls = p.kind === KIND.EXPENSE ? 'out' : p.kind === KIND.INCOME ? 'in' : '';
  const head = `<div class="ai-dh">${transfer ? accountTile(to) : iconTile(cat?.icon ?? 'tag')}<div class="main"><div class="title">${h(title)}</div><div class="ai-dsub">${h(sub)}</div></div><div class="num ${cls}">${sign}${money(p.cents, p.currency)}</div></div>`;
  if (p.currency !== HOME) return `<div class="card ai-msg ai-draft">${head}<div class="amber ai-fx">${tr('外币请到记账页记。', 'Record foreign currency on the entry page.')}</div></div>`;
  const need = !account || (transfer && (!to || to.id === account.id));
  let picks = '';
  if (m.editing || need) {
    const list = aiAccounts().filter((a) => !a.archived || a.id === m.accountId || a.id === m.toAccountId);
    const opt = (a, on) => ({ v: `${i}:${a.id}`, name: a.name, lead: accountTile(a), on });
    picks = `<div class="ai-picks">${aiPicker(`ask-a${i}`, account?.name ?? tr('选账户', 'Account'), account ? accountTile(account) : aiIcon('wallet'), list.map((a) => opt(a, a.id === m.accountId)), 'ask-acc')}
      ${transfer ? aiPicker(`ask-t${i}`, to?.name ?? tr('转入账户', 'To'), to ? accountTile(to) : aiIcon('wallet'), list.filter((a) => a.id !== account?.id).map((a) => opt(a, a.id === m.toAccountId)), 'ask-to') : ''}</div>
      ${!transfer && m.editing ? `<div class="ai-picks">${aiPicker(`ask-c${i}`, top ? aiCat(top) : tr('选分类', 'Category'), top ? iconTile(top.icon ?? 'tag') : aiIcon('tag'),
        aiTops(p.kind === KIND.INCOME).map((c) => ({ v: `${i}:${c.id}`, name: aiCat(c), lead: iconTile(c.icon ?? 'tag'), on: c.id === top?.id })), 'ask-cat')}</div>` : ''}`;
  }
  const ok = !!aiDraftTx(m);
  return `<div class="card ai-msg ai-draft">${head}${picks}
    <div class="ai-btns"><button class="btn link ai-muted" data-act="ask-toggle" data-v="${i}">${m.editing ? tr('收起', 'Done') : tr('修改', 'Change')}</button><button class="btn primary" data-act="ask-save" data-v="${i}" ${ok ? '' : 'disabled'}>${tr('记下', 'Record')}</button></div></div>`;
}

function askView() {
  if (!aiKey()) {
    return `<div class="ai-ask"><div class="card ai-nokey"><b>${tr('需要 Claude API 密钥。', 'This needs a Claude API key.')}</b><div class="muted small">${tr('在「我的 → 设置」里填。', 'Set it under Me → Settings.')}</div>
      <button class="btn primary" data-act="ai-settings">${tr('AI 设置', 'AI settings')}</button></div></div>`;
  }
  const L = computeLookup(), busy = state.asking;
  const hints = [tr('今天买菜 12.5 用 ING', 'Groceries 12.5 today with ING'), tr('从 ING 转 200 到 Revolut', 'Move 200 from ING to Revolut'),
    tr('今年在 AI 工具上花了多少', 'How much on AI tools this year'), tr('上个月买菜比前一个月多多少', 'Groceries last month vs the month before')];
  const msgs = state.chat.map((m, i) => {
    if (m.kind === 'q') return `<div class="bubble me ai-msg">${h(m.text)}</div>`;
    if (m.kind === 'answer') {
      // 回答里引用的账单：后来被改过就显示最新的，被删了就不显示
      const rel = (m.related ?? []).map((id) => state.data.tx.get(typeof id === 'object' ? id.id : id)).filter(Boolean);
      return `<div class="card ai-msg ai-ans"><div class="ai-text">${h(m.text)}</div>${rel.length ? `<div class="ai-rel">${rowsOf(rel, L)}</div>` : ''}</div>`;
    }
    if (m.kind === 'draft') return aiDraftCard(m, i, L);
    return `<div class="card ai-msg ai-errc"><div class="err">${h(m.text)}</div><button class="btn link" data-act="ask-retry" data-v="${i}" ${busy ? 'disabled' : ''}>${tr('重试', 'Retry')}</button></div>`;
  }).join('');
  const start = `<div class="ai-hints"><div class="muted ai-hl">${tr('说一句话，记账或提问', 'Say it: record or ask')}</div>${hints.map((x) => `<button class="card ai-hint" data-act="ask-hint" data-v="${h(x)}">${h(x)}</button>`).join('')}</div>`;
  return `<div class="ai-ask">
    <div class="ai-msgs">${state.chat.length ? msgs : start}${busy ? `<div class="muted ai-think">${tr('正在想', 'Thinking')}<i></i><i></i><i></i></div>` : ''}</div>
    <form class="quick ai-in" data-form="ask"><span class="spark">${hmSvg(ICONS.sparkle.d)}</span><input id="quick" placeholder="${tr('记一笔，或者问一句', 'Record or ask')}" autocomplete="off" enterkeyhint="send" aria-label="${tr('记一笔，或者问一句', 'Record or ask')}"><button class="send" aria-label="${tr('发送', 'Send')}" disabled>${hmSvg(ICONS.forward.d)}</button></form>
    <i class="ai-end" aria-hidden="true"></i></div>`;
}

/** 还没入库的账单也用同一种行来显示，只是点了没反应（别处可能还在用）。 */
function txRowStatic(t, L) { return txRow(t, L, true).replace('data-act="view"', 'data-act="noop"').replace('row click', 'row'); }

/** 对话滚到最新的一条。 */
function aiScrollEnd() {
  requestAnimationFrame(() => {
    if (state.tab !== 'ask') return;
    document.querySelector('.ai-ask .ai-end')?.scrollIntoView({ block: 'end', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
}

async function sendAsk(text) {
  const q = String(text ?? '').trim();
  if (!q || state.asking) return;
  state.tab = 'ask'; state.q = ''; state.searching = false; state.aiPick = null;
  state.chat.push({ kind: 'q', text: q }); state.asking = true; render(); aiScrollEnd();
  let msg;
  try { msg = await askLedger(q); } catch (e) { msg = { kind: 'error', text: e instanceof AiError ? e.message : tr('出错了：', 'Something went wrong: ') + (e?.message ?? ''), question: q }; }
  state.chat.push(msg); state.asking = false; render(); aiScrollEnd();
  // 电脑上把光标放回输入框；手机上不放，免得键盘弹出来挡住回答
  if (state.tab === 'ask' && matchMedia('(hover: hover)').matches) document.getElementById('quick')?.focus();
}
// 正在想的时候、或者没写字时按回车：什么也不做，也不清空输入框（app.js 收到提交会先清空再发）
document.addEventListener('submit', (ev) => {
  if (ev.target?.dataset?.form !== 'ask' || !ev.target.closest('.ai-ask')) return;
  const input = ev.target.querySelector('input');
  if (state.asking || !input?.value.trim()) { ev.preventDefault(); ev.stopPropagation(); }
}, true);

// ---------------------------------------------------------------- 净资产曲线（按住左右拖看某个月）

/** 每个月月末的净资产（主货币）：所有账户的"初始余额 + 到月末为止的账单影响"折成主货币，加上那时还没报回来的待报销（同手机端 Insight.netWorthSeries）。 */
function netWorthSeries() {
  const accounts = [...state.data.account.values()], byId = new Map(accounts.map((a) => [a.id, a]));
  const txs = allTxs().sort((a, b) => a.date - b.date);
  const bal = new Map(accounts.map((a) => [a.id, a.initialCents ?? 0]));
  const total = () => accounts.reduce((s, a) => s + toHome(a, bal.get(a.id)), 0);
  const now = new Date(), ny = now.getFullYear(), nm = now.getMonth() + 1;
  if (!txs.length) return [{ y: ny, m: nm, label: ymLabel(ny, nm), cents: total() }];
  const first = dayToDate(txs[0].date);
  let y = first.getUTCFullYear(), m = first.getUTCMonth() + 1;
  if (y > ny || (y === ny && m > nm)) { y = ny; m = nm; }
  const out = [];
  let i = 0;
  while (y < ny || (y === ny && m <= nm)) {
    const end = epochDay(y, m + 1, 0);
    for (; i < txs.length && txs[i].date <= end; i++) {
      const t = txs[i];
      for (const id of new Set([t.accountId, t.toAccountId])) { const a = byId.get(id); if (a) bal.set(id, bal.get(id) + effect(a, t)); }
    }
    out.push({ y, m, label: ymLabel(y, m), cents: total() + pendingReimburse(txs, end) });
    if (m === 12) { y++; m = 1; } else m++;
  }
  return out;
}

function netWorthCard() {
  const series = netWorthSeries(), shown = state.worthAll ? series : series.slice(-12);
  const current = series[series.length - 1].cents, change = series.length >= 2 ? current - series[series.length - 2].cents : null;
  const high = Math.max(...shown.map((p) => p.cents)), low = Math.min(...shown.map((p) => p.cents));
  const delta = change == null ? '' : tr(`比上月 ${aiSigned(change)}`, `${aiSigned(change)} vs last month`);
  const head = `<div class="ai-nw-h"><div class="ai-nw-t"><div class="muted ai-nw-l" data-nw="label">${tr('净资产', 'Net worth')}</div><div class="num ai-nw-v" data-nw="value">${money(current)}</div></div>
      <div class="ai-nw-seg">${seg('worth', [[0, tr('12 个月', '12 mo')], [1, tr('全部', 'All')]], state.worthAll ? 1 : 0)}</div></div>
    <div class="ai-nw-d ${change == null ? '' : change >= 0 ? 'in' : 'out'}" data-nw="delta">${delta}</div>`;
  if (shown.length < 2) return `<div class="card ai-nw">${head}<div class="muted ai-nw-few">${tr('记满两个月就有曲线了', 'The curve appears after two months')}</div></div>`;
  // 画在 100 × 120 的格子里，横向拉伸；圆点和竖线用 HTML 叠在上面，不会被拉扁
  const H = 120, pad = 6, span = Math.max(1, high - low), n = shown.length;
  const X = (i) => +(i * 100 / (n - 1)).toFixed(3), Y = (c) => +(pad + (H - 2 * pad) * (1 - (c - low) / span)).toFixed(3);
  const pts = shown.map((p, i) => [X(i), Y(p.cents)]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < n; i++) { const [ax, ay] = pts[i - 1], [bx, by] = pts[i], mid = +((ax + bx) / 2).toFixed(3); d += ` C${mid},${ay} ${mid},${by} ${bx},${by}`; }
  const zero = low < 0 && high > 0 ? `<line class="ai-nw-zero" x1="0" x2="100" y1="${Y(0)}" y2="${Y(0)}" vector-effect="non-scaling-stroke"/>` : '';
  const data = h(JSON.stringify({ p: shown.map((s) => [s.label, s.cents]), cur: current, chg: change, H }));
  const [lx, ly] = pts[n - 1];
  return `<div class="card ai-nw">${head}
    <div class="ai-nw-plot" data-nw-data="${data}" role="img" aria-label="${tr('净资产曲线，按住左右拖看每个月', 'Net worth chart; press and drag to see each month')}">
      <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="ai-nw-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--primary)" stop-opacity=".28"/><stop offset="1" stop-color="var(--primary)" stop-opacity="0"/></linearGradient></defs>
        <path d="${d} L${lx},${H} L0,${H} Z" fill="url(#ai-nw-fill)"/>${zero}<path d="${d}" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>
      <i class="ai-nw-guide" hidden></i><i class="ai-nw-dot" style="left:${lx}%;top:${(ly * 100 / H).toFixed(3)}%"></i></div>
    <div class="ai-nw-f muted"><span>${h(shown[0].label)}</span><span>${tr(`最高 ${money(high)} · 最低 ${money(low)}`, `High ${money(high)} · Low ${money(low)}`)}</span><span>${h(shown[n - 1].label)}</span></div></div>`;
}

/** 选中第 i 个月（null 表示松手，回到现在的数）：改标题、金额、和前一个月比，挪圆点和竖线。不重画整页。 */
function aiNwShow(plot, i) {
  const card = plot.closest('.ai-nw'), o = JSON.parse(plot.dataset.nwData), n = o.p.length, k = i ?? n - 1;
  const q = (s) => card.querySelector(`[data-nw="${s}"]`);
  q('label').textContent = i == null ? tr('净资产', 'Net worth') : o.p[i][0];
  q('value').textContent = money(i == null ? o.cur : o.p[i][1]);
  const dl = q('delta');
  const d = i == null ? o.chg : i > 0 ? o.p[i][1] - o.p[i - 1][1] : null;
  dl.textContent = d == null ? '' : i == null ? tr(`比上月 ${aiSigned(d)}`, `${aiSigned(d)} vs last month`) : tr(`比前一个月 ${aiSigned(d)}`, `${aiSigned(d)} vs month before`);
  dl.className = `ai-nw-d ${d == null ? '' : d >= 0 ? 'in' : 'out'}`;
  const vals = o.p.map((x) => x[1]), low = Math.min(...vals), span = Math.max(1, Math.max(...vals) - low), pad = 6;
  const x = k * 100 / (n - 1), y = (pad + (o.H - 2 * pad) * (1 - (o.p[k][1] - low) / span)) * 100 / o.H;
  const dot = plot.querySelector('.ai-nw-dot'), guide = plot.querySelector('.ai-nw-guide');
  dot.style.left = x + '%'; dot.style.top = y + '%';
  guide.hidden = i == null; guide.style.left = x + '%';
}
const aiNw = { plot: null, id: null };
function aiNwAt(plot, clientX) {
  const n = JSON.parse(plot.dataset.nwData).p.length, r = plot.getBoundingClientRect();
  aiNwShow(plot, Math.min(n - 1, Math.max(0, Math.floor((clientX - r.left) / Math.max(1, r.width) * (n - 1) + 0.5))));
}
// 按下就选中手指底下的那个月，拖动跟着换，松手恢复。曲线上 touch-action: pan-y，上下滑照样滚动页面
document.addEventListener('pointerdown', (ev) => {
  const plot = ev.target.closest?.('.ai-nw-plot');
  if (!plot || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
  aiNw.plot = plot; aiNw.id = ev.pointerId; aiNwAt(plot, ev.clientX);
});
document.addEventListener('pointermove', (ev) => { if (aiNw.plot && ev.pointerId === aiNw.id) { if (aiNw.plot.isConnected) aiNwAt(aiNw.plot, ev.clientX); else aiNw.plot = null; } });
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, (ev) => {
    if (!aiNw.plot || ev.pointerId !== aiNw.id) return;
    if (aiNw.plot.isConnected) aiNwShow(aiNw.plot, null);
    aiNw.plot = null;
  });
}

// ---------------------------------------------------------------- 修正当前余额（同手机端账户页的弹窗 + LedgerViewModel.checkBalance）

/** 填现在实际有多少：差额挪到初始余额，或者记一笔不计入收支的"余额核对差额"；都会记下今天核对过。 */
async function aiCheckBalance(account, current, target, asBill) {
  const a = state.data.account.get(account.id) ?? account, diff = target - current, day = today();
  if (!asBill || diff === 0) { await saveRecord('account', { ...a, initialCents: (a.initialCents ?? 0) + diff, checkedAt: day }); return; }
  const income = diff > 0, cur = acctCur(a), foreign = cur !== HOME, cents = Math.abs(diff);
  let cat = aiTops(income).find((c) => c.name === '其他');
  if (!cat) { cat = { id: newId(), name: '其他', icon: 'tag', isIncome: income, sortOrder: state.data.category.size, parentId: 0 }; await saveRecord('category', cat); }
  await saveRecord('tx', {
    id: newId(), kind: income ? KIND.INCOME : KIND.EXPENSE, amountCents: foreign ? convert(cents, cur, HOME) ?? cents : cents, categoryId: cat.id, accountId: a.id, toAccountId: 0,
    ledgerId: state.ledgerId, date: day, note: '余额核对差额', tags: '', reimburse: 0, createdAt: Date.now(), currency: foreign ? cur : '', origCents: foreign ? cents : 0,
    excluded: true, offsetOf: 0, offsetParts: '', project: '', fund: '',
  });
  await saveRecord('account', { ...a, checkedAt: day });
}

/** 弹出修正余额的对话框（画在 #app 外面，不受 render() 影响）。保存了返回 true。 */
function fixBalance(accountId) {
  const a = state.data.account.get(Number(accountId));
  if (!a) return Promise.resolve(false);
  return new Promise((done) => {
    const cur = acctCur(a), balance = balanceOf(a, allTxs()), init = a.initialCents ?? 0;
    let bill = false;
    const box = document.createElement('div');
    box.className = 'modal ai-fix';
    box.innerHTML = `<div class="card grid" role="dialog" aria-modal="true" aria-labelledby="ai-fix-t">
      <b id="ai-fix-t" class="ai-dt">${tr('修正当前余额', 'Correct balance')}</b>
      <label class="f">${tr(`现在实际有多少（${cur}）`, `Actual balance now (${cur})`)}<input id="ai-fix-in" inputmode="decimal" autocomplete="off" placeholder="${(balance / 100).toFixed(2)}"></label>
      <div class="seg" role="group"><button type="button" class="on" data-m="0">${tr('改初始余额', 'Adjust opening')}</button><button type="button" data-m="1">${tr('记差额账单', 'Add an entry')}</button></div>
      <div class="muted small ai-fix-note" aria-live="polite"></div>
      <div class="between"><button type="button" class="btn" data-v="0">${tr('取消', 'Cancel')}</button><button type="button" class="btn primary" data-v="1"></button></div></div>`;
    const input = box.querySelector('input'), note = box.querySelector('.ai-fix-note'), ok = box.querySelector('[data-v="1"]');
    const update = () => {
      const t = aiCents(input.value), bad = Number.isNaN(t);
      input.classList.toggle('ai-bad', bad); input.setAttribute('aria-invalid', String(bad));
      ok.disabled = bad;
      ok.textContent = t == null || t === balance ? tr('余额无误', 'Balance is right') : tr('修正', 'Apply');
      note.textContent = t == null || bad ? '' : bill ? tr(`差额 ${money(t - balance, cur)}，不计入收支`, `Difference ${money(t - balance, cur)}, not counted`)
        : tr(`初始余额 ${money(init, cur)} → ${money(t - balance + init, cur)}`, `Opening ${money(init, cur)} → ${money(t - balance + init, cur)}`);
    };
    const key = (e) => { if (e.key === 'Escape') close(false); else if (e.key === 'Enter' && e.target === input && !ok.disabled) ok.click(); };
    const close = (v) => { box.remove(); document.removeEventListener('keydown', key); done(v); };
    box.addEventListener('input', update);
    box.addEventListener('click', async (e) => {
      const m = e.target.closest('[data-m]');
      if (m) { bill = m.dataset.m === '1'; box.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b === m)); update(); return; }
      const b = e.target.closest('button[data-v]');
      if (!b) { if (e.target === box) close(false); return; }
      if (b.dataset.v === '0') { close(false); return; }
      const t = aiCents(input.value);
      if (Number.isNaN(t)) return;
      b.disabled = true;
      try { await aiCheckBalance(a, balance, t ?? balance, bill); close(true); render(); } catch (err) { b.disabled = false; note.innerHTML = `<span class="err">${h(err.message)}</span>`; }
    });
    document.addEventListener('keydown', key);
    document.body.appendChild(box);
    update();
    setTimeout(() => input.focus(), 30);
  });
}

// ---------------------------------------------------------------- 月度复盘（同手机端 ReviewScreen）

/** 周期性项目认哪些账单：分类名（一级或子分类）对上，或者备注里有关键词。 */
function aiCovers(rule, t, L) {
  if (t.kind !== (rule.income ? KIND.INCOME : KIND.EXPENSE)) return false;
  const leaf = state.data.category.get(t.categoryId)?.name, top = L.top(t.categoryId)?.name, note = (t.note ?? '').toLowerCase();
  return (rule.categories ?? []).some((c) => c === leaf || c === top) || (rule.keywords ?? []).some((k) => k && note.includes(String(k).toLowerCase()));
}

function aiReview(y, m, L) {
  const inMonth = (yy, mm) => { const from = epochDay(yy, mm, 1), to = epochDay(yy, mm + 1, 0); return allTxs().filter((t) => t.ledgerId === state.ledgerId && t.date >= from && t.date <= to); };
  const pd = new Date(y, m - 2, 1);
  const list = inMonth(y, m), before = inMonth(pd.getFullYear(), pd.getMonth() + 1);
  const now = L.totals(list), prev = L.totals(before);
  // 按一级分类算支出（口径和统计页一样：扣掉抵扣，不含报销、退款、不计）
  const byTop = (l) => { const map = new Map(); for (const t of l) if (t.kind === KIND.EXPENSE && L.counts(t)) { const k = L.top(t.categoryId)?.id ?? 0; map.set(k, (map.get(k) ?? 0) + L.net(t)); } return map; };
  const catNow = byTop(list), catPrev = byTop(before);
  const top5 = [...catNow.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const deltas = [...new Set([...catNow.keys(), ...catPrev.keys()])].map((k) => [k, (catNow.get(k) ?? 0) - (catPrev.get(k) ?? 0)]);
  const rise = deltas.filter((x) => x[1] > 0).reduce((b, x) => (!b || x[1] > b[1] ? x : b), null);
  const fall = deltas.filter((x) => x[1] < 0).reduce((b, x) => (!b || x[1] < b[1] ? x : b), null);
  const spends = list.filter((t) => t.kind === KIND.EXPENSE && L.counts(t));
  const biggest = spends.slice().sort((a, b) => L.net(b) - L.net(a)).slice(0, 3);
  // 这个月过了几天：当月算到今天，过去的月份算整月，还没到的月份算 0
  const d = new Date(), cy = d.getFullYear(), cm = d.getMonth() + 1;
  const days = y === cy && m === cm ? d.getDate() : y < cy || (y === cy && m < cm) ? new Date(y, m, 0).getDate() : 0;
  const perDay = new Map();
  for (const t of spends) perDay.set(t.date, (perDay.get(t.date) ?? 0) + L.net(t));
  const pos = [...perDay.entries()].filter((x) => x[1] > 0);
  const busiest = pos.reduce((b, x) => (!b || x[1] > b[1] ? x : b), null);
  const quiet = Math.max(0, days - pos.filter(([day]) => dayToDate(day).getUTCDate() <= days).length);
  const pending = sum(list.filter((t) => t.kind === KIND.EXPENSE && t.reimburse === 1), (t) => t.amountCents);
  // 周期性项目按所有账本看（和"周期性收支"页一样），这个月一笔都没有的列出来
  const from = epochDay(y, m, 1), to = epochDay(y, m + 1, 0);
  const monthAll = allTxs().filter((t) => !t.excluded && t.date >= from && t.date <= to);
  const rules = shared.get('recurring', store.get('hl.recurring', typeof RECURRING_DEFAULT !== 'undefined' ? RECURRING_DEFAULT : [])) ?? [];
  const missing = rules.filter((r) => !monthAll.some((t) => aiCovers(r, t, L)));
  return { list, now, prev, catPrev, top5, rise, fall, spends, biggest, days, busiest, quiet, pending, missing };
}

const aiCatNameOf = (id) => aiCat(state.data.category.get(id)) || tr('未分类', 'Uncategorized');
const aiPct = (a, b) => (b === 0 ? '' : ` (${a >= b ? '+' : ''}${Math.round((a - b) * 100 / Math.abs(b))}%)`);

/** 交给 AI 的只有这些数字和分类名，没有任何一笔账单的原文（同手机端 facts()）。 */
function aiFacts(y, m, r, L) {
  const { now, prev } = r, label = ymLabel(y, m), avg = r.days ? Math.trunc(now.expense / r.days) : 0, lines = [];
  lines.push(tr(`月份：${label}，已过 ${r.days} 天。币种 ${HOME}。`, `Month: ${label}, ${r.days} days elapsed. Currency ${HOME}.`));
  lines.push(tr(`收入 ${money(now.income)}（上月 ${money(prev.income)}）`, `Income ${money(now.income)} (last month ${money(prev.income)})`));
  lines.push(tr(`支出 ${money(now.expense)}（上月 ${money(prev.expense)}）`, `Expenses ${money(now.expense)} (last month ${money(prev.expense)})`));
  lines.push(tr(`结余 ${money(now.income - now.expense)}（上月 ${money(prev.income - prev.expense)}）`, `Net ${money(now.income - now.expense)} (last month ${money(prev.income - prev.expense)})`));
  if (r.top5.length) lines.push(tr('支出最多的分类：', 'Top expense categories:') + r.top5.map(([id, c]) => `${aiCatNameOf(id)} ${money(c)} (${tr('上月', 'last month')} ${money(r.catPrev.get(id) ?? 0)})`).join('; '));
  if (r.rise) lines.push(tr(`涨得最多：${aiCatNameOf(r.rise[0])} ${aiSigned(r.rise[1])}`, `Biggest rise: ${aiCatNameOf(r.rise[0])} ${aiSigned(r.rise[1])}`));
  if (r.fall) lines.push(tr(`降得最多：${aiCatNameOf(r.fall[0])} ${aiSigned(r.fall[1])}`, `Biggest drop: ${aiCatNameOf(r.fall[0])} ${aiSigned(r.fall[1])}`));
  if (r.biggest.length) lines.push(tr('最大的几笔支出：', 'Largest expenses:') + r.biggest.map((t) => `${aiCatNameOf(L.top(t.categoryId)?.id ?? 0)} ${money(L.net(t))}`).join('; '));
  if (r.days > 0) lines.push(tr(`日均支出 ${money(avg)}，没花钱的天数 ${r.quiet}。`, `Average per day ${money(avg)}, days without spending ${r.quiet}.`));
  if (r.busiest) lines.push(tr(`花钱最多的一天花了 ${money(r.busiest[1])}。`, `The busiest day cost ${money(r.busiest[1])}.`));
  if (r.pending > 0 || now.reimbursed > 0) lines.push(tr(`新增待报销 ${money(r.pending)}，报回 ${money(now.reimbursed)}。`, `New claims ${money(r.pending)}, reimbursed ${money(now.reimbursed)}.`));
  if (r.missing.length) lines.push(tr('本月还没出现的周期性项目：', 'Recurring items not seen yet this month: ') + r.missing.map((x) => x.name).join(', '));
  return lines.join('\n');
}

/** 故事卡片：一张讲一件事，左右滑着看。 */
function aiStories(y, m, r, L) {
  const { now, prev } = r, out = [], avg = r.days ? Math.trunc(now.expense / r.days) : 0, label = ymLabel(y, m);
  const dlt = now.expense - prev.expense;
  const line1 = [prev.expense > 0 ? (dlt >= 0 ? tr(`比上月多 ${money(dlt)}`, `${money(dlt)} more than last month`) : tr(`比上月少 ${money(-dlt)}`, `${money(-dlt)} less than last month`)) : '',
    r.days > 0 ? tr(`平均每天 ${money(avg)}`, `${money(avg)} a day`) : ''].filter(Boolean).join(tr('，', ', '));
  // 第一张（封面）：这个月的主题行星 + "土星月"
  out.push({ c: ['#7B6CF6', '#4E8DF5'], icon: 'receipt', planet: typeof plOfMonth === 'function' ? plOfMonth(y, m) : null, kicker: tr(`${label}，你一共花了`, `In ${label} you spent`), big: money(now.expense), line: line1 });
  if (r.top5.length) {
    const [id, c] = r.top5[0], pct = Math.round(c * 100 / Math.max(1, now.expense));
    out.push({ c: ['#FF8A5B', '#F2557A'], icon: state.data.category.get(id)?.icon ?? 'tag', kicker: tr('钱主要花在了', 'Most of it went to'), big: aiCatNameOf(id), line: tr(`${money(c)}，占 ${pct}%`, `${money(c)}, ${pct}% of spending`) });
  }
  if (r.biggest.length) {
    const t = r.biggest[0];
    out.push({ c: ['#22B59A', '#1C7FD6'], icon: state.data.category.get(t.categoryId)?.icon ?? 'tag', kicker: tr('最大的一笔', 'The biggest one'), big: money(L.net(t)),
      line: `${aiMD(t.date)} · ${(t.note || aiCatNameOf(L.top(t.categoryId)?.id ?? 0)).slice(0, 40)}` });
  }
  if (r.busiest) {
    const [day, c] = r.busiest;
    out.push({ c: ['#F5A623', '#E5674D'], icon: 'calendar', kicker: tr('花钱最多的一天', 'Your biggest day'), big: money(c), line: aiMD(day) + (r.quiet > 0 ? tr(`，这个月还有 ${r.quiet} 天一分没花`, ` · ${r.quiet} no-spend days`) : '') });
  }
  const net = now.income - now.expense;
  out.push(net >= 0 ? { c: ['#34C77B', '#15A0A0'], icon: 'star', kicker: tr('这个月存下了', 'You saved'), big: money(net), line: tr(`收入 ${money(now.income)}`, `Income ${money(now.income)}`) }
    : { c: ['#E5484D', '#9B3FD1'], icon: 'chart', kicker: tr('这个月多花了', 'You overspent by'), big: money(-net), line: tr(`收入 ${money(now.income)}`, `Income ${money(now.income)}`) });
  return out;
}

const aiMonthKey = () => `${state.month.y}-${state.month.m}`;

/**
 * 月度复盘。统计页的"复盘"一栏直接调用它。按 state.month 看；自带一个月份切换（统计页自己有月份切换时传 { switcher: false }）。
 */
function reviewView({ switcher = true } = {}) {
  const L = computeLookup(), { y, m } = state.month, r = aiReview(y, m, L), key = aiMonthKey(), { now, prev } = r;
  // 换了月份，故事卡片从第一张看起
  if (state.reviewPageKey !== key) { state.reviewPageKey = key; state.reviewPage = 0; }
  const fig = (label, cents, last, cls, goodUp) => {
    const d = cents - last, dc = d === 0 ? 'muted' : (d > 0) === goodUp ? 'in' : 'out';
    return `<div><div class="muted ai-fl">${label}</div><div class="num ai-fv ${cls}">${money(cents)}</div><div class="ai-fd ${dc}">${aiSigned(d)}${aiPct(cents, last)}</div></div>`;
  };
  const parts = [];
  if (switcher) parts.push(`<div class="ai-rv-month">${monthBar()}</div>`);
  if (!r.list.length) parts.push(aiEmpty('review', tr('这个月还没有账单', 'Nothing this month yet')));
  if (r.spends.length) {
    const stories = aiStories(y, m, r, L);
    parts.push(`<div class="ai-stories"><div class="ai-pager" data-n="${stories.length}">${stories.map((s, i) => `<section class="ai-story" style="--c1:${s.c[0]};--c2:${s.c[1]};--d:${-(i * 3.7).toFixed(1)}s" aria-roledescription="${tr('卡片', 'card')}" aria-label="${i + 1} / ${stories.length}">
        <i class="ai-sh" aria-hidden="true"></i>
        ${s.planet ? `<span class="ai-splanet">${planetSvg(s.planet, { px: 64 })}<span>${h(tr(s.planet.zh + '月', s.planet.en + ' month'))}</span></span>` : `<span class="ai-sbox">${aiIcon(s.icon)}</span>`}<span class="ai-sgap"></span>
        <div class="ai-sk">${h(s.kicker)}</div><div class="ai-sb${/\d/.test(s.big) ? ' num' : ''}">${h(s.big)}</div>${s.line ? `<div class="ai-sl">${h(s.line)}</div>` : ''}</section>`).join('')}</div>
      <div class="ai-dots" aria-hidden="true">${stories.map((_, i) => `<i class="${i === state.reviewPage ? 'on' : ''}"></i>`).join('')}</div></div>`);
    // 重画以后翻回刚才看的那一张
    const page = state.reviewPage;
    if (page) requestAnimationFrame(() => { const p = document.querySelector('.ai-pager'); if (p) p.scrollLeft = page * (p.clientWidth + 12); });
  }
  parts.push(`<div class="card ai-figs"><div class="ai-three">${fig(tr('支出', 'Expense'), now.expense, prev.expense, 'out', false)}${fig(tr('收入', 'Income'), now.income, prev.income, 'in', true)}${fig(tr('结余', 'Net'), now.income - now.expense, prev.income - prev.expense, '', true)}</div>
    <div class="muted ai-fnote">${tr('小字是和上月比', 'Small print: vs last month')}</div></div>`);
  const busy = state.reviewBusy === key, text = state.reviewText?.[key] ?? '', fail = state.reviewFail?.[key] ?? '';
  parts.push(`<div class="card ai-sum"><div class="ai-sum-h">${iconTile('sparkle', 'ai-t32')}<b>${tr('AI 总结', 'AI summary')}</b>
      ${busy ? `<span class="ai-spin" role="status" aria-label="${tr('正在写', 'Writing')}"></span>` : `<button class="btn link" data-act="review-ai" ${aiKey() && r.list.length && !state.reviewBusy ? '' : 'disabled'}>${text ? tr('重写', 'Rewrite') : tr('写一段', 'Write')}</button>`}</div>
    ${aiKey() ? '' : `<div class="muted small">${tr('要先在设置里填 API 密钥', 'Set an API key in Settings first')}</div>`}
    ${text ? `<div class="ai-sum-t">${h(text)}</div>` : ''}${fail ? `<div class="err ai-sum-e">${h(fail)}</div>` : ''}</div>`);
  if (r.top5.length) {
    parts.push(`<div class="card ai-where"><div class="muted ai-ch">${tr('钱花在哪了', 'Where it went')}</div>${r.top5.map(([id, cents]) => {
      const d = cents - (r.catPrev.get(id) ?? 0);
      const dt = d === 0 ? tr('和上月一样', 'Same as last month') : d > 0 ? tr(`比上月多 ${money(d)}`, `${money(d)} more than last month`) : tr(`比上月少 ${money(-d)}`, `${money(-d)} less than last month`);
      return `<div class="ai-wr">${iconTile(state.data.category.get(id)?.icon ?? 'tag')}<div class="main"><div class="title">${h(aiCatNameOf(id))}</div><div class="ai-wd ${d > 0 ? 'out' : d < 0 ? 'in' : 'muted'}">${dt}</div></div><div class="num">${money(cents)}</div></div>`;
    }).join('')}
      ${r.rise || r.fall ? `<div class="ai-rf">${r.rise ? `<div class="out">${tr(`涨得最多：${aiCatNameOf(r.rise[0])} ${aiSigned(r.rise[1])}`, `Biggest rise: ${aiCatNameOf(r.rise[0])} ${aiSigned(r.rise[1])}`)}</div>` : ''}${r.fall ? `<div class="in">${tr(`降得最多：${aiCatNameOf(r.fall[0])} ${aiSigned(r.fall[1])}`, `Biggest drop: ${aiCatNameOf(r.fall[0])} ${aiSigned(r.fall[1])}`)}</div>` : ''}</div>` : ''}</div>`);
  }
  if (r.biggest.length) parts.push(`<div class="card ai-big"><div class="muted ai-ch">${tr('最大的几笔', 'Largest expenses')}</div>${rowsOf(r.biggest, L)}</div>`);
  if (r.days > 0 && r.list.length) {
    const bd = r.busiest ? dayToDate(r.busiest[0]) : null;
    parts.push(`<div class="card ai-rhythm"><div class="ai-three"><div><div class="muted ai-fl">${tr('日均支出', 'Per day')}</div><div class="num ai-rv">${money(Math.trunc(now.expense / r.days))}</div></div>
      <div><div class="muted ai-fl">${tr('花得最多的一天', 'Busiest day')}</div><div class="num ai-rv">${r.busiest ? money(r.busiest[1]) : '—'}</div>${bd ? `<div class="muted ai-fd">${tr(`${bd.getUTCMonth() + 1}月${bd.getUTCDate()}日`, dayISO(r.busiest[0]))}</div>` : ''}</div>
      <div class="right"><div class="muted ai-fl">${tr('没花钱', 'No-spend days')}</div><div class="num ai-rv">${tr(`${r.quiet} 天`, String(r.quiet))}</div></div></div></div>`);
  }
  if (r.pending > 0 || now.reimbursed > 0) parts.push(`<div class="card ai-claim"><div class="muted ai-ch">${tr('报销', 'Claims')}</div><div class="between"><span class="amber">${tr(`新增待报销 ${money(r.pending)}`, `New to claim ${money(r.pending)}`)}</span><span class="in">${tr(`报回 ${money(now.reimbursed)}`, `Reimbursed ${money(now.reimbursed)}`)}</span></div></div>`);
  if (r.missing.length) parts.push(`<div class="card ai-miss"><div class="muted ai-ch">${tr('这个月还没出现', 'Not seen yet this month')}</div><div class="amber ai-mt">${h(r.missing.map((x) => x.name).join('、'))}</div></div>`);
  return `<div class="ai-review grid">${parts.join('')}</div>`;
}
// 故事卡片翻页时，下面的小圆点跟着走
document.addEventListener('scroll', (ev) => {
  const p = ev.target;
  if (!(p instanceof Element) || !p.classList.contains('ai-pager')) return;
  const i = Math.round(p.scrollLeft / Math.max(1, p.clientWidth + 12));
  if (i === state.reviewPage) return;
  state.reviewPage = i;
  p.parentElement.querySelectorAll('.ai-dots i').forEach((d, k) => d.classList.toggle('on', k === i));
}, true);

async function writeReview(y, m) {
  const L = computeLookup(), r = aiReview(y, m, L);
  const system = LANG === 'en'
    ? 'You are a personal finance assistant. From the monthly figures the user gives you, write a review of 3 to 5 sentences in English: what stands out, how it compares with last month, and exactly one practical suggestion. Plain text only, no lists, no headings. Use only the numbers provided; do not invent any.'
    : '你是个人记账助手。根据用户给出的这个月的数字，用 3 到 5 句中文写一段复盘：哪里值得注意、和上个月比怎么样，最后给且只给一条可行的建议。只写正文，不要列表和标题。只用给出的数字，不要编造。';
  const out = await aiJson(system, aiFacts(y, m, r, L), { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } }, 2000);
  const text = String(out.summary ?? '').trim();
  if (!text) throw new AiError(tr('AI 没有给出总结，请重试。', 'The AI gave no summary. Try again.'));
  return text;
}

// ---------------------------------------------------------------- 对账：银行账单对账本（同手机端 ReconcileScreen + Reconcile.run）

const REC_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['transactions'],
  properties: { transactions: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['date', 'amount', 'type', 'currency', 'merchant', 'details', 'counterparty', 'category', 'subcategory', 'account', 'to_account'],
    properties: {
      date: { type: 'string' }, amount: { type: 'number' }, type: { type: 'string', enum: ['expense', 'income', 'transfer'] }, currency: { type: 'string' },
      merchant: { type: 'string' }, details: { type: 'string' }, counterparty: { type: 'string' }, category: { type: 'string' }, subcategory: { type: 'string' },
      account: { type: 'string' }, to_account: { type: 'string' },
    },
  } } },
};

function aiRecSystem(target) {
  const cats = [...state.data.category.values()];
  const names = (income) => aiTops(income).map((c) => { const subs = cats.filter((s) => s.parentId === c.id).map((s) => s.name); return subs.length ? `${c.name}（${subs.join('、')}）` : c.name; }).join('；');
  return `你是记账助手。用户会提供银行或支付应用的账单：手机截图、PDF 对账单，或导出的表格文本。账单可能是中文、荷兰语或英语。
这份账单属于用户的「${target.name}」账户。请逐笔提取其中的交易，要求：
- date：交易日期，格式 YYYY-MM-DD。只写了月和日时，年份按今天（${dayISO(today())}）往前推断，不要得出未来的日期。
- amount：金额的绝对值，正数。注意欧洲写法 1.234,56 表示 1234.56。
- type：钱流出账户是 expense，流入是 income；用户在自己的两个账户之间挪钱是 transfer（见下）。
- currency：ISO 货币代码（EUR、CNY、USD 等），按账单上的符号或银行所在地判断。
- merchant：商户或交易对方的简短名称；没有就用交易摘要。
- details：这笔交易的原始说明，照抄成一行，不超过 200 个字符；长串的流水号、卡号、IBAN 可以省略；没有填空字符串。
- counterparty：交易对方的名称，照账单原样填；没有填空字符串。
- category：一级分类。支出只能从这些里选一个（括号里是它的子分类）：${names(false)}。收入只能从这些里选一个：${names(true)}。填括号前面的名字，拿不准时选"其他"。
- subcategory：所选一级分类括号里的一个子分类，原样填；没有合适的填空字符串。
- account：这笔交易发生在用户的哪个账户，只能从用户的账户名单里原样选一个；认不出填空字符串。
- to_account：仅 transfer 使用，其余填空字符串。
用户自己的账户名单：${aiAccounts().map((a) => a.name).join('、') || '（无）'}。
转账的判断：交易对方是用户自己的另一个账户（对方名称或摘要能对应到名单里的某个账户，或写明是本人账户互转、转入储蓄 / 投资账户、给自己的钱包充值或提现、信用卡还款、券商或交易所出入金），
就记为 transfer：account 填钱转出的账户，to_account 填钱转入的账户，category 填空字符串。只认得出一头时，认不出的那头填空字符串；对方是别人就按普通的 expense / income 处理。
只提取已完成的真实交易：忽略余额、小计、合计行，忽略失败、已撤销或待处理的交易。长截图会被切成上下相邻且有少量重叠的多张图片，重叠处的同一笔交易只算一笔。
如果内容里没有任何交易，返回空列表。不要编造看不清的内容。`;
}

/** 一张图片 → 一组 JPEG 内容块：宽度压到 1200 以内；长截图切成上下有重叠的几段。 */
async function aiImageBlocks(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new AiError(tr(`读不了图片「${file.name}」。`, `Couldn't read the image "${file.name}".`))); i.src = url; });
    const scale = Math.min(1, 1200 / img.naturalWidth), w = Math.round(img.naturalWidth * scale), hh = Math.round(img.naturalHeight * scale);
    const seg = Math.round(w * 1.6), overlap = Math.round(w * 0.12), blocks = [];
    for (let top = 0; top < hh; top += seg - overlap) {
      const part = Math.min(seg, hh - top), c = document.createElement('canvas');
      c.width = w; c.height = part;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, part);
      g.drawImage(img, 0, top / scale, img.naturalWidth, part / scale, 0, 0, w, part);
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] } });
      if (top + part >= hh || blocks.length >= 12) break;
    }
    return blocks;
  } finally { URL.revokeObjectURL(url); }
}
const aiBase64 = async (file) => { const bytes = new Uint8Array(await file.arrayBuffer()); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
/** 文字账单：先按 UTF-8 读，乱码就按 GBK（国内银行导出的 CSV 常是 GBK）。 */
async function aiFileText(file) {
  const buf = await file.arrayBuffer(), utf = new TextDecoder('utf-8').decode(buf);
  if (!utf.includes('�')) return utf.replace(/^﻿/, '');
  try { return new TextDecoder('gbk').decode(buf); } catch { return utf; }
}
async function aiXlsxText(file) {
  if (typeof xlsxToCsv === 'function') {
    for (const arg of [() => file.arrayBuffer(), () => file]) {
      try { const r = await xlsxToCsv(await arg()); if (r) return Array.isArray(r) ? r.join('\n') : String(r); } catch { /* 换一种参数再试 */ }
    }
  }
  return aiFileText(file);
}
/** 一段文字账单（带表头）要识别的内容。 */
const aiTextJob = (name, header, lines) => ({ name, header, lines, content: `以下是账单文件「${name}」的一部分（第一行是表头）：\n\n${header}\n${lines.join('\n')}` });

/** 读全部文件，返回识别出的流水（ParsedTx 的样子）。最多三段同时识别。 */
async function aiReadStatements(files, target, onProgress) {
  const jobs = [];
  for (const f of files) {
    const name = f.name || 'file', type = f.type || '';
    if (/\.pdf$/i.test(name) || type === 'application/pdf') {
      if (f.size > 30 * 1024 * 1024) throw new AiError(tr(`「${name}」超过 30 MB，请拆开再试。`, `"${name}" is over 30 MB. Split it and retry.`));
      jobs.push({ name, content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await aiBase64(f) } }, { type: 'text', text: '读出这份账单里的全部交易。' }] });
    } else if (type.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(name)) {
      jobs.push({ name, content: [...await aiImageBlocks(f), { type: 'text', text: '读出这份账单里的全部交易。' }] });
    } else {
      const text = /\.xlsx?$/i.test(name) || /spreadsheet|ms-excel/.test(type) ? await aiXlsxText(f) : await aiFileText(f);
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) continue;
      for (let i = 1; i < lines.length; i += 20) jobs.push(aiTextJob(name, lines[0], lines.slice(i, i + 20)));
    }
  }
  if (!jobs.length) throw new AiError(tr('文件里没有内容。', 'The files are empty.'));
  const system = aiRecSystem(target), order = jobs.slice(), queue = jobs.slice();
  let done = 0, total = jobs.length, found = 0;
  onProgress(0, total, 0);
  const work = async () => {
    while (queue.length) {
      const job = queue.shift();
      let r;
      try { r = await aiJson(system, job.content, REC_SCHEMA, 32000); } catch (e) {
        // 一段的结果装不下：文字账单对半拆开再识别
        if (e.tooLong && job.lines?.length > 1) {
          const half = job.lines.length >> 1, a = aiTextJob(job.name, job.header, job.lines.slice(0, half)), b = aiTextJob(job.name, job.header, job.lines.slice(half));
          order.splice(order.indexOf(job), 1, a, b); queue.unshift(a, b); total++;
          onProgress(done, total, found); continue;
        }
        throw e;
      }
      job.rows = r.transactions ?? [];
      done++; found += job.rows.length;
      onProgress(done, total, found);
    }
  };
  await Promise.all([work(), work(), work()]);
  // 结果按原来的顺序拼起来
  const rows = order.flatMap((j) => j.rows ?? []);
  const out = [];
  for (const o of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date ?? '')) continue;
    const cents = Math.round(Math.abs(Number(o.amount)) * 100);
    if (!Number.isFinite(cents) || cents <= 0) continue;
    const account = String(o.account ?? '').trim(), toAccount = String(o.to_account ?? '').trim();
    const transfer = o.type === 'transfer' && account !== toAccount;
    const merchant = String(o.merchant ?? '').trim(), details = String(o.details ?? '').trim();
    out.push({
      date: isoToDay(o.date), cents, kind: transfer ? KIND.TRANSFER : o.type === 'income' ? KIND.INCOME : KIND.EXPENSE,
      currency: String(o.currency ?? '').trim().toUpperCase() || HOME,
      note: [merchant && !details.toLowerCase().includes(merchant.toLowerCase()) ? merchant : '', details].filter(Boolean).join(', ').slice(0, 500),
      counterparty: String(o.counterparty ?? '').trim(), category: transfer ? '' : String(o.category ?? '').trim(), sub: transfer ? '' : String(o.subcategory ?? '').trim(),
      // 收支一律算在所选账户上；转账保留两头
      account: transfer ? account : target.name, toAccount: transfer ? toAccount : '',
    });
  }
  return out;
}

/** 这一行对所选账户来说是进还是出：收入为正，支出为负；转账看哪一头是这个账户，认不出按出账算。 */
const aiRecSigned = (p, a) => (p.kind === KIND.INCOME || (p.kind === KIND.TRANSFER && p.toAccount === a.name && p.account !== a.name) ? p.cents : -p.cents);
/** 给人看的一行原文：备注为主，转账带上两头的账户名。 */
const aiRecDescribe = (p) => [p.note, p.counterparty && !p.note.toLowerCase().includes(p.counterparty.toLowerCase()) ? p.counterparty : '',
  p.kind === KIND.TRANSFER ? [p.account, p.toAccount].filter(Boolean).join(' → ') : ''].filter(Boolean).join(' · ');

/**
 * 同手机端 Reconcile.run：
 * 1. 金额相同、日期相差 0、1、2、3、5、8 天的逐级配对（先配最近的）；
 * 2. 剩下的银行行先看是不是记在了别的账户（同金额、三天内）；账本多出来的只看流水日期范围内的；
 * 3. 十天之内两边多出来的合计正好相等，就是同一笔钱的不同记法（sameMoney）。
 */
function aiReconcileRun(bank, account) {
  const id = account.id, all = allTxs().sort(byNewest);
  const mine = all.filter((t) => t.accountId === id || t.toAccountId === id), others = all.filter((t) => t.accountId !== id && t.toAccountId !== id);
  const empty = { matched: 0, bankOnly: [], ledgerOnly: [], misplaced: [], bankTotal: 0, ledgerTotal: 0, diff: 0, open: 0 };
  if (!bank.length) return empty;
  const from = Math.min(...bank.map((b) => b.date)), to = Math.max(...bank.map((b) => b.date));
  const ledger = mine.map((tx) => ({ tx, cents: effect(account, tx) })).filter((x) => x.cents !== 0);
  const bankUsed = bank.map(() => false), ledgerUsed = ledger.map(() => false), byCents = new Map();
  bank.forEach((b, i) => { if (!byCents.has(b.cents)) byCents.set(b.cents, []); byCents.get(b.cents).push(i); });
  for (const step of [0, 1, 2, 3, 5, 8]) {
    ledger.forEach((l, i) => {
      if (ledgerUsed[i]) return;
      let best = -1, gap = Infinity;
      for (const k of byCents.get(l.cents) ?? []) { const g = Math.abs(bank[k].date - l.tx.date); if (!bankUsed[k] && g <= step && g < gap) { best = k; gap = g; } }
      if (best >= 0) { bankUsed[best] = true; ledgerUsed[i] = true; }
    });
  }
  const matched = ledgerUsed.filter(Boolean).length;
  const restBank = bank.filter((_, i) => !bankUsed[i]).sort((a, b) => a.date - b.date);
  const taken = new Set(), misplaced = [], loneBank = [];
  for (const row of restBank) {
    let hit = null, gap = Infinity;
    for (const t of others) {
      if (taken.has(t.id) || t.kind === KIND.TRANSFER || t.accountId === id || (t.kind === KIND.INCOME ? t.amountCents : -t.amountCents) !== row.cents) continue;
      const g = Math.abs(t.date - row.date);
      if (g <= 3 && g < gap) { hit = t; gap = g; }
    }
    if (hit) { taken.add(hit.id); misplaced.push({ row, tx: hit }); } else loneBank.push(row);
  }
  const loneLedger = ledger.filter((l, i) => !ledgerUsed[i] && l.tx.date >= from && l.tx.date <= to).sort((a, b) => a.tx.date - b.tx.date);
  // 成组抵消
  const days = new Map(), day = (d) => { if (!days.has(d)) days.set(d, { date: d, b: [], l: [], net: 0 }); return days.get(d); };
  loneBank.forEach((row, i) => { const x = day(row.date); x.b.push(i); x.net += row.cents; });
  loneLedger.forEach((l, i) => { const x = day(l.tx.date); x.l.push(i); x.net -= l.cents; });
  const list = [...days.values()].sort((a, b) => a.date - b.date), sameB = new Set(), sameL = new Set();
  for (let i = 0; i < list.length;) {
    let s = 0, hb = false, hl = false, end = -1;
    for (let j = i; j < list.length && list[j].date - list[i].date <= 10; j++) {
      s += list[j].net; hb = hb || list[j].b.length > 0; hl = hl || list[j].l.length > 0;
      if (s === 0 && hb && hl) { end = j; break; }
    }
    if (end >= 0) { for (let k = i; k <= end; k++) { list[k].b.forEach((x) => sameB.add(x)); list[k].l.forEach((x) => sameL.add(x)); } i = end + 1; } else i++;
  }
  const bankOnly = loneBank.map((row, i) => ({ row, same: sameB.has(i) })), ledgerOnly = loneLedger.map((l, i) => ({ ...l, same: sameL.has(i) }));
  const bankTotal = sum(bank, (b) => b.cents), ledgerTotal = sum(ledger.filter((_, i) => ledgerUsed[i]), (l) => l.cents) + sum(loneLedger, (l) => l.cents);
  return { matched, bankOnly, ledgerOnly, misplaced, bankTotal, ledgerTotal, diff: bankTotal - ledgerTotal,
    open: bankOnly.filter((x) => !x.same).length + ledgerOnly.filter((x) => !x.same).length + misplaced.length };
}
/** 兼容旧的调用：reconcile(银行行 [{date:'YYYY-MM-DD', amount, text}], 账户 id) */
function reconcile(bankRows, accountId) {
  const a = state.data.account.get(accountId);
  return aiReconcileRun(bankRows.map((r, i) => ({ date: isoToDay(r.date), cents: Math.round(Number(r.amount) * 100), text: r.text ?? '', key: i })).filter((b) => Number.isFinite(b.date) && b.cents), a);
}

/** 流水上的一行 → 可以直接记进所选账户的草稿。外币的不处理（null）；分类只认已有的，认不出归"其他"；转账另一头认不出时按普通收支记。 */
function aiRecDraft(p, account) {
  if (p.currency && p.currency !== HOME) return null;
  const known = new Set(aiAccounts().map((a) => a.name));
  if (p.kind === KIND.TRANSFER) {
    const incoming = p.toAccount === account.name && p.account !== account.name, other = incoming ? p.account : p.toAccount;
    if (known.has(other) && other !== account.name) return { ...p, account: incoming ? other : account.name, toAccount: incoming ? account.name : other };
    return { ...p, kind: incoming ? KIND.INCOME : KIND.EXPENSE, category: '其他', sub: '', account: account.name, toAccount: '' };
  }
  const income = p.kind === KIND.INCOME, category = aiTops(income).some((c) => c.name === p.category) ? p.category : '其他';
  return { ...p, category, sub: category === p.category ? p.sub : '', account: account.name, toAccount: '' };
}
/** 分类按名字找，没有就新建（同手机端 importDrafts）。 */
async function aiCategoryFor(name, sub, income) {
  const topName = name || '其他';
  let top = aiTops(income).find((c) => c.name === topName);
  if (!top) { top = { id: newId(), name: topName, icon: iconKey(topName), isIncome: income, sortOrder: state.data.category.size, parentId: 0 }; await saveRecord('category', top); }
  if (!sub || sub === topName) return top.id;
  let leaf = [...state.data.category.values()].find((c) => c.parentId === top.id && c.name === sub);
  if (!leaf) { const icon = iconKey(sub); leaf = { id: newId(), name: sub, icon: icon === 'tag' ? top.icon : icon, isIncome: income, sortOrder: state.data.category.size, parentId: top.id }; await saveRecord('category', leaf); }
  return leaf.id;
}
async function aiRecImport(p, account) {
  const d = aiRecDraft(p, account);
  if (!d) return;
  const transfer = d.kind === KIND.TRANSFER, byName = (n) => aiAccounts().find((a) => a.name === n)?.id ?? account.id;
  await saveRecord('tx', {
    id: newId(), kind: d.kind, amountCents: d.cents, categoryId: transfer ? 0 : await aiCategoryFor(d.category, d.sub, d.kind === KIND.INCOME),
    accountId: byName(d.account), toAccountId: transfer ? byName(d.toAccount) : 0, ledgerId: state.ledgerId, date: d.date, note: d.note, tags: '',
    reimburse: 0, createdAt: Date.now(), currency: '', origCents: 0, excluded: false, offsetOf: 0, offsetParts: '', project: '', fund: '',
  });
}

/** 对账页的状态（app.js 里的 state.rec，缺的字段在这里补上）。 */
function aiRec() {
  const rec = state.rec ?? (state.rec = {});
  for (const [k, v] of Object.entries({ accountId: 0, busy: false, done: 0, total: 0, found: 0, error: '', showSame: false, files: [], balanceText: '', parsed: null })) if (rec[k] === undefined) rec[k] = v;
  return rec;
}

function reconcileView() {
  const rec = aiRec(), target = state.data.account.get(rec.accountId), cur = target ? acctCur(target) : HOME;
  if (rec.busy) {
    const many = rec.total > 1;
    return `<div class="ai-rec"><div class="card ai-load" role="status">${many
      ? `<b>${tr(`正在识别 ${rec.done} / ${rec.total} 段`, `Reading part ${rec.done} of ${rec.total}`)}</b><div class="bar ai-pbar"><i style="width:${(rec.done * 100 / rec.total).toFixed(1)}%"></i></div><div class="muted small">${tr(`已读出 ${rec.found} 笔`, `${rec.found} found so far`)}</div>`
      : `<span class="ai-spin lg"></span><div class="muted">${tr('正在读取账单…', 'Reading…')}</div>`}</div></div>`;
  }
  if (!rec.parsed || !target) {
    const accounts = aiAccounts().filter((a) => !a.archived || a.id === rec.accountId);
    const files = rec.files ?? [];
    return `<div class="ai-rec grid"><div class="card grid ai-rec-set">
        <div class="muted ai-ch">${tr('账户', 'Account')}</div>
        <div>${aiPicker('rec-acc', target?.name ?? tr('选择账户', 'Choose account'), target ? accountTile(target) : aiIcon('wallet'), accounts.map((a) => ({ v: a.id, name: a.name, lead: accountTile(a), on: a.id === rec.accountId })), 'rec-acc')}</div>
        <div class="muted ai-ch">${tr('银行账单', 'Statement')}</div>
        <div><label class="btn ai-file">${files.length ? tr(`已选 ${files.length} 个文件`, `${files.length} selected`) : tr('选择文件', 'Choose files')}<input type="file" id="rec-file" multiple hidden></label></div>
        ${files.length ? `<div class="muted small ai-fnames">${files.map((f) => h(f.name)).join('<br>')}</div>` : ''}
        <label class="f">${tr('银行余额（可不填）', 'Bank balance (optional)')}<input id="rec-bal" inputmode="decimal" autocomplete="off" value="${h(rec.balanceText)}"></label></div>
      ${rec.error ? `<div class="err">${h(rec.error)}</div>` : ''}${aiKey() ? '' : `<div class="err">${tr('需要先填 API 密钥。', 'Set an API key first.')}</div>`}
      <button class="btn primary ai-go" data-act="rec-start" ${target && files.length ? '' : 'disabled'}>${tr('开始对账', 'Start')}</button></div>`;
  }
  const bank = rec.parsed.map((p, i) => ({ date: p.date, cents: aiRecSigned(p, target), text: aiRecDescribe(p), key: i }));
  const res = aiReconcileRun(bank, target), L = computeLookup();
  const ledgerBalance = balanceOf(target, allTxs()), bb = aiCents(rec.balanceText), bankBalance = bb == null || Number.isNaN(bb) ? null : bb;
  const gap = bankBalance != null ? bankBalance - ledgerBalance : res.diff;
  const sameCount = res.bankOnly.filter((x) => x.same).length + res.ledgerOnly.filter((x) => x.same).length;
  const line = (row, action = '') => `<div class="ai-bl"><div class="main"><div class="muted ai-bd">${dayISO(row.date)}</div><div class="ai-bt">${h(row.text)}</div></div>
    <div class="num ${row.cents > 0 ? 'in' : 'out'}">${row.cents > 0 ? '+' : '-'}${money(Math.abs(row.cents), cur)}</div>${action}</div>`;
  const stat = (label, cents, cls = '') => `<div><div class="muted ai-fl">${label}</div><div class="num ai-rv ${cls}">${money(cents, cur)}</div></div>`;
  const parts = [`<div class="card ai-rh"><div class="ai-rh1">${accountTile(target)}<b>${h(target.name)}</b><span class="muted small">${tr(`对上 ${res.matched} 笔`, `${res.matched} matched`)}</span></div>
    <div class="ai-three">${stat(tr('账本余额', 'Ledger'), ledgerBalance)}${bankBalance != null ? stat(tr('银行余额', 'Bank'), bankBalance) : ''}<div class="right"><div class="muted ai-fl">${tr('差额', 'Difference')}</div><div class="num ai-rv ${gap === 0 ? 'in' : 'amber'}">${money(gap, cur)}</div></div></div>
    <div class="muted small ai-rh2">${res.open === 0 ? tr('流水范围内都对上了', 'Everything in the statement matches')
      : tr(`处理完下面 ${res.open} 条，余额将是 ${money(ledgerBalance + res.diff, cur)}`, `After the ${res.open} items below: ${money(ledgerBalance + res.diff, cur)}`)}</div>
    <div class="ai-rh3"><button class="btn link" data-act="rec-reset">${tr('换文件', 'Other files')}</button></div></div>`];
  if (res.misplaced.length) {
    parts.push(`<div class="card ai-rc"><b>${tr(`记错账户 ${res.misplaced.length}`, `Wrong account ${res.misplaced.length}`)}</b>${res.misplaced.map((m) => `${txRow(m.tx, L, true)}<div class="ai-ra"><button class="btn link" data-act="rec-move" data-v="${m.tx.id}">${tr(`改到 ${h(target.name)}`, `Move to ${h(target.name)}`)}</button></div>`).join('')}
      ${res.misplaced.length > 1 ? `<div class="ai-ra"><button class="btn" data-act="rec-move-all">${tr(`全部改到 ${h(target.name)}`, `Move all to ${h(target.name)}`)}</button></div>` : ''}</div>`);
  }
  const bankOpen = res.bankOnly.filter((x) => !x.same);
  if (bankOpen.length) {
    parts.push(`<div class="card ai-rc"><b>${tr(`银行有，账本没有 ${bankOpen.length}`, `In the bank, not in the ledger ${bankOpen.length}`)}</b>${bankOpen.map((x) => line(x.row, aiRecDraft(rec.parsed[x.row.key], target)
      ? `<button class="btn link ai-add" data-act="rec-add" data-v="${x.row.key}">${tr('补记', 'Add')}</button>` : `<span class="muted ai-fx2">${tr('外币', 'Foreign')}</span>`)).join('')}</div>`);
  }
  const ledgerOpen = res.ledgerOnly.filter((x) => !x.same);
  if (ledgerOpen.length) {
    parts.push(`<div class="card ai-rc"><b>${tr(`账本有，银行没有 ${ledgerOpen.length}`, `In the ledger, not in the bank ${ledgerOpen.length}`)}</b>${ledgerOpen.map((x) => `${txRow(x.tx, L, true)}<div class="ai-ra"><button class="btn link danger" data-act="rec-del" data-v="${x.tx.id}">${tr('删除', 'Delete')}</button></div>`).join('')}</div>`);
  }
  if (sameCount) {
    parts.push(`<div class="card ai-rc"><button class="ai-same muted" data-act="rec-same" aria-expanded="${!!rec.showSame}">${tr(`只是记法不同 ${sameCount}`, `Same money, recorded differently ${sameCount}`)}  ${rec.showSame ? '▴' : '▾'}</button>
      ${rec.showSame ? res.bankOnly.filter((x) => x.same).map((x) => line(x.row)).join('') + rowsOf(res.ledgerOnly.filter((x) => x.same).map((x) => x.tx), L) : ''}</div>`);
  }
  return `<div class="ai-rec grid">${parts.join('')}</div>`;
}

async function aiRecStart() {
  const rec = aiRec(), target = state.data.account.get(rec.accountId);
  if (!target || !rec.files.length || rec.busy) return;
  Object.assign(rec, { busy: true, error: '', done: 0, total: 0, found: 0 });
  render();
  try {
    const rows = await aiReadStatements(rec.files, target, (done, total, found) => { Object.assign(rec, { done, total, found }); if (state.tab === 'accounts') render(); });
    if (!rows.length) rec.error = tr('没有识别到交易。', 'No transactions found.');
    else { rec.parsed = rows; rec.showSame = false; }
  } catch (e) { rec.error = e instanceof AiError ? e.message : tr('识别失败：', 'Reading failed: ') + (e?.message ?? ''); }
  rec.busy = false;
  render();
}

// ---------------------------------------------------------------- 这些功能的点击、提交、选文件

async function aiAction(act, v) {
  const rec = aiRec();
  const pair = () => String(v).split(':').map(Number);
  switch (act) {
    case 'ai-settings': state.aiSettings = true; break;
    case 'ai-close': if (lastClickTarget?.dataset?.act !== 'ai-close') return true; state.aiSettings = false; break;
    case 'ai-close-btn': state.aiSettings = false; break;
    case 'ai-clear': store.del('hl.apiKey'); state.aiSettings = false; break;
    case 'ai-save': { const k = document.getElementById('ai-key').value.trim(); if (k) store.set('hl.apiKey', k); store.set('hl.model', document.getElementById('ai-model').value.trim()); state.aiSettings = false; break; }
    case 'ai-pick': state.aiPick = state.aiPick === v ? null : v; break;
    // 问账本
    case 'ask-hint': sendAsk(v); return true;
    case 'ask-retry': {
      const i = Number(v), m = state.chat[i];
      if (!m || state.asking) return true;
      state.chat.splice(i, 1);
      if (state.chat[i - 1]?.kind === 'q') state.chat.splice(i - 1, 1);
      sendAsk(m.question); return true;
    }
    case 'ask-toggle': { const m = state.chat[Number(v)]; if (m) m.editing = !m.editing; state.aiPick = null; break; }
    case 'ask-acc': case 'ask-to': case 'ask-cat': {
      const [i, id] = pair(), m = state.chat[i];
      if (m) m[{ 'ask-acc': 'accountId', 'ask-to': 'toAccountId', 'ask-cat': 'categoryId' }[act]] = id;
      if (m && act === 'ask-acc' && m.toAccountId === id) m.toAccountId = 0;
      state.aiPick = null; break;
    }
    case 'ask-save': {
      const m = state.chat[Number(v)], tx = m && aiDraftTx(m);
      if (!tx) return true;
      try { await saveRecord('tx', tx); m.savedId = tx.id; m.editing = false; if (typeof plShootingStar === 'function') plShootingStar(); } catch (e) { state.error = e.message; }
      break;
    }
    case 'noop': return true;
    // 净资产、修正余额
    case 'worth': state.worthAll = v === '1'; break;
    case 'asset-tab': state.assetTab = v; state.accountId = null; state.project = null; state.openKey = null; break;
    case 'fix-balance': fixBalance(Number(v)); return true;
    // 复盘
    case 'review-ai': {
      const { y, m } = state.month, key = aiMonthKey();
      if (state.reviewBusy) return true;
      state.reviewBusy = key; state.reviewFail = { ...(state.reviewFail ?? {}), [key]: '' }; render();
      try { state.reviewText[key] = await writeReview(y, m); } catch (e) { state.reviewFail[key] = e instanceof AiError ? e.message : tr('没写出来：', 'Failed: ') + (e?.message ?? ''); }
      state.reviewBusy = false; break;
    }
    // 对账
    case 'rec-acc': rec.accountId = Number(v); rec.parsed = null; rec.error = ''; state.aiPick = null; break;
    case 'rec-start': aiRecStart(); return true;
    case 'rec-reset': rec.parsed = null; rec.error = ''; break;
    case 'rec-same': rec.showSame = !rec.showSame; break;
    case 'rec-move': { const t = state.data.tx.get(Number(v)); if (t) try { await saveRecord('tx', { ...t, accountId: rec.accountId }); } catch (e) { state.error = e.message; } break; }
    case 'rec-move-all': {
      const target = state.data.account.get(rec.accountId);
      if (!target || !rec.parsed) return true;
      const bank = rec.parsed.map((p, i) => ({ date: p.date, cents: aiRecSigned(p, target), text: '', key: i }));
      try { for (const m of aiReconcileRun(bank, target).misplaced) await saveRecord('tx', { ...m.tx, accountId: target.id }); } catch (e) { state.error = e.message; }
      break;
    }
    case 'rec-add': { const target = state.data.account.get(rec.accountId), p = rec.parsed?.[Number(v)]; if (target && p) try { await aiRecImport(p, target); } catch (e) { state.error = e.message; } break; }
    case 'rec-del': {
      const t = state.data.tx.get(Number(v));
      if (!t) return true;
      if (!await uiConfirm(tr('删除这笔账单？', 'Delete this entry?'), { ok: tr('删除', 'Delete'), danger: true, detail: h(`${dayISO(t.date)}  ${money(t.amountCents)}`) })) return true;
      try { await deleteRecord('tx', t.id); } catch (e) { state.error = e.message; }
      break;
    }
    default: return false;
  }
  render();
  return true;
}

async function aiChange(ev) {
  const rec = aiRec();
  if (ev.target.id === 'rec-account') { rec.accountId = Number(ev.target.value); rec.parsed = null; rec.error = ''; render(); return true; }
  if (ev.target.id !== 'rec-file') return false;
  rec.files = [...ev.target.files]; rec.error = ''; rec.parsed = null;
  render();
  return true;
}

// 边打字边更新：对账的银行余额只记下来不重画；问账本的发送钮没字时灰掉
document.addEventListener('input', (ev) => {
  if (typeof state === 'undefined') return;
  if (ev.target.id === 'rec-bal') { aiRec().balanceText = ev.target.value; return; }
  if (ev.target.id === 'quick') { const b = ev.target.closest('.ai-ask')?.querySelector('.send'); if (b) b.disabled = !ev.target.value.trim() || state.asking; }
});
