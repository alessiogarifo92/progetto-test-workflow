// App shell: the only module that touches document, window, timers, Date.now and storage.
// What to show is decided in view.js (pure, tested); this file wires events to the timer and
// applies the view to the DOM. Time comes from core (endAt), never from the repaint interval.
// The end of a session is ONE unchained setTimeout armed only from commit(); every other path
// just re-syncs through dispatch.

import { createTimer, endDelay, remainingMs, shouldAlert } from './core.js';
import { createAlerts } from './alerts.js';
import { createStore, getLocalStorage } from './store.js';
import { buildView, eventAnnouncement } from './view.js';

const store = createStore(getLocalStorage());
const timer = createTimer({ now: () => Date.now(), store });
const alerts = createAlerts({
  AudioContextCtor: window.AudioContext || window.webkitAudioContext,
  NotificationApi: window.Notification,
});

const RING_C = 2 * Math.PI * 135; // circumference of the 280px ring (r = 135)
const REPAINT_MS = 250;
const ANNOUNCE_DELAY_MS = 50;

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'), todayCount: $('today-count'), emptyCount: $('empty-count'),
  settingsBtn: $('settings-btn'), settings: $('settings'), stage: $('stage'),
  setWork: $('set-work'), setShort: $('set-short'), setLong: $('set-long'),
  progress: $('ring-progress'), maskArc: $('ring-mask-arc'),
  digits: $('digits'), check: $('check'), heading: $('heading'), label: $('label'), awayNote: $('away-note'),
  primary: $('btn-primary'), secondary: $('btn-secondary'), quiet: $('quiet'), unsaved: $('unsaved'),
  prefs: $('prefs'), notifyHint: $('notify-hint'), sound: $('pref-sound'), notify: $('pref-notify'),
  empty: $('empty'), history: $('history'), historyList: $('history-list'),
  live: $('live'),
};
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let handle = null; // the one pending end-of-session timeout
let announceHandle = null;
let complete = false; // UI flag: the complete screen is showing
let away = false; // that completion was noticed late (not worth an alert)
let lastMinute = null; // last full-minute mark seen while running
let settingsOpen = false;
let historySig = '';

// ---------------------------------------------------------------- wiring

// The only place the end timeout is armed.
function commit() {
  clearTimeout(handle);
  handle = null;
  const d = endDelay(timer.getState(), Date.now());
  if (d !== null) handle = setTimeout(onDue, d);
}

// After any dispatch/hydrate: remember a completion, re-arm, repaint.
function settle(completion, text) {
  if (completion) {
    complete = true;
    away = !shouldAlert(completion, Date.now());
    if (!away) fireAlerts();
  }
  commit();
  render(text);
}

// Chime and system notification for a session that ended just now (the 60 s grace is the core's call).
function fireAlerts() {
  const settings = timer.getSettings();
  if (settings.sound) alerts.chime();
  if (settings.notify) alerts.notify('Session complete', 'Time for a break.');
}

function run(type) {
  const before = timer.getState();
  const completion = timer.dispatch({ type });
  settle(completion, eventAnnouncement({ type, before, state: timer.getState(), completion }));
}

function onDue() {
  run('sync');
}

function act(type) {
  if (type !== 'pause') {
    complete = false;
    away = false;
  }
  run(type);
  // Reset and Skip hide the secondary button that had focus: keep focus on a live control.
  if (type === 'reset' || type === 'skip') el.primary.focus();
}

// ---------------------------------------------------------------- render

// toggleAttribute, not .hidden: SVG elements have no hidden property.
function show(node, on) {
  node.toggleAttribute('hidden', !on);
}

// A text change in an aria-live node is only spoken when the text differs: clear first, then set
// in the next task so identical consecutive messages are announced again.
function announce(text) {
  clearTimeout(announceHandle);
  el.live.textContent = '';
  announceHandle = setTimeout(() => {
    el.live.textContent = text;
  }, ANNOUNCE_DELAY_MS);
}

function renderHistory(rows) {
  const sig = rows.map((r) => r.iso).join(',');
  if (sig === historySig) return;
  historySig = sig;
  el.historyList.replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = r.iso;
    time.textContent = r.hhmm;
    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = r.text;
    li.append(time, dur);
    return li;
  }));
}

function syncInput(input, value) {
  if (document.activeElement !== input) input.value = String(value);
}

function render(eventText = null) {
  const settings = timer.getSettings();
  const v = buildView({
    state: timer.getState(),
    settings,
    now: Date.now(),
    ui: { complete, away, lastMinute, reduceMotion: reduceMotion.matches, persistent: store.isPersistent(), settingsOpen },
  });
  complete = v.complete;
  away = v.away;
  lastMinute = v.lastMinute;

  el.app.dataset.screen = v.screen;
  el.app.dataset.phase = v.phase;

  el.maskArc.setAttribute('stroke-dasharray', String(RING_C));
  el.maskArc.setAttribute('stroke-dashoffset', String(RING_C * (1 - v.frac)));
  if (v.dashed) el.progress.setAttribute('stroke-dasharray', '2 8');
  else el.progress.removeAttribute('stroke-dasharray');

  el.digits.textContent = v.digits;
  el.digits.classList.toggle('long', v.digitsLong);
  show(el.digits, v.digitsVisible);
  show(el.check, v.checkVisible);
  show(el.heading, v.headingVisible);
  show(el.label, v.labelVisible);
  show(el.awayNote, v.awayVisible);
  el.label.textContent = v.label;

  el.primary.dataset.action = v.primary.action;
  el.primary.textContent = v.primary.text;
  show(el.secondary, v.secondary.visible);
  if (v.secondary.visible) {
    el.secondary.dataset.action = v.secondary.action;
    el.secondary.textContent = v.secondary.text;
  }

  el.todayCount.textContent = String(v.todayCount);
  el.emptyCount.textContent = String(v.todayCount);
  show(el.quiet, v.quiet.visible);
  el.quiet.textContent = v.quiet.text;
  show(el.empty, v.emptyVisible);
  show(el.history, v.historyVisible);
  show(el.prefs, v.prefsVisible);
  show(el.unsaved, v.unsavedVisible);
  renderHistory(v.history);

  el.sound.checked = settings.sound;
  el.notify.checked = settings.notify;
  syncInput(el.setWork, settings.workMin);
  syncInput(el.setShort, settings.shortMin);
  syncInput(el.setLong, settings.longMin);

  document.title = v.title;
  const text = eventText ?? v.announce;
  if (text) announce(text);
}

// Safety net only: the repaint never decides time, it just notices an end the timeout missed.
function tick() {
  const state = timer.getState();
  if (state.status === 'running' && remainingMs(state, timer.getSettings(), Date.now()) <= 0) onDue();
  else render();
}

// ---------------------------------------------------------------- events

// A double-click or double-tap on the shared primary button must not Start and then Pause.
el.primary.addEventListener('click', (e) => {
  alerts.prime(); // browsers only start audio inside a user gesture, so every Start click primes it
  if (e.detail > 1) return;
  act(el.primary.dataset.action);
});
el.secondary.addEventListener('click', () => act(el.secondary.dataset.action));

// The alert toggles live in the complete-screen panel and in the settings sheet: one node, moved.
el.settingsBtn.addEventListener('click', () => {
  settingsOpen = el.settingsBtn.getAttribute('aria-expanded') !== 'true';
  el.settingsBtn.setAttribute('aria-expanded', String(settingsOpen));
  show(el.settings, settingsOpen);
  if (settingsOpen) el.settings.append(el.prefs);
  else el.stage.after(el.prefs);
  render();
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
// Permission is asked only here, from the click on the toggle, never on load.
el.notify.addEventListener('change', async () => {
  const wanted = el.notify.checked;
  show(el.notifyHint, false);
  timer.updateSettings({ notify: wanted });
  if (wanted) {
    const result = await alerts.requestPermission();
    if (result !== 'granted') {
      timer.updateSettings({ notify: false });
      el.notifyHint.textContent = result === 'denied'
        ? 'Notifications are blocked for this site in the browser settings.'
        : 'This browser does not support notifications.';
      show(el.notifyHint, true);
    }
  }
  render();
});

// A reload or another tab can resume a running session without a Start click: prime on the first gesture.
for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => alerts.prime(), { once: true });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') run('sync');
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) run('sync');
});
window.addEventListener('storage', (e) => {
  if (e.key === null || e.key.startsWith('focusTimer:')) run('sync');
});

// ---------------------------------------------------------------- start

// The repaint safety net is armed first, so a failure in the first render cannot disable it.
setInterval(tick, REPAINT_MS);
try {
  const completion = timer.hydrate();
  settle(completion, completion ? 'Session complete' : null);
} catch (err) {
  console.error(err);
}
