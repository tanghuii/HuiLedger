// 支出心情（和手机端 ui/Mood.kt 一样）：买完之后的感受。账单上存 score：1–100 分（没有 = 没打分），
// 另外写一个 mood：对应的 1–5 档，给 3.8.0 的旧版本读。以前只有 mood（1–5）的账单按 ×20 当分数。
// 用户选按五星打还是按百分制打（共享设置 moodScale："star" / "percent"）。
// 五档各一颗带表情的行星——很后悔（海王星撇嘴）、有点后悔（天王星撇嘴）、一般（水星平嘴）、开心（地球笑）、超开心（金星笑）。
'use strict';

const MOODS = [
  { level: 1, zh: '很后悔', en: 'Big regret', planet: 'neptune', face: -1, color: '#5B7BF5' },
  { level: 2, zh: '有点后悔', en: 'Some regret', planet: 'uranus', face: -1, color: '#1FB5A8' },
  { level: 3, zh: '一般', en: 'Okay', planet: 'mercury', face: 0, color: '#8793A6' },
  { level: 4, zh: '开心', en: 'Happy', planet: 'earth', face: 1, color: '#3DBA6F' },
  { level: 5, zh: '超开心', en: 'Delighted', planet: 'venus', face: 1, color: '#F2B01E' },
];
/** 账单的分数（1–100，0 = 没打分）。 */
const txScore = (t) => { const s = Number(t?.score); if (s > 0) return Math.min(100, Math.round(s)); const m = Number(t?.mood); return m > 0 ? Math.min(5, m) * 20 : 0; };
const moodLevel = (s) => (s > 0 ? Math.min(5, Math.max(1, Math.floor((s + 19) / 20))) : 0);
const moodOf = (s) => MOODS.find((m) => m.level === moodLevel(s)) ?? null;
const moodLabel = (s) => { const m = moodOf(s); return m ? tr(m.zh, m.en) : ''; };
const moodPercent = () => (typeof shared !== 'undefined' ? shared.get('moodScale', 'star') : 'star') === 'percent';
/** 显示用：五星是"★4"，百分制是"85 分"。 */
const moodText = (s) => (s > 0 ? (moodPercent() ? tr(`${s} 分`, `${s}`) : `★${moodLevel(s)}`) : '');
/** 一颗心情行星（按分数落在的那一档）。 */
const moodPlanet = (s, px = 24, cls = '') => { const m = moodOf(s); return m && typeof planetSvg === 'function' ? planetSvg(m.planet, { px, mood: m.face, spin: false, cls: 'mood-pl ' + cls }) : ''; };
/** 存进账单：score + 旧版本读的 mood；0 = 去掉。 */
function moodPut(rec, s) {
  if (s > 0) { rec.score = Math.min(100, Math.round(s)); rec.mood = moodLevel(rec.score); } else { delete rec.score; delete rec.mood; }
  return rec;
}
/** 账单列表里的小标记：行星 + "★4" / "85"。 */
const moodBadge = (s) => { const m = moodOf(s); return m ? `<span class="mood-badge" style="color:${m.color}">${moodPlanet(s, 15)}${moodPercent() ? s : '★' + m.level}</span>` : ''; };

const MOOD_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.85 6.05 6.6.8-4.87 4.56 1.27 6.55L12 17.3l-5.85 3.26 1.27-6.55L2.55 9.45l6.6-.8z"/></svg>';
/**
 * 打分：五星（点第几颗就是几星，再点同一颗取消）或者百分制（拖动，拖到 0 是取消）。
 * where：'tx' = 直接存进账单 id；'ed' = 记一笔页（先放在 state.editing._score，保存时一起存）。
 */
function moodRater(s, where, id = '') {
  const m = moodOf(s);
  const pl = m ? moodPlanet(s, 30) : typeof plNowPlanet === 'function' ? plNowPlanet(30, 0, 'mood-pl') : '';
  if (moodPercent()) {
    return `<div class="mood-rate"><span class="mood-rate-pl">${pl}</span>
      <input type="range" class="mood-range" min="0" max="100" step="5" value="${s}" data-mood-where="${where}" data-mood-id="${id}" aria-label="${tr('打分', 'Score')}">
      <b class="mood-rate-lb num" style="color:${m?.color ?? 'var(--muted)'}">${s > 0 ? tr(`${s} 分`, `${s}`) : tr('未打分', '—')}</b></div>`;
  }
  const lv = moodLevel(s);
  const attrs = (i) => (where === 'ed' ? `data-act="ed-set" data-k="_score" data-v="${lv === i ? 0 : i * 20}"` : `data-act="mood-set" data-v="${id}:${lv === i ? 0 : i * 20}"`);
  return `<div class="mood-rate"><span class="mood-rate-pl">${pl}</span>
    <div class="mood-stars">${[1, 2, 3, 4, 5].map((i) => `<button class="${i <= lv ? 'on' : ''}" ${attrs(i)} aria-label="${i}★">${MOOD_STAR}</button>`).join('')}</div>
    <span class="mood-rate-lb" style="color:${m?.color ?? 'var(--muted)'}">${m ? h(tr(m.zh, m.en)) : tr('点击星星打分', 'Tap a star')}</span></div>`;
}
// 百分制拖动时：数字和行星跟着变（不重画整页）；松手才存
document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (!el.classList?.contains('mood-range')) return;
  const s = Number(el.value), box = el.closest('.mood-rate'), m = moodOf(s), lb = box?.querySelector('.mood-rate-lb');
  if (lb) { lb.textContent = s > 0 ? tr(`${s} 分`, `${s}`) : tr('未打分', '—'); lb.style.color = m?.color ?? 'var(--muted)'; }
  const pl = box?.querySelector('.mood-rate-pl');
  if (pl) pl.innerHTML = m ? moodPlanet(s, 30) : typeof plNowPlanet === 'function' ? plNowPlanet(30, 0, 'mood-pl') : '';
});
document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (!el.classList?.contains('mood-range')) return;
  const s = Number(el.value);
  if (el.dataset.moodWhere === 'ed') { if (state.editing) state.editing._score = s; return; }
  try { await moodSave(Number(el.dataset.moodId), s); } catch (e) { state.error = e.message; }
  render();
});

async function moodSave(id, score) {
  const t = state.data.tx.get(Number(id));
  if (!t) return;
  await saveRecord('tx', moodPut({ ...t }, score));
}

function moodView() {
  const L = computeLookup();
  const exp = monthTxs().filter((t) => t.kind === KIND.EXPENSE && L.counts(t));
  const rated = exp.filter((t) => txScore(t) > 0), unrated = exp.filter((t) => !(txScore(t) > 0));
  const net = (t) => L.net(t), sumOf = (l) => l.reduce((a, t) => a + net(t), 0);
  const lvOf = (t) => moodLevel(txScore(t));
  const avg = rated.length ? rated.reduce((a, t) => a + txScore(t) * net(t), 0) / Math.max(1, sumOf(rated)) : 0;
  const avgS = Math.round(avg), pct = moodPercent();
  const { y, m } = state.month;
  const head = avgS ? moodPlanet(avgS, 54) : typeof plOfMonth === 'function' ? planetSvg(plOfMonth(y, m), { px: 54, mood: 0 }) : '';
  const avgTxt = !avgS ? tr('本月暂未给支出打分', 'No ratings this month yet')
    : pct ? tr(`平均 ${avgS} 分 · ${moodLabel(avgS)}`, `Average ${avgS} · ${moodLabel(avgS)}`)
    : tr(`平均 ★${(avg / 20).toFixed(1)} · ${moodLabel(avgS)}`, `Average ★${(avg / 20).toFixed(1)} · ${moodLabel(avgS)}`);
  const bar = rated.length ? `<div class="mood-bar">${MOODS.map((md) => { const v = sumOf(rated.filter((t) => lvOf(t) === md.level)); return v > 0 ? `<i style="flex:${v};background:${md.color}"></i>` : ''; }).join('')}</div>
    <div class="mood-legend">${MOODS.map((md) => `<div>${moodPlanet(md.level * 20, 22)}<span class="muted">${pct ? `${(md.level - 1) * 20 + 1}–${md.level * 20}` : '★' + md.level}</span><span class="num">${money(sumOf(rated.filter((t) => lvOf(t) === md.level)))}</span></div>`).join('')}</div>` : '';
  const top = (title, list, lv) => (list.length ? `<div class="card mood-list"><div class="mood-h">${moodPlanet(lv * 20, 18)}<b>${title}</b></div>${rowsOf(list, L)}</div>` : '');
  const byAmt = (l) => [...l].sort((a, b) => net(b) - net(a)).slice(0, 5);
  return `<div class="grid mood-page">${monthBar()}
    <div class="seg"><button class="${pct ? '' : 'on'}" data-act="mood-scale" data-v="star">${tr('五星评价', '5 stars')}</button><button class="${pct ? 'on' : ''}" data-act="mood-scale" data-v="percent">${tr('百分制', '100 points')}</button></div>
    <div class="card"><div class="mood-sum">${head}<div><b>${avgTxt}</b>
      <div class="muted small">${tr(`已打分 ${rated.length} / ${exp.length} 笔`, `${rated.length} of ${exp.length} rated`)}</div></div></div>
      <div class="between mood-figs"><div><b class="num" style="color:${MOODS[0].color}">${money(sumOf(rated.filter((t) => lvOf(t) <= 2)))}</b><div class="muted small">${tr('后悔的花费', 'Regretted')}</div></div>
        <div class="right"><b class="num" style="color:${MOODS[3].color}">${money(sumOf(rated.filter((t) => lvOf(t) >= 4)))}</b><div class="muted small">${tr('开心的花费', 'Joyful')}</div></div></div>${bar}</div>
    ${top(tr('最后悔的几笔', 'Most regretted'), byAmt(rated.filter((t) => lvOf(t) <= 2)), 1)}${top(tr('最开心的几笔', 'Most joyful'), byAmt(rated.filter((t) => lvOf(t) >= 4)), 5)}
    ${unrated.length ? `<div class="card mood-list"><div class="mood-h"><b>${tr(`未打分 · ${unrated.length} 笔`, `Not rated · ${unrated.length}`)}</b></div>
      ${unrated.slice(0, 30).map((t) => `${rowsOf([t], L)}<div class="mood-under">${moodRater(0, 'tx', t.id)}</div>`).join('')}</div>` : ''}
  </div>`;
}

MOD.pages.mood = () => moodView();
MOD.me.push({ key: 'mood', get name() { return tr('支出心情', 'Spending mood'); }, icon: 'heart', order: 14 });
MOD.actions.push(async (act, v) => {
  if (act === 'mood-scale') {
    try { await shared.set('moodScale', v === 'percent' ? 'percent' : 'star'); } catch (e) { state.error = e.message; }
    render();
    return true;
  }
  if (act !== 'mood-set') return false;
  const [id, s] = String(v).split(':').map(Number);
  try { await moodSave(id, s); } catch (e) { state.error = e.message; }
  render();
  return true;
});
