// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test } from '@jupyterlab/galata';

import { KERNELS, createNotebook, getOutputs, runCode } from './utils';

// JupyterLite served over plain http from another host than localhost, like
// on a LAN, is an insecure context: crypto.randomUUID does not exist there.
// The browser resolves insecure.test to the server of the tests.
test.use({
  baseURL: 'http://insecure.test:8000',
  launchOptions: {
    args: ['--host-resolver-rules=MAP insecure.test 127.0.0.1']
  },
  // Only the browser resolves insecure.test: skip the temporary folder that
  // Galata makes with the contents API of a server, which JupyterLite does
  // not have anyway
  tmpPath: ''
});

for (const kernel of KERNELS) {
  test.describe(`Insecure context (${kernel.displayName})`, () => {
    test.beforeEach(async ({ page }) => {
      await createNotebook(page, kernel);
      expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    });

    test('Sync a slider with the kernel over plain http', async ({ page }) => {
      const index = await runCode(
        page,
        'const s = new Jupyter.widgets.IntSlider({ value: 3 }); s'
      );
      const outputs = await getOutputs(page, index);
      const readout = outputs.locator('.widget-readout');
      await expect(readout).toHaveText('3');
      await expect(outputs).toHaveCount(1);
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stderr')
      ).toHaveCount(0);

      // From the frontend to the kernel
      await outputs.getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await expect(readout).toHaveText('5');
      const cell = await runCode(page, 's.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['5']);

      // From the kernel to the frontend
      await runCode(page, 's.value = 7;');
      await expect(readout).toHaveText('7');
    });

    test('Display a button and handle clicks over plain http', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          "const b = new Jupyter.widgets.Button({ description: 'Go' });",
          "b.onClick(() => console.log('clicked'));",
          'b'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);
      await outputs.getByRole('button', { name: 'Go' }).click();
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText('clicked');
    });
  });
}
