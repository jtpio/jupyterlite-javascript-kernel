// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test } from '@jupyterlab/galata';

import {
  IFRAME_KERNEL,
  KERNELS,
  WORKER_KERNEL,
  createNotebook,
  getOutputs,
  runCode
} from './utils';

for (const kernel of KERNELS) {
  test.describe(`Rich display (${kernel.displayName})`, () => {
    test.beforeEach(async ({ page }) => {
      await createNotebook(page, kernel);
    });

    test('Render HTML strings', async ({ page }) => {
      const index = await runCode(page, '"<b>Bold</b> and <i>italic</i>"');

      const html = await getOutputs(page, index, 'text/html');
      await expect(html.locator('b')).toHaveText('Bold');
      await expect(html.locator('i')).toHaveText('italic');
    });

    test('Display several values with display()', async ({ page }) => {
      const index = await runCode(
        page,
        ['display("<h3>First</h3>");', 'display([1, 2, 3]);', '"last"'].join(
          '\n'
        )
      );

      const outputs = await getOutputs(page, index);
      await expect(outputs).toHaveCount(3);
      await expect(outputs.nth(0).locator('h3')).toHaveText('First');
      await expect(outputs.nth(1)).toContainText('3 items');
      await expect(outputs.nth(2)).toHaveText("'last'");
    });

    test('Use the custom representations of objects', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'display({ _toHtml: () => "<span class=\'custom\'>custom HTML</span>" });',
          'display({ _toMarkdown: () => "## Custom Markdown" });',
          'display({ _toSvg: () => \'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8" /></svg>\' });',
          '({ _toMime: () => ({ "text/html": "<em>custom bundle</em>" }) })'
        ].join('\n')
      );

      await expect(
        (await getOutputs(page, index, 'text/html')).locator('.custom')
      ).toHaveText('custom HTML');
      await expect(
        (await getOutputs(page, index, 'text/markdown')).getByRole('heading', {
          name: 'Custom Markdown'
        })
      ).toBeVisible();
      await expect(await getOutputs(page, index, 'image/svg+xml')).toHaveCount(
        1
      );
      await expect(
        (await getOutputs(page, index, 'text/html')).locator('em')
      ).toHaveText('custom bundle');
    });

    test('Update the outputs of a display', async ({ page }) => {
      const first = await runCode(
        page,
        'const progress = display("Loading...", { id: true });'
      );
      await expect(await getOutputs(page, first)).toHaveText(["'Loading...'"]);

      // The handle updates the output in the first cell
      const second = await runCode(page, 'progress.update("Done!");');
      await expect(await getOutputs(page, first)).toHaveText(["'Done!'"]);
      await expect(await getOutputs(page, second)).toHaveCount(0);

      // Displaying again shows the new value in both cells
      const third = await runCode(page, 'progress.display("Shown again");');
      await expect(await getOutputs(page, first)).toHaveText(["'Shown again'"]);
      await expect(await getOutputs(page, third)).toHaveText(["'Shown again'"]);

      // Both outputs of the display follow the updates
      await runCode(page, 'progress.update("Updated twice");');
      await expect(await getOutputs(page, first)).toHaveText([
        "'Updated twice'"
      ]);
      await expect(await getOutputs(page, third)).toHaveText([
        "'Updated twice'"
      ]);
    });

    test('Display with the helpers', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const name = "helpers";',
          'display.html`<b>Hello ${name}</b>`;',
          'display.markdown("## Markdown title");',
          'display.svg(\'<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><rect width="30" height="30" fill="teal" /></svg>\');',
          'display.json({ language: "JavaScript" });',
          'display.png("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", { width: 40 });',
          'display.text("Plain text");'
        ].join('\n')
      );

      const outputs = await getOutputs(page, index);
      await expect(outputs).toHaveCount(6);
      await expect(outputs.nth(0).locator('b')).toHaveText('Hello helpers');
      await expect(
        outputs.nth(1).getByRole('heading', { name: 'Markdown title' })
      ).toBeVisible();
      await expect(outputs.nth(2)).toHaveAttribute(
        'data-mime-type',
        'image/svg+xml'
      );
      await expect(outputs.nth(3)).toHaveClass(/jp-RenderedJSON/);
      await expect(outputs.nth(3)).toContainText('language');
      await expect(outputs.nth(4).locator('img')).toHaveAttribute(
        'width',
        '40'
      );
      await expect(outputs.nth(5)).toHaveText('Plain text');
    });

    test('Clear the outputs of a cell', async ({ page }) => {
      const index = await runCode(
        page,
        'display("before");\nclearOutput();\ndisplay("after");'
      );

      await expect(await getOutputs(page, index)).toHaveText(["'after'"]);
    });

    test('Use the Jupyter display symbol and _toJson', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'display({ [Symbol.for("Jupyter.display")]: () => ({ "text/html": "<em>From the symbol</em>" }) });',
          '({ _toJson: () => ({ kernel: "JavaScript" }) })'
        ].join('\n')
      );

      const outputs = await getOutputs(page, index);
      await expect(outputs.nth(0).locator('em')).toHaveText('From the symbol');
      await expect(outputs.nth(1)).toHaveClass(/jp-RenderedJSON/);
      await expect(outputs.nth(1)).toContainText('kernel');
    });

    test('Format built-in objects', async ({ page }) => {
      let index = await runCode(page, 'new Date(0)');
      await expect(await getOutputs(page, index)).toContainText(
        '1970-01-01T00:00:00.000Z'
      );

      index = await runCode(page, 'new Set(["a", "b"])');
      await expect(await getOutputs(page, index)).toContainText('2 items');

      index = await runCode(
        page,
        'function square(x) { return x * x; }\nsquare'
      );
      await expect(
        (await getOutputs(page, index, 'text/html')).locator('code')
      ).toContainText('return x * x;');
    });
  });
}

test.describe(`Rich display (${IFRAME_KERNEL.displayName})`, () => {
  test.beforeEach(async ({ page }) => {
    await createNotebook(page, IFRAME_KERNEL);
  });

  test('Render DOM elements', async ({ page }) => {
    let index = await runCode(
      page,
      [
        'const div = document.createElement("div");',
        'div.innerHTML = "<strong>Hello from the DOM</strong>";',
        'div'
      ].join('\n')
    );
    await expect(
      (await getOutputs(page, index, 'text/html')).locator('strong')
    ).toHaveText('Hello from the DOM');

    index = await runCode(
      page,
      [
        'const canvas = document.createElement("canvas");',
        'canvas.width = 40;',
        'canvas.height = 30;',
        'const context = canvas.getContext("2d");',
        'context.fillStyle = "teal";',
        'context.fillRect(0, 0, 40, 30);',
        'canvas'
      ].join('\n')
    );
    const image = (await getOutputs(page, index, 'image/png')).locator('img');
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(40);
  });
});

test.describe(`Rich display (${WORKER_KERNEL.displayName})`, () => {
  test('Run without a DOM', async ({ page }) => {
    await createNotebook(page, WORKER_KERNEL);

    const index = await runCode(page, 'typeof document');
    expect(await page.notebook.getCellTextOutput(index)).toEqual([
      "'undefined'"
    ]);
  });
});
