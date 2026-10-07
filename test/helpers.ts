// A page without a browser (jsdom), and fakes for the parts jsdom lacks:
// WebRTC, WebSocket, the screen share and media streams.

import { JSDOM } from "jsdom";

export type Win = Window & typeof globalThis;

export function page(html: string, url = "https://shop.example.com/checkout"): { win: Win; doc: Document } {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url, pretendToBeVisual: true });
  const win = dom.window as unknown as Win;
  // jsdom has no layout: a fixed 1000 x 500 viewport.
  Object.defineProperty(win, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(win, "innerHeight", { value: 500, configurable: true });
  return { win, doc: win.document };
}

/** Give `el` a layout box (jsdom has none). */
export function box(el: Element, x: number, y: number, w: number, h: number): void {
  (el as HTMLElement).getBoundingClientRect = () => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
}

export class FakeTrack extends EventTarget {
  kind = "video";
  readyState = "live";
  contentHint = "";
  stopped = false;
  constructor(public settings: Record<string, unknown> = { displaySurface: "browser", width: 1000, height: 500 }, public handle?: string) {
    super();
  }
  getSettings() {
    return this.settings;
  }
  getCaptureHandle() {
    return this.handle === undefined ? null : { handle: this.handle };
  }
  stop() {
    this.stopped = true;
    this.readyState = "ended";
  }
}

export class FakeStream {
  constructor(public tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks;
  }
}

/** `new MediaStream([...])`, as the session and the compositor call it. */
(globalThis as unknown as { MediaStream: unknown }).MediaStream = FakeStream;

export class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.last = this;
    this.readyState = 1;
  }
  send(text: string) {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  /** The server says `m`. */
  async deliver(m: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(m) });
    await flush();
  }
  types() {
    return this.sent.map((m) => m.type);
  }
}

export class FakeChannel {
  readyState = "connecting";
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public label: string) {}
  send(text: string) {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close() {
    this.readyState = "closed";
  }
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  async agentSays(m: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(m) });
    await flush();
  }
}

export class FakePeer {
  static all: FakePeer[] = [];
  tracks: unknown[] = [];
  channels: FakeChannel[] = [];
  local: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  candidates: unknown[] = [];
  closed = false;
  onicecandidate: ((ev: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  constructor(public config: RTCConfiguration) {
    FakePeer.all.push(this);
  }
  addTrack(t: unknown) {
    this.tracks.push(t);
  }
  createDataChannel(label: string) {
    const c = new FakeChannel(label);
    this.channels.push(c);
    return c;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0 fake offer" };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.local = d;
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
  }
  async addIceCandidate(c: unknown) {
    this.candidates.push(c);
  }
  close() {
    this.closed = true;
  }
}

/** Let promises and microtasks run. */
export async function flush(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}
