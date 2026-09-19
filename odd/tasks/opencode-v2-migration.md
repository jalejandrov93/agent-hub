# opencode-v2-migration

## Objective

Make agent-hub's `opencode` adapter correct against OpenCode v2 (`@opencode/cli` 2.0.10),
restoring reliable delegation: uncorrupted prompts, working model discovery, accurate
token accounting, and timeouts that actually stop server-side work.

## Problem

OpenCode v2 replaced the v1 CLI contract the adapter was written against. v1 and v2 do not
coexist (the v2 installer replaces the v1 binary), so this is a hard cut, not dual support.
Three of the breakages are silent: the prompt is corrupted, tokens always read as null, and
timeouts orphan live server-side sessions.

## Why

Every failure mode is silent. Nothing throws; delegation just degrades.

## Evidence (all verified against the installed 2.0.10 binary and its own server records)

| # | Finding | How it was verified |
|---|---|---|
| E1 | `run --dir` removed | `opencode run --help` |
| E2 | `run --variant` removed; variant now rides the model id as `provider/model#variant` | `opencode run --help` |
| E3 | A prompt passed as argv arrives **wrapped in literal double quotes** | `session.message.list` stored `"\"Repeat back the exact characters…\""` |
| E4 | A prompt passed on **stdin** arrives verbatim | same endpoint stored the text with no quotes |
| E5 | `step_finish.part.tokens` has **no `total`** — it is `{input, output, reasoning, cache:{read,write}}` | live NDJSON capture |
| E6 | `step_finish` is **not guaranteed** to be emitted at all | one live run produced only `step_start` + `text` |
| E7 | A run can contain **several assistant messages**; concatenating every `text` event splices unrelated turns together | live capture produced `"PONG"` then `"Ready to plan — what do you want to work on?"` |
| E8 | `models --verbose` and the provider positional are gone; output is a flat id list with no metadata | `opencode models --help` |
| E9 | `GET /api/model` returns full metadata (`providerID`, `name`, `cost`, `limit`, `capabilities`, `variants`) | 95 entries returned |
| E10 | The `location` query param is `style: deepObject` → `location[directory]=…`, not JSON | OpenAPI spec; the JSON form returns `InvalidRequestError` |
| E11 | **`--standalone` is unusable**: every invocation spawns a fresh server and samples its cold, empty catalog | measured locally (private `serve` polled repeatedly: 0 providers/0 models; shared service returns 95). Upstream root cause: `provider.ts:364-380` gates providers on `integration.connections.length`. Issue #41071 fixed it via PR #41783's readiness barrier, but **that barrier is absent in 2.0.10** and `server/test/model.test.ts` was inverted to assert callers must poll |
| E12 | `run` carries the **client's** cwd into `session.create({location:{directory}})`, and tools honor it, so worktree delegation via the shared service is safe | v2.0.10 `run.ts:73-96` -> `session-target.ts:62-68` -> `tool/plugin/shell.ts:202`. The `location.directory=/home/alejandro` seen earlier was an artifact of `opencode api` sending no location, not of session execution |
| E13 | `run` handles **only SIGINT**, whose handler calls `session.interrupt`. SIGTERM is unhandled, SIGKILL uncatchable | `process.on("SIGINT", …)` is the sole registration (binary + `noninteractive.ts:642`) |
| E19 | On the shared service the **server owns execution**, so killing the client does not stop the run: it keeps spending tokens and editing the worktree. `POST /api/session/{id}/interrupt` is the only real cancellation | upstream issue #48683; `--standalone` is the only mode with a stdin ownership lease (`standalone.ts:27-32`) |
| E14 | cwd comes from `process.env.PWD ?? process.cwd()`, then `chdir` | v2.0.10 source, `packages/cli/src/run/run.ts` |
| E15 | Without `--auto`, permissions are auto-rejected and the session is interrupted | v2.0.10 source, `noninteractive.ts` |
| E16 | Exit codes are meaningful: `0` ok, `1` failure, `130` interrupt. An unknown flag exits 1 | source + `opencode models --verbose` run without a pipe |
| E17 | All 7 registry models still exist; `opencode-go/default` never did | `/api/model` catalog |
| E18 | Event vocabulary survives: `step_start`, `text`, `reasoning`, `tool_use`, `step_finish`, `error`. No `session.error`, no terminal event | emitter extracted from the binary + live capture |

## Scope

Authorized: `src/adapters/opencode.mjs`, `src/adapters/index.mjs`, `src/process.mjs`,
`src/jobrunner.mjs`, `src/discovery.mjs`, `src/preflight.mjs`, `src/config.mjs`,
`src/index.mjs`, their tests and fixtures, and the opencode docs.

Out of scope: migrating to `@opencode/client`/the HTTP API as the delegation transport
(considered and rejected for now — the API self-declares `"Experimental HttpApi surface"`,
version `0.0.1`). The adapter contract (`cmd`, `buildArgv`, `parseResult`, `classifyError`,
`listModels`) stays intact.

## Constraints

- `listModels` must keep returning ids that match `DELEGATION_MAP`/`MODEL_REGISTRY` keys
  exactly — `preflight.mjs:156` compares by strict equality.
- No `--standalone` anywhere (E11).
- Strict TDD: observed RED before implementation, then GREEN, then refactor.
- Runner: `npm test` (`node --test`, excluding `test/live/`); `npm run test:live` with
  `AGENT_HUB_LIVE=1` for the real round-trip.

## Delivery

Route per task recorded below. RDD is **on** (decided by global), so each work-unit commit
gets `gentle-ai review assess --base-ref <last boundary> --committed-only --json` and the
tier is honored. Forecast ≈ 500–550 authored changed lines, above the ~400 heuristic:
sliced into the work units below. Push/PR remain the user's decision.

## Tasks

- [x] **T1 — stdin plumbing.** `src/process.mjs`: `spawnDetached` accepts `opts.stdin`;
      when present, `stdio[0]='pipe'`, write and `end()`. `runCommand` propagates it.
      Route: delegated (part of the T1–T3 writer unit).
- [x] **T2 — v2 argv + prompt on stdin.** `src/adapters/opencode.mjs`: drop `--dir` and
      `--variant`, fold the variant into the model id, remove the prompt from argv, export
      `stdinFor()`. `src/jobrunner.mjs:266`: pass `stdin` and `env.PWD = cwd`.
      Route: delegated.
- [x] **T3 — kill ladder.** `src/process.mjs`: SIGINT first (E13), so the client interrupts
      the server-side session, then the existing SIGTERM→SIGKILL ladder. Fix the now-false
      "opencode ignores SIGTERM" comment. Route: delegated.
- [x] **T10 — explicit server-side interrupt on timeout.** SIGINT is only best-effort: the
      handler fires `session.interrupt` and swallows its rejection, and a SIGKILL bypasses it
      entirely, leaving a live server-side session (E19). Every NDJSON line carries
      `sessionID`, so the id is already known from partial stdout at timeout. On an opencode
      timeout, issue `opencode api session.interrupt --param sessionID=<id>` and verify.
      Invocation confirmed live: it returns `{"interrupted": <bool>}`, exit 0, and is safe and
      idempotent on an already-finished session (returns `false`).
      Route: delegated (own unit — it needs a jobrunner hook).
- [x] **T4 — parseResult.** Take only the last assistant message's `text` parts (E7); sum
      `tokens` since there is no `total` (E5); tolerate a missing `step_finish` (E6).
      Route: delegated.
- [x] **T5 — model discovery.** `modelsArgv('opencode')` → `opencode api model.list`;
      `listModels` parses `{data:[…]}`; fall back to the flat `opencode models` list when
      the API call fails. Route: delegated.
- [x] **T6 — drop the provider fan-out.** Remove `opencodeProviders()` and both
      `if (agent === 'opencode')` branches in `discovery.mjs` and `preflight.mjs`.
      Route: delegated.
- [x] **T7 — classifyError + exit codes.** Use the exit code (E16): 130 is an interrupt,
      not a crash. Drop the dead `session.error` branch. Route: delegated.
- [~] **T8 — registry and version.** `TESTED_VERSIONS.opencode` → `'2.0.10'` **done**;
      verified end to end with the real binary (`npm run selftest` now prints
      `opencode  : opencode v2.0.10` with no WARN). Replacing the fake `opencode-go/default`
      is **still open** — see "Open decision". Route: inline (mechanical, known lines).
- [x] **T9 — fixtures, tests, docs.** Regenerate from the live captures; delete
      `models-verbose.txt`; update the skill reference and README. Route: delegated.

## Open decision

`opencode-go/default` is not a real id. Real ids on that provider include
`muse-spark-1.3-contributor`, `deepseek-v4-pro`, `deepseek-v4-flash`, `glm-5.3`, `kimi-k3`.
Needs the user to pick one; until then T8 keeps the entry out of the ready set rather than
guessing a paid model.

## Progress

- Branch `feat/opencode-v2` created off `dev`.
- **T1–T3 done** (delegated writer, strict TDD; RED observed per task, then GREEN).
  Parent spot check: `npm test` -> 986 tests, 978 pass, 0 fail, 8 cancelled.
  The 8 cancelled all live in `test/quota-codexbar.test.mjs` and are pre-existing —
  verified by stashing the whole change and re-running (baseline: 968 pass, **1 fail**,
  8 cancelled). Note the baseline also had one genuine failure, which this unit fixes.
- **Scope gap found and fixed inline by the parent**: `pingAgent` (`preflight.mjs:347`)
  built the argv but passed neither `stdin` nor `PWD`, so the L3 ping would have sent
  opencode an empty message from the wrong directory while still spending a real model
  call — a "ready" that proves nothing. Fixed under TDD (RED observed: stdin empty).

## Review record

- Work unit 1 (`6c6c071`) assessed `medium`, `review_due: true` (`slice_budget_reached`).
  Consent relayed; the user granted. Lineage `review-7f58a68979765f79` created.
- The lineage **could not reach a terminal outcome**: its `collect` transition returned a
  `review.capture-result` slot whose token list carries none of `--agent`, `--input` or
  `--preflight`, and `capture-result` refuses that exact list as `invalid_request`
  (`mutation_outcome: not_started`). The bound STATUS reoffers the identical slot, so it is
  deterministic, not transient.
- **T4 + T7 done** (delegated writer, strict TDD). Parent spot check: `npm test` -> 997 tests,
  989 pass, 0 fail, 8 cancelled (same pre-existing `quota-codexbar` set).
  The writer's choice to count cache tokens toward the total was independently verified against
  `success.jsonl`: opencode v1's own recorded `total` (39465) equals
  input+output+reasoning+cache.read+cache.write exactly, and does not equal the sum without
  cache (38072). Parent hardened one gap it found: the three non-cache components were summed
  unguarded, so a model omitting `reasoning` would have reported `NaN` tokens. Covered by a test.
- A regression of upstream #4582 (closed `not_planned` because the token was present on 2.9.0
  stable; this build is 3.4.0 stable). Reported with the user's explicit consent as
  `Gentleman-Programming/gentle-ai#4804`.
- The candidate's exact provider-issued decline invocation was then executed once and validated
  (`action: declined`, `consent: declined_this_candidate`, target identity matched), and native
  STATUS re-entered clean. **Outcome for this work unit: declined — unreviewed, delivery under
  ordinary repository policy.**

- **T5 + T6 done** (delegated writer, strict TDD). Parent spot check: 1004 tests,
  995 pass, 8 cancelled, 1 intermittent failure matching the base profile above.
  Parent hardened one gap: the fallback id parser rejected nested ids
  (`openrouter/anthropic/claude-sonnet-4.5`), which v2 documents as valid, so such a model
  would have been dropped and reported as "not listed". Re-verified after the change that all
  95 real catalog ids are still accepted and that HTTP status lines, usage banners and JSON
  fragments are still rejected.
- **T9 + T10 done** (delegated writer, strict TDD). New adapter hooks `interruptArgv()` and
  `sessionIdFrom()`; a bounded, best-effort `attemptServerInterrupt()` in `jobrunner` that can
  never throw into or stall finalization; a new `job.interrupted` event (added to both
  `schemas.mjs` and `eventlog.mjs`, which an existing test keeps in parity).
  **Parent closed a gap the writer scoped out**: the interrupt fired only on `timeout`, but
  `cancelJob` kills the same process group and `finishJob` no-ops once it sees `canceled`, so a
  *user cancel* orphaned the server-side session just as badly — and cancelling is exactly when
  the user wants it stopped. `cancelJob` now fires the same bounded interrupt, recovering the
  session id from partial stdout. Covered by a test.
  Parent spot check: `npm test` -> 1014 tests, 1006 pass, 0 fail, 8 cancelled.

## Finding for the user (not acted on)

`.opencode/package.json` in this repo pins `@opencode-ai/plugin` 1.18.30 — a v1 plugin, and v2's
migration guide states plainly that V1 plugin implementations do not run in V2. The directory is
gitignored, so nothing was changed; it is a local dev-environment artifact, independent of this
codebase change.

- Work unit 2 (`69b0d4d`) assessed `medium`, `review_due: true` (`slice_budget_reached`).
  Native review was **not re-attempted**: the defect above is deterministic and already
  reproduced twice on this build, and the contract is explicit that an unavailable verifier's
  typed result is preserved rather than retried indefinitely. Outcome recorded as
  **unavailable — upstream #4804**. RDD stays enabled; nothing was disabled or worked around.
  Re-attemptable at any time once a fix ships in the stable channel.

## Test-suite baseline (honest record)

This repo's suite is not clean on the base and never was during this work. Measured:

- `test/quota-codexbar.test.mjs` run in isolation: 8 tests, **0 pass, 0 fail, 8 cancelled** —
  the whole file is inert (`cancelledByParent`). Present on the base.
- The base (`dev`, all of this branch's changes stashed) reports **1 fail + 8 cancelled**.
- Under full-suite parallel load one test fails intermittently; it moves between
  `test/worktree-lease.test.mjs` ("old holder cannot release the new holder lock after reclaim")
  and the codexbar set. `worktree-lease` passes **5/5 in isolation**. Both are timing-sensitive
  and neither touches opencode, discovery or preflight.

So "0 fail" on this branch is not claimed. What is claimed: every opencode-related file passes
deterministically, and the branch's failure profile matches the base's. Cleaning up that flake
is separate work, out of this feature's scope.

## Next step

T8 (registry + tested version) and T9 (fixtures, docs), then T10 (server-side interrupt).
