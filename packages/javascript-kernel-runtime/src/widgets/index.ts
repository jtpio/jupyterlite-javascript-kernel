// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

export * from './version';
export * from './widget';
export * from './widget_dom';
export * from './widget_layout';
export * from './widget_style';
export * from './widget_int';
export * from './widget_float';
export * from './widget_bool';
export * from './widget_selection';
export * from './widget_string';
export * from './widget_output';
export * from './widget_button';
export * from './widget_color';
export * from './widget_image';
export * from './widget_box';
export * from './widget_selectioncontainer';
export * from './widget_link';

import type { CommManager } from '../comm';

import {
  Widget,
  type BufferPath,
  type WidgetClass,
  type WidgetTraitPair
} from './widget';
import { DOMWidget } from './widget_dom';
import { Layout } from './widget_layout';
import {
  ButtonStyle,
  CheckboxStyle,
  DescriptionStyle,
  HTMLMathStyle,
  HTMLStyle,
  LabelStyle,
  ProgressStyle,
  SliderStyle,
  Style,
  TextStyle,
  ToggleButtonsStyle,
  ToggleButtonStyle
} from './widget_style';
import {
  BoundedIntText,
  IntProgress,
  IntRangeSlider,
  IntSlider,
  IntText,
  Play
} from './widget_int';
import {
  BoundedFloatText,
  FloatLogSlider,
  FloatProgress,
  FloatRangeSlider,
  FloatSlider,
  FloatText
} from './widget_float';
import { Checkbox, ToggleButton, Valid } from './widget_bool';
import {
  Dropdown,
  RadioButtons,
  Select,
  SelectionRangeSlider,
  SelectionSlider,
  SelectMultiple,
  ToggleButtons
} from './widget_selection';
import {
  Combobox,
  HTML,
  HTMLMath,
  Label,
  Password,
  Text,
  Textarea
} from './widget_string';
import { Output } from './widget_output';
import { Button } from './widget_button';
import { ColorPicker } from './widget_color';
import { Image } from './widget_image';
import { Box, GridBox, HBox, VBox } from './widget_box';
import { Accordion, Stack, Tab } from './widget_selectioncontainer';
import { DirectionalLink, Link } from './widget_link';

/**
 * All widget classes, keyed by class name.
 */
export const widgetClasses: Record<string, typeof Widget> = {
  Widget,
  DOMWidget,
  Layout,
  Style,
  DescriptionStyle,
  SliderStyle,
  ProgressStyle,
  ButtonStyle,
  CheckboxStyle,
  ToggleButtonStyle,
  ToggleButtonsStyle,
  TextStyle,
  HTMLStyle,
  HTMLMathStyle,
  LabelStyle,
  IntSlider,
  FloatSlider,
  FloatLogSlider,
  IntRangeSlider,
  FloatRangeSlider,
  Play,
  IntProgress,
  FloatProgress,
  IntText,
  FloatText,
  BoundedIntText,
  BoundedFloatText,
  Checkbox,
  ToggleButton,
  Valid,
  Dropdown,
  RadioButtons,
  Select,
  SelectMultiple,
  ToggleButtons,
  SelectionSlider,
  SelectionRangeSlider,
  Text,
  Textarea,
  Password,
  Combobox,
  Label,
  HTML,
  HTMLMath,
  Output,
  Button,
  ColorPicker,
  Image,
  Box,
  HBox,
  VBox,
  GridBox,
  Accordion,
  Tab,
  Stack,
  Link,
  DirectionalLink
};

/**
 * Create runtime-local widget classes bound to a specific comm manager.
 */
export function createWidgetClasses(
  manager: CommManager
): Record<string, unknown> {
  const classes: Record<string, unknown> = {};
  // The widgets create the default layout and style of their bound class
  const boundClasses = new Map<WidgetClass, WidgetClass>();

  for (const [name, cls] of Object.entries(widgetClasses)) {
    const BoundWidgetClass = class extends cls {};
    Object.defineProperty(BoundWidgetClass, 'name', { value: name });
    BoundWidgetClass.setDefaultManager(manager);
    BoundWidgetClass._boundClasses = boundClasses;
    boundClasses.set(cls, BoundWidgetClass);
    classes[name] = BoundWidgetClass;
  }

  const LinkClass = classes.Link as typeof Link;
  const DirectionalLinkClass =
    classes.DirectionalLink as typeof DirectionalLink;

  classes.jslink = (source: WidgetTraitPair, target: WidgetTraitPair) =>
    new LinkClass({ source, target });
  classes.jsdlink = (source: WidgetTraitPair, target: WidgetTraitPair) =>
    new DirectionalLinkClass({ source, target });

  return classes;
}

/**
 * The comm target of the widget manager of the frontend asking for the
 * state of all the widgets, like when a notebook is reopened on a running
 * kernel.
 */
export const WIDGET_CONTROL_TARGET = 'jupyter.widget.control';

/**
 * Register the comm target answering the `request_states` of the widget
 * manager of the frontend with the state of all the live widgets, in an
 * `update_states` message, like ipywidgets: a notebook reopened on a running
 * kernel shows its widgets again.
 */
export function registerWidgetControlTarget(manager: CommManager): void {
  manager.registerTarget(WIDGET_CONTROL_TARGET, comm => {
    comm.onMsg = data => {
      if (data.method !== 'request_states') {
        return;
      }
      const states: Record<string, unknown> = {};
      const buffers: ArrayBuffer[] = [];
      const bufferPaths: BufferPath[] = [];
      for (const widget of manager.getWidgets<unknown>()) {
        if (!(widget instanceof Widget)) {
          continue;
        }
        const serialized = widget._serializeFullState();
        const { state } = serialized;
        states[widget.commId] = {
          model_name: state._model_name,
          model_module: state._model_module,
          model_module_version: state._model_module_version,
          state
        };
        // The paths of the buffers start with the id of their widget
        serialized.bufferPaths.forEach((path, i) => {
          bufferPaths.push([widget.commId, 'state', ...path]);
          buffers.push(serialized.buffers[i]);
        });
      }
      comm.send(
        { method: 'update_states', states, buffer_paths: bufferPaths },
        undefined,
        buffers
      );
    };
  });
}
