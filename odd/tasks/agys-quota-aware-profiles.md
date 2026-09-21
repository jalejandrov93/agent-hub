# agys: quota-aware, model-group-aware profile selection and 429 failover

## Objective
Make agys multi-account delegation actually spread load across accounts: detect
quota exhaustion correctly, choose the account by the quota of the model group a
job will use, and move to another account after a 429.

## Problem (observed 2026-09-21)
Six agys profiles are logged in, but every agy job ran on `esp`, which then hit
`RESOURCE_EXHAUSTED (429): Individual quota reached` on the Claude/GPT group while
other accounts had 100% left. Causes, verified in code:
1. `src/adapters/agy.mjs:97` — an envelope with `status:"ERROR"` returns
   `crash` before `envelope.error` is inspected, so a 429 is never `quota`
   (no breaker, no fallback, misleading `errorKind`).
2. `src/providers/profiles.mjs` `isBucketExhausted` reads only
   `usedPercent`-style fields; `agys quota --json` reports `remainingFraction`,
   so no bucket is ever exhausted.
3. `profileStateFor` marks a profile exhausted only when EVERY bucket of EVERY
   group is exhausted; quota is per model group ("Gemini Models" vs "Claude and
   GPT models") and per window (5h, weekly).
4. With all priorities 0 and no usage data, `selectProfile` falls back to name
   order, so `esp` always wins. No failover after a 429 on a profile.

## Scope
`src/adapters/agy.mjs`, `src/providers/profiles.mjs`, `src/providers/agys.mjs`,
the call sites that resolve a profile (`src/jobrunner.mjs`, `src/router.mjs`,
`src/dispatch.mjs`), and tests. Dashboard only if a type/contract it reads changes.

## Constraints
- Strict TDD: observed RED before GREEN. Node v22 for tests
  (`~/.local/share/fnm/aliases/default/bin`).
- `startJob` must stay synchronous (see `profileFromEnv` note in agys.mjs).
- Never re-execute a write-mode turn automatically on another account.
- Explicit profile (`AGENT_HUB_AGYS_PROFILE` or dashboard "profile" mode) is
  respected as-is; only `auto` mode selects.

## Tasks
- [x] T1 — agy adapter: `status:"ERROR"` envelopes are classified from
  `envelope.error` (429/RESOURCE_EXHAUSTED/quota reached → `quota`, auth → `auth`),
  and the message carries the provider error text.
- [x] T2 — quota parsing and state: buckets with `remainingFraction` are
  understood; state is computed per model group (Gemini vs Claude/GPT) and a
  group is exhausted when ANY of its windows is exhausted.
- [x] T3 — selection: `auto` picks, among viable profiles for the job's model
  group, the one with the most remaining quota in that group (priority, then
  name, as tie-breakers). The job's model is passed down to the resolver.
- [x] T4 — failover: a `quota` failure on profile X marks X exhausted for that
  model group until its reset (parsed from "Resets in …" when present, else a
  bounded default), so the next attempt/dispatch uses another account.

## Acceptance criteria
- With the real `agys quota --json` shape, a Claude job skips a profile whose
  Claude/GPT 5h bucket is 0 and picks the one with most Claude/GPT quota left.
- A 429 envelope yields `errorKind:'quota'`.
- After a quota failure on X, the next resolution for the same group avoids X.
- `npm test` fully green.

## Checks
New RED→GREEN tests per task; `npm test` (Node v22).

## TDD
Mode: strict (session config). Runner: `npm test` (`node --test`), Node v22.

## Delivery
Same branch as the concurrency fix (`fix/concurrency-reclaim-and-dispatch-takeover`),
one PR to `dev` as requested by the user. Forecast ~350 authored lines; the branch
already carries ~520, so the PR exceeds the ~400 budget — strategy decision is
asked before opening the PR (`ask-on-risk`).

## Progress / evidence

### T1 — agy adapter classification (done)
- Files: `src/adapters/agy.mjs`, `test/adapters/agy.test.mjs`,
  `test/fixtures/agy/stream-quota-error.jsonl` (trimmed from the real run log
  at `~/.local/share/agent-hub/runs/2026-09-21T18-46-57-657Z-fe4e4663/stdout.log`),
  `test/fixtures/agy/stream-auth-error.jsonl`.
- RED: 3 new tests failed — `'crash' !== 'quota'` / `'crash' !== 'auth'` /
  missing-message match, since `classifyError` returned `crash` for
  `status:"ERROR"` before inspecting `envelope.error`.
- GREEN: `node --test test/adapters/agy.test.mjs` → 20/20 pass.
- Commit: `83ca7d4` fix(agy): classify ERROR envelopes from their provider error.

### T2 — quota parsing + per-model-group state (done)
- Files: `src/providers/profiles.mjs`, `test/providers-agys.test.mjs`.
- RED: import of `modelGroupFor`/`remainingQuotaForModel` failed (not yet
  exported); after adding, the per-group state test failed
  `'esp' !== 'ita'`-style false negatives against `isBucketExhausted` only
  reading `usedPercent`.
- GREEN: `node --test test/providers-agys.test.mjs` → 37/37 pass at this point.
- Commit: `b8bed32` fix(agys): understand remainingFraction quota buckets and
  per-model-group state.

### T3 — quota-aware selection (done)
- Files: `src/providers/profiles.mjs` (`selectProfile` model-aware sort),
  `src/providers/agys.mjs` (`resolveAgyProfileSync`/`resolveAgyProfile` thread
  `model`, cache key includes model group), `src/jobrunner.mjs` (`startJob`
  passes `model`), `src/router.mjs` (`route()` resolves profiles per agy
  candidate's own model), `src/dispatch.mjs` (profile memo keyed by
  `agent:modelGroup`, `resolveProfileFn` receives `model`).
- RED: `selectProfile` model tests failed (`'esp' !== 'ita'`); router/dispatch
  model-threading tests failed with `undefined` where a model string was
  expected; sync-cache-key test failed (`callCount` stayed 2 instead of 4,
  proving a Gemini-cached pick was leaking into a Claude/GPT resolution).
- GREEN: `node --test test/providers-agys.test.mjs` → 43/43;
  `node --test test/jobrunner-agys.test.mjs` → 9/9;
  `node --test test/router-agys-annotation.test.mjs` → 4/4;
  `node --test test/dispatch-agys.test.mjs` → 9/9.
- Commit: `3564938` fix(agys): select the profile with the most remaining
  quota per model group.

### T4 — failover after a quota failure (done, with one documented deferral)
- Files: `src/config.mjs` (`agysExhaustionFile` path), `src/providers/agys.mjs`
  (`parseResetDurationMs`, `recordQuotaExhaustion`, `readQuotaExhaustion`,
  `isProfileExhaustedFor`, both resolvers consult it), `src/jobrunner.mjs`
  (`finishJob` calls `recordQuotaExhaustionFn` on a `quota` errorKind).
- RED: module import of the new exports failed first; after adding empty
  stubs, `resolveAgyProfileSync`/`resolveAgyProfile` exhaustion tests failed
  (`'esp' !== 'ita'`) because nothing consulted the exhaustion store yet; the
  jobrunner hook test failed `0 !== 1` (recordQuotaExhaustionFn never called).
- GREEN: `node --test test/providers-agys.test.mjs` → 50/50;
  `node --test test/jobrunner-agys.test.mjs` → 12/12.
- Commit: `64ba8d5` fix(agys): fail over to another account after a quota
  (429) failure.
- **Deferred (not a bug, a scope boundary):** dispatch's own intra-call retry
  stage (`executeWithPolicy` in `src/policy/executor.mjs`) cannot react to a
  quota failure on a same-call retry. `startJob()` is synchronous and returns
  `status:'queued'` before the CLI process (and therefore any 429) has run;
  the actual quota failure is only written to the job store asynchronously,
  after `finishJob` runs on process exit — by which point dispatch's
  `executeWithPolicy` loop has already returned. So there is no synchronous
  signal for the retry stage to react to within one `dispatch()` call.
  Verified by reading `src/dispatch.mjs` (the taskFn returns `job.status`
  straight from `startJobFn`'s synchronous return) and `src/policy/executor.mjs`
  (retry only re-invokes taskFn on a thrown/`status:'failed'` result from that
  same synchronous return). Making the retry loop await job completion per
  attempt would be a materially larger behavioral change (dispatch is
  documented as fire-and-forget with a separate wait contract) than this
  bounded fix, so it is out of scope here. What IS fixed and tested: the
  profile memo is now keyed by `agent:modelGroup` (not just `agent`), so a
  fallback to a DIFFERENT quota group within one dispatch call re-resolves
  correctly, and the exhaustion store means the NEXT separate
  dispatch/startJob call (the realistic case — the hub is not called in a
  tight synchronous retry loop against the same job) avoids the exhausted
  profile, which is what the acceptance criteria require.

### Full suite
- `npm test` (Node v22, `node --test`): **1393 pass / 0 fail** (baseline was
  1364; +29 new tests across the four tasks).
- Dashboard typecheck/tests: not run — no dashboard file imports
  `providers/agys.mjs` or `providers/profiles.mjs` (`grep -rl` came back
  empty), and no job-record/route()/`agysProfilesSnapshot()` output shape
  changed (only new optional fields and functions were added), so nothing the
  dashboard reads changed.

Engram mirror (`odd/agys-quota-aware-profiles/tasks`): **PENDING** — Engram
rejects saves in this session (multiple active runtime sessions match).
