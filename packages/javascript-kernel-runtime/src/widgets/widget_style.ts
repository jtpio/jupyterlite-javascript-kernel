// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Widget } from './widget';
import {
  BASE_MODULE,
  BASE_MODULE_VERSION,
  CONTROLS_MODULE,
  CONTROLS_MODULE_VERSION
} from './version';

// The accessors of the properties of the styles are defined from their
// default state, and typed by their declarations

/**
 * The properties of the fonts of the styles, null for the default ones.
 */
const FONT = {
  font_family: null,
  font_size: null,
  font_style: null,
  font_variant: null,
  font_weight: null,
  text_color: null,
  text_decoration: null
};

/**
 * The style of a widget, like `{ description_width: 'initial' }`.
 */
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

  declare description_width: string;

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), description_width: '' };
  }
}

export class SliderStyle extends DescriptionStyle {
  static override modelName = 'SliderStyleModel';

  declare handle_color: string | null;

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), handle_color: null };
  }
}

export class ProgressStyle extends DescriptionStyle {
  static override modelName = 'ProgressStyleModel';

  declare bar_color: string | null;

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), bar_color: null };
  }
}

export class ButtonStyle extends Style {
  static override modelName = 'ButtonStyleModel';
  static override modelModule = CONTROLS_MODULE;
  static override modelModuleVersion = CONTROLS_MODULE_VERSION;

  declare button_color: string | null;
  declare font_family: string | null;
  declare font_size: string | null;
  declare font_style: string | null;
  declare font_variant: string | null;
  declare font_weight: string | null;
  declare text_color: string | null;
  declare text_decoration: string | null;

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), button_color: null, ...FONT };
  }
}

export class CheckboxStyle extends DescriptionStyle {
  static override modelName = 'CheckboxStyleModel';

  declare background: string | null;

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), background: null };
  }
}

export class ToggleButtonStyle extends DescriptionStyle {
  static override modelName = 'ToggleButtonStyleModel';

  declare font_family: string | null;
  declare font_size: string | null;
  declare font_style: string | null;
  declare font_variant: string | null;
  declare font_weight: string | null;
  declare text_color: string | null;
  declare text_decoration: string | null;

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), ...FONT };
  }
}

export class ToggleButtonsStyle extends DescriptionStyle {
  static override modelName = 'ToggleButtonsStyleModel';

  declare button_width: string;
  declare font_weight: string;

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), button_width: '', font_weight: '' };
  }
}

/**
 * The style of the text widgets.
 */
class _StringStyle extends DescriptionStyle {
  declare background: string | null;
  declare font_size: string | null;
  declare text_color: string | null;
  protected override _defaults(): Record<string, unknown> {
    return {
      ...super._defaults(),
      background: null,
      font_size: null,
      text_color: null
    };
  }
}

export class TextStyle extends _StringStyle {
  static override modelName = 'TextStyleModel';
}

export class HTMLStyle extends _StringStyle {
  static override modelName = 'HTMLStyleModel';
}

export class HTMLMathStyle extends _StringStyle {
  static override modelName = 'HTMLMathStyleModel';
}

export class LabelStyle extends _StringStyle {
  static override modelName = 'LabelStyleModel';

  declare font_family: string | null;
  declare font_style: string | null;
  declare font_variant: string | null;
  declare font_weight: string | null;
  declare text_decoration: string | null;

  protected override _defaults(): Record<string, unknown> {
    return { ...super._defaults(), ...FONT };
  }
}
