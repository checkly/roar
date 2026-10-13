import { CheckGroupV2, Frequency, MultiStepCheck, RetryStrategyBuilder } from 'checkly/constructs'

// The group carries the incident identity; the checks inside are the three roles of
// the pattern: repro (fails while the bug exists), control (must stay green), and a
// log-tagged variant for log stores that record the query string but not headers.
export const reproGroup = new CheckGroupV2('roar-repro-group', {
  name: '[ROAR repro] <issue id> — <error message>',
  tags: ['roar', 'repro', '<issue-id>'],
  locations: ['eu-west-1'],
  activated: true,
  muted: false,
  // These checks are SUPPOSED to fail while the bug exists; a retry doubles the noise.
  retryStrategy: RetryStrategyBuilder.noRetries(),
})

new MultiStepCheck('roar-repro-race', {
  name: 'PUT racing DELETE — expect no 500 (fails = REPRODUCED)',
  group: reproGroup,
  frequency: Frequency.EVERY_1H,
  locations: ['eu-west-1'],
  code: { entrypoint: './race.spec.ts' },
  playwrightConfig: { timeout: 120_000 },
  retryStrategy: RetryStrategyBuilder.noRetries(),
})

new MultiStepCheck('roar-repro-control', {
  name: 'CONTROL: identical flow, serial — must be green',
  group: reproGroup,
  frequency: Frequency.EVERY_1H,
  locations: ['eu-west-1'],
  code: { entrypoint: './control.spec.ts' },
  playwrightConfig: { timeout: 120_000 },
  retryStrategy: RetryStrategyBuilder.noRetries(),
})
