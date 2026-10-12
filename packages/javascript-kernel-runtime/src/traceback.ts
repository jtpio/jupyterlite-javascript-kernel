// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// Tracebacks of the errors, with the locations in the cells (In[3]:2:9), the
// line of code with a caret, and without the frames of the kernel.
//
// The cells are compiled with a `//# sourceURL=In[3]` directive, so the
// engines name their frames after the cell: V8 and QuickJS print
// `    at inner (In[3]:5:9)`, SpiderMonkey and JavaScriptCore `inner@In[3]:5:9`.
// The positions are in the compiled code, which has some lines before the
// code of the cell and rewrites some statements: they are mapped back to the
// cell with the position map of its edits, and the number of lines the engine
// adds, measured once with a probe (see calibrate).

import { inspect, isError } from './inspect';
import { LOOP_GUARD_NAME } from './interrupt';
import { PositionMap, lineStarts, offsetToLineColumn } from './source_edits';
import { color, hasOwn, safe } from './utils';

/**
 * A frame of a stack trace.
 */
export interface IStackFrame {
  /**
   * The name of the function, empty for anonymous functions.
   */
  name: string;

  /**
   * The file (URL) of the code, or the location as printed when it has no
   * position.
   */
  file: string;

  /**
   * The line, 1-based, or 0 when unknown.
   */
  line: number;

  /**
   * The column as printed by the engine (1-based in most engines), or 0
   * when unknown.
   */
  column: number;

  /**
   * Whether the frame is an async frame, awaiting the frame above.
   */
  isAsync: boolean;

  /**
   * Whether the frame is a built-in function, without a location.
   */
  native: boolean;
}

/**
 * A frame of a stack trace, with the location in the cell for the frames of
 * the cells.
 */
export interface IMappedFrame extends IStackFrame {
  /**
   * The name of the cell, like In[3], or null for the other frames. The
   * line and column (1-based) of the frame are then the ones in the cell.
   */
  cell: string | null;

  /**
   * The source URL of the cell, or null for the other frames.
   */
  token: string | null;
}

/**
 * The code of a cell, with what is needed to map the positions of its
 * compiled code back to the cell.
 */
export interface ICellSource {
  /**
   * The name of the cell in the tracebacks, like In[3].
   */
  name: string;

  /**
   * The code of the cell, as typed by the user.
   */
  code: string;

  /**
   * The lines of the code of the cell.
   */
  codeLines: string[];

  /**
   * The offsets of the starts of the lines of the code of the cell.
   */
  codeLineStarts: number[];

  /**
   * Maps the offsets of the edited code to the offsets of the cell.
   */
  map: PositionMap;

  /**
   * The offsets of the starts of the lines of the compiled body.
   */
  bodyLineStarts: number[];

  /**
   * The offset of the edited code in the compiled body.
   */
  cellStart: number;

  /**
   * The length of the edited code.
   */
  editedLength: number;
}

/**
 * Create the source of a cell, for the tracebacks.
 *
 * @param options.name - The name of the cell in the tracebacks, like In[3].
 * @param options.code - The code of the cell, as typed by the user.
 * @param options.body - The compiled code, defaults to the code of the cell.
 * @param options.cellStart - The offset of the edited code in the body.
 * @param options.map - The position map of the edits, defaults to none.
 * @param options.editedLength - The length of the edited code, defaults to
 * the rest of the body.
 */
export function createCellSource(options: {
  name: string;
  code: string;
  body?: string;
  cellStart?: number;
  map?: PositionMap;
  editedLength?: number;
}): ICellSource {
  const { name, code } = options;
  const body = options.body ?? code;
  const cellStart = options.cellStart ?? 0;
  return {
    name,
    code,
    codeLines: code.split(/\r\n?|[\n\u2028\u2029]/),
    codeLineStarts: lineStarts(code),
    map: options.map ?? PositionMap.identity(code.length),
    bodyLineStarts: lineStarts(body),
    cellStart,
    editedLength: options.editedLength ?? body.length - cellStart
  };
}

/**
 * How an engine reports the positions of the code of the cells, measured by
 * compiling a probe like a cell (see calibrate).
 */
export interface ICalibration {
  /**
   * Whether the engine names the frames after the `//# sourceURL` directive.
   */
  sourceUrlHonored: boolean;

  /**
   * The file of the frames of the code compiled at runtime, when the engine
   * ignores the directive: the frames of this file are attributed to the
   * current cell, which is approximate.
   */
  sharedFile: string | null;

  /**
   * The number of lines the engine adds before the compiled body.
   */
  lineOffset: number;

  /**
   * The column of the first character of a line: 1 or 0.
   */
  columnBase: number;

  /**
   * The files of the code of the kernel, whose frames are not shown.
   */
  kernelFiles: Set<string>;
}

/**
 * What the tracebacks need to know of the cells.
 */
export interface ITracebackContext {
  /**
   * The cells, by source URL.
   */
  cells: ReadonlyMap<string, ICellSource>;

  /**
   * How the engine reports the positions, or null when its stack traces can
   * not be read: the tracebacks then have no frames.
   */
  calibration: ICalibration | null;

  /**
   * The source URL of the cell being executed, for the errors it throws:
   * the frames below its last frame are the ones of the kernel.
   */
  currentToken?: string;
}

/**
 * The parts of an error reply.
 */
export interface IErrorParts {
  ename: string;
  evalue: string;
  traceback: string[];
}

/**
 * A syntax error in the code of a cell, with its location.
 */
export class CellSyntaxError extends SyntaxError {
  /**
   * Instantiate a syntax error.
   *
   * @param message - The message of the error, without the location.
   * @param location - The source URL of the cell, the line (1-based) and the
   * column (0-based) of the error.
   */
  constructor(
    message: string,
    readonly location: { token: string; line: number; column: number }
  ) {
    super(message);
  }
}

/**
 * The file of the runtime package itself, whose frames are the kernel's.
 */
const RUNTIME_FILE = safe(() => parseStack(new Error().stack)[0]?.file, null);

/**
 * The start of the source URLs of the code the kernel compiles in the realm
 * of the cells, like the loop guard.
 */
const KERNEL_SOURCE_PREFIX = '__jsKernel';

/**
 * The names engines give to the code which is not in a function.
 */
const UNNAMED = new Set([
  '',
  'anonymous',
  'eval',
  '<eval>',
  'global code',
  'eval code',
  'module code'
]);

/**
 * The maximum depth of the nested causes and aggregated errors.
 */
const MAX_NESTED_DEPTH = 5;

/**
 * The maximum number of aggregated errors shown.
 */
const MAX_AGGREGATED_ERRORS = 10;

/**
 * Parse a stack trace, in the format of V8 and QuickJS
 * (`    at name (file:line:column)`) or of SpiderMonkey and JavaScriptCore
 * (`name@file:line:column`). The lines which are not frames are ignored.
 */
export function parseStack(stack: unknown): IStackFrame[] {
  if (typeof stack !== 'string') {
    return [];
  }
  const lines = stack.split('\n');
  const v8 = lines.some(line => /^\s+at /.test(line));
  const frames: IStackFrame[] = [];
  for (const line of lines) {
    const frame = v8 ? parseV8Frame(line) : parseAtFrame(line);
    if (frame) {
      frames.push(frame);
    }
  }
  return frames;
}

/**
 * Parse a frame like `    at async name (file:1:2)`, `    at file:1:2` or
 * `    at eval (eval at f (file:1:2), <anonymous>:3:4)`.
 */
function parseV8Frame(line: string): IStackFrame | null {
  const match = /^\s+at (?:(.+?) \((.+)\)|(.+))$/.exec(line);
  if (!match) {
    return null;
  }
  let name = match[1] ?? '';
  let location = match[1] !== undefined ? match[2] : match[3];
  let isAsync = false;
  if (name.startsWith('async ')) {
    isAsync = true;
    name = name.slice(6);
  } else if (location.startsWith('async ')) {
    isAsync = true;
    location = location.slice(6);
  }
  // The code evaluated with eval or Function has the location of its origin
  const origin = location.lastIndexOf('), ');
  if (location.startsWith('eval at ') && origin >= 0) {
    location = location.slice(origin + 3);
  }
  const frame = withLocation(name, location, isAsync);
  frame.native =
    frame.line === 0 &&
    (location === '<anonymous>' ||
      location === 'native' ||
      /^index \d+$/.test(location));
  return frame;
}

/**
 * Parse a frame like `name@file:1:2` or `async*name@file:1:2`.
 */
function parseAtFrame(line: string): IStackFrame | null {
  const trimmed = line.trim();
  // The URLs often have an @ (npm/package@1.0.0), the names rarely
  const at = trimmed.indexOf('@');
  if (at < 0) {
    return null;
  }
  let name = trimmed.slice(0, at);
  const location = trimmed.slice(at + 1);
  let isAsync = false;
  if (name.startsWith('async*')) {
    isAsync = true;
    name = name.slice(6);
  }
  const frame = withLocation(name, location, isAsync);
  frame.native = location === '[native code]' || location === 'native';
  return frame;
}

/**
 * A frame with the file, line and column of a location.
 */
function withLocation(
  name: string,
  location: string,
  isAsync: boolean
): IStackFrame {
  const position = /^(.*):(\d+):(\d+)$/.exec(location);
  return position
    ? {
        name,
        file: position[1],
        line: Number(position[2]),
        column: Number(position[3]),
        isAsync,
        native: false
      }
    : { name, file: location, line: 0, column: 0, isAsync, native: false };
}

/**
 * Measure how an engine reports the positions of the code of the cells,
 * from an error created by a probe compiled like a cell, with
 * `;\nthis.e =\nnew Error()\n//# sourceURL=<probeUrl>` as its body.
 *
 * @param probeError - The error created by the probe.
 * @param probeUrl - The source URL of the probe.
 * @param probeLine - The line of `new Error()` in the body of the probe.
 * @returns The calibration, or null when the stack trace can not be read.
 */
export function calibrate(
  probeError: unknown,
  probeUrl: string,
  probeLine = 3
): ICalibration | null {
  const frames = parseStack(safe(() => (probeError as any).stack));
  if (frames.length === 0) {
    return null;
  }
  let index = frames.findIndex(frame => frame.file === probeUrl);
  const sourceUrlHonored = index >= 0;
  if (!sourceUrlHonored) {
    index = 0;
  }
  const probe = frames[index];
  const sharedFile = sourceUrlHonored ? null : probe.file;
  // The probe is called by the kernel, so the frames below it are the
  // kernel's: the executor, the evaluator and the transport of the messages
  const kernelFiles = new Set<string>();
  for (const frame of frames.slice(index + 1)) {
    if (!frame.native && frame.file !== sharedFile) {
      kernelFiles.add(frame.file);
    }
  }
  if (RUNTIME_FILE && RUNTIME_FILE !== sharedFile) {
    kernelFiles.add(RUNTIME_FILE);
  }
  return {
    sourceUrlHonored,
    sharedFile,
    lineOffset: probe.line > 0 ? probe.line - probeLine : 0,
    columnBase: probe.column === 0 ? 0 : 1,
    kernelFiles
  };
}

/**
 * Map the frames of a stack trace to the cells, and remove the frames of the
 * kernel.
 *
 * @param frames - The frames, from parseStack.
 * @param ctx - The cells and the calibration of the engine.
 * @param errorPosition - The position of the error, for the engines which
 * do not give the position of the frames of the cells.
 */
export function mapFrames(
  frames: IStackFrame[],
  ctx: ITracebackContext,
  errorPosition?: { line: number; column: number } | null
): IMappedFrame[] {
  const { cells, calibration, currentToken } = ctx;
  const sharedFile =
    calibration && !calibration.sourceUrlHonored
      ? calibration.sharedFile
      : null;
  const fallbackToken = currentToken ?? Array.from(cells.keys()).pop() ?? null;

  // The errors of the loop guard are thrown by the kernel, from the loop
  const guard = frames.findIndex(
    frame => frame.file === LOOP_GUARD_NAME || frame.name === LOOP_GUARD_NAME
  );
  if (guard >= 0) {
    frames = frames.slice(guard + 1);
    errorPosition = null;
  }

  let mapped: IMappedFrame[] = [];
  frames.forEach((frame, i) => {
    let token: string | null = cells.has(frame.file) ? frame.file : null;
    if (token === null && sharedFile !== null && frame.file === sharedFile) {
      token = fallbackToken;
    }
    const cell = token !== null ? cells.get(token) : undefined;
    if (token === null || !cell) {
      mapped.push({ ...frame, cell: null, token: null });
      return;
    }
    // Without the positions of the frames, only the error has one
    const position =
      frame.line > 0 ? frame : i === 0 && errorPosition ? errorPosition : null;
    if (!position) {
      return;
    }
    mapped.push({
      ...frame,
      ...mapPosition(cell, position, calibration),
      cell: cell.name,
      token
    });
  });

  // The frames below the last frame of the cell being executed are the ones
  // of the kernel running it
  if (currentToken) {
    let last = -1;
    mapped.forEach((frame, i) => {
      if (frame.token === currentToken) {
        last = i;
      }
    });
    if (last >= 0) {
      mapped = mapped.slice(0, last + 1);
    }
  }

  const kernelFiles = calibration?.kernelFiles;
  const isKernel = (frame: IMappedFrame) =>
    frame.token === null &&
    !frame.native &&
    (frame.file === RUNTIME_FILE ||
      !!kernelFiles?.has(frame.file) ||
      frame.file.startsWith(KERNEL_SOURCE_PREFIX));
  return mapped.filter((frame, i) => {
    if (isKernel(frame)) {
      return false;
    }
    // The built-in functions called by the kernel, like Function.call
    if (frame.native && frame.token === null) {
      const caller = mapped.slice(i + 1).find(other => !other.native);
      return !(caller && isKernel(caller));
    }
    return true;
  });
}

/**
 * The position in a cell (1-based line and column) of a position in its
 * compiled code.
 */
function mapPosition(
  cell: ICellSource,
  position: { line: number; column: number },
  calibration: ICalibration | null
): { line: number; column: number } {
  const lineOffset = calibration?.lineOffset ?? 0;
  const columnBase = calibration?.columnBase ?? 1;
  const starts = cell.bodyLineStarts;
  const bodyLine = Math.min(
    Math.max(position.line - lineOffset, 1),
    starts.length
  );
  const bodyOffset =
    starts[bodyLine - 1] + Math.max(position.column - columnBase, 0);
  const generated = Math.min(
    Math.max(bodyOffset - cell.cellStart, 0),
    cell.editedLength
  );
  const offset = Math.min(
    Math.max(cell.map.toOriginal(generated), 0),
    cell.code.length
  );
  const { line, column } = offsetToLineColumn(cell.codeLineStarts, offset);
  return { line, column: column + 1 };
}

/**
 * Format a frame like Node.js: `    at name (location)`.
 */
export function formatFrame(frame: IMappedFrame, colors = true): string {
  let name = frame.name;
  // V8 names the code of a cell after the object it is called on, like
  // `Window.eval`
  if (frame.token !== null && /^[\w$]+\.(?:eval|anonymous)$/.test(name)) {
    name = '';
  }
  if (UNNAMED.has(name)) {
    name = '';
  }
  let location: string;
  if (frame.cell !== null) {
    location = `${frame.cell}:${frame.line}:${frame.column}`;
  } else if (frame.native) {
    location = 'native';
  } else if (frame.line > 0) {
    location = `${frame.file}:${frame.line}:${frame.column}`;
  } else {
    location = frame.file;
  }
  if (colors) {
    location = color(frame.cell !== null ? 'cyan' : 'gray', location);
  }
  const text = name ? `${name} (${location})` : location;
  return `    at ${frame.isAsync ? 'async ' : ''}${text}`;
}

/**
 * Format frames, with the runs of identical frames (of a stack overflow)
 * collapsed.
 */
export function formatFrames(frames: IMappedFrame[], colors = true): string[] {
  const lines: string[] = [];
  const same = (a: IMappedFrame, b: IMappedFrame) =>
    a.name === b.name &&
    a.file === b.file &&
    a.cell === b.cell &&
    a.line === b.line &&
    a.column === b.column;
  let i = 0;
  while (i < frames.length) {
    let j = i + 1;
    while (j < frames.length && same(frames[i], frames[j])) {
      j++;
    }
    lines.push(formatFrame(frames[i], colors));
    const repeated = j - i - 1;
    if (repeated > 0) {
      lines.push(
        `    ... ${repeated} more identical frame${repeated > 1 ? 's' : ''}`
      );
    }
    i = j;
  }
  return lines;
}

/**
 * Format a thrown value for an error reply, like Node.js: the location of
 * the error in its cell with a caret under the column, `Name: message` and
 * the frames, then the cause and the aggregated errors.
 *
 * @param value - The thrown value, an error or any other value.
 * @param ctx - The cells and the calibration of the engine.
 * @param options.prefix - Printed before the header, like `Uncaught` for the
 * errors thrown outside of an execution.
 * @param options.colors - Whether to color with ANSI escape codes.
 */
export function formatError(
  value: unknown,
  ctx: ITracebackContext,
  options: { prefix?: string; colors?: boolean } = {}
): IErrorParts {
  const colors = options.colors ?? true;
  const paint = (name: string, text: string) =>
    colors ? color(name, text) : text;
  const { ename, evalue, frames } = describe(value, ctx);

  const traceback: string[] = [];
  const syntaxLocation =
    value instanceof CellSyntaxError ? value.location : null;
  const top = frames.find(frame => frame.token !== null);
  const location = syntaxLocation
    ? syntaxLocation
    : top
      ? { token: top.token!, line: top.line, column: top.column - 1 }
      : null;
  const cell = location ? ctx.cells.get(location.token) : undefined;
  if (location && cell) {
    traceback.push(...caretBlock(cell, location.line, location.column, paint));
  }

  let header: string;
  if (ename === 'Uncaught') {
    header = `${paint('red', paint('bold', options.prefix || 'Uncaught'))} ${evalue}`;
  } else {
    header =
      (options.prefix ? `${paint('red', options.prefix)} ` : '') +
      paint('red', paint('bold', ename)) +
      (evalue ? `: ${evalue}` : '');
  }
  traceback.push(header);
  traceback.push(...formatFrames(frames, colors));
  traceback.push(...nestedErrors(value, ctx, colors, 1, [value]));
  return { ename, evalue, traceback };
}

/**
 * The lines shown after `Name: message` for an error: its frames, its cause
 * and its aggregated errors. Returns null for the values which are not
 * errors, and for the errors whose stack trace can not be read.
 *
 * @param value - The error.
 * @param ctx - The cells and the calibration of the engine.
 * @param colors - Whether to color with ANSI escape codes.
 */
export function formatStackLines(
  value: unknown,
  ctx: ITracebackContext,
  colors = true
): string[] | null {
  if (!isErrorLike(value)) {
    return null;
  }
  const parsed = parseStack(safe(() => (value as any).stack));
  const nested = nestedErrors(value, ctx, colors, 1, [value]);
  if (parsed.length === 0 && nested.length === 0) {
    return null;
  }
  const frames = mapFrames(parsed, ctx, errorPosition(value));
  return [...formatFrames(frames, colors), ...nested];
}

/**
 * Whether a value is an error, from any realm, or looks like one, like a
 * DOMException.
 */
function isErrorLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return (
    isError(value) ||
    safe(
      () =>
        typeof (value as any).name === 'string' &&
        typeof (value as any).message === 'string',
      false
    )
  );
}

/**
 * The position of an error, from its line and column properties, set by
 * JavaScriptCore.
 */
function errorPosition(
  value: unknown
): { line: number; column: number } | null {
  const line = safe(() => (value as any).line);
  const column = safe(() => (value as any).column);
  return typeof line === 'number' && typeof column === 'number'
    ? { line, column }
    : null;
}

/**
 * The name, message and frames of a thrown value. The values which are not
 * errors are named `Uncaught`, with their inspection as message.
 */
function describe(
  value: unknown,
  ctx: ITracebackContext
): { ename: string; evalue: string; frames: IMappedFrame[] } {
  if (!isErrorLike(value)) {
    return {
      ename: 'Uncaught',
      evalue: inspect(value, { colors: false }),
      frames: []
    };
  }
  const error = value as any;
  const ename = safe(() => String(error.name), 'Error') || 'Error';
  const evalue = safe(() => String(error.message), '');
  // The syntax errors of the cells are raised by the kernel before running
  // them, so their frames are the kernel's
  const frames =
    value instanceof CellSyntaxError
      ? []
      : mapFrames(
          parseStack(safe(() => error.stack)),
          ctx,
          errorPosition(value)
        );
  return { ename, evalue, frames };
}

/**
 * The location of an error in its cell: the name of the cell and the line,
 * the line of code, and a caret under the column.
 */
function caretBlock(
  cell: ICellSource,
  line: number,
  column: number,
  paint: (name: string, text: string) => string
): string[] {
  const text = cell.codeLines[line - 1];
  if (text === undefined || text.trim() === '') {
    return [];
  }
  let caret = Math.min(Math.max(column, 0), text.length);
  let shown = text;
  // Show a window of the long lines, around the column
  if (text.length > 200) {
    const start = Math.max(0, Math.min(caret - 80, text.length - 160));
    const end = Math.min(text.length, start + 160);
    shown =
      (start > 0 ? '…' : '') +
      text.slice(start, end) +
      (end < text.length ? '…' : '');
    caret = caret - start + (start > 0 ? 1 : 0);
  }
  const padding = shown.slice(0, caret).replace(/[^\t]/g, ' ');
  return [
    paint('cyan', `${cell.name}:${line}`),
    shown,
    padding + paint('red', paint('bold', '^')),
    ''
  ];
}

/**
 * The cause and the aggregated errors of an error, like Node.js shows them:
 * `  [cause]: TypeError: ...` and `  [errors]: [ ... ]`.
 */
function nestedErrors(
  value: unknown,
  ctx: ITracebackContext,
  colors: boolean,
  depth: number,
  seen: unknown[]
): string[] {
  if (!isErrorLike(value) || depth > MAX_NESTED_DEPTH) {
    return [];
  }
  const lines: string[] = [];
  const block = (nested: unknown): string[] => {
    if (seen.includes(nested)) {
      return ['[Circular]'];
    }
    if (!isErrorLike(nested)) {
      return inspect(nested, { colors }).split('\n');
    }
    const { ename, evalue, frames } = describe(nested, ctx);
    const header =
      (colors ? color('red', color('bold', ename)) : ename) +
      (evalue ? `: ${evalue}` : '');
    return [
      header,
      ...formatFrames(frames, colors),
      ...nestedErrors(nested, ctx, colors, depth + 1, [...seen, nested])
    ];
  };

  if (safe(() => hasOwn(value, 'cause'), false)) {
    const [first, ...rest] = block(safe(() => (value as any).cause));
    lines.push(`  [cause]: ${first}`, ...rest.map(line => `  ${line}`));
  }
  const errors = safe(() =>
    hasOwn(value, 'errors') ? (value as any).errors : undefined
  );
  if (Array.isArray(errors)) {
    lines.push('  [errors]: [');
    for (const error of errors.slice(0, MAX_AGGREGATED_ERRORS)) {
      lines.push(...block(error).map(line => `    ${line}`));
    }
    if (errors.length > MAX_AGGREGATED_ERRORS) {
      const more = errors.length - MAX_AGGREGATED_ERRORS;
      lines.push(`    ... ${more} more error${more > 1 ? 's' : ''}`);
    }
    lines.push('  ]');
  }
  return lines;
}
