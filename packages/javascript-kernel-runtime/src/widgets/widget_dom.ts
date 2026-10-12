// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { isPlainObject } from '../utils';

import {
  Widget,
  type WidgetClass,
  _deserializeWidgetReference,
  _serializeWidgetReference
} from './widget';
import { Layout } from './widget_layout';
import { Style } from './widget_style';

/**
 * A widget with a view in the frontend, a layout and a style.
 *
 * Like ipywidgets, a plain object given as `layout` or `style`, to the
 * constructor or to the accessors, becomes a `Layout` or a style of the
 * `styleClass` of the widget, and the widget gets default ones, so that
 * `widget.layout.width = '200px'` works.
 */
export class DOMWidget extends Widget {
  /**
   * The class of the style of the widget, like `SliderStyle`, or null when
   * the widget has no style, like a box.
   */
  static styleClass: WidgetClass<Style> | null = null;

  protected override _defaults(): Record<string, unknown> {
    return {
      ...super._defaults(),
      layout: null,
      style: null,
      _dom_classes: [],
      tabbable: null,
      tooltip: null
    };
  }

  get layout(): Layout {
    return this.get('layout') as Layout;
  }
  set layout(v: Layout | Record<string, unknown> | null) {
    this.set('layout', v);
  }

  get style(): Style | null {
    return (this.get('style') as Style | null) ?? null;
  }
  set style(v: Style | Record<string, unknown> | null) {
    this.set('style', v);
  }

  /**
   * The tooltip of the widget, shown when the pointer is over it.
   */
  get tooltip(): string | null {
    return this.get('tooltip') as string | null;
  }
  set tooltip(v: string | null) {
    this.set('tooltip', v);
  }

  /**
   * Whether the widget can be focused with the Tab key, null for the
   * default of the widget.
   */
  get tabbable(): boolean | null {
    return this.get('tabbable') as boolean | null;
  }
  set tabbable(v: boolean | null) {
    this.set('tabbable', v);
  }

  /**
   * Add a CSS class to the view of the widget.
   */
  addClass(className: string): this {
    const classes = this.get('_dom_classes') as string[];
    if (!classes.includes(className)) {
      this.set('_dom_classes', [...classes, className]);
    }
    return this;
  }

  /**
   * Remove a CSS class from the view of the widget.
   */
  removeClass(className: string): this {
    const classes = this.get('_dom_classes') as string[];
    if (classes.includes(className)) {
      this.set(
        '_dom_classes',
        classes.filter(name => name !== className)
      );
    }
    return this;
  }

  protected override _validate(
    state: Record<string, unknown>,
    names: ReadonlySet<string>
  ): void {
    super._validate(state, names);
    // The layout and the style created here are closed by `Widget` when the
    // state is rejected, here or by a subclass
    state.layout = this._toWidget('layout', state.layout, Layout);
    const styleClass = (this.constructor as typeof DOMWidget).styleClass;
    if (styleClass || (state.style !== null && state.style !== undefined)) {
      state.style = this._toWidget('style', state.style, styleClass ?? Style);
    }
  }

  protected override _serializeProperty(name: string, value: unknown): unknown {
    if (
      (name === 'layout' || name === 'style') &&
      (value instanceof Widget || value === null)
    ) {
      return _serializeWidgetReference(value);
    }
    return super._serializeProperty(name, value);
  }

  protected override _deserializeProperty(
    name: string,
    value: unknown
  ): unknown {
    if (name === 'layout' || name === 'style') {
      return _deserializeWidgetReference(this._manager, value);
    }
    return super._deserializeProperty(name, value);
  }

  /**
   * The widget of a layout or a style: the widget itself, a new one from a
   * plain object, or a default one.
   */
  private _toWidget(
    name: string,
    value: unknown,
    cls: WidgetClass<Layout | Style>
  ): Widget {
    if (value instanceof Widget) {
      return value;
    }
    if (value === null || value === undefined) {
      return this._createWidget(cls);
    }
    if (isPlainObject(value)) {
      return this._createWidget(cls, value as Record<string, unknown>);
    }
    throw new TypeError(
      `The ${name} of a widget must be a widget or a plain object of its properties`
    );
  }
}
