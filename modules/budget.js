// 预算：和手机端 BudgetScreen 一样——月度总预算的大圆环、每天可用、累计花费走势和月底预测、分类预算。
// 数据是和手机共享的设置：budget = 每月总预算（分，主货币，0 = 不设）；catBudgets = { "一级分类 id": 分 }。
// 统计口径和首页一致：总数用 L.totals(...).expense（扣掉退款），分类和走势只看计入收支的支出（L.counts）。
'use strict';

const BUD = {
  /** 正在改的预算：'total' 是总预算，数字是一级分类 id；null 表示没在改。 */
  edit: null, err: '', grownKey: '',

  total: () => Number(shared.get('budget', 0)) || 0,
  cats() { const o = shared.get('catBudgets', {}); return o && typeof o === 'object' ? o : {}; },
  catOf(id) { return Number(BUD.cats()[String(id)] ?? 0) || 0; },

  /** 这个月（state.month、当前账本）的数：已花、各一级分类花了多少、每天花了多少。 */
  numbers() {
    const L = computeLookup(), txs = monthTxs(), { y, m } = state.month;
    const spent = L.totals(txs).expense;
    const expenses = txs.filter((t) => t.kind === KIND.EXPENSE && L.counts(t));
    const byTop = new Map();
    for (const t of expenses) { const top = L.top(t.categoryId), k = top?.id ?? -1; if (!byTop.has(k)) byTop.set(k, { top, cents: 0 }); byTop.get(k).cents += L.net(t); }
    const days = new Date(y, m, 0).getDate(), daily = new Array(days).fill(0);
    for (const t of expenses) daily[dayToDate(t.date).getUTCDate() - 1] += Math.max(0, L.net(t));
    const now = new Date(), current = now.getFullYear() === y && now.getMonth() + 1 === m;
    return { L, spent, byTop, daily, days, current, todayDay: now.getDate() };
  },
};

const budCentsInput = (c) => (c > 0 ? (c / 100).toFixed(2) : '');

/** 大圆环：fraction 是用掉的比例，中间放内容。 */
function budgetRing(fraction, color, inner) {
  const size = 190, w = 16, r = (size - w) / 2, len = 2 * Math.PI * r, f = Math.min(1, Math.max(0, fraction));
  return `<div class="bud-ring"><svg viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-opacity=".14" stroke-width="${w}"/>
    ${f > 0 ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-dasharray="${(len * f).toFixed(2)} ${len.toFixed(2)}"/>` : ''}</svg>
    <div class="in-ring">${inner}</div></div>`;
}

/** 累计花费曲线 + 预算线 + 均匀花完的虚线；当月再加一条到月底的预测虚线。 */
function budgetPace(n, total) {
  const { daily, days, current } = n, upTo = current ? n.todayDay : days;
  const cum = []; let acc = 0;
  for (const c of daily) { acc += c; cum.push(acc); }
  const forecast = current && upTo > 0 ? Math.floor(cum[upTo - 1] * days / upTo) : cum[days - 1];
  const top = Math.max(total, forecast, cum[days - 1], 1);
  const W = 600, H = 150, step = W / Math.max(1, days - 1), y = (c) => +(H - 4 - (H - 8) * c / top).toFixed(1);
  const pts = cum.slice(0, Math.max(1, upTo)).map((c, i) => `${(i * step).toFixed(1)},${y(c)}`);
  const lastX = ((Math.max(1, upTo) - 1) * step).toFixed(1);
  // 换了月份才放一次"长出来"的动画，别的操作重画时不再闪
  const key = `${state.ledgerId}-${state.month.y}-${state.month.m}`, grow = BUD.grownKey !== key;
  BUD.grownKey = key;
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="bud-chart ${grow ? 'grow' : ''}" role="img" aria-label="累计花费">
    <defs><linearGradient id="bud-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--primary)" stop-opacity=".28"/><stop offset="1" stop-color="var(--primary)" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" y1="${y(total)}" x2="${W}" y2="${y(total)}" stroke="var(--muted)" stroke-opacity=".35" stroke-width="1"/>
    <line x1="0" y1="${y(0)}" x2="${W}" y2="${y(total)}" stroke="var(--muted)" stroke-opacity=".55" stroke-width="1.5" stroke-dasharray="8 8"/>
    ${current && upTo >= 1 && upTo < days ? `<line x1="${lastX}" y1="${y(cum[upTo - 1])}" x2="${W}" y2="${y(forecast)}" stroke="var(--expense)" stroke-opacity=".6" stroke-width="2" stroke-dasharray="6 6"/>` : ''}
    <path class="area" d="M${pts.join(' L')} L${lastX},${H} L0,${H} Z" fill="url(#bud-fill)"/>
    <path class="line" d="M${pts.join(' L')}" pathLength="1" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${upTo > 0 ? `<circle class="dot" cx="${lastX}" cy="${y(cum[upTo - 1])}" r="4.5" fill="var(--primary)"/>` : ''}</svg>`;
  const diff = forecast - total;
  return `<div class="card"><b class="muted small">本月花费走势</b>${svg}
    <div class="between small muted"><span>1</span><span>虚线：匀速花完</span><span>${days}</span></div>
    ${current ? `<div class="${diff > 0 ? 'out' : 'in'}" style="font-weight:600;margin-top:6px">预计月底花 ${money(forecast)}，${diff > 0 ? '超 ' + money(diff) : '剩 ' + money(-diff)}</div>` : ''}</div>`;
}

function budgetView() {
  const n = BUD.numbers(), total = BUD.total(), cb = BUD.cats(), { spent } = n;
  // 左边：大圆环
  let head;
  if (total <= 0) {
    head = `<div class="card grid">${monthBar()}<div><b>还没设月度预算</b><div class="muted">本月已支出 ${money(spent)}</div></div>
      <div><button class="btn primary" data-act="bud-edit" data-v="total">设置预算</button></div></div>`;
  } else {
    const left = total - spent, ratio = spent / total;
    const color = left < 0 ? 'var(--expense)' : ratio > 0.8 ? 'var(--amber)' : 'var(--primary)';
    const daysLeft = n.current ? n.days - n.todayDay + 1 : 0;
    head = `<div class="card grid">${monthBar()}
      ${budgetRing(ratio, color, `<div class="muted small">${left >= 0 ? '还剩' : '超支'}</div><div class="num bud-left ${left < 0 ? 'out' : ''}">${money(Math.abs(left))}</div><div class="small" style="color:${color}">已用 ${Math.round(ratio * 100)}%</div>`)}
      <div class="bud-stats"><div><div class="muted small">预算</div><div class="num">${money(total)}</div></div>
        <div><div class="muted small">已花</div><div class="num out">${money(spent)}</div></div>
        <div><div class="muted small">每天可用</div><div class="num">${daysLeft > 0 && left > 0 ? money(Math.floor(left / daysLeft)) : '—'}</div></div></div>
      <div><button class="btn" data-act="bud-edit" data-v="total">改预算</button></div></div>`;
  }
  // 右边：走势，分类预算
  const tops = [...state.data.category.values()].filter((c) => !c.parentId && !c.isIncome).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const spentOf = (id) => n.byTop.get(id)?.cents ?? 0;
  const has = (id) => (Number(cb[String(id)]) || 0) > 0;
  const budgeted = tops.filter((c) => has(c.id)).sort((a, b) => spentOf(b.id) / cb[String(b.id)] - spentOf(a.id) / cb[String(a.id)]);
  const others = [...n.byTop.values()].filter((g) => !g.top || !has(g.top.id)).sort((a, b) => b.cents - a.cents);
  const free = tops.filter((c) => !has(c.id));
  const budgetedRows = budgeted.map((c) => {
    const b = Number(cb[String(c.id)]), used = spentOf(c.id), ratio = used / b;
    const color = ratio > 1 ? 'var(--expense)' : ratio > 0.8 ? 'var(--amber)' : (ICONS[c.icon] ?? ICONS.tag).c;
    return `<div class="row click" data-act="bud-edit" data-v="${c.id}">${iconTile(c.icon ?? 'tag')}
      <div class="main"><div class="between"><span class="title">${h(c.name)}</span><span class="num muted small" style="font-weight:500">${money(used)} / ${money(b)}</span></div>
        <div class="bar bud-bar" style="background:color-mix(in srgb, ${color} 15%, transparent)"><i style="width:${Math.min(100, ratio * 100).toFixed(1)}%;background:linear-gradient(90deg, color-mix(in srgb, ${color} 65%, transparent), ${color})"></i></div>
        <div class="small ${used > b ? 'out' : ratio > 0.8 ? 'amber' : 'muted'}" style="${used > b ? 'font-weight:600' : ''}">${used <= b ? '还剩 ' + money(b - used) : '超支 ' + money(used - b)}</div></div></div>`;
  }).join('');
  const otherRows = others.map((g) => `<div class="row ${g.top ? 'click' : ''}" ${g.top ? `data-act="bud-edit" data-v="${g.top.id}"` : ''}>${iconTile(g.top?.icon ?? 'tag')}
      <div class="main"><div class="between"><span class="title">${h(g.top?.name ?? '未分类')}</span><span class="num">${money(g.cents)}</span></div>
        <div class="bar thin"><i style="width:${Math.min(100, g.cents * 100 / Math.max(1, spent)).toFixed(1)}%;background:${(ICONS[g.top?.icon] ?? ICONS.tag).c}"></i></div></div></div>`).join('');
  const picker = free.length ? `<select class="mini" data-change="bud-pick" aria-label="设分类预算"><option value="">＋ 分类预算</option>${free.map((c) => `<option value="${c.id}">${h(c.name)}</option>`).join('')}</select>` : '';
  const catCard = `<div class="card"><div class="between"><b class="muted small">分类预算</b>${picker}</div>
    ${!budgetedRows && !otherRows ? '<p class="muted" style="margin:8px 0 0">暂无支出</p>' : ''}${budgetedRows}
    ${budgetedRows && otherRows ? '<div class="muted small" style="margin-top:8px">没设预算的</div>' : ''}${otherRows}</div>`;
  return `<div class="cols"><div class="grid sticky">${head}</div><div class="grid">${total > 0 ? budgetPace(n, total) : ''}${catCard}</div></div>${budgetDialog()}`;
}

/** 改预算的小窗：总预算或某个分类的。留空 = 不设。 */
function budgetDialog() {
  if (BUD.edit == null) return '';
  const isTotal = BUD.edit === 'total', cat = isTotal ? null : state.data.category.get(BUD.edit);
  const cur = isTotal ? BUD.total() : BUD.catOf(BUD.edit);
  return `<div class="modal bl-modal"><div class="bl-back" data-act="bud-cancel"></div><div class="card grid" role="dialog" aria-label="预算">
    <div class="row" style="padding:0">${isTotal ? iconTile('target') : iconTile(cat?.icon ?? 'tag')}<b style="font-size:18px">${isTotal ? '每月预算' : h(cat?.name ?? '') + ' 每月预算'}</b></div>
    <label class="f">金额（${HOME}）<input id="bud-input" inputmode="decimal" value="${budCentsInput(cur)}" placeholder="留空 = 不设" style="font-size:22px;font-weight:700" autocomplete="off"></label>
    ${BUD.err ? `<p class="err" style="margin:0">${h(BUD.err)}</p>` : ''}
    <div class="between">${cur > 0 ? '<button class="btn link danger" data-act="bud-clear">清除</button>' : '<span></span>'}
      <div style="display:flex;gap:8px"><button class="btn" data-act="bud-cancel">取消</button><button class="btn primary" data-act="bud-save">保存</button></div></div>
  </div></div>`;
}

async function budgetSave(cents) {
  try {
    if (BUD.edit === 'total') await shared.set('budget', cents);
    else {
      const next = { ...BUD.cats() }, k = String(BUD.edit);
      if (cents > 0) next[k] = cents; else delete next[k];
      await shared.set('catBudgets', next);
    }
    BUD.edit = null; BUD.err = '';
  } catch (e) { BUD.err = e.message; }
}

/** 明细页月度卡片下面的预算小卡（设了预算才有），点一下进预算页。 */
function budgetHomeCard() {
  const total = BUD.total();
  if (total <= 0) return '';
  const L = computeLookup(), txs = monthTxs(), spent = L.totals(txs).expense, cb = BUD.cats();
  const left = total - spent, ratio = Math.min(1, Math.max(0, spent / total)), over = left < 0;
  const { y, m } = state.month, now = new Date(), current = now.getFullYear() === y && now.getMonth() + 1 === m;
  const daysLeft = current ? new Date(y, m, 0).getDate() - now.getDate() + 1 : 0;
  const bar = over ? 'var(--expense)' : ratio > 0.8 ? 'var(--amber)' : 'var(--primary)';
  // 超了预算的分类
  const byTop = new Map();
  for (const t of txs) if (t.kind === KIND.EXPENSE && L.counts(t)) { const k = L.top(t.categoryId)?.id ?? -1; byTop.set(k, (byTop.get(k) ?? 0) + L.net(t)); }
  const overCats = [...byTop.entries()].filter(([id, c]) => { const b = Number(cb[String(id)]) || 0; return b > 0 && b < c; }).map(([id]) => state.data.category.get(id)?.name).filter(Boolean);
  return `<div class="card click bud-home" data-act="tab" data-v="budget">
    <div class="between"><span class="muted small">${current ? '本月预算' : m + '月预算'}</span><span class="num ${over ? 'out' : ''}" style="font-size:18px">${over ? '超支 ' + money(-left) : '还剩 ' + money(left)}</span></div>
    <div class="bar" style="margin:8px 0 6px;background:color-mix(in srgb, ${bar} 15%, transparent)"><i style="width:${(ratio * 100).toFixed(1)}%;background:linear-gradient(90deg, color-mix(in srgb, ${bar} 70%, transparent), ${bar})"></i></div>
    <div class="between small muted"><span>已花 ${money(spent)} / ${money(total)}</span>${daysLeft > 0 && !over ? `<span>每天 ${money(Math.floor(left / daysLeft))}</span>` : ''}</div>
    ${overCats.length ? `<div class="small out" style="font-weight:600;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">超支：${h(overCats.join('、'))}</div>` : ''}</div>`;
}

MOD.pages.budget = () => budgetView();
MOD.me.push({ key: 'budget', name: '预算', icon: 'target', order: 10 });
MOD.homeCards.push(() => budgetHomeCard());

MOD.actions.push(async (act, v, el) => {
  if (!act.startsWith('bud-')) return false;
  switch (act) {
    case 'bud-edit': BUD.edit = v === 'total' ? 'total' : Number(v); BUD.err = ''; setTimeout(() => document.getElementById('bud-input')?.focus()); break;
        case 'bud-cancel': BUD.edit = null; BUD.err = ''; break;
    case 'bud-clear': await budgetSave(0); break;
    case 'bud-save': {
      const text = document.getElementById('bud-input')?.value.trim() ?? '';
      const cents = text ? parseCents(text) : 0;
      if (cents == null) { BUD.err = '金额不对'; break; }
      await budgetSave(cents);
      break;
    }
    default: return true;
  }
  render();
  return true;
});

MOD.changes.push(async (ev) => {
  if (ev.target.dataset?.change !== 'bud-pick' || !ev.target.value) return false;
  BUD.edit = Number(ev.target.value); BUD.err = '';
  render(); setTimeout(() => document.getElementById('bud-input')?.focus());
  return true;
});

// 回车 = 保存
document.addEventListener('keydown', (ev) => {
  if (ev.target.id === 'bud-input' && ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); document.querySelector('[data-act="bud-save"]')?.click(); }
});
// 离开预算页就把没保存的小窗关掉
document.addEventListener('click', (ev) => { if (ev.target.closest?.('[data-act="tab"]')) { BUD.edit = null; BUD.err = ''; } }, true);
