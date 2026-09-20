# ODD Feature: C2 — Evidence & Artifacts

## Objective

Give workflow nodes a first-class evidence layer: each node can produce named
structured artifacts on disk, and downstream nodes can consume them by
reference (`artifact://workflow/node/name`) instead of receiving a giant
inline response. Node completion records a manifest of which promised
artifacts actually exist.

## Problem

Today a workflow node's only output is the agent CLI's `response.txt` inside
`runs/<jobId>/`. The engine persists that whole job record into
`workflow_nodes.result_json`, so passing a research brief to an implementation
node means inlining an unbounded string, and "what did this node actually
produce" is not answerable from the workflow state. There is no typed,
file-backed evidence and no stable reference across runs.

## Why now

C3 (verifier) needs files to verify (test reports, diffs, acceptance checks)
and C4 (judge) needs evidence to judge. Neither can be built on an opaque
response string. C2 is the prerequisite, and the frozen roadmap puts it first.

## Scope

In scope:
- `src/artifacts.mjs`: artifact reference parsing/formatting, path-safe
  resolution under `runs/<workflowId>/<stepId>/artifacts/`, atomic
  write/read/list, manifest collection, and bounded `artifact://` inlining.
- `src/workflow/schema.mjs`: optional per-node `artifacts: string[]` declaring
  the evidence files the node must produce.
- `src/workflow/engine.mjs`: create the node's artifacts dir, tell the agent
  where to write declared artifacts, resolve upstream `artifact://` refs into
  the dispatched task, and write a manifest after the node succeeds.
- Tests: `test/artifacts.test.mjs` (pure module) and
  `test/workflow-artifacts.test.mjs` (engine integration).
- Docs: README section + CHANGELOG entry.

Out of scope (explicit follow-ups):
- Failing a node when a declared artifact is missing — that is C3's verifier.
- Artifacts for `fanout` children (delegate nodes only in this slice).
- Any MCP tool to read artifacts; the ref format is the interface for now.

## Constraints

- Path safety is non-negotiable: every workflowId/stepId/name used as a path
  segment must match the same shape `src/jobstore.mjs` uses for job ids, and
  the resolved path must stay inside the runs directory.
- No `eval`/`new Function` anywhere (C1.1 rule).
- Additive only: existing node result shape, events, and SQLite schema are
  unchanged. The manifest is a sibling file on disk, not a new column.
- Strict TDD: failing test first, observed RED, then GREEN.

## Resolved TDD

- Mode: `on` (strict TDD, project default).
- Runner: `node --test <file>` (repo script: `npm test`).
- Source: orchestrator strict-TDD mode + existing repo convention.

## Delegation route

- T1/T2: delegated writer (`agent-hub` `delegate`, `agy`, `gemini-3.8-flash-high`,
  `mode: write`) in worktree `/home/alejandro/Desarrollo/agent-hub-worktrees/c2-artifacts`.
  Trigger: 2+ non-trivial files, context-heavy.
- Orchestrator: design, feature doc, review, independent verification, commits.
- No Claude delegation (quota): executors are agy gemini-3.8-flash.

## Tasks

| ID | Task | Route | Evidence |
|----|------|-------|----------|
| T1 | `src/artifacts.mjs` + `test/artifacts.test.mjs` | delegated writer | RED then GREEN output |
| T2 | Schema `artifacts[]` + engine integration + `test/workflow-artifacts.test.mjs` | delegated writer | RED then GREEN output |
| T3 | README + CHANGELOG docs | delegated writer (small) | diff read-back |

## Acceptance criteria

- `artifact://<workflowId>/<stepId>/<name>` round-trips through
  `artifactRef` / `parseArtifactRef`; malformed refs parse to `null`.
- Path traversal (`..`, absolute paths, empty segments) is rejected for every
  segment.
- `writeArtifact` is atomic and returns `{ref, path, bytes, sha256}`;
  `readArtifact` returns the content; a missing artifact throws
  `artifact not found: <ref>`.
- `collectManifest` reports declared names as `present`/`missing` with ref +
  bytes.
- `resolveArtifactRefs` replaces every `artifact://` token with file content
  under a per-ref byte cap and reports what it inlined/truncated.
- Engine: a delegate node with `artifacts: [...]` gets its dir created, the
  instruction appended to the task, and a manifest written on success.
- Engine: a downstream node whose task contains an upstream `artifact://` ref
  receives the upstream file content in its dispatched task.
- Engine: an unresolvable `artifact://` ref fails that node with a clear error.
- Full suite green: `npm test` (new tests included, no regression).

## Checks

- `node --test test/artifacts.test.mjs`
- `node --test test/workflow-artifacts.test.mjs`
- `npm test`

## Progress log

- 2026-09-20: feature doc created; worktree + branch `feat/c2-artifacts`.
