# Lessons that generalize

What we'd tell anyone building an automated version of this loop. Ordered roughly by
how much pain each one saved or caused.

## Reproduction

- **Code reading before probing.** The alert names a symptom; the repo names the
  trigger. Stack frames + `git log -S` + searching old PRs for the error message is
  cheaper and more reliable than trying to synthesize the original request.
- **Cheapest route to the same code path.** Don't reproduce through the alerting
  route if a simpler-to-authenticate route reaches the same function.
- **Always a control check.** Same payload, no edge condition. Red repro + green
  control is the whole argument in one screenshot.
- **Per-request, machine-readable output.** Print one JSON line per round (ids,
  statuses, bodies) and one verdict line. A run must be decomposable *after* the fact,
  because you'll discover it contained more than one failure mode.
- **Turn retries off** on repro checks (they're supposed to fail — retries just double
  the noise and the cost), and **clean up what you create**: these runs make real
  resources in a real account. Use a dedicated account and a throwaway key.

## Correlation identity

- **`traceparent` is the primary key.** If the target runs OpenTelemetry, your
  synthetic request's trace id lands on the error-tracker event. One filter recovers
  everything a run caused. Custom `x-*` headers are nice; the trace id is the join.
- **Logs are the weak link.** Our access logs carried no trace id and no headers —
  only method/path/query/status/account. Two workarounds: query-param tagging (the
  query string *is* logged — but strict input validation rejects unknown params on
  some routes, so probe per route), and joining on path resource ids + timestamps.
  The durable fix is a platform one: put the trace id in the request log.
- Error trackers may hide request headers in their API even when they're on the
  event — verify by trace id, not by reading headers back.

## Verdicts

- **A generic 500 is not a diagnosis.** One race, three distinct errors, identical
  bodies. The probe alone can say "something 500s"; only enrichment can say *what*.
- **Fingerprint drift is real.** The same root cause groups into different
  error-tracker issues depending on the route's error wrapping. Match on
  message + frame + your trace id, never on issue membership.
- **Verify by message, not by check color.** After the fix deployed, the target
  message was gone (zero events on the new release) but the check stayed red — the
  race had simply fallen through to the next unguarded line. A fix can be fully
  verified while the check that found it still fails.

## Fixing

- Mirror the nearest precedent fix exactly (shape of the guard, shape of the test).
- Prove the unit test red on the pre-fix code — actually run it against the old file
  and keep the output. "Red with the verbatim production error message" is the
  strongest sentence in the PR.
- The PR description is the incident record: check ids, run links, event table, log
  timeline, and an explicit list of what is *not* fixed. Reviewers get the whole loop
  without leaving the PR.
- "Who introduced it" has three answers: the fragile line's author (often years old),
  whoever changed its surroundings, and whoever changed the traffic so the latent bug
  started firing. Tag people as context, not as blame.

## Verification

- **A staging gate closes the loop fast.** Deploy the same check project to a staging
  account (env-var retargeting), confirm it's red pre-merge, watch
  merge → CD deploy → job success, re-run. Ours went merge-to-verified in ~15 minutes
  unattended.
- Leave the checks deployed afterwards. They are the regression monitor; wire an alert
  channel once they're green.

## Platform gaps we hit (design these away in your own stack)

- Synthetic requests didn't carry trace/check identity by default — the probe had to
  inject it. Make your monitoring product do this out of the box.
- Request logs without a trace/request id make log correlation heuristic.
- Generic error bodies (`{"statusCode":500}`) make probes blind; an error id echoed in
  the response body would let the probe classify failures itself.
