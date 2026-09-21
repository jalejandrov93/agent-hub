# Jules (cloud)

## Cloud delegation (Jules)

Every other agent here is a local CLI: agent-hub spawns it, streams its stdout
and reaps it. [Jules](https://jules.google) is not. It is a REST API
(`v1alpha`, **alpha — shapes may change**) and the work runs on Google's
servers, against a GitHub repository you connected in the Jules web UI. The
result is a pull request, never a change to your `cwd`. That difference drives
every design decision below.

Jules is reachable only through its own tools (`jules_delegate`,
`jules_sources`, `jules_check`, `jules_sessions`, `jules_interact`,
`jules_wait`, `jules_supervise`). It is deliberately absent
from the delegation map, so `route` never picks it and `delegate` cannot reach
it — you get a cloud session only when you ask for one.

**It survives your machine being off.** This is the point of the feature: hand
over a task, close the laptop, come back later. Because the MCP server is a
per-session stdio process and the dashboard is a local service, both die with
the machine while the Jules session keeps going, so polling can never be the
only way to learn the outcome:

- While the server is up, a poll loop streams Jules' activity into the job's
  `stdout.log`, so `job_result` and the dashboard show progress live. Activities
  are deduplicated by identity, not by page token, and the interval backs off to
  60s when nothing moves.
- On startup the server resumes polling any job still marked `running`. If its
  deadline elapsed while nothing was watching, it does one final read before
  deciding — a session that finished overnight lands as `succeeded` with its
  pull-request link, not as a timeout.
- Whenever you want, `jules_check` answers "did it finish, and on which branch"
  with a single live read and no poll loop at all. If the session ended while
  the machine was off, it finalizes the local job so `job_result` returns the
  real answer. `jules_sessions` lists what Jules has even when this machine has
  no record of it, so a reinstall or a session started elsewhere is still
  recoverable.

**Cancel is local only.** The Jules API exposes no cancel endpoint — and no
`pause`/`resume` endpoints either. `job_cancel`
marks the job canceled and stops this server's polling; the session keeps
running on Google's side. The tool says so.

**Waiting is a state, not a stall.** A Jules session can sit in
`AWAITING_PLAN_APPROVAL`, `AWAITING_USER_FEEDBACK` or `PAUSED` indefinitely,
and the hub no longer polls those blindly: the poll interval is semantic per
state (`QUEUED`/`PLANNING` 5s, `IN_PROGRESS` 5–15s backoff, `AWAITING_*`
30–60s, `PAUSED` 5min), a waiting tick skips re-draining `listActivities`,
and the job record carries `pollingStoppedReason: 'awaiting_interaction'`
until new activity resumes it. `jules_check` now also answers
`attentionRequired` / `attentionReason` (`user_feedback` | `plan_approval` |
`paused`) / `recommendedAction` (`send_message` | `approve_plan`) /
`canAutoResolve` / `attempts`, and `jules_interact` (`reply` |
`approve_plan`) is the interaction API — `pause`/`resume`/`cancel` remotes
are explicitly rejected because the backend does not offer them. See
`src/cloud/poller.mjs` (`STATE_INTERVALS`, `intervalForState`),
`src/cloud/jules/adapter.mjs` (`ALL_JULES_STATES`, `isWaitingState`) and
`src/cloud/check.mjs` (`computeAttention`).

**Model A: interacting never restarts polling.** After `jules_interact`
(or `job_reply` on a Jules parent) nothing observes the session again on its
own — the local record freezes at `running` until *you* observe it. So the
three observation tools have distinct jobs, and mixing them up loses
completions:

- `job_wait` — waits on the **local record**: returns on terminal, or
  immediately on `done`+`waiting` with attention fields. It does *not* poll
  Jules itself, so after an interaction it will *not* see the session finish.
- `jules_wait` — **actively observes** one session for a bounded local budget
  (`timeoutS≤600`); never a watch daemon.
- `jules_check` — one **punctual inspection** plus reconciliation (finalizes
  the local job if the session already ended).

Post-interaction rule: `jules_interact` → observe with `jules_wait` (or
`jules_check`), never `job_wait` alone. Continuous supervision belongs to
`jules_supervise` (B4), which owns observation through a
`remote.watch = {owner, generation}` lease so two watchers never drive the
same session: it loops observe → decide → interact → resume-observation,
auto-replies only through 6 hard gates with `maxAutoReplies=2` counted on
`autoReplyCount` (never `turnDepth`), and escalates anything else as
`REQUEST_USER`. `PAUSED` is never approved/replied.

**Several accounts.** Quotas are per Jules account, so agent-hub can hold more
than one. Add them in the dashboard; they live in `accounts.json` under
`AGENT_HUB_HOME`, written with mode `0600`, and no API response ever returns a
raw key. A policy (`round_robin`, `least_used` or `priority`) picks the account
for each new session, a `429` fails over to the next eligible account, and a job
keeps the account that started it for its whole life. Account health is judged
by `GET /sessions`, never `GET /sources`: a valid key can be refused `/sources`
with a 401 while working normally. With no accounts configured, `JULES_API_KEY`
is used as before. All key resolution lives in `src/cloud/credentials.mjs`.

**Recurring tasks.** The Jules API has no scheduling, so agent-hub owns it.
Schedules run inside the dashboard service, the only long-lived process here,
and fire at most one run at a time per schedule. With the machine off, no
schedule fires; sessions already started keep running on Google's side.

**The key never leaves this process.** `JULES_API_KEY` travels only in the
`X-Goog-Api-Key` header. It is never written to a job record, an event, a log
line or a response, and it is stripped from the environment handed to the local
agent CLIs, which are third-party programs agent-hub does not control.

**Sources are read-only.** Repositories are connected to Jules through its
GitHub App in the web UI. The API can list them (`jules_sources`) but cannot add
one. `jules_delegate` accepts an explicit `source`, or infers it from `cwd` via
the `origin` remote.

