1. **Update `docs/execution-contract.md`**
   - **Deadline semantics:** Update `src/timeouts.mjs:34` and `src/timeouts.mjs:58-66` to `src/timeouts.mjs:25` (`resolveEffectiveTimeoutS`) and `src/timeouts.mjs:63` respectively.
   - **Local kill:** Change `src/jobrunner.mjs:182-186` to `src/jobrunner.mjs:333`, and `src/config.mjs:73` to `src/config.mjs:98`.
   - **Local-deadline ≠ remote-failure:** Change `src/cloud/runner.mjs:81-97` to `src/cloud/runner.mjs:51`.
   - **Resume after deadline:** Change `src/cloud/runner.mjs:564-579` to `src/cloud/runner.mjs:537` (`resumeRemoteJobs`).
   - **Per-attempt backoff:** Change `src/cloud/poller.mjs:4-6` and `src/cloud/poller.mjs:30-38` to `src/cloud/poller.mjs:7`.
   - **Cancellation:** Update `cancelJob` reference `src/jobrunner.mjs:306-317` to `src/jobrunner.mjs:553`, and `finishJob` from `src/jobrunner.mjs:214-215` to `src/jobrunner.mjs:412`. Change `updateResult` from `src/jobstore.mjs:129-139` to `src/jobstore.mjs:338`. Update `SIGTERM->SIGKILL` from `src/process.mjs:35-54` to `src/process.mjs:48-94`. Update `MAY keep running` refs: `src/jobrunner.mjs:319-335` to `src/cloud/poller.mjs:239-251`, and `src/index.mjs:264` to `src/index.mjs:560`.
   - **Retry/resume/fallback/escalation:** Update `resume` `sessionId` ref from `src/jobrunner.mjs:233` to `src/jobrunner.mjs:473`. Update `fallback` ref `src/router.mjs:169-221` to `src/router.mjs:260`. Update `codex` ref `src/config.mjs:185-190` to `src/config.mjs:233`. Update `circuit breaker` ref `src/preflight.mjs:79-83` and `src/config.mjs:57-65` to `src/config.mjs:67-82`.
   - **Idempotency:** Update `createJob` ref `src/jobstore.mjs:58-104` to `src/jobstore.mjs:58`. Update orphan check `src/jobstore.mjs:182-195` to `src/jobstore.mjs:501-510`.
   - **Read purity/write ownership:** Update `takeSnapshotFn` from `src/jobrunner.mjs:156` and `src/jobrunner.mjs:226-286` to `src/jobrunner.mjs:287` and `src/jobrunner.mjs:450`. Update `takeSnapshot` from `src/readguard.mjs:51-107` to `src/readguard.mjs:52`. Update secrets redacting from `src/jobrunner.mjs:160-161` to `src/sandbox.mjs`.
   - **C0-real gate:** Update section to reflect that `better-sqlite3` ships, `initDb()` runs at startup (`src/index.mjs`), and describe the `AGENT_HUB_STORE` json|shadow|sqlite modes from `src/jobstore.mjs`.
   - **delegate() vs dispatch():** Add explicit notes comparing the two in the execution contract. Note that routing them together is an open item.

2. **Ensure README.md Consistency**
   - Check if `README.md` describes `delegate()` vs `dispatch()` and update it to maintain consistency with `docs/execution-contract.md`.

3. **Verify**
   - Complete pre commit steps to ensure proper testing, verifications, reviews and reflections are done. Run `npm run test` and `node --test test/timeouts.test.mjs test/cloud.test.mjs test/router.test.mjs`.
