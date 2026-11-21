// 支出心情（和手机端 ui/Mood.kt 一样）：买完之后的感受，五颗带表情的行星——很后悔（海王星撇嘴）、
// 有点后悔（天王星撇嘴）、一般（水星平嘴）、开心（地球笑）、超开心（金星笑）。账单上存 mood：1–5，0 / 没有 = 没打分。
// 记一笔、账单详情里能打分；"我的 → 支出心情"看每个月花得值不值，还没打分的直接点行星打上。
'use strict';

const MOODS = [
  { score: 1, zh: '很后悔', en: 'Big regret', planet: 'neptune', face: -1, color: '#5B7BF5' },
  { score: 2, zh: '有点后悔', en: 'Some regret', planet: 'uranus', face: -1, color: '#1FB5A8' },
  { score: 3, zh: '一般', en: 'Okay', planet: 'mercury', face: 0, color: '#8793A6' },
  { score: 4, zh: '开心', en: 'Happy', planet: 'earth', face: 1, color: '#3DBA6F' },
  { score: 5, zh: '超开心', en: 'Delighted', planet: 'venus', face: 1, color: '#F2B01E' },
];
const moodOf = (s) => MOODS.find((m) => m.score === Number(s)) ?? null;
const moodLabel = (s) => { const m = moodOf(s); return m ? tr(m.zh, m.en) : ''; };
/** 一颗心情行星。 */
const moodPlanet = (s, px = 24, cls = '') => { const m = moodOf(s); return m && typeof planetSvg === 'function' ? planetSvg(m.planet, { px, mood: m.face, spin: false, cls: 'mood-pl ' + cls }) : ''; };
/** 五颗排一排，点一颗就是打这个分，再点同一颗取消。act / id：点了发给哪个动作、哪笔账单。 */
function moodPicker(current, act, id = '', px = 34) {
  return `<div class="mood-pick">${MOODS.map((m) => `<button class="${m.score === current ? 'on' : ''}" data-act="${act}" data-v="${id}:${m.score === current ? 0 : m.score}" aria-label="${h(tr(m.zh, m.en))}">${moodPlanet(m.score, px)}<span>${h(tr(m.zh, m.en))}</span></button>`).join('')}</div>`;
}

async function moodSave(id, score) {
  const t = state.data.tx.get(Number(id));
  if (!t) return;
  const n = { ...t };
  if (score > 0) n.mood = score; else delete n.mood;
  await saveRecord('tx', n);
}

function moodView() {
  const L = computeLookup();
  const exp = monthTxs().filter((t) => t.kind === KIND.EXPENSE && L.counts(t));
  const rated = exp.filter((t) => Number(t.mood) > 0), unrated = exp.filter((t) => !(Number(t.mood) > 0));
  const net = (t) => L.net(t), sumOf = (l) => l.reduce((a, t) => a + net(t), 0);
  const avg = rated.length ? Math.min(5, Math.max(1, Math.round(rated.reduce((a, t) => a + t.mood * net(t), 0) / Math.max(1, sumOf(rated))))) : 0;
  const { y, m } = state.month;
  const head = avg ? moodPlanet(avg, 54) : typeof plOfMonth === 'function' ? planetSvg(plOfMonth(y, m), { px: 54, mood: 0 }) : '';
  const total = Math.max(1, sumOf(rated));
  const bar = rated.length ? `<div class="mood-bar">${MOODS.map((md) => { const v = sumOf(rated.filter((t) => t.mood === md.score)); return v > 0 ? `<i style="flex:${v};background:${md.color}"></i>` : ''; }).join('')}</div>
    <div class="mood-legend">${MOODS.map((md) => `<div>${moodPlanet(md.score, 22)}<span class="num">${money(sumOf(rated.filter((t) => t.mood === md.score)))}</span></div>`).join('')}</div>` : '';
  const top = (title, list, s) => (list.length ? `<div class="card mood-list"><div class="mood-h">${moodPlanet(s, 18)}<b>${title}</b></div>${rowsOf(list, L)}</div>` : '');
  const byAmt = (l) => [...l].sort((a, b) => net(b) - net(a)).slice(0, 5);
  return `<div class="grid mood-page">${monthBar()}
    <div class="card"><div class="mood-sum">${head}<div><b>${avg ? tr(`这个月整体：${moodLabel(avg)}`, `Overall: ${moodLabel(avg)}`) : tr('这个月还没给支出打分', 'No ratings this month yet')}</b>
      <div class="muted small">${tr(`已打分 ${rated.length} / ${exp.length} 笔`, `${rated.length} of ${exp.length} rated`)}</div></div></div>
      <div class="between mood-figs"><div><b class="num" style="color:${MOODS[0].color}">${money(sumOf(rated.filter((t) => t.mood <= 2)))}</b><div class="muted small">${tr('后悔的花费', 'Regretted')}</div></div>
        <div class="right"><b class="num" style="color:${MOODS[3].color}">${money(sumOf(rated.filter((t) => t.mood >= 4)))}</b><div class="muted small">${tr('开心的花费', 'Joyful')}</div></div></div>${bar}</div>
    ${top(tr('最后悔的几笔', 'Most regretted'), byAmt(rated.filter((t) => t.mood <= 2)), 1)}${top(tr('最开心的几笔', 'Most joyful'), byAmt(rated.filter((t) => t.mood >= 4)), 5)}
    ${unrated.length ? `<div class="card mood-list"><div class="mood-h"><b>${tr(`还没打分 · ${unrated.length} 笔`, `Not rated · ${unrated.length}`)}</b></div>
      ${unrated.slice(0, 30).map((t) => `${rowsOf([t], L)}${moodPicker(0, 'mood-set', t.id, 26)}`).join('')}</div>` : ''}
  </div>`;
}

MOD.pages.mood = () => moodView();
MOD.me.push({ key: 'mood', get name() { return tr('支出心情', 'Spending mood'); }, icon: 'heart', order: 14 });
MOD.actions.push(async (act, v) => {
  if (act !== 'mood-set') return false;
  const [id, s] = String(v).split(':').map(Number);
  try { await moodSave(id, s); } catch (e) { state.error = e.message; }
  render();
  return true;
});
