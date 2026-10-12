// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type { CommManager } from '../comm';
import { isPlainObject, isThenable } from '../utils';

import { Widget, type WidgetClass } from './widget';
import { Checkbox } from './widget_bool';
import { VBox } from './widget_box';
import { Button } from './widget_button';
import { DOMWidget } from './widget_dom';
import { FloatSlider } from './widget_float';
import { IntSlider } from './widget_int';
import { Output } from './widget_output';
import { Dropdown } from './widget_selection';
import { Text } from './widget_string';

/**
 * The function of an interactive widget: it gets the values of the controls
 * in one object, by name, like `({ n, name }) => ...`.
 */
export type InteractFunction = (kwargs: Record<string, any>) => unknown;

/**
 * The options of an interactive widget, like the ones of ipywidgets.
 */
export interface IInteractOptions {
  /**
   * Whether the function only runs when the user clicks a button, false by
   * default.
   */
  manual?: boolean;

  /**
   * The label of the button of a manual interactive widget, 'Run Interact'
   * by default.
   */
  manual_name?: string;

  /**
   * Whether the value returned by the function is shown under the controls:
   * true for `interact()`, false by default for `interactive()`.
   */
  auto_display?: boolean;

  /**
   * Whether the outputs of the previous run are cleared when the function
   * runs again, true by default.
   */
  clear_output?: boolean;

  /**
   * Whether the controls made from the abbreviations, like a slider, send
   * their value while the user drags them, true by default. When false, the
   * function runs once the user releases the slider, or presses Enter in a
   * text box.
   */
  continuous_update?: boolean;
}

/**
 * A value given to the function of an interactive widget as is, without a
 * control, like `fixed()` of ipywidgets.
 */
export class Fixed {
  constructor(readonly value: unknown) {}
}

/**
 * Give a value to the function of an interactive widget as is, without a
 * control, like `interact(f, { n: [0, 10], data: fixed(rows) })`.
 */
export function fixed(value: unknown): Fixed {
  return new Fixed(value);
}

/**
 * A control of an interactive widget, or a fixed value.
 */
type Control = Widget | Fixed;

/**
 * The widgets of the controls of a function, and the output of its runs,
 * in a VBox, like `interactive` of ipywidgets.
 *
 * Each abbreviation gives a control, like ipywidgets:
 *
 * - `[min, max]` or `[min, max, step]`: an IntSlider, or a FloatSlider when
 *   one of the numbers is not an integer
 * - a number: a slider around it
 * - a boolean: a Checkbox
 * - a string: a Text
 * - an array of values or of `[label, value]` pairs, or an object of the
 *   values by label: a Dropdown
 * - a widget with a value: the widget itself
 * - `fixed(value)`: the value, without a control
 *
 * The function runs with the values of the controls, now and when one of
 * them changes, or when the button of a manual widget is clicked, with its
 * outputs (the `console`, `display()`) in an Output widget under the
 * controls, which replace the outputs of the previous run. An async function
 * is awaited, and the result of a run which ended after a newer one started
 * is dropped. The errors are shown in the Output widget.
 */
export class Interactive extends VBox {
  constructor(
    fn: InteractFunction,
    abbreviations: Record<string, unknown> = {},
    options: IInteractOptions = {}
  ) {
    checkFunction(fn);
    if (typeof abbreviations !== 'object' || abbreviations === null) {
      throw new TypeError(
        'The controls must be an object of abbreviations by name, like { n: [0, 10] }'
      );
    }
    super({ _dom_classes: ['widget-interact'] });
    this.manual = options.manual ?? false;
    this.manual_name = options.manual_name ?? 'Run Interact';

    const created: Widget[] = [];
    try {
      for (const [name, abbreviation] of Object.entries(abbreviations)) {
        const control = this._widgetFromAbbreviation(name, abbreviation);
        if (control instanceof Widget) {
          if (control !== abbreviation) {
            created.push(control);
            if (
              options.continuous_update === false &&
              'continuous_update' in control
            ) {
              control.set('continuous_update', false);
            }
          }
          if (!control.description) {
            control.description = name;
          }
        }
        this._controls.set(name, control);
      }
    } catch (error) {
      for (const widget of created) {
        widget.close();
      }
      this.close();
      throw error;
    }
    this.kwargs_widgets = [...this._controls.values()].filter(
      (control): control is Widget => control instanceof Widget
    );

    const children: Widget[] = this.kwargs_widgets.filter(
      widget => widget instanceof DOMWidget
    );
    if (this.manual) {
      this.manual_button = this._createWidget(Button, {
        description: this.manual_name
      });
      this.manual_button.onClick(() => this.update());
      children.push(this.manual_button);
    }
    this.out = this._createWidget(Output);
    children.push(this.out);
    this.children = children;
    this._runner = new _InteractRunner(this._manager, this.out, fn, () =>
      this._values()
    );
    this.auto_display = options.auto_display ?? false;
    this.clear_output = options.clear_output ?? true;

    // The function runs for every change of the controls, or on demand with
    // the button: a text box then also runs it when Enter is pressed
    for (const widget of this.kwargs_widgets) {
      if (!this.manual) {
        widget.observe(() => this.update(), 'value');
      } else if (widget instanceof Text) {
        widget.continuous_update = false;
        widget.observe(() => this.update(), 'value');
      }
    }
    if (!this.manual) {
      this.update();
    }
  }

  /**
   * The function running with the values of the controls.
   */
  get f(): InteractFunction {
    return this._runner.fn;
  }

  /**
   * The widgets of the controls, in the order of the abbreviations.
   */
  readonly kwargs_widgets: Widget[];

  /**
   * The Output widget showing the outputs of the function.
   */
  readonly out: Output;

  /**
   * The button running the function, for a manual widget.
   */
  readonly manual_button: Button | null = null;

  /**
   * Whether the function only runs when the button is clicked.
   */
  readonly manual: boolean;

  /**
   * The label of the button of a manual widget.
   */
  readonly manual_name: string;

  /**
   * Whether the value returned by the function is shown in the Output
   * widget.
   */
  get auto_display(): boolean {
    return this._runner.autoDisplay;
  }
  set auto_display(value: boolean) {
    this._runner.autoDisplay = value;
  }

  /**
   * Whether the outputs of the previous run are cleared when the function
   * runs again.
   */
  get clear_output(): boolean {
    return this._runner.clearOutput;
  }
  set clear_output(value: boolean) {
    this._runner.clearOutput = value;
  }

  /**
   * The values given to the function by its last run, by name.
   */
  get kwargs(): Record<string, unknown> {
    return this._runner.kwargs;
  }

  /**
   * The value returned by the function in its last run, awaited for an
   * async function.
   */
  get result(): unknown {
    return this._runner.result;
  }

  /**
   * Run the function with the current values of the controls, with its
   * outputs in the Output widget. The button of a manual widget is disabled
   * until the run ends, or until an interrupt.
   */
  update(): void {
    const button = this.manual_button;
    if (button) {
      button.disabled = true;
    }
    this._runner.run(() => {
      if (button) {
        button.disabled = false;
      }
    });
  }

  /**
   * The values of the controls by name, in an object of the realm of the
   * cells.
   */
  private _values(): Record<string, unknown> {
    const RealmObject = this._manager.realmConstructor('Object');
    const values = new RealmObject() as Record<string, unknown>;
    for (const [name, control] of this._controls) {
      values[name] =
        control instanceof Fixed ? control.value : valueOf(control);
    }
    return values;
  }

  /**
   * The control of an abbreviation, like ipywidgets.
   */
  private _widgetFromAbbreviation(
    name: string,
    abbreviation: unknown
  ): Control {
    if (abbreviation instanceof Fixed) {
      return abbreviation;
    }
    if (abbreviation instanceof Widget) {
      if (!hasValue(abbreviation)) {
        throw new TypeError(
          `The widget of ${name} has no value: only widgets with a value can be controls`
        );
      }
      return abbreviation;
    }
    switch (typeof abbreviation) {
      case 'string':
        return this._createWidget(Text, { value: abbreviation });
      case 'boolean':
        return this._createWidget(Checkbox, { value: abbreviation });
      case 'number':
        return this._sliderAround(name, abbreviation);
      default:
        break;
    }
    if (
      Array.isArray(abbreviation) &&
      (abbreviation.length === 2 || abbreviation.length === 3) &&
      abbreviation.every(item => typeof item === 'number')
    ) {
      return this._sliderFromRange(name, abbreviation as number[]);
    }
    if (
      isPlainObject(abbreviation) ||
      (typeof abbreviation === 'object' &&
        abbreviation !== null &&
        Symbol.iterator in abbreviation)
    ) {
      return this._createWidget(Dropdown, { options: abbreviation });
    }
    throw new TypeError(
      `${describe(abbreviation)} cannot be transformed to a widget for ${name}`
    );
  }

  /**
   * A slider of `[min, max]` or `[min, max, step]`, with its value in the
   * middle, like ipywidgets.
   */
  private _sliderFromRange(name: string, range: number[]): Widget {
    const [min, max, step] = range;
    if (!range.every(Number.isFinite)) {
      throw new RangeError(`The range of ${name} must be finite numbers`);
    }
    if (min > max) {
      throw new RangeError(
        `The range of ${name} must be [min, max]: min > max (${min} > ${max})`
      );
    }
    if (step !== undefined && step <= 0) {
      throw new RangeError(`The step of ${name} must be > 0, not ${step}`);
    }
    const integer = range.every(Number.isInteger);
    let value = integer
      ? min + Math.floor((max - min) / 2)
      : min + (max - min) / 2;
    if (step !== undefined) {
      // On a step
      value = min + Math.trunc((value - min) / step) * step;
    }
    const cls: WidgetClass = integer ? IntSlider : FloatSlider;
    return this._createWidget(cls, {
      value,
      min,
      max,
      ...(step !== undefined ? { step } : {})
    });
  }

  /**
   * A slider for a number, from -value to 3 * value, like ipywidgets.
   */
  private _sliderAround(name: string, value: number): Widget {
    if (!Number.isFinite(value)) {
      throw new RangeError(`The value of ${name} must be a finite number`);
    }
    const [min, max] =
      value === 0
        ? [0, 1]
        : value > 0
          ? [-value, 3 * value]
          : [3 * value, -value];
    const cls: WidgetClass = Number.isInteger(value) ? IntSlider : FloatSlider;
    return this._createWidget(cls, {
      value,
      min,
      max
    });
  }

  private _controls = new Map<string, Control>();
  private _runner: _InteractRunner;
}

/**
 * Runs the function of an interactive widget with its outputs in an Output
 * widget, which the outputs of each run replace.
 *
 * @internal
 */
export class _InteractRunner {
  constructor(
    manager: CommManager,
    out: Output,
    readonly fn: InteractFunction,
    values: () => Record<string, unknown>
  ) {
    this._manager = manager;
    this._out = out;
    this._values = values;
  }

  /**
   * Whether the value returned by the function is shown in the Output.
   */
  autoDisplay = false;

  /**
   * Whether the outputs of the previous run are cleared.
   */
  clearOutput = true;

  /**
   * The values given to the function by its last run.
   */
  kwargs: Record<string, unknown> = {};

  /**
   * The value returned by the function in its last run.
   */
  result: unknown = undefined;

  /**
   * Run the function, in the Output widget. An async function is awaited:
   * the result of a run which ends after a newer run started is dropped.
   *
   * @param ended - Called when the last run ended, or when an interrupt
   * stopped waiting for it.
   */
  run(ended?: () => void): void {
    const run = ++this._runs;
    const end = (): void => {
      if (run === this._runs) {
        ended?.();
      }
    };
    const show = (value: unknown): void => {
      if (run !== this._runs) {
        return;
      }
      this.result = value;
      if (this.autoDisplay && value !== undefined && value !== null) {
        this._manager.publish({
          type: 'display_data',
          bundle: {
            data: this._manager.mimeBundle(value),
            metadata: {},
            transient: {}
          }
        });
      }
    };
    const captured = this._out.capture(
      () => {
        let result: unknown;
        try {
          this.kwargs = this._values();
          result = this.fn(this.kwargs);
        } catch (error) {
          end();
          // Shown in the Output widget, while it captures the outputs
          this._manager.reportError(error);
          return;
        }
        if (!isThenable(result)) {
          show(result);
          end();
          return;
        }
        // An interrupt ends the run, whose promise may then never settle,
        // like when it waits for a timer
        const settled = this._manager.addWait(end);
        // The outputs after an await go to the Output widget too
        return Promise.resolve(result).then(
          value => {
            settled();
            show(value);
            end();
          },
          (error: unknown) => {
            settled();
            end();
            this._manager.reportError(error, true);
          }
        );
      },
      { clearOutput: this.clearOutput, wait: true }
    );
    captured();
  }

  private _manager: CommManager;
  private _out: Output;
  private _values: () => Record<string, unknown>;
  private _runs = 0;
}

/**
 * The Output widget of a function running with the values of some existing
 * controls, now and when one of them changes, like `interactive_output()`
 * of ipywidgets: the controls are laid out apart, like in an HBox.
 *
 * @param OutputClass - The class of the Output widget, bound to `manager`.
 *
 * @internal
 */
export function _interactiveOutput(
  manager: CommManager,
  OutputClass: typeof Output,
  fn: InteractFunction,
  controls: Record<string, Widget>
): Output {
  checkFunction(fn);
  if (typeof controls !== 'object' || controls === null) {
    throw new TypeError('The controls must be an object of widgets by name');
  }
  const entries = Object.entries(controls);
  for (const [name, control] of entries) {
    if (!(control instanceof Widget) || !hasValue(control)) {
      throw new TypeError(
        `The control of ${name} must be a widget with a value`
      );
    }
  }
  const out = new OutputClass();
  const runner = new _InteractRunner(manager, out, fn, () => {
    const RealmObject = manager.realmConstructor('Object');
    const values = new RealmObject() as Record<string, unknown>;
    for (const [name, control] of entries) {
      values[name] = valueOf(control);
    }
    return values;
  });
  for (const [, control] of entries) {
    control.observe(() => runner.run(), 'value');
  }
  runner.run();
  return out;
}

/**
 * Whether a widget has a value, like a `ValueWidget` of ipywidgets.
 */
function hasValue(widget: Widget): boolean {
  return 'value' in widget;
}

/**
 * The value of a widget, through its accessor, like the value of a
 * selection widget, derived from its index.
 */
function valueOf(widget: Widget): unknown {
  return (widget as unknown as { value: unknown }).value;
}

/**
 * Check the function of an interactive widget.
 */
function checkFunction(fn: unknown): void {
  if (typeof fn !== 'function') {
    throw new TypeError(
      'The first argument must be the function to run with the values of the controls'
    );
  }
}

/**
 * A short description of a value, for the errors.
 */
function describe(value: unknown): string {
  if (typeof value === 'function') {
    return 'A function';
  }
  if (typeof value === 'object' && value !== null) {
    return 'This object';
  }
  return String(value);
}
