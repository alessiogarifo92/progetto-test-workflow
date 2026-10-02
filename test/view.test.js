import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, initialState, step } from '../src/core.js';
import { buildView, eventAnnouncement } from '../src/view.js';

// The suite runs with TZ=Europe/Rome (test/setup-tz.mjs).
const MIN = 60_000;
const S = DEFAULT_SETTINGS;
const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const T0 = local(2026, 10, 2, 10, 0);

const UI = { complete: false, away: false, lastMinute: null, reduceMotion: false, persistent: true, settingsOpen: false };
const view = (state, over = {}, now = T0, settings = S) => buildView({ state, settings, now, ui: { ...UI, ...over } });

const idle = (phase = 'work', extra = {}) => ({ ...initialState(), phase, ...extra });
const started = (phase = 'work', at = T0, extra = {}) => ({ ...step({ ...initialState(), phase, ...extra }, S, { type: 'start' }, at).state });
const paused = (phase = 'work', at = T0, pauseAt = T0 + 5 * MIN) => step(started(phase, at), S, { type: 'pause' }, pauseAt).state;
const entry = (endedAt, durationMs = 25 * MIN) => ({ id: endedAt, endedAt, durationMs });

// ---------------------------------------------------------------- screens

test('screen: idle, running, paused', () => {
  assert.equal(view(idle()).screen, 'idle');
  assert.equal(view(started()).screen, 'running');
  assert.equal(view(paused()).screen, 'paused');
});

test('screen: complete only for an idle break phase with the flag set', () => {
  assert.equal(view(idle('short'), { complete: true }).screen, 'complete');
  assert.equal(view(idle('long'), { complete: true }).screen, 'complete');
  assert.equal(view(idle('work'), { complete: true }).screen, 'idle');
  assert.equal(view(started('short'), { complete: true }).screen, 'running');
  assert.equal(view(paused('short', T0, T0 + MIN), { complete: true }).screen, 'paused');
  assert.equal(view(idle('short'), { complete: false }).screen, 'idle');
});

test('the effective complete/away flags are returned so the shell can drop stale ones', () => {
  const v = view(started(), { complete: true, away: true });
  assert.equal(v.complete, false);
  assert.equal(v.away, false);
  const w = view(idle('short'), { complete: true, away: true });
  assert.equal(w.complete, true);
  assert.equal(w.away, true);
});

test('phase accent: work vs break', () => {
  assert.equal(view(started('work')).phase, 'work');
  assert.equal(view(started('short')).phase, 'break');
  assert.equal(view(started('long')).phase, 'break');
});

// ---------------------------------------------------------------- labels and buttons

test('labels', () => {
  assert.equal(view(idle()).label, 'Ready');
  assert.equal(view(started('work')).label, 'Work · session 1');
  assert.equal(view(started('work', T0, { cycle: 2 })).label, 'Work · session 3');
  assert.equal(view(started('short')).label, 'Short break');
  assert.equal(view(started('long')).label, 'Long break');
  assert.equal(view(paused()).label, 'Paused');
  assert.equal(view(idle('short')).label, 'Short break ready');
  assert.equal(view(idle('long')).label, 'Long break ready');
});

test('label, heading and check visibility per screen', () => {
  const run = view(started());
  assert.deepEqual([run.labelVisible, run.headingVisible, run.checkVisible, run.digitsVisible], [true, false, false, true]);
  const done = view(idle('short'), { complete: true });
  assert.deepEqual([done.labelVisible, done.headingVisible, done.checkVisible, done.digitsVisible], [false, true, true, false]);
});

test('primary and secondary buttons', () => {
  const i = view(idle());
  assert.deepEqual(i.primary, { text: 'Start', action: 'start' });
  assert.equal(i.secondary.visible, false);

  const r = view(started());
  assert.deepEqual(r.primary, { text: 'Pause', action: 'pause' });
  assert.deepEqual(r.secondary, { text: 'Reset', action: 'reset', visible: true });

  const p = view(paused());
  assert.deepEqual(p.primary, { text: 'Resume', action: 'start' });
  assert.deepEqual(p.secondary, { text: 'Reset', action: 'reset', visible: true });

  const c = view(idle('short'), { complete: true });
  assert.deepEqual(c.primary, { text: 'Start break 5:00', action: 'start' });
  assert.deepEqual(c.secondary, { text: 'Skip', action: 'skip', visible: true });

  const l = view(idle('long'), { complete: true });
  assert.equal(l.primary.text, 'Start long break 15:00');

  assert.deepEqual(view(idle('short')).primary, { text: 'Start break', action: 'start' });
});

test('the break button follows the configured minutes', () => {
  const v = view(idle('short'), { complete: true }, T0, { ...S, shortMin: 7 });
  assert.equal(v.primary.text, 'Start break 7:00');
});

// ---------------------------------------------------------------- digits and ring

test('digits: running, paused, idle show the remaining/planned time', () => {
  assert.equal(view(idle()).digits, '25:00');
  assert.equal(view(started(), {}, T0 + 90_000).digits, '23:30');
  assert.equal(view(paused()).digits, '20:00');
});

test('digits that need the long class: 120:00 only', () => {
  assert.equal(view(idle('work'), {}, T0, { ...S, workMin: 120 }).digitsLong, true);
  assert.equal(view(idle('work'), {}, T0, { ...S, workMin: 120 }).digits, '120:00');
  assert.equal(view(idle()).digitsLong, false);
  assert.equal(view(idle('work'), {}, T0, { ...S, workMin: 99 }).digitsLong, false);
});

test('ring fraction', () => {
  assert.equal(view(idle()).frac, 1);
  assert.equal(view(idle('short'), { complete: true }).frac, 1);
  assert.equal(view(started()).frac, 1);
  assert.equal(view(started(), {}, T0 + 12.5 * MIN).frac, 0.5);
  assert.equal(view(paused()).frac, 20 / 25);
  assert.equal(view(started(), {}, T0 + 25 * MIN).frac, 0);
  assert.equal(view(started(), {}, T0 + 26 * MIN).frac, 0); // never negative
  assert.equal(view(paused()).dashed, true);
  assert.equal(view(started()).dashed, false);
});

test('ring fraction moves in whole seconds under reduceMotion', () => {
  const at = T0 + 500; // 24:59.5 left
  const smooth = view(started(), {}, at).frac;
  const stepped = view(started(), { reduceMotion: true }, at).frac;
  assert.equal(smooth, (25 * MIN - 500) / (25 * MIN));
  assert.equal(stepped, (25 * MIN - 0) / (25 * MIN)); // 24:59.5 rounds up to 25:00
  assert.equal(view(started(), { reduceMotion: true }, T0 + 1500).frac, (25 * MIN - 1000) / (25 * MIN));
});

// ---------------------------------------------------------------- quiet line

test('quiet line: next break prediction at cycle 0..3', () => {
  const quiet = (cycle) => view(started('work', T0, { cycle })).quiet;
  assert.deepEqual(quiet(0), { visible: true, text: 'Today 0 · next: break 5:00' });
  assert.equal(quiet(1).text, 'Today 0 · next: break 5:00');
  assert.equal(quiet(2).text, 'Today 0 · next: break 5:00');
  assert.equal(quiet(3).text, 'Today 0 · next: break 15:00');
});

test('quiet line: after a break the next is work; shows the day count; hidden off-run', () => {
  const today = { day: '2026-10-02', count: 3 };
  assert.equal(view(started('short', T0, { today })).quiet.text, 'Today 3 · next: work 25:00');
  assert.equal(view(paused('work')).quiet.visible, true);
  assert.equal(view(idle()).quiet.visible, false);
  assert.equal(view(idle('short'), { complete: true }).quiet.visible, false);
});

test('today count is zero when the stored day is not today', () => {
  const old = { day: '2026-10-01', count: 4 };
  assert.equal(view(idle('work', { today: old })).todayCount, 0);
  assert.equal(view(idle('work', { today: { day: '2026-10-02', count: 4 } })).todayCount, 4);
});

// ---------------------------------------------------------------- title

test('title mirrors the countdown only while running', () => {
  assert.equal(view(started(), {}, T0 + 47_000).title, '24:13 Work');
  assert.equal(view(started('short')).title, '05:00 Break');
  assert.equal(view(started('long')).title, '15:00 Break');
  assert.equal(view(paused()).title, 'Focus Timer');
  assert.equal(view(idle()).title, 'Focus Timer');
  assert.equal(view(idle('short'), { complete: true }).title, 'Focus Timer');
});

// ---------------------------------------------------------------- announcements

test('minute announcements: not at start, once per full minute, never repeated', () => {
  const st = started();
  let ui = { lastMinute: null };
  let v = view(st, ui, T0);
  assert.equal(v.announce, null); // nothing at Start (the click announces)
  assert.equal(v.lastMinute, 25);

  ui = { lastMinute: v.lastMinute };
  v = view(st, ui, T0 + 30_000); // 24:30 left, still the 25th minute
  assert.equal(v.announce, null);
  assert.equal(v.lastMinute, 25);

  v = view(st, ui, T0 + 60_000); // 24:00 left: full minute mark
  assert.equal(v.announce, '24 minutes remaining');
  assert.equal(v.lastMinute, 24);

  v = view(st, { lastMinute: 24 }, T0 + 60_000 + 250); // same minute again
  assert.equal(v.announce, null);
});

test('minute announcements: singular, and nothing at zero', () => {
  const st = started();
  assert.equal(view(st, { lastMinute: 2 }, T0 + 24 * MIN).announce, '1 minute remaining');
  assert.equal(view(st, { lastMinute: 1 }, T0 + 25 * MIN).announce, null);
});

test('minute announcements reset when not running', () => {
  assert.equal(view(paused(), { lastMinute: 12 }).lastMinute, null);
  assert.equal(view(idle(), { lastMinute: 12 }).lastMinute, null);
  assert.equal(view(paused(), { lastMinute: 12 }).announce, null);
});

test('event announcements: Started, Resumed, Paused, Reset, Break skipped', () => {
  const run = started();
  const stop = paused();
  assert.equal(eventAnnouncement({ type: 'start', before: idle(), state: run, completion: null }), 'Started, 25 minutes');
  assert.equal(eventAnnouncement({ type: 'start', before: idle(), state: started('work'), completion: null }), 'Started, 25 minutes');
  assert.equal(eventAnnouncement({ type: 'start', before: idle('short'), state: started('short'), completion: null }), 'Started, 5 minutes');
  assert.equal(eventAnnouncement({ type: 'start', before: stop, state: run, completion: null }), 'Resumed');
  assert.equal(eventAnnouncement({ type: 'start', before: run, state: run, completion: null }), null); // already running
  assert.equal(eventAnnouncement({ type: 'pause', before: run, state: stop, completion: null }), 'Paused, 20:00 remaining');
  assert.equal(eventAnnouncement({ type: 'pause', before: idle(), state: idle(), completion: null }), null);
  assert.equal(eventAnnouncement({ type: 'reset', before: run, state: idle(), completion: null }), 'Reset');
  assert.equal(eventAnnouncement({ type: 'reset', before: stop, state: idle(), completion: null }), 'Reset');
  assert.equal(eventAnnouncement({ type: 'reset', before: idle(), state: idle(), completion: null }), null);
  assert.equal(eventAnnouncement({ type: 'skip', before: idle('short'), state: idle('work'), completion: null }), 'Break skipped');
  assert.equal(eventAnnouncement({ type: 'skip', before: started('long'), state: idle('work'), completion: null }), 'Break skipped');
});

test('a one minute session is announced in the singular', () => {
  const state = { ...started(), plannedMs: MIN };
  assert.equal(eventAnnouncement({ type: 'start', before: idle(), state, completion: null }), 'Started, 1 minute');
});

test('event announcements: Session complete wins, Break over when a running break ends', () => {
  const done = { id: 1, endedAt: 1, durationMs: 25 * MIN, phase: 'work' };
  assert.equal(eventAnnouncement({ type: 'sync', before: started(), state: idle('short'), completion: done }), 'Session complete');
  assert.equal(eventAnnouncement({ type: 'start', before: started(), state: started('short'), completion: done }), 'Session complete');

  const brk = started('short');
  assert.equal(eventAnnouncement({ type: 'sync', before: brk, state: idle('work'), completion: null }), 'Break over');
  assert.equal(eventAnnouncement({ type: 'pause', before: brk, state: idle('work'), completion: null }), 'Break over');
  assert.equal(eventAnnouncement({ type: 'reset', before: brk, state: idle('work'), completion: null }), 'Break over');
  assert.equal(eventAnnouncement({ type: 'sync', before: brk, state: brk, completion: null }), null);
  assert.equal(eventAnnouncement({ type: 'sync', before: started('work'), state: started('work'), completion: null }), null);
  assert.equal(eventAnnouncement({ type: 'sync', before: idle('short'), state: idle('short'), completion: null }), null);
});

// ---------------------------------------------------------------- panels

test('empty vs non-empty history panels', () => {
  const none = view(idle());
  assert.deepEqual([none.emptyVisible, none.historyVisible, none.history], [true, false, []]);

  const some = view(idle('work', { history: [entry(T0 - MIN)] }));
  assert.deepEqual([some.emptyVisible, some.historyVisible], [false, true]);

  // running screens show neither
  const run = view(started('work', T0, { history: [entry(T0 - MIN)] }));
  assert.deepEqual([run.emptyVisible, run.historyVisible], [false, false]);
  assert.deepEqual([view(started()).emptyVisible, view(paused()).emptyVisible], [false, false]);

  const done = view(idle('short', { history: [entry(T0 - MIN)] }), { complete: true });
  assert.equal(done.historyVisible, true);
  assert.equal(done.emptyVisible, false);
});

test('history rows: local HH:MM, ISO time, "Work N min"', () => {
  const at = local(2026, 10, 2, 9, 5);
  const v = view(idle('work', { history: [entry(at, 25 * MIN), entry(at - 3_600_000, 90 * MIN)] }));
  assert.deepEqual(v.history, [
    { iso: new Date(at).toISOString(), hhmm: '09:05', text: 'Work 25 min' },
    { iso: new Date(at - 3_600_000).toISOString(), hhmm: '08:05', text: 'Work 90 min' },
  ]);
});

test('history rows: an entry whose endedAt cannot form a Date is skipped, never throws', () => {
  const good = entry(local(2026, 10, 2, 9, 5));
  const bad = [
    { id: 1, endedAt: 1e16, durationMs: 25 * MIN },
    { id: 2, endedAt: NaN, durationMs: 25 * MIN },
    { id: 3, endedAt: 'soon', durationMs: 25 * MIN },
    { id: 4, endedAt: Infinity, durationMs: 25 * MIN },
    { id: 5, endedAt: undefined, durationMs: 25 * MIN },
    { id: 6, endedAt: local(2026, 10, 2, 9, 6), durationMs: NaN },
    null,
  ];
  let v;
  assert.doesNotThrow(() => { v = view(idle('work', { history: [...bad, good] })); });
  assert.equal(v.history.length, 1);
  assert.equal(v.history[0].hhmm, '09:05');
  assert.equal(v.historyVisible, true);

  // only bad entries: behaves like an empty history
  const allBad = view(idle('work', { history: bad }));
  assert.deepEqual([allBad.history, allBad.historyVisible, allBad.emptyVisible], [[], false, true]);
});

test('prefs panel: complete screen or open settings sheet', () => {
  assert.equal(view(idle()).prefsVisible, false);
  assert.equal(view(started()).prefsVisible, false);
  assert.equal(view(idle('short'), { complete: true }).prefsVisible, true);
  assert.equal(view(idle(), { settingsOpen: true }).prefsVisible, true);
  assert.equal(view(started(), { settingsOpen: true }).prefsVisible, true);
});

test('away note only when the complete screen carries the away flag', () => {
  assert.equal(view(idle('short'), { complete: true, away: true }).awayVisible, true);
  assert.equal(view(idle('short'), { complete: true, away: false }).awayVisible, false);
  assert.equal(view(idle(), { complete: false, away: true }).awayVisible, false);
});

test('not-saved notice follows ui.persistent', () => {
  assert.equal(view(idle(), { persistent: true }).unsavedVisible, false);
  assert.equal(view(idle(), { persistent: false }).unsavedVisible, true);
});
