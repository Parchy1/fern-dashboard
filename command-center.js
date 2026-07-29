import { completeRecommendedAction, formatClock, selectRecommendedAction, timeToMinutes } from './next-action.js';

const DAY_MS = 86400000;

export function dateKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

export function activeDateKey(now) {
  const value = new Date(now == null ? Date.now() : now);
  if (value.getHours() < 6) value.setDate(value.getDate() - 1);
  return dateKey(value);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function computeWaterProgress(state, now) {
  if (!state || !state.profile || !state.profile.weightKg) return null;
  const profile = state.profile;
  const weightKg = state.weightUnit === 'lb' ? profile.weightKg / 2.20462 : profile.weightKg;
  const base = weightKg * 35;
  const exercise = (profile.activityHrsPerWeek || 0) / 7 * 500;
  const caffeine = Math.max(0, (state.caffeineMgPerDay || 0) - 200) * 1.5;
  let adjustment = 0;
  if (profile.sex === 'm') adjustment += 200;
  if ((profile.age || 0) >= 50) adjustment += 100;
  let unitMl = state.bottleMl || 500;
  if (state.unit === 'glass') unitMl = state.glassMl || 250;
  else if (state.unit === 'oz') unitMl = 30;
  else if (state.unit === 'ml') unitMl = 1;
  const total = Math.max(1, Math.ceil((base + exercise + caffeine + adjustment) / unitMl));
  const done = Number((state.logs || {})[dateKey(new Date(now == null ? Date.now() : now))]) || 0;
  return { done, total, ratio: Math.min(1, done / total) };
}

export function computeBestStreak(habitDefs, habitLog, workoutDays, now) {
  function streakFor(isDone) {
    let streak = 0;
    const cursor = new Date(now == null ? Date.now() : now);
    if (!isDone(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
    while (isDone(dateKey(cursor)) && streak < 3660) { streak++; cursor.setDate(cursor.getDate() - 1); }
    return streak;
  }
  let best = { days: 0, label: 'No active streak' };
  (habitDefs || []).forEach(habit => {
    const days = streakFor(key => !!(habitLog && habitLog[habit.id] && habitLog[habit.id][key]));
    if (days > best.days) best = { days, label: habit.name || 'Habit' };
  });
  const workouts = streakFor(key => !!(workoutDays && workoutDays[key]));
  if (workouts > best.days) best = { days: workouts, label: 'Workouts' };
  return best;
}

export function computeNetWorthTrend(history, now) {
  const cutoff = (now == null ? Date.now() : now) - 180 * DAY_MS;
  const points = (Array.isArray(history) ? history : []).filter(point => point && point.t >= cutoff && Number.isFinite(Number(point.v)));
  if (points.length < 2) return null;
  const firstTime = points[0].t;
  const xs = points.map(point => (point.t - firstTime) / DAY_MS);
  const ys = points.map(point => Number(point.v));
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((sum, x, index) => sum + x * ys[index], 0);
  const sumXX = xs.reduce((sum, x) => sum + x * x, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (!denominator) return null;
  const perDay = (n * sumXY - sumX * sumY) / denominator;
  return { monthly: perDay * 30.44, current: ys[ys.length - 1] };
}

export function buildSchedule(goals, googleSnapshot, now) {
  const nowMinutes = new Date(now == null ? Date.now() : now).getHours() * 60 + new Date(now == null ? Date.now() : now).getMinutes();
  const items = [];
  (goals || []).filter(goal => goal && goal.text && goal.time).forEach(goal => {
    items.push({ kind: 'goal', title: goal.text, time: goal.time, minutes: timeToMinutes(goal.time), done: !!goal.done, href: 'main.html' });
  });
  ((googleSnapshot && googleSnapshot.calendarEventsToday) || []).forEach(event => {
    items.push({ kind: 'calendar', title: event.title || '(no title)', time: event.time || 'All day', minutes: timeToMinutes(event.time), done: false, href: 'google.html' });
  });
  items.sort((a, b) => (a.minutes == null ? 9999 : a.minutes) - (b.minutes == null ? 9999 : b.minutes));
  const nextIndex = items.findIndex(item => !item.done && item.minutes != null && item.minutes >= nowMinutes);
  return items.map((item, index) => ({ ...item, isNext: index === nextIndex }));
}

export function nextRenewal(subscription, now) {
  if (!subscription || !subscription.renewal) return null;
  const safe = /^\d{4}-\d{2}-\d{2}$/.test(subscription.renewal) ? subscription.renewal + 'T00:00:00' : subscription.renewal;
  const renewal = new Date(safe);
  if (Number.isNaN(renewal.getTime())) return null;
  const current = new Date(now == null ? Date.now() : now);
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate());
  let safety = 0;
  while (renewal < today && safety++ < 600) {
    if (subscription.period === 'weekly') renewal.setDate(renewal.getDate() + 7);
    else if (subscription.period === 'yearly') renewal.setFullYear(renewal.getFullYear() + 1);
    else renewal.setMonth(renewal.getMonth() + 1);
  }
  return { date: renewal, days: Math.round((renewal.getTime() - today.getTime()) / DAY_MS) };
}

export function computeBurnoutRisk(data, now) {
  const checkins = data.checkins || [];
  const sleepNights = data.sleepNights || {};
  const habitDefs = data.habitDefs || [];
  const habitLog = data.habitLog || {};
  const goalsByDate = data.goalsByDate || {};
  const feelingByDay = {}, stressByDay = {};
  checkins.forEach(checkin => {
    if (!checkin || !checkin.dateKey) return;
    if (checkin.feeling != null) (feelingByDay[checkin.dateKey] ||= []).push(checkin.feeling);
    if (checkin.stress != null) (stressByDay[checkin.dateKey] ||= []).push(checkin.stress);
  });
  const rows = [];
  const cursor = new Date(now == null ? Date.now() : now);
  for (let i = 0; i < 14; i++) {
    const key = dateKey(cursor);
    const sleep = sleepNights[key] || {};
    const goals = goalsByDate[key] || [];
    const habitRate = habitDefs.length ? habitDefs.filter(habit => habitLog[habit.id] && habitLog[habit.id][key]).length / habitDefs.length : null;
    const todoRate = goals.length ? goals.filter(goal => goal.done).length / goals.length : null;
    rows.push({
      stress: average(stressByDay[key] || []),
      sleepQuality: sleep.sleepQuality == null ? null : Number(sleep.sleepQuality),
      consistency: average([habitRate, todoRate].filter(value => value != null)),
    });
    cursor.setDate(cursor.getDate() - 1);
  }
  const recent = rows.slice(0, 7), prior = rows.slice(7, 14);
  const avgField = (list, field) => average(list.map(row => row[field]).filter(value => value != null));
  const signals = [];
  const recentStress = avgField(recent, 'stress'), priorStress = avgField(prior, 'stress');
  const recentSleep = avgField(recent, 'sleepQuality'), priorSleep = avgField(prior, 'sleepQuality');
  const recentConsistency = avgField(recent, 'consistency'), priorConsistency = avgField(prior, 'consistency');
  if (recentStress != null && priorStress != null && recentStress - priorStress >= 0.5) signals.push('stress is trending up');
  if (recentSleep != null && priorSleep != null && priorSleep - recentSleep >= 0.5) signals.push('sleep quality is trending down');
  if (recentConsistency != null && priorConsistency != null && priorConsistency - recentConsistency >= 0.15) signals.push('daily consistency is slipping');
  return { level: signals.length >= 2 ? 'Elevated' : signals.length === 1 ? 'Moderate' : 'Low', signals };
}

export function buildAlerts(data, now) {
  const alerts = [];
  const current = new Date(now == null ? Date.now() : now);
  const nowMinutes = current.getHours() * 60 + current.getMinutes();
  const overdue = (data.goals || []).map(goal => ({ goal, minutes: goal && !goal.done ? timeToMinutes(goal.time) : null }))
    .filter(item => item.minutes != null && item.minutes < nowMinutes)
    .sort((a, b) => a.minutes - b.minutes);
  if (overdue.length) {
    const first = overdue[0].goal;
    alerts.push({ level: 'critical', icon: '!', title: first.text, detail: 'Overdue since ' + formatClock(first.time), href: 'main.html' });
  }
  if (overdue.length > 1) {
    alerts.push({ level: 'warning', icon: '+', title: (overdue.length - 1) + ' more scheduled item' + (overdue.length === 2 ? '' : 's') + ' overdue', detail: 'Review today\'s remaining plan', href: 'main.html' });
  }
  const water = computeWaterProgress(data.water, current.getTime());
  if (water && current.getHours() >= 18 && water.ratio < 0.5) alerts.push({ level: 'warning', icon: '◒', title: 'Hydration is behind', detail: water.done + ' of ' + water.total + ' drinks logged', href: 'health.html#water' });
  (data.subscriptions || []).forEach(subscription => {
    const renewal = nextRenewal(subscription, current.getTime());
    if (renewal && renewal.days <= 5) alerts.push({ level: renewal.days === 0 ? 'critical' : 'warning', icon: '↻', title: (subscription.name || 'Subscription') + ' renews ' + (renewal.days === 0 ? 'today' : 'in ' + renewal.days + 'd'), detail: 'Review the upcoming charge', href: 'finance.html' });
  });
  if (data.burnout && data.burnout.level === 'Elevated') alerts.push({ level: 'warning', icon: '△', title: 'Burnout risk is elevated', detail: data.burnout.signals.join(' · '), href: 'insights-recovery.html' });
  const rank = { critical: 0, warning: 1 };
  return alerts.sort((a, b) => rank[a.level] - rank[b.level]).slice(0, 5);
}

export function buildRecentActivity(data) {
  const activity = [];
  Object.keys(data.goalsByDate || {}).forEach(key => (data.goalsByDate[key] || []).forEach(goal => {
    if (goal && goal.doneAt) activity.push({ ts: Number(goal.doneAt), icon: '✓', title: 'Completed ' + goal.text, detail: 'To-do', href: 'main.html' });
  }));
  (data.notes || []).forEach(note => { if (note && note.updatedAt) activity.push({ ts: Number(note.updatedAt), icon: '✎', title: note.title || 'Updated a note', detail: 'Notes', href: 'notes.html' }); });
  (data.reading || []).forEach(item => { if (item && item.updatedAt) activity.push({ ts: Number(item.updatedAt), icon: '◫', title: item.title || 'Updated reading', detail: 'Reading', href: 'reading.html' }); });
  (data.financeActivity || []).forEach(item => { if (item && item.ts) activity.push({ ts: Number(item.ts), icon: '$', title: (item.kind || 'Updated') + ' · ' + (item.name || 'Finance'), detail: 'Finance', href: 'finance.html' }); });
  (data.checkins || []).forEach(item => { if (item && item.ts) activity.push({ ts: Number(item.ts), icon: '◉', title: 'Logged a feeling check-in', detail: 'Peak', href: 'peak.html' }); });
  return activity.filter(item => Number.isFinite(item.ts)).sort((a, b) => b.ts - a.ts).slice(0, 6);
}

export function buildProactiveInsight(data) {
  const nights = Object.values(data.sleepNights || {}).filter(night => night && Number(night.sleepHours) > 0).slice(-3);
  if (nights.length >= 2) {
    const hours = average(nights.map(night => Number(night.sleepHours)));
    if (hours < 7) return 'Sleep averaged ' + hours.toFixed(1) + ' hours across your latest logs — protecting tonight would have the highest recovery payoff.';
  }
  if (data.burnout && data.burnout.signals.length) return data.burnout.signals[0].replace(/^./, char => char.toUpperCase()) + ' — lighten the next block before adding more.';
  const water = data.waterProgress;
  if (water && water.ratio < 0.5) return 'Hydration is the clearest controllable signal right now — one drink moves it immediately.';
  if (data.action) return 'Your clearest path forward is already selected: finish “' + data.action.title + '” before adding another priority.';
  return 'Systems are ready. Add a goal or check-in and the Command Center will start prioritizing your day.';
}

function storeGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}

async function pushGoalList(dayKey, goals) {
  const url = window.DASH_SUPABASE_URL || 'https://srajryooffirbroltjmg.supabase.co';
  const key = window.DASH_SUPABASE_KEY || 'sb_publishable_5142ZwTLF_DkSVRzciNuRA_bHwRAu4c';
  if (!url || !key || url.indexOf('PASTE-') === 0) return false;
  try {
    const read = await fetch(url + '/rest/v1/app_state?key=eq.goals&select=data', {
      headers: { apikey: key, Authorization: 'Bearer ' + key },
    });
    if (!read.ok) return false;
    const rows = await read.json();
    const merged = { ...((rows && rows[0] && rows[0].data) || {}) };
    merged['goals:' + dayKey] = goals;
    const write = await fetch(url + '/rest/v1/app_state?on_conflict=key', {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ key: 'goals', data: merged, updated_at: new Date().toISOString() }),
    });
    return write.ok;
  } catch (e) { return false; }
}

function collectGoalsByDate() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.indexOf('goals:') === 0) out[key.slice(6)] = storeGet(key) || [];
  }
  return out;
}

function formatAgo(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

function escapeText(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function readModel() {
  const now = new Date();
  const todayKey = activeDateKey(now.getTime());
  const goalsByDate = collectGoalsByDate();
  const goals = goalsByDate[todayKey] || [];
  const water = storeGet('po_water_v1');
  const habitDefs = storeGet('habits:defs') || [];
  const habitLog = storeGet('habits:log') || {};
  const workoutDays = storeGet('po_coach_workout_done') || {};
  const sleepNights = storeGet('sleep:nights') || {};
  const checkins = storeGet('peak:checkins') || [];
  const burnout = computeBurnoutRisk({ checkins, sleepNights, habitDefs, habitLog, goalsByDate }, now.getTime());
  const action = selectRecommendedAction(goals, now.getHours() * 60 + now.getMinutes(), storeGet('leverage_stats_v1'));
  const waterProgress = computeWaterProgress(water, now.getTime());
  const streak = computeBestStreak(habitDefs, habitLog, workoutDays, now.getTime());
  const trend = computeNetWorthTrend(storeGet('nw:history') || [], now.getTime());
  const model = {
    now, todayKey, goalsByDate, goals, water, waterProgress, habitDefs, habitLog, workoutDays,
    sleepNights, checkins, burnout, action, streak, trend,
    schedule: buildSchedule(goals, storeGet('google:snapshot'), now.getTime()),
    subscriptions: storeGet('subs') || [],
    notes: storeGet('notes:items') || [],
    reading: storeGet('reading:items') || [],
    financeActivity: storeGet('nw:activity') || [],
  };
  model.alerts = buildAlerts(model, now.getTime());
  model.activity = buildRecentActivity(model);
  model.insight = buildProactiveInsight(model);
  return model;
}

function render() {
  const model = readModel();
  const hour = model.now.getHours();
  const greeting = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  document.getElementById('ccGreeting').textContent = greeting + ', Fernando';
  document.getElementById('ccSystemText').textContent = model.alerts.length ? model.alerts.length + ' signal' + (model.alerts.length === 1 ? '' : 's') + ' need attention' : 'All systems nominal';
  document.getElementById('scoreCard').classList.toggle('has-alerts', model.alerts.length > 0);

  const actionEl = document.getElementById('ccAction');
  if (model.action) {
    actionEl.dataset.index = String(model.action.index);
    document.getElementById('ccActionEyebrow').textContent = model.action.eyebrow;
    document.getElementById('ccActionTitle').textContent = model.action.title;
    document.getElementById('ccActionReason').textContent = model.action.reason;
    document.getElementById('ccActionDone').hidden = false;
  } else {
    delete actionEl.dataset.index;
    document.getElementById('ccActionEyebrow').textContent = model.goals.length ? 'Mission complete' : 'Ready when you are';
    document.getElementById('ccActionTitle').textContent = model.goals.length ? 'Everything is done for today' : 'Add your first objective';
    document.getElementById('ccActionReason').textContent = model.goals.length ? 'Use Focus Mode to plan the next block.' : 'The Command Center will prioritize it automatically.';
    document.getElementById('ccActionDone').hidden = true;
  }

  const scheduleEl = document.getElementById('ccSchedule');
  scheduleEl.innerHTML = model.schedule.length ? model.schedule.map(item =>
    '<a class="cc-schedule-item' + (item.isNext ? ' is-next' : '') + (item.done ? ' is-done' : '') + '" href="' + item.href + '">'
    + (item.isNext ? '<span class="hud-pulse-dot cc-now-marker"></span>' : '<span class="cc-schedule-node"></span>')
    + '<span class="cc-schedule-time">' + escapeText(item.time) + '</span><span class="cc-schedule-title">' + escapeText(item.title) + '</span></a>'
  ).join('') : '<a class="cc-empty-inline" href="main.html">Nothing timed yet — add a time to any goal →</a>';

  const latestSleep = Object.values(model.sleepNights).filter(Boolean).slice(-1)[0];
  const sleepValue = latestSleep ? (latestSleep.sleepHours ? latestSleep.sleepHours + 'h' : latestSleep.sleepQuality + '/5') : 'Not logged';
  const moneyValue = model.trend ? (model.trend.monthly >= 0 ? '▲ ' : '▼ ') + Math.abs(model.trend.monthly).toLocaleString('en-US', { maximumFractionDigits: 0 }) + '/mo' : 'Trend building';
  document.getElementById('ccSignals').innerHTML = [
    ['◐', 'Sleep', sleepValue, 'sleep.html'],
    ['◒', 'Water', model.waterProgress ? model.waterProgress.done + '/' + model.waterProgress.total : 'Not set', 'health.html#water'],
    ['↗', 'Net worth', moneyValue, 'finance.html'],
    ['⚡', 'Best streak', model.streak.days ? model.streak.days + 'd · ' + model.streak.label : 'Start today', 'main.html'],
  ].map(signal => '<a class="cc-signal" href="' + signal[3] + '"><span class="cc-signal-icon">' + signal[0] + '</span><span><b>' + escapeText(signal[1]) + '</b><small>' + escapeText(signal[2]) + '</small></span></a>').join('');

  document.getElementById('ccInsightText').textContent = model.insight;
  document.getElementById('ccAlertCount').textContent = String(model.alerts.length);
  document.getElementById('ccAlerts').innerHTML = model.alerts.length ? model.alerts.map(alert =>
    '<a class="cc-alert is-' + alert.level + '" href="' + alert.href + '"><span class="cc-alert-icon">' + alert.icon + '</span><span><b>' + escapeText(alert.title) + '</b><small>' + escapeText(alert.detail) + '</small></span><span class="cc-row-arrow">→</span></a>'
  ).join('') : '<div class="cc-panel-empty"><span>✓</span><b>No active alerts</b><small>Threshold checks are clear.</small></div>';

  document.getElementById('ccActivity').innerHTML = model.activity.length ? model.activity.map(item =>
    '<a class="cc-activity-item" href="' + item.href + '"><span class="cc-activity-icon">' + item.icon + '</span><span><b>' + escapeText(item.title) + '</b><small>' + escapeText(item.detail) + ' · ' + formatAgo(item.ts) + '</small></span></a>'
  ).join('') : '<div class="cc-panel-empty"><span>◎</span><b>No recent activity yet</b><small>Completed tasks and updates appear here.</small></div>';

  document.getElementById('focusObjective').textContent = model.action ? model.action.title : 'Plan your next objective';
  window.__commandCenterModel = model;
}

function boot() {
  if (!document.getElementById('ccAction')) return;
  const doneButton = document.getElementById('ccActionDone');
  doneButton.addEventListener('click', () => {
    const model = window.__commandCenterModel || readModel();
    if (!model.action) return;
    const updated = completeRecommendedAction(model.goals, model.action.index, Date.now());
    localStorage.setItem('goals:' + model.todayKey, JSON.stringify(updated));
    pushGoalList(model.todayKey, updated);
    window.dispatchEvent(new CustomEvent('goals-changed'));
    render();
  });

  const focus = document.getElementById('focusMode');
  const openButtons = document.querySelectorAll('[data-focus-open]');
  const closeButton = document.getElementById('focusClose');
  let focusStartedAt = null, focusElapsed = 0, focusTimer = null;
  const timerEl = document.getElementById('focusTimer');
  const timerButton = document.getElementById('focusTimerToggle');
  function paintTimer() {
    const elapsed = focusElapsed + (focusStartedAt ? Date.now() - focusStartedAt : 0);
    const seconds = Math.floor(elapsed / 1000);
    timerEl.textContent = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  }
  function openFocus() {
    focus.classList.add('show'); document.body.classList.add('focus-mode-open');
    document.getElementById('focusObjective').textContent = (window.__commandCenterModel && window.__commandCenterModel.action) ? window.__commandCenterModel.action.title : 'Plan your next objective';
    closeButton.focus();
  }
  function closeFocus() {
    if (focusStartedAt) {
      focusElapsed += Date.now() - focusStartedAt;
      focusStartedAt = null;
      clearInterval(focusTimer);
      timerButton.textContent = 'Resume';
      paintTimer();
    }
    focus.classList.remove('show');
    document.body.classList.remove('focus-mode-open');
  }
  openButtons.forEach(button => button.addEventListener('click', openFocus));
  closeButton.addEventListener('click', closeFocus);
  timerButton.addEventListener('click', () => {
    if (focusStartedAt) { focusElapsed += Date.now() - focusStartedAt; focusStartedAt = null; clearInterval(focusTimer); timerButton.textContent = 'Resume'; }
    else { focusStartedAt = Date.now(); focusTimer = setInterval(paintTimer, 250); timerButton.textContent = 'Pause'; }
    paintTimer();
  });
  document.getElementById('focusReset').addEventListener('click', () => { focusElapsed = 0; focusStartedAt = focusStartedAt ? Date.now() : null; paintTimer(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && focus.classList.contains('show')) closeFocus();
    else if (event.key === 'Tab' && focus.classList.contains('show')) {
      const focusable = Array.from(focus.querySelectorAll('button:not([disabled]),a[href]'));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('storage', render);
  window.addEventListener('goals-changed', render);
  document.addEventListener('command-center:refresh', render);
  setInterval(render, 60000);
  render();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
