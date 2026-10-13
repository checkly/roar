import { expect, test } from '@playwright/test'
import {
  API_KEY,
  API_ROOT,
  createResource,
  deleteResource,
  logContext,
  updateResource,
  type Outcome,
} from './repro-context'

// The race-class repro shape: N rounds of create → (UPDATE ∥ DELETE) with varied
// jitter so the interleaving changes between rounds. Fails on any UPDATE 5xx.
// Prints one ROAR_REPRO_ROUND line per round and one ROAR_REPRO_RESULT verdict line —
// a run must be decomposable afterwards, because a single race can hide several
// distinct failure modes behind identical 500 bodies.
const ROUNDS = 8
const JITTERS_MS = [0, 0, 5, 5, 10, 20, 40, 80]

test('UPDATE vs DELETE race — no update may 500', async ({ request }) => {
  test.skip(!API_KEY || !API_ROOT, 'missing REPRO_API_KEY / REPRO_TARGET_API')
  logContext()

  const outcomes: Array<{ round: number; jitterMs: number; resourceId: string; put: Outcome; del: Outcome }> = []
  const created: string[] = []
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const jitterMs = JITTERS_MS[round % JITTERS_MS.length]
      const { id, body } = await createResource(request, `roar repro race r${round} ${Date.now()}`)
      created.push(id)

      const putBody = { ...body, name: `${body.name} (edited)` }
      for (const k of ['id', 'created_at', 'updated_at']) delete putBody[k]

      const putP = updateResource(request, id, putBody, `put-r${round}`)
      const delP = (async () => {
        if (jitterMs) await new Promise((r) => setTimeout(r, jitterMs))
        return deleteResource(request, id, `delete-r${round}`)
      })()
      const [put, del] = await Promise.all([putP, delP])
      outcomes.push({ round, jitterMs, resourceId: id, put, del })
      console.log(`ROAR_REPRO_ROUND ${JSON.stringify({ round, jitterMs, resourceId: id, put, del })}`)
    }
  } finally {
    // Best-effort cleanup of anything the race left behind — these are real resources.
    for (const id of created) {
      const res = await deleteResource(request, id)
      if (![204, 404].includes(res.status)) console.log(`cleanup ${id}: ${res.status} ${res.body}`)
    }
  }

  const fiveHundreds = outcomes.filter((o) => o.put.status >= 500)
  console.log(
    `ROAR_REPRO_RESULT ${JSON.stringify({
      verdict: fiveHundreds.length ? 'REPRODUCED' : 'NOT_REPRODUCED',
      rounds: outcomes.length,
      put500s: fiveHundreds.map((o) => ({ round: o.round, requestId: o.put.requestId, status: o.put.status, body: o.put.body })),
      putStatuses: outcomes.map((o) => o.put.status),
      deleteStatuses: outcomes.map((o) => o.del.status),
    })}`,
  )
  expect(
    fiveHundreds,
    `UPDATE returned 5xx in rounds ${fiveHundreds.map((o) => o.round).join(',')} — look up the x-roar-request ids / trace ids in your error tracker`,
  ).toHaveLength(0)
})
