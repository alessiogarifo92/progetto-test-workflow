// View model of the app shell: every branch of "what to show" lives here, pure.
// No document, window, timers or Date.now: everything comes in as arguments, so
// test/view.test.js can cover it without a DOM. src/app.js only applies the result.

import { durationMs, formatMmSs, LIMITS, remainingMs, todayCount } from './core.js';

const MIN_MS = 60000;
const clock = (min) => `${min}:00`;
const minutesLabel = (n) => `${n} ${n === 1 ? 'minute' : 'minutes'}`;
const isBreak = (phase) => phase !== 'work';

// Rows for the history list. An entry whose time cannot form a valid Date (or whose length is
// not a number) is skipped, so a corrupt entry can never throw inside a repaint.
function historyRows(history) {
  const rows = [];
  for (const h of Array.isArray(history) ? history : []) {
    try {
      if (h === null || typeof h !== 'object') continue;
      if (typeof h.endedAt !== 'number' || !Number.isFinite(h.durationMs)) continue;
      const d = new Date(h.endedAt);
      if (!Number.isFinite(d.getTime())) continue;
      const pad = (n) => String(n).padStart(2, '0');
      rows.push({
        iso: d.toISOString(),
        hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
        text: `Work ${Math.round(h.durationMs / MIN_MS)} min`,
      });
    } catch {
      // unreadable entry: leave it out
    }
  }
  return rows;
}

function labelFor(screen, state) {
  if (screen === 'running') {
    if (state.phase === 'work') return `Work · session ${state.cycle + 1}`;
    return state.phase === 'long' ? 'Long break' : 'Short break';
  }
  if (screen === 'paused') return 'Paused';
  if (screen === 'idle' && state.phase !== 'work') return state.phase === 'long' ? 'Long break ready' : 'Short break ready';
  return 'Ready';
}

function buttonsFor(screen, state, settings) {
  if (screen === 'running') return { primary: { text: 'Pause', action: 'pause' }, secondary: { text: 'Reset', action: 'reset', visible: true } };
  if (screen === 'paused') return { primary: { text: 'Resume', action: 'start' }, secondary: { text: 'Reset', action: 'reset', visible: true } };
  if (screen === 'complete') {
    const long = state.phase === 'long' ? 'long ' : '';
    return {
      primary: { text: `Start ${long}break ${clock(durationMs(state.phase, settings) / MIN_MS)}`, action: 'start' },
      secondary: { text: 'Skip', action: 'skip', visible: true },
    };
  }
  return {
    primary: { text: isBreak(state.phase) ? 'Start break' : 'Start', action: 'start' },
    secondary: { text: '', action: 'reset', visible: false },
  };
}

function quietFor(screen, state, settings, count) {
  if (screen !== 'running' && screen !== 'paused') return { visible: false, text: '' };
  const next = state.phase === 'work'
    ? `break ${clock(durationMs(state.cycle + 1 >= LIMITS.longEvery ? 'long' : 'short', settings) / MIN_MS)}`
    : `work ${clock(durationMs('work', settings) / MIN_MS)}`;
  return { visible: true, text: `Today ${count} · next: ${next}` };
}

// ui: { complete, away, lastMinute, reduceMotion, persistent, settingsOpen }
export function buildView({ state, settings, now, ui }) {
  // The complete screen only makes sense while the break that followed is still untouched.
  const complete = Boolean(ui.complete) && state.status === 'idle' && isBreak(state.phase);
  const away = complete && Boolean(ui.away);
  const screen = complete ? 'complete' : state.status;
  const active = screen === 'running' || screen === 'paused';
  const running = screen === 'running';

  const rem = remainingMs(state, settings, now);
  const shown = ui.reduceMotion ? Math.ceil(rem / 1000) * 1000 : rem;
  const planned = state.status === 'idle' ? durationMs(state.phase, settings) : state.plannedMs || rem;
  const frac = active && planned > 0 ? Math.min(1, Math.max(0, shown / planned)) : 1;

  const digits = formatMmSs(rem);
  const rows = historyRows(state.history);
  const hasHistory = rows.length > 0;
  const count = todayCount(state, now);
  const { primary, secondary } = buttonsFor(screen, state, settings);

  // one polite announcement per full minute while running; never at the moment of Start
  let announce = null;
  let lastMinute = null;
  if (running) {
    const m = Math.ceil(rem / MIN_MS);
    if (ui.lastMinute !== null && ui.lastMinute !== undefined && m !== ui.lastMinute && m > 0) {
      announce = `${minutesLabel(m)} remaining`;
    }
    lastMinute = m;
  }

  return {
    screen,
    phase: isBreak(state.phase) ? 'break' : 'work',
    complete,
    away,
    label: labelFor(screen, state),
    labelVisible: screen !== 'complete',
    headingVisible: screen === 'complete',
    awayVisible: away,
    checkVisible: screen === 'complete',
    digitsVisible: screen !== 'complete',
    digits,
    digitsLong: digits.length > 5,
    frac,
    dashed: screen === 'paused',
    primary,
    secondary,
    quiet: quietFor(screen, state, settings, count),
    todayCount: count,
    title: running ? `${digits} ${state.phase === 'work' ? 'Work' : 'Break'}` : 'Focus Timer',
    announce,
    lastMinute,
    prefsVisible: screen === 'complete' || Boolean(ui.settingsOpen),
    emptyVisible: screen === 'idle' && !hasHistory,
    historyVisible: (screen === 'idle' || screen === 'complete') && hasHistory,
    history: rows,
    unsavedVisible: !ui.persistent,
  };
}

// Announcement for a user action or a sync, given the state before and after it.
// A completion wins; a running break that ended on its own is "Break over".
export function eventAnnouncement({ type, before, state, completion }) {
  if (completion) return 'Session complete';
  const breakRan = before.status === 'running' && isBreak(before.phase);
  if (type === 'start') {
    if (before.status === 'idle' && state.status === 'running') return `Started, ${minutesLabel(Math.round(state.plannedMs / MIN_MS))}`;
    if (before.status === 'paused' && state.status === 'running') return 'Resumed';
    return null;
  }
  if (type === 'pause' && before.status === 'running' && state.status === 'paused') {
    return `Paused, ${formatMmSs(state.remainingMs)} remaining`;
  }
  if (type === 'reset' && before.status !== 'idle' && state.status === 'idle' && !(breakRan && state.phase !== before.phase)) return 'Reset';
  if (type === 'skip' && isBreak(before.phase)) return 'Break skipped';
  if (breakRan && state.status === 'idle') return 'Break over';
  return null;
}
