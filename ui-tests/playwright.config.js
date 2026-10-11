// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

const baseConfig = require('@jupyterlab/galata/lib/playwright-config');

module.exports = {
  ...baseConfig,
  retries: process.env.CI ? 1 : 0,
  expect: {
    // Leave room for the kernels to start
    timeout: 15000
  },
  use: {
    ...baseConfig.use,
    appPath: '',
    autoGoto: false,
    baseURL: 'http://localhost:8000',
    trace: 'retain-on-failure',
    video: 'retain-on-failure'
  },
  webServer: {
    command: 'jlpm start',
    port: 8000,
    timeout: 120 * 1000,
    reuseExistingServer: !process.env.CI
  }
};
