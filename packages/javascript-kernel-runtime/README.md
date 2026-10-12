# @jupyterlite/javascript-kernel-runtime

An engine-neutral Jupyter runtime for JavaScript: the part of a JavaScript
kernel that runs next to the user code. It covers:

- the rewriting of the cells with [acorn](https://github.com/acornjs/acorn)
  and [astring](https://github.com/davidbonnet/astring): top-level `await`,
  declarations kept in the global scope, `import` statements
- Node.js-style `inspect()` of the values, and the `console`
- `display()` and the rich outputs (HTML, Markdown, SVG, images, JSON, ...)
- the tracebacks of the errors, with their locations in the cells
- completion, inspection (the documentation of the names) and `isComplete`
- comms and [Jupyter Widgets](https://ipywidgets.readthedocs.io/)

It only needs the ECMAScript built-ins, so it runs in a browser window, a Web
Worker or an engine without the web APIs. It is used by the
[JupyterLite JavaScript kernel](https://github.com/jupyterlite/javascript-kernel)
and the [p5.js kernel](https://github.com/jupyterlite/p5-kernel), and is meant
to be embedded by engines like
[xeus-quickjs](https://github.com/jtpio/xeus-quickjs).

## Files

- `lib/`: one ES module per source file, with the types, for bundlers.
- `dist/javascript-kernel-runtime.umd.js`, `dist/javascript-kernel-runtime.umd.min.js`
  and `dist/javascript-kernel-runtime.mjs`: single-file builds with acorn and
  astring included, for the kernels that do not use npm, with their source
  maps. `dist/THIRD_PARTY_LICENSES.txt` has the licenses of acorn and
  astring (MIT).

## Loading

With a bundler:

```javascript
import { JavaScriptRuntimeEvaluator } from '@jupyterlite/javascript-kernel-runtime';
```

With a script, the UMD build sets a global. Delete it after reading it, so
that the cells do not see it:

```html
<script src="https://cdn.jsdelivr.net/npm/@jupyterlite/javascript-kernel-runtime/dist/javascript-kernel-runtime.umd.min.js"></script>
<script>
  const runtime = globalThis.JupyterJavaScriptRuntime;
  delete globalThis.JupyterJavaScriptRuntime;
</script>
```

As an ES module, for example with `qjs -m` or from a CDN:

```javascript
import * as runtime from './javascript-kernel-runtime.mjs';
```

To embed it in an engine written in C or C++, evaluate the UMD file inside a
CommonJS shim, which sets no global. This is how an engine like xeus-quickjs,
which embeds acorn the same way, can embed it:

```javascript
const runtime = (function () {
  const module = { exports: {} };
  const exports = module.exports;
  /* the content of javascript-kernel-runtime.umd.js */
  return module.exports;
})();
```

## The host adapter

A kernel creates one evaluator for the realm running the cells, and calls
`dispose()` when the kernel restarts:

```javascript
const evaluator = new runtime.JavaScriptRuntimeEvaluator({
  globalScope: globalThis,
  onOutput: message => publish(message)
});
const reply = await evaluator.execute('1 + 1', 1);
```

| Option                   | Description                                                                                                                                                                                                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `globalScope`            | The global object of the realm running the cells. The evaluator installs `display`, `clearOutput`, `Jupyter` (and `prompt` with `requestInput`) on it.                                                                                                                        |
| `onOutput`               | Called with the output messages, see below.                                                                                                                                                                                                                                   |
| `requestInput`           | `(prompt, password, parentHeader?) => string \| null`: asks the user for some input, synchronously, for `prompt()`. Returns null when the input can not be asked.                                                                                                             |
| `now`                    | `() => number`: the current time in milliseconds, for `console.time()` and the batching of the outputs. Defaults to `performance.now()`, or `Date.now()`.                                                                                                                     |
| `readFile`               | `(path) => Uint8Array`: reads a file, for `display.image(path)`, which is only available with it.                                                                                                                                                                             |
| `promiseState`           | `(promise) => [state, value] \| null`: the state of a promise (0 pending, 1 fulfilled, 2 rejected), for engines which can tell it: the outputs then show it.                                                                                                                  |
| `onCommTargetRegistered` | `(targetName) => void`: called when a comm target is registered, for kernels that must register it before the frontend can open comms on it.                                                                                                                                  |
| `scheduler`              | `{ setTimeout(callback, ms), clearTimeout(handle) }`: the timers of the host, for the work the runtime defers, like sending the pending text of the streams. Defaults to the timers of `globalScope`, if any, read when the evaluator is created. `null` for none, see below. |
| `flushInterval`          | The longest time in milliseconds the text written to stdout or stderr is kept, to send the consecutive writes together. 50 by default, 0 sends one message per write.                                                                                                         |
| `maxStreamBufferSize`    | The size of the pending text of a stream, in UTF-16 code units, from which it is sent. 1,000,000 by default.                                                                                                                                                                  |
| `maxStreamOutput`        | The number of characters a cell can print on stdout and stderr, counted from the start of the cell or its last `clear_output`: the rest is dropped, with a notice on stderr. 5,000,000 by default, 0 for no limit.                                                            |
| `executor`               | A `JavaScriptExecutor`, to configure it, for example to turn off the magic imports.                                                                                                                                                                                           |

The methods of the evaluator:

- `execute(code, executionCount, parentMessageId?, parentHeader?)` runs a
  cell, and returns a promise of the content of the `execute_reply`. The host
  must run the job queue of the engine until the promise settles: browsers do
  it on their own, QuickJS runs `JS_ExecutePendingJob` in a loop, and
  quickjs-emscripten `runtime.executePendingJobs()`.
- `complete(code, cursorPos)`, `inspect(code, cursorPos, detailLevel)` and
  `isComplete(code)` are synchronous, and return the content of the replies.
  The cursor positions are in code points, like in the Jupyter protocol.
- `handleCommOpen(commId, targetName, data, buffers?, parentMessageId?)`,
  `handleCommMsg(commId, data, buffers?, parentMessageId?)` and
  `handleCommClose(commId, data, buffers?, parentMessageId?)` handle the comm
  messages of the frontend.
- `flushOutputs()` sends the text written to stdout and stderr and not sent
  yet, see below.
- `reportUncaught(error, inPromise?)` prints an error thrown outside of an
  execution on stderr, as `Uncaught Error: ...`, or
  `Uncaught (in promise) Error: ...` for the reason of a rejected promise.
  Once the cell reached `maxStreamOutput`, the error goes to the console of
  the host instead.
- `dispose()` removes the globals and the listeners of the evaluator.

`onOutput` is called in order, during `execute()` and also later, for the
outputs of callbacks, timers and widget handlers: the host attaches them to
its current parent message. The consecutive writes to a stream (the
`console`, uncaught errors) are merged into one `stream` message, sent:

- before any other output message, including the comm messages,
- at the end of `execute()` and of the comm handlers, and before `prompt()`
  asks for input,
- when the stream or the parent message changes,
- at most `flushInterval` after the first write, with the timers of the
  `scheduler`, or on the next write after `flushInterval`: a long synchronous
  loop then shows its output while it runs, even without timers,
- when the pending text reaches `maxStreamBufferSize`.

A `clear_output` without `wait` drops the pending text of the cell, which
would be cleared at once. The frontend merges the consecutive stream outputs
anyway, so the notebook shows the same text, with far fewer messages.

An engine whose timers would keep the cell running passes `scheduler: null`,
and calls `evaluator.flushOutputs()` when the cell, its timers and its jobs
are done, before it publishes the reply. The messages
(`RuntimeOutputMessage`) map to the Jupyter messages:

| `type`                | Payload                                                            | Jupyter message                                                         |
| --------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `stream`              | `bundle`: `{ name, text }`                                         | `stream`                                                                |
| `display_data`        | `bundle`: `{ data, metadata, transient }`                          | `display_data`                                                          |
| `update_display_data` | `bundle`: `{ data, metadata, transient }`                          | `update_display_data`                                                   |
| `clear_output`        | `bundle`: `{ wait }`                                               | `clear_output`                                                          |
| `execute_result`      | `bundle`: `{ execution_count, data, metadata }`                    | `execute_result`, not published for silent requests                     |
| `execute_error`       | `bundle`: `{ status, ename, evalue, traceback }`                   | `error`, also returned by `execute()` as the reply                      |
| `comm_open`           | `content`: `{ comm_id, target_name, data }`, `metadata`, `buffers` | `comm_open`                                                             |
| `comm_msg`            | `content`: `{ comm_id, data }`, `metadata`, `buffers`              | `comm_msg`                                                              |
| `comm_close`          | `content`: `{ comm_id, data }`, `metadata`, `buffers`              | `comm_close`                                                            |
| `input_request`       | `content`: `{ prompt, password }`                                  | `input_request`, not sent by the evaluator: kept for the input backends |

For example, with the native functions of an engine like xeus-quickjs, which
publish the messages:

```javascript
const onOutput = message => {
  switch (message.type) {
    case 'stream':
      native.publishStream(message.bundle.name, message.bundle.text);
      break;
    case 'display_data':
      native.displayData(
        JSON.stringify(message.bundle.data),
        JSON.stringify(message.bundle.metadata),
        JSON.stringify(message.bundle.transient)
      );
      break;
    // ...
  }
};
```

The adapter also wraps the natives whose shapes differ from the options above.
For example, for natives that return a negative state for the values which are
not promises, and an `ArrayBuffer` for the files:

```javascript
const evaluator = new runtime.JavaScriptRuntimeEvaluator({
  globalScope: globalThis,
  onOutput,
  promiseState: value => {
    const state = native.promiseState(value);
    return state[0] < 0 ? null : state;
  },
  readFile: path => new Uint8Array(native.readFile(path))
});
```

The host owns the interruptions and the timers:

- To interrupt a cell, stop the engine (with `JS_SetInterruptHandler` in
  QuickJS, or by terminating the iframe or the Web Worker): `execute()`
  reports the error the engine throws.
- The cells use the timers of the host, if any. The runtime only uses the
  ones of `scheduler`, to send the pending text of the streams.

The `import` statements of the cells load the npm packages from jsDelivr by
default. Without network module loading, turn off the magic imports: the
`import` statements then become `import(source)`, handled by the module
loader of the engine.

```javascript
const config = new runtime.ExecutorConfig();
config.magicImports = { ...config.magicImports, enabled: false };
const evaluator = new runtime.JavaScriptRuntimeEvaluator({
  globalScope: globalThis,
  onOutput,
  executor: new runtime.JavaScriptExecutor(globalThis, config)
});
```

## Tracebacks

The evaluator names the cells after their execution count, like `In[3]`
(`<silent-1>`, `<silent-2>`... for the execution count 0), and compiles them
with a `//# sourceURL=In[3]` directive. The `traceback` of an
`execute_error` is a list of lines, colored with ANSI escape codes:

```
In[3]:2
  throw new Error("boom")
        ^

Error: boom
    at inner (In[3]:2:9)
    at In[3]:4:1
```

The errors thrown outside of an execution, like in a timer, are printed on
stderr, with the same locations:

```
In[4]:1
setTimeout(() => { throw new Error("later") }, 0)
                         ^

Uncaught Error: later
    at In[4]:1:26
```

- When `globalScope` has `addEventListener`, the evaluator listens for its
  `error` and `unhandledrejection` events, and cancels them: in a Web Worker,
  the errors it does not cancel reach the `onerror` handler of the `Worker`
  in the page.
- The errors of the comm handlers and of the callbacks of the widgets, and the
  rejections of the promises they return, are caught by the runtime, since the
  runtime may not run in the realm of the cells: in an iframe kernel, it runs
  in the page.
- An engine without these events calls `evaluator.reportUncaught(error)` with
  the errors it catches, like the exceptions of its jobs, and
  `evaluator.reportUncaught(reason, true)` for the promises rejected without a
  handler (`JS_SetHostPromiseRejectionTracker` in QuickJS).

To format the errors in another way, use the executor of the evaluator:

```javascript
const { ename, evalue, traceback } = evaluator.executor.formatError(error, {
  prefix: 'Uncaught',
  colors: false
});
```

The positions of the frames are mapped back to the cells: the evaluator
measures once how the engine reports the positions of the code compiled at
runtime, with a probe compiled like a cell, and hides the frames of the files
below the probe, which are the ones of the kernel. It raises
`Error.stackTraceLimit` to 50, when the engine has it, since the frames of
the kernel take some. With an engine which ignores the `//# sourceURL`
directive, the frames of the code compiled at runtime are attributed to the
current cell, which is approximate.

A kernel which compiles the cells itself, for example with a native
`evalScript(source, fileName)`, can reuse the helpers of the tracebacks:

```javascript
const cells = new Map();
cells.set('In[3]', runtime.createCellSource({ name: 'In[3]', code }));
const context = {
  cells,
  calibration: {
    sourceUrlHonored: true,
    sharedFile: null,
    lineOffset: 0,
    columnBase: 1,
    kernelFiles: new Set(['runtime.js'])
  }
};
const { ename, evalue, traceback } = runtime.formatError(error, context);
```

- `parseStack(stack)` parses the stack traces of V8 and QuickJS
  (`    at name (file:1:2)`), SpiderMonkey and JavaScriptCore
  (`name@file:1:2`).
- `mapFrames(frames, context)` maps the frames to the cells and removes the
  frames of the kernel, `formatFrames(frames)` formats them like Node.js.
- `formatError(value, context, { prefix, colors })` returns the `ename`,
  `evalue` and `traceback` of a thrown value.
- `SourceEdits` edits a source code and maps the positions of the edited
  code back to the source, for the kernels which rewrite the cells.
- `CellSyntaxError` is a syntax error with its location in a cell, shown with
  a caret.

## Engine requirements

- The ES2020 syntax, and the ES2022 built-ins.
- The `Function` constructor and the constructor of the async functions,
  which compile the cells.
- Optionally, dynamic `import()`, for the `import` statements of the cells.

The other host APIs are optional:

| Global        | Without it                                                       |
| ------------- | ---------------------------------------------------------------- |
| `crypto`      | `crypto.getRandomValues()`, or else `Math.random()`, for the ids |
| `TextDecoder` | A built-in UTF-8 decoder                                         |
| `URL`         | The import URLs are joined as strings                            |
| `performance` | `Date.now()` for `console.time()`                                |
| `console`     | The evaluator installs its console                               |

`crypto.randomUUID()` only exists in secure contexts: the ids of the comms
also work in JupyterLite served over plain http.

## Contributing

The package compiles without the DOM types (`"lib": ["ES2022"]` and
`"types": []` in its `tsconfig.json`), so every build fails when the code
uses a DOM API. The globals of the host are only read in
[`src/env.ts`](src/env.ts), with a fallback when they are missing.

`jlpm build` builds `lib/` with `tsc`, then the single-file builds in `dist/`
with `scripts/bundle.mjs`.

The internal helpers are marked with `@internal`: they may change in any
release.
