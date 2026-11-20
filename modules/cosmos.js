// 行星账本的星球都在这里摆：首页卡片上的本月行星、月份旁边的"土星月"、"我的"头像、外观里的"我的星球""本月行星"、
// 登录页的小星系、彩色卡片上的星环装饰、底栏 ＋ 的小轨道、记完一笔的流星；外观里的"桌面图标"。
// 星球的画法在 planets.js（生成的文件，别手改）；这里只管放在哪、选哪颗。样式在 css/cosmos.css。
// 两个和手机共享的设置：planet（自己的星球，'saturn' 这样的字符串）、monthPlanet（每月轮换的锚点 { ym, i }）。
// 桌面图标是另一个设置，只存在这台设备上（hl.launcherIcon，不同步），默认紫色的品牌星；自己的星球不再换图标。
'use strict';

const PL_KEYS = PLANETS_NINE.map((p) => p.key);
const PL_MONTH_ZH = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const PL_MONTH_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const plReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/** 所有星球动画共用一个钟：页面重画后接着转，不会每点一下就跳回开头。 */
const plNow = () => performance.now() / 1000;

/** 自己的星球；没选过是 null（这时到处用紫色的品牌星）。 */
function plMine() {
  const k = String(shared.get('planet', '') ?? '').trim().toLowerCase();
  return PL_KEYS.includes(k) ? planetByKey(k) : null;
}
/** 每月轮换的锚点；没有或坏了就用默认（2026 年 12 月 = 水星）。 */
function plAnchor() {
  let a = shared.get('monthPlanet', null);
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  const ym = Number(a?.ym), i = Number(a?.i);
  return Number.isInteger(ym) && Number.isInteger(i) ? { ym, i: ((i % 9) + 9) % 9 } : MONTH_PLANET_DEFAULT;
}
/** 某年某月的主题行星。 */
const plOfMonth = (y, m) => monthPlanet(planetYm(y, m), plAnchor());

// ---------------------------------------------------------------- 桌面图标（iPhone"添加到主屏幕"时取 apple-touch-icon）

/** 可选的桌面图标：品牌星（默认）+ 九颗星。 */
const PL_ICONS = ['brand', ...PL_KEYS];
/** 这台设备选的桌面图标（hl.launcherIcon）；没选过或坏了是 'brand'。index.html 一打开就按它换图标。 */
function plLauncher() {
  let k = '';
  try { k = JSON.parse(localStorage.getItem('hl.launcherIcon')); } catch { /* 没有或坏了 */ }
  return PL_ICONS.includes(k) ? k : 'brand';
}
function plApplyIcon() {
  const href = `icons/planets/${plLauncher()}-180.png`;
  for (const link of document.querySelectorAll('link[rel="apple-touch-icon"]')) if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}
addEventListener('DOMContentLoaded', () => {
  // 3.0 用 hl.planet 记"图标 = 自己的星球"；现在图标单独选，旧的不要了（升级上来是默认紫色星球）
  try { localStorage.removeItem('hl.planet'); } catch { /* 存不了就算了 */ }
  plApplyIcon();
});

// ---------------------------------------------------------------- 首页：汇总卡片上的星球、月份旁的"土星月"

/** 汇总卡片右上角：这个月的主题行星，自转；结余为负就撇嘴（和原来的金币同一个判断）。 */
function plFace(happy, px = 58) {
  const { y, m } = state.month;
  return planetSvg(plOfMonth(y, m), { px, mood: happy ? 1 : -1, cls: px >= 40 ? 'hm-face pl-face' : 'pl-face' });
}

/** 月份旁边：小星球 + "土星月"（是自己的星球就是"本命月 ✦"）；点一下换这个月的星。 */
function plMonthTag(y, m) {
  const p = plOfMonth(y, m), own = plMine()?.key === p.key, open = !!state.plMPick;
  const pop = open ? `<div class="hm-menu-bg" data-act="pl-mpick-x"></div><div class="pl-mpop" role="menu">${PLANETS_NINE.map((q, i) => `<button class="${q.key === p.key ? 'on' : ''}" role="menuitemradio" aria-checked="${q.key === p.key}" data-act="pl-mset" data-v="${i}" aria-label="${h(planetName(q))}">${planetSvg(q, { px: 28, spin: q.key === p.key })}</button>`).join('')}</div>` : '';
  return `<span class="pl-mtag"><button class="pl-ml" data-act="pl-mpick" aria-haspopup="menu" aria-expanded="${open}">${planetSvg(p, { px: 18 })}<span>${own ? tr('本命月', 'Your month') : tr(p.zh + '月', p.en + ' month')}</span>${own ? '<i class="pl-tw2" aria-hidden="true">✦</i>' : ''}</button>${pop}</span>`;
}

// ---------------------------------------------------------------- 选自己的星球（"我的"头像点进来、外观页）

/** 3×3：九颗星，下面写名字；选中的那颗垫一层主题色、打勾，并且在转。 */
function plMineGrid() {
  const mine = plMine()?.key;
  return `<div class="pl-grid">${PLANETS_NINE.map((p) => `<button class="pl-opt${p.key === mine ? ' on' : ''}" data-act="pl-mine" data-v="${p.key}" aria-pressed="${p.key === mine}">${planetSvg(p, { px: 44, spin: p.key === mine })}<span>${h(planetName(p))}</span></button>`).join('')}</div>`;
}

/** "我的"页头像：自己的星球（没选是品牌星），白色的圆底。 */
function plAvatar() {
  const p = plMine() ?? PLANET_BRAND;
  return `<button class="hm-av pl-av" data-act="pl-sheet" aria-label="${tr('我的星球', 'My planet')}">${planetSvg(p, { px: 46 })}</button>`;
}

/** 点头像弹出的选星球小窗（画在 #app 最后，盖在页面上面）。 */
function plSheet() {
  if (!state.plSheet || !state.session) return '';
  return `<div class="modal pl-modal" data-act="pl-sheet-x"><div class="card grid" role="dialog" aria-modal="true" aria-label="${tr('我的星球', 'My planet')}">
    <div class="between"><b class="pl-sh">${tr('我的星球', 'My planet')}</b><button class="ed-x" data-act="pl-sheet-close" aria-label="${tr('关闭', 'Close')}">✕</button></div>${plMineGrid()}</div></div>`;
}

/** 桌面图标：十个小图标（和真的图标一样的紫色底），品牌星排第一，写"默认"。 */
function plIconCard() {
  const cur = plLauncher();
  const note = IS_IOS ? tr('删掉主屏幕图标，在 Safari 重新添加后生效', 'Delete the Home Screen icon and re-add it from Safari')
    : tr('重新安装到桌面后生效', 'Reinstall to the home screen to apply');
  const name = (k) => (k === 'brand' ? tr('默认', 'Default') : planetName(planetByKey(k)));
  return `<div class="card grid"><span class="ap-h">${tr('桌面图标', 'App icon')}</span>
    <div class="pl-icons">${PL_ICONS.map((k) => `<button class="${k === cur ? 'on' : ''}" data-act="pl-icon" data-v="${k}" aria-pressed="${k === cur}"><img src="icons/planets/${k}-180.png" alt="" width="52" height="52"><span>${h(name(k))}</span></button>`).join('')}</div>
    <div class="muted small">${note}</div></div>`;
}

/** 外观页最上面的三张卡：我的星球、桌面图标、本月行星（换这个月的星，后面的月份跟着往后推）。 */
function plAppearanceCards() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth() + 1, ym = planetYm(y, m), a = plAnchor(), cur = monthPlanet(ym, a);
  const next = [1, 2, 3, 4, 5].map((k) => { const d = new Date(y, m - 1 + k, 1); return [d.getMonth() + 1, monthPlanet(planetYm(d.getFullYear(), d.getMonth() + 1), a)]; });
  return `<div class="card grid"><span class="ap-h">${tr('我的星球', 'My planet')}</span>${plMineGrid()}</div>${plIconCard()}
    <div class="card grid"><span class="ap-h">${tr('本月行星', 'Planet of the month')}</span>
      <div class="pl-now">${planetSvg(cur, { px: 56 })}<b>${tr(`${PL_MONTH_ZH[m - 1]} · ${cur.zh}`, `${PL_MONTH_EN[m - 1]} · ${cur.en}`)}</b></div>
      <div class="pl-row">${PLANETS_NINE.map((p, i) => `<button class="${p.key === cur.key ? 'on' : ''}" data-act="pl-mset" data-v="${i}" data-ym="${ym}" aria-pressed="${p.key === cur.key}" aria-label="${h(planetName(p))}">${planetSvg(p, { px: 28, spin: false })}</button>`).join('')}</div>
      <div class="pl-next">${next.map(([mm, p]) => `<span>${planetSvg(p, { px: 24, spin: false })}<small>${tr(mm + '月', MONTH_EN[mm - 1])}</small></span>`).join('')}</div></div>`;
}

MOD.actions.push(async (act, v, el) => {
  if (!act.startsWith('pl-')) return false;
  switch (act) {
    case 'pl-mpick': state.plMPick = !state.plMPick; break;
    case 'pl-mpick-x': state.plMPick = false; break;
    // 换某个月的星 = 把锚点挪到那个月（首页是正在看的月份，外观页是这个月）
    case 'pl-mset': {
      const i = Number(v), ym = Number(el?.dataset.ym) || planetYm(state.month.y, state.month.m);
      state.plMPick = false;
      if (!(i >= 0 && i < 9)) break;
      try { await shared.set('monthPlanet', { ym, i }); state.error = ''; } catch (e) { state.error = e.message; }
      break;
    }
    case 'pl-sheet': state.plSheet = true; break;
    // 点小窗外面的遮罩才关
    case 'pl-sheet-x': if (lastClickTarget !== el) return true; state.plSheet = false; break;
    case 'pl-sheet-close': state.plSheet = false; break;
    case 'pl-icon': {
      if (!PL_ICONS.includes(v)) return true;
      try { localStorage.setItem('hl.launcherIcon', JSON.stringify(v)); } catch { /* 存不了就算了 */ }
      plApplyIcon();
      break;
    }
    case 'pl-mine': {
      if (!PL_KEYS.includes(v)) return true;
      state.plSheet = false;
      try { await shared.set('planet', v); state.error = ''; } catch (e) { state.error = e.message; }
      break;
    }
    default: return false;
  }
  render();
  return true;
});

// ---------------------------------------------------------------- 登录页：品牌星在中间转，三颗小星（火星、地球、土星）斜着绕它

function plLoginHero() {
  const sats = ['mars', 'earth', 'saturn'].map((k, i) => `<span class="pl-sat" style="animation-delay:${-(i * 8 + (plNow() % 24)).toFixed(2)}s"><span>${planetSvg(k, { px: 20 })}</span></span>`).join('');
  return `<div class="pl-hero" aria-hidden="true"><div class="pl-ls"><span class="pl-core">${planetSvg(PLANET_BRAND, { px: 96 })}</span>${sats}</div></div>`;
}

// ---------------------------------------------------------------- 标题后面一颗一闪一闪的小星

const plTwinkle = () => '<svg class="pl-tw" viewBox="-1 -1 2 2" aria-hidden="true"><path d="M0,-1Q.16,-.16,1,0Q.16,.16,0,1Q-.16,.16,-1,0Q-.16,-.16,0,-1Z"/></svg>';

// ---------------------------------------------------------------- 底栏的 ＋：一圈斜着的细轨道，一颗小月亮 6 秒绕一圈；按下去转得快一阵

const plNav = { extra: 0, raf: 0, start: 0 };
function plNavOrbit() {
  const still = plReduced();
  // 绕到按钮后面那半圈被按钮挡住：遮罩把"上半圈 ∩ 按钮"那块抠掉
  return `<svg class="pl-orbit" viewBox="-38 -38 76 76" aria-hidden="true"><defs><mask id="pl-nav-m"><rect x="-38" y="-38" width="76" height="76" fill="#fff"/><path d="M-26,0A26,26 0 0,1 26,0Z" transform="rotate(-18)" fill="#000"/></mask></defs>
    <g mask="url(#pl-nav-m)"><g transform="rotate(-18)"><ellipse rx="35" ry="10.5" class="pl-orbit-r"/>
      <circle r="3.2" class="pl-orbit-m"${still ? ' cx="-26" cy="7"' : ''}>${still ? '' : '<animateMotion dur="6s" repeatCount="indefinite" path="M35,0A35,10.5 0 1,1 -35,0A35,10.5 0 1,1 35,0"/>'}</circle></g></g></svg>`;
}
function plBoost() {
  if (plReduced()) return;
  plNav.start = performance.now();
  if (plNav.raf) return;
  let last = plNav.start;
  const step = (now) => {
    const k = Math.max(0, 1 - (now - plNav.start) / 900);
    plNav.extra += ((now - last) / 1000) * 5 * k * k; // 一下子快到 6 倍，0.9 秒里慢慢落回来
    last = now;
    try { document.querySelector('.nav-add .pl-orbit')?.setCurrentTime(plNow() + plNav.extra); } catch { /* 不支持就算了 */ }
    plNav.raf = k > 0 ? requestAnimationFrame(step) : 0;
  };
  plNav.raf = requestAnimationFrame(step);
}
document.addEventListener('pointerdown', (e) => { if (e.target.closest?.('.nav-add')) plBoost(); }, true);

// ---------------------------------------------------------------- 记完一笔：屏幕上沿斜着划过一颗小流星

function plShootingStar() {
  if (plReduced()) return;
  const el = document.createElement('div');
  el.className = 'pl-shoot'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<i></i><b>✦</b>';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

// ---------------------------------------------------------------- 彩色卡片的装饰：一道很淡的星环、两颗绕着它转的小月亮、几颗一闪一闪的小星
// 代替原来漂浮的圆；卡片的颜色和光泽不变。同一张卡片每次画出来位置都一样（按卡片的样子算种子）。
// 全是 CSS 动画（只动 transform 和 opacity），系统要求少动画时停在原地。

const PL_DECOR = '.card.cc, .face, .ai-story';
function plHash(s) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
function plRand(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const plSeedOf = (el) => plHash([...el.classList].filter((c) => c !== 'mini' && c !== 'click').sort().join('.') + '|' + (el.getAttribute('style') ?? '') + '|' + (el.dataset.v ?? '') + '|' + (el.dataset.roId ?? ''));

function plDecorHtml(W, H, seed) {
  const r = plRand(seed), now = plNow(), f = (n) => +n.toFixed(1), small = H < 90;
  // 负的延迟 = 接着上次画的位置转（重画不会跳）
  const lag = (dur) => `-${f((now + r() * dur) % dur)}s`;
  // 星系的中心：原来那团大圆在的地方（右上角），稍微往里一点
  const cx = W * (0.86 + r() * 0.06), cy = H * (small ? 0.1 : 0.04 + r() * 0.06);
  const rx = W * (small ? 0.36 : 0.44), ry = rx * 0.3, sw = Math.max(1.5, H * (small ? 0.05 : 0.028)), tilt = -(10 + r() * 8);
  const ring = `<i class="pl-ring" style="left:${f(-rx)}px;top:${f(-ry)}px;width:${f(2 * rx)}px;height:${f(2 * ry)}px;border-width:${f(sw)}px;transform:rotate(${f(tilt)}deg)"></i>`;
  // 小月亮：斜的椭圆轨道（一个压扁的平面），月亮自己反着压回来，所以一直是圆的
  const moon = (R, k, cls, rad, alpha, dur) => {
    const a0 = 105 + r() * 55, d = lag(dur), tl = tilt - 4 + r() * 10;
    return `<i class="pl-orb" style="left:${f(-R)}px;top:${f(-R)}px;width:${f(2 * R)}px;height:${f(2 * R)}px;transform:rotate(${f(tl)}deg) scaleY(${k})">`
      + `<i class="pl-spin" style="transform:rotate(${f(a0)}deg);animation-duration:${dur}s;animation-delay:${d}"><i class="pl-moon ${cls}" style="width:${f(2 * rad)}px;height:${f(2 * rad)}px;margin:${f(-rad)}px;background:rgba(255,255,255,${alpha});transform:rotate(${f(-a0)}deg) scaleY(${cls === 'm1' ? 2.5 : 3.125});animation-duration:${dur}s;animation-delay:${d}"></i></i></i>`;
  };
  const moons = moon(W * (small ? 0.42 : 0.5), 0.4, 'm1', Math.max(2, H * 0.04), 0.28, 18) + moon(W * (small ? 0.26 : 0.3), 0.32, 'm2', Math.max(1.5, H * 0.025), 0.24, 11);
  let spk = '';
  const n = small ? 4 : 4 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const s = 1.5 + r() * 1.5, x = W * (0.05 + r() * 0.9), y = H * (0.1 + r() * 0.8), dur = 2 + r() * 2;
    spk += `<i class="pl-spk" style="left:${f(x - s)}px;top:${f(y - s)}px;width:${f(2 * s)}px;height:${f(2 * s)}px;animation-duration:${f(dur)}s;animation-delay:${lag(dur)}"></i>`;
  }
  return `<i class="pl-sys${small ? ' still' : ''}" style="left:${f(cx)}px;top:${f(cy)}px;animation-delay:${lag(26)}">${ring}${moons}</i>${spk}`;
}

/** 给新画出来的彩色卡片加装饰：先把要量的都量完，再一起插进去（只排一次版）。 */
function plDecorate(cards) {
  const todo = [];
  for (const c of cards) {
    if (c.querySelector(':scope > .pl-dc')) continue;
    const W = c.offsetWidth;
    let H = c.offsetHeight;
    // 首页汇总卡片收成一行时：按展开的高度摆（回到顶上展开后还是那个样子）
    if (c.classList.contains('mini')) H = Math.max(H, (c.querySelector('.hm-full > div')?.scrollHeight ?? 0) + 36);
    if (W > 0 && H > 0) todo.push([c, W, H]);
  }
  for (const [c, W, H] of todo) {
    const d = document.createElement('i');
    d.className = 'pl-dc'; d.setAttribute('aria-hidden', 'true');
    d.innerHTML = plDecorHtml(W, H, plSeedOf(c));
    c.prepend(d);
  }
}

// 页面每次重画（app.js 的 render 换掉 #app 的内容）都会到这里，浏览器画出来之前处理完：
// 新的彩色卡片加装饰；新画的星球接着上一帧转
new MutationObserver((records) => {
  const cards = [], svgs = [];
  for (const rec of records) for (const n of rec.addedNodes) {
    if (n.nodeType !== 1 || n.classList.contains('pl-dc')) continue;
    if (n.matches(PL_DECOR)) cards.push(n);
    if (n.matches('svg.planet, svg.pl-orbit')) svgs.push(n);
    if (n.firstElementChild) { cards.push(...n.querySelectorAll(PL_DECOR)); svgs.push(...n.querySelectorAll('svg.planet, svg.pl-orbit')); }
  }
  if (cards.length) plDecorate(cards);
  if (svgs.length && !plReduced()) {
    const t = plNow();
    for (const s of svgs) { try { s.setCurrentTime(s.classList.contains('pl-orbit') ? t + plNav.extra : t); } catch { /* 老浏览器 */ } }
  }
}).observe(document.body, { childList: true, subtree: true });
