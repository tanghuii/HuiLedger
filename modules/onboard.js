// 使用向导：六步（欢迎 + 用户名、是不是 iPhone（是的话装快捷指令）、主货币、账户、个性化、完成）。
// 新账号第一次读完数据、还没有账单、这台设备没走过向导（hl.onboarded）时自动打开；已经有账单的账号直接记成走过了。
// 设置 → 使用向导 可以随时再打开。走完或点"跳过"都记成走过了。
// 画在 #app 外面的一层（不受 render() 影响，输入框里打的字不会被冲掉）；背后的页面照常重画，换外观、颜色马上看得到。
// 样式在 css/onboard.css。
'use strict';

/** 进度条上的六颗星（当前那步的大一点、在转）。 */
const OB_DOTS = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn'];
/** 写账户的那一步（点"下一步"时把选的账户存进去）。 */
const OB_ACC_STEP = 3;
/** 主货币：最常用的八种排前面，其余按原来的顺序。 */
const OB_COMMON = ['EUR', 'CNY', 'USD', 'GBP', 'HKD', 'JPY', 'CHF', 'CAD'];
/** 默认账户的 id（shared.js 的 DEFAULT_ACCOUNTS）：没有账单时在向导里可以取消掉。 */
const OB_DEFAULT_IDS = [1, 2, 3];
/**
 * 品牌方块：[logo 名, 中文名, 英文名]。名字要能被 brandOf() 认出 logo（中英文都是），
 * 英文里没有对应关键字的几家（中信、桂林、中泰）英文名带上中文。分三组：中国 / 欧洲 / 投资（投资那组默认类型是"投资"）。
 * 现金不是品牌，排在第一个。
 */
const OB_GROUPS = [
  ['cn', () => tr('中国', 'China'), [['cash', '现金', 'Cash'], ['alipay', '支付宝', 'Alipay'], ['wechat', '微信', 'WeChat Pay'], ['icbc', '工商银行', 'ICBC'], ['boc', '中国银行', 'BOC'],
    ['abc', '农业银行', 'ABC'], ['cmbc', '民生银行', 'CMBC'], ['citic', '中信银行', 'CITIC 中信'], ['pingan', '平安银行', 'PingAn Bank'], ['guilin', '桂林银行', 'Guilin Bank 桂林银行'], ["ccb", "建设银行", "CCB"], ["bocom", "交通银行", "BOCOM"], ["psbc", "邮储银行", "PSBC"], ["cmb", "招商银行", "CMB"], ["spdb", "浦发银行", "SPDB"], ["cib", "兴业银行", "CIB"], ["ceb", "光大银行", "CEB"], ["hxb", "华夏银行", "Hua Xia Bank"], ["cgb", "广发银行", "CGB"], ["czb", "浙商银行", "CZB"], ["bob", "北京银行", "Bank of Beijing"], ["bosc", "上海银行", "Bank of Shanghai"], ["jsb", "江苏银行", "Bank of Jiangsu"], ["nbcb", "宁波银行", "Bank of Ningbo"], ["njcb", "南京银行", "Bank of Nanjing"], ["hzb", "杭州银行", "Bank of Hangzhou"], ["webank", "微众银行", "WeBank"], ["mybank", "网商银行", "MYbank"], ["unionpay", "云闪付", "UnionPay"], ["jdpay", "京东金融", "JD Finance"]]],
  ['eu', () => tr('欧洲', 'Europe'), [['ing', 'ING', 'ING'], ['abn', 'ABN AMRO', 'ABN AMRO'], ['rabobank', 'Rabobank', 'Rabobank'], ['asn', 'ASN Bank', 'ASN Bank'], ['bunq', 'bunq', 'bunq'],
    ['revolut', 'Revolut', 'Revolut'], ['n26', 'N26', 'N26'], ['wise', 'Wise', 'Wise'], ['paypal', 'PayPal', 'PayPal'], ['lemfi', 'LemFi', 'LemFi'], ["sns", "SNS", "SNS"], ["regiobank", "RegioBank", "RegioBank"], ["triodos", "Triodos", "Triodos"], ["knab", "Knab", "Knab"], ["deutschebank", "Deutsche Bank", "Deutsche Bank"], ["commerzbank", "Commerzbank", "Commerzbank"], ["sparkasse", "Sparkasse", "Sparkasse"], ["volksbank", "Volksbank", "Volksbank"], ["dkb", "DKB", "DKB"], ["comdirect", "comdirect", "comdirect"], ["postbank", "Postbank", "Postbank"], ["bnp", "BNP Paribas", "BNP Paribas"], ["creditagricole", "Crédit Agricole", "Crédit Agricole"], ["socgen", "Société Générale", "Société Générale"], ["labanquepostale", "La Banque Postale", "La Banque Postale"], ["boursobank", "BoursoBank", "BoursoBank"], ["santander", "Santander", "Santander"], ["bbva", "BBVA", "BBVA"], ["caixabank", "CaixaBank", "CaixaBank"], ["intesa", "Intesa Sanpaolo", "Intesa Sanpaolo"], ["unicredit", "UniCredit", "UniCredit"], ["hsbc", "汇丰 HSBC", "HSBC"], ["barclays", "Barclays", "Barclays"], ["lloyds", "Lloyds", "Lloyds"], ["natwest", "NatWest", "NatWest"], ["monzo", "Monzo", "Monzo"], ["kbc", "KBC", "KBC"], ["belfius", "Belfius", "Belfius"], ["nordea", "Nordea", "Nordea"], ["ubs", "UBS", "UBS"], ["klarna", "Klarna", "Klarna"]]],
  ['inv', () => tr('投资', 'Investing'), [['trading212', 'Trading 212', 'Trading 212'], ['traderepublic', 'Trade Republic', 'Trade Republic'], ['scalable', 'Scalable Capital', 'Scalable Capital'],
    ['bitvavo', 'Bitvavo', 'Bitvavo'], ['coinbase', 'Coinbase', 'Coinbase'], ['kraken', 'Kraken', 'Kraken'], ['finst', 'Finst', 'Finst'], ['robinhood', 'Robinhood', 'Robinhood'], ['zhongtai', '中泰证券', 'Zhongtai 中泰'], ["degiro", "DEGIRO", "DEGIRO"], ["binance", "币安 Binance", "Binance"], ["ibkr", "盈透 IBKR", "Interactive Brokers"]]],
];
/** 账户类型的小标签（类型号和 manage.js 的 mgTypes 一样：0 储蓄、1 投资、2 信用、3 现金）。 */
const obTypes = () => [[0, tr('储蓄', 'Savings')], [2, tr('信用卡', 'Credit card')], [1, tr('投资', 'Investing')], [3, tr('现金', 'Cash')]];

const ob = { el: null, open: false, shown: false, step: 0, picks: [], drop: new Set(), created: new Set(), adding: false, busy: false, err: '', note: '', seq: 0, dir: 1, nick: '', ios: null };

const obDone = () => { try { return JSON.parse(localStorage.getItem('hl.onboarded')) === true; } catch { return false; } };
const obMark = () => { try { localStorage.setItem('hl.onboarded', 'true'); } catch { /* 存不了就算了 */ } };

/** 方块对应的已有账户（没归档的）：现金看类型，品牌看 logo。 */
function obExisting(key) {
  const list = [...state.data.account.values()].filter((a) => !a.archived).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  return key === 'cash' ? list.find((a) => a.type === 3) : list.find((a) => brandOf(a)?.logo === 'logo_' + key);
}
/** 这个账户有没有账单（转出、转入都算）。 */
const obUsed = (id) => [...state.data.tx.values()].some((t) => t.accountId === id || t.toAccountId === id);
const obBrand = (key) => OB_GROUPS.flatMap((g) => g[2]).find((b) => b[0] === key);

// ---------------------------------------------------------------- 打开、关上

function obOpen() {
  if (!state.session) return;
  Object.assign(ob, { open: true, step: 0, picks: [], adding: false, busy: false, err: '', note: '', dir: 1, nick: String(shared.get('nickname', '') || '').trim(), ios: IS_IOS ? true : null });
  ob.drop.clear(); ob.created.clear();
  if (!ob.el) {
    ob.el = document.createElement('div');
    ob.el.className = 'ob';
    ob.el.setAttribute('role', 'dialog');
    ob.el.setAttribute('aria-modal', 'true');
    ob.el.addEventListener('click', obClick);
    ob.el.addEventListener('input', obInput);
    ob.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      if (e.target.id === 'ob-name') { e.preventDefault(); obAddCustom(); }
      if (e.target.id === 'ob-nick') { e.preventDefault(); ob.el.querySelector('[data-ob="next"]')?.click(); }
    });
  }
  document.body.appendChild(ob.el);
  document.documentElement.classList.add('ob-lock');
  obRender();
}

/** 关上（走完或跳过都算走过了），回到明细页。 */
function obClose(mark = true) {
  if (mark) obMark();
  ob.open = false;
  ob.el?.remove();
  document.documentElement.classList.remove('ob-lock');
  if (state.session) { state.tab = 'ledger'; state.calendarMode = false; scrollTo(0, 0); }
  render();
}

// ---------------------------------------------------------------- 画

function obRender() {
  if (!ob.open || !ob.el) return;
  if (!state.session) { obClose(false); return; }
  const prev = ob.el.querySelector('.ob-body'), keep = prev && prev.dataset.step === String(ob.step) ? prev.scrollTop : 0;
  const s = ob.step, last = s === OB_DOTS.length - 1;
  const steps = [obWelcome, obIphone, obCurrency, obAccounts, obStyle, obFinish];
  const dots = OB_DOTS.map((k, i) => `<span class="ob-dot${i === s ? ' on' : ''}${i < s ? ' done' : ''}">${planetSvg(k, { px: i === s ? 26 : 14, spin: i === s, face: i === s })}</span>`).join('');
  ob.el.setAttribute('aria-label', tr('使用向导', 'Setup guide'));
  ob.el.innerHTML = `<div class="ob-head">
      <button class="ob-back" data-ob="back" aria-label="${tr('返回', 'Back')}"${s ? '' : ' hidden'}>${hmSvg(ICONS.back.d)}</button>
      <div class="ob-dots" role="progressbar" aria-valuemin="1" aria-valuemax="${OB_DOTS.length}" aria-valuenow="${s + 1}">${dots}</div>
      <button class="ob-skip" data-ob="skip">${tr('跳过', 'Skip')}</button></div>
    <div class="ob-body" data-step="${s}"><div class="ob-step${prev && prev.dataset.step !== String(s) ? (ob.dir > 0 ? ' in-r' : ' in-l') : ''}">${steps[s]()}</div></div>
    <div class="ob-foot">${ob.err ? `<p class="err ob-err">${h(ob.err)}</p>` : ''}
      <button class="btn primary ob-next" data-ob="next" ${ob.busy ? 'disabled' : ''}>${ob.busy ? tr('请稍候…', 'Please wait…') : last ? tr('开始记账', 'Start') : tr('下一步', 'Next')}</button></div>`;
  const body = ob.el.querySelector('.ob-body');
  if (keep) body.scrollTop = keep;
}

function obWelcome() {
  return `<div class="ob-center">
    <div class="ob-hero">${typeof plLoginHero === 'function' ? plLoginHero() : planetSvg(PLANET_BRAND, { px: 120 })}</div>
    <h1 class="ob-title">${tr('欢迎来到行星记账', 'Welcome to Planet Ledger')}</h1>
    <p class="muted ob-lead">${tr('花一分钟，把账本设成你的样子', 'Take a minute to make it yours')}</p>
    <label class="ob-nick"><span>${tr('用户名', 'Username')}</span><input id="ob-nick" value="${h(ob.nick)}" placeholder="${tr('如何称呼您？（设置昵称）', 'What should we call you?')}" maxlength="20" autocomplete="nickname" enterkeyhint="next"></label></div>`;
}

/** 是不是 iPhone：是的话就地装快捷指令（以后账单在分享菜单里一键导入）。 */
function obIphone() {
  const has = typeof scSteps === 'function' && typeof IMP_SHORTCUT_URL !== 'undefined' && IMP_SHORTCUT_URL;
  const pick = (v, label) => `<button class="ob-yn${ob.ios === v ? ' on' : ''}" data-ob="ios" data-v="${v ? 1 : 0}" aria-pressed="${ob.ios === v}">${label}</button>`;
  const body = ob.ios === true && has ? `<div class="card ob-card ob-sc"><b>${tr('装上快捷指令，账单一键导入', 'Add the Shortcut for one-tap imports')}</b>${scSteps()}${scButton()}</div>`
    : ob.ios === false ? `<p class="muted ob-lead">${tr('以后用 iPhone 时：设置 › iPhone 快捷导入', 'Using an iPhone later? Settings › iPhone quick import')}</p>` : '';
  return `<h2 class="ob-h">${tr('您使用的是 iOS 设备吗？', 'Are you on an iPhone?')}</h2>
    <div class="ob-yns">${pick(true, tr('是，iOS', 'Yes, iPhone'))}${pick(false, tr('不是', 'No'))}</div>${body}`;
}

function obCurrency() {
  const btn = (c) => `<button class="${c === HOME ? 'on' : ''}" data-ob="cur" data-v="${c}" aria-pressed="${c === HOME}" ${ob.busy ? 'disabled' : ''}><span class="ob-flag">${hmFlag(c)}</span><b>${c}</b></button>`;
  return `<h2 class="ob-h">${tr('主货币', 'Main currency')}</h2>
    <div class="ob-cur">${OB_COMMON.filter((c) => FX_CODES.includes(c)).map(btn).join('')}</div>
    <div class="ob-cur ob-cur2">${FX_CODES.filter((c) => !OB_COMMON.includes(c)).map(btn).join('')}</div>`;
}

function obAccounts() {
  const tile = ([key, zh, en]) => {
    const ex = obExisting(key), picked = ob.picks.some((p) => p.k === key), on = ex ? !ob.drop.has(ex.id) : picked;
    const name = ex && !ob.drop.has(ex.id) ? ex.name : tr(zh, en);
    const logo = key === 'cash' ? iconTile('coins') : accountTile({ name: tr(zh, en), type: 0 });
    return `<button class="ob-tile${on ? ' on' : ''}" data-ob="tile" data-v="${key}" aria-pressed="${on}">${logo}<span>${h(name)}</span></button>`;
  };
  const groups = OB_GROUPS.map(([k, name, list]) => `<div class="ob-gh">${name()}</div><div class="ob-tiles">${list.map(tile).join('')}${k === 'inv' ? `<button class="ob-tile ob-other" data-ob="other" aria-expanded="${ob.adding}"><span class="tile ob-plus">＋</span><span>${tr('其他', 'Other')}</span></button>` : ''}</div>`).join('');
  const add = ob.adding ? `<div class="ob-add"><input id="ob-name" placeholder="${tr('账户名称', 'Account name')}" autocomplete="off" enterkeyhint="done" maxlength="40"><button class="btn primary" data-ob="add">${tr('添加', 'Add')}</button></div>` : '';
  const sym = (SYMBOL[HOME] ?? '').trim() || HOME;
  const rows = ob.picks.map((p) => `<div class="ob-nrow">
      <div class="ob-ntop">${accountTile({ name: p.name, type: p.type }, 'sm')}<span class="ob-nname">${h(p.name)}</span>
        <label class="ob-bal"><span>${h(sym)}</span><input data-k="${h(p.k)}" inputmode="decimal" autocomplete="off" placeholder="${tr('初始余额', 'Opening balance')}" value="${h(p.init)}" aria-label="${tr('初始余额', 'Opening balance')}"></label>
        <button class="ob-x" data-ob="unpick" data-v="${h(p.k)}" aria-label="${tr('移除', 'Remove')}">✕</button></div>
      <div class="ob-types">${obTypes().map(([t, n]) => `<button class="chip${p.type === t ? ' on' : ''}" data-ob="type" data-v="${h(p.k)}" data-t="${t}">${n}</button>`).join('')}</div></div>`).join('');
  return `<h2 class="ob-h">${tr('选择您使用的银行或支付钱包', 'Which wallets and banks do you use?')}</h2>
    ${ob.note ? `<div class="ob-note">${h(ob.note)}</div>` : ''}
    ${groups}${add}
    ${rows ? `<div class="card ob-new">${rows}</div>` : ''}`;
}

function obStyle() {
  const styles = AP_STYLES.map(([k, name]) => `<button class="ap-opt ${apPrefs.style === k ? 'on' : ''}" data-act="ap-style" data-v="${k}" aria-pressed="${apPrefs.style === k}">
      <span class="ap-sw" data-p="${k}"><i><em></em></i></span><span class="ap-txt"><b>${name()}</b></span></button>`).join('');
  const ledger = state.data.ledger.get(state.ledgerId), cur = ledger ? apLedgerHex(ledger.id) : null;
  const colors = ledger ? `<div class="card ob-card"><span class="ap-h">${tr('主题色', 'Theme color')}</span>
    <div class="ob-colors">${AP_COLORS.map((c) => `<button class="${cur === c ? 'on' : ''}" style="background:${c}" data-act="ap-color" data-v="${c}" aria-label="${c}" aria-pressed="${cur === c}"></button>`).join('')}</div>
    <div><button class="chip ${cur ? '' : 'on'}" data-act="ap-color" data-v="">${tr('跟随外观', 'Use the theme\'s color')}</button></div></div>` : '';
  return `<h2 class="ob-h">${tr('个性化', 'Make it yours')}</h2>
    <div class="card ob-card"><span class="ap-h">${tr('我的星球', 'My planet')}</span>${plMineGrid()}</div>
    <div class="card ob-card"><span class="ap-h">${tr('外观', 'Appearance')}</span><div class="ap-styles">${styles}</div></div>
    ${colors}`;
}

function obFinish() {
  const mine = plMine(), p = mine ?? PLANET_BRAND;
  const n = [...state.data.account.values()].filter((a) => !a.archived).length;
  return `<div class="ob-center ob-fin">
    <div class="ob-big">${planetSvg(p, { px: 128, mood: 1 })}</div>
    <h1 class="ob-title">${tr('初始设置完成！', 'All set!')}</h1>
    <div class="card ob-sum">
      <div><span class="ob-flag">${hmFlag(HOME)}</span><span>${tr('主货币', 'Main currency')} <b>${h(HOME)}</b></span></div>
      <div>${iconTile('wallet', 'sm')}<span>${tr(`${n} 个账户`, `${n} account${n === 1 ? '' : 's'}`)}</span></div>
      <div>${planetSvg(p, { px: 24, spin: false })}<span>${mine ? h(planetName(mine)) : tr('暂未选择星球', 'No planet yet')}</span></div></div>
    <div class="ob-tips"><div><b>＋</b><span>${tr('记一笔，长按＋可以语音', 'Tap ＋ to log, hold it to speak')}</span></div>
      <div>${hmSvg(ICONS.sparkle.d)}<span>${tr('AI 设置里填密钥，就能一句话记账', 'Add an AI key in settings to log by sentence')}</span></div></div></div>`;
}

// ---------------------------------------------------------------- 动作

function obInput(e) {
  if (e.target.id === 'ob-nick') { ob.nick = e.target.value; return; }
  const k = e.target.dataset?.k;
  if (k == null) return;
  const p = ob.picks.find((x) => x.k === k);
  if (p) p.init = e.target.value;
}

function obToggle(key) {
  ob.note = '';
  const ex = obExisting(key);
  if (ex) {
    if (ob.drop.has(ex.id)) { ob.drop.delete(ex.id); return; }
    // 默认账户（和这次向导里加的）没记过账可以取消，其余的不动
    if ((OB_DEFAULT_IDS.includes(ex.id) || ob.created.has(ex.id)) && !obUsed(ex.id)) ob.drop.add(ex.id);
    else ob.note = obUsed(ex.id) ? tr(`「${ex.name}」有账单，不能取消`, `“${ex.name}” has entries`) : tr(`「${ex.name}」已在使用`, `“${ex.name}” is already set up`);
    return;
  }
  const i = ob.picks.findIndex((p) => p.k === key);
  if (i >= 0) { ob.picks.splice(i, 1); return; }
  const b = obBrand(key);
  if (!b) return;
  ob.picks.push({ k: key, name: tr(b[1], b[2]), type: key === 'cash' ? 3 : OB_GROUPS.find((g) => g[2].includes(b))[0] === 'inv' ? 1 : 0, init: '' });
}

function obAddCustom() {
  const input = document.getElementById('ob-name'), name = (input?.value ?? '').trim();
  if (!name) { input?.focus(); return; }
  const low = name.toLowerCase(), taken = [...state.data.account.values()].some((a) => !a.archived && !ob.drop.has(a.id) && a.name.trim().toLowerCase() === low) || ob.picks.some((p) => p.name.trim().toLowerCase() === low);
  if (taken) { ob.note = tr(`已经有「${name}」`, `“${name}” already exists`); obRender(); return; }
  ob.picks.push({ k: 'c' + (++ob.seq), name, type: /cash|现金/i.test(name) ? 3 : 0, init: '', custom: true });
  ob.adding = false; ob.note = '';
  obRender();
}

/** 第三步点"下一步"：新选的账户写进去（和"账户"页新建账户同一条路：saveRecord + HL_JSON），取消的默认账户删掉。 */
async function obCommit() {
  const parsed = [];
  for (const p of ob.picks) {
    const text = String(p.init ?? '').trim().replace(/\s/g, '').replace(',', '.'), v = text ? Number(text) : 0;
    if (!Number.isFinite(v)) { ob.err = tr(`「${p.name}」初始余额不正确`, `Invalid opening balance for “${p.name}”`); return false; }
    parsed.push([p, Math.round(v * 100)]);
  }
  const all = [...state.data.account.values()];
  let order = all.length ? Math.max(...all.map((a) => a.sortOrder ?? 0)) + 1 : 0, id = newId();
  for (const [p, cents] of parsed) {
    const a = HL_JSON.account({ id: id++, name: p.name.trim(), type: p.type, initialCents: cents, sortOrder: order++, currency: '', archived: false, checkedAt: 0 });
    await saveRecord('account', a);
    ob.created.add(a.id);
    ob.picks.splice(ob.picks.indexOf(p), 1); // 写好一个去掉一个：中途出错再点一次不会重复
  }
  for (const aid of [...ob.drop]) { if (!obUsed(aid)) await deleteRecord('account', aid); ob.drop.delete(aid); }
  return true;
}

/** 换主货币：没有要折算的东西（新账本）就直接改；有账单或余额就走设置里同一条折算的路（有账单时先问一下）。 */
async function obSetCurrency(code) {
  if (!FX_CODES.includes(code) || code === HOME || ob.busy) return;
  const hasTx = state.data.tx.size > 0;
  const needConvert = hasTx || [...state.data.account.values()].some((a) => !a.currency && a.initialCents)
    || Number(shared.get('budget', 0)) > 0 || Object.keys(shared.get('catBudgets', {}) ?? {}).length > 0;
  if (hasTx && !(await uiConfirm(tr(`把主货币改成 ${code}？`, `Change main currency to ${code}?`), {
    ok: tr('折算并更改', 'Convert and change'),
    detail: tr(`账单、初始余额与预算将按最新汇率折算成 ${code}。`, `All entries, opening balances and the budget are converted to ${code} at the latest rates.`),
  }))) return;
  ob.busy = true; ob.err = ''; obRender();
  try {
    if (needConvert) await hmSetHome(code);
    else { await shared.set('home', code); hmSyncHome(); }
  } catch (e) { ob.err = e.message; }
  ob.busy = false;
  render(); obRender();
}

async function obClick(e) {
  const el = e.target.closest('[data-ob], [data-act]');
  if (!el || !ob.el.contains(el)) return;
  const v = el.dataset.v;
  // 第四步的星球、外观、主题色：和外观页同样的按钮，交给原来的处理（背后的页面跟着重画）
  if (el.dataset.act) {
    for (const f of MOD.actions) { try { if (await f(el.dataset.act, v, el)) break; } catch (err) { console.warn(err); } }
    obRender(); return;
  }
  switch (el.dataset.ob) {
    case 'skip': obClose(true); return;
    case 'back': if (ob.step > 0 && !ob.busy) { ob.step--; ob.dir = -1; ob.err = ''; ob.note = ''; } break;
    case 'next': {
      if (ob.busy) return;
      ob.err = '';
      if (ob.step === OB_DOTS.length - 1) { obClose(true); return; }
      if (ob.step === 0) {
        // 用户名：必填（和手机端同步，显示在"我的"页上）
        const nick = ob.nick.trim().slice(0, 20);
        if (!nick) { ob.err = tr('起一个用户名吧', 'Pick a username'); obRender(); document.getElementById('ob-nick')?.focus(); return; }
        if (nick !== String(shared.get('nickname', '') || '').trim()) {
          ob.busy = true; obRender();
          try { await shared.set('nickname', nick); } catch (err) { ob.err = err.message; }
          ob.busy = false; render();
          if (ob.err) break;
        }
      }
      if (ob.step === OB_ACC_STEP) {
        ob.busy = true; obRender();
        let ok = false;
        try { ok = await obCommit(); } catch (err) { ob.err = err.message; }
        ob.busy = false; render();
        if (!ok) break;
      }
      ob.step++; ob.dir = 1; ob.note = ''; ob.adding = false;
      break;
    }
    case 'cur': await obSetCurrency(v); return;
    case 'ios': ob.ios = v === '1'; break;
    case 'tile': obToggle(v); break;
    case 'unpick': ob.picks = ob.picks.filter((p) => p.k !== v); break;
    case 'type': { const p = ob.picks.find((x) => x.k === v); if (p) p.type = Number(el.dataset.t); break; }
    case 'other':
      ob.adding = !ob.adding; ob.note = ''; obRender();
      if (ob.adding) document.getElementById('ob-name')?.focus();
      return;
    case 'add': obAddCustom(); return;
    default: return;
  }
  obRender();
}

// 设置 → 使用向导
MOD.actions.push(async (act) => {
  if (act !== 'ob-open') return false;
  obOpen();
  return true;
});

// 第一次读完云端数据：已经有账单的账号不打扰（记成走过了）；全新的、这台设备没走过的就打开向导
MOD.onLoad.push(async () => {
  if (obDone() || ob.open) return;
  if (state.data.tx.size) { obMark(); return; }
  if (ob.shown) return;
  ob.shown = true;
  setTimeout(() => { if (state.session && !obDone() && !ob.open) obOpen(); }, 0);
});

// 退出登录（或登录过期）时向导跟着关掉
addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app');
  if (root) new MutationObserver(() => { if (ob.open && !state.session) obClose(false); }).observe(root, { childList: true });
});
