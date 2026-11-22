// AI 密钥设置向导：图文分步，教用户在 DeepSeek 或 Claude 开通、复制密钥，粘贴回来验证后保存。
// 从导入页进来的（快捷指令传来账单却没有密钥）：保存后回到导入页，自动开始识别。和手机端 AiKeyGuide.kt 一样。
// 样式在 css/aikey.css。
'use strict';

const AK = { p: 'deepseek', key: '', busy: false, err: '', warn: '', ok: false, from: 'me', shown: false };

/**
 * 等着识别的账单只能用 Claude 吗：已经按 Claude 的方式准备好、PDF 原文件发过去的那种（换成 DeepSeek 要重新读）。
 * 新的账单两家都行：PDF 会先在本机读成文字交给 DeepSeek，截图 deepseek-flash 能看。
 */
function akNeedsClaude() {
  if (typeof IMP === 'undefined') return false;
  return !!IMP.run?.jobs?.some((j) => j.blocks?.some((b) => b?.type === 'document'));
}
/** 有没有一把能用的密钥（PDF、截图要 Claude 的）。 */
const akReady = () => (akNeedsClaude() ? !!aiKey('claude') : !!aiKey());

/** 打开向导。from：保存后回到哪一页（导入页会自动开始识别）。 */
function akOpen(from) {
  Object.assign(AK, { p: akNeedsClaude() ? 'claude' : aiProvider(), key: '', busy: false, err: '', warn: '', ok: false, from: from || state.tab || 'me' });
  if (!aiKey(AK.p) && !akNeedsClaude()) AK.p = 'deepseek';
  state.aiSettings = false; state.aiDraft = null;
  state.tab = 'aikey'; scrollTo(0, 0);
}

// ---------------------------------------------------------------- 示意图：画一个简化的网页，要点的地方闪一圈，旁边一个小标注

const AK_SITES = {
  deepseek: { url: 'platform.deepseek.com', brand: 'DeepSeek 开放平台', side: ['用量信息', 'API Keys', '充值', '账单'], top: '充值', keys: 'API Keys', create: '创建 API key', prefix: 'sk-', amounts: ['¥10', '¥50', '¥100'], pay: '支付宝 / 微信' },
  claude: { url: 'platform.claude.com', brand: 'Claude Console', side: ['Workspaces', 'API keys', 'Billing', 'Usage'], top: 'Billing', keys: 'API keys', create: 'Create key', prefix: 'sk-ant-', amounts: ['$5', '$20', '$100'], pay: 'Visa / Mastercard' },
};
function akFrame(p, inner) {
  return `<div class="ak-shot" aria-hidden="true"><div class="ak-bar"><i></i><i></i><i></i><span>${AK_SITES[p].url}</span></div><div class="ak-page">${inner}</div></div>`;
}
const akHl = (html, tip) => `<span class="ak-hl">${html}${tip ? `<em class="ak-tip">${tip}</em>` : ''}</span>`;
function akSide(p, on) {
  return `<div class="ak-side">${AK_SITES[p].side.map((x) => (x === on ? akHl(`<b>${x}</b>`, '') : `<span>${x}</span>`)).join('')}</div>`;
}
function akShot(p, step) {
  const S = AK_SITES[p];
  if (step === 1) {
    return akFrame(p, `<div class="ak-login"><b class="ak-brand">${S.brand}</b>
      <span class="ak-in">${p === 'deepseek' ? tr('手机号', 'Phone number') : 'Email'}</span><span class="ak-in">${p === 'deepseek' ? tr('验证码', 'Code') : tr('验证码（邮件）', 'Code from email')}</span>
      ${akHl(`<span class="ak-btn">${p === 'deepseek' ? tr('登录 / 注册', 'Log in / Sign up') : 'Continue'}</span>`, tr('注册并登录', 'Sign up'))}</div>`);
  }
  if (step === 2) {
    return akFrame(p, `${akSide(p, S.top)}<div class="ak-main"><b>${p === 'deepseek' ? tr('充值', 'Top up') : 'Buy credits'}</b>
      <div class="ak-chips">${S.amounts.map((a, i) => (i === 0 ? akHl(`<span class="ak-chip">${a}</span>`, tr('选一个金额', 'Pick an amount')) : `<span class="ak-chip">${a}</span>`)).join('')}</div>
      <span class="ak-pay">${S.pay}</span></div>`);
  }
  return akFrame(p, `${akSide(p, S.keys)}<div class="ak-main"><b>${S.keys}</b>
    ${akHl(`<span class="ak-btn">＋ ${S.create}</span>`, '')}
    <div class="ak-keyrow"><code>${S.prefix}••••••••••••</code>${akHl(`<span class="ak-copy">${tr('复制', 'Copy')}</span>`, tr('复制密钥', 'Copy the key'))}</div></div>`);
}

// ---------------------------------------------------------------- 页面

function akSteps(p) {
  const S = AK_SITES[p], open = `<a class="btn ak-open" href="https://${S.url}" target="_blank" rel="noopener">${tr(`打开 ${S.url}`, `Open ${S.url}`)} ↗</a>`;
  const steps = p === 'deepseek' ? [
    [tr('注册并登录 DeepSeek 开放平台', 'Sign up at the DeepSeek platform'), tr('用手机号或微信即可注册。', 'Sign up with a phone number or WeChat.'), open],
    [tr('充值', 'Top up'), tr('点击左侧「充值」，选择金额，用支付宝或微信支付。识别一份账单通常只需几分钱。', 'Tap Top up on the left, pick an amount, pay with Alipay or WeChat. One statement usually costs a few cents.'), ''],
    [tr('创建并复制 API Key', 'Create and copy an API key'), tr('点击左侧「API Keys」→「创建 API key」，名称可填「行星记账」，复制以 sk- 开头的密钥。密钥只显示一次，请立即复制。', 'Tap API Keys → Create API key, name it "Planet Ledger", and copy the key that starts with sk-. It is shown only once.'), ''],
  ] : [
    [tr('注册并登录 Claude Console', 'Sign up at Claude Console'), tr('用邮箱注册。中国大陆地区无法使用 Claude。', 'Sign up with your email. Claude is not available in mainland China.'), open],
    [tr('购买额度', 'Buy credits'), tr('进入「Settings → Billing」，点击「Buy credits」，可选 $5 起，需使用境外信用卡。', 'Go to Settings → Billing → Buy credits, from $5, with an international card.'), ''],
    [tr('创建并复制 API Key', 'Create and copy an API key'), tr('进入「Settings → API keys」，点击「Create key」，复制以 sk-ant- 开头的密钥。密钥只显示一次，请立即复制。', 'Go to Settings → API keys → Create key and copy the key that starts with sk-ant-. It is shown only once.'), ''],
  ];
  return steps.map(([t, d, extra], i) => `<li class="card ak-step"><div class="ak-sh"><i>${i + 1}</i><b>${t}</b></div><p>${d}</p>${akShot(p, i + 1)}${extra}</li>`).join('');
}

function akView() {
  const p = AK.p, S = AK_SITES[p], needClaude = akNeedsClaude();
  const pending = typeof IMP !== 'undefined' && (IMP.incoming || IMP.run) ? (IMP.incoming?.name || tr('账单', 'your statement')) : '';
  const card = (k, title, pros, badge) => `<button class="ak-prov${p === k ? ' on' : ''}" data-act="ak-prov" data-v="${k}" aria-pressed="${p === k}">
    <span class="ak-ph"><b>${title}</b>${badge ? `<em>${badge}</em>` : ''}</span><span class="ak-pros">${pros.map((x) => `<span>${x}</span>`).join('')}</span></button>`;
  const form = AK.ok
    ? `<div class="ak-done">${hmSvg(ICONS.check.d)}<b>${tr('密钥已保存', 'Key saved')}</b><span class="muted">${AK.from === 'import' ? tr('正在返回识别…', 'Back to reading…') : ''}</span></div>`
    : `<label class="f">${tr(`粘贴 ${S.prefix} 开头的密钥`, `Paste the key starting with ${S.prefix}`)}
        <div class="ak-inrow"><input id="ak-key" value="${h(AK.key)}" placeholder="${S.prefix}…" autocomplete="off" autocapitalize="off" spellcheck="false">
        ${navigator.clipboard?.readText ? `<button class="btn" data-act="ak-paste" type="button">${tr('粘贴', 'Paste')}</button>` : ''}</div></label>
      ${AK.err ? `<div class="err">${h(AK.err)}</div>` : ''}${AK.warn ? `<div class="ak-warn">${h(AK.warn)}</div>` : ''}
      <button class="btn primary ak-save" data-act="ak-save" ${AK.busy ? 'disabled' : ''}>${AK.busy ? tr('正在验证…', 'Checking…') : AK.from === 'import' ? tr('验证并开始识别', 'Check and start reading') : tr('验证并保存', 'Check and save')}</button>
      <p class="muted small ak-priv">${tr('密钥仅保存在本设备，识别时直接发送给 AI 服务，不经过其他服务器。', 'The key stays on this device and goes straight to the AI service.')}</p>`;
  return `<div class="subbar"><button class="round" data-act="tab" data-v="${h(AK.from)}" aria-label="${tr('返回', 'Back')}">‹</button><b>${tr('设置 AI 密钥', 'Set up an AI key')}</b></div>
    <div class="grid ak-page">
      <div class="card ak-hero">${iconTile('sparkle')}<div><b>${tr('识别账单需要您自己的 AI 密钥', 'Reading statements needs your own AI key')}</b>
        <span class="muted small">${pending ? tr(`已收到「${h(pending)}」，保存密钥后将自动开始识别。`, `“${h(pending)}” is waiting. Reading starts once the key is saved.`) : tr('费用按实际用量从您的 AI 账户扣除。', 'Usage is billed to your own AI account.')}</span></div></div>
      ${needClaude ? `<div class="ak-warn">${tr('该账单已按 Claude 的方式准备，请继续使用 Claude，或放弃后重新导入。', 'This statement was prepared for Claude. Use Claude, or discard it and import again.')}</div>` : ''}
      <div class="ak-provs">
        ${card('deepseek', 'DeepSeek', [tr('国内可直接开通', 'Easy to open in China'), tr('支付宝 / 微信充值', 'Alipay / WeChat Pay'), tr('支持 PDF、Excel、CSV 与截图', 'PDF, Excel, CSV and screenshots')], needClaude ? '' : tr('推荐', 'Recommended'))}
        ${card('claude', 'Claude', [tr('复杂版式识别更稳定', 'Steadier on complex layouts'), tr('需境外信用卡', 'International card'), tr('中国大陆不可用', 'Not in mainland China')], needClaude ? tr('推荐', 'Recommended') : '')}
      </div>
      <ol class="ak-steps">${akSteps(p)}
        <li class="card ak-step ak-last"><div class="ak-sh"><i>4</i><b>${tr('回到这里粘贴并保存', 'Paste it here')}</b></div>${form}</li></ol>
    </div>`;
}
MOD.pages.aikey = () => akView();

/** 验证：格式对不对，再用它取一次模型列表（能取到就说明密钥有效、有余额）。 */
async function akSave() {
  const p = AK.p, S = AK_SITES[p], key = String(document.getElementById('ak-key')?.value ?? AK.key).trim().replace(/\s+/g, '');
  AK.key = key; AK.err = ''; AK.warn = '';
  if (!key) { AK.err = tr('请先粘贴密钥', 'Paste the key first'); render(); return; }
  if (!key.startsWith(S.prefix) || (p === 'deepseek' && key.startsWith('sk-ant-'))) {
    AK.err = p === 'deepseek' && key.startsWith('sk-ant-') ? tr('这是 Claude 的密钥，请在上方选择 Claude', 'This is a Claude key. Choose Claude above.')
      : tr(`密钥格式不正确，应以 ${S.prefix} 开头，请检查是否完整复制`, `The key should start with ${S.prefix}. Check it was copied in full.`);
    render(); return;
  }
  AK.busy = true; render();
  let saveAnyway = false;
  try {
    const list = await aiFetchModels(p, key);
    store.set(AI_PROVIDERS[p].listK, list);
  } catch (e) {
    const msg = e instanceof AiError ? e.message : '';
    // 连不上（网络问题）：先存下，识别时再看；密钥无效、余额不足：不存，提示改正
    if (/无法连接|Can't reach/.test(msg)) { saveAnyway = true; AK.warn = tr('暂时无法验证密钥（网络问题），已先保存。', "Couldn't check the key right now (network), so it was saved anyway."); }
    else { AK.busy = false; AK.err = msg === tr('余额不足', 'Out of balance') ? tr('余额不足，请先充值（第 2 步）', 'Out of balance. Top up first (step 2).') : msg === tr('密钥无效', 'Invalid key') ? tr('密钥无效，请检查是否完整复制', 'Invalid key. Check it was copied in full.') : (msg || tr('验证失败，请重试', 'Check failed. Try again.')); render(); return; }
  }
  store.set(AI_PROVIDERS[p].keyK, key);
  store.set('hl.aiProvider', p);
  Object.assign(AK, { busy: false, ok: true, key: '' });
  render();
  // 从导入页来的：回去，自动开始（或接着）识别
  setTimeout(() => {
    if (state.tab !== 'aikey') return;
    state.tab = AK.from;
    if (AK.from === 'import' && typeof impAutoStart === 'function') { IMP.autoStarted = false; impAutoStart(); }
    render();
  }, saveAnyway ? 1600 : 900);
}

MOD.actions.push(async (act, v) => {
  switch (act) {
    case 'ak-open': akOpen(v); break;
    case 'ak-prov': if (AK_SITES[v]) { AK.key = String(document.getElementById('ak-key')?.value ?? ''); AK.p = v; AK.err = ''; AK.warn = ''; } break;
    case 'ak-paste':
      try { AK.key = (await navigator.clipboard.readText()).trim(); } catch { AK.err = tr('无法读取剪贴板，请长按输入框粘贴', 'Couldn\'t read the clipboard. Long-press the box to paste.'); }
      break;
    case 'ak-save': await akSave(); return true;
    default: return false;
  }
  render();
  return true;
});
