# ODD Feature: opencode model policy (dashboard allowlist + catalog-driven pools)

Objective: let the user decide from the dashboard which opencode models agent-hub may use, route opencode chain steps to allowed models from the live catalog, and block any other opencode model. Branch: `feat/opencode-model-policy` (from `origin/main` 7f9a565). Delivery: `ask-on-risk`. Test runner: `npm test` (node --test) + `npm --workspace dashboard test` (vitest) for the UI.

## Specs

- **S1 — Dashboard allowlist.** User: "los modelos dee opencode se actualizan frecuentemente, y de cierta forma deberia desde la dashboard elegir cuales si permitir usar, seria mas practico". Every model in the live opencode catalog is listed in the dashboard with an Allowed/Blocked toggle and a tier label (free, Go, paid); models not yet decided are marked "new". The decision persists in `$AGENT_HUB_HOME/model-policy.json` (survives reinstalls).
- **S2 — Routing uses only allowed models.** opencode chain steps name a pool (`@free`, `@go`) instead of a fixed model id. `route()` expands a pool into the allowed models of that pool that the current catalog lists, in the order set in the dashboard. A vanished model is skipped; with none left the chain falls through to the next agent.
- **S3 — Hard block.** User: "porque depronto delegamos a un agente que gaste mucha cuota de opencode". `delegate`/`dispatch` with an explicit opencode model that the policy does not allow is rejected before launch with a clear error.
- **S4 — Defaults for undecided models** (approved by the user, "si dale", 2026-10-25): free models (catalog cost 0) are allowed; Go (`opencode-go/*`) and paid models are blocked until the user enables them.
- **S5 — Docs.** opencode provider docs, routing docs, the orchestrator skill and CHANGELOG describe the policy and the pools; stale pinned ids are removed.

Assumptions (not stated by the user, chosen by the implementer):
- A1: pool assignment per task type: `recon`, `research`, `triage` → `@free`; `call-chain-trace` → `@go` then `@free`; `mechanical-edit` (write) → `@go`. A pool expands to at most 2 concrete candidates.
- A2: when the catalog is unavailable, an undecided model has unknown tier and is blocked (fail closed); explicitly allowed models stay allowed.
- A3: the policy applies to opencode only; other agents are unchanged.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1, S4 | inline | pending | `src/model-policy.mjs` storage, pool classification, allow decision + unit tests |
| T2 | S2 | inline | pending | pool steps in `DELEGATION_MAP`, expansion in `route()` and in map consumers (discovery, agents_status, drift, gaps, proposals) + tests |
| T3 | S3 | inline | pending | block in `delegate`/`dispatch` + errorKind + tests |
| T4 | S1 | inline | pending | dashboard API (`GET/PUT /api/model-policy`) + Agents view toggles and order + tests |
| T5 | S5 | inline | pending | docs, skill, CHANGELOG |

Route evidence: no Writer trigger (units are sequential: T2–T4 depend on T1's module), so the parent writes inline. Forecast: ~700 authored lines (over the 400 heuristic) → `ask-on-risk` asks for the chain strategy before the PR.

## Log

- L1 (2026-10-25, user, original request): "analiza como mejorar obtener los agentes de opencode, suelo usar opencode go y gratuitos"
- L2 (2026-10-25, user): "los modelos dee opencode se actualizan frecuentemente, y de cierta forma deberia desde la dashboard elegir cuales si permitir usar, seria mas practico, porque depronto delegamos a un agente que gaste mucha cuota de opencode"
- L3 (2026-10-25, user, approving the proposed design and S4 defaults): "si dale"
- L4 (evidence): live catalog has 48 opencode models (`opencode/*` Zen, `opencode-go/*` 30, `deepseek/*` 2); 8 free by catalog cost; none of the 4 pinned ids (`router.mjs` recon/call-chain-trace/research/triage/mechanical-edit) is listed. `effectiveChainFor` only appends (proposals.mjs:43-57); `overrides.json` supports only hold/breakerReset.
