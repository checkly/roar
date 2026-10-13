# ROAR — Reliability Orchestration, Automation & Response

An operating loop for acting on production alerts (Sentry, logs, metrics) by turning
them into **synthetic reproductions**: a monitoring check that fails while the bug
exists, carries its own correlation identity into your telemetry, and becomes the
verification gate for the fix.

We (Checkly) ran this loop manually end to end on a real production error — from a
Sentry event to a merged fix verified on staging in the same afternoon — and wrote
down everything that worked, everything that didn't, and the code. This repo is the
shareable version.

```
DETECT      an alert fires (Sentry issue, log alert, metric anomaly)
   ↓
CORRELATE   map it to code + to the cheapest route that reaches the same code
   ↓
REPRODUCE   a synthetic check that triggers it on demand (fails = reproduced)
   ↓
TRACE       follow the check's own trace/correlation ids into APM + logs
   ↓
DIAGNOSE    root cause, history (who/when/what changed), people with context
   ↓
ACT         fix PR whose description *is* the incident record
   ↓
VERIFY      the same check, against the environment the fix deployed to
```

## The core ideas

**1. The reproduction is a check, and it fails while the bug exists.**
One artifact serves three phases: it proves the repro (REPRODUCE), it gates the fix
(VERIFY — it goes green when the fix deploys), and it stays as the regression monitor
afterwards. Always deploy a serial **control** check alongside it: same payload, no
race/edge condition, must stay green — that's your proof the failure is the condition,
not the payload or the account.

**2. Every request the check sends carries identity.**
W3C `traceparent` is the join that actually works: if the target service runs OTel,
its error tracker records your trace id on the resulting event, and
`trace:<id>` finds everything one check run caused. Add your own headers on top
(stable per-issue id, per-run id, per-request id, step label) and, where the target
tolerates them, query params — many access logs echo the query string but not headers.
See [`template/__checks__/repro-context.ts`](template/__checks__/repro-context.ts).

**3. Never claim "reproduced" from a generic 500.**
Our single race produced **three distinct failures** behind identical
`{"statusCode":500}` bodies. Only the enrichment step (error tracker + logs, filtered
by your ids) can tell them apart — and the verdict after a fix must be *per error
message*, not "did the check go green" (it can stay red on the next failure mode of
the same race, which is exactly what happened to us).

**4. Code reading before probing.**
The alert alone rarely tells you how to reproduce. Reading the in-app stack frames and
the git history of those files found a sibling fix whose PR description named the
trigger ("a concurrent DELETE racing the PUT") — turning "replay a 12 KB payload we
don't have" into a 10-line race loop. Also: reproduce on the **cheapest route that
reaches the same code** (for us: the public API with an API key, instead of the
session-authenticated internal route the alert came from).

## What's in here

| path | what |
| --- | --- |
| [`docs/CASE-STUDY.md`](docs/CASE-STUDY.md) | the worked example: a race-condition TypeError, from Sentry event to verified fix |
| [`docs/LESSONS.md`](docs/LESSONS.md) | everything that generalizes — including the failures and gotchas |
| [`template/`](template/) | a deployable Checkly CLI project implementing the pattern (race + control checks, correlation identity, machine-readable output) |

## Quickstart (Checkly)

```sh
cd template
npm install
# store the probe's credentials as account env vars (never in code)
npx checkly env add REPRO_API_KEY <key> --secret
npx checkly env add REPRO_TARGET_API https://api.yourservice.example
npx checkly test --record     # ad-hoc cloud run; read the REPRO_RESULT output line
npx checkly deploy            # becomes a standing monitor + the verify gate
```

The same project deploys to any environment/account purely via env vars
(`CHECKLY_API_KEY` / `CHECKLY_ACCOUNT_ID`), which is what makes a **staging gate**
cheap: if your main branch auto-deploys to staging, the repro check deployed there is
red before the fix merges and green after — the loop closes without waiting for a
production release.

The pattern is tool-agnostic: the checks happen to be Checkly `MultiStepCheck`s
(Playwright under the hood), the enrichment happened to be Sentry + Grafana Loki —
substitute your own synthetic monitoring and telemetry and the loop is unchanged.

## License

MIT
