# GitHub Copilot CLI

## Headless invocation (what `agent-hub`'s adapter builds)

```
copilot -p "<task>" -s --output-format json --model <model> --no-ask-user \
    [--deny-tool=write --deny-tool=shell | --allow-all-tools] --add-dir <cwd>
```

- `mode:'read'` → adds `--deny-tool=write --deny-tool=shell` (deny wins over allow).
  `mode:'write'` → `--allow-all-tools`.
- Result parsing: JSONL event stream. Find the last `type:'result'` event; success requires
  `exitCode === 0`. Response text comes from the last `assistant.message` event's
  `.data.content`. Copilot's JSON stream **never reports a token count** — only
  `resultEvent.usage.premiumRequests`.
- Tool denials in read mode surface as `tool.execution_complete` events with
  `data.success:false`, `data.error:{code:'denied', message:...}` — the adapter collects these
  into `toolDenials` on the parsed result rather than treating the whole job as failed, since a
  partial read-mode answer can still be useful.
- **Combine stdout+stderr before classifying errors.** The `model_unavailable` rejection message
  was measured on **stderr**, while the JSONL status/result stream is stdout. Reading stdout
  alone silently misses it and misclassifies as `crash`.

## Models — `--model` availability is subscription-specific; verify before trusting an id

`copilot help config` documents a large model catalog (`gpt-5-mini`, `gpt-4.1`, `gpt-5.4-mini`,
`gpt-5.4`, `gpt-5.3-codex`, `claude-sonnet-4.6`, `claude-haiku-4.5`, `claude-opus-4.7`, etc.).
**That catalog is documentation, not availability** — which ids actually work depends on the
Copilot plan/subscription behind the CLI. A rejected id fails with:

```
Error: Model "<id>" from --model flag is not available.
```

written to stderr (process exit code is not reliable for this — the adapter matches on message
text, not exit code). `--model auto` is always accepted and lets Copilot resolve to whatever
model the plan actually grants. **Route to `auto` for every task type; treat any explicit id as
`degraded`/unverified until an L3 ping confirms it (`agent-hub preflight --agent copilot
--model <id> --ping`).**

copilot auto-updates its own binary — do not assume a pinned CLI version.

> Author's setup (verified live, 2026-09): every explicit id tried (`gpt-5-mini`, `gpt-4.1`,
> `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.4`, `claude-sonnet-4.6`, `claude-haiku-4.5`,
> `gpt-5.6-luna`) was rejected; only `auto` worked, silently resolving to `gpt-5.6-luna` — an id
> that does not even appear in `help config`. Binary version observed jumping 1.0.31 → 1.0.83
> mid-session.

## Health / quota signal

- `copilot help config` = L1 listing, advisory only (see above — catalog membership does not
  prove availability for anything but `auto`).
- Quota: `gh api /copilot_internal/user` → `quota_snapshots.premium_interactions
  .percent_remaining` — advisory; a credits-based billing plan can make this number stop
  reflecting real remaining capacity. Do not gate delegation on it, only inform.

## Gotchas (measured)

1. Never assume an explicit `--model` id will work on a given subscription — use `auto` unless
   you've verified the id with an L3 ping.
2. A `model_unavailable` errorKind is not retriable on that id; re-route to `auto` immediately,
   don't retry the same id.
3. If writing an error classifier or debugging a `crash` misclassification here, check stderr
   first — copilot's most distinctive failure message lives there, not on stdout.
4. `--add-dir <cwd>` still applies the same as other adapters even though `auto` resolves the
   model automatically.
