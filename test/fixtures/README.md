# Adapter fixtures — provenance

Recorded 2026-09-11 against `agy` 1.2.1, `opencode` 1.18.30, `copilot` 1.0.31.
Every command was run with `timeout -k 5 <n>` in the foreground with a tiny
prompt (`Reply exactly: PONG`), from `~/.claude/mcp-servers/agent-hub` as cwd.

## REAL (actual CLI output, byte-for-byte)

- `agy/success.txt` — `agy -p "Reply exactly: PONG" --output-format json --model gemini-3.8-flash-low --mode plan --add-dir <cwd> --dangerously-skip-permissions`
- `agy/models.txt` — `agy models`
- `opencode/success.jsonl` — `opencode run "Reply exactly: PONG" -m opencode/muse-spark-1.3-contributor-free --format json --agent plan --dir <cwd> --title fixture-pong`
  (NOTE: `opencode/nemotron-3.5-lightning-free`, the model named in the original
  plan, hung for the full 90s timeout and was SIGKILLed twice in a row — it is
  a real model id per `opencode models opencode --verbose` but was unusable at
  recording time. `muse-spark-1.3-contributor-free` answered in ~3s instead.)
- `opencode/models-verbose.txt` — `opencode models opencode --verbose` (first ~100 lines; full catalog is much
  longer, current free ids as of recording: `big-pickle`, `ling-3.0-flash-fin-free`,
  `mimo-v2.5-free`, `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free`,
  `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`)
- `copilot/success.jsonl` — `copilot -p "Reply exactly: PONG" -s --output-format json --model auto --no-ask-user --deny-tool=write --deny-tool=shell --add-dir <cwd>`
  (`--model gpt-5-mini` — the id named in the plan and *listed* in `help config`
  — failed every attempt with `Error: Model "gpt-5-mini" from --model flag is
  not available.`, so did every other doc-listed id we tried: `gpt-4.1`,
  `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.4`, `claude-sonnet-4.6`,
  `claude-haiku-4.5`, `gpt-5.6-luna`. Only `--model auto` worked; it resolved
  to `gpt-5.6-luna`, a model id that does not appear in `help config` at all.
  See the README discovered-facts section for the implication.)
- `copilot/help-config.txt` — `copilot help config`
- `copilot/model_unavailable.txt` — re-recorded 2026-09-11 against copilot 1.0.83 (it auto-updated
  mid-session): `copilot -p "Reply exactly: PONG" -s --output-format json --model gpt-5-mini
  --no-ask-user --allow-all-tools --deny-tool=write --deny-tool=shell --add-dir <cwd>`. Prints the
  MCP status events then the plain (non-JSON) line `Error: Model "gpt-5-mini" from --model flag is
  not available.`. Exit code observed here was 1; the parent orchestrator separately verified exit
  0 for the same message on the same copilot version — classifyError matches on the message text,
  not the exit code, so this is moot for parsing but is recorded here as an open discrepancy. This
  file is stdout+stderr merged (`2>&1`), matching how adapters/copilot.mjs's classifyError is
  actually called throughout this codebase (jobrunner.mjs always merges both streams into one log).
- `copilot/model_unavailable.stdout-only.txt` and `.stderr-only.txt` — the SAME rejection with the
  two streams captured separately. Important finding: `Error: Model "..." is not available.` is
  written to **stderr**, the JSONL status noise to stdout. `preflight.mjs`'s `pingAgent` originally
  called `commandRunner` (which keeps the streams separate) and only passed `result.stdout` to
  `classifyError`, so it silently missed this error and misclassified it as a generic `crash`. Fixed
  by combining `stdout+stderr` before classifying in `pingAgent`, matching jobrunner's existing
  merged-log convention. Regression test: `test/preflight.test.mjs` "copilot writes the
  model-unavailable rejection to STDERR".
- `copilot/tool_denied.jsonl` — `copilot -p "Create a file named deny-test.txt with content: hello" -s --output-format json --model auto --no-ask-user --deny-tool=write --deny-tool=shell --add-dir <cwd>`,
  a real reproducible write-mode denial. The interesting event is
  `tool.execution_complete` with `data.success:false` and
  `data.error:{message:"Permission to run this tool was denied due to the
  following rules: \`write\`", code:"denied"}`. No file was created.

## REAL, recorded 2026-09-11 during live orchestrator work (not this fixture-recording session)

- `agy/stream-success.jsonl` — a real `--output-format stream-json` turn (gemini-3.8-flash-low): NDJSON
  `init` -> `step_update` (agent_response, streamed as text_delta) -> `result` (status SUCCESS, response
  "PONG-42\n", conversation_id `9b4f88b8-...`). Confirms the final `result` event's nested `result` object
  is the real envelope, not the top-level line.
- `agy/stream-timeout.jsonl` — a real agy turn that hit its own `--print-timeout 20s` (gemini-3.8-flash-medium):
  `init`, then the plain-text diagnostic line `[agy] print timeout after 20s with turn in progress; returning
  partial output`, then a `result` event with `status:"SUCCESS"`, empty `response`, all-zero `usage`. agy
  exits 0 here — the hub's own hard-kill (`exitInfo.timedOut`) never fires — so classifyError must also match
  the stdout diagnostic line. Separately verified live: resuming this exact conversation_id and asking for the
  answer returned `UNFINISHED` — the turn was truly abandoned, not just slow to report.
- `opencode/billing-402.jsonl` — a real DeepSeek `deepseek-v4-pro` run that failed with `statusCode:402`
  `"Insufficient Balance"` (copied from a real `runs/<jobId>/stdout.log`, read-only, run dir untouched).
  Previously misclassified as generic `crash`; now a distinct `billing` kind that opens the circuit breaker
  immediately instead of waiting for the quota/canceled failureThreshold.

## SYNTHETIC (cannot be reproduced safely / on demand — hand-built from the documented shapes)

- `agy/stream-empty.jsonl` — a stream-json turn that completes SUCCESS with an empty response and no
  `agent_response` text_delta at all (distinct from `stream-timeout.jsonl`: no print-timeout marker, and a
  real non-zero token count) — classifies as the retriable `empty` kind, not `timeout`.

- `agy/canceled.txt` — models the documented CANCELED failure mode (headless
  agy auto-denies a permission prompt): `status:"CANCELED"`, empty `response`,
  process exit 0. Not reproduced live because it requires a tool that actually
  needs a permission prompt under `--dangerously-skip-permissions`, which we
  did not want to trigger against this repo.
- `agy/quota.txt` — models a 429/RESOURCE_EXHAUSTED failure: no JSON envelope
  on stdout at all, only a diagnostic line, matching `agy-run.sh`'s handling
  ("no JSON envelope returned" -> exit 2). Not reproduced live because it
  requires actually exhausting the Antigravity quota.
- `opencode/empty.jsonl` — models the documented drop of `text`/`step_finish`
  events: only `step_start` and a `tool_use` event, no `text`, no
  `step_finish`. Not reproduced live because the drop is nondeterministic.
- `copilot/auth_failed.txt` — models an unauthenticated `copilot` invocation.
  Not reproduced live because it requires logging the local `copilot` CLI out.
