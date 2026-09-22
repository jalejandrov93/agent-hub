# Feature: agys balanced profile selection + explicit profile pin

Locator: `odd/tasks/agys-balanced-profiles.md` (worktree `agent-hub-worktrees/agys-balanced`, branch `feat/agys-balanced-profiles`)
Engram mirror: `odd/agys-balanced-profiles/tasks` (project `agent-hub`)

## Objective

Spread agy jobs across agys accounts by quota AND current load, and let a caller pin one account per task.

## Problem / why

- `resolveAgyProfileSync` (src/providers/agys.mjs) caches the chosen profile for 60 s per model group, so a burst of N parallel jobs all land on ONE account (observed: 8 jobs at 2026-09-21 15:51 all on `personal`). It only moves after a 429.
- `delegate()` / `dispatch()` expose no `profile` input, although `startJob` (src/jobrunner.mjs ~205) already accepts `profile`. Pinning today requires the global agys mode file or `AGENT_HUB_AGYS_PROFILE`, which affects every concurrent job.

## Design (accepted by user 2026-09-22)

- Quota-weighted, load-aware rotation:
  `score = remainingQuota(profile, modelGroup) - LOAD_PENALTY * inFlight(profile, modelGroup)`;
  highest score wins; ties -> least-recently-assigned profile (round-robin); then priority, then name.
- Cache only the slow part (agys list + quota snapshot, keep the 60 s TTL). In-flight counts and last-assignment are computed on every call.
- In-flight = jobs with status `running`/`queued` whose recorded `profile` matches and whose model is in the same model group (read from the job store).
- Unknown quota keeps sorting last (existing behaviour); exhausted/unavailable profiles stay excluded; the 429 exhaustion record stays authoritative.
- Explicit `profile` input on `delegate` and `dispatch`: validated against `agys list`; unknown profile -> clear error, no silent fallback. Recorded with `profileStatus: 'pinned'`.
- Global mode precedence unchanged: `AGENT_HUB_AGYS_PROFILE` env / mode file `profile` still pin globally; per-call `profile` overrides auto only (and overrides a global pin, since it is explicit per call).

## Scope

In: src/providers/agys.mjs, src/providers/profiles.mjs, src/jobrunner.mjs, src/dispatch.mjs, delegate/dispatch tool schemas (src/index.mjs or src/tools/*), router annotation if it shares the resolver, tests, CHANGELOG, tool docs if they list inputs.
Out: dashboard UI changes, agys itself, Jules accounts.

T4 additionally touches: src/router.mjs (codex fallback ordering in `triage`/`mechanical-edit` chains), a new pure gate function (e.g. `src/routing/codex-gate.mjs`), CHANGELOG, and any doc stating "quota never reorders agents" — that statement becomes true for every agent except codex, which T4 intentionally gates/promotes on its own plan quota.

## Constraints

- Strict TDD (RED -> GREEN -> REFACTOR). Runner: `npm test` (node --test). TDD source: user global config "Strict TDD Mode: enabled".
- No behaviour change for `mode: off`.
- ~400 authored changed lines is a planning heuristic only.
- Delivery strategy: ask-on-risk. Forecast ~300 lines (T1-T3); T4 forecast ~150 lines.

## Tasks

- [x] T1 Explicit `profile` input on `delegate` and `dispatch` (validate against agys list, `profileStatus: 'pinned'`, error on unknown). Route: delegated writer (2+ non-trivial files).
- [x] T2 Load-aware quota rotation in profile selection (in-flight penalty + least-recently-assigned tie-break; cache only the quota snapshot). Route: delegated writer.
- [x] T3 CHANGELOG + tool docs; full `npm test`.
- [x] T4 (added 2026-09-22, user-approved) Quota-gated codex routing: gate codex (agent 'codex', model 'default', last fallback in `triage`/`mechanical-edit` per src/config.mjs tier 'limited') on its own plan quota from CodexBar (src/quota/codexbar.mjs + src/quota/mapping.mjs). Pure, unit-tested rule, e.g. `src/routing/codex-gate.mjs`:
  - remaining = 100 - usedPercent of the most-constrained window (primary, and secondary if present).
  - remaining < CODEX_MIN_REMAINING_PCT (20) -> drop codex from the chain entirely; annotate `skipped: [{agent:'codex', reason:'quota_low', remainingPct}]` (or router's existing annotation style).
  - remaining >= CODEX_PROMOTE_REMAINING_PCT (50) AND on pace (usedPercent/100 <= elapsedFraction of the window, elapsedFraction = 1 - (resetsAt - now)/windowMinutes) -> promote codex to position 2 (right after the first entry) in `triage`/`mechanical-edit`; annotate reason `quota_headroom`.
  - Otherwise (including unknown/unreachable/stale quota) -> unchanged, last fallback. Never drop/promote on missing data.
  - Only codex is affected; every other agent's ordering stays byte-identical — keep/extend the existing "quota never reorders" pin test for non-codex chains and note codex as the documented exception.
  - Apply wherever the chain is consumed for execution: verify dispatch.mjs walks route()'s ordered chain (not a second copy) before wiring the gate only into router.mjs.
  - Inject `now` and usage for tests; no live network calls in tests.
  - Commit: `feat(router): gate codex fallback on its plan quota`.

## Acceptance criteria

- 3 simultaneous gemini jobs with similar quota go to 3 different accounts.
- An account with much higher quota receives more jobs, but in-flight load reduces its score.
- `delegate({profile:'work1', ...})` runs on work1 and the job record shows `profile: 'work1'`, `profileStatus: 'pinned'`.
- `delegate({profile:'nope'})` fails fast with a clear message.
- Full suite green.
- T4: codex remaining quota < 20% -> dropped from `triage`/`mechanical-edit` chains entirely, with an annotated reason. remaining >= 50% and on pace -> promoted to position 2. Otherwise/unknown quota -> unchanged as last fallback. Every non-codex chain is byte-identical to before T4.

## Checks

`npm test` in the worktree.

## Progress

- T1 done (2026-09-22). Route: delegated writer (this agent), TDD RED->GREEN observed per behaviour.
  - `listAgysProfilesSync` added to src/providers/agys.mjs (sync `agys list` parse, injectable execFn) — RED: `SyntaxError: ... does not provide an export named 'listAgysProfilesSync'`; GREEN: test/providers-agys.test.mjs 52/52.
  - `delegateTool` (src/tools/jobs.mjs) accepts `profile`, validates via `listAgysProfilesFn` (sync), rejects non-agy agent / unknown profile / agys-unavailable, sets `profileStatus:'pinned'`, now takes injectable `startJobFn`/`listAgysProfilesFn`/`env` — RED: 4 new tests failed (missing exception / real startJob invoked); GREEN: test/tools-jobs.test.mjs 33/33.
  - `dispatch()` (src/dispatch.mjs) accepts `profile`, validates against the routed/explicit primary candidate's agent + `listAgysProfilesFn`/`isAgysAvailableFn` (async, injectable) right after candidate discovery, and bypasses `resolveProfileFn`/the per-group memo entirely when pinned (profile stays fixed through retry/fallback; a 429 on a pinned job still fails with quota and still records exhaustion, since selection never runs) — RED evidence: initial run hung past 120s (unvalidated `profile` fell into `...restDeps` and reached the real, unmocked `resolveAgyProfile`/agys CLI on the "unknown profile" and "non-agy" rejection tests) killed manually; after wiring, GREEN: test/dispatch-agys.test.mjs 14/14.
  - `delegate`/`dispatch` MCP tool schemas (src/index.mjs) gained an optional `profile` string input with the documented description; wired through to the tool handlers.
  - Design note: mode 'off' + explicit profile -> explicit profile is authoritative (dispatch's pinned branch never consults `getAgysMode`), covered by an explicit test.
  - Full `npm test`: 1404/1404 pass.
  - Commit: `d99fd48` feat(agys): accept an explicit profile on delegate and dispatch.

- T2 done (2026-09-22). Route: delegated writer (this agent), TDD RED->GREEN observed per behaviour.
  - `src/providers/profiles.mjs`: added `LOAD_PENALTY = 0.15` (each in-flight job costs 15 percentage points of headroom) and a pure `scoreProfile(remainingQuota, inFlight, loadPenalty)`; `selectProfile` gained `inFlightByProfile`/`lastAssignedByProfile` params (both default `{}`, so any caller that omits them keeps byte-identical pre-T2 ordering) and now sorts by score (falling back to least-recently-assigned, then priority, then name on a near-tie within 1e-9) — RED: `SyntaxError: ... does not provide an export named 'scoreProfile'`; GREEN: test/providers-agys.test.mjs 58/58, including the 0.85/0.30/0.29 break-even math from the design doc (A keeps winning through 3 in-flight jobs, loses to B at the 4th).
  - `src/providers/agys.mjs`: added `computeAgyLoadContext` (job-store-derived `inFlightByProfile`/`lastAssignedByProfile`, scoped to one model group; running/queued only; folds in-process reservations) and `reserveAgyLoadSlot`/`resetAgyLoadReservations`/`AGY_LOAD_RESERVATION_TTL_MS` (10s) for the same-tick burst race. `resolveAgyProfileSync` and `resolveAgyProfile` (async) both now cache ONLY the agys list+quota snapshot (60s TTL, unchanged) and recompute the pick — including load context — on every call; both gained `listJobsFn`/`reservations`/`reserve` params, `reserve` defaulting to **false** (a pick-only/informational caller like router.mjs must never reserve, or it would bias the next real selection) — RED: new export errors then a failing burst-spread assertion (`1 !== 2`); GREEN: test/providers-agys.test.mjs 64/64.
  - `src/jobrunner.mjs` (`startJob`) and `src/dispatch.mjs` (`dispatch`'s per-group memo resolution) now pass `reserve: true` to the auto-pick resolver call — RED: `receivedReserve === undefined`; GREEN: test/jobrunner-agys.test.mjs 14/14 (incl. a real, unmocked 3-calls-3-profiles test) and test/dispatch-agys.test.mjs 15/15.
  - `router.mjs` untouched: its informational `_resolveAgyProfileSync` call keeps the `reserve: false` default, so annotation-only lookups never bias a later real pick.
  - Design decisions / deviations from the doc: (1) reservation is opt-in per call (`reserve` flag) rather than automatic inside the resolver, specifically to protect router.mjs's annotation-only call from polluting shared state — the doc's wording ("small in-process reservation map... released on terminal state or after a short TTL") is satisfied via TTL-only expiry (10s), no explicit release-on-terminal wiring, since createJob() persists synchronously and the job-store count takes over almost immediately. (2) LOAD_PENALTY kept at the suggested 0.15. (3) `listJobsFn`/`reservations` are injectable on both resolvers to keep tests off the real `~/.local/share/agent-hub` state (this machine has real, live job history — several pre-existing tests that pass `model` without `AGENT_HUB_HOME` needed an explicit `listJobsFn: () => []` to stay isolated; documented inline at each call site).
  - Full `npm test`: 1419/1419 pass (was 1404 after T1; +15).
  - Commit: `6fd6705` feat(agys): balance agy jobs across profiles by quota and in-flight load.

- T3 done (2026-09-22). Route: delegated writer (this agent); docs-only, no TDD applicable.
  - `CHANGELOG.md`: two `[Unreleased] / Added` entries (explicit `profile` pin; load-aware rotation).
  - `docs/reference/tools.md`: `delegate`/`dispatch` input-signature table rows updated with `profile?` and its semantics.
  - `docs/providers/agy.md`: `auto` mode description corrected (was "highest-priority", now load-aware score); added "Load-aware rotation (auto mode)" and "Per-call profile pin" subsections with the score formula, tie-break order, and pin semantics (validation, `profileStatus:'pinned'`, retry/fallback immunity).
  - Full `npm test`: 1419/1419 pass (unchanged from T2 — docs only).
  - Commit: (recorded after this commit is created).

- T4 done (2026-09-22). Route: delegated writer (this agent), TDD RED->GREEN observed per behaviour.
  - `src/routing/codex-gate.mjs` (new, pure): `CODEX_MIN_REMAINING_PCT=20`, `CODEX_PROMOTE_REMAINING_PCT=50`, `codexQuotaDecision({quota, now})` — reads a `quotaFor()`-shaped result for `{agent:'codex', model:'default'}`, picks the MOST CONSTRAINED window (min remaining) across primary/secondary/tertiary, and returns `{action:'drop'|'promote'|'unchanged', reason, remainingPct}`. `drop` when remaining `<20`; `promote` when remaining `>=50` AND on pace (`usedPercent/100 <= elapsedFraction`, elapsedFraction derived from `resetsAt`/`windowMinutes`, clamped [0,1]); missing pace data or unknown/unreachable/stale quota (`quotaUnavailableReason`, `stale:true`, no usable window) never drops or promotes. RED: `ERR_MODULE_NOT_FOUND`; GREEN: test/routing-codex-gate.test.mjs 10/10 (incl. the real-shape usedPercent:89 example from the task, the exact-20%/exact-50% inclusive boundaries, ahead-of-pace non-promotion, and the multi-window most-constrained case).
  - `src/router.mjs`: added `now = Date.now` param and `CODEX_GATED_TASK_TYPES = new Set(['triage', 'mechanical-edit'])`. Moved the `fetchUsage` quota snapshot fetch to before the primary/fallback split (computed from every surviving candidate, not just the post-gate chain) so the gate can read codex's own quota before finalizing order; applies `codexQuotaDecision` only for those two taskTypes, only when a codex candidate is present. `drop` removes codex from `candidates` and pushes `{agent, model, reason:'quota_low', remainingPct}` onto `skipped` (existing `.passthrough()` schema, no schema change needed); `promote` reorders `candidates` to `[first, codex(+quotaGate), ...rest]` (`quotaGate:{action:'promoted', reason:'quota_headroom', remainingPct}` on the returned `ChainStep`, also `.passthrough()`). Added a guard mirroring the existing `eligibleSurvivors.length===0` branch for the edge case where codex was the only surviving candidate and gets dropped. RED: 3/6 new router tests failing (drop/promote/mechanical-edit cases); GREEN: test/router-codex-gate.test.mjs 6/6, plus the pre-existing "quota never reorders" pin test (test/router-quota.test.mjs) and test/router.test.mjs + test/router-agys-annotation.test.mjs all still green (20/20) since codex quota stays unseeded/unknown there.
  - Docs: `docs/routing.md` ("It never decides anything" -> documents the codex exception with the score/threshold summary); `src/index.mjs` `agents_quota` tool description (was "quota never chooses, skips or reorders an agent" -> now scoped to "every agent except codex", with the codex rule summarized); CHANGELOG `[Unreleased]/Added`.
  - Design decisions / deviations from the doc: (1) when multiple windows exist (primary+secondary), the SAME most-constrained window drives both the drop threshold and the promote pace check (the doc's wording was ambiguous about which window's pace to use when several exist) — documented in the module docstring. (2) `route()`'s existing empty-survivors early-return is duplicated (not refactored into a shared helper) for the post-gate-drop empty case, to keep the diff small and avoid touching unrelated control flow. (3) `dispatch.mjs` needed NO changes — verified it already consumes `route()`'s ordered `primary`/`fallbacks` exclusively (no second chain-building path), so the gate lives in exactly one place.
  - Full `npm test`: 1435/1435 pass (was 1419 after T3; +16).
  - Commit: (recorded after this commit is created).

## Next step

All tasks (T1-T4) complete. Feature ready for user review / PR.
