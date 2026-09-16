git checkout src/dashboard.mjs src/schemas.mjs test/dashboard.test.mjs
git add src/dashboard.mjs src/schemas.mjs test/dashboard.test.mjs
git commit -m "feat(dashboard): add Jules cloud provider backend API" -m "Adds REST routes to manage accounts, merged sources, schedules, and cloud sessions. The /api/sources route manually merges data from readSourcesCache with GitHub branches. Job activities use plain text lines from stdout.log. Corresponding types added to schemas.mjs, and all test coverage implemented with dependencies injected."
