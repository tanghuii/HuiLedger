// 外观：五套外观、线性图标、账本主题色（和手机端 Glass.kt 的 AppStyle / JizhangTheme、设置里的"外观""图标"、账本颜色对应）。
// 外观和图标画法只存在这台设备上（手机端也是存在本机）；账本颜色是和手机共享的设置 ledgerColors。
// 样式都在 css/themes.css；这里只在 <html> 上打标记（见那个文件开头的说明）。
'use strict';

const AP_STYLES = [
  ['glass', () => tr('液态玻璃', 'Liquid glass'), () => tr('半透明卡片，柔和光晕', 'Translucent cards, soft glow')],
  ['bento', () => tr('便当格', 'Bento'), () => tr('黑白底配彩色方块', 'Monochrome with color tiles')],
  ['dark', () => tr('深色金融', 'Dark finance'), () => tr('近黑底，亮绿强调', 'Near-black, bright green')],
  ['cartoon', () => tr('卡通', 'Cartoon'), () => tr('粗描边，糖果色', 'Bold outlines, candy colors')],
  ['paper', () => tr('手账纸', 'Paper'), () => tr('米色纸张，点阵底纹', 'Cream paper, dot grid')],
];
/** 账本颜色可选的十种（和手机端 LedgersScreen 的 LEDGER_COLORS 一样）。 */
const AP_COLORS = ['#6C5CE7', '#3B82F6', '#0EA5A4', '#22A06B', '#84A93A', '#E0A100', '#F07C2B', '#E5484D', '#E0569B', '#8A6A4F'];

// app.js 里的 store 这时还没定义，自己读写 localStorage（格式和 store 一样是 JSON）
const apStore = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式存不了就算了 */ } },
};
const apPrefs = {
  style: AP_STYLES.some(([k]) => k === apStore.get('hl.style')) ? apStore.get('hl.style') : 'glass',
  line: apStore.get('hl.lineIcons', false) === true,
  // 上次用的账本色先记着：打开页面时数据还没读出来，也不会先闪一下默认紫色
  accent: apStore.get('hl.accent', null),
};

/** 手机端存的账本颜色是有符号的 ARGB 整数。 */
const apHex = (v) => '#' + ((Number(v) >>> 0) & 0xFFFFFF).toString(16).padStart(6, '0').toUpperCase();
const apArgb = (hex) => (0xFF000000 | parseInt(hex.slice(1), 16)) | 0;
/** 相对亮度（和 Compose 的 Color.luminance() 一样按线性 sRGB 算），亮色上的字用黑色。 */
const apLum = (hex) => [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
  .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);

const apMeta = document.querySelector('meta[name="theme-color"]');
const apMetaDefault = apMeta?.content;
const apIsHex = (c) => /^#[0-9a-f]{6}$/i.test(c ?? '');
/** 两个 #RRGGBB 按比例混（t 是第一个的占比）。 */
const apMix = (a, b, t) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * t + parseInt(b.slice(i, i + 2), 16) * (1 - t)).toString(16).padStart(2, '0')).join('');
/** 状态栏（安卓上装到桌面后还有浏览器顶栏）的颜色 = 页面最上面那一截的颜色：
 *  液态玻璃是底色叠一团主题色的光晕（选了账本色就是那个颜色），其他外观就是底色。 */
function apThemeColor() {
  if (!apMeta) return;
  const cs = getComputedStyle(document.documentElement), bg = cs.getPropertyValue('--bg').trim();
  if (!apIsHex(bg)) { apMeta.content = apMetaDefault; return; }
  if (apPrefs.style !== 'glass') { apMeta.content = bg; return; }
  const glow = apIsHex(apPrefs.accent) ? apPrefs.accent : cs.getPropertyValue('--blob1').trim();
  apMeta.content = apIsHex(glow) ? apMix(glow, bg, matchMedia('(prefers-color-scheme: dark)').matches ? 0.4 : 0.55) : bg;
}

function apSetAccent(hex) {
  const de = document.documentElement;
  if (hex && /^#[0-9a-f]{6}$/i.test(hex)) {
    de.style.setProperty('--accent', hex);
    de.style.setProperty('--on-accent', apLum(hex) > 0.6 ? '#000' : '#fff');
    de.classList.add('ap-accent');
  } else {
    de.style.removeProperty('--accent'); de.style.removeProperty('--on-accent');
    de.classList.remove('ap-accent');
  }
}

/** 把选好的外观、图标画法、账本色标到 <html> 上。 */
function apApply() {
  const de = document.documentElement, s = apPrefs.style;
  de.dataset.style = s;
  de.classList.toggle('ap-solid', s !== 'glass');
  de.classList.toggle('line-icons', apPrefs.line);
  // 深浅固定的外观：style.css 里按系统深浅色写的规则也跟着它走
  if (s === 'dark') de.dataset.theme = 'dark'; else if (s === 'bento' || s === 'cartoon') de.dataset.theme = 'light'; else delete de.dataset.theme;
  apSetAccent(apPrefs.accent);
  apThemeColor();
}
// 越早越好：这时页面还没画内容
apApply();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', apThemeColor);

/** 当前账本自己的颜色（#RRGGBB），没设是 null。 */
function apLedgerHex(id = state.ledgerId) {
  const v = shared.get('ledgerColors', {})?.[String(id)];
  return v == null ? null : apHex(v);
}

/** 分类图标的方块记下自己的颜色（--tc），各外观、线性图标据此换画法。只认带图标、用纯色底的方块（不碰银行 logo、字标和账本色块）。 */
function apMarkTiles(root) {
  const list = root.matches?.('.tile') ? [root] : root.querySelectorAll ? root.querySelectorAll('.tile') : [];
  for (const el of list) {
    if (el.classList.contains('ap-ic') || el.classList.contains('ap-no')) continue;
    const c = !el.classList.contains('mg-ltile') && el.querySelector(':scope > svg') && el.style.backgroundColor;
    if (c) { el.style.setProperty('--tc', c); el.classList.add('ap-ic'); } else el.classList.add('ap-no');
  }
}

/** 每次重画之后：账本换了、颜色改了（本机或手机同步过来的）就换主题色。 */
function apSyncAccent() {
  try {
    if (!state.session || !state.data.ledger.size) return; // 数据还没读出来时先用记着的颜色
    const hex = apLedgerHex();
    if (hex === apPrefs.accent) return;
    apPrefs.accent = hex; apStore.set('hl.accent', hex);
    apSetAccent(hex); apThemeColor();
  } catch { /* state 还没准备好 */ }
}

// 页面每次重画（app.js 的 render 换掉 #app 的内容，编辑器等往 body 里加层）都会触发；在浏览器画出来之前就处理完，不会闪
new MutationObserver((records) => {
  for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) apMarkTiles(n);
  apSyncAccent();
}).observe(document.body, { childList: true, subtree: true });

MOD.onLoad.push(async () => apSyncAccent());

// ---------------------------------------------------------------- 外观页（设置 → 外观）

function appearanceView() {
  // 设置页登记了就回设置页；没有设置页时这页挂在"我的"上，返回栏由 more.js 画
  const inMe = MOD.me.some((m) => m.key === 'appearance');
  const back = inMe ? '' : `<div class="subbar"><button class="round" data-act="tab" data-v="${MOD.pages.settings ? 'settings' : 'me'}" aria-label="${tr('返回', 'Back')}">‹</button><b>${tr('外观', 'Appearance')}</b></div>`;
  const styles = AP_STYLES.map(([k, name, hint]) => `<button class="ap-opt ${apPrefs.style === k ? 'on' : ''}" data-act="ap-style" data-v="${k}" aria-pressed="${apPrefs.style === k}">
      <span class="ap-sw" data-p="${k}"><i><em></em></i></span><span class="ap-txt"><b>${name()}</b><small>${hint()}</small></span></button>`).join('');
  const line = apPrefs.line;
  const icons = `<div class="card grid">
    <div class="between"><span class="ap-h">${tr('图标', 'Icons')}</span>
      <div class="seg ap-seg"><button class="${line ? '' : 'on'}" data-act="ap-line" data-v="0">${tr('彩色', 'Color')}</button><button class="${line ? 'on' : ''}" data-act="ap-line" data-v="1">${tr('线性', 'Line')}</button></div></div>
    <div class="ap-tiles">${['food', 'bus', 'basket', 'home', 'heart', 'gift'].map((k) => iconTile(k)).join('')}</div></div>`;
  const ledger = state.data.ledger.get(state.ledgerId);
  const cur = ledger ? apLedgerHex(ledger.id) : null;
  const colors = ledger ? `<div class="card grid">
    <span class="ap-h">${tr(`「${h(ledger.name)}」的主题色`, `Color for “${h(ledger.name)}”`)}</span>
    <div class="ap-colors">${AP_COLORS.map((c) => `<button class="${cur === c ? 'on' : ''}" style="background:${c}" data-act="ap-color" data-v="${c}" aria-label="${c}"></button>`).join('')}</div>
    <div><button class="chip ${cur ? '' : 'on'}" data-act="ap-color" data-v="">${tr('跟随外观', 'Use the theme\'s color')}</button></div></div>` : '';
  // 最上面两张：我的星球、本月行星（modules/cosmos.js）
  const planets = typeof plAppearanceCards === 'function' ? plAppearanceCards() : '';
  return `${back}<div class="grid">${planets}
    <div class="card grid"><span class="ap-h">${tr('外观', 'Appearance')}</span><div class="ap-styles">${styles}</div></div>
    ${icons}${colors}</div>`;
}

MOD.pages.appearance = () => appearanceView();

MOD.actions.push(async (act, v) => {
  switch (act) {
    case 'ap-style':
      if (AP_STYLES.some(([k]) => k === v)) { apPrefs.style = v; apStore.set('hl.style', v); apApply(); render(); }
      return true;
    case 'ap-line':
      apPrefs.line = v === '1'; apStore.set('hl.lineIcons', apPrefs.line); apApply(); render();
      return true;
    case 'ap-color': {
      const id = state.ledgerId;
      if (!state.data.ledger.has(id)) return true;
      const colors = { ...(shared.get('ledgerColors', {}) ?? {}) };
      if (v) colors[String(id)] = apArgb(v); else delete colors[String(id)];
      try { await shared.set('ledgerColors', colors); state.error = ''; } catch (e) { state.error = e.message; }
      render();
      return true;
    }
    default: return false;
  }
});

// 所有脚本都跑完之后：还没有设置页的话，先在"我的"里放一个入口，免得这页没处进
addEventListener('DOMContentLoaded', () => {
  if (!MOD.pages.settings && !MOD.me.some((m) => m.key === 'appearance')) {
    MOD.me.push({ key: 'appearance', get name() { return tr('外观', 'Appearance'); }, icon: 'paint', order: 85 });
  }
  apSyncAccent();
});
