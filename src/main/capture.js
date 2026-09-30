'use strict';
// Screenshots and the coordinate mapping between Claude's image space and the real screen.
//
// Three spaces are involved:
//   sent     - the downscaled screenshot Claude sees and answers in
//   dip      - Electron's device-independent pixels (what window positions use)
//   physical - real pixels, what the input helper moves the mouse in

const { desktopCapturer, screen } = require('electron');

const MAX_VISUAL_TOKENS = 4784;
const MAX_API_LONG_EDGE = 2576;

function fitSize(w, h, maxEdge) {
  maxEdge = Math.min(maxEdge, MAX_API_LONG_EDGE);
  let s = Math.min(1, maxEdge / Math.max(w, h));
  while (Math.ceil((w * s) / 28) * Math.ceil((h * s) / 28) > MAX_VISUAL_TOKENS) s *= 0.97;
  return { width: Math.max(1, Math.floor(w * s)), height: Math.max(1, Math.floor(h * s)) };
}

/** The screenshot cell a physical pixel falls in (integer math, so no float drift). */
function cellOf(p, sentSize, physSize) {
  return Math.floor((p * sentSize) / physSize);
}

/**
 * The physical pixel nearest the center of a screenshot cell that still belongs to that cell.
 * Fractional coordinates from the model are kept; whole ones aim at the cell's center.
 */
function centerPixel(v, sentSize, physSize) {
  const cell = Math.min(sentSize - 1, Math.max(0, Math.floor(v)));
  const frac = Number.isInteger(v) ? 0.5 : v - Math.floor(v);
  let p = Math.floor(((cell + frac) * physSize) / sentSize);
  while (p > 0 && cellOf(p, sentSize, physSize) > cell) p--;
  while (p < physSize - 1 && cellOf(p, sentSize, physSize) < cell) p++;
  return p;
}

class ScreenTarget {
  /** @param {Electron.Display} display */
  constructor(display, maxLongEdge = 1920) {
    this.display = display;
    this.bounds = display.bounds; // dip
    this.phys = {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    };
    // Physical top-left of this display. Mapping from here avoids rounding to whole logical
    // pixels, which would cost up to a pixel of accuracy at 150-200% scaling.
    this.physOrigin = process.platform === 'win32'
      ? screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y })
      : { x: display.bounds.x, y: display.bounds.y };
    this.sent = fitSize(this.phys.width, this.phys.height, maxLongEdge);
    this.decorate = null; // async (png, fraction|null) => png; adds the user's drawing, which capture can't see
  }

  async capturePng(region) {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(this.bounds.width * this.display.scaleFactor),
        height: Math.round(this.bounds.height * this.display.scaleFactor),
      },
    });
    const source = sources.find((s) => s.display_id === String(this.display.id)) || (sources.length === 1 ? sources[0] : null);
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('Could not capture the screen. Another app may be blocking screen capture.');
    }
    let img = source.thumbnail;
    const fraction = region ? {
      x0: region.x0 / this.sent.width, y0: region.y0 / this.sent.height, x1: region.x1 / this.sent.width, y1: region.y1 / this.sent.height,
    } : null;
    if (region) {
      const size = img.getSize();
      const sx = size.width / this.sent.width;
      const sy = size.height / this.sent.height;
      const rect = {
        x: Math.round(region.x0 * sx), y: Math.round(region.y0 * sy),
        width: Math.max(1, Math.round((region.x1 - region.x0) * sx)),
        height: Math.max(1, Math.round((region.y1 - region.y0) * sy)),
      };
      img = img.crop(rect);
      const fit = fitSize(rect.width, rect.height, Math.max(this.sent.width, this.sent.height));
      img = img.resize({ width: fit.width, height: fit.height, quality: 'best' });
    } else {
      img = img.resize({ width: this.sent.width, height: this.sent.height, quality: 'best' });
    }
    const png = img.toPNG();
    if (!this.decorate) return png;
    try {
      return await this.decorate(png, fraction);
    } catch {
      return png;
    }
  }

  screenshot() { return this.capturePng(null); }

  zoom([x0, y0, x1, y1]) {
    if (!(x1 > x0 && y1 > y0)) throw new Error(`Zoom region [${x0}, ${y0}, ${x1}, ${y1}] is empty`);
    return this.capturePng({
      x0: Math.max(0, x0), y0: Math.max(0, y0),
      x1: Math.min(this.sent.width, x1), y1: Math.min(this.sent.height, y1),
    });
  }

  checkSent([x, y]) {
    if (!(Number.isFinite(x) && Number.isFinite(y))) throw new Error(`Coordinate must be [x, y], got ${JSON.stringify([x, y])}`);
    if (x < 0 || y < 0 || x > this.sent.width || y > this.sent.height) {
      throw new Error(`Coordinate [${x}, ${y}] is outside the ${this.sent.width}x${this.sent.height} screenshot`);
    }
  }

  /** Screenshot pixel -> point in dip, local to this display (for drawing the overlay). */
  sentToLocalDip([x, y]) {
    this.checkSent([x, y]);
    return { x: (x * this.bounds.width) / this.sent.width, y: (y * this.bounds.height) / this.sent.height };
  }

  /** Screenshot pixel -> physical screen pixel (for the input helper). Aims at the pixel's center. */
  sentToPhysical([x, y]) {
    this.checkSent([x, y]);
    return {
      x: this.physOrigin.x + centerPixel(x, this.sent.width, this.phys.width),
      y: this.physOrigin.y + centerPixel(y, this.sent.height, this.phys.height),
    };
  }

  /** Physical screen pixel -> screenshot pixel. */
  physicalToSent(pt) {
    return {
      x: cellOf(pt.x - this.physOrigin.x, this.sent.width, this.phys.width),
      y: cellOf(pt.y - this.physOrigin.y, this.sent.height, this.phys.height),
    };
  }
}

module.exports = { ScreenTarget, fitSize };
