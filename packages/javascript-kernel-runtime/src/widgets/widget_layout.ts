// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Widget } from './widget';
import { BASE_MODULE, BASE_MODULE_VERSION } from './version';

/**
 * The CSS properties of a layout, like ipywidgets: `border` is a shortcut
 * for the four borders.
 */
const LAYOUT_PROPERTIES = [
  'align_content',
  'align_items',
  'align_self',
  'border_top',
  'border_right',
  'border_bottom',
  'border_left',
  'bottom',
  'display',
  'flex',
  'flex_flow',
  'height',
  'justify_content',
  'justify_items',
  'left',
  'margin',
  'max_height',
  'max_width',
  'min_height',
  'min_width',
  'overflow',
  'order',
  'padding',
  'right',
  'top',
  'visibility',
  'width',
  'object_fit',
  'object_position',
  'grid_auto_columns',
  'grid_auto_flow',
  'grid_auto_rows',
  'grid_gap',
  'grid_template_rows',
  'grid_template_columns',
  'grid_template_areas',
  'grid_row',
  'grid_column',
  'grid_area'
];

const BORDER_SIDES = ['top', 'right', 'bottom', 'left'];

/**
 * The layout of a widget: its CSS properties, null for the default ones,
 * like `new Layout({ width: '200px', border: '1px solid gray' })` or
 * `widget.layout.width = '200px'`.
 */
export class Layout extends Widget {
  static override modelName = 'LayoutModel';
  static override viewName = 'LayoutView';
  static override modelModule = BASE_MODULE;
  static override modelModuleVersion = BASE_MODULE_VERSION;
  static override viewModule = BASE_MODULE;
  static override viewModuleVersion = BASE_MODULE_VERSION;

  // The accessors of the properties are defined from the default state
  declare align_content: string | null;
  declare align_items: string | null;
  declare align_self: string | null;
  declare border_top: string | null;
  declare border_right: string | null;
  declare border_bottom: string | null;
  declare border_left: string | null;
  declare bottom: string | null;
  declare display: string | null;
  declare flex: string | null;
  declare flex_flow: string | null;
  declare height: string | null;
  declare justify_content: string | null;
  declare justify_items: string | null;
  declare left: string | null;
  declare margin: string | null;
  declare max_height: string | null;
  declare max_width: string | null;
  declare min_height: string | null;
  declare min_width: string | null;
  declare overflow: string | null;
  declare order: string | null;
  declare padding: string | null;
  declare right: string | null;
  declare top: string | null;
  declare visibility: string | null;
  declare width: string | null;
  declare object_fit: string | null;
  declare object_position: string | null;
  declare grid_auto_columns: string | null;
  declare grid_auto_flow: string | null;
  declare grid_auto_rows: string | null;
  declare grid_gap: string | null;
  declare grid_template_rows: string | null;
  declare grid_template_columns: string | null;
  declare grid_template_areas: string | null;
  declare grid_row: string | null;
  declare grid_column: string | null;
  declare grid_area: string | null;

  protected override _defaults(): Record<string, unknown> {
    return Object.fromEntries(LAYOUT_PROPERTIES.map(name => [name, null]));
  }

  /**
   * The border of the four sides, or null when they differ.
   */
  get border(): string | null {
    const [first, ...others] = BORDER_SIDES.map(
      side => this.get(`border_${side}`) as string | null
    );
    return others.every(border => border === first) ? first : null;
  }
  set border(v: string | null) {
    this.set('border', v);
  }

  protected override _validate(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    super._validate(state, names);
    if (Object.prototype.hasOwnProperty.call(state, 'border')) {
      // The borders given for a side win over the shortcut
      for (const side of BORDER_SIDES) {
        if (!names.has(`border_${side}`)) {
          state[`border_${side}`] = state.border;
        }
      }
      delete state.border;
    }
  }
}
