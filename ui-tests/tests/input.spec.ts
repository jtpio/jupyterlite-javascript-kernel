// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test } from '@jupyterlab/galata';

import {
  IFRAME_KERNEL,
  WORKER_KERNEL,
  createNotebook,
  getOutputs,
  runCode
} from './utils';

const QUESTION = 'const name = prompt("What is your name?");\n`Hello ${name}`';

test.describe(`Input (${WORKER_KERNEL.displayName})`, () => {
  test.beforeEach(async ({ page }) => {
    await createNotebook(page, WORKER_KERNEL);
  });

  test('Answer a prompt in the output area', async ({ page }) => {
    const index = await runCode(page, QUESTION, { wait: false });

    const input = page.locator('.jp-Stdin-input');
    await expect(page.locator('.jp-Stdin-prompt')).toHaveText(
      'What is your name?'
    );
    await input.fill('Ada');
    await input.press('Enter');

    await page.notebook.waitForRun(index);
    await expect(await getOutputs(page, index)).toHaveText([
      'What is your name? Ada\n',
      "'Hello Ada'"
    ]);
  });

  test('Show the output printed before a prompt', async ({ page }) => {
    const index = await runCode(
      page,
      'console.log("Welcome");\nconst name = prompt("Name?");\nconsole.log("Hi " + name);',
      { wait: false }
    );

    const input = page.locator('.jp-Stdin-input');
    await expect(page.locator('.jp-Stdin-prompt')).toHaveText('Name?');
    const stdout = await getOutputs(
      page,
      index,
      'application/vnd.jupyter.stdout'
    );
    await expect(stdout.first()).toHaveText('Welcome\n');
    await input.fill('Ada');
    await input.press('Enter');

    await page.notebook.waitForRun(index);
    await expect(stdout.last()).toContainText('Hi Ada');
  });

  test('Hide the answers to the password prompts', async ({ page }) => {
    const index = await runCode(
      page,
      'const secret = prompt.password("Password:");\nsecret.length',
      { wait: false }
    );

    const input = page.locator('.jp-Stdin-input');
    await expect(input).toHaveAttribute('type', 'password');
    await input.fill('swordfish');
    await input.press('Enter');

    await page.notebook.waitForRun(index);
    const outputs = await getOutputs(page, index);
    await expect(outputs).toHaveText([/^Password:/, '9']);
    await expect(outputs.first()).not.toContainText('swordfish');
  });
});

test.describe(`Input (${IFRAME_KERNEL.displayName})`, () => {
  test('Answer a prompt in a browser dialog', async ({ page }) => {
    await createNotebook(page, IFRAME_KERNEL);

    // The iframe runs the code on the main thread, so it uses the dialog of
    // the browser
    const dialog = new Promise<string>(resolve => {
      page.once('dialog', async prompt => {
        resolve(prompt.message());
        await prompt.accept('Grace');
      });
    });
    const index = await runCode(page, QUESTION, { wait: false });

    expect(await dialog).toBe('What is your name?');
    await page.notebook.waitForRun(index);
    await expect(await getOutputs(page, index)).toHaveText(["'Hello Grace'"]);
  });
});
