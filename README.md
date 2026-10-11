# jupyterlite-javascript-kernel

[![Github Actions Status](https://github.com/jupyterlite/javascript-kernel/workflows/Build/badge.svg)](https://github.com/jupyterlite/javascript-kernel/actions/workflows/build.yml)
[![lite-badge](https://jupyterlite.rtfd.io/en/latest/_static/badge.svg)](https://jupyterlite.github.io/javascript-kernel/lab/index.html)

A JavaScript kernel for JupyterLite.

![a screenshot showing a notebook with the JavaScript kernel in JupyterLite](https://github.com/jupyterlite/javascript-kernel/assets/591645/c9085a6e-452e-4f77-8553-36133ee32389)

## Requirements

- JupyterLite >=0.3.0

This kernel was originally maintained as part of the main JupyterLite repository, and was moved to its own repository for the JupyterLite 0.3.0 release.

## Install

To install the extension, execute:

```bash
pip install jupyterlite-javascript-kernel
```

## Uninstall

To remove the extension, execute:

```bash
pip uninstall jupyterlite-javascript-kernel
```

## Runtime modes

The extension currently registers two JavaScript kernelspecs:

- `JavaScript (IFrame)`:
  Runs code in a hidden runtime `iframe` on the main page thread. Use this when your code needs browser DOM APIs like `document`, `window`, or canvas access through the page context.
- `JavaScript (Web Worker)`:
  Runs code in a dedicated Web Worker. Use this for stronger isolation and to avoid blocking the main UI thread.

Pick either kernel from the notebook kernel selector in JupyterLite.

### Kernel information

The kernel banner shows the version of the kernel and the runtime it uses, for
example `JavaScript kernel 0.4.0 for JupyterLite (Web Worker runtime)`. It is
shown at the top of consoles, and in the dialog opened from **Help > About the
JavaScript (IFrame) Kernel** or **Help > About the JavaScript (Web Worker)
Kernel**.

The language version in the kernel info, saved in the `language_info` of the
notebook metadata, is the ECMAScript edition that the kernel parses, like
`ES2026`. The browser decides which built-in APIs exist.

While a JavaScript notebook or console is active, the **Help** menu also links
to the MDN JavaScript Reference, the MDN Web APIs and this README.

### Kernel startup extensions

Frontend extensions can register startup work that runs before user code in
both runtime modes. Use this to preload runtime modules and register comm
targets without sending bootstrap code through `requestExecute`.

```typescript
import type { JupyterFrontEndPlugin } from '@jupyterlab/application';
import { IJavaScriptKernelStartupRegistry } from '@jupyterlite/javascript-kernel';

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'my-extension:javascript-startup',
  autoStart: true,
  requires: [IJavaScriptKernelStartupRegistry],
  activate: (app, startup) => {
    const runtimeBootstrap = new URL(
      './runtime-bootstrap.js',
      import.meta.url
    ).toString();
    const lspCommTarget = new URL(
      './lsp-comm-target.js',
      import.meta.url
    ).toString();

    startup.registerStartupExtension({
      id: 'my-extension:lsp',
      activate: async context => {
        await context.preloadModule(runtimeBootstrap);
        await context.registerCommTarget({
          targetName: 'my-extension:lsp',
          module: lspCommTarget,
          exportName: 'registerLspTarget'
        });
      },
      deactivate: async context => {
        await context.unregisterCommTarget('my-extension:lsp');
      }
    });
  }
};
```

`context.registerCommTarget()` imports the module in the kernel runtime and
passes the exported handler to `Jupyter.comm.registerTarget(targetName,
handler)`. The default export is used when `exportName` is omitted. Disposing
a startup registration calls its optional `deactivate` callback for active
kernels.

### Worker mode limitations

Web Workers do not expose DOM APIs. In `JavaScript (Web Worker)`, APIs such as `document`, direct element access, and other main-thread-only browser APIs are unavailable.

### Import side effects in iframe mode

In `JavaScript (IFrame)`, user code and imports execute in the runtime iframe scope.

By default, module-level side effects stay in the runtime iframe. To intentionally affect the main page (`window.parent`), access it directly.

Cell declarations like `var`, `let`, `const`, `function`, and `class` remain in the runtime scope. Host-page mutations happen when your code (or imported code) explicitly reaches `window.parent`.

#### Example: canvas-confetti

```javascript
import confetti from 'canvas-confetti';

const canvas = window.parent.document.createElement('canvas');
Object.assign(canvas.style, {
  position: 'fixed',
  inset: '0',
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
  zIndex: '2147483647'
});
window.parent.document.body.appendChild(canvas);

const fire = confetti.create(canvas, { resize: true, useWorker: true });

fire({ particleCount: 20, spread: 70 });
```

#### Example: p5.js

```javascript
import p5 from 'p5';

const mount = window.parent.document.createElement('div');
Object.assign(mount.style, {
  position: 'fixed',
  right: '16px',
  bottom: '16px',
  zIndex: '1000'
});
window.parent.document.body.appendChild(mount);

const sketch = new p5(p => {
  p.setup = () => {
    p.createCanvas(120, 80);
    p.noLoop();
  };
}, mount);
```

#### Can side effects be auto-detected and cleaned up?

Partially, yes, but not perfectly. This project currently does not provide automatic side-effect cleanup for host-page mutations.

Limits of automatic cleanup:

- It will not reliably undo monkey-patched globals.
- It will not automatically remove all event listeners or timers.
- It cannot safely revert all stateful third-party module internals.

## Rich output

The last expression of a cell is shown as its result. The values are printed like with `util.inspect` in Node.js, and the data with a JSON representation, like objects and arrays, is also shown as an interactive tree.

`display(value, options)` shows values in the middle of a cell. With the `id` option (`true` to generate one), it returns a handle to update the output later, also from other cells:

```javascript
const task = display.text('Starting...', { id: true });
await new Promise(resolve => setTimeout(resolve, 1000));
task.update('Done!');
```

The `metadata` option sets the metadata of the output. `handle.display(value)` shows a new output, updated together with the other outputs of the handle.

The helpers of `display` show content for the common MIME types:

- `display.html`, `display.markdown`, `display.svg`, `display.latex` and `display.text` take a string, or are used as tagged templates: ``display.markdown`**${name}**` ``
- `display.json(value)` shows an interactive JSON tree
- `display.png(bytes, { width, height })` and `display.jpeg(...)` show images, from their bytes or base64
- `display.mime(bundle)` shows a MIME bundle, like `{ 'text/html': '<b>Hi</b>', 'text/plain': 'Hi' }`

`clearOutput(wait)` clears the outputs of the cell. With `wait` set to `true`, they are cleared when the next output arrives, to avoid flickering.

Objects can define their own representation, with a `[Symbol.for('Jupyter.display')]()` or `_toMime()` method returning a MIME bundle, or with the `_toHtml()`, `_toMarkdown()`, `_toSvg()`, `_toPng()`, `_toJpeg()`, `_toLatex()` and `_toJson()` methods:

```javascript
class Temperature {
  constructor(celsius) {
    this.celsius = celsius;
  }

  [Symbol.for('Jupyter.display')]() {
    return {
      'text/html': `<b>${this.celsius} °C</b>`,
      'text/plain': `${this.celsius} °C`
    };
  }
}

new Temperature(21);
```

> **Note:** the second argument of `display()` used to be the metadata of the output. It is now an object of options, with the metadata under `metadata`.

## Console

The `console` methods print to the outputs of the cell, with the values formatted like in Node.js:

- `console.log`, `console.info` and `console.debug` print to the standard output, `console.error`, `console.warn` and `console.trace` to the standard error
- the format specifiers `%s`, `%d`, `%i`, `%f`, `%j`, `%o`, `%O` and `%c` are replaced, like `console.log('%s is %d', 'answer', 42)`
- `console.table` shows a table, `console.dir` an object with options like `{ depth }`
- `console.group`, `console.groupCollapsed` and `console.groupEnd` indent the messages
- `console.count`, `console.countReset`, `console.time`, `console.timeLog`, `console.timeEnd` and `console.assert` work like in the browser
- `console.clear` clears the outputs of the cell

## Errors

An error shows where it happened in the cell, then its frames, like in Node.js:

```
In[3]:2
  throw new Error("boom")
        ^

Error: boom
    at inner (In[3]:2:9)
    at outer (In[3]:5:3)
    at In[3]:7:1
```

- `In[3]` is the execution count of the cell, followed by the line and the column. The frames of the functions defined in other cells show the cell where they are defined. The frames of the kernel are hidden.
- Syntax errors show the line and a caret under the column, before running the cell.
- Values thrown that are not errors are shown as is, like `Uncaught 'x'` for `throw "x"`.
- The `cause` of an error and the errors of an `AggregateError` are shown nested, under `[cause]:` and `[errors]:`.
- `console.error(error)`, `console.trace()` and the errors shown as values use the same locations.

The columns can differ slightly between browsers, which point at different parts of the expression that failed.

## Input

`prompt(message)` asks the user for some text, and returns it:

```javascript
const name = prompt('What is your name?');
```

- In `JavaScript (Web Worker)`, the question is shown in the output area, like `input()` in Python kernels. `prompt.password(message)` hides the answer. This uses the JupyterLite service worker, so it needs a browser supporting it.
- In `JavaScript (IFrame)`, the code runs on the main thread of the page, so `prompt()` is the dialog of the browser.

## Completion and documentation

Press **Tab** to complete the names defined in the kernel, and the properties of objects and literals like `"text".toUpp`. The completer shows the type of each completion, like `class` or `function`.

Press **Shift+Tab**, or open **Help > Show Contextual Help**, to see the documentation of the name under the cursor: its signature, its JSDoc comment, and its source. The built-in objects link to their page on MDN, and the names which are not defined show suggestions.

```javascript
/**
 * Compute the area of a circle.
 * @param {number} radius - The radius of the circle
 */
function circleArea(radius) {
  return Math.PI * radius ** 2;
}
```

## Jupyter Widgets

The kernel provides built-in support for [Jupyter Widgets](https://ipywidgets.readthedocs.io/) (`ipywidgets`-compatible). Widget classes and helpers are available under `Jupyter.widgets`; destructure the ones you need before using them:

```javascript
const { IntSlider, IntProgress, jslink } = Jupyter.widgets;

const slider = new IntSlider({
  value: 50,
  min: 0,
  max: 100,
  description: 'My Slider'
});
const progress = new IntProgress({
  value: 50,
  min: 0,
  max: 100,
  description: 'Mirror'
});
display(slider);
display(progress);

slider.observe(({ new: value }) => {
  console.log('Slider value:', value);
}, 'value');

jslink([slider, 'value'], [progress, 'value']);
```

Widgets auto-display when they are the last expression in a cell. Use the global `display()` function to display a widget explicitly, for example when assigning to a variable.

Widgets also work when JupyterLite is served over plain http, for example on a LAN, where the browser hides some APIs like `crypto.randomUUID` (only `prompt()` in `JavaScript (Web Worker)` needs the service worker, which needs `https` or `localhost`).

### Available widgets

- **Numeric**: `IntSlider`, `FloatSlider`, `FloatLogSlider`, `IntRangeSlider`, `FloatRangeSlider`, `Play`, `IntProgress`, `FloatProgress`, `IntText`, `FloatText`, `BoundedIntText`, `BoundedFloatText`
- **Boolean**: `Checkbox`, `ToggleButton`, `Valid`
- **Selection**: `Dropdown`, `RadioButtons`, `Select`, `SelectMultiple`, `ToggleButtons`, `SelectionSlider`, `SelectionRangeSlider`
- **String**: `Text`, `Textarea`, `Password`, `Combobox`
- **Display**: `Label`, `HTML`, `HTMLMath`, `Output`
- **Button**: `Button` (with `.onClick()` handler)
- **Color**: `ColorPicker`
- **Media**: `Image` (from bytes, sent as binary buffers)
- **Layout / Style**: `Layout`, `DescriptionStyle`, `SliderStyle`, `ProgressStyle`, `ButtonStyle`, `CheckboxStyle`, `ToggleButtonStyle`, `ToggleButtonsStyle`, `TextStyle`, `HTMLStyle`, `HTMLMathStyle`, `LabelStyle`
- **Containers**: `Box`, `HBox`, `VBox`, `GridBox`, `Accordion`, `Tab`, `Stack`
- **Helpers**: `jslink`, `jsdlink`

### Ported widget modules

The widget runtime is split into files that roughly follow the upstream `ipywidgets` package structure so it is easier to track what has been ported.

| Upstream `ipywidgets` file                           | Local file                                                                    | Status  | Notes                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------- |
| `packages/base/src/widget.ts`                        | `packages/javascript-kernel-runtime/src/widgets/widget.ts`                    | Ported  | Kernel-side `Widget` and `DOMWidget` equivalents                     |
| `packages/base/src/widget_layout.ts`                 | `packages/javascript-kernel-runtime/src/widgets/widget_layout.ts`             | Ported  | Layout models                                                        |
| `packages/base/src/widget_style.ts`                  | `packages/javascript-kernel-runtime/src/widgets/widget_style.ts`              | Ported  | Shared style models, plus control-specific styles gathered here      |
| `packages/controls/src/widget_int.ts`                | `packages/javascript-kernel-runtime/src/widgets/widget_int.ts`                | Ported  | Integer widgets, play, progress, and text inputs                     |
| `packages/controls/src/widget_float.ts`              | `packages/javascript-kernel-runtime/src/widgets/widget_float.ts`              | Ported  | Float widgets                                                        |
| `packages/controls/src/widget_bool.ts`               | `packages/javascript-kernel-runtime/src/widgets/widget_bool.ts`               | Ported  | Boolean widgets; related styles live in `widget_style.ts`            |
| `packages/controls/src/widget_selection.ts`          | `packages/javascript-kernel-runtime/src/widgets/widget_selection.ts`          | Partial | Selection semantics still differ from `ipywidgets` in some cases     |
| `packages/controls/src/widget_string.ts`             | `packages/javascript-kernel-runtime/src/widgets/widget_string.ts`             | Ported  | String and display widgets; related styles live in `widget_style.ts` |
| `packages/output/src/output.ts`                      | `packages/javascript-kernel-runtime/src/widgets/widget_output.ts`             | Partial | Output capture is supported but not feature-complete                 |
| `packages/controls/src/widget_button.ts`             | `packages/javascript-kernel-runtime/src/widgets/widget_button.ts`             | Partial | Button widget is present, but callback behavior differs slightly     |
| `packages/controls/src/widget_color.ts`              | `packages/javascript-kernel-runtime/src/widgets/widget_color.ts`              | Ported  | Color picker                                                         |
| `packages/controls/src/widget_box.ts`                | `packages/javascript-kernel-runtime/src/widgets/widget_box.ts`                | Ported  | Box, HBox, VBox, GridBox                                             |
| `packages/controls/src/widget_selectioncontainer.ts` | `packages/javascript-kernel-runtime/src/widgets/widget_selectioncontainer.ts` | Ported  | Accordion, Tab, Stack                                                |
| `packages/controls/src/widget_link.ts`               | `packages/javascript-kernel-runtime/src/widgets/widget_link.ts`               | Ported  | `jslink`, `jsdlink`, `Link`, and `DirectionalLink`                   |
| `packages/controls/src/widget_image.ts`              | `packages/javascript-kernel-runtime/src/widgets/widget_image.ts`              | Ported  | `Image`; `Video` and `Audio` are not ported yet                      |

> **Note:** `jupyterlab-widgets`, `@jupyter-widgets/controls`, and `@jupyter-widgets/output` must be available in the JupyterLite deployment for the full widget set to render.

See the [example notebook](examples/widgets.ipynb) for more usage examples.

### Enable or disable specific modes

The two runtime modes are registered by separate plugins:

- `@jupyterlite/javascript-kernel-extension:kernel-iframe`
- `@jupyterlite/javascript-kernel-extension:kernel-worker`

You can disable either one using `disabledExtensions` in `jupyter-config-data`.

Disable worker mode:

```json
{
  "jupyter-config-data": {
    "disabledExtensions": [
      "@jupyterlite/javascript-kernel-extension:kernel-worker"
    ]
  }
}
```

Disable iframe mode:

```json
{
  "jupyter-config-data": {
    "disabledExtensions": [
      "@jupyterlite/javascript-kernel-extension:kernel-iframe"
    ]
  }
}
```

## Contributing

### Packages

The repository contains three npm packages:

- `@jupyterlite/javascript-kernel-runtime`: the code running next to the user code, in the iframe or the Web Worker. It executes the cells, formats the outputs, and implements comms and widgets. It does not depend on JupyterLite, so that other JavaScript kernels can reuse it. It is engine-neutral: it only needs the ECMAScript built-ins, and compiles without the DOM types, which the build checks. It also ships single-file builds, with `acorn` and `astring` included, for kernels that do not use npm, and exports the engine-neutral helpers of the tracebacks, like `parseStack` and `formatError`, for other kernels. See its [README](packages/javascript-kernel-runtime/README.md).
- `@jupyterlite/javascript-kernel`: the JupyterLite kernel, with the iframe and Web Worker runtimes. It also exports everything from `@jupyterlite/javascript-kernel-runtime`.
- `@jupyterlite/javascript-kernel-extension`: the JupyterLite extension registering the kernels.

### Development install

Note: You will need NodeJS to build the extension package.

The `jlpm` command is JupyterLab's pinned version of
[yarn](https://yarnpkg.com/) that is installed with JupyterLab. You may use
`yarn` or `npm` in lieu of `jlpm` below.

```bash
# Clone the repo to your local environment
# Change directory to the jupyterlite-javascript-kernel directory
# Install package in development mode
pip install -e ".[dev]"
# Link your development version of the extension with JupyterLab
jupyter-builder develop . --overwrite
# Rebuild extension Typescript source after making changes
jlpm build
```

You can watch the source directory and run JupyterLab at the same time in different terminals to watch for changes in the extension's source and automatically rebuild the extension.

```bash
# Watch the source directory in one terminal, automatically rebuilding when needed
jlpm watch
# Run JupyterLab in another terminal
jupyter lab
```

With the watch command running, every saved change will immediately be built locally and available in your running JupyterLab. Refresh JupyterLab to load the change in your browser (you may need to wait several seconds for the extension to be rebuilt).

By default, the `jlpm build` command generates the source maps for this extension to make it easier to debug using the browser dev tools. To also generate source maps for the JupyterLab core extensions, you can run the following command:

```bash
jupyter lab build --minimize=False
```

The version reported by the kernel comes from
`packages/javascript-kernel/src/version.ts`, generated from `package.json` by
`jlpm version:sync`. `jlpm lint:check` verifies that it is up to date, and
`scripts/bump-version.py` regenerates it during releases. `jlpm lint:check`
also verifies that the ECMAScript edition reported by the kernel
(`ECMASCRIPT_EDITION` in `packages/javascript-kernel-runtime/src/executor.ts`)
is the latest edition of the installed `acorn` parser: update it together with
`acorn`.

### Running the tests

The UI tests in [`ui-tests`](ui-tests) use the kernels in a JupyterLite site with Playwright and Galata. See [`ui-tests/README.md`](ui-tests/README.md) to run them.

### Development uninstall

```bash
pip uninstall jupyterlite-javascript-kernel
```

In development mode, you will also need to remove the symlink created by `jupyter-builder develop`
command. To find its location, you can run `jupyter labextension list` to figure out where the `labextensions`
folder is located. Then you can remove the symlink named `@jupyterlite/javascript-kernel` within that folder.

### Packaging the extension

See [RELEASE](RELEASE.md)
