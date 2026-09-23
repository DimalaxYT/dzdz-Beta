const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 35000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    headless: true,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    launchOptions: {
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
      args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:3100/api/health',
    env: { HOST: '0.0.0.0', PORT: '3100', PUBLIC_URL: '', KEEP_ALIVE: 'false', DISCORD_NOTIFY: 'false', DISCORD_HEARTBEAT: 'false', DISCORD_WEBHOOK_URL: '', DISCORD_BOT_TOKEN: '', DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '', MAX_FILE_SIZE_MB: '2', CHUNK_SIZE_MB: '1', STORAGE_DIR: 'storage/e2e' },
    reuseExistingServer: false,
    timeout: 20000
  }
});
