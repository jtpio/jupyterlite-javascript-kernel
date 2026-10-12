// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  undefinedName,
  type ErrorHint
} from '@jupyterlite/javascript-kernel-runtime';

/**
 * The globals of the pages, which the Web Workers do not have.
 */
const DOM_GLOBALS = new Set([
  'alert',
  'Audio',
  'confirm',
  'customElements',
  'document',
  'getComputedStyle',
  'HTMLCanvasElement',
  'HTMLElement',
  'HTMLImageElement',
  'Image',
  'localStorage',
  'parent',
  'sessionStorage',
  'window'
]);

/**
 * Explain where the CDN of the magic imports is set, when a package could
 * not be loaded from it.
 *
 * @param cdnSetting - Where the users set the CDN, like
 * `Settings > Settings Editor > JavaScript Kernel`.
 */
function cdnSettingHint(cdnSetting: string): ErrorHint {
  return (error, { failedImport }) => {
    const status = failedImport?.status;
    if (
      status === undefined ||
      status === null ||
      (status >= 200 && status < 300)
    ) {
      return null;
    }
    return `The packages are loaded from the CDN base URL of ${cdnSetting}.`;
  };
}

/**
 * Suggest the JavaScript (IFrame) kernel for the globals of the pages, in a
 * realm without a DOM, like the Web Worker.
 */
const domHint: ErrorHint = (error, { globalScope }) => {
  const name = undefinedName(error);
  if (name === null || !DOM_GLOBALS.has(name) || 'document' in globalScope) {
    return null;
  }
  return `${name} is not available in the JavaScript (Web Worker) kernel, which has no DOM: use Kernel > Change Kernel… > JavaScript (IFrame), or an OffscreenCanvas to draw.`;
};

/**
 * The hints of the JupyterLite kernels for the errors of the cells. The
 * failed imports point to the setting of the CDN only when the kernel has
 * one.
 *
 * @param cdnSetting - Where the users set the CDN of the magic imports.
 */
export function kernelErrorHints(cdnSetting?: string): ErrorHint[] {
  return cdnSetting ? [cdnSettingHint(cdnSetting), domHint] : [domHint];
}
