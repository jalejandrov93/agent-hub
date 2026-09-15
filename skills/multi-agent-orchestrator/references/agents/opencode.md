# opencode — reference

## Headless invocation (what `agent-hub`'s adapter builds)

```
opencode run "<task>" -m <provider>/<model> --format json --agent plan|build --dir <cwd> \
    [--title T] [--variant V] [-s <sessionId>] [--auto]
```

- `mode:'read'` → `--agent plan`; `mode:'write'` → `--agent build` **and** `--auto` (auto-accept
  edits — required for a headless write job, otherwise it blocks on a prompt that never comes).
- `--variant` selects reasoning effort: `minimal|low|medium|high|max`. Explicit `variant` on
  `delegate`/`job_reply` wins; otherwise the model's `MODEL_REGISTRY` default applies (Muse Spark
  1.3 defaults to `high` — see Models below); otherwise no flag is passed.
- `-s <sessionId>` resumes a prior session — this is what `job_reply` uses.
- Result parsing: JSONL event stream. `text` events carry `.part.text`; the last `step_finish`
  event carries `.part.tokens.total` and `.part.cost`. **`text`/`step_finish` events can be
  silently dropped from the stream** — if no `text` event is found, the adapter classifies the
  job `errorKind:'empty'` (retriable) rather than treating an empty response as a crash.
- A provider `error`/`session.error` event with `statusCode:402` or an "insufficient balance"
  message classifies as `errorKind:'billing'` (not retriable) — a single occurrence opens the
  circuit breaker immediately for that agent+model pair, unlike `quota`/`canceled` which need
  two failures within 30 minutes. Measured live against `deepseek/deepseek-v4-pro`.
- opencode **ignores SIGTERM**. The hub's process manager SIGKILLs the whole process group
  after a grace period instead of waiting on a graceful exit — do not assume a cancel is fast.
- opencode materializes a `.opencode/` directory inside the `--dir` cwd as a side effect.

## Models

Free tier, cost 0 (Meta trains on prompts for at least one of these — user has explicitly
accepted "no restriction"; the `dataPolicy` badge in `agents_status`/dashboard still shows it,
it just never blocks routing):

| Model | dataPolicy | Use it for |
|---|---|---|
| `opencode/muse-spark-1.3-contributor-free` | trains | research/recon fallback, brainstorming, 1M ctx — **verified working** in live tests, defaults to `--variant high` (`MODEL_REGISTRY` default); a live ping with `--variant high --agent plan` answered correctly. |
| `opencode/nemotron-3-ultra-free` | logs | call-chain-trace fallback |
| `opencode/mimo-v2.5-free` | logs | library/docs research |
| `opencode/big-pickle` | logs | general purpose free fallback |
| `opencode/nemotron-3.5-lightning-free` | logs | **do not use as primary** — hung indefinitely (full 90s timeout, SIGKILLed) in live testing 2026-09-11, despite being a real listed model id. `muse-spark-1.3-contributor-free` answered the same prompt in ~3s. |

Paid (availability depends on which providers your opencode account has configured; example
below is one working set):

| Model | Use it for |
|---|---|
| `deepseek/deepseek-v4-pro` | general purpose paid |
| `deepseek/deepseek-v4-flash` | mechanical-edit write jobs — cheap, write-capable |
| `opencode-go/*` | capped $12/5h · $30/week · $60/month, **no usage API** — track spend manually |

## Health / quota signal

- `opencode models <provider> --verbose` = L1 listing (adapter parses repeated
  `<provider>/<id>` blocks with `providerID`, `id`, `name`, `cost`, `limit`).
- `opencode providers list`, `opencode stats --days 1 --models` — useful for a human check, not
  wired into the automated preflight ladder.
- No authoritative non-interactive quota API for the free tier or `deepseek/*`; `opencode-go/*`
  has hard dollar caps but no queryable usage — the circuit breaker is the only automated signal:
  ≥2 `quota`/`canceled` failures in 30 min for the same pair, or a **single** `billing` failure
  (402/insufficient balance opens it immediately, since a billing failure never clears on retry).

## Gotchas (measured)

1. Free-model prompts are not private by default — accepting the free tier's data-training terms
   is a deliberate per-user choice, not an oversight to fix. Never route a task containing
   secrets/`.env`/credentials to any agent regardless of tier.
2. A job that appears to hang past its timeout is likely `nemotron-3.5-lightning-free` — do not
   retry the same model, switch to `muse-spark-1.3-contributor-free`.
3. Cancel is not instant: SIGTERM is ignored, so `job_cancel` takes as long as the SIGKILL grace
   period before the process group is confirmed gone.
4. `.opencode/` appears in the target cwd after any run — expected, not a stray artifact to
   "clean up" mid-task.
