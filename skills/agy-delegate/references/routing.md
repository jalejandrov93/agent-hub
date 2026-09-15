# Routing detail — when `agy` pays off, and when it costs you

> Canonical agy reference (models, health signals, gotchas) is now
> `~/.claude/skills/multi-agent-orchestrator/references/agents/agy.md`. This file keeps the
> prompt-pattern and anti-pattern detail for the no-MCP `agy-run.sh` fallback.

## The break-even rule

Delegation to `agy` is worth it when:

```
tokens(files agy reads)  >>  tokens(answer agy returns)  +  tokens(verification you still need)
```

The third term is the one people forget. If you cannot trust the answer without opening the
same files, you paid the Antigravity quota *and* the Claude quota. That is worse than not
delegating.

**Rule of thumb:** delegate when the answer is a *location*, a *list*, a *count*, or a
*summary*. Do not delegate when the answer is a *judgement* you must audit.

## Model selection

> Author's setup (verified 2026-09-11, agy 1.2.1): the aliases below matched `agy models`'s
> output, superseding a 2026-09-01 reading — the CLI had moved from `gemini-3.7-flash-*` to
> `gemini-3.8-flash-*`, and `agy-run.sh`'s aliases were updated to match. Re-verify against your
> own `agy models` output; alias-to-id mappings shift as agy's catalog moves.

| Alias | Model id | Use it for | Measured latency |
|---|---|---|---|
| `low` | `gemini-3.8-flash-low` | Single-file facts, inventories, greps, counts | 4–10s |
| `medium` | `gemini-3.8-flash-medium` | Multi-file lookups with light reasoning | ~15s |
| `high` | `gemini-3.8-flash-high` | Call chains, cross-module tracing | 30–110s |
| `pro` | `gemini-3.1-pro-high` | Dense reasoning, design critique | slow |
| `sonnet` | `claude-sonnet-4-6` | Adversarial review, second opinion | — |
| `opus` | `claude-opus-4-6-thinking` | Hardest review, disagreement resolution | — |
| `oss` | `gpt-oss-120b-medium` | Opinion diversity on a contested call | — |

Start at `low`. Escalate only when `low` answers `INSUFFICIENT_EVIDENCE` or returns something
you can prove wrong. Escalating on a hunch spends latency for nothing.

## Prompt patterns that work

Every one of these was validated against this monorepo.

**Locate** — the highest-value pattern:
```
--task "Which files under apps/web/src define a Redis cache key? One relative path per line." --model low --max-lines 15
```

**Bounded fact** — replaces three of your own file reads:
```
--task "Does apps/web/src/server/media/media-profiles.ts define a featuredImage profile? Answer yes/no plus the line number." --model low --max-lines 3
```

**Inventory with positions** — measured at 13 lines / 10s:
```
--task "In <file>, list exported functions that perform a Prisma write. One per line as name:line." --model low --max-lines 15
```

**Compress an artifact you never want in context:**
```
--task "Read /tmp/ci.log. List only the failing test names and their assertion messages." --model low --max-lines 30
```

**Adversarial review on the Antigravity quota:**
```
--task "Review the diff in <file> for correctness and edge cases. List concrete defects as path:line — claim. No praise, no summary." --model sonnet --max-lines 40
```

## Anti-patterns

| Anti-pattern | Why it fails | Do instead |
|---|---|---|
| "Map this module" with no shape | 108s, 27k tokens of `file://` noise | Name the exact fields and the line budget |
| Relying on `--json-schema` | Returned an empty `structured_output` while the text was right | Shape the output in the prompt |
| Several small sequential calls | ~21k baseline tokens each | Batch related questions into one `--task` |
| Delegating a design decision | You re-read the code to trust it — paid twice | Use `agy` for the *evidence*, decide yourself |
| Letting `agy` write into your repo's denylisted paths (migrations, generated files, etc.) | It never read this repo's `CLAUDE.md`/`AGENTS.md`, so it has no idea what's off-limits | State the denylist explicitly in the task; keep those paths out of `--write` |
| Calling `agy` directly instead of the wrapper | No output contract → context flood, and no project rules | Always `agy-run.sh` |
| Assuming `agy` read the repo's `GEMINI.md` | It does not. Verified: it answered `NO` when asked if a repo-only app name was in its context | The wrapper injects it; keep it under 8KB |

## Batching

Because every call carries ~21k baseline input tokens, three questions in one `--task` cost
roughly one third of three separate calls. Number them and demand a numbered answer:

```
--task "Answer as three numbered blocks, max 5 lines each.
1) Which files import resolveCmsImageUrl?
2) Where is CMS_ASSETS_BASE_URL read?
3) Does any client component read it directly?" --model low --max-lines 18
```

## Session reuse

`agy --continue` and `agy --conversation <id>` resume a conversation. The wrapper prints the
conversation id on failure only; for a genuine multi-turn investigation, call `agy` with
`--conversation` directly — but keep the same output contract in every turn, or the second
turn floods your context with the verbosity the first one avoided.
