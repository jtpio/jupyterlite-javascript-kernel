// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test, type IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import {
  IFRAME_KERNEL,
  KERNEL_VERSION,
  KERNELS,
  WORKER_KERNEL,
  createNotebook,
  getOutputs,
  runCode,
  waitForKernelIdle
} from './utils';

/**
 * Get a section of the launcher, like "Notebook" or "Console".
 */
function launcherSection(page: IJupyterLabPageFixture, title: string): Locator {
  return page.locator('.jp-Launcher-section').filter({
    has: page.locator('.jp-Launcher-sectionTitle', { hasText: title })
  });
}

test.describe('Launcher', () => {
  test('Show the two kernels for notebooks and consoles', async ({ page }) => {
    await page.goto('lab/index.html');

    for (const section of ['Notebook', 'Console']) {
      for (const kernel of KERNELS) {
        const card = launcherSection(page, section).getByRole('button', {
          name: kernel.displayName
        });
        await expect(card).toBeVisible();
        await expect(card.locator('img')).toBeVisible();
      }
    }
  });
});

for (const kernel of KERNELS) {
  test.describe(kernel.displayName, () => {
    test('Create a notebook from the launcher', async ({ page }) => {
      await page.goto('lab/index.html');

      await launcherSection(page, 'Notebook')
        .getByRole('button', { name: kernel.displayName })
        .click();
      await waitForKernelIdle(page, kernel);

      const index = await runCode(page, '6 * 7');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['42']);
    });

    test('Run code in a console', async ({ page }) => {
      await page.goto('lab/index.html');

      await launcherSection(page, 'Console')
        .getByRole('button', { name: kernel.displayName })
        .click();
      const console = page.locator('.jp-CodeConsole');
      const banner = console.locator('.jp-CodeConsole-banner');
      await expect(banner).toContainText(
        `JavaScript kernel ${KERNEL_VERSION} for JupyterLite (${kernel.runtime} runtime)`
      );
      await expect(banner).toContainText('ECMAScript 20');
      await expect(banner).toContainText(
        kernel === WORKER_KERNEL ? 'without the DOM' : 'with access to the DOM'
      );
      await waitForKernelIdle(page, kernel);

      await console.locator('.jp-CodeConsole-input .cm-content').click();
      await page.keyboard.type('const items = ["a", "b"];');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('items.join(" and ")');
      await page.keyboard.press('Shift+Enter');

      await expect(
        console.locator('.jp-CodeConsole-content .jp-OutputArea-output')
      ).toHaveText(["'a and b'"]);
    });

    test('Show the kernel banner from the Help menu', async ({ page }) => {
      await createNotebook(page, kernel);

      // The item appears once JupyterLab has fetched the kernel info
      const menu = await page.menu.openLocator('Help');
      const about = menu!.getByRole('menuitem', { name: kernel.about });
      await expect(about).toBeVisible();
      await about.click();

      const dialog = page.locator('.jp-Dialog');
      await expect(dialog).toContainText(
        `JavaScript kernel ${KERNEL_VERSION} for JupyterLite (${kernel.runtime} runtime)`
      );
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).toHaveCount(0);
    });

    test('Show the kernel help links in the Help menu', async ({ page }) => {
      await page.route('https://github.com/**', route =>
        route.fulfill({ contentType: 'text/html', body: '<html></html>' })
      );
      await createNotebook(page, kernel);

      const menu = await page.menu.openLocator('Help');
      for (const name of ['JavaScript Reference', 'Web APIs']) {
        await expect(
          menu!.getByRole('menuitem', { name, exact: true })
        ).toBeVisible();
      }
      await menu!
        .getByRole('menuitem', { name: 'JavaScript Kernel', exact: true })
        .click();

      const tab = page.activity.getTabLocator('JavaScript Kernel');
      await expect(tab).toBeVisible();
      await expect(page.locator('.jp-Help iframe')).toHaveAttribute(
        'src',
        'https://github.com/jupyterlite/javascript-kernel#readme'
      );
    });

    test('Wait for the code to be complete in a console', async ({ page }) => {
      await page.goto('lab/index.html');

      // Run the code with Enter, if the kernel says that it is complete
      await page.menu.clickMenuItem('Settings>Settings Editor');
      await page.getByRole('tab', { name: 'Code Console' }).click();
      await page
        .getByRole('heading', { name: 'Interaction mode', exact: true })
        .locator('..')
        .getByRole('combobox')
        .selectOption('Terminal');

      await page.menu.clickMenuItem('File>New Launcher');
      await launcherSection(page, 'Console')
        .getByRole('button', { name: kernel.displayName })
        .click();
      await waitForKernelIdle(page, kernel);
      const console = page.locator('.jp-CodeConsole');
      const prompt = console.locator('.jp-CodeConsole-input .cm-content');
      const outputs = console.locator(
        '.jp-CodeConsole-content .jp-OutputArea-output'
      );

      await prompt.click();
      await page.keyboard.type('Math.max(');
      await page.keyboard.press('Enter');
      // The call is not complete: Enter adds a new line
      await expect(prompt.locator('.cm-line')).toHaveCount(2);
      await expect(outputs).toHaveCount(0);

      await page.keyboard.type('1, 5)');
      await page.keyboard.press('Enter');
      await expect(outputs).toHaveText(['5']);
    });

    test('Restart the kernel', async ({ page }) => {
      await createNotebook(page, kernel);
      let index = await runCode(page, 'const before = "restart";\nbefore');
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "'restart'"
      ]);

      await page.menu.clickMenuItem('Kernel>Restart Kernel…');
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Confirm Kernel Restart' })
        .click();
      await waitForKernelIdle(page, kernel);

      index = await runCode(page, 'typeof before');
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        "'undefined'"
      ]);
    });

    test('Change the kernel', async ({ page }) => {
      const other = kernel === IFRAME_KERNEL ? WORKER_KERNEL : IFRAME_KERNEL;
      await createNotebook(page, kernel);

      await page.menu.clickMenuItem('Kernel>Change Kernel…');
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('combobox').selectOption(other.displayName);
      await dialog.getByRole('button', { name: 'Select' }).click();
      await waitForKernelIdle(page, other);

      const index = await runCode(page, 'typeof document');
      expect(await page.notebook.getCellTextOutput(index)).toEqual([
        other === IFRAME_KERNEL ? "'object'" : "'undefined'"
      ]);
    });

    test('Keep running after a cell replaces postMessage and Function', async ({
      page
    }) => {
      await createNotebook(page, kernel);
      await runCode(page, 'function postMessage() {}');
      let index = await runCode(page, '1 + 1');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['2']);

      await runCode(page, 'Function = undefined;');
      index = await runCode(page, 'const point = { x: 1 + 2 };\npoint.x');
      expect(await page.notebook.getCellTextOutput(index)).toEqual(['3']);

      // The completion evaluates the code before the dot
      const input = await page.notebook.getCellInputLocator(index + 1);
      await input!.click();
      await page.keyboard.type('point.');
      await page.keyboard.press('Tab');
      await expect(
        page.locator('.jp-Completer-item .jp-Completer-match').first()
      ).toHaveText('x');
    });
  });
}

test.describe(`Closed runtime (${WORKER_KERNEL.displayName})`, () => {
  test('Fail the requests once a cell closed the Web Worker', async ({
    page
  }) => {
    await createNotebook(page, WORKER_KERNEL);
    let index = await runCode(page, 'self.close()');
    const stopped =
      'RuntimeStoppedError: The JavaScript runtime stopped: the code closed the Web Worker with close(). Restart the kernel.';
    await expect(
      await getOutputs(page, index, 'application/vnd.jupyter.stderr')
    ).toHaveText(stopped);

    // The next cells fail instead of waiting forever
    index = await runCode(page, '1 + 1');
    await expect(
      await getOutputs(page, index, 'application/vnd.jupyter.stderr')
    ).toHaveText(stopped);

    await page.menu.clickMenuItem('Kernel>Restart Kernel…');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirm Kernel Restart' })
      .click();
    await waitForKernelIdle(page, WORKER_KERNEL);
    index = await runCode(page, '1 + 1');
    expect(await page.notebook.getCellTextOutput(index)).toEqual(['2']);
  });
});

test.describe(`Runtime startup failure (${WORKER_KERNEL.displayName})`, () => {
  // The requests of the Web Worker go to the network, where the test can
  // block them, instead of through the service worker
  test.use({ serviceWorkers: 'block' });

  /**
   * Make the Web Worker fail to start, like offline or with a content
   * security policy: the modules that its script imports do not load. The
   * scripts of the page load as usual.
   */
  async function blockWorkerModules(
    page: IJupyterLabPageFixture
  ): Promise<() => Promise<void>> {
    const url = /\/javascript-kernel-extension\/static\/.*\.js/;
    await page.route(url, route =>
      // The browser loads the modules of a Web Worker as other resources
      route.request().resourceType() === 'other'
        ? route.abort()
        : route.fallback()
    );
    return () => page.unroute(url);
  }

  test('Fail the cells with the startup error instead of hanging', async ({
    page
  }) => {
    const unblock = await blockWorkerModules(page);
    await createNotebook(page, WORKER_KERNEL);

    // The error of the browser names the script which failed to load
    const failed =
      /^RuntimeStartupError: JavaScript runtime failed to start: NetworkError: .*The script at '.*' failed to load\..* Restart the kernel to try again\.$/;
    let index = await runCode(page, '1 + 1');
    await expect(
      await getOutputs(page, index, 'application/vnd.jupyter.stderr')
    ).toHaveText(failed);

    // The kernel banner tells it too
    const menu = await page.menu.openLocator('Help');
    await menu!.getByRole('menuitem', { name: WORKER_KERNEL.about }).click();
    const dialog = page.locator('.jp-Dialog');
    await expect(dialog).toContainText(
      'JavaScript runtime failed to start: NetworkError'
    );
    await dialog.getByRole('button', { name: 'Close' }).click();

    // Once the network is back, a restart starts the runtime
    await unblock();
    await page.menu.clickMenuItem('Kernel>Restart Kernel…');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirm Kernel Restart' })
      .click();
    await waitForKernelIdle(page, WORKER_KERNEL);
    index = await runCode(page, '1 + 1');
    expect(await page.notebook.getCellTextOutput(index)).toEqual(['2']);
  });
});

test.describe(`Kernel info (${IFRAME_KERNEL.displayName})`, () => {
  test('Store the language info in the notebook metadata', async ({ page }) => {
    await createNotebook(page, IFRAME_KERNEL);

    await page.sidebar.openTab('jp-property-inspector');
    const inspector = page.sidebar.getContentPanelLocator('right');
    await inspector.getByText('Advanced Tools').click();

    const metadata = inspector.locator('.jp-JSONEditor').last();
    await expect(metadata).toContainText(/"version": "ES20\d\d"/);
    await expect(metadata).toContainText('"nbconvert_exporter": "script"');
    await expect(metadata).toContainText('"mimetype": "text/javascript"');
  });
});
