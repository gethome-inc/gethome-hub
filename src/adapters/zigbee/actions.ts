/**
 * Zigbee2MQTT `action` parsing — turns the flat vendor action vocabulary
 * ("single", "double_left", "button_3_hold", "flip90") into the canonical
 * event model: a button inventory the apps can render, and per-event
 * (button, gesture) pairs.
 *
 * Aqara devices are the baseline (wireless switches, Opple remotes, the cube,
 * vibration sensors), but the same grammar covers IKEA, Hue, Tuya and SONOFF
 * remotes: a gesture token prefixed or suffixed with a button name.
 */

export interface ParsedAction {
  /** Button id — "main" for single-button devices. */
  button: string;
  /** Gesture id: single, double, triple, hold, release, shake, flip90… */
  gesture: string;
}

export interface ButtonDescriptor {
  id: string;
  label: string;
  gestures: string[];
}

/**
 * Gestures that appear standalone or as a prefix/suffix around a button name.
 * Compound tokens (press_release) must run before their tails (release), so
 * matching is longest-first.
 */
const GESTURE_TOKENS = [
  'press_release',
  'hold_release',
  'double_press',
  'triple_press',
  'long_press',
  'long_release',
  'short_release',
  'double_click',
  'long_click',
  'quadruple',
  'quintuple',
  'single',
  'double',
  'triple',
  'many',
  'hold',
  'release',
  'press',
  'click',
  'tap',
] as const;

/** Standalone actions that are whole gestures on the main button. */
const STANDALONE_GESTURES = new Set<string>([
  ...GESTURE_TOKENS,
  // Aqara cube / vibration / misc
  'shake',
  'throw',
  'wakeup',
  'fall',
  'slide',
  'flip90',
  'flip180',
  'rotate_left',
  'rotate_right',
  'vibration',
  'tilt',
  'drop',
  'toggle',
  'on',
  'off',
  'stop',
  'open',
  'close',
]);

/** Parse one action value into (button, gesture). Never throws. */
export function parseAction(value: string): ParsedAction {
  const action = value.trim();
  if (action === '') return { button: 'main', gesture: 'unknown' };

  if (STANDALONE_GESTURES.has(action)) {
    return { button: 'main', gesture: action };
  }

  // "<button>_<gesture>" — left_single, button_1_hold, arrow_left_click.
  for (const gesture of GESTURE_TOKENS) {
    if (action.endsWith(`_${gesture}`)) {
      return { button: stripButtonPrefix(action.slice(0, -(gesture.length + 1))), gesture };
    }
  }

  // "<gesture>_<button>" — single_left, double_both, hold_right (Aqara).
  for (const gesture of GESTURE_TOKENS) {
    if (action.startsWith(`${gesture}_`)) {
      return { button: stripButtonPrefix(action.slice(gesture.length + 1)), gesture };
    }
  }

  return { button: 'main', gesture: action };
}

function stripButtonPrefix(button: string): string {
  return button.startsWith('button_') ? button.slice('button_'.length) : button;
}

/**
 * Build the button inventory from an `action` expose's declared values,
 * preserving first-seen order of buttons and of gestures within a button.
 */
export function buttonInventory(values: string[]): ButtonDescriptor[] {
  const buttons = new Map<string, ButtonDescriptor>();
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const { button, gesture } = parseAction(value);
    let descriptor = buttons.get(button);
    if (!descriptor) {
      descriptor = { id: button, label: buttonLabel(button), gestures: [] };
      buttons.set(button, descriptor);
    }
    if (!descriptor.gestures.includes(gesture)) descriptor.gestures.push(gesture);
  }
  return [...buttons.values()].slice(0, 32);
}

/** "1" → "Button 1", "left" → "Left", "arrow_left" → "Arrow left". */
function buttonLabel(id: string): string {
  if (id === 'main') return 'Button';
  if (/^\d+$/.test(id)) return `Button ${id}`;
  const words = id.split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
