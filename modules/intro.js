// 打开网页时的开场（和 App 的开场一样，约 1.6 秒）：紫色品牌星随页面打开放大，然后往左边飞出屏幕；
// 同时这个月的主题行星从右边飞进来，到中间轻轻一弹、笑一下，接着沿弧线飞进首页卡片右上角那颗星的位置，
// 深空同时淡掉露出首页。卡片上真的那颗在动画期间先藏着（html.pl-intro-on），落到了再换上。
// 只在页面刚打开时放一次（这个文件在 app.js 之前加载，直接把那一层挂在 body 上，和 #app 无关，页面重画不会再放）。
// 点一下任意位置跳过；系统要求少动画时只有一个很快的淡出。全部用 Web Animations，只动 transform 和 opacity。
// 样式在 css/intro.css。
'use strict';

const plIntro = { ran: false, el: null, anims: [], done: false, t0: 0 };

/** 这个月的主题行星（和首页卡片同一颗：共享设置 13 的锚点）；数据还没读出来就用默认锚点。 */
function plIntroPlanet() {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth() + 1;
  try { if (typeof plOfMonth === 'function' && typeof state !== 'undefined') return plOfMonth(y, m); } catch { /* 还没准备好 */ }
  return monthPlanet(planetYm(y, m), MONTH_PLANET_DEFAULT);
}

function plIntroEnd(fast) {
  const o = plIntro;
  if (o.done || !o.el) return;
  o.done = true;
  clearTimeout(o.tFly); clearTimeout(o.tEnd);
  const el = o.el;
  if (!fast) { el.remove(); o.el = null; document.documentElement.classList.remove('pl-intro-on'); return; }
  // 跳过：停在当前这一帧，整层很快淡掉（淡完之前这一层还挡着点击，免得一下点穿到下面的页面）
  for (const a of o.anims) { try { a.pause(); } catch { /* 已经结束 */ } }
  const f = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out', fill: 'forwards' });
  const gone = () => { el.remove(); if (o.el === el) o.el = null; document.documentElement.classList.remove('pl-intro-on'); };
  f.onfinish = gone;
  setTimeout(gone, 300); // 动画被浏览器压着不跑（后台、省电）时也按时拿掉
}

function plIntroStart() {
  const o = plIntro;
  if (o.ran) return;
  o.ran = true;
  if (document.visibilityState === 'hidden' || !document.body) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.className = 'pl-intro'; el.setAttribute('aria-hidden', 'true');
  o.el = el;
  document.documentElement.classList.add('pl-intro-on');
  const W = innerWidth, H = innerHeight, S = Math.round(Math.min(W * 0.46, H * 0.46, 200));
  el.style.setProperty('--s', S + 'px');
  const brand = `<div class="pl-in-p pl-in-b">${planetSvg(PLANET_BRAND, { px: S })}</div>`;
  if (reduced) {
    // 少动画：品牌星静静地在中间，很快淡出
    el.innerHTML = `<div class="pl-in-bg"></div><div class="pl-in-st"><div class="pl-in-c">${brand}</div></div>`;
    document.body.appendChild(el);
    const f = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, delay: 120, easing: 'ease-out', fill: 'forwards' });
    o.anims = [f];
    f.onfinish = () => plIntroEnd(false);
    o.tEnd = setTimeout(() => plIntroEnd(false), 450); // 动画被压着不跑时也按时拿掉
    el.addEventListener('click', () => plIntroEnd(true));
    return;
  }
  // 背景里的小星（位置随机，只在开场时用）
  let dots = '';
  for (let i = 0; i < 28; i++) {
    const s = (1 + Math.random() * 1.8).toFixed(1);
    dots += `<i style="left:${(Math.random() * 100).toFixed(1)}%;top:${(Math.random() * 100).toFixed(1)}%;width:${s}px;height:${s}px;opacity:${(0.3 + Math.random() * 0.6).toFixed(2)}"></i>`;
  }
  el.innerHTML = `<div class="pl-in-bg"><div class="pl-in-dots">${dots}</div></div>
    <div class="pl-in-st"><div class="pl-in-c">${brand}
      <div class="pl-in-go"><div class="pl-in-gy"><div class="pl-in-f"><div class="pl-in-x"><div class="pl-in-y"><i class="pl-in-tr"></i><div class="pl-in-p pl-in-s"><div class="pl-in-k2"></div></div></div></div></div></div></div>
    </div></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', () => plIntroEnd(true));
  addEventListener('keydown', function esc(e) {
    if (!plIntro.done && ['Escape', 'Enter', ' '].includes(e.key)) plIntroEnd(true);
    if (plIntro.done) removeEventListener('keydown', esc);
  });

  const q = (s) => el.querySelector(s), A = [];
  const t0 = document.timeline.currentTime ?? performance.now();
  o.t0 = t0;
  /** 一段动画，按开场的 0 点对齐（at 是开场后多少毫秒开始）。 */
  // fill：同一个元素上的第二段用 'forwards'，免得它开始之前就把第一段盖住
  const run = (node, frames, at, duration, easing = 'linear', fill = 'both') => {
    const a = node.animate(frames, { duration, easing, fill });
    a.startTime = t0 + at;
    A.push(a); return a;
  };
  o.anims = A;
  const st = q('.pl-in-st').getBoundingClientRect();
  // 主题行星的起点：右边屏幕外，略高一点；品牌星往左边屏幕外飞
  const dx = Math.round(st.width * 0.5 + S * 1.1), dy = -Math.round(st.height * 0.08);
  const away = -Math.round(st.width * 0.5 + S * 1.2);

  // 1. 0–340ms：品牌星随页面打开淡入、放大（0.85 → 1.15）
  run(q('.pl-in-b'), [{ opacity: 0, transform: 'scale(.85)' }, { opacity: 1, transform: 'scale(1.15)' }], 0, 340, 'cubic-bezier(.2,.8,.2,1)');
  // 2. 280–760ms：品牌星往左飞出屏幕，越飞越快
  run(q('.pl-in-b'), [{ opacity: 1, transform: 'translate(0,0) scale(1.15) rotate(0deg)' }, { opacity: 1, offset: 0.7 }, { opacity: 0, transform: `translate(${away}px, ${Math.round(st.height * 0.05)}px) scale(.85) rotate(-14deg)` }],
    280, 480, 'cubic-bezier(.5,0,.9,.5)', 'forwards');
  // 背景的小星：两颗星交换时往左漂一点（像镜头在往右转）
  run(q('.pl-in-dots'), [{ transform: 'translateX(0)' }, { transform: `translateX(${-Math.round(st.width * 0.06)}px)` }], 280, 540, 'cubic-bezier(.4,0,.2,1)');

  // 3. 280–820ms：主题行星同时从右边飞进来。横、竖分两层用不同的缓动，走一条浅浅的弧线；由小变大，一开始快、到中间慢慢停住
  run(q('.pl-in-x'), [{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], 280, 540, 'cubic-bezier(.2,.65,.3,1)');
  run(q('.pl-in-y'), [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], 280, 540, 'cubic-bezier(.45,0,.3,1)');
  run(q('.pl-in-s'), [
    { transform: 'scale(.45) rotate(16deg)', opacity: 0.5 },
    { opacity: 1, offset: 0.3 },
    { transform: 'scale(1) rotate(0deg)', opacity: 1 },
  ], 280, 540, 'cubic-bezier(.2,.65,.3,1)');
  // 身后一道淡淡的拖尾，指向来的方向（右边）
  const ang = `rotate(${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1)}deg)`;
  run(q('.pl-in-tr'), [
    { opacity: 0, transform: `${ang} scale(.4, .5)` },
    { opacity: 0.6, offset: 0.25 },
    { opacity: 0, transform: `${ang} scale(.5, .7)` },
  ], 280, 520, 'ease-out');
  // 4. 到中间后轻轻一弹：820–1080ms，1 → 1.06 → 0.98 → 1
  run(q('.pl-in-k2'), [
    { transform: 'scale(1)' }, { transform: 'scale(1.06)', offset: 0.3, easing: 'ease-in-out' },
    { transform: 'scale(.98)', offset: 0.65, easing: 'ease-in-out' }, { transform: 'scale(1)' },
  ], 820, 260, 'ease-out');

  // 主题行星在飞的路上才定是哪一颗（这时本机的快照多半已经读出来了，锚点和首页一样）
  const fly = () => {
    const p = plIntroPlanet(), k2 = q('.pl-in-k2');
    // 飞的时候嘴是平的，快到中间换成笑脸：780–900ms
    k2.innerHTML = planetSvg(p, { px: S, mood: 0 }) + `<div class="pl-in-sm">${planetSvg(p, { px: S, mood: 1 })}</div>`;
    run(k2.querySelector('.pl-in-sm'), [{ opacity: 0 }, { opacity: 1 }], 780, 120, 'ease-out');
  };
  o.tFly = setTimeout(fly, 120);

  // 5. 1100–1600ms：深空淡掉露出首页，主题行星沿弧线（先往右、再往上）飞进首页卡片右上角那颗星的位置，越飞越小；
  //    动画拿掉的那一刻，卡片上真的那颗接上（找不到卡片就原地变大一点淡掉）
  o.tEnd = setTimeout(() => {
    if (o.done) return;
    if (!q('.pl-in-sm')) fly(); // 计时被拖住了：至少把星换上
    // 开始淡出后就不挡手了：下面的页面已经露出来，点到的就是页面；万一结束的回调迟到，也按时拿掉
    el.style.pointerEvents = 'none';
    o.tEnd = setTimeout(() => plIntroEnd(false), 800);
    run(q('.pl-in-bg'), [{ opacity: 1 }, { opacity: 0 }], 1100, 320, 'cubic-bezier(.4,0,.2,1)');
    const c = q('.pl-in-c').getBoundingClientRect(), target = plIntroTarget();
    let last;
    if (target) {
      const tx = (target.x - c.left).toFixed(1), ty = (target.y - c.top).toFixed(1);
      run(q('.pl-in-go'), [{ transform: 'translateX(0)' }, { transform: `translateX(${tx}px)` }], 1100, 500, 'cubic-bezier(.3,0,.2,1)', 'forwards');
      run(q('.pl-in-gy'), [{ transform: 'translateY(0)' }, { transform: `translateY(${ty}px)` }], 1100, 500, 'cubic-bezier(.6,0,.2,1)', 'forwards');
      last = run(q('.pl-in-f'), [{ transform: 'scale(1) rotate(0deg)' }, { transform: 'scale(.6) rotate(10deg)', offset: 0.5 }, { transform: `scale(${(target.w / S).toFixed(3)}) rotate(0deg)` }],
        1100, 500, 'cubic-bezier(.45,0,.15,1)', 'forwards');
    } else {
      last = run(q('.pl-in-go'), [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.25)', opacity: 0 }], 1100, 400, 'cubic-bezier(.5,0,.2,1)', 'forwards');
    }
    last.onfinish = () => plIntroEnd(false);
  }, 1050);
}

/** 首页卡片右上角那颗星（在屏幕上、翻页条当前这一页上才算）：中心位置和大小。 */
function plIntroTarget() {
  const f = document.querySelector('#app .hm-sum:not(.mini) .hm-top1 > .pl-face'), pg = f?.closest('.hm-pager');
  if (!f || !pg) return null;
  const r = f.getBoundingClientRect(), b = pg.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (!r.width || x < b.left || x > b.right || y < 0 || y > innerHeight) return null;
  return { x, y, w: r.width };
}

// 这个文件在 app.js 之前跑：现在就把这一层挂上（盖住页面第一次画出来的样子），时间线也从现在算起
plIntroStart();
