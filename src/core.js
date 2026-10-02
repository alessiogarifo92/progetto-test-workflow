// Pure core of the Focus Timer: state machine, time and day logic.
// Spec: docs/state-machine.md. No imports; time comes only from the injected
// now(), persistence only from the injected store.

export const LIMITS = { minMin: 1, maxMin: 120, historyMax: 10, longEvery: 4, alertGraceMs: 60000 };
export const DEFAULT_SETTINGS = { workMin: 25, shortMin: 5, longMin: 15, sound: true, notify: false };

const MINUTE_MS = 60000;
const MAX_SESSION_MS = LIMITS.maxMin * MINUTE_MS;
const MAX_CATCHUP_MS = 7 * 24 * 60 * MINUTE_MS; // older running states are dropped, not recorded
const PHASES = ['work', 'short', 'long'];
const STATUSES = ['idle', 'running', 'paused'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHASE_SETTING = { work: 'workMin', short: 'shortMin', long: 'longMin' };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPlanned = (v) => isNum(v) && v > 0 && v <= MAX_SESSION_MS;

// ---------------------------------------------------------------- settings

export function clampMinutes(value, fallback) {
  let n = NaN;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(LIMITS.maxMin, Math.max(LIMITS.minMin, Math.round(n)));
}

export function normalizeSettings(raw) {
  const r = raw !== null && typeof raw === 'object' ? raw : {};
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  return {
    workMin: clampMinutes(r.workMin, DEFAULT_SETTINGS.workMin),
    shortMin: clampMinutes(r.shortMin, DEFAULT_SETTINGS.shortMin),
    longMin: clampMinutes(r.longMin, DEFAULT_SETTINGS.longMin),
    sound: bool(r.sound, DEFAULT_SETTINGS.sound),
    notify: bool(r.notify, DEFAULT_SETTINGS.notify),
  };
}

// ---------------------------------------------------------------- state

export function initialState() {
  return {
    phase: 'work',
    status: 'idle',
    endAt: null,
    remainingMs: null,
    plannedMs: null,
    cycle: 0,
    today: { day: '', count: 0 },
    history: [],
  };
}

function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h) => h !== null && typeof h === 'object' && isNum(h.id) && isNum(h.endedAt) && isNum(h.durationMs))
    .map((h) => ({ id: h.id, endedAt: h.endedAt, durationMs: h.durationMs }))
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, LIMITS.historyMax);
}

function normalizeToday(raw) {
  if (raw !== null && typeof raw === 'object' && typeof raw.day === 'string' && DAY_RE.test(raw.day)
    && Number.isInteger(raw.count) && raw.count >= 0) {
    return { day: raw.day, count: raw.count };
  }
  return { day: '', count: 0 };
}

export function normalizeState(raw, now) {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return initialState();
    const phaseOk = PHASES.includes(raw.phase);
    const phase = phaseOk ? raw.phase : 'work';
    const status = STATUSES.includes(raw.status) ? raw.status : 'idle';
    const cycle = Number.isInteger(raw.cycle) && raw.cycle >= 0 && raw.cycle < LIMITS.longEvery ? raw.cycle : 0;
    const out = { ...initialState(), phase, cycle, today: normalizeToday(raw.today), history: normalizeHistory(raw.history) };
    // an unknown phase leaves running/paused untrustworthy (work or break?): drop them, never count
    if (status === 'running' && phaseOk && isNum(raw.endAt) && isPlanned(raw.plannedMs)
      && raw.endAt - now <= MAX_SESSION_MS + LIMITS.alertGraceMs
      && now - raw.endAt <= MAX_CATCHUP_MS) {
      return { ...out, status: 'running', endAt: raw.endAt, plannedMs: raw.plannedMs };
    }
    if (status === 'paused' && phaseOk && isPlanned(raw.remainingMs) && isPlanned(raw.plannedMs)) {
      return { ...out, status: 'paused', remainingMs: raw.remainingMs, plannedMs: raw.plannedMs };
    }
    return out;
  } catch {
    return initialState();
  }
}

// ---------------------------------------------------------------- time helpers

export function durationMs(phase, settings) {
  const key = PHASE_SETTING[phase] || 'workMin';
  const s = settings !== null && typeof settings === 'object' ? settings : {};
  return clampMinutes(s[key], DEFAULT_SETTINGS[key]) * MINUTE_MS;
}

export function remainingMs(state, settings, now) {
  if (state.status === 'running') return Math.max(0, state.endAt - now);
  if (state.status === 'paused') return state.remainingMs;
  return durationMs(state.phase, settings);
}

export function formatMmSs(ms) {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const total = Math.ceil(safe / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function endDelay(state, now) {
  return state.status === 'running' ? Math.max(0, state.endAt - now) : null;
}

export function dayKey(ms) {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayCount(state, now) {
  return state.today.day === dayKey(now) ? state.today.count : 0;
}

export function shouldAlert(completed, now) {
  if (!completed) return false;
  return now - completed.endedAt <= LIMITS.alertGraceMs;
}

// ---------------------------------------------------------------- transitions

const cleared = (state, phase) => ({ ...state, phase, status: 'idle', endAt: null, remainingMs: null, plannedMs: null });

// Rule 0: a running session whose endAt has passed completes, whatever the
// event that made us look. Only a work phase is recorded; the next phase is
// left idle (never auto-started).
function syncStep(state, now) {
  if (state.status !== 'running' || !isNum(state.endAt) || !(now >= state.endAt)) return { state, completed: null };
  if (state.phase !== 'work') return { state: cleared(state, 'work'), completed: null };

  const id = state.endAt;
  const cycle = state.cycle + 1;
  const long = cycle >= LIMITS.longEvery;
  const base = cleared(state, long ? 'long' : 'short');
  base.cycle = long ? 0 : cycle;
  if (state.history.some((h) => h.id === id)) return { state: base, completed: null };

  const key = dayKey(id);
  base.today = state.today.day === key ? { day: key, count: state.today.count + 1 } : { day: key, count: 1 };
  base.history = [{ id, endedAt: id, durationMs: state.plannedMs }, ...state.history].slice(0, LIMITS.historyMax);
  return { state: base, completed: { id, endedAt: id, durationMs: state.plannedMs, phase: 'work' } };
}

function apply(state, settings, type, now) {
  switch (type) {
    case 'start':
      if (state.status === 'idle') {
        const plannedMs = durationMs(state.phase, settings);
        return { ...state, status: 'running', endAt: now + plannedMs, remainingMs: null, plannedMs };
      }
      if (state.status === 'paused') {
        return { ...state, status: 'running', endAt: now + state.remainingMs, remainingMs: null };
      }
      return state;
    case 'pause':
      if (state.status !== 'running') return state;
      // capped at the planned length: a load check rejects remainingMs above it
      return { ...state, status: 'paused', remainingMs: Math.min(state.endAt - now, state.plannedMs), endAt: null };
    case 'reset':
      return state.status === 'idle' ? state : cleared(state, state.phase);
    case 'skip':
      return cleared(state, state.phase === 'work' ? 'short' : 'work');
    default:
      return state;
  }
}

export function step(state, settings, event, now) {
  const synced = syncStep(state, now);
  const type = event !== null && typeof event === 'object' ? event.type : undefined;
  return { state: apply(synced.state, settings, type, now), completed: synced.completed };
}

// ---------------------------------------------------------------- timer

export function createTimer({ now, store }) {
  let state = initialState();
  let settings = { ...DEFAULT_SETTINGS };

  const safe = (fn) => {
    try { return fn(); } catch { return null; }
  };
  const isNone = (v) => v === null || v === undefined;

  function refresh(at) {
    const rawState = safe(() => store.loadState());
    if (!isNone(rawState)) state = normalizeState(rawState, at);
    const rawSettings = safe(() => store.loadSettings());
    if (!isNone(rawSettings)) settings = normalizeSettings(rawSettings);
  }

  function run(event) {
    const at = now();
    refresh(at);
    const before = state;
    const result = step(state, settings, event, at);
    state = result.state;
    if (state !== before) safe(() => store.saveState(state));
    return result.completed;
  }

  return {
    getState: () => state,
    getSettings: () => settings,
    hydrate: () => run({ type: 'sync' }),
    dispatch: (event) => run(event),
    updateSettings(patch) {
      const rawSettings = safe(() => store.loadSettings());
      const base = isNone(rawSettings) ? settings : normalizeSettings(rawSettings);
      const p = patch !== null && typeof patch === 'object' ? patch : {};
      const bool = (k) => (typeof p[k] === 'boolean' ? p[k] : base[k]);
      settings = {
        workMin: clampMinutes(p.workMin, base.workMin),
        shortMin: clampMinutes(p.shortMin, base.shortMin),
        longMin: clampMinutes(p.longMin, base.longMin),
        sound: bool('sound'),
        notify: bool('notify'),
      };
      safe(() => store.saveSettings(settings));
      return settings;
    },
  };
}
