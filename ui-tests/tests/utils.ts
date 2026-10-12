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
 * @param options.open - Whether to open JupyterLite first, true by default.
 * @returns The name of the notebook.
 */
export async function createNotebook(
  page: IJupyterLabPageFixture,
  kernel: IKernel,
  options: { open?: boolean } = {}
): Promise<string> {
  if (options.open ?? true) {
    await page.goto('lab/index.html');
  }
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

/**
 * Open the settings of the JavaScript kernels from the Settings > Settings
 * Editor menu, searching for them.
 *
 * @returns The form of the settings.
 */
export async function openKernelSettings(
  page: IJupyterLabPageFixture
): Promise<Locator> {
  await page.menu.clickMenuItem('Settings>Settings Editor');
  await page
    .locator('.jp-PluginList')
    .getByRole('searchbox')
    .fill('JavaScript');
  await page.getByRole('tab', { name: 'JavaScript Kernel' }).click();
  const form = page
    .locator('.jp-SettingsForm')
    .filter({ hasText: 'JavaScript Kernel' });
  await expect(form.getByLabel('Magic imports', { exact: true })).toBeVisible();
  return form;
}

/**
 * Get the field of a setting in the form of the Settings Editor, from its
 * title: the label of a checkbox, or the heading above a text field.
 */
export function getSettingField(form: Locator, title: string): Locator {
  return form
    .getByLabel(title, { exact: true })
    .or(
      form
        .getByRole('heading', { name: title, exact: true })
        .locator('..')
        .locator('input')
    );
}

/**
 * Change a setting of the JavaScript kernels in the form of the Settings
 * Editor, and wait for it to be saved: the tab of the editor shows it is
 * modified until the setting is saved, half a second after the change.
 *
 * @param value - The value of a text field, or whether to check a checkbox.
 */
export async function setKernelSetting(
  page: IJupyterLabPageFixture,
  form: Locator,
  label: string,
  value: string | boolean
): Promise<void> {
  const field = getSettingField(form, label);
  if (typeof value === 'boolean') {
    await field.setChecked(value);
  } else {
    await field.fill(value);
  }
  const tab = page.activity.getTabLocator('Settings');
  await expect(tab).toHaveClass(/jp-mod-dirty/);
  await expect(tab).not.toHaveClass(/jp-mod-dirty/);
}
