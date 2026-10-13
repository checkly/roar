# Case study: from one Sentry event to a verified fix

A real walk of the loop, anonymized to the degree that it's about *our* API but the
mechanics transfer. Total wall-clock from picking up the event to a merged,
staging-verified fix: one afternoon, with ~15 minutes of that being the merge → deploy
→ re-verify tail, unattended.

## DETECT

A Sentry event:

- `TypeError: Cannot destructure property 'id' of 'undefined' as it is undefined.`
- on `PUT /.../checks/:id` (an update endpoint), release + pod + region attached
- in-app frames pointing at a model lifecycle hook (`afterUpdate`), which maps
  `({ id }) => id` over rows it re-queries itself
- the request body (12 KB) was **not** captured — so "replay the request" was not an
  option

A detail that mattered: the requesting user-agent was our own synthetic-monitoring
browser, and the account was our E2E test account. The error was being *caused* by our
own end-to-end suite editing a resource while its cleanup deleted it.

## CORRELATE

Reading the two in-app frames and running `git log -S` on the crashing expression
found a **sibling fix from weeks earlier**: the identical crash, one frame up in the
same stack, whose PR description already named the trigger — *a concurrent DELETE
racing the PUT makes the hook's find query come back holding a nullish entry*. That
fix had guarded only its own hook; the frame below it was still unguarded.

The alerting route required session auth. The same model hook, however, runs under the
public API (`PUT /v1/checks/:id`), which needs only an API key. Cheapest route wins.

## REPRODUCE

A Checkly project (see [`../template`](../template)) with three checks:

1. **Race** — 8 rounds of: create a throwaway resource, fire `PUT` and `DELETE`
   concurrently with 0–80 ms jitter, record per-request outcomes, clean up. Fails on
   any 5xx.
2. **Control** — identical create → PUT → DELETE, strictly serial. Must stay green.
3. **Log-tagged variant** — same race, with correlation ids additionally in query
   params so the backend access log (which records the query string but no headers)
   can be grepped per run.

First cloud run: **4 of 8 raced PUTs returned 500, control 200.** Reproduced.

## TRACE / ENRICH

Every request carried `traceparent` + custom headers. Results:

- **Error tracker (Sentry):** all four 500s appeared as events carrying *our* trace id
  with a `parent_span_id` — the backend's OTel joined the trace we started. Filter
  `trace:<id>`, done.
- **Fingerprint drift:** the events did *not* land in the original Sentry issue. The
  public API wraps errors before logging, so the identical root cause fingerprints
  into a different (catch-all) issue. "New events in the same issue" is the wrong
  success criterion; "same message + same in-app frame + our trace id" is the right one.
- **Two failure modes:** only 1 of the 4 was our TypeError. The other 3 were a
  Postgres `deadlock detected` on the `SELECT … FOR UPDATE` the update hook takes —
  a second bug, invisible in the identical 500 bodies.
- **Logs (Loki):** the access log had method/path/status/duration per request —
  but **no trace id, no headers**. Join was path-resource-id + account + timestamp.
  The log timestamps were good enough to reconstruct the interleaving: whichever side
  commits first wins, the loser 500s; PUT and DELETE always landed on different API
  pods (so the deadlock is in the database, not in-process).

## DIAGNOSE

"Who introduced it" turned out to need three answers, not one:

1. who wrote the fragile line → `git blame`: two years earlier, in unrelated work;
2. who changed its surroundings → a models refactor had reordered the sibling hook's
   guard (that's what the earlier sibling fix restored);
3. who changed the **traffic** so the latent race started firing → an E2E-suite change
   that moved resource cleanup from per-worker to per-test, a few days before the
   Sentry issue's `firstSeen`.

Reviewers = the sibling-fix author + the issue assignee. Context, not blame.

## ACT

A one-line guard (filter nullish rows before the destructure, mirroring the sibling
fix) plus a unit spec proven **red on main** (it fails with the verbatim Sentry
message) and green with the guard. The PR description carried the whole record: the
check ids and run links, the round ↔ Sentry-event table, the log timeline, and an
explicit "the deadlock is NOT fixed here".

## VERIFY

The same project was deployed to the **staging** account (env-var retargeting), where
it was red pre-merge. Main auto-deploys to staging; a watcher followed
merge → deploy-job success, then re-ran the checks:

- the target message: **zero events** on the new release, filtered by the new runs'
  trace ids — fix verified;
- the checks stayed **red anyway**: the same race now surfaced the *next* three
  unguarded dereferences further down the handler (plus the untouched deadlock).

That last point is the biggest single lesson: for race-class bugs, verify by error
message, not by check color — and prefer one structural guard at the top of the
handler over whack-a-mole at each dereference.
