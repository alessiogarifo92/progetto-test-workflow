// App shell: the only module that touches document, window, timers, Date.now and storage.
// Time comes from core (endAt), never from the repaint interval. The end of a session is ONE
// unchained setTimeout armed only from commit(); every other path just re-syncs through dispatch.

import {
  createTimer, durationMs, endDelay, formatMmSs, LIMITS, remainingMs, shouldAlert, todayCount,
} from './core.js';
import { createStore, getLocalStorage } from './store.js';

const store = createStore(getLocalStorage());
const timer = createTimer({ now: () => Date.now(), store });

const RING_C = 2 * Math.PI * 135; // circumference of the 280px ring (r = 135)
const REPAINT_MS = 250;

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), todayCount: $('today-count'), emptyCount: $('empty-count'),
  settingsBtn: $('settings-btn'), settings: $('settings'),
  setWork: $('set-work'), setShort: $('set-short'), setLong: $('set-long'),
  progress: $('ring-progress'), maskArc: $('ring-mask-arc'),
  digits: $('digits'), check: $('check'), heading: $('heading'), label: $('label'), awayNote: $('away-note'),
  primary: $('btn-primary'), secondary: $('btn-secondary'), quiet: $('quiet'), unsaved: $('unsaved'),
  prefs: $('prefs'), sound: $('pref-sound'), notify: $('pref-notify'),
  empty: $('empty'), history: $('history'), historyList: $('history-list'),
  live: $('live'),
};
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let handle = null; // the one pending end-of-session timeout
let complete = false; // UI flag: the complete screen is showing
let away = false; // that completion was noticed late (not worth an alert)
let lastMinute = null; // last full-minute mark announced while running
let historySig = '';

// ---------------------------------------------------------------- wiring

// The only place the end timeout is armed.
function commit() {
  clearTimeout(handle);
  handle = null;
  const d = endDelay(timer.getState(), Date.now());
  if (d !== null) handle = setTimeout(onDue, d);
}

function onDue() {
  settle(timer.dispatch({ type: 'sync' }));
}

// After any dispatch/hydrate: remember a completion, re-arm, repaint.
function settle(completion) {
  if (completion) {
    complete = true;
    away = !shouldAlert(completion, Date.now());
    announce('Session complete');
  }
  commit();
  render();
}

function act(type) {
  const before = timer.getState().status;
  if (type !== 'pause') {
    complete = false;
    away = false;
  }
  const completion = timer.dispatch({ type });
  const state = timer.getState();
  if (type === 'start' && state.status === 'running') {
    announce(before === 'paused' ? 'Resumed' : `Started, ${minutesLabel(Math.round(state.plannedMs / 60000))}`);
  } else if (type === 'pause' && state.status === 'paused') {
    announce(`Paused, ${formatMmSs(state.remainingMs)} remaining`);
  }
  settle(completion);
}

function resync() {
  settle(timer.dispatch({ type: 'sync' }));
}

// ---------------------------------------------------------------- render

const minutesLabel = (n) => `${n} ${n === 1 ? 'minute' : 'minutes'}`;
const clock = (min) => `${min}:00`;

function announce(text) {
  el.live.textContent = text;
}

function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// toggleAttribute, not .hidden: SVG elements have no hidden property.
function show(node, on) {
  node.toggleAttribute('hidden', !on);
}

function renderHistory(history) {
  const sig = history.map((h) => h.id).join(',');
  if (sig === historySig) return;
  historySig = sig;
  el.historyList.replaceChildren(...history.map((h) => {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = new Date(h.endedAt).toISOString();
    time.textContent = hhmm(h.endedAt);
    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = `Work ${Math.round(h.durationMs / 60000)} min`;
    li.append(time, dur);
    return li;
  }));
}

function syncInput(input, value) {
  if (document.activeElement !== input) input.value = String(value);
}

function render() {
  const now = Date.now();
  const state = timer.getState();
  const settings = timer.getSettings();
  // The complete screen only makes sense while the break that followed is still untouched.
  if (state.status !== 'idle' || state.phase === 'work') complete = false;
  if (!complete) away = false;
  const screen = complete ? 'complete' : state.status;
  const isWork = state.phase === 'work';
  const running = state.status === 'running';

  const rem = remainingMs(state, settings, now);
  const shown = reduceMotion.matches ? Math.ceil(rem / 1000) * 1000 : rem;
  const planned = state.status === 'idle' ? durationMs(state.phase, settings) : state.plannedMs || rem;
  const frac = state.status === 'running' || state.status === 'paused' ? Math.min(1, Math.max(0, shown / planned)) : 1;

  el.app.dataset.screen = screen;
  el.app.dataset.phase = isWork ? 'work' : 'break';

  // ring
  el.maskArc.setAttribute('stroke-dasharray', String(RING_C));
  el.maskArc.setAttribute('stroke-dashoffset', String(RING_C * (1 - frac)));
  if (screen === 'paused') el.progress.setAttribute('stroke-dasharray', '2 8');
  else el.progress.removeAttribute('stroke-dasharray');

  const text = formatMmSs(rem);
  el.digits.textContent = text;
  el.digits.classList.toggle('long', text.length > 5);
  show(el.digits, screen !== 'complete');
  show(el.check, screen === 'complete');

  // labels and controls
  let label = 'Ready';
  if (screen === 'running') label = isWork ? `Work · session ${state.cycle + 1}` : state.phase === 'long' ? 'Long break' : 'Short break';
  else if (screen === 'paused') label = 'Paused';
  else if (screen === 'idle' && !isWork) label = state.phase === 'long' ? 'Long break ready' : 'Short break ready';
  el.label.textContent = label;
  show(el.label, screen !== 'complete');
  show(el.heading, screen === 'complete');
  show(el.awayNote, screen === 'complete' && away);

  const breakMin = clock(durationMs(state.phase, settings) / 60000);
  let primary = ['start', 'Start'];
  let secondary = null;
  if (screen === 'running') [primary, secondary] = [['pause', 'Pause'], ['reset', 'Reset']];
  else if (screen === 'paused') [primary, secondary] = [['start', 'Resume'], ['reset', 'Reset']];
  else if (screen === 'complete') [primary, secondary] = [['start', `Start ${state.phase === 'long' ? 'long ' : ''}break ${breakMin}`], ['skip', 'Skip']];
  else if (!isWork) primary = ['start', 'Start break'];
  el.primary.dataset.action = primary[0];
  el.primary.textContent = primary[1];
  show(el.secondary, secondary !== null);
  if (secondary) {
    el.secondary.dataset.action = secondary[0];
    el.secondary.textContent = secondary[1];
  }

  // today count, quiet line, empty/history/prefs
  const count = todayCount(state, now);
  el.todayCount.textContent = String(count);
  el.emptyCount.textContent = String(count);
  const onQuiet = screen === 'running' || screen === 'paused';
  show(el.quiet, onQuiet);
  if (onQuiet) {
    const next = isWork
      ? `break ${clock(durationMs(state.cycle + 1 >= LIMITS.longEvery ? 'long' : 'short', settings) / 60000)}`
      : `work ${clock(settings.workMin)}`;
    el.quiet.textContent = `Today ${count} · next: ${next}`;
  }
  const hasHistory = state.history.length > 0;
  show(el.empty, screen === 'idle' && !hasHistory);
  show(el.history, (screen === 'idle' || screen === 'complete') && hasHistory);
  show(el.prefs, screen === 'complete');
  renderHistory(state.history);
  el.sound.checked = settings.sound;
  el.notify.checked = settings.notify;
  syncInput(el.setWork, settings.workMin);
  syncInput(el.setShort, settings.shortMin);
  syncInput(el.setLong, settings.longMin);
  show(el.unsaved, !store.isPersistent());

  // document title and the polite full-minute announcements
  document.title = running ? `${text} ${isWork ? 'Work' : 'Break'}` : 'Focus Timer';
  if (running) {
    const m = Math.ceil(rem / 60000);
    if (m !== lastMinute) {
      if (lastMinute !== null && m > 0) announce(`${minutesLabel(m)} remaining`);
      lastMinute = m;
    }
  } else {
    lastMinute = null;
  }
}

// Safety net only: the repaint never decides time, it just notices an end the timeout missed.
function tick() {
  const state = timer.getState();
  if (state.status === 'running' && remainingMs(state, timer.getSettings(), Date.now()) <= 0) onDue();
  else render();
}

// ---------------------------------------------------------------- events

el.primary.addEventListener('click', () => act(el.primary.dataset.action));
el.secondary.addEventListener('click', () => act(el.secondary.dataset.action));

el.settingsBtn.addEventListener('click', () => {
  const open = el.settingsBtn.getAttribute('aria-expanded') !== 'true';
  el.settingsBtn.setAttribute('aria-expanded', String(open));
  show(el.settings, open);
});

for (const [input, key] of [[el.setWork, 'workMin'], [el.setShort, 'shortMin'], [el.setLong, 'longMin']]) {
  input.addEventListener('change', () => {
    const next = timer.updateSettings({ [key]: input.value });
    input.value = String(next[key]); // never keep an out-of-range or empty value
    render();
  });
}
el.sound.addEventListener('change', () => {
  timer.updateSettings({ sound: el.sound.checked });
  render();
});
el.notify.addEventListener('change', () => {
  timer.updateSettings({ notify: el.notify.checked });
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resync();
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) resync();
});
window.addEventListener('storage', (e) => {
  if (e.key === null || e.key.startsWith('focusTimer:')) resync();
});

// ---------------------------------------------------------------- start

settle(timer.hydrate());
setInterval(tick, REPAINT_MS);
