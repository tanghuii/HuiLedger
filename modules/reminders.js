// 提醒：和手机端 Reminders.kt 的 run()、设置页"提醒"卡片同样的判断。
// iPhone 上的网页没法定时发通知，所以改成打开 App 时在明细页顶上放横幅，每条都能点 × 关掉（当天不再出现）：
//   · 今天还没记账（开了每日提醒、过了提醒时间、今天一笔都没新记）
//   · 信用卡还款日：还有 3 天 / 1 天 / 今天，并且还欠着钱（共享设置 cardDue = { 账户 id: 每月几号 }）
//   · 借款到期：前 3 天、当天、过期后每 7 天，还清了就不提（共享设置 loanDue = { 对方: epochDay }）
// 另外能把信用卡还款日导成 .ics（每月重复、带提醒），加到 iPhone 日历里，到点由日历提醒。
// 开关和提醒时间只存在这台设备上（localStorage 的 hl.remind），和手机端一样是本机设置。
'use strict';

const RM_KEY = 'hl.remind', RM_X = 'hl.remindX';
const rmJson = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const rmPut = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式存不了 */ } };
const rmPrefs = () => ({ daily: false, dues: true, hour: 20, ...rmJson(RM_KEY, {}) });
/** 今天关掉过的横幅。 */
const rmDismissed = () => { const o = rmJson(RM_X, {}); return o.day === today() ? o.keys ?? [] : []; };

/** 离下一个"每月 day 号"还有几天（今天就是则为 0）；月份没有那一天时按月底算。 */
function rmDaysUntil(day) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth() + 1, t = today();
  const len = (yy, mm) => new Date(yy, mm, 0).getDate();
  let d = epochDay(y, m, Math.min(day, len(y, m)));
  if (d < t) { const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1; d = epochDay(ny, nm, Math.min(day, len(ny, nm))); }
  return d - t;
}

/** 现在该出现的提醒：[{ key, icon, title, text, go }]。 */
function rmItems() {
  if (!state.session || !state.data.account.size) return [];
  const p = rmPrefs(), out = [], txs = allTxs();
  if (p.dues) {
    // 信用卡还款日
    const due = shared.get('cardDue', {}) ?? {};
    for (const [id, day] of Object.entries(due)) {
      const a = state.data.account.get(Number(id));
      if (!a || a.archived || !(Number(day) >= 1)) continue;
      const left = rmDaysUntil(Number(day)), owed = -balanceOf(a, txs);
      if (owed > 0 && [0, 1, 3].includes(left)) out.push({
        key: 'card:' + a.id, icon: 'card', go: 'card:' + a.id,
        title: tr(`${a.name} 还款日`, `${a.name} payment due`),
        text: (left === 0 ? tr('今天到期', 'Due today') : tr(`剩余 ${left} 天`, `In ${left} days`)) + tr(`，欠款 ${money(owed, acctCur(a))}`, `, ${money(owed, acctCur(a))} owed`),
      });
    }
    // 借款到期：前 3 天、当天、过期后每 7 天；还清了不提
    const loan = typeof loanAccount === 'function' ? loanAccount() : null;
    const dues = shared.get('loanDue', {}) ?? {};
    if (loan) for (const [person, day] of Object.entries(dues)) {
      const mine = txs.filter((t) => (t.loanPerson ?? '').trim() === person.trim());
      const net = mine.reduce((s, t) => s + effect(loan, t), 0), left = Number(day) - today();
      if (net !== 0 && (left === 3 || left === 0 || (left < 0 && -left % 7 === 0))) out.push({
        key: 'loan:' + person, icon: 'people', go: 'loan:' + person,
        title: tr(`借款到期：${person}`, `Loan due: ${person}`),
        text: (left > 0 ? tr(`剩余 ${left} 天`, `In ${left} days`) : left === 0 ? tr('今天到期', 'Due today') : tr(`已逾期 ${-left} 天`, `${-left} days overdue`))
          + tr(`，剩余 ${money(Math.abs(net))}`, `, ${money(Math.abs(net))} left`),
      });
    }
  }
  // 今天还没记账：过了提醒时间才提
  if (p.daily && new Date().getHours() >= p.hour) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    if (!txs.some((t) => (t.createdAt ?? 0) >= start.getTime())) out.push({ key: 'daily', icon: 'pen', go: 'new', title: tr('今日暂未记账', 'Nothing logged today'), text: tr('花一分钟记一笔', 'Take a minute to log it') });
  }
  const gone = rmDismissed();
  return out.filter((x) => !gone.includes(x.key));
}

const RM_ICON = {
  card: 'M3,6.5h18v11H3z M3,10h18 M6.5,14.5h4',
  people: 'M9,11a3.5,3.5 0 1,0 0,-7a3.5,3.5 0 1,0 0,7z M2.5,20c0,-3.6 2.9,-6 6.5,-6s6.5,2.4 6.5,6 M16,4.3a3.5,3.5 0 0,1 0,6.6 M18,14.4c2.1,.8 3.5,2.8 3.5,5.6',
  pen: 'M4,20h4l10.5,-10.5l-4,-4l-10.5,10.5z M13,7l4,4',
};
// 放在最前面（"多选"那一行属于下面的账单列表）
MOD.homeCards.unshift(() => {
  const items = rmItems();
  if (!items.length) return '';
  return `<div class="rm-bans">${items.map((x) => `<div class="card rm-ban">
    <button class="rm-main" data-act="rm-go" data-v="${h(x.go)}"><span class="rm-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${RM_ICON[x.icon]}"/></svg></span>
      <span class="rm-tx"><b>${h(x.title)}</b><span>${h(x.text)}</span></span></button>
    <button class="rm-x" data-act="rm-x" data-v="${h(x.key)}" aria-label="${tr('今天不再提醒', 'Dismiss for today')}">×</button></div>`).join('')}</div>`;
});

// ---------------------------------------------------------------- .ics：信用卡还款日加到日历

const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** 每行最多 75 个字节，长了就折行（RFC 5545）。 */
function icsFold(line) {
  const enc = new TextEncoder(), out = [];
  let cur = '';
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const icsDate = (day) => dayISO(day).replace(/-/g, '');

/** 有设了还款日的信用卡（没归档的）。 */
const rmCards = () => Object.entries(shared.get('cardDue', {}) ?? {})
  .map(([id, day]) => ({ a: state.data.account.get(Number(id)), day: Number(day) }))
  .filter((x) => x.a && !x.a.archived && x.day >= 1 && x.day <= 31);

function rmIcs() {
  const hr = rmPrefs().hour, stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PlanetLedger//Reminders//' + (LANG === 'en' ? 'EN' : 'ZH'), 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const { a, day } of rmCards()) {
    const first = today() + rmDaysUntil(day);
    // 29–31 号：那个月没有这一天就落在月底（和手机端一样）
    const rule = day > 28 ? `FREQ=MONTHLY;BYMONTHDAY=${Array.from({ length: day - 27 }, (_, i) => 28 + i).join(',')};BYSETPOS=-1` : `FREQ=MONTHLY;BYMONTHDAY=${day}`;
    const alarm = (trigger, text) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:${trigger}`, `DESCRIPTION:${icsText(text)}`, 'END:VALARM'];
    const title = tr(`${a.name} 还款日`, `${a.name} payment due`);
    lines.push('BEGIN:VEVENT', `UID:huiledger-card-${a.id}@huiledger`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(first)}`, `DTEND;VALUE=DATE:${icsDate(first + 1)}`, `RRULE:${rule}`,
      `SUMMARY:${icsText(title)}`, 'TRANSP:TRANSPARENT',
      // 提醒时间和设置里的一样：3 天前、1 天前、当天
      ...alarm(`-P2DT${24 - hr}H`, tr(`${a.name} 3 天后还款`, `${a.name} due in 3 days`)),
      ...alarm(`-PT${24 - hr}H`, tr(`${a.name} 明天还款`, `${a.name} due tomorrow`)),
      ...alarm(`PT${hr}H`, tr(`${a.name} 今天还款`, `${a.name} due today`)),
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

async function rmExportIcs() {
  if (!rmCards().length) { xsToast(tr('暂未设置还款日', 'No payment days set')); return; }
  const name = 'PlanetLedger-due.ics', text = rmIcs();
  const file = new File([text], name, { type: 'text/calendar' });
  // iPhone 上用分享面板；不行就直接下载
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: tr('还款日', 'Payment days') }); return; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------------------------------------------------------- 设置页里的"提醒"卡片

function remindersSettingsHtml() {
  const p = rmPrefs(), cards = state.session ? rmCards().length : 0;
  const hours = Array.from({ length: 17 }, (_, i) => i + 7);
  return `<div class="card hm-list xs-set rm-set">
    <div class="xs-h">${tr('提醒', 'Reminders')}</div>
    <div class="hm-li"><span class="xs-lbl"><span>${tr('每日记账提醒', 'Daily reminder')}</span></span>${xsSwitch('rm-daily', p.daily, tr('每日记账提醒', 'Daily reminder'))}</div>
    <div class="hm-li"><span class="xs-lbl"><span>${tr('还款日、借款到期', 'Card payments, loans due')}</span></span>${xsSwitch('rm-dues', p.dues, tr('还款日、借款到期', 'Card payments, loans due'))}</div>
    <div class="hm-li"><span class="xs-lbl"><span>${tr('提醒时间', 'Time')}</span></span><select id="rm-hour" class="xs-sel" aria-label="${tr('提醒时间', 'Time')}">${hours.map((x) => `<option value="${x}" ${x === p.hour ? 'selected' : ''}>${x}:00</option>`).join('')}</select></div>
    ${cards ? `<button class="hm-li" data-act="rm-ics"><span class="xs-lbl"><span>${tr('将还款日添加至日历', 'Add due days to Calendar')}</span></span>${hmSvg(ICONS.forward.d, 'hm-chev')}</button>` : ''}
  </div>`;
}

MOD.actions.push(async (act, v) => {
  if (!act.startsWith('rm-')) return false;
  const p = rmPrefs();
  switch (act) {
    case 'rm-daily': rmPut(RM_KEY, { ...p, daily: !p.daily }); break;
    case 'rm-dues': rmPut(RM_KEY, { ...p, dues: !p.dues }); break;
    case 'rm-ics': await rmExportIcs(); return true;
    case 'rm-x': rmPut(RM_X, { day: today(), keys: [...rmDismissed(), v] }); break;
    case 'rm-go': {
      const [kind, ...rest] = String(v).split(':'), arg = rest.join(':');
      if (kind === 'new') { state.error = ''; startEdit(null); return true; }
      if (kind === 'card') { state.tab = 'accounts'; state.accountId = Number(arg); scrollTo(0, 0); }
      if (kind === 'loan' && typeof LOAN !== 'undefined') {
        const t = allTxs().find((x) => (x.loanPerson ?? '').trim() === arg.trim() && x.loanSide);
        LOAN.side = t?.loanSide ?? 1; LOAN.open = arg; LOAN.loose = false; LOAN.add = null; state.tab = 'loans'; scrollTo(0, 0);
      }
      break;
    }
    default: return false;
  }
  render();
  return true;
});

MOD.changes.push(async (ev) => {
  if (ev.target.id !== 'rm-hour') return false;
  const hr = Number(ev.target.value);
  if (hr >= 7 && hr <= 23) rmPut(RM_KEY, { ...rmPrefs(), hour: hr });
  render();
  return true;
});
