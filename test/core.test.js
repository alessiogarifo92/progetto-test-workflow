import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  DEFAULT_SETTINGS,
  clampMinutes,
  normalizeSettings,
  normalizeState,
  initialState,
  durationMs,
  step,
  remainingMs,
  formatMmSs,
  endDelay,
  todayCount,
  dayKey,
  shouldAlert,
  createTimer,
} from '../src/core.js';

// The suite runs with TZ=Europe/Rome (test/setup-tz.mjs). Dates are built with
// local constructors so the day-key tests are deterministic.
const MIN = 60_000;
const S = DEFAULT_SETTINGS;
const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const T0 = local(2026, 10, 2, 10, 0);

const ev = (type) => ({ type });
const run = (state, type, now, settings = S) => step(state, settings, ev(type), now);

// A state running a work session started at `at`.
const working = (at = T0, extra = {}) => ({ ...run(initialState(), 'start', at).state, ...extra });
// A state running a break phase started at `at`.
const onBreak = (phase, at = T0) => run({ ...initialState(), phase }, 'start', at).state;

function fakeStore({ state = null, settings = null } = {}) {
  const s = { state, settings, saves: 0, settingsSaves: 0 };
  return {
    s,
    loadState: () => (s.state === null ? null : structuredClone(s.state)),
    saveState: (o) => { s.state = structuredClone(o); s.saves += 1; return true; },
    loadSettings: () => (s.settings === null ? null : structuredClone(s.settings)),
    saveSettings: (o) => { s.settings = structuredClone(o); s.settingsSaves += 1; return true; },
  };
}

// ---------------------------------------------------------------- constants

test('constants and defaults', () => {
  assert.deepEqual(LIMITS, { minMin: 1, maxMin: 120, historyMax: 10, longEvery: 4, alertGraceMs: 60000 });
  assert.deepEqual(DEFAULT_SETTINGS, { workMin: 25, shortMin: 5, longMin: 15, sound: true, notify: false });
  assert.deepEqual(initialState(), {
    phase: 'work', status: 'idle', endAt: null, remainingMs: null, plannedMs: null,
    cycle: 0, today: { day: '', count: 0 }, history: [],
  });
});

test('initialState returns a fresh object each time', () => {
  const a = initialState();
  a.history.push({ id: 1 });
  assert.deepEqual(initialState().history, []);
});

// ---------------------------------------------------------------- clampMinutes

test('clampMinutes: edges and invalid input', () => {
  assert.equal(clampMinutes(0, 25), 1);
  assert.equal(clampMinutes(1, 25), 1);
  assert.equal(clampMinutes(120, 25), 120);
  assert.equal(clampMinutes(121, 25), 120);
  assert.equal(clampMinutes(-5, 25), 1);
  assert.equal(clampMinutes(2.5, 25), 3);
  assert.equal(clampMinutes(2.4, 25), 2);
  assert.equal(clampMinutes('30', 25), 30);
  assert.equal(clampMinutes('', 25), 25);
  assert.equal(clampMinutes('   ', 25), 25);
  assert.equal(clampMinutes('abc', 25), 25);
  assert.equal(clampMinutes(null, 25), 25);
  assert.equal(clampMinutes(undefined, 25), 25);
  assert.equal(clampMinutes(NaN, 25), 25);
  assert.equal(clampMinutes(Infinity, 25), 25);
  assert.equal(clampMinutes(true, 25), 25);
  assert.equal(clampMinutes({}, 25), 25);
  assert.equal(clampMinutes([], 25), 25);
});

// ---------------------------------------------------------------- normalizeSettings

test('normalizeSettings: valid, partial and garbage input never throws', () => {
  assert.deepEqual(normalizeSettings({ workMin: 30, shortMin: 10, longMin: 20, sound: false, notify: true }),
    { workMin: 30, shortMin: 10, longMin: 20, sound: false, notify: true });
  assert.deepEqual(normalizeSettings({ workMin: 500, shortMin: 'x', sound: 'yes', notify: 1 }),
    { workMin: 120, shortMin: 5, longMin: 15, sound: true, notify: false });
  for (const raw of [null, undefined, 42, 'str', [], true, () => {}]) {
    assert.deepEqual(normalizeSettings(raw), DEFAULT_SETTINGS);
  }
  assert.notEqual(normalizeSettings(null), DEFAULT_SETTINGS, 'returns a copy, not the shared default');
});

// ---------------------------------------------------------------- durations / formatting

test('durationMs uses clamped settings per phase', () => {
  assert.equal(durationMs('work', S), 25 * MIN);
  assert.equal(durationMs('short', S), 5 * MIN);
  assert.equal(durationMs('long', S), 15 * MIN);
  assert.equal(durationMs('work', { ...S, workMin: 999 }), 120 * MIN);
  assert.equal(durationMs('short', { ...S, shortMin: 'abc' }), 5 * MIN);
  assert.equal(durationMs('bogus', S), 25 * MIN);
});

test('formatMmSs rounds seconds up', () => {
  assert.equal(formatMmSs(1), '00:01');
  assert.equal(formatMmSs(1000), '00:01');
  assert.equal(formatMmSs(1001), '00:02');
  assert.equal(formatMmSs(0), '00:00');
  assert.equal(formatMmSs(25 * MIN), '25:00');
  assert.equal(formatMmSs(25 * MIN - 1), '25:00');
  assert.equal(formatMmSs(59_001), '01:00');
  assert.equal(formatMmSs(120 * MIN), '120:00');
});

test('formatMmSs clamps negative and non-finite input to 00:00', () => {
  assert.equal(formatMmSs(-1), '00:00');
  assert.equal(formatMmSs(-99999), '00:00');
  assert.equal(formatMmSs(NaN), '00:00');
  assert.equal(formatMmSs(Infinity), '00:00');
  assert.equal(formatMmSs(undefined), '00:00');
});

// ---------------------------------------------------------------- dayKey / todayCount

test('dayKey is the LOCAL date, not UTC', () => {
  // 2026-10-03 00:30 Rome is 2026-10-02 22:30 UTC.
  assert.equal(dayKey(local(2026, 10, 3, 0, 30)), '2026-10-03');
  assert.equal(dayKey(local(2026, 10, 2, 23, 59, 59)), '2026-10-02');
  assert.equal(dayKey(local(2026, 1, 5, 12)), '2026-01-05');
  assert.equal(dayKey(local(2026, 12, 31, 23, 59)), '2026-12-31');
});

test('todayCount: 0 when the stored day is not today', () => {
  const st = { ...initialState(), today: { day: '2026-10-02', count: 3 } };
  assert.equal(todayCount(st, local(2026, 10, 2, 8)), 3);
  assert.equal(todayCount(st, local(2026, 10, 3, 0, 1)), 0);
  assert.equal(todayCount(initialState(), T0), 0);
});

// ---------------------------------------------------------------- endDelay / remainingMs

test('endDelay: ms to endAt while running, never negative, null otherwise', () => {
  const st = working(T0);
  assert.equal(endDelay(st, T0 + 1000), 25 * MIN - 1000);
  assert.equal(endDelay(st, T0 + 25 * MIN), 0);
  assert.equal(endDelay(st, T0 + 99 * MIN), 0);
  assert.equal(endDelay(initialState(), T0), null);
  assert.equal(endDelay(run(st, 'pause', T0 + MIN).state, T0 + MIN), null);
});

test('remainingMs per status', () => {
  const st = working(T0);
  assert.equal(remainingMs(initialState(), S, T0), 25 * MIN);
  assert.equal(remainingMs({ ...initialState(), phase: 'long' }, S, T0), 15 * MIN);
  assert.equal(remainingMs(st, S, T0 + 5 * MIN), 20 * MIN);
  assert.equal(remainingMs(st, S, T0 + 99 * MIN), 0);
  const paused = run(st, 'pause', T0 + 5 * MIN).state;
  assert.equal(remainingMs(paused, S, T0 + 500 * MIN), 20 * MIN);
});

// ---------------------------------------------------------------- transition table

test('row 1: idle + start -> running with endAt = now + duration', () => {
  const { state, completed } = run(initialState(), 'start', T0);
  assert.equal(completed, null);
  assert.equal(state.status, 'running');
  assert.equal(state.phase, 'work');
  assert.equal(state.endAt, T0 + 25 * MIN);
  assert.equal(state.plannedMs, 25 * MIN);
  assert.equal(state.remainingMs, null);
});

test('row 1: start on a break phase uses that phase duration and settings', () => {
  const st = run({ ...initialState(), phase: 'long' }, 'start', T0, { ...S, longMin: 20 }).state;
  assert.equal(st.endAt, T0 + 20 * MIN);
  assert.equal(st.plannedMs, 20 * MIN);
});

test('row 2: running + pause -> paused with remaining time', () => {
  const st = run(working(T0), 'pause', T0 + 10 * MIN).state;
  assert.equal(st.status, 'paused');
  assert.equal(st.remainingMs, 15 * MIN);
  assert.equal(st.endAt, null);
  assert.equal(st.plannedMs, 25 * MIN);
});

test('row 3: paused + start -> running again with endAt = now + remaining', () => {
  const paused = run(working(T0), 'pause', T0 + 10 * MIN).state;
  const st = run(paused, 'start', T0 + 40 * MIN).state;
  assert.equal(st.status, 'running');
  assert.equal(st.endAt, T0 + 40 * MIN + 15 * MIN);
  assert.equal(st.remainingMs, null);
  assert.equal(st.plannedMs, 25 * MIN);
});

test('row 4: running + sync at now >= endAt completes the work session', () => {
  const st = working(T0);
  const { state, completed } = run(st, 'sync', T0 + 25 * MIN);
  assert.deepEqual(completed, { id: T0 + 25 * MIN, endedAt: T0 + 25 * MIN, durationMs: 25 * MIN, phase: 'work' });
  assert.equal(state.phase, 'short');
  assert.equal(state.status, 'idle');
  assert.equal(state.endAt, null);
  assert.equal(state.plannedMs, null);
  assert.equal(state.cycle, 1);
  assert.deepEqual(state.history, [{ id: T0 + 25 * MIN, endedAt: T0 + 25 * MIN, durationMs: 25 * MIN }]);
  assert.deepEqual(state.today, { day: '2026-10-02', count: 1 });
});

test('row 5: running + sync before endAt is unchanged (same reference)', () => {
  const st = working(T0);
  const { state, completed } = run(st, 'sync', T0 + 25 * MIN - 1);
  assert.equal(state, st);
  assert.equal(completed, null);
});

test('row 6: idle and paused + sync are no-ops', () => {
  const idle = initialState();
  assert.equal(run(idle, 'sync', T0).state, idle);
  const paused = run(working(T0), 'pause', T0 + MIN).state;
  const r = run(paused, 'sync', T0 + 999 * MIN);
  assert.equal(r.state, paused);
  assert.equal(r.completed, null);
});

test('row 7: reset from running and paused -> idle, same phase, nothing recorded', () => {
  for (const st of [working(T0, { cycle: 2 }), run(working(T0, { cycle: 2 }), 'pause', T0 + MIN).state]) {
    const { state, completed } = run(st, 'reset', T0 + 2 * MIN);
    assert.equal(completed, null);
    assert.equal(state.status, 'idle');
    assert.equal(state.phase, 'work');
    assert.equal(state.cycle, 2);
    assert.equal(state.endAt, null);
    assert.equal(state.remainingMs, null);
    assert.equal(state.plannedMs, null);
    assert.deepEqual(state.history, []);
    assert.deepEqual(state.today, { day: '', count: 0 });
  }
});

test('row 7: reset keeps the break phase it was in', () => {
  const state = run(onBreak('long'), 'reset', T0 + MIN).state;
  assert.equal(state.phase, 'long');
  assert.equal(state.status, 'idle');
});

test('row 8: idle + reset is a no-op (same reference)', () => {
  const idle = initialState();
  assert.equal(run(idle, 'reset', T0).state, idle);
});

test('rows 10 and 11: start while running and pause while idle/paused are no-ops', () => {
  const running = working(T0);
  assert.equal(run(running, 'start', T0 + MIN).state, running);
  const idle = initialState();
  assert.equal(run(idle, 'pause', T0).state, idle);
  const paused = run(running, 'pause', T0 + MIN).state;
  assert.equal(run(paused, 'pause', T0 + 2 * MIN).state, paused);
});

test('unknown event type is a no-op and does not throw', () => {
  const st = working(T0);
  assert.equal(step(st, S, { type: 'bogus' }, T0 + MIN).state, st);
  assert.equal(step(st, S, {}, T0 + MIN).state, st);
});

test('step is pure: the input state is never mutated', () => {
  const st = working(T0);
  const frozen = structuredClone(st);
  run(st, 'sync', T0 + 30 * MIN);
  run(st, 'pause', T0 + MIN);
  run(st, 'skip', T0 + MIN);
  assert.deepEqual(st, frozen);
});

// ---------------------------------------------------------------- reset around the end (Rule 0)

test('reset 1 s after start (24:59 left) records nothing', () => {
  const { state, completed } = run(working(T0), 'reset', T0 + 1000);
  assert.equal(completed, null);
  assert.equal(state.status, 'idle');
  assert.equal(state.phase, 'work');
  assert.deepEqual(state.history, []);
  assert.equal(state.cycle, 0);
});

test('reset at 00:01 remaining records nothing', () => {
  const { state, completed } = run(working(T0), 'reset', T0 + 25 * MIN - 1000);
  assert.equal(completed, null);
  assert.equal(state.phase, 'work');
  assert.equal(state.status, 'idle');
  assert.deepEqual(state.history, []);
  assert.deepEqual(state.today, { day: '', count: 0 });
});

test('reset at exactly 00:00 records the session first (Rule 0), then is a no-op', () => {
  const { state, completed } = run(working(T0), 'reset', T0 + 25 * MIN);
  assert.equal(completed.id, T0 + 25 * MIN);
  assert.equal(state.history.length, 1);
  assert.equal(state.phase, 'short');
  assert.equal(state.status, 'idle');
  assert.equal(state.cycle, 1);
  assert.equal(state.today.count, 1);
});

test('reset long after the end records with endedAt = endAt, not the click time', () => {
  const { state, completed } = run(working(T0), 'reset', T0 + 90 * MIN);
  assert.equal(completed.endedAt, T0 + 25 * MIN);
  assert.equal(state.history[0].endedAt, T0 + 25 * MIN);
});

test('pause at or after endAt records first, then pause is a no-op on the next phase', () => {
  const { state, completed } = run(working(T0), 'pause', T0 + 25 * MIN);
  assert.ok(completed);
  assert.equal(state.status, 'idle');
  assert.equal(state.phase, 'short');
  assert.equal(state.history.length, 1);
});

test('start at or after endAt records first, then starts the next phase', () => {
  const { state, completed } = run(working(T0), 'start', T0 + 26 * MIN);
  assert.ok(completed);
  assert.equal(state.phase, 'short');
  assert.equal(state.status, 'running');
  assert.equal(state.endAt, T0 + 26 * MIN + 5 * MIN);
});

test('skip after the end records first, then skips the new current phase', () => {
  const { state, completed } = run(working(T0), 'skip', T0 + 26 * MIN);
  assert.ok(completed);
  assert.equal(state.phase, 'work');
  assert.equal(state.status, 'idle');
  assert.equal(state.history.length, 1);
  assert.equal(state.cycle, 1);
});

test('a paused session resumed and completed counts once, with the planned duration', () => {
  let st = working(T0);
  st = run(st, 'pause', T0 + 10 * MIN).state;
  st = run(st, 'start', T0 + 20 * MIN).state;
  st = run(st, 'pause', T0 + 22 * MIN).state;
  st = run(st, 'start', T0 + 30 * MIN).state;
  const end = st.endAt;
  assert.equal(end, T0 + 30 * MIN + 13 * MIN);
  const { state, completed } = run(st, 'sync', end);
  assert.equal(completed.durationMs, 25 * MIN);
  assert.equal(completed.endedAt, end);
  assert.equal(state.history.length, 1);
});

// ---------------------------------------------------------------- skip

test('skip: work -> short, short -> work, long -> work; nothing recorded, cycle unchanged', () => {
  for (const [from, to] of [['work', 'short'], ['short', 'work'], ['long', 'work']]) {
    const idle = { ...initialState(), phase: from, cycle: 2 };
    const { state, completed } = run(idle, 'skip', T0);
    assert.equal(completed, null);
    assert.equal(state.phase, to);
    assert.equal(state.status, 'idle');
    assert.equal(state.cycle, 2);
    assert.deepEqual(state.history, []);
    assert.deepEqual(state.today, { day: '', count: 0 });
  }
});

test('skip while running or paused drops the session without recording', () => {
  const running = working(T0, { cycle: 1 });
  const a = run(running, 'skip', T0 + 10 * MIN);
  assert.equal(a.state.phase, 'short');
  assert.equal(a.state.status, 'idle');
  assert.equal(a.state.endAt, null);
  assert.equal(a.state.cycle, 1);
  assert.deepEqual(a.state.history, []);
  const paused = run(running, 'pause', T0 + MIN).state;
  const b = run(paused, 'skip', T0 + 2 * MIN);
  assert.equal(b.state.phase, 'short');
  assert.equal(b.state.remainingMs, null);
  assert.equal(b.state.plannedMs, null);
  assert.deepEqual(b.state.history, []);
});

test('skipping a work session does not count towards the long break', () => {
  let st = initialState();
  let t = T0;
  for (let i = 0; i < 3; i++) {
    st = run(st, 'start', t).state;
    t += 25 * MIN;
    st = run(st, 'sync', t).state;
    st = run(st, 'skip', t).state; // skip the break
  }
  assert.equal(st.cycle, 3);
  st = run(st, 'start', t).state;
  st = run(st, 'skip', t + MIN).state; // skipped work, not counted
  assert.equal(st.phase, 'short');
  assert.equal(st.cycle, 3);
});

// ---------------------------------------------------------------- cycle / long break

test('works 1..3 go to short break, the 4th goes to long and resets the cycle', () => {
  let st = initialState();
  let t = T0;
  const expected = ['short', 'short', 'short', 'long'];
  for (let i = 0; i < 4; i++) {
    st = run(st, 'start', t).state;
    t += 25 * MIN;
    const r = run(st, 'sync', t);
    st = r.state;
    assert.equal(r.completed.phase, 'work');
    assert.equal(st.phase, expected[i], `after work #${i + 1}`);
    assert.equal(st.cycle, i === 3 ? 0 : i + 1);
    // run the break to its end: back to work, idle, not recorded
    st = run(st, 'start', t).state;
    t += 20 * MIN;
    const b = run(st, 'sync', t);
    assert.equal(b.completed, null);
    st = b.state;
    assert.equal(st.phase, 'work');
    assert.equal(st.status, 'idle');
  }
  assert.equal(st.history.length, 4);
  assert.equal(st.today.count, 4);
});

test('break completion is never recorded or counted and never auto-starts', () => {
  const st = { ...onBreak('short'), cycle: 1, today: { day: dayKey(T0), count: 2 } };
  const { state, completed } = run(st, 'sync', T0 + 5 * MIN);
  assert.equal(completed, null);
  assert.equal(state.phase, 'work');
  assert.equal(state.status, 'idle');
  assert.equal(state.cycle, 1);
  assert.equal(state.today.count, 2);
  assert.deepEqual(state.history, []);
});

test('long break completion returns to work, idle', () => {
  const { state, completed } = run(onBreak('long'), 'sync', T0 + 15 * MIN);
  assert.equal(completed, null);
  assert.equal(state.phase, 'work');
  assert.equal(state.status, 'idle');
});

// ---------------------------------------------------------------- midnight / today counter

test('a session ending 2026-10-03 00:30 local counts for 2026-10-03', () => {
  const start = local(2026, 10, 3, 0, 5);
  const st = run(initialState(), 'start', start).state; // ends 00:30
  const { state } = run(st, 'sync', local(2026, 10, 3, 0, 31));
  assert.equal(state.history[0].endedAt, local(2026, 10, 3, 0, 30));
  assert.deepEqual(state.today, { day: '2026-10-03', count: 1 });
});

test('a session started before midnight is counted on the day it ENDS', () => {
  const start = local(2026, 10, 2, 23, 50);
  const st = run(initialState(), 'start', start).state; // ends 2026-10-03 00:15
  const { state } = run(st, 'sync', local(2026, 10, 3, 0, 16));
  assert.equal(state.today.day, '2026-10-03');
});

test('today counter restarts across days and todayCount is 0 the next day', () => {
  const dayOne = { ...initialState(), today: { day: '2026-10-02', count: 5 } };
  const st = run(dayOne, 'start', local(2026, 10, 2, 23, 50)).state;
  const done = run(st, 'sync', local(2026, 10, 3, 0, 20)).state;
  assert.deepEqual(done.today, { day: '2026-10-03', count: 1 });
  // same day: increments
  const work2 = run(done, 'skip', local(2026, 10, 3, 9)).state; // skip the break
  const again = run(run(work2, 'start', local(2026, 10, 3, 9)).state, 'sync', local(2026, 10, 3, 10)).state;
  assert.equal(again.today.count, 2);
  // next morning without any write
  assert.equal(todayCount(again, local(2026, 10, 3, 23, 59)), 2);
  assert.equal(todayCount(again, local(2026, 10, 4, 0, 0)), 0);
});

// ---------------------------------------------------------------- history cap / idempotence

test('history is capped at 10, newest first', () => {
  let st = initialState();
  let t = T0;
  for (let i = 0; i < 12; i++) {
    st = { ...run(st, 'start', t).state };
    t += 25 * MIN;
    st = run(st, 'sync', t).state;
    st = run(st, 'skip', t).state; // skip break
  }
  assert.equal(st.history.length, LIMITS.historyMax);
  assert.equal(st.history[0].endedAt, T0 + 12 * 25 * MIN);
  assert.equal(st.history[9].endedAt, T0 + 3 * 25 * MIN);
  assert.equal(st.today.count, 12);
});

test('history append is idempotent: same id twice adds nothing and does not recount', () => {
  const end = T0 + 25 * MIN;
  const st = {
    ...working(T0),
    today: { day: dayKey(end), count: 1 },
    history: [{ id: end, endedAt: end, durationMs: 25 * MIN }],
  };
  const { state, completed } = run(st, 'sync', end + 1000);
  assert.equal(completed, null);
  assert.equal(state.history.length, 1);
  assert.equal(state.today.count, 1);
  assert.equal(state.phase, 'short');
  assert.equal(state.status, 'idle');
});

// ---------------------------------------------------------------- DST

test('a 25-minute session across the Europe/Rome fall-back lasts exactly 25 min of epoch time', () => {
  // 2026-10-25: at 03:00 CEST clocks go back to 02:00 CET. Start at 02:50 CEST (first pass).
  const start = new Date('2026-10-25T00:50:00Z').getTime(); // 02:50 CEST
  assert.equal(new Date(start).getHours(), 2);
  const st = run(initialState(), 'start', start).state;
  assert.equal(st.endAt - start, 25 * MIN);
  assert.equal(run(st, 'sync', st.endAt - 1).completed, null);
  const { completed, state } = run(st, 'sync', st.endAt);
  assert.equal(completed.endedAt - start, 25 * MIN);
  assert.equal(completed.durationMs, 25 * MIN);
  // wall clock: 02:50 CEST + 25 min = 02:15 CET (second 02:xx hour)
  assert.equal(new Date(st.endAt).getHours(), 2);
  assert.equal(new Date(st.endAt).getMinutes(), 15);
  assert.equal(state.today.day, '2026-10-25');
  assert.equal(remainingMs(st, S, start + 10 * MIN), 15 * MIN);
});

// ---------------------------------------------------------------- shouldAlert

test('shouldAlert: true within 60 s of the end, false when later', () => {
  const c = { id: 1000, endedAt: 1000, durationMs: 1, phase: 'work' };
  assert.equal(shouldAlert(c, 1000), true);
  assert.equal(shouldAlert(c, 1000 + 60_000), true);
  assert.equal(shouldAlert(c, 1000 + 60_001), false);
  assert.equal(shouldAlert(null, 1000), false);
});

// ---------------------------------------------------------------- normalizeState

const validRunning = (extra = {}) => ({
  phase: 'work', status: 'running', endAt: T0 + 10 * MIN, remainingMs: null, plannedMs: 25 * MIN,
  cycle: 1, today: { day: '2026-10-02', count: 2 }, history: [], ...extra,
});

test('normalizeState keeps a valid state intact', () => {
  const raw = validRunning({ history: [{ id: 5, endedAt: 5, durationMs: 25 * MIN }] });
  assert.deepEqual(normalizeState(raw, T0), raw);
  const paused = { ...validRunning(), status: 'paused', endAt: null, remainingMs: 7 * MIN };
  assert.deepEqual(normalizeState(paused, T0), paused);
});

test('normalizeState: non-object input gives the initial state, never throws', () => {
  for (const raw of [null, undefined, 0, 'str', [], true, NaN, () => {}]) {
    assert.deepEqual(normalizeState(raw, T0), initialState());
  }
});

test('normalizeState: running without a usable endAt becomes idle (no phantom session)', () => {
  const bad = [
    { endAt: null }, { endAt: undefined }, { endAt: NaN }, { endAt: Infinity }, { endAt: '1790000000000' },
    { endAt: {} }, { endAt: [] }, { endAt: true },
  ];
  for (const extra of bad) {
    const raw = { ...validRunning(), ...extra };
    const out = normalizeState(raw, T0);
    assert.equal(out.status, 'idle', JSON.stringify(extra));
    assert.equal(out.endAt, null);
    assert.equal(out.plannedMs, null);
    assert.equal(run(out, 'sync', T0 + 999 * MIN).completed, null, 'must not complete a phantom session');
  }
  const missing = validRunning();
  delete missing.endAt;
  const out = normalizeState(missing, T0);
  assert.equal(out.status, 'idle');
  assert.equal(run(out, 'sync', T0 + 999 * MIN).completed, null);
});

test('normalizeState: running with a bad plannedMs becomes idle', () => {
  for (const plannedMs of [null, undefined, NaN, 0, -5, 121 * MIN, '1500000', Infinity]) {
    const out = normalizeState(validRunning({ plannedMs }), T0);
    assert.equal(out.status, 'idle', String(plannedMs));
  }
  assert.equal(normalizeState(validRunning({ plannedMs: 120 * MIN }), T0).status, 'running');
});

test('normalizeState: huge future endAt becomes idle, the limit itself is accepted', () => {
  assert.equal(normalizeState(validRunning({ endAt: T0 + 24 * 60 * MIN }), T0).status, 'idle');
  assert.equal(normalizeState(validRunning({ endAt: 9e15 }), T0).status, 'idle');
  assert.equal(normalizeState(validRunning({ endAt: T0 + 120 * MIN + 60_000 }), T0).status, 'running');
  assert.equal(normalizeState(validRunning({ endAt: T0 + 120 * MIN + 60_001 }), T0).status, 'idle');
});

test('normalizeState: an endAt in the past is kept (catch-up) and completes on the next sync', () => {
  const out = normalizeState(validRunning({ endAt: T0 - 5 * MIN }), T0);
  assert.equal(out.status, 'running');
  const { completed } = run(out, 'sync', T0);
  assert.equal(completed.endedAt, T0 - 5 * MIN);
});

test('normalizeState: paused needs a finite remainingMs in (0, 120 min] and a plannedMs', () => {
  const paused = (extra) => ({ ...validRunning(), status: 'paused', endAt: null, remainingMs: 7 * MIN, ...extra });
  assert.equal(normalizeState(paused({}), T0).status, 'paused');
  for (const remainingMs of [null, undefined, NaN, 0, -1, 121 * MIN, '5', Infinity]) {
    assert.equal(normalizeState(paused({ remainingMs }), T0).status, 'idle', String(remainingMs));
  }
  assert.equal(normalizeState(paused({ plannedMs: null }), T0).status, 'idle');
  const out = normalizeState(paused({ endAt: 12345 }), T0);
  assert.equal(out.endAt, null, 'a paused state keeps no endAt');
});

test('normalizeState: bad phase/status/cycle fall back field by field', () => {
  assert.equal(normalizeState({ phase: 'bogus' }, T0).phase, 'work');
  assert.equal(normalizeState({ phase: 'long' }, T0).phase, 'long');
  assert.equal(normalizeState({ status: 'bogus' }, T0).status, 'idle');
  assert.equal(normalizeState({ status: 'running' }, T0).status, 'idle', 'running without times -> idle');
  for (const cycle of [-1, 4, 2.5, NaN, null, '2', undefined, Infinity]) {
    assert.equal(normalizeState({ cycle }, T0).cycle, 0, String(cycle));
  }
  for (const cycle of [0, 1, 2, 3]) assert.equal(normalizeState({ cycle }, T0).cycle, cycle);
  const out = normalizeState({ phase: 'bogus', status: 'bogus', cycle: 99 }, T0);
  assert.deepEqual(out, initialState());
});

test('normalizeState: history must be an array, entries filtered, capped, newest first', () => {
  for (const history of [null, 'x', 5, {}, { length: 3 }]) {
    assert.deepEqual(normalizeState({ history }, T0).history, []);
  }
  const mixed = [
    { id: 1, endedAt: 100, durationMs: MIN },
    { id: 2, endedAt: NaN, durationMs: MIN },
    null,
    'x',
    { id: '3', endedAt: 300, durationMs: MIN },
    { id: 4, endedAt: 400, durationMs: null },
    { id: 5, endedAt: 500, durationMs: MIN, junk: 'dropped' },
  ];
  assert.deepEqual(normalizeState({ history: mixed }, T0).history, [
    { id: 5, endedAt: 500, durationMs: MIN },
    { id: 1, endedAt: 100, durationMs: MIN },
  ]);
  const many = Array.from({ length: 15 }, (_, i) => ({ id: i, endedAt: i, durationMs: MIN }));
  const out = normalizeState({ history: many }, T0).history;
  assert.equal(out.length, 10);
  assert.equal(out[0].id, 14);
  assert.equal(out[9].id, 5);
});

test('normalizeState: today must be {YYYY-MM-DD, integer >= 0}', () => {
  const def = { day: '', count: 0 };
  assert.deepEqual(normalizeState({ today: { day: '2026-10-02', count: 3 } }, T0).today, { day: '2026-10-02', count: 3 });
  assert.deepEqual(normalizeState({ today: { day: '2026-10-02', count: 0 } }, T0).today, { day: '2026-10-02', count: 0 });
  for (const today of [
    null, 'x', 5, [], {}, { day: '2026-10-02' }, { count: 3 }, { day: 20261002, count: 1 },
    { day: '2026-10-2', count: 1 }, { day: 'yesterday', count: 1 }, { day: '2026-10-02', count: -1 },
    { day: '2026-10-02', count: 1.5 }, { day: '2026-10-02', count: NaN }, { day: '2026-10-02', count: '3' },
  ]) {
    assert.deepEqual(normalizeState({ today }, T0).today, def, JSON.stringify(today));
  }
});

test('normalizeState: JSON-valid but wrong-shaped values never throw and never invent sessions', () => {
  const shapes = [
    {}, { status: 'running' }, { status: 'running', endAt: null, plannedMs: 1500000 },
    { status: 'paused' }, { phase: 5, status: [] }, { history: [[]], today: [[]] },
    JSON.parse('{"endAt": null, "status": "running", "plannedMs": null}'),
    JSON.parse('{"__proto__": {"status": "running"}}'),
  ];
  for (const raw of shapes) {
    const out = normalizeState(raw, T0);
    assert.equal(out.status, 'idle', JSON.stringify(raw));
    assert.equal(run(out, 'sync', T0 + 1e9).completed, null);
  }
});

test('normalizeState: a throwing getter in raw does not escape', () => {
  const raw = { get status() { throw new Error('boom'); } };
  assert.deepEqual(normalizeState(raw, T0), initialState());
});

// ---------------------------------------------------------------- createTimer

test('createTimer: initial getState/getSettings are defaults', () => {
  const timer = createTimer({ now: () => T0, store: fakeStore() });
  assert.deepEqual(timer.getState(), initialState());
  assert.deepEqual(timer.getSettings(), DEFAULT_SETTINGS);
});

test('createTimer.hydrate: empty store stays idle and saves nothing', () => {
  const store = fakeStore();
  const timer = createTimer({ now: () => T0, store });
  assert.equal(timer.hydrate(), null);
  assert.equal(store.s.saves, 0);
  assert.equal(timer.getState().status, 'idle');
});

test('createTimer.hydrate: resumes a running session that has not ended', () => {
  const store = fakeStore({ state: validRunning({ endAt: T0 + 10 * MIN }) });
  const timer = createTimer({ now: () => T0, store });
  assert.equal(timer.hydrate(), null);
  assert.equal(timer.getState().status, 'running');
  assert.equal(timer.getState().endAt, T0 + 10 * MIN);
  assert.equal(store.s.saves, 0, 'unchanged state is not re-saved');
});

test('createTimer.hydrate: catch-up after reload records with endedAt = endAt (alert within grace)', () => {
  const endAt = T0 + 25 * MIN;
  const store = fakeStore({ state: validRunning({ endAt, plannedMs: 25 * MIN }) });
  const nowAt = endAt + 30_000;
  const timer = createTimer({ now: () => nowAt, store });
  const completed = timer.hydrate();
  assert.deepEqual(completed, { id: endAt, endedAt: endAt, durationMs: 25 * MIN, phase: 'work' });
  assert.equal(shouldAlert(completed, nowAt), true);
  assert.equal(store.s.saves, 1);
  assert.equal(store.s.state.history[0].endedAt, endAt);
  assert.equal(store.s.state.phase, 'short');
  assert.equal(store.s.state.status, 'idle');
});

test('createTimer.hydrate: missed timer (mock.timers.setTime) completes once, late, without alert', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const timer = createTimer({ now: () => Date.now(), store: fakeStore() });
  timer.hydrate();
  timer.dispatch(ev('start'));
  const endAt = timer.getState().endAt;
  // the tab was suspended: the clock jumps two hours ahead, no timer fired
  t.mock.timers.setTime(T0 + 2 * 60 * MIN);
  const completed = timer.hydrate();
  assert.equal(completed.endedAt, endAt);
  assert.equal(shouldAlert(completed, Date.now()), false);
  assert.equal(timer.getState().phase, 'short');
  assert.equal(timer.getState().status, 'idle', 'the next phase never auto-starts');
  assert.equal(timer.getState().history.length, 1);
});

test('createTimer.hydrate: late by more than 60 s -> shouldAlert false', () => {
  const endAt = T0 + 25 * MIN;
  const store = fakeStore({ state: validRunning({ endAt, plannedMs: 25 * MIN }) });
  const nowAt = endAt + 61_000;
  const completed = createTimer({ now: () => nowAt, store }).hydrate();
  assert.equal(completed.endedAt, endAt);
  assert.equal(shouldAlert(completed, nowAt), false);
});

test('createTimer.hydrate: a break that expired while away ends silently into work idle', () => {
  const brk = { ...validRunning({ phase: 'short', endAt: T0 + 5 * MIN, plannedMs: 5 * MIN }) };
  const store = fakeStore({ state: brk });
  const timer = createTimer({ now: () => T0 + 5 * 60 * MIN, store });
  assert.equal(timer.hydrate(), null);
  assert.equal(timer.getState().phase, 'work');
  assert.equal(timer.getState().status, 'idle');
  assert.equal(timer.getState().history.length, 0);
});

test('createTimer.hydrate: corrupt stored state yields no phantom session and does not throw', () => {
  const corrupt = [
    { status: 'running', endAt: null, plannedMs: 1500000 },
    { status: 'running', plannedMs: 1500000 },
    { status: 'running', endAt: NaN, plannedMs: 1500000 },
    { status: 'running', endAt: 'soon', plannedMs: 1500000 },
    { status: 'running', endAt: 9e15, plannedMs: 1500000 },
    { phase: 'bogus', status: 'running', endAt: T0 - 1, plannedMs: 'x' },
    { history: 'nope', today: 7, status: 'running' },
    'a string',
    [],
    42,
  ];
  for (const state of corrupt) {
    const store = fakeStore({ state });
    const timer = createTimer({ now: () => T0, store });
    assert.equal(timer.hydrate(), null, JSON.stringify(state));
    assert.equal(timer.getState().status, 'idle');
    assert.deepEqual(timer.getState().history, []);
    assert.equal(todayCount(timer.getState(), T0), 0);
  }
});

test('createTimer.hydrate: loads settings, normalizing garbage', () => {
  const store = fakeStore({ settings: { workMin: 50, shortMin: 'abc', longMin: 999, sound: 'no', notify: true } });
  const timer = createTimer({ now: () => T0, store });
  timer.hydrate();
  assert.deepEqual(timer.getSettings(), { workMin: 50, shortMin: 5, longMin: 120, sound: true, notify: true });
});

test('createTimer.dispatch: start, pause, start, reset persist and return null', () => {
  const store = fakeStore();
  let now = T0;
  const timer = createTimer({ now: () => now, store });
  timer.hydrate();
  assert.equal(timer.dispatch(ev('start')), null);
  assert.equal(store.s.state.status, 'running');
  assert.equal(store.s.state.endAt, T0 + 25 * MIN);
  now += 5 * MIN;
  timer.dispatch(ev('pause'));
  assert.equal(store.s.state.status, 'paused');
  assert.equal(store.s.state.remainingMs, 20 * MIN);
  now += 100 * MIN;
  timer.dispatch(ev('start'));
  assert.equal(store.s.state.endAt, now + 20 * MIN);
  timer.dispatch(ev('reset'));
  assert.equal(store.s.state.status, 'idle');
  assert.equal(store.s.saves, 4);
});

test('createTimer.dispatch: unchanged state is not saved', () => {
  const store = fakeStore();
  const timer = createTimer({ now: () => T0, store });
  timer.hydrate();
  timer.dispatch(ev('reset'));
  timer.dispatch(ev('pause'));
  timer.dispatch(ev('sync'));
  assert.equal(store.s.saves, 0);
});

test('createTimer.dispatch: returns the completion produced by its own sync, once', () => {
  const store = fakeStore();
  let now = T0;
  const timer = createTimer({ now: () => now, store });
  timer.hydrate();
  timer.dispatch(ev('start'));
  now = T0 + 25 * MIN;
  const c = timer.dispatch(ev('sync'));
  assert.equal(c.endedAt, T0 + 25 * MIN);
  assert.equal(timer.dispatch(ev('sync')), null);
  assert.equal(timer.getState().today.count, 1);
});

test('createTimer.dispatch: Rule 0 through the timer (reset at the end records first)', () => {
  const store = fakeStore();
  let now = T0;
  const timer = createTimer({ now: () => now, store });
  timer.hydrate();
  timer.dispatch(ev('start'));
  now = T0 + 25 * MIN;
  const c = timer.dispatch(ev('reset'));
  assert.ok(c);
  assert.equal(store.s.state.history.length, 1);
});

test('createTimer.dispatch: store returning null falls back to the in-memory state', () => {
  const store = { loadState: () => null, saveState: () => false, loadSettings: () => null, saveSettings: () => false };
  let now = T0;
  const timer = createTimer({ now: () => now, store });
  timer.hydrate();
  timer.dispatch(ev('start'));
  now = T0 + 25 * MIN;
  const c = timer.dispatch(ev('sync'));
  assert.ok(c);
  assert.equal(timer.getState().history.length, 1);
  assert.equal(timer.getState().phase, 'short');
});

test('createTimer: a throwing store never throws out of the timer', () => {
  const boom = () => { throw new Error('storage disabled'); };
  const store = { loadState: boom, saveState: boom, loadSettings: boom, saveSettings: boom };
  const timer = createTimer({ now: () => T0, store });
  assert.equal(timer.hydrate(), null);
  assert.equal(timer.dispatch(ev('start')), null);
  assert.equal(timer.getState().status, 'running');
  assert.doesNotThrow(() => timer.updateSettings({ workMin: 30 }));
  assert.equal(timer.getSettings().workMin, 30);
});

test('two tabs, one store: a stale tab never overwrites the newer history/today', () => {
  for (const action of ['reset', 'start', 'pause', 'sync']) {
    const store = fakeStore({
      state: { ...validRunning({ endAt: T0 + 25 * MIN }), cycle: 2, today: { day: dayKey(T0), count: 3 } },
    });
    let nowA = T0;
    let nowB = T0;
    const tabA = createTimer({ now: () => nowA, store });
    const tabB = createTimer({ now: () => nowB, store });
    tabA.hydrate();
    tabB.hydrate(); // B believes: running, count 3
    assert.equal(tabB.getState().today.count, 3);

    nowA = T0 + 25 * MIN; // A's timer fires: count 4
    assert.ok(tabA.dispatch(ev('sync')));
    assert.equal(store.s.state.today.count, 4);

    nowB = T0 + 25 * MIN + 2000; // B reacts with a stale view
    const c = tabB.dispatch(ev(action));
    assert.equal(c, null, `${action}: B must not see/alert a second completion`);
    assert.equal(store.s.state.today.count, 4, `${action}: count survives`);
    assert.equal(store.s.state.history.length, 1, `${action}: history keeps the session`);
    assert.equal(tabB.getState().today.count, 4);
    assert.equal(tabB.getState().history.length, 1);
  }
});

test('two tabs: B starting the break after A completed keeps A\'s record', () => {
  const store = fakeStore({ state: validRunning({ endAt: T0 + 25 * MIN }) });
  let now = T0;
  const a = createTimer({ now: () => now, store });
  const b = createTimer({ now: () => now, store });
  a.hydrate(); b.hydrate();
  now = T0 + 25 * MIN;
  a.dispatch(ev('sync'));
  b.dispatch(ev('start'));
  assert.equal(store.s.state.phase, 'short');
  assert.equal(store.s.state.status, 'running');
  assert.equal(store.s.state.history.length, 1);
  assert.equal(store.s.state.today.count, 3);
});

// ---------------------------------------------------------------- settings

test('updateSettings clamps, merges, saves and returns the new settings', () => {
  const store = fakeStore({ settings: { ...DEFAULT_SETTINGS, shortMin: 8 } });
  const timer = createTimer({ now: () => T0, store });
  const out = timer.updateSettings({ workMin: 500, longMin: '30', sound: false });
  assert.deepEqual(out, { workMin: 120, shortMin: 8, longMin: 30, sound: false, notify: false });
  assert.deepEqual(store.s.settings, out);
  assert.deepEqual(timer.getSettings(), out);
});

test('updateSettings: invalid fields keep the current value, unknown keys are dropped', () => {
  const store = fakeStore({ settings: { ...DEFAULT_SETTINGS, workMin: 40 } });
  const timer = createTimer({ now: () => T0, store });
  const out = timer.updateSettings({ workMin: 'abc', shortMin: '', sound: 'maybe', notify: 1, evil: 'x' });
  assert.deepEqual(out, { ...DEFAULT_SETTINGS, workMin: 40 });
  assert.equal('evil' in store.s.settings, false);
  assert.deepEqual(timer.updateSettings(null), out);
  assert.deepEqual(timer.updateSettings(undefined), out);
});

test('updateSettings with an empty store merges into the in-memory settings', () => {
  const store = { loadState: () => null, saveState: () => false, loadSettings: () => null, saveSettings: () => false };
  const timer = createTimer({ now: () => T0, store });
  timer.updateSettings({ workMin: 30 });
  assert.equal(timer.updateSettings({ shortMin: 7 }).workMin, 30);
});

test('settings change while running leaves endAt, plannedMs untouched', () => {
  const store = fakeStore();
  let now = T0;
  const timer = createTimer({ now: () => now, store });
  timer.hydrate();
  timer.dispatch(ev('start'));
  const before = structuredClone(store.s.state);
  timer.updateSettings({ workMin: 50 });
  assert.deepEqual(store.s.state, before);
  assert.equal(timer.getState().endAt, T0 + 25 * MIN);
  assert.equal(timer.getState().plannedMs, 25 * MIN);
  // paused: remainingMs untouched too
  now += 5 * MIN;
  timer.dispatch(ev('pause'));
  timer.updateSettings({ workMin: 10 });
  assert.equal(timer.getState().remainingMs, 20 * MIN);
  // finishing the session records the length it started with
  now += 10 * MIN;
  timer.dispatch(ev('start'));
  now += 20 * MIN;
  const c = timer.dispatch(ev('sync'));
  assert.equal(c.durationMs, 25 * MIN);
});

test('an idle phase picks up the new duration on the next start', () => {
  const store = fakeStore();
  const timer = createTimer({ now: () => T0, store });
  timer.hydrate();
  timer.updateSettings({ workMin: 50 });
  assert.equal(remainingMs(timer.getState(), timer.getSettings(), T0), 50 * MIN);
  timer.dispatch(ev('start'));
  assert.equal(timer.getState().endAt, T0 + 50 * MIN);
});

test('settings saved by another tab are used by the next dispatch', () => {
  const store = fakeStore();
  const a = createTimer({ now: () => T0, store });
  const b = createTimer({ now: () => T0, store });
  a.hydrate(); b.hydrate();
  a.updateSettings({ workMin: 40 });
  b.dispatch(ev('start'));
  assert.equal(b.getState().endAt, T0 + 40 * MIN);
});

// A garbage but finite past endAt (e.g. 5) must not become a 1970 "session":
// catch-up is limited to 7 days; older running states fall back to idle.
test('a running state whose endAt is older than the 7-day catch-up window is dropped, not recorded', () => {
  const stale = { phase: 'work', status: 'running', endAt: 5, plannedMs: 25 * MIN, cycle: 2, today: { day: '2026-10-02', count: 3 }, history: [] };
  const norm = normalizeState(stale, T0);
  assert.equal(norm.status, 'idle');
  assert.equal(norm.endAt, null);
  const { state, completed } = run(norm, 'sync', T0);
  assert.equal(completed, null);
  assert.equal(state.history.length, 0);
  assert.deepEqual(state.today, { day: '2026-10-02', count: 3 });
});

test('a running state that expired 6 days ago is still caught up and recorded', () => {
  const endAt = T0 - 6 * 24 * 60 * MIN;
  const st = { phase: 'work', status: 'running', endAt, plannedMs: 25 * MIN, cycle: 0, today: { day: '', count: 0 }, history: [] };
  const { completed } = run(normalizeState(st, T0), 'sync', T0);
  assert.equal(completed.id, endAt);
  assert.equal(shouldAlert(completed, T0), false);
});
