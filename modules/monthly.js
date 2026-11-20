// 月度账单：和手机端 MonthlyBillScreen 一样——选一个月，生成一张账单图（结余、收支、支出构成），
// 可以分享图片、存成图片，或者导出这个月的表格。图用 canvas 画（宽 360，按 3 倍画成 1080 像素），预览就是这张图。
'use strict';

const MB = { key: '', url: '', busy: false, canvas: null };

/** 这个月（state.month、当前账本）的数：收支、支出按一级分类从大到小，超过 6 类的并成"其他"。 */
function mbNumbers() {
  const L = computeLookup(), txs = monthTxs(), t = L.totals(txs);
  const by = new Map();
  for (const x of txs) if (x.kind === KIND.EXPENSE && L.counts(x)) { const top = L.top(x.categoryId), k = top?.id ?? -1; if (!by.has(k)) by.set(k, { top, cents: 0 }); by.get(k).cents += L.net(x); }
  const sums = [...by.values()].filter((r) => r.cents > 0).sort((a, b) => b.cents - a.cents);
  const total = Math.max(1, sums.reduce((s, r) => s + r.cents, 0));
  const head = sums.slice(0, sums.length > 6 ? 5 : 6).map((r) => ({ icon: r.top?.icon ?? 'more', name: catName(r.top) ?? tr('其他', 'Other'), cents: r.cents, share: r.cents / total }));
  const rest = sums.slice(head.length).reduce((s, r) => s + r.cents, 0);
  if (rest > 0) head.push({ icon: 'more', name: tr('其他', 'Other'), cents: rest, share: rest / total });
  return { txs, income: t.income, expense: t.expense, rows: head, days: new Set(txs.map((x) => x.date)).size };
}

/** 星球的 SVG 画进 canvas：SVG 的环会伸出 viewBox，先把 viewBox 放大 1.6 倍再画。 */
function mbPlanetImage(p, mood) {
  const k = 1.6;
  let svg = planetSvg(p, { px: 100, mood, spin: false });
  svg = svg.replace(/viewBox="([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)"/, (_, x, y, w, hh) => `viewBox="${x * k} ${y * k} ${w * k} ${hh * k}"`)
    .replace('width="100" height="100"', `width="${100 * k}" height="${100 * k}"`)
    .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  return new Promise((done) => {
    const img = new Image(), url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => { URL.revokeObjectURL(url); done(img); };
    img.onerror = () => { URL.revokeObjectURL(url); done(null); };
    img.src = url;
  });
}

/** 画账单图，返回 canvas。 */
async function mbDraw(n) {
  const { y, m } = state.month, W = 360, S = 3, P = 18, FONT = '-apple-system, "PingFang SC", "Helvetica Neue", "Segoe UI", Roboto, sans-serif';
  const rows = n.rows, boxH = 16 + 18 + 12 + (rows.length ? rows.length * 42 - 12 : 18) + 16;
  const cardY = 52, cardH = 194, boxY = cardY + cardH + 12, footY = boxY + boxH + 12, H = footY + 18 + P;
  const c = document.createElement('canvas');
  c.width = W * S; c.height = H * S;
  const g = c.getContext('2d');
  g.scale(S, S);
  const font = (px, w = 400) => { g.font = `${w} ${px}px ${FONT}`; };
  const text = (s, x, yy, color, align = 'left') => { g.fillStyle = color; g.textAlign = align; g.fillText(s, x, yy); };
  const rr = (x, yy, w, hh, r) => { g.beginPath(); g.roundRect ? g.roundRect(x, yy, w, hh, r) : g.rect(x, yy, w, hh); };
  const sparkle = (x, yy, r, color) => {
    const k = r * 0.28; g.beginPath(); g.moveTo(x, yy - r);
    g.quadraticCurveTo(x + k, yy - k, x + r, yy); g.quadraticCurveTo(x + k, yy + k, x, yy + r);
    g.quadraticCurveTo(x - k, yy + k, x - r, yy); g.quadraticCurveTo(x - k, yy - k, x, yy - r); g.fillStyle = color; g.fill();
  };
  const soft = 'rgba(255,255,255,.72)';
  // 深色星空底 + 几颗固定位置的小星
  const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#17123A'); bg.addColorStop(0.5, '#261E5E'); bg.addColorStop(1, '#33287A');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  [[0.08, 0.05], [0.9, 0.03], [0.72, 0.12], [0.15, 0.42], [0.94, 0.5], [0.05, 0.78], [0.86, 0.9], [0.4, 0.97]]
    .forEach(([sx, sy], i) => sparkle(W * sx, H * sy, i % 3 === 0 ? 4 : 2.6, `rgba(255,255,255,${i % 2 === 0 ? 0.55 : 0.32})`));

  const planet = typeof plOfMonth === 'function' ? plOfMonth(y, m) : PLANETS_NINE[0];
  const happy = n.income >= n.expense;
  const [brand, pimg] = await Promise.all([mbPlanetImage(PLANET_BRAND, 1), mbPlanetImage(planet, happy ? 1 : -1)]);
  // 顶上一行：品牌星 + 行星记账，右边"月度账单"
  if (brand) g.drawImage(brand, P - 6.6, P - 6.6, 22 * 1.6, 22 * 1.6);
  font(13, 600); text(tr('行星记账', 'Planet Ledger'), P + 30, P + 16, soft);
  font(13); text(tr('月度账单', 'Monthly bill'), W - P, P + 16, soft, 'right');

  // 主题色卡片
  const cx = P, cw = W - 2 * P, accent = '#6C5CE7';
  g.save(); rr(cx, cardY, cw, cardH, 24); g.clip();
  const cg = g.createLinearGradient(cx, cardY, cx + cw, cardY + cardH); cg.addColorStop(0, '#897DEC'); cg.addColorStop(0.5, accent); cg.addColorStop(1, '#493E9D');
  g.fillStyle = cg; g.fillRect(cx, cardY, cw, cardH);
  const sheen = g.createLinearGradient(0, cardY, 0, cardY + cardH * 0.45); sheen.addColorStop(0, 'rgba(255,255,255,.14)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sheen; g.fillRect(cx, cardY, cw, cardH);
  // 卡片右上角一道淡淡的星环，环上一颗小星
  const ox = cx + cw * 0.98, oy = cardY + cardH * 0.02, orx = cw * 0.5, ory = orx * 0.3, tilt = -16 * Math.PI / 180;
  g.save(); g.translate(ox, oy); g.rotate(tilt);
  g.beginPath(); g.ellipse(0, 0, orx, ory, 0, 0, Math.PI * 2); g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 2.5; g.stroke();
  const a = 2.3, sx = orx * Math.cos(a), sy = ory * Math.sin(a);
  g.restore();
  const px = ox + sx * Math.cos(tilt) - sy * Math.sin(tilt), py = oy + sx * Math.sin(tilt) + sy * Math.cos(tilt);
  const glow = g.createRadialGradient(px, py, 0, px, py, 11); glow.addColorStop(0, 'rgba(255,255,255,.35)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = glow; g.fillRect(px - 11, py - 11, 22, 22); sparkle(px, py, 6, 'rgba(255,255,255,.92)');
  g.restore();
  const onSoft = 'rgba(255,255,255,.75)';
  font(22, 700); text(ymLabel(y, m), cx + 18, cardY + 40, '#fff');
  font(12); text(typeof plMonthName === 'function' ? plMonthName(planet) : '', cx + 18, cardY + 58, onSoft);
  if (pimg) g.drawImage(pimg, cx + cw - 18 - 60 - 18, cardY + 12 - 18, 96, 96);
  font(13); text(tr('本月结余', 'Net this month'), cx + 18, cardY + 92, onSoft);
  font(32, 700); text(money(n.income - n.expense), cx + 18, cardY + 130, '#fff');
  font(12); text(tr('支出', 'Expense'), cx + 18, cardY + 154, onSoft); text(tr('收入', 'Income'), cx + cw - 18, cardY + 154, onSoft, 'right');
  font(18, 600); text(money(n.expense), cx + 18, cardY + 177, '#FFD0D0'); text(money(n.income), cx + cw - 18, cardY + 177, '#C9FFE3', 'right');

  // 支出构成
  rr(cx, boxY, cw, boxH, 22); g.fillStyle = 'rgba(255,255,255,.08)'; g.fill(); g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 1; g.stroke();
  font(14, 600); text(tr('支出构成', 'Where it went'), cx + 16, boxY + 16 + 14, '#fff');
  if (!rows.length) { font(13); text(tr('这个月没有支出', 'No spending this month'), cx + 16, boxY + 16 + 18 + 12 + 14, soft); }
  const mix = (hex, t) => { const v = parseInt(hex.slice(1), 16), ch = [v >> 16, (v >> 8) & 255, v & 255].map((q) => Math.round(q + (255 - q) * t)); return `rgb(${ch.join(',')})`; };
  rows.forEach((r, i) => {
    const ry = boxY + 16 + 18 + 12 + i * 42, ix = cx + 16, color = ICONS[r.icon]?.c ?? '#8793A6';
    const tg = g.createLinearGradient(ix, ry, ix + 30, ry + 30); tg.addColorStop(0, mix(color, 0.28)); tg.addColorStop(1, color);
    rr(ix, ry, 30, 30, 10); g.fillStyle = tg; g.fill();
    g.save(); g.translate(ix + 6, ry + 6); g.scale(0.75, 0.75);
    g.strokeStyle = '#fff'; g.lineWidth = 1.8; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke(new Path2D(ICONS[r.icon]?.d ?? ICONS.more.d)); g.restore();
    const tx = ix + 40, right = cx + cw - 16;
    font(14, 600); const amt = money(r.cents); text(amt, right, ry + 14, '#fff', 'right');
    const aw = g.measureText(amt).width;
    font(12); const pct = Math.round(r.share * 100) + '%'; text(pct, right - aw - 8, ry + 14, soft, 'right');
    const pw = g.measureText(pct).width;
    font(14); let name = r.name; const room = right - aw - 8 - pw - 8 - tx;
    while (name.length > 1 && g.measureText(name).width > room) name = name.slice(0, -2) + '…';
    text(name, tx, ry + 14, '#fff');
    const bw = right - tx;
    rr(tx, ry + 22, bw, 5, 2.5); g.fillStyle = 'rgba(255,255,255,.12)'; g.fill();
    rr(tx, ry + 22, Math.max(5, bw * Math.min(1, Math.max(0.02, r.share))), 5, 2.5); g.fillStyle = mix(color, 0.2); g.fill();
  });

  font(12); text(tr(`共 ${n.txs.length} 笔 · 记账 ${n.days} 天`, `${n.txs.length} entries · ${n.days} days`), cx, footY + 14, soft);
  font(11); text('planet.tanghui.app', W - P, footY + 14, 'rgba(255,255,255,.45)', 'right');
  return c;
}

/** 这个月的数一变（或换了月份、语言）就重画预览。画好后只换掉图片，不重画整页。 */
async function mbRefresh() {
  const n = mbNumbers(), { y, m } = state.month;
  const key = [y, m, state.ledgerId, LANG, HOME, n.txs.length, n.income, n.expense, n.rows.map((r) => r.cents).join('.')].join('|');
  if (key === MB.key && MB.canvas) return;
  MB.key = key;
  const c = await mbDraw(n);
  if (MB.key !== key) return;
  MB.canvas = c; MB.url = c.toDataURL('image/png');
  const img = document.querySelector('.mb-img');
  if (img) img.src = MB.url;
}

const mbName = (ext) => { const { y, m } = state.month; return `${tr('行星记账', 'PlanetLedger')}-${y}-${String(m).padStart(2, '0')}.${ext}`; };

/** 分享图片：手机上用系统分享面板；电脑上（不支持分享文件）就下载。save = true 时直接下载（iPhone 主屏幕 App 里下载没反应，还是走分享面板）。 */
async function mbShare(save) {
  if (!MB.canvas || MB.busy) return;
  MB.busy = true;
  try {
    const blob = await new Promise((done) => MB.canvas.toBlob(done, 'image/png'));
    const file = typeof File === 'function' ? new File([blob], mbName('png'), { type: 'image/png' }) : null;
    if ((!save || IS_IOS) && file && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] }).catch(() => { /* 用户取消了 */ });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = mbName('png');
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  } finally { MB.busy = false; }
}

function monthlyView() {
  setTimeout(mbRefresh, 0);
  const has = monthTxs().length > 0;
  return `<div class="grid mb-page">
    ${monthBar()}
    <div class="mb-frame"><img class="mb-img" alt="${tr('月度账单', 'Monthly bill')}" src="${MB.url}"></div>
    <button class="btn primary mb-share" data-act="mb-share">${hmSvg(ICONS.share.d)}<span>${tr('分享图片', 'Share image')}</span></button>
    <div class="mb-row"><button class="btn" data-act="mb-save">${tr('保存图片', 'Save image')}</button><button class="btn" data-act="mb-csv" ${has ? '' : 'disabled'}>${tr('导出表格', 'Export CSV')}</button></div>
  </div>`;
}

MOD.pages.monthly = () => monthlyView();
MOD.me.push({ key: 'monthly', get name() { return tr('月度账单', 'Monthly bill'); }, icon: 'receipt', order: 12 });
MOD.actions.push(async (act) => {
  if (act === 'mb-share') { await mbShare(false); return true; }
  if (act === 'mb-save') { await mbShare(true); return true; }
  if (act === 'mb-csv') { exportCsv(monthTxs(), mbName('csv')); return true; }
  return false;
});
