// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test } from '@jupyterlab/galata';

import {
  KERNELS,
  createNotebook,
  getOutputs,
  runCode,
  waitForKernelIdle
} from './utils';

for (const kernel of KERNELS) {
  test.describe(`Widgets (${kernel.displayName})`, () => {
    test.beforeEach(async ({ page }) => {
      await createNotebook(page, kernel);
    });

    test('Sync a slider with the kernel', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { IntSlider } = Jupyter.widgets;',
          'const slider = new IntSlider({ value: 5, max: 10, description: "Level" });',
          'slider'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);
      const readout = widget.locator('.widget-readout');
      await expect(widget.getByText('Level')).toBeVisible();
      await expect(readout).toHaveText('5');

      // From the frontend to the kernel
      await widget.getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await expect(readout).toHaveText('7');
      const cell = await runCode(page, 'slider.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['7']);

      // From the kernel to the frontend
      await runCode(page, 'slider.value = 2;');
      await expect(readout).toHaveText('2');
    });

    test('Handle button clicks', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { Button, Output } = Jupyter.widgets;',
          'let clicks = 0;',
          'const output = new Output();',
          'const button = new Button({ description: "Click me" });',
          'button.onClick(() => {',
          'clicks += 1;',
          'output.appendStdout(`Clicked ${clicks} times\\n`);',
          '});',
          'display(button);',
          'output'
        ].join('\n')
      );
      const widgets = await getOutputs(page, index);

      const button = widgets.getByRole('button', { name: 'Click me' });
      await button.click();
      await button.click();
      await expect(widgets.locator('.widget-output')).toContainText(
        'Clicked 2 times'
      );

      const cell = await runCode(page, 'clicks');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['2']);
    });

    test('Show the errors of the button handlers', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { Button, HBox } = Jupyter.widgets;',
          'const failing = new Button({ description: "Fail" });',
          'failing.onClick(() => {',
          'throw new Error("bad click");',
          '});',
          'const rejecting = new Button({ description: "Fail later" });',
          'rejecting.onClick(async () => {',
          'throw new Error("bad async click");',
          '});',
          'new HBox({ children: [failing, rejecting] })'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);
      const stderr = await getOutputs(
        page,
        index,
        'application/vnd.jupyter.stderr'
      );

      // The errors are printed on stderr, one after the other
      await outputs.getByRole('button', { name: 'Fail', exact: true }).click();
      await expect(stderr).toContainText('Uncaught Error: bad click');
      await expect(stderr).toContainText('at In[1]:4:');

      await outputs.getByRole('button', { name: 'Fail later' }).click();
      await expect(stderr).toContainText(
        'Uncaught (in promise) Error: bad async click'
      );

      // The button still works
      await outputs.getByRole('button', { name: 'Fail', exact: true }).click();
      await expect(stderr).toHaveText(
        /bad click[^]*bad async click[^]*bad click/
      );
    });

    test('Show the errors of the callbacks captured by an Output', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Output } = Jupyter.widgets;',
          'const output = new Output();',
          'const job = output.capture(async () => {',
          'throw new Error("captured");',
          '});',
          'job();'
        ].join('\n')
      );

      const outputArea = await page.notebook.getCellOutputLocator(index);
      await expect(outputArea!).toContainText(
        'Uncaught (in promise) Error: captured'
      );
    });

    test('Capture the console in an Output widget', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { Output } = Jupyter.widgets;',
          'const out = new Output();',
          'display(out);',
          'console.log("outside");',
          'out.capture(() => console.log("inside"))();',
          'console.log("after");'
        ].join('\n')
      );

      const outputs = await getOutputs(page, index);
      const widget = outputs.locator('.widget-output');
      await expect(widget).toContainText('inside');
      await expect(widget).not.toContainText('outside');
      await expect(widget).not.toContainText('after');
      // The output of the widget, then the ones of the cell
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText(['inside\n', 'outside\nafter\n']);
    });

    test('Capture the outputs of a button callback in an Output widget', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Button, Output } = Jupyter.widgets;',
          'const out = new Output();',
          'const log = new Button({ description: "Log" });',
          'log.onClick(out.capture(() => console.log("clicked")));',
          'const load = new Button({ description: "Load" });',
          'load.onClick(out.capture(async () => {',
          'console.log("loading");',
          'await null;',
          'console.log("ready");',
          'await new Promise(resolve => setTimeout(resolve, 200));',
          'console.log("loaded");',
          '}));',
          'display(log);',
          'display(load);',
          'out'
        ].join('\n')
      );
      // Another cell runs after
      const later = await runCode(page, 'console.log("later")');
      const outputs = await getOutputs(page, index);
      const widget = outputs.locator('.widget-output');

      await outputs.getByRole('button', { name: 'Log' }).click();
      await expect(widget).toContainText('clicked');

      // The outputs after an await too
      await outputs.getByRole('button', { name: 'Load' }).click();
      await expect(widget).toContainText('loaded');
      await expect(widget).toHaveText(
        /^clicked\s+loading\s+ready\s+loaded\s*$/
      );

      // Only in the widget: the stream outputs of the cell are the ones of
      // the widget
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText(['clicked\nloading\nready\nloaded\n']);
      await expect(await getOutputs(page, later)).toHaveText(['later\n']);
    });

    test('Show the outputs of overlapping clicks in an Output widget', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Button, Output } = Jupyter.widgets;',
          'const out = new Output();',
          'const slow = new Button({ description: "Slow" });',
          'let clicks = 0;',
          'slow.onClick(out.capture(async () => {',
          'const click = ++clicks;',
          'console.log(`start ${click}`);',
          'await new Promise(resolve => setTimeout(resolve, 1000));',
          'console.log(`end ${click}`);',
          '}));',
          'display(slow);',
          'out'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);
      const button = outputs.getByRole('button', { name: 'Slow' });

      // The second click starts while the first one waits
      await button.click();
      await button.click();
      const widget = outputs.locator('.widget-output');
      await expect(widget).toHaveText(/^start 1\s+start 2\s+end 1\s+end 2\s*$/);
    });

    test('Keep the order of the printed and appended outputs of a click after an await', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Button, Output } = Jupyter.widgets;',
          'const out = new Output();',
          'const load = new Button({ description: "Load" });',
          'load.onClick(out.capture(async () => {',
          'await new Promise(resolve => setTimeout(resolve, 100));',
          'console.log("fetched");',
          'out.appendDisplayData({ "text/html": "<b>table</b>" });',
          'console.log("logged");',
          'out.appendStdout("appended\\n");',
          '}));',
          'display(load);',
          'out'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);
      await outputs.getByRole('button', { name: 'Load' }).click();
      const widget = outputs.locator('.widget-output');
      await expect(widget).toHaveText(
        /^fetched\s+table\s*logged\s+appended\s*$/
      );
    });

    test('Print the outputs of the next cells in their cell while an async capture runs', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Button, Output } = Jupyter.widgets;',
          'const out = new Output();',
          'const wait = new Button({ description: "Wait" });',
          'wait.onClick(out.capture(async () => {',
          'console.log("waiting");',
          'await new Promise(() => {});',
          '}));',
          'display(wait);',
          'display(out);',
          'out.capture(async () => {',
          'console.log("polling");',
          'await new Promise(() => {});',
          '})();'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);
      const widget = outputs.locator('.widget-output');
      await outputs.getByRole('button', { name: 'Wait' }).click();
      await expect(widget).toHaveText(/^polling\s+waiting\s*$/);

      // The code of the next cell after an await
      const next = await runCode(
        page,
        [
          'await new Promise(resolve => setTimeout(resolve, 100));',
          'console.log("done");'
        ].join('\n')
      );
      await expect(await getOutputs(page, next)).toHaveText(['done\n']);

      // The interrupt ends the capture of the click: the code running after
      // a cell prints in the cell
      await page.menu.clickMenuItem('Kernel>Interrupt Kernel');
      const later = await runCode(
        page,
        [
          '(async () => {',
          'await new Promise(resolve => setTimeout(resolve, 200));',
          'console.log("later");',
          '})();'
        ].join('\n')
      );
      await expect(await getOutputs(page, later)).toHaveText(['later\n']);
      await expect(widget).toHaveText(/^polling\s+waiting\s*$/);
    });

    test('Show the result of the cell which started an async capture in the cell', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Output } = Jupyter.widgets;',
          'const out = new Output();',
          'display(out);',
          'out.capture(async () => {',
          'console.log("before");',
          'await new Promise(resolve => setTimeout(resolve, 500));',
          'console.log("after");',
          '})();',
          '"result"'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);
      const widget = outputs.locator('.widget-output');
      await expect(widget).toHaveText(/^before\s+after\s*$/);
      // The result is shown in the cell, after the widget
      await expect(await getOutputs(page, index, 'text/plain')).toHaveText(
        "'result'"
      );
      await expect(outputs.last()).toHaveText("'result'");
    });

    test('Clear an Output widget from an async capture after the result of its cell', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Output } = Jupyter.widgets;',
          'const out = new Output();',
          'out.capture(async () => {',
          'console.log("before");',
          'await new Promise(resolve => setTimeout(resolve, 500));',
          'out.clearOutput({ wait: true });',
          'console.log("after");',
          '})();',
          'setTimeout(() => console.log("later"), 1500);',
          'out'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);
      const widget = outputs.locator('.widget-output');
      await expect(widget).toHaveText(/^after\s*$/);
      // The clear went to the widget, not to the cell: the next output of
      // the cell is shown after the widget
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText(['after\n', 'later\n']);
      await expect(widget).toHaveText(/^after\s*$/);
    });

    test('Show the outputs of the timers of an async capture in the Output widget', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Output } = Jupyter.widgets;',
          'const out = new Output();',
          'out.capture(async () => {',
          'console.log("start");',
          'await new Promise(resolve => setTimeout(() => {',
          'console.log("tick");',
          'resolve();',
          '}, 300));',
          'console.log("end");',
          '})();',
          'out'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);
      const widget = outputs.locator('.widget-output');
      await expect(widget).toHaveText(/^start\s+tick\s+end\s*$/);
      // The only stream output is the one of the widget
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveCount(1);
    });

    test('Print the outputs of the widget callbacks in their cell', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Button, IntSlider } = Jupyter.widgets;',
          'const slider = new IntSlider({ value: 5, description: "Level" });',
          'slider.observe(change => console.log(`level ${change.new}`), "value");',
          'const button = new Button({ description: "Hello" });',
          'button.onClick(() => console.log("hello"));',
          'display(button);',
          'slider'
        ].join('\n')
      );
      const later = await runCode(page, 'console.log("later")');
      const outputs = await getOutputs(page, index);

      await outputs.getByRole('button', { name: 'Hello' }).click();
      await outputs.getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText(['hello\nlevel 6\n']);
      await expect(await getOutputs(page, later)).toHaveText(['later\n']);

      // Called by the code of a cell, the callback prints in that cell
      const set = await runCode(page, 'slider.value = 8;');
      await expect(await getOutputs(page, set)).toHaveText(['level 8\n']);
    });

    test('Clear and append to an Output widget', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { Button, Output } = Jupyter.widgets;',
          'const out = new Output();',
          'out.appendStdout("text\\n");',
          'out.appendDisplayData(6 * 7);',
          'out.appendDisplayData(new Button({ description: "Inside" }));',
          'out.appendDisplayData({ "text/html": "<b>bold</b>" });',
          'out'
        ].join('\n')
      );
      const widget = (await getOutputs(page, index)).locator('.widget-output');
      await expect(widget).toContainText('text');
      await expect(widget).toContainText('42');
      await expect(
        widget.getByRole('button', { name: 'Inside' })
      ).toBeVisible();
      await expect(widget.locator('b')).toHaveText('bold');

      // Cleared when the next output arrives
      await runCode(page, 'out.clearOutput({ wait: true });');
      await expect(widget).toContainText('42');
      await runCode(page, 'out.appendStdout("replaced\\n");');
      await expect(widget).toHaveText(/^replaced\s*$/);

      // A button showing only the outputs of its last click
      const counter = await runCode(
        page,
        [
          'let count = 0;',
          'const counter = new Button({ description: "Count" });',
          'counter.onClick(out.capture({ clearOutput: true, wait: true })(() => {',
          'console.log(`count ${++count}`);',
          '}));',
          'counter'
        ].join('\n')
      );
      const button = (await getOutputs(page, counter)).getByRole('button', {
        name: 'Count'
      });
      await button.click();
      await expect(widget).toHaveText(/^count 1\s*$/);
      await button.click();
      await expect(widget).toHaveText(/^count 2\s*$/);
      await runCode(page, 'out.clearOutput();');
      await expect(widget).toHaveText('');

      // Cleared when a captured output arrives
      const note = await runCode(
        page,
        [
          'const note = new Button({ description: "Note" });',
          'note.onClick(out.capture(() => console.log("note")));',
          'out.appendStdout("old\\n");',
          'out.clearOutput({ wait: true });',
          'note'
        ].join('\n')
      );
      await expect(widget).toHaveText(/^old\s*$/);
      await (await getOutputs(page, note))
        .getByRole('button', { name: 'Note' })
        .click();
      await expect(widget).toHaveText(/^note\s*$/);
      await runCode(page, 'out.appendStdout("more\\n");');
      await expect(widget).toHaveText(/^note\s+more\s*$/);
    });

    test('Observe the changes made in the frontend', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { Dropdown, Label, VBox } = Jupyter.widgets;',
          'const fruit = new Dropdown({ options: ["Apple", "Banana", "Cherry"], description: "Fruit" });',
          'const label = new Label({ value: "Nothing selected" });',
          'fruit.observe(change => { label.value = `Selected ${change.new}`; }, "value");',
          'new VBox({ children: [fruit, label] })'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);
      await expect(widget.getByText('Nothing selected')).toBeVisible();

      await widget.getByRole('combobox').selectOption('Banana');
      await expect(widget.getByText('Selected Banana')).toBeVisible();
    });

    test('Link widgets in the frontend', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { IntSlider, IntText, HBox, jslink } = Jupyter.widgets;',
          'const source = new IntSlider({ value: 1, description: "Source" });',
          'const target = new IntText({ value: 1, description: "Target" });',
          'jslink([source, "value"], [target, "value"]);',
          'new HBox({ children: [source, target] })'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);

      const input = widget.getByRole('spinbutton');
      await input.fill('9');
      await input.press('Enter');
      await expect(widget.locator('.widget-readout')).toHaveText('9');

      const cell = await runCode(page, '`${source.value} and ${target.value}`');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual([
        "'9 and 9'"
      ]);
    });

    test('Show widgets in containers', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { Tab, IntSlider, Text } = Jupyter.widgets;',
          'new Tab({',
          'children: [new IntSlider({ value: 3 }), new Text({ value: "second page" })],',
          'titles: ["Slider", "Text"]',
          '})'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);

      await expect(widget.locator('.widget-slider')).toBeVisible();
      await widget.getByRole('tab', { name: 'Text' }).click();
      await expect(widget.getByRole('textbox')).toHaveValue('second page');
      await expect(widget.locator('.widget-slider')).toBeHidden();
    });

    test('Show images from their bytes', async ({ page }) => {
      // A red PNG image of 3x2 pixels
      const index = await runCode(
        page,
        [
          'const { Image } = Jupyter.widgets;',
          'const png = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==";',
          'const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));',
          'const image = new Image({ value: bytes, format: "png", width: "60" });',
          'image'
        ].join('\n')
      );
      const img = (await getOutputs(page, index)).getByRole('img');
      const naturalWidth = () =>
        img.evaluate(element => (element as HTMLImageElement).naturalWidth);

      await expect(img).toHaveAttribute('width', '60');
      await expect.poll(naturalWidth).toBe(3);

      // New bytes are sent to the frontend
      await runCode(
        page,
        [
          'const svg = \'<svg xmlns="http://www.w3.org/2000/svg" width="5" height="4"><rect width="5" height="4" fill="blue"/></svg>\';',
          'image.format = "svg+xml";',
          'image.value = new TextEncoder().encode(svg);'
        ].join('\n')
      );
      await expect.poll(naturalWidth).toBe(5);
    });

    test('Select the options by value, with labelled options', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Dropdown } = Jupyter.widgets;',
          'const d = new Dropdown({ options: [["One", 1], ["Two", 2]], value: 2, description: "Number" });',
          'd.observe(change => console.log(`value ${change.new}`), "value");',
          'd'
        ].join('\n')
      );
      const combobox = (await getOutputs(page, index)).getByRole('combobox');
      await expect(combobox).toHaveValue('Two');
      let cell = await runCode(page, 'd.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['2']);

      // The value of the option chosen in the frontend
      await combobox.selectOption('One');
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText('value 1\n');
      cell = await runCode(page, 'd.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['1']);

      // The selected value is kept when the options change
      cell = await runCode(
        page,
        'd.options = { Zero: 0, Uno: 1, Three: 3 };\n`${d.label} ${d.value}`'
      );
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(["'Uno 1'"]);
      await expect(combobox).toHaveValue('Uno');
      cell = await runCode(page, 'd.value = 5;');
      await expect(
        await getOutputs(page, cell, 'application/vnd.jupyter.stderr')
      ).toContainText('RangeError: Invalid selection: value not found');

      // An option given as undefined is left out
      cell = await runCode(
        page,
        'new Dropdown({ options: ["A", "B"], index: undefined }).value'
      );
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(["'A'"]);

      // A range of two options, the lower one first
      cell = await runCode(
        page,
        [
          'const { SelectionRangeSlider } = Jupyter.widgets;',
          'const range = new SelectionRangeSlider({ options: ["A", "B", "C"], value: ["A", "C"] });',
          'range.options = ["C", "B", "A"];',
          '`${range.index}`'
        ].join('\n')
      );
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(["'0,2'"]);
      cell = await runCode(page, 'range.value = ["B"];');
      await expect(
        await getOutputs(page, cell, 'application/vnd.jupyter.stderr')
      ).toContainText(
        'RangeError: Invalid selection: index must have two values'
      );

      // Values which are not JSON, like a cyclic object or a bigint
      const radio = await runCode(
        page,
        [
          'const { RadioButtons } = Jupyter.widgets;',
          'const cyclic = { name: "cyclic" };',
          'cyclic.self = cyclic;',
          'const r = new RadioButtons({ options: { Cyclic: cyclic, Big: 10n } });',
          'r.observe(change => console.log(`picked ${change.new === cyclic ? "cyclic" : change.new}`), "value");',
          'r'
        ].join('\n')
      );
      const radios = await getOutputs(page, radio);
      await radios.getByRole('radio', { name: 'Big' }).check();
      await radios.getByRole('radio', { name: 'Cyclic' }).check();
      await expect(
        await getOutputs(page, radio, 'application/vnd.jupyter.stdout')
      ).toHaveText('picked 10\npicked cyclic\n');
    });

    test('Style and lay out the widgets with plain objects', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Button } = Jupyter.widgets;',
          'const b = new Button({ description: "Go", style: { button_color: "rgb(255, 0, 0)" } });',
          'b.layout.width = "200px";',
          'b'
        ].join('\n')
      );
      const button = (await getOutputs(page, index)).getByRole('button', {
        name: 'Go'
      });
      await expect(button).toHaveCSS('width', '200px');
      await expect(button).toHaveCSS('background-color', 'rgb(255, 0, 0)');

      await runCode(
        page,
        [
          'b.tooltip = "hint";',
          'b.style.button_color = "rgb(0, 128, 0)";',
          'b.layout = { width: "120px", border: "3px solid rgb(0, 0, 255)" };',
          'b.addClass("my-button");'
        ].join('\n')
      );
      await expect(button).toHaveAttribute('title', 'hint');
      await expect(button).toHaveCSS('background-color', 'rgb(0, 128, 0)');
      await expect(button).toHaveCSS('width', '120px');
      await expect(button).toHaveCSS('border-left-width', '3px');
      await expect(button).toHaveClass(/my-button/);

      // A description as wide as its text
      const slider = await runCode(
        page,
        [
          'const { IntSlider } = Jupyter.widgets;',
          'const s = new IntSlider({ description: "A long description" });',
          's.style.description_width = "initial";',
          's'
        ].join('\n')
      );
      const label = (await getOutputs(page, slider)).getByText(
        'A long description'
      );
      await expect(label).toBeVisible();
      await expect
        .poll(() =>
          label.evaluate(element => element.scrollWidth <= element.clientWidth)
        )
        .toBe(true);
      const cell = await runCode(
        page,
        '`${s.layout instanceof Jupyter.widgets.Layout} ${s.style instanceof Jupyter.widgets.SliderStyle}`'
      );
      expect(await page.notebook.getCellTextOutput(cell)).toEqual([
        "'true true'"
      ]);
    });

    test('Keep the numeric values in their bounds', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { HBox, IntSlider } = Jupyter.widgets;',
          'const s = new IntSlider({ value: 150, description: "Clamped" });',
          'const t = new IntSlider({ value: 150, max: 200, description: "Fits" });',
          'new HBox({ children: [s, t] })'
        ].join('\n')
      );
      const readouts = (await getOutputs(page, index)).locator(
        '.widget-readout'
      );
      await expect(readouts).toHaveText(['100', '150']);
      let cell = await runCode(page, 's.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['100']);

      // Lowering the max lowers the value
      cell = await runCode(page, 's.max = 10;\ns.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['10']);
      await expect(readouts).toHaveText(['10', '150']);

      // Integers are rounded, and the bounds checked
      cell = await runCode(page, 's.value = 3.7;\ns.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['4']);
      await expect(readouts).toHaveText(['4', '150']);
      cell = await runCode(page, 's.min = 20;');
      await expect(
        await getOutputs(page, cell, 'application/vnd.jupyter.stderr')
      ).toContainText('RangeError: setting min > max');
      cell = await runCode(
        page,
        'new Jupyter.widgets.IntRangeSlider({ value: [8, 3] })'
      );
      await expect(
        await getOutputs(page, cell, 'application/vnd.jupyter.stderr')
      ).toContainText('RangeError: setting lower > upper');

      // A bound given as undefined keeps its default
      cell = await runCode(
        page,
        'new IntSlider({ value: 5, max: undefined }).max'
      );
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['100']);
    });

    test('Pass the button to its click handlers, and the custom messages to onMsg', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Button } = Jupyter.widgets;',
          'const button = new Button({ description: "Click me" });',
          'button.onClick(b => { b.description = "Clicked"; });',
          'button.onMsg(content => console.log(`message ${content.event}`));',
          'button'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);
      await outputs.getByRole('button', { name: 'Click me' }).click();
      await expect(
        outputs.getByRole('button', { name: 'Clicked' })
      ).toBeVisible();
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText('message click\n');
    });

    test('Give the values of the frontend to the cells as their own objects', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { Button, IntRangeSlider } = Jupyter.widgets;',
          'const button = new Button({ description: "Click me" });',
          'button.onMsg(content => console.log(`plain object ${content.constructor === Object}`));',
          'const range = new IntRangeSlider({ value: [2, 5], max: 10, description: "Range" });',
          'display(button);',
          'range'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);
      await outputs.getByRole('button', { name: 'Click me' }).click();
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText('plain object true\n');

      // The pair of values the user picked is an array of the cells
      await outputs.getByRole('slider').last().click();
      await page.keyboard.press('ArrowRight');
      await expect(outputs.locator('.widget-readout')).toContainText('6');
      const cell = await runCode(
        page,
        '`${range.value} ${range.value instanceof Array}`'
      );
      expect(await page.notebook.getCellTextOutput(cell)).toEqual([
        "'2,6 true'"
      ]);
    });

    test('Close the widgets and the links once', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { IntSlider, IntText, HBox, jslink } = Jupyter.widgets;',
          'const source = new IntSlider({ value: 1, description: "Source" });',
          'const target = new IntText({ value: 1, description: "Target" });',
          'const link = jslink([source, "value"], [target, "value"]);',
          'link.on("close", () => console.log("unlinked"));',
          'source.on("close", () => console.log("closed"));',
          'new HBox({ children: [source, target] })'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);
      let cell = await runCode(page, 'link.unlink();\nlink.unlink();');
      await expect(
        await getOutputs(page, cell, 'application/vnd.jupyter.stdout')
      ).toHaveText('unlinked\n');

      // The target does not change the source anymore
      const input = widget.getByRole('spinbutton');
      await input.fill('9');
      await input.press('Enter');
      await expect(widget.locator('.widget-readout')).toHaveText('1');

      cell = await runCode(
        page,
        'source.close();\nsource.close();\nsource.value = 5;'
      );
      await expect(
        await getOutputs(page, cell, 'application/vnd.jupyter.stdout')
      ).toHaveText('closed\n');
    });

    test('Upload files to the kernel with a FileUpload', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { FileUpload } = Jupyter.widgets;',
          'const up = new FileUpload({ accept: ".csv" });',
          'up.observe(({ new: files }) => console.log(`Uploaded ${files.map(file => file.name)}`), "value");',
          'up'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);
      const button = widget.getByRole('button', { name: 'Upload (0)' });

      // Pick a CSV file with the button
      const chooser = page.waitForEvent('filechooser');
      await button.click();
      await (
        await chooser
      ).setFiles({
        name: 'data.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('city,people\nParis,2100000\n')
      });
      await expect(
        widget.getByRole('button', { name: 'Upload (1)' })
      ).toBeVisible();
      await expect(
        await getOutputs(page, index, 'application/vnd.jupyter.stdout')
      ).toHaveText('Uploaded data.csv\n');

      // The kernel has its name, type, size, date and bytes
      let cell = await runCode(
        page,
        [
          'const [file] = up.value;',
          'console.log(new TextDecoder().decode(file.content));',
          'console.log(file.name, file.type, file.size, file.content instanceof Uint8Array, file.last_modified instanceof Date);'
        ].join('\n')
      );
      await expect(
        await getOutputs(page, cell, 'application/vnd.jupyter.stdout')
      ).toHaveText(
        'city,people\nParis,2100000\n\ndata.csv text/csv 26 true true\n'
      );

      // The kernel can forget the files
      cell = await runCode(page, 'up.value = [];');
      await expect(
        widget.getByRole('button', { name: 'Upload (0)' })
      ).toBeVisible();
    });

    test.describe('Away from UTC', () => {
      // A time zone with a half-hour offset, so that a mix-up of the UTC and
      // local fields of the dates shows
      test.use({ timezoneId: 'Asia/Kolkata' });

      test('Pick dates and times', async ({ page }) => {
        const index = await runCode(
          page,
          [
            'const { DatePicker, DatetimePicker, NaiveDatetimePicker, TimePicker, VBox } = Jupyter.widgets;',
            'const day = new DatePicker({ value: new Date("2024-05-01"), description: "Day" });',
            'const time = new TimePicker({ value: "09:30", description: "Time" });',
            'const meeting = new DatetimePicker({ value: new Date("2024-05-01T09:30:00Z"), description: "Meeting" });',
            'const naive = new NaiveDatetimePicker({ value: new Date("2024-05-01T09:30"), description: "Naive" });',
            'new VBox({ children: [day, time, meeting, naive] })'
          ].join('\n')
        );
        const widget = await getOutputs(page, index);
        const dayInput = widget.locator('input[type="date"]');
        const timeInput = widget.locator('input[type="time"]');
        // The pickers of a date and a time show the local time
        const meetingInput = widget.getByLabel('Meeting');
        const naiveInput = widget.getByLabel('Naive');
        await expect(dayInput).toHaveValue('2024-05-01');
        await expect(timeInput).toHaveValue('09:30');
        await expect(meetingInput).toHaveValue('2024-05-01T15:00');
        await expect(naiveInput).toHaveValue('2024-05-01T09:30');

        // From the frontend to the kernel
        await dayInput.fill('2024-06-15');
        await timeInput.fill('14:45');
        await meetingInput.fill('2024-06-15T14:45');
        await naiveInput.fill('2024-06-15T08:00');
        let cell = await runCode(
          page,
          '`${day.value.toISOString().slice(0, 10)} ${day.value instanceof Date} ${time.value}`'
        );
        expect(await page.notebook.getCellTextOutput(cell)).toEqual([
          "'2024-06-15 true 14:45'"
        ]);
        cell = await runCode(
          page,
          '`${meeting.value.toISOString()} ${naive.value.toISOString()} ${naive.value.getHours()}`'
        );
        expect(await page.notebook.getCellTextOutput(cell)).toEqual([
          "'2024-06-15T09:15:00.000Z 2024-06-15T02:30:00.000Z 8'"
        ]);

        // From the kernel to the frontend, kept in the bounds
        await runCode(
          page,
          [
            'day.value = "2025-01-02";',
            'time.value = "18:05:30";',
            'meeting.value = "2025-01-02T18:00:00Z";',
            'naive.value = new Date(2025, 0, 2, 7, 5);'
          ].join('\n')
        );
        await expect(dayInput).toHaveValue('2025-01-02');
        await expect(timeInput).toHaveValue('18:05:30');
        await expect(meetingInput).toHaveValue('2025-01-02T23:30');
        await expect(naiveInput).toHaveValue('2025-01-02T07:05');
        cell = await runCode(
          page,
          'day.min = new Date("2025-02-01");\nday.value.toISOString().slice(0, 10)'
        );
        expect(await page.notebook.getCellTextOutput(cell)).toEqual([
          "'2025-02-01'"
        ]);
        await expect(dayInput).toHaveValue('2025-02-01');
      });
    });

    test('Add tags in a TagsInput', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { TagsInput } = Jupyter.widgets;',
          'const tags = new TagsInput({ value: ["red"] });',
          'tags'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);
      // The input of the new tags is styled like a tag
      const tag = widget.locator('.jupyter-widget-tag:not(input)');
      await expect(tag).toHaveText(['red']);

      // Type a tag, and leave the input with Tab: Chromium does not commit
      // the inputs with suggestions, like this one, with Enter
      await widget.locator('.jupyter-widget-tagsinput').click();
      const input = widget.locator('input.jupyter-widget-taginput');
      await input.pressSequentially('green');
      await input.press('Tab');
      await expect(tag).toHaveText(['red', 'green']);
      let cell = await runCode(page, 'tags.value.join(", ")');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual([
        "'red, green'"
      ]);

      // From the kernel to the frontend, with the allowed tags only
      await runCode(page, 'tags.value = ["blue"];');
      await expect(tag).toHaveText(['blue']);
      cell = await runCode(
        page,
        'tags.allowed_tags = ["red", "green", "blue"];\ntags.value = ["pink"];'
      );
      await expect(
        await getOutputs(page, cell, 'application/vnd.jupyter.stderr')
      ).toContainText('Tag value pink is not allowed');
    });

    test('Add numbers and colors in their tags inputs', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { ColorsInput, FloatsInput, IntsInput, VBox } = Jupyter.widgets;',
          'const ints = new IntsInput({ value: [1, 2], max: 10 });',
          'const floats = new FloatsInput({ value: ["1.5", 2] });',
          'const colors = new ColorsInput({ value: ["red", "#00ff00"] });',
          'new VBox({ children: [ints, floats, colors] })'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);
      const intsInput = widget.locator('.jupyter-widget-tagsinput').nth(0);
      const intTags = intsInput.locator('.jupyter-widget-tag:not(input)');
      // The numbers are shown in their format, and the strings are numbers
      await expect(intTags).toHaveText(['1', '2']);
      await expect(
        widget
          .locator('.jupyter-widget-tagsinput')
          .nth(1)
          .locator('.jupyter-widget-tag:not(input)')
      ).toHaveText(['1.5', '2.0']);
      await expect(widget.locator('.jupyter-widget-colortag')).toHaveCount(2);
      let cell = await runCode(page, 'floats.value.map(v => v * 2).join(", ")');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(["'3, 4'"]);

      // Type a number
      await intsInput.click();
      const input = intsInput.locator('input.jupyter-widget-taginput');
      await input.pressSequentially('7');
      await input.press('Tab');
      await expect(intTags).toHaveText(['1', '2', '7']);
      cell = await runCode(page, 'ints.value.reduce((a, b) => a + b)');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['10']);

      // The numbers are kept in their bounds
      cell = await runCode(page, 'ints.value = [11];');
      await expect(
        await getOutputs(page, cell, 'application/vnd.jupyter.stderr')
      ).toContainText('RangeError: Tag value 11 should be <= 10');
      await expect(intTags).toHaveText(['1', '2', '7']);
    });

    test('Play audio from its bytes, and show videos and images from their URL', async ({
      page
    }) => {
      // Half a second of silence, in a WAV file of 8-bit samples at 8 kHz
      const index = await runCode(
        page,
        [
          'const { Audio, Image, Video, VBox } = Jupyter.widgets;',
          'const wav = new Uint8Array(44 + 4000);',
          'const view = new DataView(wav.buffer);',
          'const text = (offset, s) => [...s].forEach((c, i) => { wav[offset + i] = c.charCodeAt(0); });',
          'text(0, "RIFF"); view.setUint32(4, 36 + 4000, true); text(8, "WAVE");',
          'text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);',
          'view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);',
          'text(36, "data"); view.setUint32(40, 4000, true); wav.fill(128, 44);',
          'const audio = new Audio({ value: wav, format: "wav", autoplay: false });',
          'const video = Video.fromUrl("https://example.com/clip.mp4", { autoplay: false, loop: false });',
          'const image = Image.fromUrl("https://example.com/cat.png", { width: "80" });',
          'new VBox({ children: [audio, video, image] })'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);
      const player = widget.locator('audio');
      await expect(player).toHaveAttribute('controls', '');
      await expect
        .poll(() =>
          player.evaluate(element => (element as HTMLAudioElement).duration)
        )
        .toBe(0.5);
      const movie = widget.locator('video');
      await expect(movie).toHaveAttribute(
        'src',
        'https://example.com/clip.mp4'
      );
      await expect(movie).not.toHaveAttribute('loop');
      const picture = widget.locator('img');
      await expect(picture).toHaveAttribute(
        'src',
        'https://example.com/cat.png'
      );
      await expect(picture).toHaveAttribute('width', '80');

      const cell = await runCode(
        page,
        '`${audio.value === wav} ${video.format} ${video.autoplay} ${new TextDecoder().decode(image.value)}`'
      );
      expect(await page.notebook.getCellTextOutput(cell)).toEqual([
        "'true url false https://example.com/cat.png'"
      ]);
    });

    test('Make controls for a function with interact', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { interact } = Jupyter.widgets;',
          "interact(({ n, name }) => `${name}: ${'*'.repeat(n)}`, { n: [0, 10], name: 'stars' })"
        ].join('\n')
      );
      const widget = await getOutputs(page, index);
      const slider = widget.getByRole('slider');
      const readout = widget.locator('.widget-readout');
      const textbox = widget.getByRole('textbox');
      const output = widget.locator('.widget-output');
      await expect(widget.getByText('n', { exact: true })).toBeVisible();
      await expect(widget.getByText('name', { exact: true })).toBeVisible();
      await expect(readout).toHaveText('5');
      await expect(textbox).toHaveValue('stars');
      await expect(output).toHaveText("'stars: *****'");

      // Drag the slider with the mouse: the output follows
      const box = (await slider.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 200, y, { steps: 10 });
      await page.mouse.up();
      await expect(readout).toHaveText('10');
      await expect(output).toHaveText("'stars: **********'");

      // With the keyboard
      await slider.click();
      await page.keyboard.press('ArrowLeft');
      await expect(output).toHaveText("'stars: *********'");

      // Type in the text box: the outputs of a run replace the previous ones
      await textbox.fill('');
      await textbox.pressSequentially('moons');
      await expect(output).toHaveText("'moons: *********'");
      await expect(output.locator('.jp-OutputArea-output')).toHaveCount(1);

      const cell = await runCode(page, '_.result');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual([
        "'moons: *********'"
      ]);
    });

    test('Run the function of interact.manual with its button', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { interact } = Jupyter.widgets;',
          'let runs = 0;',
          'interact.manual(({ x }) => { runs += 1; return x * 2; }, { x: [0, 10] }, { manual_name: "Double" })'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);
      const output = widget.locator('.widget-output');
      const button = widget.getByRole('button', { name: 'Double' });
      await expect(button).toBeVisible();
      await expect(widget.locator('.widget-readout')).toHaveText('5');
      await expect(output).toHaveText('');

      // Nothing runs until the button is clicked
      await widget.getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await expect(widget.locator('.widget-readout')).toHaveText('6');
      let cell = await runCode(page, 'runs');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['0']);
      await expect(output).toHaveText('');

      await button.click();
      await expect(output).toHaveText('12');
      await widget.getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await expect(widget.locator('.widget-readout')).toHaveText('7');
      cell = await runCode(page, 'runs');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['1']);
      await expect(output).toHaveText('12');
      await button.click();
      await expect(output).toHaveText('14');
    });

    test('Show the outputs, results and errors of interactive functions', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { interactive, fixed } = Jupyter.widgets;',
          'const w = interactive(async ({ loud, word, times }) => {',
          'console.log(`${word} ${times} times`);',
          'await new Promise(resolve => setTimeout(resolve, 10));',
          'if (loud) throw new Error("too loud");',
          'return word.repeat(times);',
          '}, { loud: false, word: [["Hi", "hi"], ["Hello", "hello"]], times: fixed(2) });',
          'w'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);
      const output = widget.locator('.widget-output');
      // interactive() does not show the result, and the fixed value has no
      // control
      await expect(output).toHaveText('hi 2 times');
      await expect(widget.getByRole('checkbox')).not.toBeChecked();
      await expect(widget.getByRole('combobox')).toHaveValue('Hi');
      await expect(widget.getByText('word', { exact: true })).toBeVisible();
      await expect(widget.getByText('times', { exact: true })).toHaveCount(0);
      let cell = await runCode(page, 'w.result');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(["'hihi'"]);

      // The result of an async function is awaited, and the outputs of a
      // run replace the previous ones
      await widget.getByRole('combobox').selectOption('Hello');
      await expect(output).toHaveText('hello 2 times');
      await expect(output.locator('.jp-OutputArea-output')).toHaveCount(1);
      cell = await runCode(page, '`${w.result} ${w.kwargs.word}`');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual([
        "'hellohello hello'"
      ]);

      // The errors go to the Output widget
      await widget.getByRole('checkbox').check();
      await expect(output).toContainText(
        'Uncaught (in promise) Error: too loud'
      );
      await expect(output).toContainText('hello 2 times');
    });

    test('Run a function with existing controls with interactive_output', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { interactive_output, HBox, IntSlider, VBox } = Jupyter.widgets;',
          'const a = new IntSlider({ value: 2, max: 10, description: "a" });',
          'const b = new IntSlider({ value: 3, max: 10, description: "b" });',
          'const out = interactive_output(({ a, b }) => console.log(`${a} + ${b} = ${a + b}`), { a, b });',
          'new VBox({ children: [new HBox({ children: [a, b] }), out] })'
        ].join('\n')
      );
      const widget = await getOutputs(page, index);
      const output = widget.locator('.widget-output');
      await expect(output).toHaveText('2 + 3 = 5');
      await widget.getByRole('slider').first().click();
      await page.keyboard.press('ArrowRight');
      await expect(output).toHaveText('3 + 3 = 6');
    });

    test('Link the values of widgets in the kernel, with transforms', async ({
      page
    }) => {
      const index = await runCode(
        page,
        [
          'const { FloatSlider, FloatText, IntSlider, dlink, link } = Jupyter.widgets;',
          'const a = new IntSlider({ description: "a" });',
          'const b = new FloatText({ description: "b" });',
          'dlink([a, "value"], [b, "value"], v => v / 10);',
          'const c = new FloatSlider({ value: 20, max: 200, description: "Celsius" });',
          'const f = new FloatText({ description: "Fahrenheit" });',
          'const temperature = link([c, "value"], [f, "value"], [v => v * 9 / 5 + 32, v => (v - 32) * 5 / 9]);',
          'display(a);',
          'display(b);',
          'display(c);',
          'display(f);'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);
      const b = outputs.nth(1).getByRole('spinbutton');
      const celsius = outputs.nth(2).locator('.widget-readout');
      const fahrenheit = outputs.nth(3).getByRole('spinbutton');
      await expect(b).toHaveValue('0');
      await expect(fahrenheit).toHaveValue('68');

      // From the source to the target only
      await outputs.nth(0).getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await expect(b).toHaveValue('0.2');
      await b.fill('5');
      await b.press('Enter');
      let cell = await runCode(page, '`${a.value} ${b.value}`');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(["'2 5'"]);
      await expect(outputs.nth(0).locator('.widget-readout')).toHaveText('2');

      // Both ways
      await fahrenheit.fill('212');
      await fahrenheit.press('Enter');
      await expect(celsius).toHaveText('100.00');
      await runCode(page, 'temperature.unlink();');
      await fahrenheit.fill('32');
      await fahrenheit.press('Enter');
      await expect(fahrenheit).toHaveValue('32');
      cell = await runCode(page, 'c.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['100']);
    });

    test('Wait for the changes of the widgets', async ({ page }) => {
      const index = await runCode(
        page,
        [
          'const { Button, IntSlider } = Jupyter.widgets;',
          'const a = new IntSlider({ description: "a" });',
          'const done = new Button({ description: "Done" });',
          'display(a);',
          'display(done);'
        ].join('\n')
      );
      const outputs = await getOutputs(page, index);

      // A change made by the kernel while the cell waits
      let cell = await runCode(
        page,
        'setTimeout(() => { a.value = 7; }, 100);\nawait a.changed()'
      );
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['7']);
      await expect(outputs.nth(0).locator('.widget-readout')).toHaveText('7');

      // The changes made by the user, after the cell
      cell = await runCode(
        page,
        [
          'a.changed().then(v => console.log("got", v));',
          'done.clicked().then(() => console.log("clicked"));',
          '(async () => {',
          'for await (const v of a.changes()) {',
          'console.log("value", v);',
          'if (v >= 9) break;',
          '}',
          'console.log("done");',
          '})();'
        ].join('\n')
      );
      const stdout = await getOutputs(
        page,
        cell,
        'application/vnd.jupyter.stdout'
      );
      // One value at a time: the slider sends the last one of quick changes
      await outputs.nth(0).getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await expect(stdout).toHaveText('got 8\nvalue 8\n');
      await page.keyboard.press('ArrowRight');
      await expect(stdout).toHaveText('got 8\nvalue 8\nvalue 9\ndone\n');
      await page.keyboard.press('ArrowRight');
      await expect(outputs.nth(0).locator('.widget-readout')).toHaveText('10');
      await outputs.nth(1).getByRole('button', { name: 'Done' }).click();
      await outputs.nth(1).getByRole('button', { name: 'Done' }).click();
      await expect(stdout).toHaveText(
        'got 8\nvalue 8\nvalue 9\ndone\nclicked\n'
      );
    });

    test('Show the widgets again when the notebook is reopened', async ({
      page
    }) => {
      // A red PNG image of 3x2 pixels, sent to the frontend as a buffer
      const index = await runCode(
        page,
        [
          'const { DatePicker, HBox, Image, IntSlider } = Jupyter.widgets;',
          'const png = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==";',
          'const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));',
          'const slider = new IntSlider({ value: 5, max: 10, description: "Level" });',
          'const image = new Image({ value: bytes, format: "png", width: "60" });',
          'const day = new DatePicker({ value: new Date("2024-05-01") });',
          'new HBox({ children: [slider, image, day] })'
        ].join('\n')
      );
      let widget = await getOutputs(page, index);
      await widget.getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await expect(widget.locator('.widget-readout')).toHaveText('6');

      // Save, close the tab, and open the notebook again: the kernel keeps
      // running, with its widgets
      const notebook = 'Widgets.ipynb';
      await page.menu.clickMenuItem('File>Save Notebook');
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox').fill(notebook);
      await dialog.getByRole('button', { name: 'Rename and Save' }).click();
      const tab = page.activity.getTabLocator(notebook);
      await expect(tab).not.toHaveClass(/jp-mod-dirty/);
      await page.menu.clickMenuItem('File>Close Tab');
      await expect(tab).toHaveCount(0);
      await page.filebrowser.open(notebook);
      await waitForKernelIdle(page, kernel);

      widget = await getOutputs(page, index);
      const readout = widget.locator('.widget-readout');
      await expect(widget.getByText('Level')).toBeVisible();
      await expect(readout).toHaveText('6');
      const img = widget.getByRole('img');
      await expect(img).toHaveAttribute('width', '60');
      await expect
        .poll(() =>
          img.evaluate(element => (element as HTMLImageElement).naturalWidth)
        )
        .toBe(3);
      await expect(widget.locator('input[type="date"]')).toHaveValue(
        '2024-05-01'
      );

      // The slider still drives the value in the kernel, and the other way
      await widget.getByRole('slider').click();
      await page.keyboard.press('ArrowRight');
      await expect(readout).toHaveText('7');
      const cell = await runCode(page, 'slider.value');
      expect(await page.notebook.getCellTextOutput(cell)).toEqual(['7']);
      await runCode(page, 'slider.value = 2;');
      await expect(readout).toHaveText('2');
    });
  });
}
