// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test } from '@jupyterlab/galata';

import {
  IFRAME_KERNEL,
  KERNELS,
  createNotebook,
  getOutputs,
  getSettingField,
  openKernelSettings,
  runCode,
  setKernelSetting,
  waitForKernelIdle
} from './utils';

const STDERR = 'application/vnd.jupyter.stderr';

// The fake CDN of the test site, with the layout of jsDelivr: build.py
// copies ui-tests/fixtures/fake-cdn into the site. No network is needed.
const FAKE_CDN = 'fake-cdn/';
const FIXTURE = 'settings-fixture/index.js';

// The notebooks are created in the page where the settings were changed:
// reloading it would restore the Settings Editor tab

test.describe('Kernel settings', () => {
  test('The Settings Editor shows the JavaScript kernel settings', async ({
    page
  }) => {
    await page.goto('lab/index.html');
    const form = await openKernelSettings(page);

    await expect(getSettingField(form, 'Magic imports')).toBeChecked();
    await expect(getSettingField(form, 'CDN base URL')).toHaveValue(
      'https://cdn.jsdelivr.net/'
    );
    await expect(getSettingField(form, 'Add the npm/ prefix')).toBeChecked();
    await expect(getSettingField(form, 'Add the +esm suffix')).toBeChecked();
    await expect(getSettingField(form, 'Loop timeout (ms)')).toHaveValue(
      '10000'
    );
    await expect(
      getSettingField(form, 'Output limit (characters)')
    ).toHaveValue('5000000');
    await expect(
      getSettingField(form, 'Stop the timers of a cell when it runs again')
    ).toBeChecked();
  });

  test('Change the loop timeout of the IFrame kernel', async ({ page }) => {
    await page.goto('lab/index.html');
    const form = await openKernelSettings(page);
    await setKernelSetting(page, form, 'Loop timeout (ms)', '500');

    await createNotebook(page, IFRAME_KERNEL, { open: false });
    const index = await runCode(page, 'while (true) {}');
    const outputs = await getOutputs(page, index, STDERR);
    await expect(outputs).toContainText(
      'The while loop at line 1 of In[1] ran for more than 0.5 s'
    );
  });
});

for (const kernel of KERNELS) {
  test.describe(`Kernel settings (${kernel.displayName})`, () => {
    test('Import packages from the configured CDN', async ({ page }) => {
      await page.goto('lab/index.html');
      const form = await openKernelSettings(page);
      await setKernelSetting(page, form, 'CDN base URL', FAKE_CDN);

      await createNotebook(page, kernel, { open: false });
      await runCode(page, `import { answer } from '${FIXTURE}';`);
      const index = await runCode(page, 'answer');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['42']);
    });

    test('Apply the settings after a kernel restart', async ({ page }) => {
      await page.goto('lab/index.html');
      const form = await openKernelSettings(page);
      await setKernelSetting(page, form, 'CDN base URL', FAKE_CDN);

      const name = await createNotebook(page, kernel, { open: false });
      let index = await runCode(
        page,
        `import { answer } from '${FIXTURE}';\nanswer`
      );
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['42']);

      await page.activity.activateTab('Settings');
      await setKernelSetting(page, form, 'Magic imports', false);

      // The running kernel keeps its settings
      await page.activity.activateTab(name);
      index = await runCode(page, `import fixture from '${FIXTURE}';\nfixture`);
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "'served by the test site'"
      ]);

      await page.menu.clickMenuItem('Kernel>Restart Kernel…');
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Confirm Kernel Restart' })
        .click();
      await waitForKernelIdle(page, kernel);

      // The package name is left to the browser, which can not resolve it
      index = await runCode(page, `import x from '${FIXTURE}';`);
      const outputs = await getOutputs(page, index, STDERR);
      await expect(outputs).toContainText('TypeError');
      await expect(outputs).toContainText(FIXTURE);
    });

    test('Change the output limit', async ({ page }) => {
      await page.goto('lab/index.html');
      const form = await openKernelSettings(page);
      await setKernelSetting(page, form, 'Output limit (characters)', '1000');

      await createNotebook(page, kernel, { open: false });
      const index = await runCode(
        page,
        "for (let i = 0; i < 100; i++) console.log('x'.repeat(99))"
      );
      const outputs = await getOutputs(page, index, STDERR);
      await expect(outputs).toContainText(
        'Output limit reached: the cell printed more than 1,000 characters'
      );
    });

    test('Turn off the npm/ prefix and the +esm suffix', async ({ page }) => {
      await page.goto('lab/index.html');
      const form = await openKernelSettings(page);
      await setKernelSetting(page, form, 'CDN base URL', `${FAKE_CDN}npm/`);
      await setKernelSetting(page, form, 'Add the npm/ prefix', false);
      await setKernelSetting(page, form, 'Add the +esm suffix', false);

      await createNotebook(page, kernel, { open: false });
      let index = await runCode(
        page,
        `import { answer } from '${FIXTURE}';\nanswer`
      );
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['42']);

      // Without the +esm suffix, the import of the directory fails
      index = await runCode(page, "import x from 'settings-fixture';");
      const outputs = await getOutputs(page, index, STDERR);
      await expect(outputs).toContainText('/fake-cdn/npm/settings-fixture');
      await expect(outputs).not.toContainText('+esm');
    });
  });
}
