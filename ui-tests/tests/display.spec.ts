// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test } from '@jupyterlab/galata';
import type { Locator } from '@playwright/test';

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

    test('Show the values JSON can not represent as text', async ({ page }) => {
      // JSON would show NaN and undefined as null
      let index = await runCode(page, '[1, NaN, undefined]');
      let outputs = await getOutputs(page, index);
      await expect(outputs).toHaveText(['[ 1, NaN, undefined ]']);
      await expect(outputs).toHaveAttribute('data-mime-type', 'text/plain');

      index = await runCode(page, 'display.json({ ratio: Infinity })');
      outputs = await getOutputs(page, index);
      await expect(outputs).toHaveText(['{ ratio: Infinity }']);
      await expect(outputs).toHaveAttribute('data-mime-type', 'text/plain');
    });

    test('Show the state of platform objects', async ({ page }) => {
      let index = await runCode(
        page,
        'new Blob(["hi"], { type: "text/plain" })'
      );
      let outputs = await getOutputs(page, index);
      await expect(outputs).toHaveText([
        "Blob { size: 2, type: 'text/plain' }"
      ]);
      await expect(outputs).toHaveAttribute('data-mime-type', 'text/plain');

      index = await runCode(
        page,
        'new Response("hello", { status: 201, headers: { "X-Kernel": "JavaScript" } })'
      );
      outputs = await getOutputs(page, index);
      await expect(outputs).toContainText('Response {');
      await expect(outputs).toContainText('status: 201');
      await expect(outputs).toContainText("'x-kernel' => 'JavaScript'");
      await expect(outputs).toContainText('bodyUsed: false');
      await expect(outputs).toHaveAttribute('data-mime-type', 'text/plain');

      // The own isTrusted key of an event does not hide its state in a tree
      index = await runCode(page, 'new CustomEvent("ping", { detail: 42 })');
      outputs = await getOutputs(page, index);
      await expect(outputs).toContainText("type: 'ping'");
      await expect(outputs).toContainText('detail: 42');
      await expect(outputs).toHaveAttribute('data-mime-type', 'text/plain');

      // The entries of an asynchronous iterable are not listed
      index = await runCode(page, 'await navigator.storage.getDirectory()');
      outputs = await getOutputs(page, index);
      await expect(outputs).toHaveText([
        "FileSystemDirectoryHandle { kind: 'directory', name: '' }"
      ]);
    });

    test('Limit the JSON tree of large values', async ({ page }) => {
      let index = await runCode(
        page,
        'Array.from({ length: 100000 }, (_, i) => i)'
      );
      let outputs = await getOutputs(page, index);
      await expect(outputs).toContainText('... 99900 more items');
      await expect(outputs).toHaveAttribute('data-mime-type', 'text/plain');

      // An array at the limit is still shown as a tree
      index = await runCode(page, 'Array.from({ length: 10000 }, (_, i) => i)');
      outputs = await getOutputs(page, index);
      await expect(outputs).toHaveClass(/jp-RenderedJSON/);
      await expect(outputs).toContainText('10000 items');
    });

    test('Show objects with a data key', async ({ page }) => {
      // Keys with a slash are not MIME types
      let index = await runCode(page, '({ data: { "2024/01": 5 } })');
      let outputs = await getOutputs(page, index);
      await expect(outputs).toHaveClass(/jp-RenderedJSON/);
      // Expand the data in the tree
      await outputs.getByText('data', { exact: true }).click();
      await expect(outputs).toContainText('2024/01');
      await expect(outputs).not.toContainText('No renderer');

      // A MIME bundle in the data is shown
      index = await runCode(
        page,
        '({ data: { "text/html": "<b>From the bundle</b>" } })'
      );
      outputs = await getOutputs(page, index, 'text/html');
      await expect(outputs.locator('b')).toHaveText('From the bundle');

      // And the vendor MIME types, like the Mermaid diagrams
      index = await runCode(
        page,
        '({ data: { "text/vnd.mermaid": "graph TD; Kernel-->Diagram" } })'
      );
      outputs = await getOutputs(page, index);
      await expect(outputs.getByRole('figure')).toBeVisible();
      await expect(outputs).not.toHaveClass(/jp-RenderedJSON/);
    });

    test('Show Vega-Lite charts and Mermaid diagrams', async ({ page }) => {
      const spec = [
        '({',
        '  $schema: "https://vega.github.io/schema/vega-lite/v5.json",',
        '  data: { values: [{ a: "A", b: 3 }, { a: "B", b: 5 }] },',
        '  mark: "bar",',
        '  encoding: {',
        '    x: { field: "a", type: "nominal" },',
        '    y: { field: "b", type: "quantitative" }',
        '  }',
        '})'
      ].join('\n');
      await runCode(page, `const spec = ${spec};`);
      let index = await runCode(page, 'display.vegalite(spec);');
      let outputs = await getOutputs(page, index);
      await expect(
        outputs.locator('.vega-embed').locator('canvas.marks, svg.marks')
      ).toBeVisible();

      // A spec with a Vega-Lite $schema is shown as a chart
      index = await runCode(page, 'spec');
      outputs = await getOutputs(page, index);
      await expect(
        outputs.locator('.vega-embed').locator('canvas.marks, svg.marks')
      ).toBeVisible();
      await expect(outputs).not.toHaveClass(/jp-RenderedJSON/);

      index = await runCode(page, 'display.mermaid`graph TD; A-->B`;');
      // The diagram is an SVG image
      outputs = await getOutputs(page, index);
      await expect(
        outputs.getByRole('figure').getByRole('img')
      ).toHaveAttribute('src', /^data:image\/svg\+xml/);
    });

    test('Keep the order of the outputs of an image being encoded', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const c = new OffscreenCanvas(40, 30);',
          'const g = c.getContext("2d");',
          'g.fillStyle = "teal";',
          'g.fillRect(0, 0, 40, 30);',
          'display(c, { id: true });',
          'console.log("after the image");'
        ].join('\n')
      );

      const outputs = await getOutputs(page, index);
      await expect(outputs).toHaveCount(2);
      await expect(outputs.nth(0)).toHaveAttribute(
        'data-mime-type',
        'image/png'
      );
      await expect(outputs.nth(1)).toHaveText('after the image');
      const image = outputs.nth(0).locator('img');
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBe(40);
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
    let image = (await getOutputs(page, index, 'image/png')).locator('img');
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(40);

    // The pixels of a canvas
    index = await runCode(page, 'context.getImageData(0, 0, 20, 10)');
    image = (await getOutputs(page, index, 'image/png')).locator('img');
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(20);
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

  test('Show the drawings of an OffscreenCanvas as images', async ({
    page
  }) => {
    await createNotebook(page, WORKER_KERNEL);
    const naturalWidth = (image: Locator) =>
      image.evaluate((img: HTMLImageElement) => img.naturalWidth);

    let index = await runCode(
      page,
      [
        'const c = new OffscreenCanvas(40, 30);',
        'const g = c.getContext("2d");',
        'g.fillStyle = "teal";',
        'g.fillRect(0, 0, 40, 30);',
        'c'
      ].join('\n')
    );
    let image = (await getOutputs(page, index, 'image/png')).locator('img');
    await expect.poll(() => naturalWidth(image)).toBe(40);

    // A Blob of an image, an ImageData and an ImageBitmap
    index = await runCode(
      page,
      [
        'display(await c.convertToBlob());',
        'display(g.getImageData(0, 0, 20, 10));',
        'await createImageBitmap(c, 0, 0, 30, 10)'
      ].join('\n')
    );
    const images = (await getOutputs(page, index, 'image/png')).locator('img');
    await expect(images).toHaveCount(3);
    await expect.poll(() => naturalWidth(images.nth(0))).toBe(40);
    await expect.poll(() => naturalWidth(images.nth(1))).toBe(20);
    await expect.poll(() => naturalWidth(images.nth(2))).toBe(30);

    // The image helpers encode the drawings in their format
    index = await runCode(page, 'display.jpeg(c, { width: 80 });');
    image = (await getOutputs(page, index, 'image/jpeg')).locator('img');
    await expect(image).toHaveAttribute('width', '80');
    await expect.poll(() => naturalWidth(image)).toBe(40);
  });
});
