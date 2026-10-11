// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * Generate packages/javascript-kernel/src/version.ts from the version in
 * packages/javascript-kernel/package.json.
 *
 * Usage:
 *   node scripts/version.mjs          write the file
 *   node scripts/version.mjs --check  exit with 1 when the file is stale
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = resolve(root, 'packages', 'javascript-kernel');
const target = resolve(packageDir, 'src', 'version.ts');

const { version } = JSON.parse(
  readFileSync(resolve(packageDir, 'package.json'), 'utf-8')
);

const content = `// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// Generated from package.json by scripts/version.mjs: do not edit.

/**
 * The version of the @jupyterlite/javascript-kernel package.
 */
export const KERNEL_VERSION = '${version}';
`;

const name = relative(root, target);

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf-8');
  } catch {
    // A missing file is stale too
  }
  if (current !== content) {
    console.error(
      `${name} does not match the package version ${version}: run jlpm version:sync`
    );
    process.exit(1);
  }
  console.log(`${name} matches the package version ${version}`);
} else {
  writeFileSync(target, content);
  console.log(`Wrote ${name} with the package version ${version}`);
}
