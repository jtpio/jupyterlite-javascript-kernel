// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

export * from './version';
export * from './widget';
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
export * from './widget_box';
export * from './widget_selectioncontainer';
export * from './widget_link';

import type { CommManager } from '../comm';

import { DOMWidget, Widget, type WidgetTraitPair } from './widget';
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

  for (const [name, cls] of Object.entries(widgetClasses)) {
    const BoundWidgetClass = class extends cls {};
    Object.defineProperty(BoundWidgetClass, 'name', { value: name });
    BoundWidgetClass.setDefaultManager(manager);
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
