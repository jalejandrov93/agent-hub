import re

with open('docs/execution-contract.md', 'r') as f:
    content = f.read()

# 1. Deadline semantics
content = content.replace('(`src/timeouts.mjs:34`)', '(`src/timeouts.mjs` `resolveEffectiveTimeoutS`)')
content = content.replace('(`src/timeouts.mjs:58-66`,\n  `src/config.mjs:52`; defaults `src/config.mjs:87-109`)', '(`src/timeouts.mjs` adaptive logic,\n  `src/config.mjs`; defaults `src/config.mjs`)')
content = content.replace('(`src/jobrunner.mjs:182-186`,\n  `src/config.mjs:73`)', '(`src/jobrunner.mjs` `KILL_GRACE_S` usage,\n  `src/config.mjs`)')
content = content.replace('(`src/cloud/runner.mjs:81-97`)', '(`src/cloud/runner.mjs` `pollingStoppedReason`)')
content = content.replace('(`src/cloud/runner.mjs:564-579`)', '(`src/cloud/runner.mjs` `resumeRemoteJobs`)')
content = content.replace('(`src/cloud/poller.mjs:4-6`, `src/cloud/poller.mjs:30-38`)', '(`src/cloud/poller.mjs` `BACKOFF_FACTOR`)')

# 2. Cancellation
content = content.replace('(`src/jobrunner.mjs:306-317`,\n  `src/jobrunner.mjs:214-215`)', '(`src/jobrunner.mjs` `cancelJob` and `finishJob`)')
content = content.replace('(`src/jobstore.mjs:129-139`)', '(`src/jobstore.mjs` `updateResult`)')
content = content.replace('(`src/process.mjs:35-54`)', '(`src/process.mjs` `SIGTERM` ladder)')
content = content.replace('(`src/jobrunner.mjs:319-335`, `src/index.mjs:264`)', '(`src/cloud/poller.mjs` cancel check, `src/index.mjs` cancel documentation)')
content = content.replace('(`src/cloud/poller.mjs:170-186`)', '(`src/cloud/poller.mjs` quota protection)')

# 3. Retry / resume / fallback / escalation
content = content.replace('(`src/jobrunner.mjs:233`)', '(`src/jobrunner.mjs` `sessionId` logic)')
content = content.replace('(`src/router.mjs:169-221`)', '(`src/router.mjs` `primary + fallbacks`)')
content = content.replace('(`src/config.mjs:185-190`)', '(`src/config.mjs` `codex` tier)')
content = content.replace('(`src/preflight.mjs:79-83`,\n  `src/config.mjs:57-65`)', '(`src/preflight.mjs` circuit breaker usage,\n  `src/config.mjs` `CIRCUIT_BREAKER` limits)')
content = content.replace('(`src/cloud/runner.mjs:22-23`)', '(`src/cloud/runner.mjs` account retry limits)')

# 4. Idempotency
content = content.replace('(`src/jobstore.mjs:58-104`)', '(`src/jobstore.mjs` `createJob`)')
content = content.replace('(`src/cloud/runner.mjs:515-562`)', '(`src/cloud/runner.mjs` reconciliation)')
content = content.replace('(`src/jobstore.mjs:182-195`)', '(`src/jobstore.mjs` orphan check)')

# 5. Read purity / write ownership
content = content.replace('(`src/jobrunner.mjs:156`, `src/jobrunner.mjs:226-286`,\n  `src/readguard.mjs:51-107`)', '(`src/jobrunner.mjs` snapshot diff,\n  `src/readguard.mjs` `takeSnapshot`)')
content = content.replace('(`src/jobrunner.mjs:160-161`)', '(`src/sandbox.mjs` env filtering)')
content = content.replace('(`src/worktree.mjs:39-54`)', '(`src/worktree.mjs` `checkWriteAllowed`)')
content = content.replace('(`src/worktree.mjs:77-101`)', '(`src/worktree.mjs` `acquireWriteLock`)')
content = content.replace('(`src/fsutil.mjs:149-164`, `src/fsutil.mjs:171-178`)', '(`src/fsutil.mjs` `updateJsonLocked`)')
content = content.replace('(`src/jobrunner.mjs:63-92`)', '(`src/cloud/runner.mjs` `startRemoteJob` bypassing local lock)')

# 6. Local vs remote state
content = content.replace('(`src/jobstore.mjs:81-104`)', '(`src/jobstore.mjs` `createJob` defaults)')
content = content.replace('(`src/cloud/poller.mjs:111-145`,\n  `src/cloud/runner.mjs:444-466`)', '(`src/cloud/poller.mjs` and\n  `src/cloud/runner.mjs` blocks)')
content = content.replace('(`src/cloud/poller.mjs:226-233` -> `src/cloud/runner.mjs:88-97`)', '(`src/cloud/poller.mjs` terminal check -> `src/cloud/runner.mjs`)')

with open('docs/execution-contract.md', 'w') as f:
    f.write(content)
