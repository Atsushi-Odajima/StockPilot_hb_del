import { defineConfig, devices } from '@playwright/test';

const PORT = 8090;
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } }},
  ],
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
