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

```sh
npm install -g checkly        # or use npx checkly everywhere
npx checkly login             # browser OAuth; or set CHECKLY_API_KEY + CHECKLY_ACCOUNT_ID
npx checkly whoami            # confirm the account you're about to deploy into
```

Recommended: a **dedicated account** (or at least a dedicated check group + throwaway
API key) for reproductions — the checks create and delete real resources on every run.

Copy [`../template`](../template), adapt the three `*Resource` functions in
`__checks__/repro-context.ts` to the API you're probing, then:

```sh
cd template && npm install
npx checkly env add REPRO_API_KEY <key-for-the-target-api> --secret
npx checkly env add REPRO_TARGET_API https://api.yourservice.example
npx checkly env add REPRO_ISSUE_ID <error-tracker issue id>
npx checkly test --record     # one ad-hoc cloud run; read the ROAR_REPRO_RESULT line
npx checkly deploy            # standing monitor + the verify gate
```

To target a second environment (your staging gate), nothing in the project changes —
only env vars: `CHECKLY_API_KEY=… CHECKLY_ACCOUNT_ID=… npx checkly deploy`.

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
