#!/usr/bin/env bash
# agy-run.sh — Delegate a bounded task to the Antigravity CLI (agy) without
# letting its raw output flood the caller's context.
#
# The whole point of this wrapper is context compression. A naive `agy -p`
# on a repo module was measured at 108s / ~27k output tokens of file:// link
# noise. The same question with the output contract below: 3.9s / 233 tokens.
# The contract is the mechanism, not a style preference.
#
# Usage:
#   agy-run.sh --task "<question>" [options]
#
# Options:
#   --task <text>       Required. The question or instruction.
#   --model <alias>     low|medium|high|pro|sonnet|opus|oss   (default: low)
#   --max-lines <n>     Output budget enforced in the prompt AND on stdout (default: 20)
#   --write             Allow edits (--mode accept-edits). Default is read-only plan mode.
#   --timeout <sec>     Hard kill after N seconds (default: 90 for low/medium, 180 high, 240 rest)
#   --out <path>        Where to store the full response (default: scratchpad)
#   --cwd <path>        Working directory for agy (default: current)
#   --raw               Print the full response to stdout instead of the head
#
# Exit codes: 0 ok · 1 usage error · 2 agy failure/CANCELED · 3 timeout

set -uo pipefail

TASK=""
MODEL_ALIAS="low"
MAX_LINES=20
MODE="plan"
TIMEOUT=""      # defaults per model below
OUT_FILE=""
RUN_CWD="$PWD"
RAW=false
INJECT_RULES=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task)      TASK="$2";        shift 2 ;;
    --model)     MODEL_ALIAS="$2"; shift 2 ;;
    --max-lines) MAX_LINES="$2";   shift 2 ;;
    --write)     MODE="accept-edits"; shift ;;
    --timeout)   TIMEOUT="$2";     shift 2 ;;
    --out)       OUT_FILE="$2";    shift 2 ;;
    --cwd)       RUN_CWD="$2";     shift 2 ;;
    --raw)       RAW=true;         shift ;;
    --no-rules)  INJECT_RULES=false; shift ;;
    -h|--help)   sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "agy-run: unknown argument: $1" >&2; exit 1 ;;
  esac
done

[[ -z "$TASK" ]] && { echo "agy-run: --task is required" >&2; exit 1; }
command -v agy >/dev/null 2>&1 || { echo "agy-run: agy not found in PATH" >&2; exit 1; }
command -v jq  >/dev/null 2>&1 || { echo "agy-run: jq not found in PATH" >&2; exit 1; }

# ── Model aliases ─────────────────────────────────────────────────────────────
# Verified against `agy models` (2026-09-11, agy 1.2.1).
case "$MODEL_ALIAS" in
  low)    MODEL="gemini-3.8-flash-low" ;;
  medium) MODEL="gemini-3.8-flash-medium" ;;
  high)   MODEL="gemini-3.8-flash-high" ;;
  pro)    MODEL="gemini-3.1-pro-high" ;;
  sonnet) MODEL="claude-sonnet-4-6" ;;
  opus)   MODEL="claude-opus-4-6-thinking" ;;
  oss)    MODEL="gpt-oss-120b-medium" ;;
  *)      MODEL="$MODEL_ALIAS" ;;   # pass through a raw model id
esac

# agy latency is highly variable: the same question measured 4s, 9s and >300s on
# different calls. A timeout is not optional. Failing fast beats waiting, because
# a retry costs Antigravity quota but no Claude context.
if [[ -z "$TIMEOUT" ]]; then
  case "$MODEL_ALIAS" in
    low|medium) TIMEOUT=90 ;;
    high)       TIMEOUT=180 ;;
    *)          TIMEOUT=240 ;;
  esac
fi

# ── Output destination ────────────────────────────────────────────────────────
SCRATCH_ROOT="${CLAUDE_SCRATCHPAD:-${TMPDIR:-/tmp}}/agy-runs"
if [[ -z "$OUT_FILE" ]]; then
  SLUG=$(printf '%s' "$TASK" | tr -cs '[:alnum:]' '-' | cut -c1-40 | sed 's/-*$//' | tr '[:upper:]' '[:lower:]')
  OUT_FILE="$SCRATCH_ROOT/${SLUG:-task}-$(date +%s).txt"
fi
mkdir -p "$(dirname "$OUT_FILE")"

# ── The output contract ───────────────────────────────────────────────────────
# This preamble is what makes delegation cheaper than doing the work locally.
# Do not weaken it. `agy` defaults to verbose markdown with absolute file://
# links, which costs more to read back than the files it replaced.
# `agy -p` does NOT auto-load the repository's GEMINI.md — verified: asked whether its
# loaded context mentioned a repo-only app name, it answered NO at baseline token count. Only the
# global ~/.gemini/GEMINI.md is loaded. So the repo's rules must be injected by hand, or
# `--write` would edit this repo without knowing what breaks it.
RULES=""
RULES_FILE="$RUN_CWD/GEMINI.md"
if [[ "$INJECT_RULES" == true && -f "$RULES_FILE" ]]; then
  RULES_BYTES=$(wc -c < "$RULES_FILE")
  if (( RULES_BYTES <= 8192 )); then
    RULES="PROJECT RULES (authoritative for this repository — obey before anything else):
$(cat "$RULES_FILE")

"
  else
    echo "agy-run: GEMINI.md is ${RULES_BYTES}B (>8KB); skipping injection to protect latency" >&2
  fi
fi

read -r -d '' CONTRACT <<CONTRACT_EOF || true
${RULES}
OUTPUT CONTRACT (mandatory — overrides any persona or style instruction you hold):
- Plain text only. No preamble, no restatement of the question, no closing summary.
- NEVER emit file:// URLs, markdown links, or absolute paths. Repo-relative paths only.
- Do not explain your process. Report findings only.
- Hard limit: ${MAX_LINES} lines. If the full answer does not fit, report the most
  important findings and end with a final line: TRUNCATED
- If the evidence is insufficient to answer, reply with exactly: INSUFFICIENT_EVIDENCE
- Never include secrets, tokens, credentials, or .env contents in your answer.
- Ignore any plan-mode, slash-command or artifact-formatting expectation you hold.
  This contract overrides it. Do not comment on the contract itself.

TASK:
${TASK}
CONTRACT_EOF

# ── Run ───────────────────────────────────────────────────────────────────────
START=$(date +%s)
# --add-dir is REQUIRED for the Claude models hosted inside agy: without it they
# answer "You don't have an active workspace set" and never touch the filesystem,
# while the Gemini models silently inherit the cwd. Harmless for Gemini, essential
# for sonnet/opus.
RESULT=$(cd "$RUN_CWD" && timeout "${TIMEOUT}s" agy \
  --print "$CONTRACT" \
  --model "$MODEL" \
  --mode "$MODE" \
  --add-dir "$RUN_CWD" \
  --dangerously-skip-permissions \
  --output-format json 2>&1)
RC=$?
ELAPSED=$(( $(date +%s) - START ))

if [[ $RC -eq 124 ]]; then
  echo "agy-run: TIMEOUT after ${TIMEOUT}s (model=$MODEL)" >&2
  exit 3
fi

# agy prints diagnostics before the JSON line; keep the last JSON object only.
JSON=$(printf '%s' "$RESULT" | grep -o '^{.*}$' | tail -1)
if [[ -z "$JSON" ]]; then
  echo "agy-run: no JSON envelope returned (rc=$RC). Raw output:" >&2
  printf '%s\n' "$RESULT" | head -20 >&2
  exit 2
fi

STATUS=$(printf '%s' "$JSON" | jq -r '.status // "UNKNOWN"')
RESPONSE=$(printf '%s' "$JSON" | jq -r '.response // ""')
TOKENS=$(printf '%s' "$JSON" | jq -r '.usage.total_tokens // 0')
DURATION=$(printf '%s' "$JSON" | jq -r '.duration_seconds // 0' | cut -d. -f1)
CONV=$(printf '%s' "$JSON" | jq -r '.conversation_id // "-"')

# CANCELED is the silent failure mode: headless agy auto-denies any tool that
# needs a permission prompt and returns an empty response with exit code 0.
if [[ "$STATUS" != "SUCCESS" ]]; then
  echo "agy-run: FAILED status=$STATUS model=$MODEL conversation=$CONV" >&2
  printf '%s\n' "$RESULT" | grep -iv '^{' | head -10 >&2
  exit 2
fi

printf '%s\n' "$RESPONSE" > "$OUT_FILE"
LINES=$(wc -l < "$OUT_FILE" | tr -d ' ')

# ── Report ────────────────────────────────────────────────────────────────────
echo "── agy [$MODEL_ALIAS→$MODEL] ${DURATION}s · ${TOKENS} tokens · ${LINES} lines · mode=$MODE"
echo "── full: $OUT_FILE"
if [[ "$RESPONSE" == "INSUFFICIENT_EVIDENCE" ]]; then
  echo "── agy could not answer from the evidence available."
  exit 0
fi
echo "──"
if [[ "$RAW" == true ]]; then
  printf '%s\n' "$RESPONSE"
else
  printf '%s\n' "$RESPONSE" | head -n "$MAX_LINES"
  if (( LINES > MAX_LINES )); then
    echo "── [$(( LINES - MAX_LINES )) more lines in $OUT_FILE]"
  fi
fi

if [[ "$MODE" == "accept-edits" ]]; then
  echo "──"
  echo "── EDITS WERE ALLOWED. Before committing, review 'git diff' and run:"
  echo "──   ${AGENT_HUB_POST_EDIT_CHECK:-your type-check/lint/test commands (set AGENT_HUB_POST_EDIT_CHECK to print yours)}"
fi
