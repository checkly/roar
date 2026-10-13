# Getting started

How to set this up from zero. This is the exact tool stack we used — an AI coding
agent (Claude Code, but any MCP-capable agent works) plus three integrations:

| role in the loop | tool we used | swap in your own |
| --- | --- | --- |
| DETECT / TRACE / VERIFY (error tracker) | **Sentry MCP** | any error tracker with an API |
| TRACE (logs) | **Grafana Cloud / Loki** HTTP API | Mezmo, CloudWatch, Datadog… |
| REPRODUCE / VERIFY (synthetic checks) | **Checkly CLI** | — |

The agent does the reading, correlation and writing; the three integrations are what
it reads from and acts through. You can also run every step by hand — nothing here
requires an agent.

## 1. Checkly CLI

Checkly checks are defined **as code** ("constructs") and managed with the CLI — no UI
clicking. A project is a directory with a `checkly.config.ts` plus TypeScript files
that instantiate constructs (`CheckGroupV2`, `MultiStepCheck`, …). The two commands
that matter:

- `checkly test` — bundles the project and runs the checks **once, ad hoc, in
  Checkly's cloud** (not locally), without deploying anything.
- `checkly deploy` — creates/updates the checks in the account as standing monitors.

Setup:

```sh
npm install -g checkly        # or use npx checkly everywhere
npx checkly login             # browser OAuth; or set CHECKLY_API_KEY + CHECKLY_ACCOUNT_ID
npx checkly whoami            # confirm the account you're about to deploy into
```

Recommended: a **dedicated account** (or at least a dedicated check group + throwaway
API key) for reproductions — the checks create and delete real resources on every run.

### How identity and parameters flow

Three different kinds of "ids/parameters" are in play — easy to mix up:

1. **Logical IDs** (in code): every construct gets one
   (`new MultiStepCheck('roar-repro-race', {...})`, `logicalId: 'roar-repro-ISSUE-123'`
   in the config). They are the stable keys the CLI uses to match code to account
   state — re-deploying with the same logical IDs **updates the same checks in place**;
   changing one creates a new check. This is what makes the project idempotent and
   safe to re-deploy from CI.
2. **Account environment variables** (your secrets/config): set once with the CLI,
   available as `process.env.*` inside every check run:
   ```sh
   npx checkly env add REPRO_API_KEY <key-for-the-target-api> --secret
   npx checkly env add REPRO_TARGET_API https://api.yourservice.example
   npx checkly env add REPRO_ISSUE_ID <error-tracker issue id>
   npx checkly env ls      # verify (secrets print empty)
   ```
   Never put credentials in the check code — it's committed and visible in the UI.
3. **Runtime-provided variables** (Checkly sets these per run): `CHECKLY_CHECK_ID`,
   `CHECK_RESULT_ID` (unique per run — we use it as the run id in every header),
   `CHECKLY_REGION`. `repro-context.ts` reads all three and falls back to `local` /
   a random UUID so the same specs also run under plain `npx playwright test`.

Check-level parameters worth setting deliberately (see
[`repro.check.ts`](../template/__checks__/repro.check.ts)):

- `retryStrategy: RetryStrategyBuilder.noRetries()` on the **group and every check** —
  repro checks are *supposed* to fail; the default double-check re-runs every failure
  and doubles your noise and cost.
- `frequency: Frequency.EVERY_1H`, `locations: ['eu-west-1']` — run hourly from the
  same region as the original incident.
- `activated: true, muted: true` while you iterate (runs, but never alerts); flip
  `muted: false` once you want it to page. `tags` carry the issue id so the UI maps
  back to the error tracker.

### Running and reading results

```sh
cd template && npm install
npx checkly test --record --verbose
```

What you get back, and where we read each piece:

- **stdout**: a live `✔/✖` line per check, plus everything your spec `console.log`s —
  this is why the template prints `ROAR_REPRO_CONTEXT` / `ROAR_REPRO_ROUND` /
  `ROAR_REPRO_RESULT` as single-line JSON. An agent (or a script) parses the verdict
  and the per-request ids straight out of the CLI output:
  `ROAR_REPRO_RESULT {"verdict":"REPRODUCED","put500s":[{"round":0,"requestId":"…"}…]}`.
- **exit code**: non-zero if any check failed — usable directly as a CI gate
  (`checkly test` in a PR workflow is exactly that).
- **`--record`**: persists the run as a *test session* and prints web links — a
  per-check "View result" link (full Playwright trace, every request/response) and a
  session summary link. Put these links in the PR.

`checkly test` is how we proved REPRODUCED (red race + green control) **before**
deploying anything.

### Deploying and verifying the deploy

```sh
npx checkly deploy            # idempotent; add --force to skip the confirmation prompt
```

This creates the group + checks as standing monitors that run on their schedule.
Scheduled-run results arrive in the dashboard and via your alert channels; for
scripted verification we read the public API directly:

```sh
curl -s -H "Authorization: Bearer $CHECKLY_API_KEY" \
     -H "x-checkly-account: $CHECKLY_ACCOUNT_ID" \
     https://api.checklyhq.com/v1/checks | \
  jq '.[] | select(.tags | index("roar")) | {id, name, activated, muted, retryStrategy}'
```

(That's also how we confirmed `retryStrategy` / `doubleCheck` actually landed as
intended — trust but verify.)

To target a second environment (your staging gate), nothing in the project changes —
only env vars for the CLI itself:

```sh
CHECKLY_API_KEY=<staging key> CHECKLY_ACCOUNT_ID=<staging account> npx checkly env add REPRO_TARGET_API https://api-staging.yourservice.example
CHECKLY_API_KEY=<staging key> CHECKLY_ACCOUNT_ID=<staging account> npx checkly test --record
CHECKLY_API_KEY=<staging key> CHECKLY_ACCOUNT_ID=<staging account> npx checkly deploy
```

Same code, same logical IDs, different account: you now have the identical repro
running pre-merge-red / post-merge-green against staging.

### Gotchas we hit

- Don't set `playwrightConfigPath` in `checkly.config.ts` for a MultiStepCheck-only
  project — it additionally creates an implicit Playwright-suite check that runs all
  your specs a second time.
- `checkly test` runs **in the cloud**: the target API must be reachable from public
  internet (or use a Checkly private location).
- Secret env vars print empty in `env ls` — that's expected, not a failed write.

## 2. Sentry MCP (error tracker access for the agent)

Sentry hosts an official MCP server. In Claude Code:

```sh
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp
# then run /mcp inside the session and complete the browser OAuth
```

The tools you'll actually use in the loop:

- `get_sentry_resource(resourceType='event', resourceId=<event id>)` — event → issue,
  stack frames, trace id
- `search_events(dataset='errors', query='trace:<your trace id>')` — **the** verify
  query: everything one check run caused
- `search_issue_events(issueId=…, query='timestamp:>…')` — events in a window
- `get_issue_details(eventId=…)` — per-event message / URL / trace ids

Two caveats we hit: the MCP does not expose request *headers* on events (join by trace
id instead), and identical root causes can fingerprint into different issues depending
on the route's error wrapping — match on message + in-app frame + your trace id, never
on issue membership.

## 3. Logs (we used Grafana Cloud / Loki over plain HTTP)

Any log store with an HTTP query API works; there is also an official Grafana MCP if
you prefer. We used a service-account token and the Loki `query_range` endpoint
directly:

```sh
START=$(date -v-15M +%s)000000000; END=$(date +%s)000000000
curl -s -G -H "Authorization: Bearer $GRAFANA_TOKEN" \
  "https://<your-stack>.grafana.net/api/datasources/proxy/uid/grafanacloud-logs/loki/api/v1/query_range" \
  --data-urlencode 'query={app="your-api", env="prod"} |= "roar_run"' \
  -d limit=100 -d "start=$START" -d "end=$END"
```

Check what your request logs actually contain **before** you need them: ours had
method/path/query-string/status/duration but **no trace id and no headers**. That's
why the template duplicates the correlation ids into query params (`roar_run=…`) on
the routes that tolerate unknown params (strict input validation rejects them on
others — probe per route), and why the fallback join is path resource id + account +
timestamp.

## 4. Run the loop once, by hand

1. Pick one real error-tracker issue with a request path in it.
2. Read the in-app frames + their git history before designing the probe (the trigger
   is often already written down in an old PR).
3. Adapt the template, run `checkly test --record`, and require: **repro check red,
   control check green**.
4. Take the `traceId` from the `ROAR_REPRO_CONTEXT` output line and query your error
   tracker for `trace:<id>`. Only call it reproduced when the message + frame match
   the original issue.
5. Fix it; put the check ids, run links and event table in the PR description; deploy
   the same project to staging as the gate; re-run after the fix deploys and verify
   **by error message**, not by check color.

The full phase-by-phase procedure, including the diagnosis and PR conventions, is in
[`CASE-STUDY.md`](CASE-STUDY.md) and [`LESSONS.md`](LESSONS.md).

## 5. Automate it

Once the manual loop works, the automation is mostly prompt engineering: we condensed
the procedure into a reusable agent skill (a markdown playbook the agent loads when an
alert comes in) that encodes phases, tool calls, and the guardrails from
`LESSONS.md` — deploy repro checks with retries off, always ship a control, never
claim "reproduced" without the trace-id match, verify per message. Start there before
building anything heavier; the expensive part is the judgment in CORRELATE and
DIAGNOSE, and a well-briefed agent with these three integrations covers it.
