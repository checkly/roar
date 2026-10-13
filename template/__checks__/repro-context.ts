import { randomBytes, randomUUID } from 'node:crypto'
import type { APIRequestContext, APIResponse } from '@playwright/test'

// Identity that every request in a repro carries, so the enrich phase can find exactly
// these requests in your error tracker, traces and logs:
//
//   traceparent / baggage        W3C trace context. If the target runs OpenTelemetry,
//                                the error tracker records YOUR trace id on the event —
//                                this is the join that actually works.
//   x-roar-repro                 stable id of the issue being reproduced
//   x-roar-run                   one id per check run (CHECK_RESULT_ID when on Checkly)
//   x-roar-request               one id per HTTP request
//   x-roar-step                  what this request is (put-r3 / delete-r3 / control / cleanup)
//   User-Agent                   human-greppable summary of all of the above
//
// Query params (reproQuery) duplicate the ids for log stores that record the query
// string but not headers. Caveat: strict input validation rejects unknown query keys
// on some routes — probe each route once and tag only where tolerated.
export const REPRO_ID = process.env.REPRO_ISSUE_ID || 'roar-repro'

export const API_ROOT = (process.env.REPRO_TARGET_API || '').replace(/\/$/, '')
export const API_KEY = process.env.REPRO_API_KEY || ''

export const CHECK_ID = process.env.CHECKLY_CHECK_ID || 'local'
export const CHECK_RESULT_ID = process.env.CHECK_RESULT_ID || ''
export const LOCATION = process.env.CHECKLY_REGION || 'local'
export const RUN_ID = CHECK_RESULT_ID || randomUUID()
export const TRACE_ID = randomBytes(16).toString('hex')

export function reproHeaders(step: string): Record<string, string> {
  const requestId = randomUUID()
  const spanId = randomBytes(8).toString('hex')
  return {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    'User-Agent': `roar-repro/1 (${REPRO_ID}; run=${RUN_ID}; step=${step})`,
    'x-roar-repro': REPRO_ID,
    'x-roar-run': RUN_ID,
    'x-roar-request': requestId,
    'x-roar-step': step,
    traceparent: `00-${TRACE_ID}-${spanId}-01`,
    baggage: `roar.repro=${REPRO_ID},roar.run=${RUN_ID}`,
  }
}

export function reproQuery(step: string, requestId: string): Record<string, string> {
  return { roar_repro: REPRO_ID, roar_run: RUN_ID, roar_request: requestId, roar_step: step }
}

export function logContext(): void {
  // One machine-readable line per run; the enrich phase starts from this.
  console.log(
    `ROAR_REPRO_CONTEXT ${JSON.stringify({
      repro: REPRO_ID,
      run: RUN_ID,
      traceId: TRACE_ID,
      checkId: CHECK_ID,
      location: LOCATION,
      apiRoot: API_ROOT,
      startedAt: new Date().toISOString(),
    })}`,
  )
}

export interface Outcome {
  step: string
  requestId: string
  status: number
  body: string
  ms: number
}

export async function timed(
  step: string,
  headers: Record<string, string>,
  fn: () => Promise<APIResponse>,
): Promise<Outcome> {
  const started = Date.now()
  const res = await fn()
  const body = (await res.text()).slice(0, 500)
  return { step, requestId: headers['x-roar-request'], status: res.status(), body, ms: Date.now() - started }
}

// ---------------------------------------------------------------------------
// Adapt these three functions to your API. The example shape is a plain REST
// resource with POST /resources, PUT /resources/:id, DELETE /resources/:id.
// ---------------------------------------------------------------------------

export function resourceBody(name: string): Record<string, unknown> {
  return { name, activated: false, tags: ['roar', 'repro', 'ephemeral'] }
}

export async function createResource(
  request: APIRequestContext,
  name: string,
): Promise<{ id: string; body: Record<string, unknown> }> {
  const headers = reproHeaders('create')
  const res = await request.post(`${API_ROOT}/resources`, { headers, data: resourceBody(name) })
  const text = await res.text()
  if (res.status() !== 201) throw new Error(`create failed: ${res.status()} ${text.slice(0, 300)}`)
  const created = JSON.parse(text) as Record<string, unknown>
  return { id: created.id as string, body: created }
}

export async function updateResource(
  request: APIRequestContext,
  id: string,
  body: Record<string, unknown>,
  step: string,
): Promise<Outcome> {
  const headers = reproHeaders(step)
  return timed(step, headers, () => request.put(`${API_ROOT}/resources/${id}`, { headers, data: body }))
}

export async function deleteResource(request: APIRequestContext, id: string, step = 'cleanup'): Promise<Outcome> {
  const headers = reproHeaders(step)
  return timed(step, headers, () =>
    request.delete(`${API_ROOT}/resources/${id}`, { headers, params: reproQuery(step, headers['x-roar-request']) }),
  )
}
