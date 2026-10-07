// Masking: what never reaches the support agent's screen.
//
// The tab is captured as pixels (getDisplayMedia), so a sensitive field is
// hidden by painting over it in every frame before the frame is sent: the
// shared track is a canvas the embed draws, never the raw capture.
//
// Masked: any element with `data-gaiadesk-mask` (and so everything inside
// it), every `<input type="password">`, and inputs whose autocomplete says
// they hold a secret (one-time codes, card numbers and codes). Rectangles are
// padded and kept for a few frames, so a field that just scrolled is still
// covered where the (slightly older) captured frame shows it.

/** The selector for elements that are always masked. */
export const MASK_SELECTOR =
  '[data-gaiadesk-mask], input[type="password" i], input[autocomplete~="one-time-code" i], input[autocomplete~="cc-number" i], input[autocomplete~="cc-csc" i], input[autocomplete~="current-password" i], input[autocomplete~="new-password" i]';

/** CSS pixels added around every masked rectangle. */
export const MASK_PAD = 6;
/** Frames a rectangle stays masked after it was last seen there. */
export const MASK_HOLD_FRAMES = 4;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Whether `el` (or an ancestor) is masked. */
export function isMasked(el: Element | null): boolean {
  for (let e: Element | null = el; e; e = e.parentElement) {
    if (e.matches(MASK_SELECTOR)) return true;
  }
  return false;
}

/** The viewport rectangles (CSS px) of every masked element in `doc`. */
export function maskedRects(doc: Document): Rect[] {
  const out: Rect[] = [];
  // Descendants too: a positioned child can draw outside its masked parent.
  for (const el of Array.from(doc.querySelectorAll(`${MASK_SELECTOR}, [data-gaiadesk-mask] *`))) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  return out;
}

/**
 * Viewport rectangles (CSS px) → frame rectangles (frame px), padded and
 * clipped to the frame. The captured frame of this tab IS its viewport, so
 * the scale is the frame size over the viewport size. Pure.
 */
export function toFrame(rects: Rect[], viewport: { w: number; h: number }, frame: { w: number; h: number }, pad = MASK_PAD): Rect[] {
  if (viewport.w <= 0 || viewport.h <= 0) return [];
  const sx = frame.w / viewport.w;
  const sy = frame.h / viewport.h;
  const out: Rect[] = [];
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor((r.x - pad) * sx));
    const y0 = Math.max(0, Math.floor((r.y - pad) * sy));
    const x1 = Math.min(frame.w, Math.ceil((r.x + r.w + pad) * sx));
    const y1 = Math.min(frame.h, Math.ceil((r.y + r.h + pad) * sy));
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

/** The last few frames' rectangles: what is painted over now. */
export class MaskHistory {
  private frames: Rect[][] = [];
  constructor(private readonly hold = MASK_HOLD_FRAMES) {}

  push(rects: Rect[]): Rect[] {
    this.frames.push(rects);
    while (this.frames.length > this.hold) this.frames.shift();
    return this.frames.flat();
  }
}

export interface Compositor {
  /** The track to send: the capture with every mask painted over. */
  track: MediaStreamTrack;
  stop(): void;
}

/**
 * Draw `source` (this tab's capture) into a canvas, masks painted over, and
 * hand back the canvas's own track. Frames are drawn on a timer rather than
 * `requestAnimationFrame`, which a browser pauses in a hidden tab.
 */
export function composite(source: MediaStreamTrack, doc: Document, fps = 15): Compositor {
  const win = doc.defaultView as Window;
  const video = doc.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([source]);
  void video.play().catch(() => undefined);
  const canvas = doc.createElement("canvas");
  const s = source.getSettings();
  canvas.width = s.width || win.innerWidth;
  canvas.height = s.height || win.innerHeight;
  const ctx = canvas.getContext("2d", { alpha: false });
  const history = new MaskHistory();
  const draw = () => {
    if (!ctx) return;
    const w = video.videoWidth || canvas.width;
    const h = video.videoHeight || canvas.height;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    // Frame and masks are drawn in one task, so captureStream never samples
    // a frame without its masks.
    const rects = history.push(toFrame(maskedRects(doc), { w: win.innerWidth, h: win.innerHeight }, { w, h }));
    if (video.readyState >= 2) ctx.drawImage(video, 0, 0, w, h);
    else {
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.fillStyle = "#1f2430";
    for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#8a93a6";
    ctx.font = `${Math.max(10, Math.round(h / 60))}px system-ui, sans-serif`;
    for (const r of rects) if (r.w > 60 && r.h > 14) ctx.fillText("Hidden", r.x + 6, r.y + Math.min(r.h - 4, Math.round(h / 60) + 4));
  };
  draw();
  const timer = win.setInterval(draw, Math.round(1000 / fps));
  const out = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(fps);
  const track = out.getVideoTracks()[0];
  return {
    track,
    stop() {
      win.clearInterval(timer);
      track.stop();
      video.srcObject = null;
    },
  };
}
