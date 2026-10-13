import { expect, test } from '@playwright/test'
import { API_KEY, API_ROOT, createResource, deleteResource, logContext, updateResource } from './repro-context'

// Control for the race check: same create → UPDATE → DELETE, strictly serial.
// Must be green; a failure here means the operation itself (not the race) is broken.
test('serial create → UPDATE → DELETE stays 2xx', async ({ request }) => {
  test.skip(!API_KEY || !API_ROOT, 'missing REPRO_API_KEY / REPRO_TARGET_API')
  logContext()

  const { id, body } = await createResource(request, `roar repro control ${Date.now()}`)
  try {
    const putBody = { ...body, name: `${body.name} (edited)` }
    for (const k of ['id', 'created_at', 'updated_at']) delete putBody[k]
    const put = await updateResource(request, id, putBody, 'put-control')
    console.log(`ROAR_REPRO_RESULT ${JSON.stringify({ verdict: put.status === 200 ? 'CONTROL_OK' : 'CONTROL_FAILED', put })}`)
    expect(put.status, put.body).toBe(200)
  } finally {
    const del = await deleteResource(request, id)
    expect([204, 404]).toContain(del.status)
  }
})
