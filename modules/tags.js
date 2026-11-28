// 标签（和手机端 Tags.kt、设置里的 TagsScreen、统计里的 TagDetail 一样）：
// 标签的缩写和颜色、"标签"页（按花费排，点标志换颜色、点一行看账单）、一个标签的详情页；
// 还有分类名的英文（Lang.kt 的 CATEGORY_EN）。样式在 css/tags.css。
'use strict';

/** 标签可选的颜色。云端 tagColors 存的是序号。 */
const TAG_COLORS = ['#6C5CE7', '#3AA0F0', '#1FB5A8', '#3DBA6F', '#8BBF3A', '#F2B01E', '#FF8A3D', '#F2545B', '#EC5F9D', '#9B6CF0', '#B07A55', '#8793A6'];

/** Java 的 String.hashCode（按 UTF-16 码元），没选过颜色的标签按它分颜色，和手机端一样。 */
const tgHash = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = (Math.imul(31, x) + s.charCodeAt(i)) | 0; return x; };

/** 标签的颜色（十六进制）：手机上选过的用选的，没选过的按名字固定分一个。 */
function tagColor(tag) {
  const chosen = (typeof state !== 'undefined' && shared.get('tagColors', {})) || {};
  let i = chosen[tag] == null ? NaN : Number(chosen[tag]);
  if (!Number.isFinite(i)) i = ((tgHash(tag) % TAG_COLORS.length) + TAG_COLORS.length) % TAG_COLORS.length;
  return TAG_COLORS[Math.min(TAG_COLORS.length - 1, Math.max(0, Math.trunc(i)))];
}

// 汉字的拼音首字母：按拼音排序，看它落在哪两个字母的"第一个字"之间。
// 每个字母的第一个字取几个只有一种读音的候选里排最前的（各浏览器的排序数据略有不同）。没有拼音排序的浏览器就用汉字本身（同手机端老系统）。
const TG_PY = (() => { try { const c = new Intl.Collator('zh-Hans-u-co-pinyin'); return c.resolvedOptions().collation === 'pinyin' ? c : null; } catch { return null; } })();
const TG_PY_LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ';
const TG_PY_BOUNDS = TG_PY ? '阿啊吖锕 八芭巴叭吧捌扒 嚓擦拆叉插 哒搭耷答 妸蛾鹅俄额婀屙 发 旮嘎噶 哈铪 讥击机几丌叽 咔喀 垃拉啦 妈嘛吗 拏拿 噢哦喔 妑啪趴 七期柒沏 呥然蚺 撒仨 他她它塌趿 穵挖哇蛙洼 夕兮西吸昔汐 丫压鸭呀押 帀匝杂咂'
  .split(' ').map((s) => [...s].sort(TG_PY.compare)[0]) : [];
const tgInitialsCache = new Map();

/**
 * 标签的缩写：前两个词的首字母加最后一串数字的末两位。"北京2026" → BJ26，"奥地利EGU2026" → AD26，"南法" → NF。
 * 汉字取拼音首字母，英文单词取首字母。
 */
function tagInitials(tag) {
  tag = String(tag ?? '');
  if (tgInitialsCache.has(tag)) return tgInitialsCache.get(tag);
  const digits = (tag.match(/\d+/g) ?? []).pop()?.slice(-2) ?? '';
  let letters = '', inWord = false;
  // 和手机端一样按 UTF-16 码元一个个看
  for (let n = 0; n < tag.length; n++) {
    const ch = tag[n];
    if (/\p{Script=Han}/u.test(ch)) {
      let i = -1;
      if (TG_PY) for (let k = 0; k < TG_PY_BOUNDS.length && TG_PY.compare(ch, TG_PY_BOUNDS[k]) >= 0; k++) i = k;
      letters += i >= 0 ? TG_PY_LETTERS[i] : ch; inWord = false;
    } else if (/\p{L}/u.test(ch)) { if (!inWord) letters += ch.toUpperCase(); inWord = true; } else inWord = false;
    if (letters.length >= 2) break;
  }
  const out = letters + digits || '#';
  tgInitialsCache.set(tag, out);
  return out;
}

/** 标签的小标志：彩色圆角方块上的缩写。字号随缩写长短变（同 TagLogo）。 */
function tagLogo(tag, px = 24) {
  const text = tagInitials(tag), f = text.length >= 4 ? 0.3 : text.length === 3 ? 0.36 : 0.42;
  return `<span class="tg-logo" style="width:${px}px;height:${px}px;border-radius:${+(px * 0.32).toFixed(1)}px;background:${tagColor(tag)};font-size:${+(px * f).toFixed(1)}px">${h(text)}</span>`;
}

// ---------------------------------------------------------------- 分类名的英文

/** 预置分类和常见分类名的英文（同 Lang.kt）。自己起的名字原样显示。 */
const CATEGORY_EN = {
  '餐饮': 'Food', '三餐': 'Meals', '买菜': 'Groceries', '水果': 'Fruit', '零食': 'Snacks', '咖啡饮料': 'Coffee & drinks',
  '外卖': 'Takeout', '早餐': 'Breakfast', '午餐': 'Lunch', '晚餐': 'Dinner', '甜品': 'Dessert', '外食': 'Eating out',
  '交通': 'Transport', '公交地铁': 'Bus & metro', '火车': 'Train', '打车': 'Taxi', '飞机': 'Flights', '加油': 'Fuel',
  '自行车': 'Bike', '汽车': 'Car', '维修保养': 'Maintenance',
  '购物': 'Shopping', '服饰': 'Clothes', '数码': 'Electronics', '日用品': 'Household', '快递': 'Shipping', '淘宝': 'Taobao',
  '居住': 'Housing', '房租': 'Rent', '水电燃气': 'Utilities', '网费': 'Internet', '家具': 'Furniture', '维修': 'Repairs',
  '电器': 'Appliances', '装修': 'Renovation',
  '通讯': 'Phone', '娱乐': 'Fun', '电影': 'Movies', '游戏': 'Games', '音乐': 'Music', '付费会员': 'Subscriptions',
  '玩具': 'Toys', '按摩': 'Massage', '运动': 'Sports',
  '旅行': 'Travel', '住宿': 'Lodging', '机票': 'Air tickets', '门票': 'Tickets', '纪念品': 'Souvenirs', '旅行装备': 'Travel gear',
  '医疗': 'Health', '看病': 'Doctor', '药品': 'Medicine', '保健': 'Wellness', '医保': 'Health insurance',
  '学习': 'Education', '书籍': 'Books', '课程': 'Courses', 'AI工具': 'AI tools',
  '社交': 'Social', '聚餐': 'Dining out', '礼物': 'Gifts', '红包': 'Red packets', '亲友': 'Friends & family', '父母': 'Parents',
  '美妆': 'Beauty', '理发': 'Haircut', '护肤': 'Skincare', '面霜': 'Face cream', '香水': 'Perfume',
  '宠物': 'Pets', '孩子': 'Kids', '保险': 'Insurance', '税费': 'Taxes', '工作': 'Work', '其他': 'Other',
  '会议': 'Conferences', '注册费': 'Registration',
  '工资': 'Salary', '奖金': 'Bonus', '外快兼职': 'Side income', '投资收益': 'Investments', '利息': 'Interest',
  '补贴': 'Subsidy', '消费返现': 'Cashback', '代付收回': 'Paid back', '代付还款': 'Repayments', '代收': 'Collected for others', '代收转回': 'Passed on', '报销': 'Reimbursement', '退款': 'Refunds', '礼金': 'Gift money', '生活费': 'Allowance',
};

/** 分类的显示名：英文界面下把预置的中文名换成英文。传分类对象（也可以直接传名字）；没有名字时返回 null。 */
function catName(cat) {
  const name = typeof cat === 'string' ? cat : cat?.name;
  if (name == null) return null;
  return LANG === 'en' && Object.hasOwn(CATEGORY_EN, name) ? CATEGORY_EN[name] : name;
}

// ---------------------------------------------------------------- "标签"页（我的 → 标签）

const tgTagsOf = (t) => (t.tags ?? '').split(' ').filter((x) => x.trim());

function tagsView() {
  const L = computeLookup();
  // 标签 → 带这个标签的账单（全部账本，新的在前），按支出总额从高到低
  const groups = new Map();
  for (const t of allTxs().sort(byNewest)) for (const tag of tgTagsOf(t)) { if (!groups.has(tag)) groups.set(tag, []); groups.get(tag).push(t); }
  const spentRaw = (l) => sum(l.filter((t) => t.kind === KIND.EXPENSE), (t) => t.amountCents);
  const list = [...groups.entries()].sort((a, b) => spentRaw(b[1]) - spentRaw(a[1]));
  const bar = `<div class="subbar"><button class="round" data-act="tab" data-v="me" aria-label="${tr('返回', 'Back')}">‹</button><b>${tr('标签', 'Tags')}</b></div>`;
  if (!list.length) return `${bar}<p class="muted tg-none">${tr('暂无带标签的账单。', 'No tagged entries yet.')}</p>`;
  const cards = list.map(([tag, l]) => {
    const open = state.tgOpen === tag, spent = sum(l.filter((t) => t.kind === KIND.EXPENSE), (t) => L.net(t));
    const from = dayISO(Math.min(...l.map((t) => t.date))), to = dayISO(Math.max(...l.map((t) => t.date)));
    return `<div class="card tg-card"><div class="row click tg-row" data-act="tg-open" data-v="${h(tag)}">
        <button class="tg-lbtn" data-act="tg-color" data-v="${h(tag)}" aria-label="${tr('更换颜色', 'Color')}">${tagLogo(tag, 38)}</button>
        <div class="main"><div class="title">${h(tag)}</div><div class="sub">${tr(`${l.length} 笔 · ${from} 至 ${to}`, `${nTx(l.length)} · ${from} to ${to}`)}</div></div>
        <div class="num out">${money(spent)}</div></div>
      ${open ? `<div class="tg-list">${l.map((t) => txRow(t, L, true)).join('')}</div>` : ''}</div>`;
  }).join('');
  return `${bar}<div class="grid tg-page">${cards}</div>${state.tgColoring != null ? tgColorDialog(state.tgColoring) : ''}`;
}

/** 换颜色：12 个颜色，两行六个。 */
function tgColorDialog(tag) {
  const cur = tagColor(tag);
  return `<div class="modal tg-modal" data-act="tg-color-x"><div class="card grid tg-dlg" role="dialog" aria-modal="true" aria-label="${h(tag)}">
    <div class="tg-dhead">${tagLogo(tag, 32)}<b>${h(tag)}</b></div>
    <div class="tg-swatches">${TAG_COLORS.map((c, i) => `<button class="tg-sw${c === cur ? ' on' : ''}" style="background:${c}" data-act="tg-pick" data-v="${i}" aria-label="${i + 1}"></button>`).join('')}</div>
    <div class="tg-dfoot"><button class="btn" data-act="tg-color-x">${tr('取消', 'Cancel')}</button></div></div></div>`;
}

// ---------------------------------------------------------------- 一个标签的详情（统计 → 标签 → 点一个标签）

/** 打开一个标签的详情页；返回时回到现在这一页。看的时间段、支出 / 收入跟统计页一样。 */
function openTagDetail(tag) {
  if (state.tab !== 'tagdetail') state.tagBack = state.tab;
  state.tagDetail = String(tag);
  state.tgCat = null; state.tgClaims = false;
  state.tab = 'tagdetail'; state.q = ''; state.searching = false;
  scrollTo(0, 0);
  render();
}

function tagDetailView() {
  const tag = state.tagDetail ?? '', L = computeLookup(), income = !!state.statsIncome, kind = income ? KIND.INCOME : KIND.EXPENSE;
  const back = state.tagBack && state.tagBack !== 'tagdetail' ? state.tagBack : 'stats';
  const bar = `<div class="subbar"><button class="round" data-act="tab" data-v="${h(back)}" aria-label="${tr('返回', 'Back')}">‹</button><b>${h(tag)}</b></div>`;
  // every：这段时间带这个标签的全部账单（报销的也在里面）；own：其中参与统计的
  const every = rangeTxs().filter((t) => tgTagsOf(t).includes(tag));
  const own = every.filter((t) => t.kind === kind && L.counts(t));
  const total = sum(own, (t) => L.net(t));
  const cats = new Map();
  for (const t of own) { const top = L.top(t.categoryId), k = top?.id ?? -1; if (!cats.has(k)) cats.set(k, { top, key: k, cents: 0, items: [] }); const g = cats.get(k); g.cents += L.net(t); g.items.push(t); }
  const byCat = [...cats.values()].sort((a, b) => b.cents - a.cents);
  const claims = every.filter((t) => t.kind === KIND.EXPENSE && t.reimburse && t.reimburse !== 0);
  const pending = sum(claims.filter((t) => t.reimburse === 1), (t) => t.amountCents);
  const claimed = sum(claims, (t) => t.amountCents), done = claimed - pending;
  const paidBack = every.filter((t) => t.kind === KIND.INCOME && L.isReimburse(t));
  const list = (l) => `<div class="tg-list">${[...l].sort(byNewest).map((t) => txRow(t, L, true)).join('')}</div>`;

  const fig = (cents, label, cls) => `<div><div class="num ${cls}">${money(cents)}</div><div class="muted tg-flbl">${label}</div></div>`;
  const head = `<div class="card tg-head"><div class="tg-hrow">${tagLogo(tag, 44)}<div><div class="muted tg-hlbl">${income ? tr('收入', 'Income') : tr('自付支出', 'Own spending')}</div><div class="num tg-total">${money(total)}</div></div></div>
    ${every.length ? `<div class="muted tg-range">${dayISO(Math.min(...every.map((t) => t.date)))} – ${dayISO(Math.max(...every.map((t) => t.date)))} · ${every.length}</div>` : ''}
    ${claims.length || paidBack.length ? `<div class="tg-figs">${fig(claimed, tr('报销支出', 'Claimable'), '')}${fig(done, tr('已报销', 'Reimbursed'), 'in')}${fig(pending, tr('待报销', 'To claim'), 'amber')}${fig(sum(paidBack, (t) => t.amountCents), tr('报销收入', 'Paid back'), 'in')}</div>` : ''}</div>`;
  const donut = total > 0 ? `<div class="card st-dcard">${donutChart(byCat.map((g) => ({ label: (catName(g.top) ?? '?').slice(0, 2), name: catName(g.top) ?? tr('未分类', 'Uncategorized'), color: (ICONS[g.top?.icon] ?? ICONS.tag).c, cents: g.cents, act: 'tg-cat-pick', v: g.key })), tr('合计', 'Total'), total)}</div>` : '';
  const rows = byCat.length ? `<div class="card tg-cats">${byCat.map((g) => {
    const open = state.tgCat === g.key, pct = total > 0 ? Math.round(g.cents * 100 / total) : 0;
    return `<div class="row click tg-crow" data-act="tg-cat" data-v="${g.key}">${iconTile(g.top?.icon ?? 'tag')}
      <div class="main"><div class="title">${h(catName(g.top) ?? tr('未分类', 'Uncategorized'))} <span class="tri">${open ? '▴' : '▾'}</span></div><div class="sub">${pct}% · ${tr(`${g.items.length} 笔`, String(g.items.length))}</div></div>
      <div class="num">${money(g.cents)}</div></div>${open ? list(g.items) : ''}`;
  }).join('')}</div>` : '';
  const claimCard = claims.length || paidBack.length ? `<div class="card tg-cats"><div class="row click tg-chead" data-act="tg-claims"><div class="main title">${tr(`报销账单 · ${claims.length + paidBack.length} 笔`, `Claims · ${claims.length + paidBack.length}`)} <span class="tri">${state.tgClaims ? '▴' : '▾'}</span></div></div>
    ${state.tgClaims ? `<div class="tg-list">${[...claims, ...paidBack].sort((a, b) => b.date - a.date || b.id - a.id).map((t) => txRow(t, L, true)).join('')}</div>` : ''}</div>` : '';
  return `${bar}<div class="grid tg-detail">${head}${donut}${rows}${claimCard}</div>`;
}

MOD.pages.tags = () => tagsView();
MOD.pages.tagdetail = () => tagDetailView();

MOD.actions.push(async (act, v) => {
  switch (act) {
    // "我的"上的"标签"格子：打开标签页（和手机端一样）
    case 'hm-go': if (v !== 'tags') return false; state.tab = 'tags'; state.tgOpen = null; state.tgColoring = null; state.q = ''; state.searching = false; scrollTo(0, 0); break;
    case 'tg-open': state.tgOpen = state.tgOpen === v ? null : v; break;
    case 'tg-color': state.tgColoring = v; break;
    case 'tg-color-x': if (lastClickTarget?.closest?.('.tg-dlg') && !lastClickTarget.closest('button')) return true; state.tgColoring = null; break;
    case 'tg-pick': {
      const tag = state.tgColoring;
      state.tgColoring = null;
      if (tag != null) {
        const next = { ...(shared.get('tagColors', {}) ?? {}), [tag]: Number(v) };
        render();
        await shared.set('tagColors', next);
      }
      break;
    }
    case 'tg-detail': openTagDetail(v); return true;
    case 'tg-cat': { const k = Number(v); state.tgCat = state.tgCat === k ? null : k; break; }
    case 'tg-cat-pick': state.tgCat = Number(v); break;
    case 'tg-claims': state.tgClaims = !state.tgClaims; break;
    default: return false;
  }
  render();
  return true;
});
