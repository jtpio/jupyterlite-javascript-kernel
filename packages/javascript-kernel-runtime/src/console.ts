// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { IMimeBundle } from '@jupyterlab/nbformat';

import {
  formatPrimitive,
  inspect,
  isDate,
  isMap,
  isRegExp,
  isSet
} from './inspect';
import { escapeHtml, safe } from './utils';

/**
 * What the console needs from the kernel.
 */
export interface IConsoleHost {
  /**
   * Write some text to the stdout or stderr stream.
   */
  write(name: 'stdout' | 'stderr', text: string): void;

  /**
   * Display a MIME bundle, for console.table.
   */
  display(data: IMimeBundle): void;

  /**
   * Clear the outputs of the cell, for console.clear.
   */
  clear(wait: boolean): void;

  /**
   * The current time in milliseconds, for console.time.
   */
  now(): number;
}

/**
 * The methods of the console of the kernel.
 */
export type KernelConsole = Pick<
  Console,
  | 'log'
  | 'info'
  | 'debug'
  | 'error'
  | 'warn'
  | 'trace'
  | 'dir'
  | 'dirxml'
  | 'table'
  | 'group'
  | 'groupCollapsed'
  | 'groupEnd'
  | 'time'
  | 'timeLog'
  | 'timeEnd'
  | 'count'
  | 'countReset'
  | 'assert'
  | 'clear'
>;

/**
 * Format the arguments of console.log like Node.js, with the printf-like
 * substitutions (%s, %d, %i, %f, %j, %o, %O, %c) of the first argument.
 */
export function formatArguments(args: unknown[], colors = true): string {
  const parts: string[] = [];
  let rest = args;
  const first = args[0];
  if (typeof first === 'string' && args.length > 1 && first.includes('%')) {
    let used = 1;
    const text = first.replace(/%([sdifjoOc%])/g, (match, specifier) => {
      if (specifier === '%') {
        return '%';
      }
      if (used >= args.length) {
        return match;
      }
      const arg = args[used++];
      switch (specifier) {
        case 's':
          if (typeof arg === 'string') {
            return arg;
          }
          if (typeof arg === 'bigint') {
            return `${arg}n`;
          }
          if (arg !== null && typeof arg === 'object') {
            return inspect(arg, { depth: 1, colors });
          }
          return String(arg);
        case 'd':
        case 'i': {
          if (typeof arg === 'bigint') {
            return `${arg}n`;
          }
          if (typeof arg === 'symbol') {
            return 'NaN';
          }
          const number =
            specifier === 'i' ? parseInt(String(arg)) : Number(arg);
          return formatPrimitive(number, { colors });
        }
        case 'f':
          return typeof arg === 'symbol'
            ? 'NaN'
            : formatPrimitive(parseFloat(String(arg)), { colors });
        case 'j':
          return safe(() => JSON.stringify(arg), '[Circular]') as string;
        case 'o':
          return inspect(arg, { colors, depth: 4 });
        case 'O':
          return inspect(arg, { colors });
        case 'c':
          return '';
      }
      return match;
    });
    parts.push(text);
    rest = args.slice(used);
  }
  for (const arg of rest) {
    parts.push(typeof arg === 'string' ? arg : inspect(arg, { colors }));
  }
  return parts.join(' ');
}

function formatDuration(milliseconds: number): string {
  if (milliseconds >= 1000) {
    return `${(milliseconds / 1000).toFixed(3)}s`;
  }
  return `${milliseconds.toFixed(3)}ms`;
}

function tableCell(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return inspect(value, { depth: 0, breakLength: Infinity });
}

/**
 * The plain text and HTML tables of console.table.
 */
export function formatTable(
  data: any,
  properties?: readonly string[]
): IMimeBundle | null {
  if (data === null || typeof data !== 'object') {
    return null;
  }
  const indexHeader = '(index)';
  const valuesHeader = 'Values';
  const rows: { index: string; cells: Record<string, string> }[] = [];
  const columns: string[] = [];
  let hasValues = false;
  const addColumn = (column: string) => {
    if (!columns.includes(column)) {
      columns.push(column);
    }
  };
  const entries: [unknown, unknown][] = isMap(data)
    ? Array.from(Map.prototype.entries.call(data))
    : isSet(data)
      ? Array.from(Set.prototype.values.call(data), (value, i) => [i, value])
      : Object.entries(data);
  for (const [index, row] of entries) {
    const cells: Record<string, string> = {};
    if (
      row !== null &&
      typeof row === 'object' &&
      !isDate(row) &&
      !isRegExp(row)
    ) {
      for (const [key, value] of Object.entries(row)) {
        if (properties && !properties.includes(key)) {
          continue;
        }
        addColumn(key);
        cells[key] = tableCell(value);
      }
    } else {
      hasValues = true;
      cells[valuesHeader] = tableCell(row);
    }
    rows.push({ index: tableCell(index), cells });
  }
  if (properties) {
    columns.splice(0, columns.length, ...properties.map(String));
  }
  if (hasValues) {
    columns.push(valuesHeader);
  }

  // Plain text, drawn like Node.js does
  const headers = [indexHeader, ...columns];
  const table = rows.map(row => [
    row.index,
    ...columns.map(column => (column in row.cells ? row.cells[column] : ''))
  ]);
  const widths = headers.map(
    (header, i) =>
      Math.max(header.length, ...table.map(row => row[i].length)) + 2
  );
  const center = (text: string, width: number) => {
    const left = Math.floor((width - text.length) / 2);
    return ' '.repeat(left) + text + ' '.repeat(width - text.length - left);
  };
  const line = (left: string, middle: string, right: string) =>
    left + widths.map(width => '─'.repeat(width)).join(middle) + right;
  const plain = [
    line('┌', '┬', '┐'),
    '│' + headers.map((header, i) => center(header, widths[i])).join('│') + '│',
    line('├', '┼', '┤'),
    ...table.map(
      row => '│' + row.map((cell, i) => center(cell, widths[i])).join('│') + '│'
    ),
    line('└', '┴', '┘')
  ].join('\n');

  const html = [
    '<table>',
    '<thead><tr>' +
      headers.map(header => `<th>${escapeHtml(header)}</th>`).join('') +
      '</tr></thead>',
    '<tbody>',
    ...table.map(
      row =>
        '<tr>' +
        row
          .map((cell, i) =>
            i === 0
              ? `<th>${escapeHtml(cell)}</th>`
              : `<td>${escapeHtml(cell)}</td>`
          )
          .join('') +
        '</tr>'
    ),
    '</tbody>',
    '</table>'
  ].join('\n');

  return { 'text/html': html, 'text/plain': plain };
}

/**
 * Create a console writing to the output streams of the cells.
 */
export function createConsole(host: IConsoleHost): KernelConsole {
  let groupIndentation = '';
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();

  const write = (name: 'stdout' | 'stderr', text: string) => {
    if (groupIndentation) {
      text = text
        .split('\n')
        .map(line => groupIndentation + line)
        .join('\n');
    }
    host.write(name, text + '\n');
  };

  const console: KernelConsole = {
    log(...args: unknown[]) {
      write('stdout', formatArguments(args));
    },
    info(...args: unknown[]) {
      write('stdout', formatArguments(args));
    },
    debug(...args: unknown[]) {
      write('stdout', formatArguments(args));
    },
    error(...args: unknown[]) {
      write('stderr', formatArguments(args));
    },
    warn(...args: unknown[]) {
      write('stderr', formatArguments(args));
    },
    trace(...args: unknown[]) {
      // Skip the first line (the error) and the frame of console.trace
      const stack = String(new Error().stack ?? '');
      const frames = stack
        .split('\n')
        .filter(line => /^\s*at |@/.test(line))
        .slice(1);
      write(
        'stderr',
        [
          `Trace${args.length ? `: ${formatArguments(args)}` : ''}`,
          ...frames
        ].join('\n')
      );
    },
    dir(value: unknown, options: Record<string, unknown> = {}) {
      write('stdout', inspect(value, { colors: true, ...options }));
    },
    dirxml(...args: unknown[]) {
      write('stdout', formatArguments(args));
    },
    table(data: unknown, properties?: readonly string[]) {
      const bundle = formatTable(data, properties);
      if (bundle) {
        host.display(bundle);
      } else {
        console.log(data);
      }
    },
    group(...label: unknown[]) {
      if (label.length) {
        write('stdout', formatArguments(label));
      }
      groupIndentation += '  ';
    },
    groupCollapsed(...label: unknown[]) {
      console.group(...label);
    },
    groupEnd() {
      groupIndentation = groupIndentation.slice(2);
    },
    time(label: unknown = 'default') {
      const name = String(label);
      if (timers.has(name)) {
        console.warn(
          `Warning: Label '${name}' already exists for console.time()`
        );
        return;
      }
      timers.set(name, host.now());
    },
    timeLog(label: unknown = 'default', ...data: unknown[]) {
      const name = String(label);
      if (!timers.has(name)) {
        console.warn(`Warning: No such label '${name}' for console.timeLog()`);
        return;
      }
      const elapsed = host.now() - timers.get(name)!;
      console.log(`${name}: ${formatDuration(elapsed)}`, ...data);
    },
    timeEnd(label: unknown = 'default') {
      const name = String(label);
      if (!timers.has(name)) {
        console.warn(`Warning: No such label '${name}' for console.timeEnd()`);
        return;
      }
      console.timeLog(name);
      timers.delete(name);
    },
    count(label: unknown = 'default') {
      const name = String(label);
      const count = (counts.get(name) ?? 0) + 1;
      counts.set(name, count);
      console.log(`${name}: ${count}`);
    },
    countReset(label: unknown = 'default') {
      counts.delete(String(label));
    },
    assert(condition?: boolean, ...data: unknown[]) {
      if (condition) {
        return;
      }
      if (typeof data[0] === 'string') {
        data[0] = `Assertion failed: ${data[0]}`;
      } else {
        data.unshift('Assertion failed');
      }
      console.error(...data);
    },
    clear() {
      host.clear(false);
    }
  };
  return console;
}
