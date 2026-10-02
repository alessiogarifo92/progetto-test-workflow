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
