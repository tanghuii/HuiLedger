// 应用锁：和手机端 MainActivity 的 lock / unlock / refreshLock、EmptyArt.kt 的 LockScreen 一样。
// 开着时：打开就锁；切到后台超过 60 秒再回来也要重新解锁。解锁用面容 / 指纹（WebAuthn 平台验证器），
// 这台设备用不了就退回到 4–6 位数字密码（只存加盐的 SHA-256）。
// 注意：这只是一层"遮挡屏"，挡住别人随手翻看；数据本身没有加密，浏览器里的数据和云端都不受它保护。
// 设置只存在这台设备上（localStorage 的 hl.lock），不同步。
// 另外放了两个小工具给 reminders.js / voice.js 共用：xsToast（底部提示）、xsSwitch（开关）。
'use strict';

const LK_KEY = 'hl.lock';
const lk = {
  layer: null, locked: false, hiddenAt: 0, busy: false, fails: 0, waitUntil: 0,
  get cfg() { try { return JSON.parse(localStorage.getItem(LK_KEY)) || { on: false }; } catch { return { on: false }; } },
  save(c) { try { if (c) localStorage.setItem(LK_KEY, JSON.stringify(c)); else localStorage.removeItem(LK_KEY); } catch { /* 隐私模式存不了 */ } },
};

// ---------------------------------------------------------------- 共用小工具

/** 底部的一条小提示，2.4 秒后消失。画在 #app 外面。 */
function xsToast(text, ms = 2400) {
  let el = document.querySelector('.xs-toast');
  if (!el) { el = document.createElement('div'); el.className = 'xs-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(xsToast.t);
  xsToast.t = setTimeout(() => el.classList.remove('on'), ms);
}
/** 一个开关按钮（role=switch），点它触发 data-act。 */
const xsSwitch = (act, on, label, extra = '') => `<button class="xs-sw${on ? ' on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${label}" data-act="${act}" ${extra}><i></i></button>`;

// ---------------------------------------------------------------- 字节 / 编码

const lkRand = (n) => crypto.getRandomValues(new Uint8Array(n));
const lkB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const lkUnB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function lkHash(salt, pin) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** 这台设备能不能用面容 / 指纹（平台验证器，要求用户验证）。 */
async function lkPlatformOk() {
  try { return !!(window.PublicKeyCredential && window.isSecureContext && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch { return false; }
}

// ---------------------------------------------------------------- 锁屏那一层

const LK_GLYPH = `<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true"><path d="M11.2,18V14A8.8,9.2 0 0 1 28.8,14V18" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round"/><rect x="7.2" y="18" width="25.6" height="18.4" rx="4" fill="currentColor"/><circle cx="20" cy="26.4" r="2.4" fill="#fff"/></svg>`;

function lkPaint() {
  const pin = lk.cfg.kind === 'pin';
  lk.layer.innerHTML = `<div class="lk-box">
      <div class="lk-ic">${LK_GLYPH}</div>
      <div class="lk-t">${tr('辉记账本已锁定', 'HuiLedger is locked')}</div>
      ${pin ? `<input class="lk-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" enterkeyhint="go" aria-label="${tr('密码', 'PIN')}" placeholder="${tr('密码', 'PIN')}">` : ''}
      <div class="lk-err" aria-live="polite"></div>
      <button class="btn primary lk-go">${tr('解锁', 'Unlock')}</button>
    </div>
    <button class="btn link lk-out">${tr('退出登录', 'Sign out')}</button>`;
}

/** 锁上 / 盖上。cover = 只是切到后台时先盖住（回来不到 60 秒就揭开）。 */
function lkShow(cover = false) {
  if (!lk.layer) {
    lk.layer = document.createElement('div');
    lk.layer.className = 'lk-layer';
    lk.layer.setAttribute('role', 'dialog');
    lk.layer.setAttribute('aria-modal', 'true');
    lk.layer.addEventListener('click', lkClick);
    lk.layer.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.classList.contains('lk-pin')) { ev.preventDefault(); lkTryPin(); } });
    lk.layer.addEventListener('input', (ev) => { const p = ev.target; if (!p.classList.contains('lk-pin')) return; p.value = p.value.replace(/\D/g, '').slice(0, 6); if (p.value.length === (lk.cfg.len || 6)) lkTryPin(); });
  }
  if (!lk.layer.isConnected) { lkPaint(); document.body.appendChild(lk.layer); }
  lk.layer.setAttribute('aria-label', tr('辉记账本已锁定', 'HuiLedger is locked'));
  lk.layer.classList.toggle('lk-cover', cover);
  document.body.classList.add('lk-locked');
  // 键盘和读屏也碰不到下面的内容
  for (const el of document.body.children) if (el !== lk.layer && !el.classList.contains('ui-confirm') && !el.classList.contains('xs-toast')) el.inert = true;
  if (!cover) lk.locked = true;
}
function lkHide() {
  lk.locked = false;
  lk.layer?.remove();
  document.body.classList.remove('lk-locked');
  for (const el of document.body.children) el.inert = false;
}

/** 锁上并马上弹出面容 / 指纹（和手机端打开就弹验证一样；浏览器不让就等用户点）。 */
function lkLock() {
  if (!lk.cfg.on) return;
  lkShow(false);
  if (lk.cfg.kind === 'key') lkUnlock(true);
  else setTimeout(() => lk.layer?.querySelector('.lk-pin')?.focus(), 50);
}

function lkErr(text) {
  const e = lk.layer?.querySelector('.lk-err');
  if (e) e.textContent = text;
  if (text) { const b = lk.layer?.querySelector('.lk-box'); b?.classList.remove('lk-shake'); void b?.offsetWidth; b?.classList.add('lk-shake'); }
}

async function lkUnlock(auto = false) {
  const c = lk.cfg;
  if (!c.on) { lkHide(); return; }
  if (c.kind === 'pin') { lkTryPin(); return; }
  if (lk.busy) return;
  lk.busy = true; lkErr('');
  try {
    const got = await navigator.credentials.get({ publicKey: {
      challenge: lkRand(32), timeout: 60000, userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: lkUnB64(c.id), transports: ['internal', 'hybrid'] }],
    } });
    // 只看系统有没有验证通过（面容 / 指纹 / 设备密码），不在服务器上验签：这是遮挡屏，不是加密
    if (got) lkHide();
  } catch (e) {
    if (!auto && e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') lkErr(tr('验证没成功', 'Couldn\'t verify'));
  } finally { lk.busy = false; }
}

async function lkTryPin() {
  const inp = lk.layer?.querySelector('.lk-pin'), c = lk.cfg;
  if (!inp) return;
  if (Date.now() < lk.waitUntil) { lkErr(tr(`请 ${Math.ceil((lk.waitUntil - Date.now()) / 1000)} 秒后再试`, `Try again in ${Math.ceil((lk.waitUntil - Date.now()) / 1000)} s`)); return; }
  const pin = inp.value;
  if (pin.length < 4) { inp.focus(); return; }
  if (await lkHash(c.salt, pin) === c.hash) { lk.fails = 0; lkHide(); return; }
  inp.value = '';
  lk.fails++;
  // 连错 5 次之后每次要等 30 秒
  if (lk.fails >= 5) lk.waitUntil = Date.now() + 30000;
  lkErr(tr('密码不对', 'Wrong PIN'));
}

async function lkClick(ev) {
  const t = ev.target;
  if (t.closest('.lk-out')) {
    // 忘了密码 / 面容用不了时的出口：退出登录（数据在云端，重新登录要账号密码），同时关掉应用锁
    if (!await uiConfirm(tr('退出登录？', 'Sign out?'), { ok: tr('退出', 'Sign out'), danger: true, detail: tr('应用锁会关掉', 'App lock will be turned off') })) return;
    lk.save(null); lkHide();
    if (typeof signOut === 'function') signOut();
    return;
  }
  if (t.closest('.lk-pin')) return;
  if (lk.cfg.kind === 'pin') { if (t.closest('.lk-go')) lkTryPin(); else lk.layer.querySelector('.lk-pin')?.focus(); return; }
  // 和手机端一样：点哪里都是解锁
  lkUnlock(false);
}

// 启动时就锁（这时页面还没画内容）
if (lk.cfg.on) lkLock();

// 切到后台：先盖住（App 切换器里看不到账）；离开超过 60 秒回来要重新解锁
document.addEventListener('visibilitychange', () => {
  if (!lk.cfg.on || lk.busy) return;
  if (document.visibilityState === 'hidden') {
    lk.hiddenAt = Date.now();
    if (!lk.locked) lkShow(true);
  } else if (lk.locked) {
    // 已经锁着：不动
  } else if (lk.hiddenAt && Date.now() - lk.hiddenAt > 60000) {
    lkLock();
  } else lkHide();
});

// ---------------------------------------------------------------- 打开 / 关闭（设置页里的开关）

/** 设个 4–6 位数字密码，两次一致才算；取消返回 null。 */
function lkAskPin() {
  return new Promise((done) => {
    const box = document.createElement('div');
    box.className = 'modal ui-confirm lk-setpin';
    let first = null;
    box.innerHTML = `<div class="card grid" role="dialog" aria-modal="true">
        <b style="font-size:17px" class="lk-sp-t"></b>
        <div class="muted small lk-sp-d">${tr('这台设备用不了面容 / 指纹', 'Face ID / Touch ID not available here')}</div>
        <input class="lk-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="new-password" enterkeyhint="done" aria-label="${tr('密码', 'PIN')}">
        <div class="err" aria-live="polite"></div>
        <div class="between"><button class="btn" data-v="0">${tr('取消', 'Cancel')}</button><button class="btn primary" data-v="1"></button></div></div>`;
    const inp = box.querySelector('input');
    // 只换文字、清空输入框，输入框本身不换（焦点和键盘不会丢）
    const paint = (err = '') => {
      box.querySelector('.lk-sp-t').textContent = first == null ? tr('设个 4–6 位数字密码', 'Set a 4–6 digit PIN') : tr('再输一次', 'Enter it again');
      box.querySelector('.lk-sp-d').hidden = first != null;
      box.querySelector('.err').textContent = err;
      box.querySelector('button[data-v="1"]').textContent = first == null ? tr('下一步', 'Next') : tr('确定', 'OK');
      inp.value = ''; inp.focus();
    };
    const close = (v) => { box.remove(); done(v); };
    const next = () => {
      const v = inp.value;
      if (!/^\d{4,6}$/.test(v)) { paint(tr('要 4–6 位数字', 'Use 4–6 digits')); return; }
      if (first == null) { first = v; paint(); return; }
      if (v !== first) { first = null; paint(tr('两次不一样，重新设', 'They don\'t match. Start over.')); return; }
      close(v);
    };
    box.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) { if (b.dataset.v === '1') next(); else close(null); } else if (e.target === box) close(null); });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } else if (e.key === 'Escape') close(null); });
    box.addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
    document.body.appendChild(box);
    paint();
  });
}

async function lkEnable() {
  if (await lkPlatformOk()) {
    try {
      const cred = await navigator.credentials.create({ publicKey: {
        challenge: lkRand(32),
        rp: { name: tr('辉记账本', 'HuiLedger') },
        user: { id: lkRand(16), name: tr('辉记账本', 'HuiLedger'), displayName: tr('辉记账本 应用锁', 'HuiLedger app lock') },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged', requireResidentKey: false },
        timeout: 60000, attestation: 'none',
      } });
      if (cred) { lk.save({ on: true, kind: 'key', id: lkB64(cred.rawId) }); return true; }
    } catch (e) {
      // 用户自己取消了：就不开；别的错误（不支持等）退回到数字密码
      if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') { xsToast(tr('没有开启', 'Not turned on')); return false; }
    }
  }
  if (!window.crypto?.subtle) { xsToast(tr('这个浏览器开不了应用锁', 'App lock isn\'t supported in this browser')); return false; }
  const pin = await lkAskPin();
  if (pin == null) return false;
  const salt = lkB64(lkRand(16));
  lk.save({ on: true, kind: 'pin', salt, hash: await lkHash(salt, pin), len: pin.length });
  return true;
}

/** 设置页里的"应用锁"卡片（设置页模块把它嵌进去）。 */
function lockSettingsHtml() {
  const on = !!lk.cfg.on;
  return `<div class="card hm-list xs-set lk-set">
    <div class="hm-li"><span class="xs-lbl"><span>${tr('应用锁', 'App lock')}</span><small>${tr('用面容、指纹或密码解锁', 'Unlock with Face ID, Touch ID or PIN')}</small></span>${xsSwitch('lk-toggle', on, tr('应用锁', 'App lock'))}</div>
  </div>`;
}

MOD.actions.push(async (act) => {
  if (act !== 'lk-toggle') return false;
  if (lk.cfg.on) { lk.save(null); xsToast(tr('应用锁已关闭', 'App lock off')); }
  else if (await lkEnable()) xsToast(tr('应用锁已开启', 'App lock on'));
  render();
  return true;
});
