// 语音记账：和手机端 MainActivity 一样，长按底栏的 ＋（电脑上是右下角的圆按钮）说一句话，
// 底部弹出"正在听"的卡片：麦克风随音量跳动，说的话实时显示；说完交给"问账本"自动发出去。
// 用浏览器的 SpeechRecognition；用不了或者出错时打开问账本、把光标放进输入框，可以点键盘上的麦克风说。
// 点一下 ＋ 还是照常打开记一笔。
'use strict';

const vc = { timer: 0, press: null, swallowUntil: 0, card: null, rec: null, heard: '', done: false, cancelled: false, meter: null, level: 0, raf: 0 };
const VC_SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const VC_HOLD = 450;

const VC_MIC = `<svg viewBox="0 0 26 26" width="26" height="26" aria-hidden="true"><rect x="8.32" y="0" width="9.36" height="16.12" rx="4.68" fill="#fff"/><path d="M21.84,13A8.84,7.28 0 0 1 4.16,13" fill="none" stroke="#fff" stroke-width="2.08"/><path d="M13,20.28V24.7" stroke="#fff" stroke-width="2.08"/></svg>`;

// ---------------------------------------------------------------- 卡片

function vcShow() {
  vc.heard = ''; vc.done = false; vc.cancelled = false; vc.level = 0;
  if (!vc.card) {
    vc.card = document.createElement('div');
    vc.card.className = 'vc-card';
    vc.card.setAttribute('role', 'dialog');
    vc.card.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-vc]');
      if (!b) return;
      if (b.dataset.vc === 'stop') vcStop(); else vcCancel();
    });
  }
  vc.card.setAttribute('aria-label', tr('正在听', 'Listening'));
  vc.card.innerHTML = `<div class="vc-mic"><i class="vc-pulse"></i><span class="vc-dot">${VC_MIC}</span></div>
    <div class="vc-heard muted" aria-live="polite">${tr('正在听…说一句话记账', 'Listening… say it')}</div>
    <div class="vc-hint">${tr('比如：午饭 12 欧 ING', 'e.g. lunch 12 euros ING')}</div>
    <div class="vc-btns"><button class="btn" data-vc="cancel">${tr('取消', 'Cancel')}</button><button class="btn primary" data-vc="stop">${tr('说完了', 'Done')}</button></div>`;
  document.body.appendChild(vc.card);
  void vc.card.offsetWidth; // 先排一次版，下一句的淡入动画才会生效
  vc.card.classList.add('on');
}
function vcClose() {
  vcMeterOff();
  const c = vc.card;
  if (c?.isConnected) { c.classList.remove('on'); setTimeout(() => { if (!c.classList.contains('on')) c.remove(); }, 220); }
}
function vcSetHeard(text) {
  const el = vc.card?.querySelector('.vc-heard');
  if (!el) return;
  el.textContent = text || tr('正在听…说一句话记账', 'Listening… say it');
  el.classList.toggle('muted', !text);
}
/** 音量 0–1 → 外圈放大（1 + level × 0.5，和手机端一样）。 */
function vcLevel(v) {
  vc.level = Math.max(0, Math.min(1, v));
  vc.card?.querySelector('.vc-pulse')?.style.setProperty('--lv', vc.level.toFixed(3));
}

// ---------------------------------------------------------------- 音量（已经给过麦克风权限才开，免得多弹一次授权）

async function vcMeterOn() {
  if (vc.meter || !navigator.mediaDevices?.getUserMedia) return;
  try {
    const p = await navigator.permissions?.query({ name: 'microphone' });
    if (p?.state !== 'granted') return;
  } catch { return; }
  if (vc.done || vc.cancelled || !vc.card?.isConnected) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    if (vc.done || vc.cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser(); an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    vc.meter = { stream, ctx };
    const tick = () => {
      if (!vc.meter) return;
      an.getByteTimeDomainData(buf);
      let s = 0; for (const b of buf) { const x = (b - 128) / 128; s += x * x; }
      const rms = Math.sqrt(s / buf.length);
      // 平滑一点：涨得快、落得慢
      vcLevel(Math.max(rms * 5, vc.level * 0.85));
      vc.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch { /* 拿不到就只用说话时的小跳动 */ }
}
function vcMeterOff() {
  cancelAnimationFrame(vc.raf);
  const m = vc.meter; vc.meter = null;
  if (m) { m.stream.getTracks().forEach((t) => t.stop()); m.ctx.close?.().catch(() => {}); }
  clearInterval(vc.decay); vc.decay = 0;
}
/** 没有音量数据时：听到字就跳一下，再慢慢落回去。 */
function vcBump() {
  if (vc.meter) return;
  vcLevel(0.7 + Math.random() * 0.3);
  if (!vc.decay) vc.decay = setInterval(() => { if (!vc.meter) vcLevel(vc.level * 0.8); }, 80);
}

// ---------------------------------------------------------------- 识别

/** 用不了语音：打开问账本，光标放进输入框，提示用键盘上的麦克风。 */
function vcTypeInstead(msg) {
  vc.done = true; vc.rec = null;
  vcClose();
  state.tab = 'ask'; state.searching = false; state.q = '';
  render(); scrollTo(0, 0);
  const inp = document.querySelector('form[data-form="ask"] input, #quick');
  inp?.focus();
  xsToast(msg, 3200);
}

function vcStart() {
  if (!VC_SR) { vcTypeInstead(tr('这个浏览器不能语音识别，可以点键盘上的麦克风说', 'No speech recognition here. Use the mic on your keyboard.')); return; }
  let rec;
  try {
    rec = new VC_SR();
    rec.lang = LANG === 'en' ? 'en-US' : 'zh-CN';
    rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
  } catch { vcTypeInstead(tr('语音识别没成功，可以点键盘上的麦克风说', 'Voice didn\'t work. Use the mic on your keyboard.')); return; }
  vc.rec = rec;
  let final = '', failed = false;
  rec.onaudiostart = () => vcMeterOn();
  rec.onresult = (ev) => {
    let all = ''; final = '';
    for (const r of ev.results) { all += r[0].transcript; if (r.isFinal) final += r[0].transcript; }
    vc.heard = all.trim(); vcSetHeard(vc.heard); vcBump();
  };
  rec.onerror = (ev) => {
    if (vc.rec !== rec || vc.cancelled) return;
    failed = true;
    const e = ev.error;
    if (e === 'aborted') return;
    if (e === 'no-speech') { vc.done = true; vcClose(); xsToast(tr('没听清，再说一次', 'Didn\'t catch that. Try again.')); return; }
    if (vc.heard) return; // 已经听到了一些：交给 onend 发出去
    vcTypeInstead(e === 'not-allowed' || e === 'service-not-allowed' ? tr('没有麦克风权限，可以点键盘上的麦克风说', 'No microphone permission. Use the mic on your keyboard.')
      : e === 'network' ? tr('语音识别连不上网，先打字吧', 'Voice service can\'t reach the network. Type it instead.')
        : e === 'audio-capture' ? tr('没找到麦克风，可以点键盘上的麦克风说', 'No microphone found. Use the mic on your keyboard.')
          : tr(`语音识别出错（${e}），先打字吧`, `Voice recognition failed (${e}). Type it instead.`));
  };
  rec.onend = () => {
    if (vc.rec !== rec) return;
    vc.rec = null; vcMeterOff();
    if (vc.cancelled || vc.done) return;
    const text = (final || vc.heard).trim();
    vc.done = true; vcClose();
    if (!text) { if (!failed) xsToast(tr('没听清，再说一次', 'Didn\'t catch that. Try again.')); return; }
    // 交给"问账本"，和在输入框里打字后按发送一样
    state.tab = 'ask'; render();
    sendAsk(text);
  };
  try { rec.start(); } catch { vc.rec = null; vcTypeInstead(tr('语音识别没成功，可以点键盘上的麦克风说', 'Voice didn\'t work. Use the mic on your keyboard.')); }
}
function vcStop() {
  if (vc.rec) { try { vc.rec.stop(); } catch { /* 已经停了 */ } } else if (!vc.done) vcCancel();
}
function vcCancel() {
  vc.cancelled = true; vc.done = true;
  const r = vc.rec; vc.rec = null;
  try { r?.abort(); } catch { /* 已经停了 */ }
  vcClose();
}

// ---------------------------------------------------------------- 长按 ＋

const vcTarget = (t) => t?.closest?.('.nav-add, .fab');

document.addEventListener('pointerdown', (ev) => {
  const el = vcTarget(ev.target);
  if (!el || ev.button > 0 || !ev.isPrimary || state.editing || (typeof lk !== 'undefined' && lk.locked)) return;
  clearTimeout(vc.timer);
  vc.press = { el, x: ev.clientX, y: ev.clientY, fired: false, id: ev.pointerId };
  vc.timer = setTimeout(() => {
    if (!vc.press || vc.press.el !== el) return;
    vc.press.fired = true;
    if (vc.rec) vcCancel(); // 上一次还没结束的先停掉
    navigator.vibrate?.(12);
    vcShow();
    // 鼠标按着就能开始（按下就算用户操作）；手指要等松开那一下，iPhone 才让开麦克风
    if (ev.pointerType === 'mouse') { vc.press.started = true; vc.cancelled = false; vc.done = false; vcStart(); }
  }, VC_HOLD);
});
document.addEventListener('pointermove', (ev) => {
  const p = vc.press;
  if (!p || p.fired || ev.pointerId !== p.id) return;
  if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 12) { clearTimeout(vc.timer); vc.press = null; }
});
function vcRelease(ev) {
  const p = vc.press;
  if (!p || ev.pointerId !== p.id) return;
  clearTimeout(vc.timer); vc.press = null;
  if (!p.fired) return;
  // 长按之后跟着来的那一下点击不算"记一笔"
  vc.swallowUntil = Date.now() + 800;
  if (!p.started) { vc.cancelled = false; vc.done = false; vcStart(); }
}
document.addEventListener('pointerup', vcRelease);
document.addEventListener('pointercancel', vcRelease);
document.addEventListener('click', (ev) => {
  if (Date.now() < vc.swallowUntil && vcTarget(ev.target)) { ev.stopPropagation(); ev.preventDefault(); vc.swallowUntil = 0; }
}, true);
document.addEventListener('contextmenu', (ev) => { if (vcTarget(ev.target)) ev.preventDefault(); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && vc.card?.isConnected && !vc.done) vcCancel(); });
