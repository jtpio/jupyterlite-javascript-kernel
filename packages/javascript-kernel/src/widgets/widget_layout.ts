// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Widget } from './widget';
import { BASE_MODULE, BASE_MODULE_VERSION } from './version';

export class Layout extends Widget {
  static override modelName = 'LayoutModel';
  static override viewName = 'LayoutView';
  static override modelModule = BASE_MODULE;
  static override modelModuleVersion = BASE_MODULE_VERSION;
  static override viewModule = BASE_MODULE;
  static override viewModuleVersion = BASE_MODULE_VERSION;

  protected override _defaults(): Record<string, unknown> {
    return {};
  }
}
