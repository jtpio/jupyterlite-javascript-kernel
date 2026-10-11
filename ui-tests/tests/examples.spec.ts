// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test, type IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

import { IFRAME_KERNEL, WORKER_KERNEL, waitForKernelIdle } from './utils';

/**
 * Get the notebook of the active panel.
 */
async function getNotebook(page: IJupyterLabPageFixture): Promise<Locator> {
  const notebook = await page.notebook.getNotebookInPanelLocator();
  if (!notebook) {
    throw new Error('No active notebook');
  }
  return notebook;
}

/**
 * Get the first line of the errors shown in the outputs of the notebook.
 */
async function getErrors(page: IJupyterLabPageFixture): Promise<string[]> {
  const notebook = await getNotebook(page);
  const stderr = await notebook
    .locator(
      '.jp-OutputArea-output[data-mime-type="application/vnd.jupyter.stderr"]'
    )
    .allTextContents();
  // Errors are shown on stderr like the console.error output, but start with
  // the name of the error
  return stderr
    .filter(text => /^\w*Error: /.test(text))
    .map(text => text.split('\n')[0]);
}

/**
 * Open an example notebook from the file browser and run all its cells
 * from the Run menu.
 *
 * @returns The output areas of the notebook.
 */
async function runExample(
  page: IJupyterLabPageFixture,
  name: string,
  kernel: typeof IFRAME_KERNEL
): Promise<Locator> {
  await page.goto('lab/index.html');
  await page.filebrowser.open(name);
  await waitForKernelIdle(page, kernel);
  await page.notebook.run();
  return (await getNotebook(page)).locator('.jp-Cell-outputArea');
}

test.describe('Examples', () => {
  // Some examples run long computations
  test.setTimeout(5 * 60 * 1000);

  test('intro.ipynb', async ({ page }) => {
    const outputs = await runExample(page, 'intro.ipynb', IFRAME_KERNEL);

    await expect(outputs.getByText('3628800', { exact: true })).toBeVisible();
    await expect(outputs.getByText("'Hello, World!'")).toBeVisible();
    await expect(outputs.getByText('Done after 1 second!')).toBeVisible();
    // The console
    await expect(
      outputs.getByText('Ada Lovelace was born in 1815')
    ).toBeVisible();
    await expect(
      outputs.getByRole('table').getByRole('row', { name: '0 JavaScript 1995' })
    ).toBeVisible();
    await expect(outputs.getByText(/loop: \d+\.\d{3}ms/)).toBeVisible();
    // The documented function
    await expect(outputs.getByText('12.566370614359172')).toBeVisible();
    // The last cell shows an error on purpose
    expect(await getErrors(page)).toEqual(['Error: Something went wrong!']);
  });

  test('magic-imports.ipynb', async ({ page }) => {
    const outputs = await runExample(
      page,
      'magic-imports.ipynb',
      IFRAME_KERNEL
    );

    // marked
    await expect(
      outputs.getByRole('heading', { name: 'Hello Markdown!' })
    ).toBeVisible();
    // d3
    await expect(outputs.locator('svg rect')).toHaveCount(6);
    // chart.js
    await expect(outputs.getByText('Chart.js loaded: true')).toBeVisible();
    expect(await getErrors(page)).toEqual([]);
  });

  test('rich-output.ipynb', async ({ page }) => {
    const outputs = await runExample(page, 'rich-output.ipynb', IFRAME_KERNEL);

    // The canvases are shown as images
    await expect(
      outputs.locator('.jp-OutputArea-output[data-mime-type="image/png"] img')
    ).toHaveCount(2);
    await expect(
      outputs.locator('.jp-OutputArea-output[data-mime-type="image/svg+xml"]')
    ).not.toHaveCount(0);
    await expect(outputs.getByText('9007199254740993n')).toBeVisible();
    await expect(outputs.getByText('Symbol(my-symbol)')).toBeVisible();
    await expect(outputs.getByText('31 °C')).toBeVisible();
    // The display helpers
    await expect(outputs.getByRole('link', { name: 'link' })).toBeVisible();
    await expect(outputs.locator('mjx-container').first()).toBeVisible();
    await expect(outputs.getByText('Done!', { exact: true })).toBeVisible();
    await expect(outputs.getByText('Lift off!', { exact: true })).toBeVisible();
    await expect(outputs.getByText(/^Countdown/)).toHaveCount(0);
    // The errors are shown as values, not raised
    expect(await getErrors(page)).toEqual([]);
  });

  test('web-worker-compute.ipynb', async ({ page }) => {
    const outputs = await runExample(
      page,
      'web-worker-compute.ipynb',
      WORKER_KERNEL
    );

    await expect(outputs.getByText('Benchmark Results')).toBeVisible();
    await expect(outputs.locator('table tr')).toHaveCount(4);
    expect(await getErrors(page)).toEqual([]);
  });

  test('widgets.ipynb', async ({ page }) => {
    const outputs = await runExample(page, 'widgets.ipynb', IFRAME_KERNEL);

    await expect(outputs.getByRole('slider').first()).toBeVisible();
    await expect(
      outputs.getByRole('button', { name: 'Click me!' })
    ).toBeVisible();
    await expect(outputs.getByRole('tab', { name: 'Slider' })).toBeVisible();
    await expect(outputs.getByText('Comm ID:')).toBeVisible();
    await expect(outputs.getByRole('img')).toHaveAttribute('width', '240');
    expect(await getErrors(page)).toEqual([]);
  });
});
