import { defineConfig } from 'checkly'

// One ROAR project per incident/issue. Name it after the alert it reproduces so the
// monitoring UI maps straight back to the error tracker.
export default defineConfig({
  projectName: 'ROAR repro — <issue id> <short title>',
  logicalId: 'roar-repro-ISSUE-123', // <- your issue id
  checks: {
    activated: true,
    muted: false,
    frequency: 60,
    locations: ['eu-west-1'], // same region as the original event
    tags: ['roar', 'repro', '<issue-id>'],
    checkMatch: '**/__checks__/**/*.check.ts',
    // NOTE: do not set playwrightConfigPath here — it would additionally create an
    // implicit Playwright-suite check next to the MultiStepChecks below.
  },
  cli: {
    runLocation: 'eu-west-1',
    reporters: ['list'],
  },
})
