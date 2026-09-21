# Testing and reliability

## Benchmarks and chaos testing

Agent-hub includes automated benchmark suites and fault-injection chaos tests
to guarantee correctness, determinism, and crash recovery:

**Benchmark runner (`bench/run.mjs`, `npm run bench`)**:
Executes reproducible workflow scenarios defined in `bench/corpus.mjs`:
- `happy-path`: sequential workflow (`plan` -> `execute`), verifying artifact
  production, command verification pass, and judge acceptance.
- `retry-transient`: transient dispatch failure retrying within `maxAttempts: 2`
  with exponential backoff.
- `revision-verification`: failing verification triggering bounded judge revision
  (`maxRevisionAttempts: 2`) with feedback injection until passing.
- `fanout-child-failure`: failing child node in a parallel fanout step, verifying
  failure propagation to parent and workflow without hanging.

Asserts that all dispatches are deterministic and records zero duplicate dispatches.

**Chaos and crash recovery (`test/chaos/`)**:
- `test/chaos/chaos.test.mjs`: validates duplicate dispatch deduplication via
  `dispatchKey` CAS (exactly one job created for concurrent identical dispatches),
  expired claim re-adoption, live claim protection (live owner claims cannot be
  stolen), and cross-process SQLite write contention with zero lost updates.
- `test/chaos/crash.test.mjs`: simulates mid-wave process death (killing scheduler
  and worker processes), verifying that on workflow resumption, expired claims
  are re-adopted and completed nodes are never re-dispatched.

## Testing

```bash
npm test                                                      # server, node --test; fast, hermetic, no real CLI calls
npm run bench                                                 # workflow benchmark runner across corpus scenarios
npm run test:live                                             # AGENT_HUB_LIVE=1; real CLI pings across adapters (uses real quota)
npm run -w dashboard test                                     # dashboard, Vitest + Testing Library
npm run -w dashboard typecheck                                # dashboard, tsc --noEmit
node --test test/chaos/chaos.test.mjs test/chaos/crash.test.mjs # chaos concurrency and crash recovery suite
```

See `test/fixtures/README.md` for exactly which adapter fixtures are real CLI
output versus hand-built synthetic shapes, and why.

