'use strict';
// Executes the computer toolset's member tools (screenshot, clicks, typing, keys, scrolling...).

const CLICKS = {
  left_click: ['left', 1], right_click: ['right', 1], middle_click: ['middle', 1],
  double_click: ['left', 2], triple_click: ['left', 3],
};
const POINTER_LABELS = {
  left_click: 'clicking here', right_click: 'right-clicking', middle_click: 'clicking here',
  double_click: 'double-clicking', triple_click: 'selecting', left_click_drag: 'dragging from here',
  mouse_move: 'over here', scroll: 'scrolling', left_mouse_down: 'pressing here',
};
const READ_ONLY = new Set(['screenshot', 'zoom', 'cursor_position', 'wait']);
const MAX_WAIT_S = 60;
const SETTLE_MS = 400;
const DRAG_STEPS = 20;

class StoppedError extends Error {}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new StoppedError('Stopped'));
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new StoppedError('Stopped')); }, { once: true });
  });
}

function isRisky(name, input) {
  if (name === 'key' || name === 'hold_key') {
    const alias = { return: 'enter', kp_enter: 'enter', del: 'delete', control: 'ctrl' };
    const keys = new Set(String(input.text || '').toLowerCase().split('+').map((k) => alias[k.trim()] || k.trim()));
    if (['enter', 'delete', 'backspace'].some((k) => keys.has(k))) return true;
    if ((keys.has('alt') && keys.has('f4')) || (keys.has('ctrl') && keys.has('w'))) return true;
    if (keys.has('shift') && keys.has('delete')) return true;
  }
  return name === 'type' && String(input.text || '').includes('\n');
}

function describeAction(name, input) {
  switch (name) {
    case 'type': {
      const t = String(input.text || '');
      return `Type "${t.length > 60 ? `${t.slice(0, 57)}…` : t}"`;
    }
    case 'key': return `Press ${String(input.text || '').replace(/\+/g, ' + ')}`;
    case 'hold_key': return `Hold ${input.text} for ${input.duration}s`;
    case 'left_click_drag': return 'Drag with the mouse';
    case 'scroll': return `Scroll ${input.scroll_direction || ''}`.trim();
    default: return name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }
}

class ComputerExecutor {
  /**
   * @param {object} deps
   *   input      InputHelper
   *   pointAt    async ({x, y, label}) => void   flies the buddy to a spot before the real cursor moves
   */
  constructor({ input, pointAt }) {
    this.input = input;
    this.pointAt = pointAt;
  }

  /** Validate coordinates before anything happens, so a bad call has no side effects. */
  validate(screen, name, input) {
    if (input.coordinate != null) screen.checkSent(input.coordinate);
    if (name === 'left_click_drag') {
      if (!input.start_coordinate || !input.coordinate) throw new Error('left_click_drag needs start_coordinate and coordinate');
      screen.checkSent(input.start_coordinate);
    }
    if (name === 'mouse_move' && !input.coordinate) throw new Error('Missing coordinate');
    if ((name === 'key' || name === 'hold_key') && !input.text) throw new Error('Missing text');
    if (name === 'type' && typeof input.text !== 'string') throw new Error('Missing text');
  }

  async run(screen, name, input, signal) {
    if (name === 'screenshot') return [await screen.screenshot()];
    if (name === 'zoom') {
      if (!Array.isArray(input.region) || input.region.length !== 4) throw new Error('region must be [x0, y0, x1, y1]');
      return [await screen.zoom(input.region.map(Number))];
    }
    if (name === 'cursor_position') {
      const p = screen.physicalToSent(await this.input.cursor());
      return `X=${p.x}, Y=${p.y}`;
    }
    if (name === 'wait') {
      await sleep(Math.min(Number(input.duration) || 1, MAX_WAIT_S) * 1000, signal);
      return 'OK';
    }

    const moveTo = async (coord) => {
      const local = screen.sentToLocalDip(coord);
      await this.pointAt({ ...local, label: POINTER_LABELS[name] || '' });
      if (signal.aborted) throw new StoppedError('Stopped');
      const phys = screen.sentToPhysical(coord);
      await this.input.move(phys.x, phys.y);
    };
    const withModifiers = async (fn) => {
      const mods = input.text ? String(input.text) : '';
      if (mods) await this.input.keyDown(mods);
      try {
        return await fn();
      } finally {
        if (mods) await this.input.keyUp(mods);
      }
    };

    if (CLICKS[name]) {
      const [button, count] = CLICKS[name];
      if (input.coordinate) await moveTo(input.coordinate);
      await withModifiers(() => this.input.click(button, count));
    } else if (name === 'left_click_drag') {
      await moveTo(input.start_coordinate);
      const end = screen.sentToPhysical(input.coordinate);
      await withModifiers(async () => {
        await this.input.mouseDown('left');
        try {
          const start = await this.input.cursor();
          // Glide in steps so apps see a drag rather than a jump.
          for (let i = 1; i <= DRAG_STEPS; i++) {
            await this.input.move(start.x + ((end.x - start.x) * i) / DRAG_STEPS, start.y + ((end.y - start.y) * i) / DRAG_STEPS);
            await sleep(15);
          }
        } finally {
          await this.input.mouseUp('left');
        }
      });
    } else if (name === 'mouse_move') {
      await moveTo(input.coordinate);
    } else if (name === 'left_mouse_down' || name === 'left_mouse_up') {
      if (input.coordinate) await moveTo(input.coordinate);
      await (name === 'left_mouse_down' ? this.input.mouseDown('left') : this.input.mouseUp('left'));
    } else if (name === 'scroll') {
      const dir = input.scroll_direction;
      if (!['up', 'down', 'left', 'right'].includes(dir)) throw new Error(`scroll_direction must be up/down/left/right, got ${dir}`);
      if (input.coordinate) await moveTo(input.coordinate);
      const amount = Math.max(1, Math.min(Number(input.scroll_amount) || 3, 50));
      await withModifiers(() => this.input.scroll(
        dir === 'left' ? -amount : dir === 'right' ? amount : 0,
        dir === 'up' ? amount : dir === 'down' ? -amount : 0,
      ));
    } else if (name === 'type') {
      await this.input.type(input.text);
    } else if (name === 'key') {
      await this.input.keys(String(input.text), Math.max(1, Math.min(Number(input.repeat) || 1, 100)));
    } else if (name === 'hold_key') {
      await this.input.keyDown(String(input.text));
      try {
        await sleep(Math.min(Number(input.duration) || 1, MAX_WAIT_S) * 1000, signal);
      } finally {
        await this.input.keyUp(String(input.text));
      }
    } else {
      throw new Error(`Unsupported action: ${name}`);
    }
    await sleep(SETTLE_MS, signal);
    return 'OK';
  }
}

module.exports = { ComputerExecutor, StoppedError, READ_ONLY, isRisky, describeAction, sleep };
