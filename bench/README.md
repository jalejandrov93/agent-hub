# Benchmark Suite (`bench/run.mjs`)

The `bench/` directory contains an offline, deterministic workflow benchmark harness designed to measure and verify execution engine correctness, duplicate dispatch avoidance, and verification cycles.

## Execution

Run the benchmark suite offline:

```bash
node bench/run.mjs
```

### Offline & Quota-Free Guarantee

By default, the benchmark runs completely **offline and quota-free**:
- All dispatches and executions are mocked in-memory using `mockDispatch` and plan matrices.
- Each scenario executes in an isolated temporary `AGENT_HUB_HOME` directory.
- No real LLM providers or cloud APIs are queried, ensuring zero quota consumption.

## Built-In Scenarios

The suite exercises four scenarios defined in `bench/corpus.mjs`:

1. **`happy-path`**:
   - Sequential multi-step workflow (`plan` -> `execute`).
   - All steps complete successfully and pass verification.
2. **`retry-transient`**:
   - Exercises transient dispatch failures.
   - Verifies that failed steps are retried and succeed within `maxAttempts`.
3. **`revision-verification`**:
   - Simulates verification failure on initial output.
   - Verifies that the engine executes a revision loop (`maxRevisionAttempts`) before passing verification.
4. **`fanout-child-failure`**:
   - Executes parallel fanout branches where one child fails.
   - Verifies that the failure is cleanly propagated to the parent workflow without dangling executions.

## Opt-In Live Mode (`AGENT_HUB_LIVE=1`)

An opt-in live execution mode is planned as a follow-up:

```bash
AGENT_HUB_LIVE=1 node bench/run.mjs
```

> [!WARNING]
> Live mode is an opt-in follow-up that spends **real API quota** across configured model providers and cloud runners. It is **NOT** part of the automated test suite.
>
> When `AGENT_HUB_LIVE=1` is set, `bench/run.mjs` safely guards execution by printing a notice that live mode is not yet implemented and exiting `0`, ensuring no real jobs are inadvertently dispatched.
