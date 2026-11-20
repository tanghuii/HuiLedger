// 小插画（和手机端 EmptyArt.kt、HomeScreen.kt 的 CoinFace 同一套画法）：空页面的小图、应用锁的锁、汇总卡片上的金币脸。
// 颜色用 CSS 变量，换主题、深浅色都跟着变。样式在 css/tags.css。
'use strict';

/** 画布按 100×100 算；手机端 128dp 的画上 1dp ≈ 0.78。 */
const EA_DP = 100 / 128;
const EA_AMBER = '#F5B83D', EA_BLUSH = '#FF8FA3';
const eaF = (n) => +n.toFixed(2);
/** 主题色按透明度：primary 0.55 → color-mix(… 55%, transparent) */
const eaC = (a) => `color-mix(in srgb, var(--primary) ${Math.round(a * 100)}%, transparent)`;
/** 两个颜色混：t 是往"纸"那边走多少（同 Compose 的 lerp）。 */
const eaLerp = (c, t) => `color-mix(in srgb, ${c} ${Math.round((1 - t) * 100)}%, var(--ea-paper))`;

/** 四角的小星星。 */
function eaSparkle(x, y, r, color) {
  const k = r * 0.28, p = (a, b) => `${eaF(a)},${eaF(b)}`;
  return `<path style="fill:${color}" d="M${p(x, y - r)} Q${p(x + k, y - k)} ${p(x + r, y)} Q${p(x + k, y + k)} ${p(x, y + r)} Q${p(x - k, y + k)} ${p(x - r, y)} Q${p(x - k, y - k)} ${p(x, y - r)}Z"/>`;
}
const eaCircle = (cx, cy, r, fill) => `<circle cx="${eaF(cx)}" cy="${eaF(cy)}" r="${eaF(r)}" style="fill:${fill}"/>`;
const eaLine = (x1, y1, x2, y2, color, dp) => `<line x1="${eaF(x1)}" y1="${eaF(y1)}" x2="${eaF(x2)}" y2="${eaF(y2)}" style="stroke:${color};stroke-width:${eaF(dp * EA_DP)};stroke-linecap:round"/>`;

/** 笑脸：两只眼睛、一张嘴、两团腮红。 */
function eaFace(x, y) {
  const w = 100, e = w * 0.02, rx = w * 0.045, ry = w * 0.035, cy = y + w * 0.005 + ry;
  const a0 = 20 * Math.PI / 180, a1 = 160 * Math.PI / 180;
  return eaCircle(x - 7, y, e, 'var(--text)') + eaCircle(x + 7, y, e, 'var(--text)')
    + eaCircle(x - 12, y + 4.5, 3.5, `color-mix(in srgb, ${EA_BLUSH} 35%, transparent)`) + eaCircle(x + 12, y + 4.5, 3.5, `color-mix(in srgb, ${EA_BLUSH} 35%, transparent)`)
    + `<path d="M${eaF(x + rx * Math.cos(a0))} ${eaF(cy + ry * Math.sin(a0))}A${rx} ${ry} 0 0 1 ${eaF(x + rx * Math.cos(a1))} ${eaF(cy + ry * Math.sin(a1))}" style="fill:none;stroke:var(--text);stroke-width:${eaF(2 * EA_DP)};stroke-linecap:round"/>`;
}

function eaArt(kind) {
  // 地上一小片影子
  let s = `<ellipse cx="50" cy="90" rx="28" ry="4" style="fill:${eaC(0.10)}"/>`;
  if (kind === 'search') {
    // 一只放大镜，镜片里一张有点迷茫的脸
    s += eaLine(60, 57, 76, 73, eaC(0.75), 9)
      + eaCircle(45, 42, 21, 'var(--ea-paper)') + eaCircle(45, 42, 21, eaC(0.10))
      + `<circle cx="45" cy="42" r="21" style="fill:none;stroke:${eaC(0.75)};stroke-width:${eaF(5 * EA_DP)}"/>`
      + eaCircle(39, 41, 1.8, 'var(--text)') + eaCircle(51, 41, 1.8, 'var(--text)')
      + eaLine(41.5, 49, 48.5, 48.5, 'var(--text)', 2)
      + eaSparkle(80, 20, 4.5, EA_AMBER) + eaSparkle(18, 70, 3, eaC(0.6));
  } else if (kind === 'piggy') {
    // 一只小猪存钱罐，头顶掉下一枚硬币
    s += eaCircle(50, 15, 6.5, EA_AMBER) + `<circle cx="50" cy="15" r="3.5" style="fill:none;stroke:rgba(255,255,255,.55);stroke-width:${eaF(2 * EA_DP)}"/>`
      + `<ellipse cx="50" cy="53" rx="30" ry="23" style="fill:${eaLerp('var(--primary)', 0.78)};stroke:${eaC(0.6)};stroke-width:${eaF(2 * EA_DP)}"/>`
      // 耳朵、鼻子、腿、投币口
      + `<path d="M34 34L38 24L45 31Z" style="fill:${eaLerp('var(--primary)', 0.6)}"/>`
      + `<ellipse cx="78.5" cy="52" rx="6.5" ry="6" style="fill:${eaLerp(EA_BLUSH, 0.35)}"/>`
      + eaCircle(76.5, 52, 1, 'var(--text)') + eaCircle(80.5, 52, 1, 'var(--text)')
      + eaCircle(62, 44, 1.8, 'var(--text)')
      + eaCircle(62, 53, 3.5, `color-mix(in srgb, ${EA_BLUSH} 35%, transparent)`)
      + eaLine(44, 31.5, 56, 31.5, eaC(0.7), 3)
      + eaLine(32, 74, 32, 83, eaC(0.55), 6) + eaLine(62, 74, 62, 83, eaC(0.55), 6)
      + eaSparkle(18, 20, 4, eaC(0.6));
  } else {
    // 一张底边带锯齿的小票，上面几行字，下面一张笑脸
    const step = 44 / 6;
    let d = 'M28 12L72 12L72 80';
    for (let i = 0; i < 6; i++) d += `L${eaF(72 - step * (i + 0.5))} 76L${eaF(72 - step * (i + 1))} 80`;
    s += `<path d="${d}Z" style="fill:var(--ea-paper);stroke:${eaC(0.55)};stroke-width:${eaF(2 * EA_DP)};stroke-linejoin:round"/>`
      + [[26, 0.58], [34, 0.50], [42, 0.40]].map(([y, len]) => eaLine(36, y, 36 + len * 50, y, eaC(0.35), 3)).join('')
      + eaFace(50, 60)
      + eaSparkle(17, 24, 5, EA_AMBER) + eaSparkle(84, 36, 4, eaC(0.7)) + eaSparkle(80, 14, 2.5, `color-mix(in srgb, ${EA_AMBER} 80%, transparent)`);
  }
  return s;
}

/**
 * 空页面：一张小插画加一句话，居中。kind：'receipt' 没有账单，'search' 没找到，'piggy' 借款 / 报销这类钱的往来。
 * text 是纯文字（这里会转义）。
 */
function emptyState(kind, text, size = 128) {
  return `<div class="ea-empty"><svg class="ea-art" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">${eaArt(kind)}</svg>${text ? `<div class="ea-text">${h(text)}</div>` : ''}</div>`;
}

/** 应用锁上的那把锁：淡主题色的圆里一把主题色的锁（84px 的圆，40px 的锁）。 */
function lockArt() {
  return `<div class="ea-lock" aria-hidden="true"><svg viewBox="0 0 100 100" width="40" height="40">
    <path d="M28 35A22 23 0 0 1 72 35" style="fill:none;stroke:var(--primary);stroke-width:9;stroke-linecap:round"/>
    <line x1="28" y1="35" x2="28" y2="45" style="stroke:var(--primary);stroke-width:9;stroke-linecap:round"/><line x1="72" y1="35" x2="72" y2="45" style="stroke:var(--primary);stroke-width:9;stroke-linecap:round"/>
    <rect x="18" y="45" width="64" height="46" rx="10" style="fill:var(--primary)"/><circle cx="50" cy="66" r="6" fill="#fff"/></svg></div>`;
}

/** 汇总卡片上的小金币：结余为正就笑，为负就撇嘴（CoinFace，默认 58px）。 */
function coinFace(happy, size = 58) {
  const ink = '#2B2140';
  return `<svg class="coin-face" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true"><circle cx="54" cy="54" r="46" fill="${ink}"/>
    <circle cx="48" cy="48" r="44" fill="#FFD34D" stroke="${ink}" stroke-width="5"/><circle cx="48" cy="48" r="30" fill="none" stroke="#FFE89A" stroke-width="3"/>
    <circle cx="35" cy="42" r="4.5" fill="${ink}"/><circle cx="61" cy="42" r="4.5" fill="${ink}"/><circle cx="27" cy="54" r="5" fill="#FF8FA8"/><circle cx="69" cy="54" r="5" fill="#FF8FA8"/>
    <path d="${happy ? 'M59.28 53.42A12 10 0 0 1 36.72 53.42' : 'M36.72 62.58A12 10 0 0 1 59.28 62.58'}" fill="none" stroke="${ink}" stroke-width="5" stroke-linecap="round"/></svg>`;
}
