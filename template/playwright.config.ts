import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './__checks__',
  timeout: 120_000,
  retries: 0,
  reporter: 'list',
})
