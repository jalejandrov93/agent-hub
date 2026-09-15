# agy (Antigravity) — reference

## What it is for

`agy` is not a smarter model. It is a **separate quota**. The only reason to use it is context
compression: it reads the files, and what comes back into Claude's context is twenty lines
instead of twenty files. If the answer is inherently long, or you will re-read the code to
trust it, delegating costs more than doing it yourself.

## Headless invocation (what `agent-hub`'s adapter builds)

```
agy -p "<task>" --output-format stream-json --model <model> --mode plan|accept-edits \
    --add-dir <cwd> --dangerously-skip-permissions [--print-timeout <timeoutS>s] \
    [--conversation <sessionId>]
```

- `mode:'read'` → `--mode plan`; `mode:'write'` → `--mode accept-edits`. agy 1.2.1's `--mode`
  only accepts these two values — the hub never passes `'read'`/`'write'` through verbatim.
- `--add-dir <cwd>` is **required** for the Claude models hosted inside agy
  (`claude-sonnet-4-6`, `claude-opus-4-6-thinking`): without it they answer *"You don't have an
  active workspace set"* and never touch the filesystem, while the Gemini models silently
  inherit the cwd anyway. A `sonnet` review that returns `INSUFFICIENT_EVIDENCE` at baseline
  token count means *no workspace*, not *no findings* — check `--add-dir` was passed first.
- `--print-timeout <timeoutS>s` is agy's own turn timeout, set to the same `timeoutS` the hub
  resolved for this job. The hub's own hard kill fires `KILL_GRACE_S` (30s) later, giving agy
  room to hit its print-timeout and exit gracefully with a partial result first.
- `--conversation <sessionId>` resumes a prior turn — this is what `job_reply` uses, and what
  lets `mode` change between turns of the same conversation (verified live: `plan` → `plan` with
  feedback → `accept-edits` correctly edited only what was approved).
- Result parsing (stream-json, NDJSON): `{"event":"init",...}`, `{"event":"step_update",
  "step_update":{"step_type":"agent_response","text_delta":"...",...}}`, and a final
  `{"event":"result","result":{...}}` whose nested object is the real envelope — fields used:
  `.status`, `.response`, `.usage.total_tokens`, `.conversation_id`, `.duration_seconds`. The
  accumulated `text_delta` of `agent_response` steps is kept as partial/fallback text. The
  legacy single-line `--output-format json` envelope (no `"event"` wrapper) still parses too.

## Models (agy 1.2.1, verified `agy models`, 2026-09-11)

| Model | Tier | Use it for |
|---|---|---|
| `gemini-3.8-flash-low` | cheap | recon, single-file facts, inventories, greps, counts (4-10s) |
| `gemini-3.8-flash-medium` | cheap | multi-file lookups with light reasoning (~15s) |
| `gemini-3.8-flash-high` | mid | call-chain-trace, cross-module tracing, 1M ctx (30-110s) |
| `gemini-3.1-pro-low` / `-high` | mid / expensive | second architectural opinion, dense reasoning |
| `claude-sonnet-4-6` | mid | adversarial diff review, judge (hosted Claude, zero Claude-quota cost) |
| `claude-opus-4-6-thinking` | expensive | architecture, hardest review, disagreement resolution |
| `gpt-oss-120b-medium` | mid | opinion diversity on a contested call |

`gemini-3.7-flash-*` aliases still exist but are legacy — route to `3.8`. Start at `low`;
escalate only when it answers `INSUFFICIENT_EVIDENCE` or returns something provably wrong.

## Health / quota signal

- `agy models` = L1 listing check.
- No non-interactive quota/usage endpoint exists. The circuit breaker learns from failures:
  ≥2 `quota`/`canceled` `job.failed` events for the same agent+model pair within 30 minutes
  opens the breaker (`agents_status`/`route` then treat that pair as unusable).
- Refresh cadence: Flash tier ~5h, Pro/Claude tiers weekly.
- `cli.log` "not logged in" lines are **not reliable** — models were still listed while that
  line was present. Do not treat it as an outage signal.

## Gotchas (measured)

1. **Silent cancel.** Headless agy auto-denies any tool that needs a permission prompt and
   returns `status:CANCELED` with an empty response and **exit code 0**. This is why the hub
   always passes `--dangerously-skip-permissions` and classifies non-`SUCCESS` status as an
   error rather than trusting exit code.
2. **`--json-schema` is unreliable.** It returned `structured_output:{"files":[]}` while the
   free text held the correct answer. Never rely on it — shape output through the prompt.
3. **~21k input tokens of baseline** per call (from `~/.gemini/GEMINI.md`, 80KB). Batch related
   questions into one call as numbered blocks rather than firing several small ones.
4. **`agy -p` does not auto-load this repo's `GEMINI.md`/`CLAUDE.md`.** Verified: asked whether
   its loaded context mentioned an app name that only exists in that repo, it answered `NO` at baseline token count. Only the
   global `~/.gemini/GEMINI.md` reaches it. A raw `agy` call has no idea this repo's rules
   exist — it will assume the whole monorepo is Vite and that the repo-specific apps don't exist. (The
   `agy-run.sh` no-MCP fallback injects `<cwd>/GEMINI.md` by hand for this reason; the hub's
   adapter does not do this injection — task prompts delegated through the hub should restate
   any load-bearing repo rule inline.)
5. **Latency is highly variable, and a timeout means the turn is truly abandoned, not just
   slow.** The same `low` question measured 4s, 9s, and over 300s on different calls; medium/high
   runs of 278s/303s were measured live. Timeouts: 300s (low), 600s (medium), 900s (high/rest) —
   see `config.mjs` `DEFAULT_TIMEOUTS_S`. When agy's own `--print-timeout` fires it prints `[agy]
   print timeout after <n> with turn in progress; returning partial output` and still exits 0
   with `status:SUCCESS` and an **empty** response — verified live that resuming that exact
   conversation and asking for the answer returned `UNFINISHED`, not the real answer. The hub
   classifies this as `errorKind:'timeout'` (matching on the stdout line, not just its own hard
   kill) and records the `conversation_id` and any streamed `text_delta` as `sessionId`/partial
   text, so `job_reply({jobId, message:'<retry>'})` can resume the same conversation instead of
   starting cold.
6. Classic `gemini` CLI (not `agy`) hangs under WSL because it lives on `/mnt/c` — unrelated to
   `agy`, but a reminder every probe needs a timeout.

## No-MCP fallback

`~/.claude/skills/agy-delegate/scripts/agy-run.sh --task "<question>" [--model
low|medium|high|pro|sonnet|opus|oss] [--max-lines N] [--timeout S] [--write] [--raw] [--cwd
DIR]`. Prepends the output contract (mandatory — a naive call is 108s/~27k tokens vs 4s/233
with the contract) and injects `<cwd>/GEMINI.md` (<8KB) as project rules, which the MCP
adapter's raw argv does not do.
