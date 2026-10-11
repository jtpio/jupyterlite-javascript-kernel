// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, type IJupyterLabPageFixture } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The version of the kernel package, reported in the kernel banner.
 */
export const KERNEL_VERSION: string = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../packages/javascript-kernel/package.json'),
    'utf-8'
  )
).version;

/**
 * A JavaScript kernel registered by the extension.
 */
export interface IKernel {
  /**
   * The name of the kernel spec.
   */
  name: string;

  /**
   * The display name of the kernel spec.
   */
  displayName: string;

  /**
   * The name of the runtime in the kernel banner.
   */
  runtime: string;

  /**
   * The label of the Help menu item showing the kernel banner.
   */
  about: string;
}

/**
 * The kernel running the code in an iframe.
 */
export const IFRAME_KERNEL: IKernel = {
  name: 'javascript',
  displayName: 'JavaScript (IFrame)',
  runtime: 'IFrame',
  about: 'About the JavaScript (IFrame) Kernel'
};

/**
 * The kernel running the code in a Web Worker.
 */
export const WORKER_KERNEL: IKernel = {
  name: 'javascript-worker',
  displayName: 'JavaScript (Web Worker)',
  runtime: 'Web Worker',
  about: 'About the JavaScript (Web Worker) Kernel'
};

/**
 * The two JavaScript kernels.
 */
export const KERNELS = [IFRAME_KERNEL, WORKER_KERNEL];

/**
 * Wait for the kernel of the current notebook or console to be idle.
 */
export async function waitForKernelIdle(
  page: IJupyterLabPageFixture,
  kernel: IKernel
): Promise<void> {
  await expect(page.locator('#jp-main-statusbar')).toContainText(
    `${kernel.displayName} | Idle`
  );
}

/**
 * Open JupyterLite and create a new notebook with a kernel, from the
 * File > New > Notebook menu.
 *
 * @returns The name of the notebook.
 */
export async function createNotebook(
  page: IJupyterLabPageFixture,
  kernel: IKernel
): Promise<string> {
  await page.goto('lab/index.html');
  const name = await page.notebook.createNew(undefined, {
    kernel: kernel.name
  });
  if (!name) {
    throw new Error('The notebook was not created');
  }
  await waitForKernelIdle(page, kernel);
  return name;
}

/**
 * Type some code in the last cell of the notebook and run it with
 * Shift+Enter, like a user typing one cell after the other.
 *
 * @param options.wait - Whether to wait for the end of the execution.
 * @returns The index of the cell.
 */
export async function runCode(
  page: IJupyterLabPageFixture,
  code: string,
  options: { wait?: boolean } = {}
): Promise<number> {
  const count = await page.notebook.getCellCount();
  let index = count - 1;
  const input = await page.notebook.getCellInputLocator(index);
  const isEmpty = (await input?.locator('.cm-content').textContent()) === '';
  if (isEmpty) {
    await page.notebook.setCell(index, 'code', code);
  } else {
    await page.notebook.addCell('code', code);
    index = count;
  }
  await page.notebook.runCell(index, { wait: options.wait ?? true });
  return index;
}

/**
 * Get the outputs of a cell, optionally only the ones rendered for a MIME
 * type.
 */
export async function getOutputs(
  page: IJupyterLabPageFixture,
  index: number,
  mimeType?: string
): Promise<Locator> {
  const outputArea = await page.notebook.getCellOutputLocator(index);
  if (!outputArea) {
    throw new Error(`Cell ${index} has no output area`);
  }
  return outputArea.locator(
    mimeType
      ? `.jp-OutputArea-output[data-mime-type="${mimeType}"]`
      : '.jp-OutputArea-output'
  );
}
