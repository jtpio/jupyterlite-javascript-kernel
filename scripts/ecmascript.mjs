// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * Check that the ECMAScript edition reported by the kernel is the latest
 * edition known to the installed acorn parser.
 *
 * The kernel parses the cells with acorn and `ecmaVersion: 'latest'`, so the
 * edition it accepts is the latest one of acorn. acorn does not expose it at
 * runtime: it is read from the `ecmaVersion` type of its declarations.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = resolve(root, 'packages', 'javascript-kernel-runtime');
const executor = resolve(packageDir, 'src', 'executor.ts');

const require = createRequire(resolve(packageDir, 'package.json'));
const acornDir = dirname(require.resolve('acorn/package.json'));
const { version: acornVersion } = JSON.parse(
  readFileSync(resolve(acornDir, 'package.json'), 'utf-8')
);
const declarations = readFileSync(
  resolve(acornDir, 'dist', 'acorn.d.ts'),
  'utf-8'
);
const ecmaVersion = declarations.match(/export type ecmaVersion = ([^\n]+)/);
if (!ecmaVersion) {
  console.error(`Cannot find the ecmaVersion type of acorn ${acornVersion}`);
  process.exit(1);
}
const latest = Math.max(
  ...(ecmaVersion[1].match(/\b\d{4}\b/g) ?? []).map(Number)
);

const edition = readFileSync(executor, 'utf-8').match(
  /export const ECMASCRIPT_EDITION = (\d+);/
);
if (!edition) {
  console.error('Cannot find ECMASCRIPT_EDITION in executor.ts');
  process.exit(1);
}

if (Number(edition[1]) !== latest) {
  console.error(
    `ECMASCRIPT_EDITION is ${edition[1]}, but acorn ${acornVersion} parses ` +
      `ES${latest}: update ECMASCRIPT_EDITION in executor.ts`
  );
  process.exit(1);
}
console.log(`ECMASCRIPT_EDITION matches acorn ${acornVersion} (ES${latest})`);
