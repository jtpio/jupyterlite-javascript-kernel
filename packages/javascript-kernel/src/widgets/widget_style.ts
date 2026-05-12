// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Widget } from './widget';
import {
  BASE_MODULE,
  BASE_MODULE_VERSION,
  CONTROLS_MODULE,
  CONTROLS_MODULE_VERSION
} from './version';

export class Style extends Widget {
  static override modelName = 'StyleModel';
  static override viewName = 'StyleView';
  static override modelModule = BASE_MODULE;
  static override modelModuleVersion = BASE_MODULE_VERSION;
  static override viewModule = BASE_MODULE;
  static override viewModuleVersion = BASE_MODULE_VERSION;

  protected override _defaults(): Record<string, unknown> {
    return {};
  }
}

export class DescriptionStyle extends Style {
  static override modelName = 'DescriptionStyleModel';
  static override modelModule = CONTROLS_MODULE;
  static override modelModuleVersion = CONTROLS_MODULE_VERSION;
}

export class SliderStyle extends DescriptionStyle {
  static override modelName = 'SliderStyleModel';
}

export class ProgressStyle extends DescriptionStyle {
  static override modelName = 'ProgressStyleModel';
}

export class ButtonStyle extends Style {
  static override modelName = 'ButtonStyleModel';
  static override modelModule = CONTROLS_MODULE;
  static override modelModuleVersion = CONTROLS_MODULE_VERSION;
}

export class CheckboxStyle extends DescriptionStyle {
  static override modelName = 'CheckboxStyleModel';
}

export class ToggleButtonStyle extends DescriptionStyle {
  static override modelName = 'ToggleButtonStyleModel';
}

export class ToggleButtonsStyle extends DescriptionStyle {
  static override modelName = 'ToggleButtonsStyleModel';
}

export class TextStyle extends DescriptionStyle {
  static override modelName = 'TextStyleModel';
}

export class HTMLStyle extends Style {
  static override modelName = 'HTMLStyleModel';
  static override modelModule = CONTROLS_MODULE;
  static override modelModuleVersion = CONTROLS_MODULE_VERSION;
}

export class HTMLMathStyle extends Style {
  static override modelName = 'HTMLMathStyleModel';
  static override modelModule = CONTROLS_MODULE;
  static override modelModuleVersion = CONTROLS_MODULE_VERSION;
}

export class LabelStyle extends Style {
  static override modelName = 'LabelStyleModel';
  static override modelModule = CONTROLS_MODULE;
  static override modelModuleVersion = CONTROLS_MODULE_VERSION;
}
