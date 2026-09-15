---
name: agy-delegate
description: >
  Pointer to the agent-hub MCP delegation flow for Antigravity (`agy`) tasks — recon, symbol
  inventories, call-chain tracing, summarizing huge artifacts, second opinions, adversarial
  review via Claude Sonnet/Opus hosted inside Antigravity.
  Trigger: "agy", "antigravity", "gemini flash", "delegate this", "save tokens",
  "use my antigravity quota", "don't burn Claude", "cheap model", "second opinion".
license: Apache-2.0
metadata:
  author: jalejandrov93
  version: "2.1"
---

## Use `agent-hub`, not this skill directly

Prefer `delegate({agent:'agy', model, task, cwd, mode, ...})` through the `agent-hub` MCP
server. Read `~/.claude/skills/multi-agent-orchestrator/SKILL.md` for the full loop
(`agents_status → route → delegate → job_wait/job_status → job_result → synthesize`), the
break-even rule, and the delegation map. Agy-specific models, health signals, measured
latencies, and gotchas (silent `CANCELED`, `--json-schema` unreliability, `GEMINI.md` not
auto-loaded, `--add-dir` requirement for hosted Claude models) live in
`~/.claude/skills/multi-agent-orchestrator/references/agents/agy.md` — that file is now
canonical; this skill only points to it.

## No-MCP fallback

If `agent-hub` is not registered in this session, use the wrapper script directly:

```bash
~/.claude/skills/agy-delegate/scripts/agy-run.sh \
  --task "<question>" [--model low|medium|high|pro|sonnet|opus|oss] \
  [--max-lines N] [--timeout S] [--write] [--raw] [--cwd DIR]
```

Aliases resolve to `gemini-3.8-flash-{low,medium,high}`, `gemini-3.1-pro-high` (`pro`),
`claude-sonnet-4-6` (`sonnet`), `claude-opus-4-6-thinking` (`opus`), `gpt-oss-120b-medium`
(`oss`) — check them against your own `agy models` output, since agy's catalog moves over time.
It writes the full response to the scratchpad and prints only a header (`model · seconds ·
tokens · lines · mode`), the file path, and the first `--max-lines` lines; injects
`<cwd>/GEMINI.md` (if <8KB) as project rules since `agy -p` does not auto-load it; and always
passes `--dangerously-skip-permissions` + `--add-dir` (required for the hosted Claude models).
Never call `agy` directly — the wrapper's output contract is the difference between 108s/~27k
tokens and 4s/233 tokens.

> Author's setup (verified 2026-09-11 against agy 1.2.1's `agy models` output): the aliases
> above matched these exact ids.

## Resources

- Canonical agy reference (models, health, gotchas): `~/.claude/skills/multi-agent-orchestrator/references/agents/agy.md`
- Routing detail and anti-patterns: [references/routing.md](references/routing.md)
- Wrapper: [scripts/agy-run.sh](scripts/agy-run.sh)
