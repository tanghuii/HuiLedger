// 打开网页时的开场（和 App 的开场一样）：紫色品牌星在中间（只停一小会儿）；这个月的主题行星从右上角的深处飞过来，越飞越大，
// 品牌星往后退、淡掉，主题行星在中间轻轻一弹、笑一下，停一会儿（轻轻浮动），然后沿一条弧线飞进首页卡片右上角那颗星的位置，
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
  // 往外划的星线（"飞得很快"的感觉）
  const K = 18, streaks = Array.from({ length: K }, () => '<i class="pl-in-k"></i>').join('');
  el.innerHTML = `<div class="pl-in-bg"><div class="pl-in-dots">${dots}</div></div>
    <div class="pl-in-st"><div class="pl-in-c">${streaks}${brand}
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
  // 屏幕中心（安全区里）→ 起点：右上角深处
  const st = q('.pl-in-st').getBoundingClientRect(), dx = Math.round(st.width * 0.36), dy = -Math.round(st.height * 0.3);

  // 1. 品牌星出现：0–220ms，淡入并从 0.85 放大到 1（只停一小会儿）
  run(q('.pl-in-b'), [{ opacity: 0, transform: 'scale(.85)' }, { opacity: 1, transform: 'scale(1)' }], 0, 220, 'cubic-bezier(.2,.8,.2,1)');
  // 背景的小星：飞行时慢慢放大一点（往前冲的感觉）
  run(q('.pl-in-dots'), [{ transform: 'scale(1)' }, { transform: 'scale(1.15)' }], 150, 950, 'cubic-bezier(.5,0,.9,.5)');

  // 2. 主题行星飞过来：150–1000ms。横、竖分两层用不同的缓动，走一条缓缓的弧线；缩放 0.05 → 1 越来越快（ease-in），同时转正
  run(q('.pl-in-x'), [{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], 150, 850, 'cubic-bezier(.5,0,.8,.6)');
  run(q('.pl-in-y'), [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], 150, 850, 'cubic-bezier(.35,0,.7,.8)');
  run(q('.pl-in-s'), [
    { transform: 'scale(.05) rotate(-40deg)', opacity: 0 },
    { opacity: 0.55, offset: 0.2 },
    { opacity: 1, offset: 0.45 },
    { transform: 'scale(1) rotate(0deg)', opacity: 1 },
  ], 150, 850, 'cubic-bezier(.55,0,.95,.5)');
  // 身后一道淡淡的拖尾，指向来的方向
  const ang = `rotate(${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1)}deg)`;
  run(q('.pl-in-tr'), [
    { opacity: 0, transform: `${ang} scale(.25, .2)` },
    { opacity: 0.7, offset: 0.45 },
    { opacity: 0.5, transform: `${ang} scale(1, 1)`, offset: 0.85 },
    { opacity: 0, transform: `${ang} scale(.6, .8)` },
  ], 220, 850, 'cubic-bezier(.5,0,.9,.6)');
  // 星线从中心往外划：250–1400ms 之间错开出发
  const diag = Math.hypot(W, H);
  el.querySelectorAll('.pl-in-k').forEach((k, i) => {
    const a = (i / K) * 360 + Math.random() * 14, r0 = (0.1 + Math.random() * 0.25) * Math.min(W, H), r1 = r0 + diag * 0.75;
    run(k, [
      { transform: `rotate(${a.toFixed(1)}deg) translateX(${r0.toFixed(0)}px) scaleX(.2)`, opacity: 0 },
      { opacity: 0.9, offset: 0.3 },
      { transform: `rotate(${a.toFixed(1)}deg) translateX(${r1.toFixed(0)}px) scaleX(2.2)`, opacity: 0 },
    ], 250 + Math.random() * 400, 650 + Math.random() * 200, 'cubic-bezier(.55,0,1,.45)');
  });

  // 3. 品牌星让位：450–850ms，往左上退、缩小、淡掉
  run(q('.pl-in-b'), [{ opacity: 1, transform: 'translate(0,0) scale(1)' }, { opacity: 0, transform: `translate(${-Math.round(st.width * 0.16)}px, ${-Math.round(st.height * 0.1)}px) scale(.42)` }],
    450, 400, 'cubic-bezier(.4,0,.2,1)', 'forwards');
  // 到中间后轻轻一弹：1000–1350ms，1 → 1.08 → 0.97 → 1
  run(q('.pl-in-k2'), [
    { transform: 'scale(1)' }, { transform: 'scale(1.08)', offset: 0.3, easing: 'ease-in-out' },
    { transform: 'scale(.97)', offset: 0.65, easing: 'ease-in-out' }, { transform: 'scale(1)' },
  ], 1000, 350, 'ease-out');
  // 停在中间：1300–1950ms 轻轻往上浮一下再回来（回到正中间再出发）
  run(q('.pl-in-f'), [{ transform: 'translateY(0)' }, { transform: 'translateY(-5px)', offset: 0.5, easing: 'ease-in-out' }, { transform: 'translateY(0)' }], 1300, 650, 'ease-in-out', 'backwards');

  // 主题行星在飞的路上才定是哪一颗（这时本机的快照多半已经读出来了，锚点和首页一样）
  const fly = () => {
    const p = plIntroPlanet(), k2 = q('.pl-in-k2');
    // 飞的时候嘴是平的，落到中间换成笑脸：1030–1180ms
    k2.innerHTML = planetSvg(p, { px: S, mood: 0 }) + `<div class="pl-in-sm">${planetSvg(p, { px: S, mood: 1 })}</div>`;
    run(k2.querySelector('.pl-in-sm'), [{ opacity: 0 }, { opacity: 1 }], 1030, 150, 'ease-out');
  };
  o.tFly = setTimeout(fly, 120);

  // 4. 1950–2650ms：深空淡掉露出首页，主题行星沿弧线（先往右、再往上）飞进首页卡片右上角那颗星的位置，越飞越小；
  //    动画拿掉的那一刻，卡片上真的那颗接上（找不到卡片就原地变大一点淡掉）
  o.tEnd = setTimeout(() => {
    if (o.done) return;
    if (!q('.pl-in-sm')) fly(); // 计时被拖住了：至少把星换上
    // 开始淡出后就不挡手了：下面的页面已经露出来，点到的就是页面；万一结束的回调迟到，也按时拿掉
    el.style.pointerEvents = 'none';
    o.tEnd = setTimeout(() => plIntroEnd(false), 1000);
    run(q('.pl-in-bg'), [{ opacity: 1 }, { opacity: 0 }], 1950, 450, 'cubic-bezier(.4,0,.2,1)');
    const c = q('.pl-in-c').getBoundingClientRect(), target = plIntroTarget();
    let last;
    if (target) {
      const tx = (target.x - c.left).toFixed(1), ty = (target.y - c.top).toFixed(1);
      run(q('.pl-in-go'), [{ transform: 'translateX(0)' }, { transform: `translateX(${tx}px)` }], 1950, 700, 'cubic-bezier(.3,0,.2,1)', 'forwards');
      run(q('.pl-in-gy'), [{ transform: 'translateY(0)' }, { transform: `translateY(${ty}px)` }], 1950, 700, 'cubic-bezier(.6,0,.2,1)', 'forwards');
      last = run(q('.pl-in-f'), [{ transform: 'scale(1) rotate(0deg)' }, { transform: 'scale(.6) rotate(10deg)', offset: 0.5 }, { transform: `scale(${(target.w / S).toFixed(3)}) rotate(0deg)` }],
        1950, 700, 'cubic-bezier(.45,0,.15,1)', 'forwards');
    } else {
      last = run(q('.pl-in-go'), [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.25)', opacity: 0 }], 1950, 450, 'cubic-bezier(.5,0,.2,1)', 'forwards');
    }
    last.onfinish = () => plIntroEnd(false);
  }, 1900);
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
