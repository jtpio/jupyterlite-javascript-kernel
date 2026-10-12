# @jupyterlite/javascript-kernel-runtime

An engine-neutral Jupyter runtime for JavaScript: the part of a JavaScript
kernel that runs next to the user code. It covers:

- the rewriting of the cells with [acorn](https://github.com/acornjs/acorn)
  and [astring](https://github.com/davidbonnet/astring), like a REPL:
  top-level `await`, declarations kept in the global scope, `import` and
  `export` statements, object literal cells
- Node.js-style `inspect()` of the values, and the `console`
- `display()` and the rich outputs (HTML, Markdown, SVG, images, JSON, ...)
- the tracebacks of the errors, with their locations in the cells
- the interruption of the cells, and a timeout for the loops which keep the
  page busy
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
  and `dist/javascript-kernel-runtime.mjs`: single-file builds with acorn,
  acorn-walk and astring included, for the kernels that do not use npm, with
  their source maps. `dist/THIRD_PARTY_LICENSES.txt` has the licenses of
  acorn, acorn-walk and astring (MIT).

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

| Option                   | Description                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `globalScope`            | The global object of the realm running the cells. The evaluator installs `display`, `clearOutput`, `Jupyter` (and `prompt` with `requestInput`) on it, and a `require()` throwing a `ReferenceError` which suggests `import`, when it has no `require`.                         |
| `onOutput`               | Called with the output messages, see below.                                                                                                                                                                                                                                     |
| `requestInput`           | `(prompt, password, parentHeader?) => string \| null`: asks the user for some input, synchronously, for `prompt()`. Returns null when the user cancels. Throws a `StdinNotImplementedError` when the input can not be asked, for example when the request does not allow stdin. |
| `now`                    | `() => number`: the current time in milliseconds, for `console.time()` and the batching of the outputs. Defaults to `performance.now()`, or `Date.now()`.                                                                                                                       |
| `readFile`               | `(path) => Uint8Array`: reads a file, for `display.image(path)`, which is only available with it.                                                                                                                                                                               |
| `promiseState`           | `(promise) => [state, value] \| null`: the state of a promise (0 pending, 1 fulfilled, 2 rejected), for engines which can tell it: the outputs then show it.                                                                                                                    |
| `onCommTargetRegistered` | `(targetName) => void`: called when a comm target is registered, for kernels that must register it before the frontend can open comms on it.                                                                                                                                    |
| `scheduler`              | `{ setTimeout(callback, ms), clearTimeout(handle) }`: the timers of the host, for the work the runtime defers, like sending the pending text of the streams. Defaults to the timers of `globalScope`, if any, read when the evaluator is created. `null` for none, see below.   |
| `flushInterval`          | The longest time in milliseconds the text written to stdout or stderr is kept, to send the consecutive writes together. 50 by default, 0 sends one message per write.                                                                                                           |
| `maxStreamBufferSize`    | The size of the pending text of a stream, in UTF-16 code units, from which it is sent. 1,000,000 by default.                                                                                                                                                                    |
| `maxStreamOutput`        | The number of characters a cell can print on stdout and stderr, counted from the start of the cell or its last `clear_output`: the rest is dropped, with a notice on stderr. 5,000,000 by default, 0 for no limit.                                                              |
| `executor`               | A `JavaScriptExecutor`, to configure it, for example to customize the compilation of the cells.                                                                                                                                                                                 |
| `executorOptions`        | `IExecutorOptions`, plain data: the configuration of the magic imports, see below. Also applied to `executor`.                                                                                                                                                                  |
| `loopTimeout`            | The time in milliseconds a loop of the cells can keep the page busy before it is stopped with a `LoopTimeoutError`, 0 (the default) for no limit. See [Interrupts and loop timeout](#interrupts-and-loop-timeout).                                                              |
| `interruptBuffer`        | An `Int32Array` view of a `SharedArrayBuffer`, to interrupt the loops from another thread: the host sets its first element to 1 with `Atomics.store()`.                                                                                                                         |

The `require()` installed by the evaluator is a global function of the
realm, so `typeof require` is `'function'` for the cells and for the
modules they load: a library which checks for CommonJS with
`typeof require`, without catching the error, gets its `ReferenceError`.
`delete globalThis.require` removes it.

`requestInput` throws a `StdinNotImplementedError`, exported by the package,
when the user can not be asked: when the `execute_request` of the cell has
`allow_stdin: false`, or when the host has no way to send the request. The
cell fails with it, like with the `StdinNotImplementedError` of IPython:

```javascript
const evaluator = new runtime.JavaScriptRuntimeEvaluator({
  globalScope: globalThis,
  onOutput: message => publish(message),
  requestInput: (prompt, password, parentHeader) => {
    if (!allowStdin) {
      throw new runtime.StdinNotImplementedError();
    }
    return blockingInputRequest(prompt, password, parentHeader);
  }
});
```

The methods of the evaluator:

- `execute(code, executionCount, parentMessageId?, parentHeader?)` runs a
  cell, and returns a promise of the content of the `execute_reply`. Its
  outputs go to `parentHeader`, and so do the outputs sent outside of the
  cells until the next execution, see below. The host
  must run the job queue of the engine until the promise settles: browsers do
  it on their own, QuickJS runs `JS_ExecutePendingJob` in a loop, and
  quickjs-emscripten `runtime.executePendingJobs()`.
- `complete(code, cursorPos)`, `inspect(code, cursorPos, detailLevel)` and
  `isComplete(code)` are synchronous, and return the content of the replies.
  The cursor positions are in code points, like in the Jupyter protocol.
- `handleCommOpen(commId, targetName, data, buffers?, parentMessageId?, parentHeader?)`,
  `handleCommMsg(commId, data, buffers?, parentMessageId?, parentHeader?)`
  and `handleCommClose(commId, data, buffers?, parentMessageId?, parentHeader?)`
  handle the comm messages of the frontend, with the id and the header of the
  message. The handlers run synchronously: the promises they return are not
  awaited, so a handler which never settles does not block the kernel. The
  outputs of the handler are sent before the method returns. The method
  returns a promise which resolves at the next timer of the `scheduler`, once
  the jobs queued by the handler ran, like the code of an async callback after
  an `await null`: the host replies to the message after it, so that the
  frontend still shows the outputs of these jobs captured in an `Output`
  widget. Without a scheduler, the promise resolves at once: the host runs the
  jobs of the engine, then calls `flushOutputs()`, which ends the comm
  request.
- `flushOutputs()` sends the text written to stdout and stderr and not sent
  yet, see below.
- `interrupt()` stops the running cell, if any, with a `KeyboardInterrupt`,
  and clears the timers of the cells. `loopTimeout` gets and sets the loop
  timeout. See [Interrupts and loop timeout](#interrupts-and-loop-timeout).
- `reportUncaught(error, inPromise?)` prints an error thrown outside of an
  execution on stderr, as `Uncaught Error: ...`, or
  `Uncaught (in promise) Error: ...` for the reason of a rejected promise.
  Once the cell reached `maxStreamOutput`, the error goes to the console of
  the host instead.
- `dispose()` removes the globals and the listeners of the evaluator.

The evaluator registers the `jupyter.widget.control` comm target, so
`onCommTargetRegistered` is called with it: like ipywidgets, it answers the
`request_states` message of the widget manager of the frontend with an
`update_states` message, holding the state of all the live widgets and their
binary values as buffers, so that a notebook reopened on a running kernel shows
its widgets again. A `comm_open` of the frontend on the id of a comm already
open on the same target, like the comm of a live widget, keeps that comm and
its handlers. The host replies to the `comm_info_request` messages itself, with
the comms of the `comm_open` messages, of the frontend and of `onOutput`, not
closed yet by a `comm_close`, optionally only the ones of the `target_name` of
the request: the widget manager falls back to it when the control comm fails.

The evaluator can run outside of the realm of the cells, like in the page
holding the iframe of the cells: the JupyterLite kernel calls the evaluator
of its iframe kernel directly, and the one of its Web Worker kernel over
Comlink. A host forwarding the requests over messages should not handle the
messages any window can post, like the `message` events of a window, without
checking their source: they would run code in the realm. The evaluator reads
the globals of `globalScope` when it is created, so when the realm is
replaced, like an iframe reloaded with `location.reload()`, dispose it and
create a new one for the new realm.

`onOutput` is called in order, during `execute()` and also later, for the
outputs of callbacks, timers and widget handlers. Each message has the
`parentHeader` of the message of the frontend it belongs to, which the host
publishes it with:

- the outputs of a cell go to its `execute_request`, and so do the outputs
  sent outside of the cells until the next execution, like after an `await`,
- the outputs of the callbacks of `setTimeout`, `setInterval` and
  `requestAnimationFrame` go to the cell which created them: the evaluator
  wraps these functions of `globalScope`,
- the outputs of the callbacks of the widgets, like a click handler, go to the
  cell which registered them, when the frontend triggers them,
- the comm messages sent by a comm handler, and the outputs it captures in an
  `Output` widget, go to the comm message, and so do the outputs of the jobs
  it queued, until the promise of the comm method resolves. Once the host
  replied, the frontend forgets the comm message: the later outputs of an
  async callback captured in a comm handler, like after an `await` of a
  `fetch()`, are added to the `outputs` of the `Output` widget instead.

A message without `parentHeader`, when the evaluator got no header, goes to
the current parent of the host, usually its last `execute_request`. The
consecutive writes to a stream (the `console`, uncaught errors) are merged
into one `stream` message, sent:

- before any other output message, including the comm messages,
- at the end of `execute()` and of the comm handlers, and before `prompt()`
  asks for input,
- when the stream or the parent message (the `parentHeader` object) changes,
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

| `type`                | Payload                                                            | Jupyter message                                     |
| --------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| `stream`              | `bundle`: `{ name, text }`                                         | `stream`                                            |
| `display_data`        | `bundle`: `{ data, metadata, transient }`                          | `display_data`                                      |
| `update_display_data` | `bundle`: `{ data, metadata, transient }`                          | `update_display_data`                               |
| `clear_output`        | `bundle`: `{ wait }`                                               | `clear_output`                                      |
| `execute_result`      | `bundle`: `{ execution_count, data, metadata }`                    | `execute_result`, not published for silent requests |
| `execute_error`       | `bundle`: `{ status, ename, evalue, traceback }`                   | `error`, also returned by `execute()` as the reply  |
| `comm_open`           | `content`: `{ comm_id, target_name, data }`, `metadata`, `buffers` | `comm_open`                                         |
| `comm_msg`            | `content`: `{ comm_id, data }`, `metadata`, `buffers`              | `comm_msg`                                          |
| `comm_close`          | `content`: `{ comm_id, data }`, `metadata`, `buffers`              | `comm_close`                                        |

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

The cells use the timers of the host, if any. The runtime itself only uses
the ones of `scheduler`, to send the pending text of the streams.

The `import` statements of the cells load the npm packages from jsDelivr by
default. The `magicImports` of `executorOptions` change it, with the fields of
`IMagicImportsConfig`, all optional:

| Field             | Description                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | Whether the package names are loaded from the CDN, true by default. Without it, the `import` statements become `import(source)`, handled by the module loader of the engine.       |
| `baseUrl`         | The base URL of the CDN, `https://cdn.jsdelivr.net/` by default. The engine would resolve a relative URL against the module running the cells, if at all, so pass an absolute URL. |
| `enableAutoNpm`   | Whether `npm/` is added in front of the package names, like jsDelivr serves them, true by default.                                                                                 |
| `appendEsmSuffix` | Whether `/+esm` is added after the package paths which do not end with `.js`, `.mjs`, `.cjs`, `.wasm` or `+esm`, for jsDelivr, true by default.                                    |

For example, without network module loading, turn off the magic imports:

```javascript
const evaluator = new runtime.JavaScriptRuntimeEvaluator({
  globalScope: globalThis,
  onOutput,
  executorOptions: { magicImports: { enabled: false } }
});
```

Or load the packages from esm.sh:

```javascript
const executorOptions = {
  magicImports: {
    baseUrl: 'https://esm.sh/',
    enableAutoNpm: false,
    appendEsmSuffix: false
  }
};
```

The options are plain data, which a kernel can send to the realm or the
thread running the cells. The options left out, or `undefined`, keep their
value. `new ExecutorConfig(options)` creates a configuration from them, and
`executor.config.update(options)` changes the configuration of an executor:
the next cells use it.

## Cells

`executor.makeAsyncFromCode(code, { name })` compiles a cell to an async
function, called with the global scope as `this`, in sloppy mode:

- A cell which is an object literal, like `{ a: 1 }`, is parsed as an
  expression. The other cells are parsed as modules, or else as scripts, for
  the names reserved in strict mode like `package`, with the `import` and
  `export` statements allowed at the top level. When both fail, the
  syntax error found the furthest in the code is thrown. `isComplete`,
  `extractImports` and `registerCode` parse the cells the same way.
- The `import` statements become dynamic imports, with their attributes
  (`with { type: 'json' }`), followed by a check of each imported name, `in`
  the module namespace: a name that the module does not export throws a
  `SyntaxError` at the name, `The requested module 'x' does not provide an
export named 'y'`, before any name is bound. The `export` keywords are
  removed, keeping the declarations, the export lists are removed, and the
  re-exports load their module. A semicolon replaces the first character of
  the removed code, which ends the previous statement when it has none.
- The sources of the `import()` expressions go through the magic imports
  too, in the functions of the cell as well: a string is rewritten when the
  cell is compiled, and the other sources when the import runs, by a helper
  passed to the compiled function. `executor.functionSource(fn)` shows the
  sources as written.
- `executor.extractImports(code)` returns the `import` statements of a cell
  with their magic import URL and their attributes, which
  `executor.generateImportCode(imports)` loads again, for example in a
  sketch. `executor.registerCode(code, registry)` rewrites the string
  sources of the `import()` expressions with the magic imports, so the code
  of `executor.generateCodeFromRegistry(registry)` loads the same modules as
  the cells. The other sources are kept as written, without the magic
  imports, so a name computed when that code runs needs a full URL.
- The top-level declarations become assignments to the global scope. The
  `var` declarations are hoisted, as `if (!("x" in globalThis))
globalThis["x"] = undefined`, and keep the value of the global when they
  have no value.
- The declarations named like a property of the global scope which is not a
  writable data property are kept in the cell and copied to the global scope
  after the declaration and at the end of the cell. The accessors, like
  `name` or `status` in a window, are replaced with a writable data property
  (`Object.defineProperty`), since their setter would convert or ignore the
  value, except the event handlers (`on...`), which are assigned to install
  the handler. The non-configurable properties of the global scope, like
  `location`, `top`, `window` and `document` in a window, or `undefined`,
  can not be replaced: their declaration throws a `CellSyntaxError` at the
  declared name, before the cell runs, except a `var` declaration without a
  value, like `var window;`, which keeps the global, as in a script.

## Interrupts and loop timeout

The evaluator inserts a call to a loop guard at the start of the body of
every loop of the cells, in their functions too: `while (x) f();` becomes
`while (x) {typeof __jsKernelLoop__ == 'function' && __jsKernelLoop__(3);f();}`.
The inserted code has no line breaks, so the line numbers of the cells are
kept, and the frames of the guard are not shown in the tracebacks. The guard
is a parameter of the compiled cell, which the code of the cells can not
replace, and the functions of a cell keep it when another cell or a callback
calls them later. The code of a function moved elsewhere, like
`fn.toString()` sent to a Web Worker, runs without the guard. `display()`
and the inspection show the source of the functions as written in the cell.

`evaluator.interrupt()` interrupts the running cell:

- The cell stops waiting for its promise, and fails with
  `KeyboardInterrupt: Execution interrupted`. This stops the cells waiting
  for a promise which never settles, and the async loops. The variables of
  the cell are kept.
- Until the next execution, the loops throw the `KeyboardInterrupt`: a
  continuation of the interrupted cell, like a `fetch()` which resolves
  later, stops at its next loop.
- The timers created by the cells with `setTimeout()` and `setInterval()`
  are cleared, even when no cell is running: this stops the background
  intervals. The timers of the startup code, run before the first execution
  with an execution count, are kept. `requestAnimationFrame()` is not
  tracked, as it drives the drawing loops of libraries like p5.js.

The host calls `interrupt()` while the code of the cells is not running,
when the engine handles a message. To stop a loop which never yields:

- In a thread of its own, like a Web Worker, pass an `interruptBuffer`: the
  loops check it every few milliseconds, and throw the `KeyboardInterrupt`
  when the host sets it from another thread. The evaluator resets it at the
  start of every execution.
- On the thread of the page, like in an iframe, set a `loopTimeout`: a loop
  which keeps the page busy for longer fails with a `LoopTimeoutError`
  naming the loop, like
  `The while loop at line 2 of In[3] ran for more than 10 s without letting the page respond`.
  The time counts from the first iteration, until the engine runs a task (a
  message posted on a `MessageChannel`, or a `setTimeout(0)`): it measures
  how long the page could not render, through the microtasks too
  (`while (true) { await null }`). The time spent in `alert()`, `confirm()`,
  `prompt()`, `print()` and the synchronous `XMLHttpRequest`s does not
  count. The code of the cells changes the timeout with
  `Jupyter.loopTimeout = 60000` (in ms, 0 turns it off).
- An engine with an interrupt handler, like `JS_SetInterruptHandler` in
  QuickJS, stops the engine instead: `execute()` reports the error the
  engine throws.

The errors of the guard can be caught, but they are sticky: the loops throw
them again until the next execution (`KeyboardInterrupt`) or the next task
(`LoopTimeoutError`), and the cell fails with them even when its code caught
them, like `try { while (true) {} } catch {}`.

The guard does not cover the code of the imported modules, the code compiled
with `eval()` and `new Function()`, and the long calls to built-in
functions. It adds a function call per iteration: a loop doing almost
nothing takes about twice as long, the loops doing real work much less. The
guard reads the clock and the `interruptBuffer` about every 4 ms, with a
number of iterations adapted to the speed of each loop, so a fast loop does
not delay the checks of a slow loop running after it.

The runtime exports the parts, for the kernels which compile the cells
themselves: `LoopGuard` (`fn`, the guard passed to the compiled code,
`registerSite()`, `beginExecution()`, `race(promise)`, `interrupt()`,
`endExecution()`, `tripped`, `timeout`, `resetClock()`), `TimerRegistry`
(`install(scope, context?)`, `enable()`, `clearAll()`, `restore()`), the error
names `KEYBOARD_INTERRUPT` and `LOOP_TIMEOUT`, and `createRuntimeError(scope,
name, message)`. The executor instruments the loops when its `loopGuard` is
set.

The optional `context` of `TimerRegistry.install()`, a
`TimerRegistry.IContext`, runs the callbacks of the timers in the context of
the code which created them: `capture()` returns the current context when
`setTimeout` or `setInterval` is called, `enter(context)` makes it current
before the callback runs and returns the previous one, and
`leave(previous, threw)` restores it after the callback. With a context, the
registry also wraps `requestAnimationFrame`, whose callbacks are not cleared
by `clearAll()`.

The `OutputRouter` attaches the outputs to their parent message, an
`IParentMessage` with the `id` and the `header` of a message of the frontend:

- `cell` is the parent of the outputs sent outside of the callbacks, the
  `execute_request` which ran last, and `current` the parent of the outputs
  sent now,
- `runRequest(request, callback)` handles a comm message of the frontend,
  which stays open until `endRequest(request?)`, when the host replied to it,
- `context()` returns the parent of the callbacks registered now, for
  `TimerRegistry.IContext.capture()`, `enter(parent)` and
  `leave(previous, threw)` run them in it, like `runInScope(parent, callback)`,
  and `runCallback(parent, callback)` runs a widget callback, in `parent`
  when the frontend triggered it,
- `runUncaught(callback)` reports an uncaught error in the parent of the
  callback which threw it,
- `route(message)` returns the message with the `parentHeader` of its parent,
  or `null` when an `Output` widget took it.

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

## Widgets

The evaluator gives the cells the widget classes of `createWidgetClasses(commManager)`
as `Jupyter.widgets`: subclasses of the exported classes, like `IntSlider`,
bound to the comm manager of the evaluator. A widget creates its default
layout and style, and the ones of the plain objects given as `layout` or
`style`, with the bound classes (`Widget._boundClasses` maps the exported
classes to them), so that `slider.layout instanceof Jupyter.widgets.Layout`.
A class without a bound class is created with the manager of the widget
creating it.

A widget class, like a custom model, describes its state with:

- `modelName`, `modelModule`, `modelModuleVersion`, `viewName` (null for a
  widget without view), `viewModule` and `viewModuleVersion`, static
- `_defaults()`, the default state: the properties not starting with `_`
  get accessors on the prototype of the class, like `slider.value`, unless
  the class defines them. `declare` fields type them in TypeScript
- `styleClass`, static, for a `DOMWidget`: the class of its style, like
  `SliderStyle`, or null for a widget without style, like a box
- `_validate(state, names)`, which validates a new state before it is
  applied, like the validators of ipywidgets: it coerces the values of the
  whole new state in place, or throws to reject it. It is called with the
  names of the properties given to the constructor (after the defaults are
  applied, so `{ value: 150, max: 200 }` is valid), to `set()`, or sent by
  the frontend, which gets back the values it changed, like a clamped value.
  The properties given as `undefined` are left out, so they keep their
  default or their value.
  The numeric widgets clamp their value to their bounds, round the values of
  the integer widgets, and throw a `RangeError` when `min > max` or
  `lower > upper`. The selection widgets turn `options`, `value` and `label`
  into the synced `_options_labels` and `index`
- `_notify(changes)`, which calls the listeners of the changes of the state
  (`[name, value, old]`): the selection widgets add the changes of the value
  and the label, derived from the index
- `_createWidget(cls, state?)`, which creates a widget of another class with
  the manager of this one
- `send(content, buffers?)` and `onMsg(callback)` / `offMsg(callback)`, for
  the custom messages of the model in the frontend (`msg:custom`)

`DOMWidget` is in `widgets/widget_dom.ts`, apart from `Widget` in
`widgets/widget.ts`, since it uses `Layout` and `Style`, which extend
`Widget`.

## Engine requirements

- The ES2020 syntax, and the ES2022 built-ins.
- The `Function` constructor and the constructor of the async functions,
  which compile the cells.
- Optionally, dynamic `import()`, for the `import` statements of the cells.

The other host APIs are optional:

| Global           | Without it                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `crypto`         | `crypto.getRandomValues()`, or else `Math.random()`, for the ids                                             |
| `TextDecoder`    | A built-in UTF-8 decoder                                                                                     |
| `URL`            | The import URLs are joined as strings                                                                        |
| `performance`    | `Date.now()` for `console.time()` and the loop timeout                                                       |
| `MessageChannel` | `setTimeout(0)` marks the tasks for the loop timeout, or else it counts from the first loop of the execution |
| `console`        | The evaluator installs its console                                                                           |

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
