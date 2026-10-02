# Core state machine (spec for `src/core.js`)

Written before the code (decision D1, precondition 4). `src/core.js` implements exactly this; `test/core.test.js` checks every rule below. The module imports nothing and never touches `document`, `window`, `localStorage`, `setTimeout` or `Date.now`: time comes only from an injected `now()`, persistence only from an injected `store`.

## Types

```
Phase     = 'work' | 'short' | 'long'
Status    = 'idle' | 'running' | 'paused'
TimerState = {
  phase, status,
  endAt:       number | null,   // epoch ms, only while running
  remainingMs: number | null,   // only while paused
  plannedMs:   number | null,   // length of the session in progress (running or paused)
  cycle:       0..3,            // completed work sessions since the last long break
  today:       { day: 'YYYY-MM-DD', count: number },
  history:     [{ id, endedAt, durationMs }]   // newest first, max LIMITS.historyMax
}
Settings   = { workMin, shortMin, longMin, sound, notify }
Completion = { id, endedAt, durationMs, phase }
Event      = { type: 'start' | 'pause' | 'reset' | 'skip' | 'sync' }
LIMITS     = { minMin: 1, maxMin: 120, historyMax: 10, longEvery: 4, alertGraceMs: 60000 }
```

`DEFAULT_SETTINGS = { workMin: 25, shortMin: 5, longMin: 15, sound: true, notify: false }`.
`initialState()` = idle, `work`, cycle 0, `today = { day: '', count: 0 }`, empty history, all time fields `null`.

## Rule 0: time wins

Every `dispatch` first runs `sync`, then applies the user's event to the result. So a Pause or Reset that arrives at or after `endAt` first records the completed session, and then applies to the *next* phase (idle), where Pause and Reset are no-ops. `step(state, settings, event, now)` does this itself for every event type, so the rule holds for any caller.

The user cannot lose a session that already ended by pressing a button late. The converse also holds: a session is never recorded before `now >= endAt`.

## Transition table

`sync` is applied first in every row (Rule 0). The rows below describe the state after `sync` (call it S). "Expired" means `status = running` and `now >= endAt`.

| # | S (after sync)                 | Event   | Result                                                                                                  | Recorded |
|---|--------------------------------|---------|---------------------------------------------------------------------------------------------------------|----------|
| 1 | idle                           | start   | running; `plannedMs = durationMs(phase)`; `endAt = now + plannedMs`; `remainingMs = null`              | no       |
| 2 | running (`now < endAt`)        | pause   | paused; `remainingMs = endAt - now`; `endAt = null`; `plannedMs` kept                                   | no       |
| 3 | paused                         | start   | running; `endAt = now + remainingMs`; `remainingMs = null`; `plannedMs` kept                            | no       |
| 4 | running, expired (sync)        | sync    | COMPLETE (see below), next phase idle                                                                   | work only |
| 5 | running (`now < endAt`)        | sync    | unchanged                                                                                               | no       |
| 6 | idle or paused                 | sync    | no-op                                                                                                   | no       |
| 7 | running or paused              | reset   | idle, SAME phase, time fields `null`, `cycle` unchanged                                                 | never    |
| 8 | idle                           | reset   | no-op                                                                                                   | no       |
| 9 | any                            | skip    | next phase, idle, time fields `null`, `cycle` unchanged. `work` -> `short`; `short`/`long` -> `work`   | never    |
| 10| running (`now < endAt`)        | start   | no-op (already running)                                                                                 | no       |
| 11| idle or paused                 | pause   | no-op                                                                                                   | no       |

Notes:
- Row 9: skipping a work session does not count it, so the break after a skipped work is always `short`. The 4th *completed* work session still earns the long break, because `cycle` counts completions only.
- Because Rule 0 runs first, "running expired + pause/reset" is: row 4, then row 11/8 on the next idle phase (no-op). "Running expired + skip" is: row 4, then row 9 on the next phase (it skips the break that just became current). "Running expired + start" is: row 4, then row 1 (the next phase starts).
- Reset at 24:59 into a 25-minute work (1 s after start) and at 00:01 remaining are rows 7 (nothing recorded). Reset at exactly 00:00 or later is row 4 first (recorded), then row 8.

## Completion

A completed session is a **work** phase that is `running` when a `sync` sees `now >= endAt`, however many pause/resume cycles came before. Breaks are never recorded or counted. Reset and skip never count.

- `id = endedAt = endAt` (the scheduled end, NOT the moment the code noticed it).
- `durationMs = plannedMs`.
- `today`: let `key = dayKey(endAt)`. If `key !== today.day`, `today = { day: key, count: 1 }`; otherwise `count + 1`.
- `history`: prepend `{ id, endedAt, durationMs }`, then cap to `LIMITS.historyMax` (newest first). **Idempotent:** if `history[0].id === id`, nothing is appended and `today` is not incremented again, and the call reports `completed = null` (it was already recorded and alerted elsewhere).
- Phase advance, work: `cycle + 1`; if that reaches `LIMITS.longEvery` (4) the next phase is `long` and `cycle = 0`, otherwise `short`. Short/long completion: next phase is `work`, nothing recorded, `cycle` unchanged.
- The next phase is **never auto-started**: it is left `idle`. So a catch-up after a long absence produces at most one completion; a break that expired while the user was away simply ends silently and the next state is `work`, idle.

`shouldAlert(completed, now)` is `false` if `now - completed.endedAt > LIMITS.alertGraceMs` (the user was away; a sound a minute late is noise), and `true` otherwise. A `null` completion never alerts.

## Day key and the daily counter

`dayKey(ms)` is the **local** calendar date `YYYY-MM-DD` of that instant (not `toISOString`, which is UTC). A session ending at 2026-10-03 00:30 local time counts for `2026-10-03`, even though in UTC it is still 10-02.

`today` is a separate `{ day, count }` pair, not derived from history (history is capped). `todayCount(state, now)` compares `today.day` with `dayKey(now)` **at display time**: `0` if they differ, otherwise `today.count`. So the counter reads 0 the morning after without any write.

## Time helpers

- `durationMs(phase, settings)`: minutes of that phase (`work`->`workMin`, `short`->`shortMin`, `long`->`longMin`, unknown phase -> work) run through `clampMinutes`, times 60 000.
- `remainingMs(state, settings, now)`: running `max(0, endAt - now)`; paused `remainingMs`; idle `durationMs(phase, settings)`.
- `endDelay(state, now)`: running `max(0, endAt - now)`; otherwise `null`. The caller arms ONE unchained `setTimeout` with it.
- `formatMmSs(ms)`: `MM:SS`, seconds rounded **up** (1 ms left shows `00:01`, 1000 -> `00:01`, 1001 -> `00:02`, 0 -> `00:00`). Negative or non-finite input shows `00:00`. Minutes are not wrapped (120 min -> `120:00`).
- All durations are epoch-ms arithmetic, so a DST change inside a session never alters its length.

## Settings

`clampMinutes(value, fallback)`: `NaN`, `Infinity`, `''`, whitespace, non-numeric strings, `null`, `undefined`, booleans, objects -> `fallback`. Otherwise round to an integer (`Math.round`: 2.5 -> 3) and clamp to 1..120 (0 -> 1, 121 -> 120). Numeric strings such as `'30'` are accepted (they come from `<input>` values).

`normalizeSettings(raw)` never throws: a non-object gives the defaults; each field falls back to its default on its own; `sound` and `notify` are kept only if they are booleans.

`updateSettings(patch)` merges the patch into the stored settings (clamping each patch field, falling back to the current value for an invalid one, ignoring unknown keys) and saves. It **never** touches `endAt`, `remainingMs` or `plannedMs` of a running or paused session: the session in progress keeps the length it started with. An idle phase just shows the new duration.

## `normalizeState(raw, now)`: validation of stored state

Never throws. Corrupt but JSON-valid input must NOT create a phantom session or an absurd timer. Field-level salvage:

- `phase` one of the three, else `work`. `status` one of the three, else `idle`.
- Numbers must be `Number.isFinite`: `NaN`, `Infinity`, `null`, `undefined` and strings are rejected, never coerced (`endAt: null` must not become `0`).
- `cycle`: integer 0..3, else 0.
- `history`: must be an array; each entry kept only if `id`, `endedAt`, `durationMs` are finite numbers; sorted newest first (by `endedAt`), capped to 10.
- `today`: `day` matching `YYYY-MM-DD` and `count` an integer >= 0, else `{ day: '', count: 0 }`.
- **running** requires a finite `endAt` AND a finite `plannedMs` in (0, 120 min]. `endAt` may be in the past (the catch-up case: it expired while the page was closed and completes on the next sync) but not absurdly in the future (`endAt - now <= 120 min + 60 s`) and not older than the 7-day catch-up window (`now - endAt <= 7 days`): an older running state is treated as corrupt and becomes `idle` without recording anything (a garbage `endAt` such as `5` must never create a 1970 session).
- **paused** requires a finite `remainingMs` in (0, 120 min] and a finite `plannedMs` in (0, 120 min] (needed to record the duration if it is later completed).
- Anything failing the above -> `idle`, same phase, time fields `null`. A valid running/paused state keeps only its own time fields (running: `endAt`, `plannedMs`; paused: `remainingMs`, `plannedMs`).

## `createTimer({ now, store })`

Injected store contract (implemented elsewhere; tests use a fake): `{ loadState(): unknown|null, saveState(o): boolean, loadSettings(): unknown|null, saveSettings(o): boolean }`. Store calls that throw are treated as "nothing stored" / "not saved".

- `getState()`, `getSettings()`: the last known values (initially `initialState()` / defaults).
- `hydrate()`: load state and settings, normalize, run `sync` (catch-up), save only if the state changed. Returns the `Completion` or `null`.
- `dispatch(event)`: FIRST re-read `store.loadState()` and normalize it (so a stale tab never overwrites another tab's newer history/today), also re-read the settings, then `sync`, then apply the event, then `saveState` only if the state changed. Returns the `Completion` produced by that call or `null`.
- `updateSettings(patch)`: see Settings; returns the new settings.
- If the store returns `null` (nothing saved), the in-memory last known state / settings are used.
