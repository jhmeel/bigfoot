'use strict';
// Computer control as an ordinary function, for providers without a native computer tool.
// The executor is shared with Claude's toolset, so the action names match its members.

const ACTIONS = [
  'screenshot', 'zoom', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll', 'type', 'key',
  'hold_key', 'wait', 'cursor_position',
];

function computerFunction(width, height) {
  return {
    name: 'computer',
    description: `Control the user's screen, mouse, and keyboard. The screen is ${width}x${height} pixels; every coordinate is in that space, measured from the top-left of the latest screenshot. Take a screenshot first, and end each group of actions with one to check the result.
Actions: screenshot; zoom (region [x0,y0,x1,y1] for a closer look); left_click, right_click, middle_click, double_click, triple_click (coordinate; text = modifier keys to hold, e.g. "ctrl"); mouse_move (coordinate); left_click_drag (start_coordinate to coordinate, for drag and drop); left_mouse_down / left_mouse_up; scroll (coordinate, scroll_direction up/down/left/right, scroll_amount); type (text); key (text = a key or combo like "ctrl+c", "alt+tab", "Return"; repeat); hold_key (text, duration); wait (duration seconds); cursor_position.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS },
        coordinate: { type: 'array', items: { type: 'number' }, description: '[x, y]' },
        start_coordinate: { type: 'array', items: { type: 'number' }, description: '[x, y] where a drag starts' },
        region: { type: 'array', items: { type: 'number' }, description: '[x0, y0, x1, y1] for zoom' },
        text: { type: 'string' },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'number' },
        duration: { type: 'number' },
        repeat: { type: 'number' },
      },
      required: ['action'],
    },
  };
}

/** Split a "computer" call into the executor's (name, input). */
function toComputerCall(args) {
  const { action, ...input } = args || {};
  if (!ACTIONS.includes(action)) throw new Error(`Unknown computer action "${action}"`);
  return { name: action, input };
}

/** JSON Schema minus keywords some function-calling APIs reject. */
function portableSchema(schema) {
  if (Array.isArray(schema)) return schema.map(portableSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === 'minItems' || k === 'maxItems' || k === '$schema') continue;
    out[k] = portableSchema(v);
  }
  return out;
}

module.exports = { computerFunction, toComputerCall, portableSchema, ACTIONS };
