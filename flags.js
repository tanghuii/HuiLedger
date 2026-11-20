// Q 版国旗：和手机端 ui/FlagArt.kt 一模一样的画法（同样的比例和颜色），画成 4:3 的圆角矩形小贴纸，
// 在哪台设备上都长一个样（不用系统的国旗表情）。flagSvg(code) 返回 HTML；不认得的币种返回 ''。
// 坐标按宽 32、高 24 写：x、y 是占宽高的比例，圆和星星的半径按高度的比例（和 FlagArt 一样）。
'use strict';

const FLAG_C = { RED: '#E5484D', BLUE: '#2F5FD0', NAVY: '#1F3A8A', YELLOW: '#FFD23F', WHITE: '#FDFDFD', GREEN: '#2FA866' };

function flagArt(code) {
  const W = 32, H = 24, f = (n) => +n.toFixed(2), { RED, BLUE, NAVY, YELLOW, WHITE, GREEN } = FLAG_C;
  const fill = (c) => `<rect width="${W}" height="${H}" fill="${c}"/>`;
  const rect = (c, x, y, w, h) => `<rect x="${f(x * W)}" y="${f(y * H)}" width="${f(w * W)}" height="${f(h * H)}" fill="${c}"/>`;
  const dot = (c, x, y, r) => `<circle cx="${f(x * W)}" cy="${f(y * H)}" r="${f(r * H)}" fill="${c}"/>`;
  const bandsH = (cs) => cs.map((c, i) => rect(c, 0, i / cs.length, 1, 1 / cs.length + 0.01)).join('');
  const bandsV = (cs) => cs.map((c, i) => rect(c, i / cs.length, 0, 1 / cs.length + 0.01, 1)).join('');
  const poly = (c, ...p) => `<polygon points="${p.map(([x, y]) => `${f(x * W)},${f(y * H)}`).join(' ')}" fill="${c}"/>`;
  const star = (c, x, y, r, points = 5, rot = 0, inner = points === 5 ? 0.46 : 0.5) => {
    const cx = x * W, cy = y * H, o = r * H, pts = [];
    for (let i = 0; i < points * 2; i++) {
      const a = -Math.PI / 2 + rot * Math.PI / 180 + i * Math.PI / points, rad = i % 2 === 0 ? o : o * inner;
      pts.push(`${f(cx + rad * Math.cos(a))},${f(cy + rad * Math.sin(a))}`);
    }
    return `<polygon points="${pts.join(' ')}" fill="${c}"/>`;
  };
  const nordic = (bg, cross, inner) => fill(bg) + rect(cross, 0.28, 0, 0.2, 1) + rect(cross, 0, 0.37, 1, 0.26)
    + (inner ? rect(inner, 0.33, 0, 0.1, 1) + rect(inner, 0, 0.435, 1, 0.13) : '');
  /** 米字旗，画在给定的那一块里（澳新的旗角也用它）；嵌一个 svg 裁掉伸出去的斜线。 */
  const unionJack = (x, y, rw, rh) => {
    const w = rw * W, h = rh * H, line = (c, x1, y1, x2, y2, sw) => `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${c}" stroke-width="${f(sw)}"/>`;
    return `<svg x="${f(x * W)}" y="${f(y * H)}" width="${f(w)}" height="${f(h)}" viewBox="0 0 ${f(w)} ${f(h)}" overflow="hidden"><rect width="${f(w)}" height="${f(h)}" fill="${NAVY}"/>`
      + line(WHITE, 0, 0, w, h, h * 0.22) + line(WHITE, w, 0, 0, h, h * 0.22) + line(RED, 0, 0, w, h, h * 0.08) + line(RED, w, 0, 0, h, h * 0.08)
      + `<rect x="${f(w * 0.39)}" width="${f(w * 0.22)}" height="${f(h)}" fill="${WHITE}"/><rect y="${f(h * 0.35)}" width="${f(w)}" height="${f(h * 0.3)}" fill="${WHITE}"/>`
      + `<rect x="${f(w * 0.44)}" width="${f(w * 0.12)}" height="${f(h)}" fill="${RED}"/><rect y="${f(h * 0.42)}" width="${f(w)}" height="${f(h * 0.16)}" fill="${RED}"/></svg>`;
  };
  switch (code) {
    case 'EUR': { let s = fill('#1E3FA8'); for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; s += star(YELLOW, 0.5 + 0.31 * Math.sin(a) * H / W, 0.5 - 0.31 * Math.cos(a), 0.072); } return s; }
    case 'CNY': {
      let s = fill(RED) + star(YELLOW, 0.25, 0.34, 0.21);
      for (const [x, y] of [[0.49, 0.13], [0.58, 0.28], [0.58, 0.48], [0.49, 0.63]]) {
        const toward = Math.atan2((0.34 - y) * H, (0.25 - x) * W) * 180 / Math.PI;
        s += star(YELLOW, x, y, 0.075, 5, toward + 90);
      }
      return s;
    }
    case 'USD': {
      let s = fill(WHITE);
      for (let i = 0; i < 13; i += 2) s += rect(RED, 0, i / 13, 1, 1 / 13 + 0.004);
      s += rect('#27408B', 0, 0, 0.46, 7 / 13);
      for (let r = 0; r < 5; r++) { const n = r % 2 === 0 ? 4 : 3; for (let c = 0; c < n; c++) s += star(WHITE, (n === 4 ? 0.065 : 0.12) + c * 0.11, 0.065 + r * 0.102, 0.042); }
      return s;
    }
    case 'GBP': return unionJack(0, 0, 1, 1);
    case 'JPY': return fill(WHITE) + dot(RED, 0.5, 0.5, 0.28);
    case 'HKD': {
      const cx = W / 2, cy = H / 2, pr = 0.31 * H;
      let s = fill(RED);
      for (let i = 0; i < 5; i++) {
        s += `<g transform="rotate(${f(72 * i + 14)} ${cx} ${cy})"><ellipse cx="${f(cx + pr * 0.14)}" cy="${f(cy - pr * 0.51)}" rx="${f(pr * 0.36)}" ry="${f(pr * 0.49)}" fill="${WHITE}"/>`
          + star(RED, (cx + pr * 0.16) / W, (cy - pr * 0.56) / H, 0.035) + '</g>';
      }
      return s + `<circle cx="${cx}" cy="${cy}" r="${f(pr * 0.2)}" fill="${WHITE}"/>`;
    }
    case 'CHF': return fill(RED) + rect(WHITE, 0.41, 0.2, 0.18, 0.6) + rect(WHITE, 0.275, 0.38, 0.45, 0.24);
    case 'SEK': return nordic('#2A6FD6', YELLOW, null);
    case 'DKK': return nordic(RED, WHITE, null);
    case 'NOK': return nordic(RED, WHITE, NAVY);
    case 'ISK': return nordic(BLUE, WHITE, RED);
    case 'PLN': return fill(WHITE) + rect(RED, 0, 0.5, 1, 0.5);
    case 'CZK': return fill(WHITE) + rect(RED, 0, 0.5, 1, 0.5) + poly(BLUE, [0, 0], [0.48, 0.5], [0, 1]);
    case 'HUF': return bandsH([RED, WHITE, GREEN]);
    case 'RON': return bandsV([BLUE, YELLOW, RED]);
    case 'TRY': return fill(RED) + dot(WHITE, 0.37, 0.5, 0.27) + dot(RED, 0.37 + 0.065 * H / W, 0.5, 0.215) + star(WHITE, 0.63, 0.5, 0.13, 5, -90);
    case 'AUD': return fill(NAVY) + unionJack(0, 0, 0.5, 0.5) + star(WHITE, 0.25, 0.76, 0.15, 7)
      + [[0.75, 0.83], [0.62, 0.44], [0.75, 0.17], [0.87, 0.37]].map(([x, y]) => star(WHITE, x, y, 0.085, 7)).join('') + star(WHITE, 0.81, 0.56, 0.05);
    case 'NZD': return fill(NAVY) + unionJack(0, 0, 0.5, 0.5)
      + [[0.75, 0.2, 0.09], [0.75, 0.8, 0.1], [0.63, 0.47, 0.09], [0.87, 0.4, 0.08]].map(([x, y, r]) => star(WHITE, x, y, r + 0.03) + star(RED, x, y, r)).join('');
    case 'CAD': {
      const half = [[0, -0.38], [0.07, -0.25], [0.15, -0.29], [0.12, -0.08], [0.24, -0.18], [0.27, -0.11], [0.36, -0.13], [0.31, 0], [0.36, 0.03], [0.18, 0.17], [0.20, 0.24], [0.03, 0.21], [0.03, 0.38]];
      const pts = [...half, ...[...half].reverse().map(([x, y]) => [-x, y])].map(([x, y]) => `${f(W / 2 + x * H)},${f(H / 2 + y * H)}`).join(' ');
      return fill(WHITE) + rect(RED, 0, 0, 0.25, 1) + rect(RED, 0.75, 0, 0.25, 1) + `<polygon points="${pts}" fill="${RED}"/>`;
    }
    case 'SGD': {
      let s = fill(WHITE) + rect(RED, 0, 0, 1, 0.5) + dot(WHITE, 0.2, 0.25, 0.18) + dot(RED, 0.2 + 0.055 * H / W, 0.25, 0.155);
      for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / 5; s += star(WHITE, 0.36 + 0.085 * Math.cos(a) * H / W, 0.255 + 0.085 * Math.sin(a), 0.036); }
      return s;
    }
    case 'KRW': {
      const cx = W / 2, cy = H / 2, r = 0.25 * H, blue = '#1F4FA8', black = '#222222';
      let s = fill(WHITE) + `<g transform="rotate(33.7 ${cx} ${cy})"><circle cx="${cx}" cy="${cy}" r="${f(r)}" fill="${RED}"/>`
        + `<path d="M${f(cx - r)},${cy} A${f(r)},${f(r)} 0 0 0 ${f(cx + r)},${cy} Z" fill="${blue}"/>`
        + `<circle cx="${f(cx - r / 2)}" cy="${cy}" r="${f(r / 2)}" fill="${RED}"/><circle cx="${f(cx + r / 2)}" cy="${cy}" r="${f(r / 2)}" fill="${blue}"/></g>`;
      const trig = [[[0.2, 0.22], 33.7 - 90, [1, 1, 1]], [[0.8, 0.78], 33.7 - 90, [0, 0, 0]], [[0.8, 0.22], 90 - 33.7, [0, 1, 0]], [[0.2, 0.78], 90 - 33.7, [1, 0, 1]]];
      for (const [[px, py], deg, bars] of trig) {
        const x = px * W, y0 = py * H, bw = 0.22 * H, bt = 0.04 * H, gap = 0.028 * H;
        s += `<g transform="rotate(${f(deg)} ${f(x)} ${f(y0)})" fill="${black}">`;
        bars.forEach((solid, i) => {
          const y = y0 + (i - 1) * (bt + gap) - bt / 2;
          s += solid ? `<rect x="${f(x - bw / 2)}" y="${f(y)}" width="${f(bw)}" height="${f(bt)}"/>`
            : `<rect x="${f(x - bw / 2)}" y="${f(y)}" width="${f(bw * 0.44)}" height="${f(bt)}"/><rect x="${f(x + bw * 0.06)}" y="${f(y)}" width="${f(bw * 0.44)}" height="${f(bt)}"/>`;
        });
        s += '</g>';
      }
      return s;
    }
    case 'THB': return fill(RED) + rect(WHITE, 0, 1 / 6, 1, 4 / 6) + rect(NAVY, 0, 2 / 6, 1, 2 / 6);
    case 'MYR': {
      let s = fill(WHITE);
      for (let i = 0; i < 14; i += 2) s += rect(RED, 0, i / 14, 1, 1 / 14 + 0.004);
      return s + rect(NAVY, 0, 0, 0.5, 8 / 14) + dot(YELLOW, 0.19, 0.285, 0.19) + dot(NAVY, 0.19 + 0.05 * H / W, 0.285, 0.165) + star(YELLOW, 0.36, 0.285, 0.105, 14, 0, 0.45);
    }
    case 'INR': {
      const cx = W / 2, cy = H / 2, r = 0.145 * H;
      let s = bandsH(['#FF9933', WHITE, GREEN]) + `<circle cx="${cx}" cy="${cy}" r="${f(r)}" fill="none" stroke="${NAVY}" stroke-width="${f(0.03 * H)}"/>`;
      for (let i = 0; i < 12; i++) { const a = i * Math.PI / 12, dx = r * Math.cos(a), dy = r * Math.sin(a); s += `<line x1="${f(cx - dx)}" y1="${f(cy - dy)}" x2="${f(cx + dx)}" y2="${f(cy + dy)}" stroke="${NAVY}" stroke-width="${f(0.012 * H)}"/>`; }
      return s + `<circle cx="${cx}" cy="${cy}" r="${f(0.03 * H)}" fill="${NAVY}"/>`;
    }
    default: return '';
  }
}

const FLAG_CACHE = new Map();
/** 一面圆角矩形的小国旗（高 1em，宽 4/3em，跟着所在位置的字号变大变小）；左上一抹高光、一圈白边，和手机端 FlagBadge 一样。 */
function flagSvg(code) {
  if (!FLAG_CACHE.has(code)) {
    const art = flagArt(code);
    FLAG_CACHE.set(code, art ? `<span class="flg" aria-hidden="true"><svg viewBox="0 0 32 24" preserveAspectRatio="none">${art}</svg></span>` : '');
  }
  return FLAG_CACHE.get(code);
}
