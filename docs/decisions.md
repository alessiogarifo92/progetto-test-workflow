# Decisions

Confirmed decisions only. Read this before re-deriving anything. Newest last.

## D1 — Idea: Focus Timer (stage 1, 2026-10-02)
- Static single-page Pomodoro web app: vanilla JS (ES modules), no framework, no backend, no build step.
- Timer 25/5/15 configurable (3 number inputs, clamped 1-120), start/pause/reset, today's session count + last ~10 completed sessions, sound alert by default, browser notification as an opt-in toggle.
- Hosting: GitHub Pages (free). Recurring cost: zero. No custom domain, no analytics.
- Direction chosen by the repo owner delegating the idea ("any idea"); reviewed by one `critic` (L2): verdict *accept with changes*.
- Out of scope (stated, not hidden): background alerts on mobile/iOS, charts, streaks, accounts, sync.

### Preconditions for ticket 1 (from the critic review)
1. Time is computed from `endAt = now + duration` (pause stores `remainingMs`); the interval only repaints; re-sync on `visibilitychange`; the end is one unchained `setTimeout`; `endAt` is persisted so a reload resumes.
2. localStorage keys are namespaced and versioned (`focusTimer:v1:*`), every read/write is in try/catch with in-memory fallback, history is capped.
3. All logic lives in a pure ES module with an injected `now()` and an injected storage object (testable with `node:test`, no DOM).
4. A written state-machine spec exists before code: reset/skip/long-break (every 4th work session) and the day key uses the local date of completion.
5. Mobile background alerts are explicitly out of scope.

### What this run exercises (so a green result is not over-read)
Exercised: idea → critic, stack/cost, architecture, design (3 directions), tickets, CI, worktrees, TDD, review, manual gate, deploy-readiness on GitHub Pages, live smoke test.
Barely exercised or skipped on purpose: secrets, database/migrations, rollback beyond "revert and redeploy", recurring cost beyond zero, launch/marketing (not requested).

## D2 — Gate answers, stages 2-3.5 (2026-10-02, confirmed by the repo owner)
- **Visibility:** `progetto-test-workflow` becomes PUBLIC (needed only for GitHub Pages on a Free account; stages 4-8 run fine while private). Done by the owner in the GitHub UI (the session proxy cannot change repo settings). `claude-skills` stays private.
- **Stack confirmed:** vanilla JS ES modules, no dependencies, `node --test`, GitHub Actions, GitHub Pages deployed from a staged `_site/` (only `index.html`, `style.css`, `src/`), cost 0 EUR. No per-PR preview: the manual gate runs locally with `python3 -m http.server`.
- **Architecture confirmed:** 4 modules (`core`, `store`, `alerts`, `app`), tickets T0 CI/scaffold + T1 core + T2 store + T3 app shell + T4 alerts. Changes adopted from the critic: re-read storage before every action + `storage` event; validate stored state shape on load; day key = local date of the session's `endAt`, compared at display time (tests with a fixed TZ); `cycle` counter in state; settings changes never touch a running session; seconds rounded up; countdown in `document.title`; AudioContext created/resumed inside the Start click; `mock.timers.setTime` for the missed-timer test; Node pinned to 22 in CI.
- **Design confirmed:** direction A "Dial" (dark teal ring). Tokens: Night #10201E, Panel #182E2B, Mist #EAF4F1, Fog #9DB8B2, Mint #5FD4B8, Amber #F2B66B; display font ui-rounded stack weight 300 tabular-nums, text font system-ui; spacing 4/8/12/16/24/40/64; radius 16 panels, 999 buttons. Required changes: today's count above the fold on phones, `prefers-reduced-motion` support, replace the gear glyph with an inline SVG icon, optional light scheme later. Canvas: https://claude.ai/artifact/WJAJb2mPB29Wu7q5QZ4ZUx
- Accepted and parked: double chime with two tabs; mobile background alerts out of scope.
