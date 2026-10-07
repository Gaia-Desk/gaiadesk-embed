// One support session in this tab: consent, the share, the signaling socket
// (`/ws?embed=<token>`, a QuickSupport-style ephemeral host), the WebRTC
// connection to the agent's console, and co-browsing over its data channel.

import { apply, parseAction, RateLimit, type Action, type Outcome } from "./cobrowse.js";
import { shareThisTab, type CaptureError, type Captured } from "./capture.js";
import { composite, type Compositor } from "./mask.js";
import type { EndReason, EventMap, EventName, Listener, StartOptions, State, SupportMode } from "./types.js";
import { EmbedUi } from "./ui.js";

export const DEFAULT_SERVER = "https://gaiadesk.net";
/** The data channel the console and the embed speak co-browsing on. */
export const CHANNEL = "gaiadesk-cobrowse";

/** What the session needs from the browser (tests give their own). */
export interface Env {
  win: Window;
  doc: Document;
  nav: Navigator;
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
  RTCPeerConnection: typeof RTCPeerConnection;
  /** The share (default: `shareThisTab`). */
  share?: (nav: Navigator, origin: string) => Promise<Captured>;
  /** The masked track (default: `composite`). */
  composite?: (track: MediaStreamTrack, doc: Document) => Compositor;
}

export function browserEnv(): Env {
  const g = globalThis as unknown as Window & typeof globalThis;
  return { win: g, doc: g.document, nav: g.navigator, fetch: g.fetch.bind(g), WebSocket: g.WebSocket, RTCPeerConnection: g.RTCPeerConnection };
}

/** `https://gaiadesk.net` → its API and socket URLs. Pure. */
export function endpoints(server: string | undefined): { api: string; ws: string } {
  const u = new URL(server ?? DEFAULT_SERVER);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) {
    throw new Error("server must be https:// (http:// only for localhost)");
  }
  const origin = u.origin;
  return { api: `${origin}/v1`, ws: `${origin.replace(/^http/, "ws")}/ws` };
}

/** Check start()'s options. Pure. */
export function checkOptions(o: StartOptions): string | null {
  if (!o || typeof o !== "object") return "options are required";
  const hasKey = typeof o.publishableKey === "string" && o.publishableKey.length > 0;
  const hasToken = typeof o.embedToken === "string" && o.embedToken.length > 0;
  if (hasKey === hasToken) return "give exactly one of publishableKey or embedToken";
  if (hasToken && !/^gdemb_[0-9a-f]{64}$/.test(o.embedToken as string)) return "embedToken is not an embed token (gdemb_…)";
  if (o.mode !== undefined && o.mode !== "view" && o.mode !== "cobrowse") return "mode is view or cobrowse";
  if (o.expiresIn !== undefined && !(Number.isInteger(o.expiresIn) && o.expiresIn >= 60 && o.expiresIn <= 3600)) return "expiresIn is 60 to 3600 seconds";
  return null;
}

interface SupportInfo {
  session_id: string;
  join_code: string;
  mode: SupportMode;
  expires_at: number;
  ice_servers: RTCIceServer[];
}

export class Session {
  state: State = "idle";
  private listeners = new Map<EventName, Set<Listener<EventName>>>();
  private ui: EmbedUi | null = null;
  private captured: Captured | null = null;
  private comp: Compositor | null = null;
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private info: SupportInfo | null = null;
  private allowed = true;
  private agent: string | null = null;
  private readonly limit = new RateLimit();
  private ending = false;

  constructor(private readonly opts: StartOptions, private readonly env: Env) {}

  on<K extends EventName>(name: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn as Listener<EventName>);
    return () => set?.delete(fn as Listener<EventName>);
  }

  private emit<K extends EventName>(name: K, detail: EventMap[K]): void {
    for (const fn of this.listeners.get(name) ?? []) {
      try {
        (fn as Listener<K>)(detail);
      } catch {
        // a listener's failure is the page's, never the session's
      }
    }
  }

  private setState(s: State): void {
    this.state = s;
    this.emit("state", { state: s });
  }

  private get company(): string {
    return this.opts.branding?.name?.trim() || "our";
  }

  /** The mode before the server has said (the consent dialog's wording). */
  private get askedMode(): SupportMode {
    return this.opts.mode ?? "view";
  }

  /** Show the consent dialog; the rest follows the customer's choice. */
  begin(): void {
    const bad = checkOptions(this.opts);
    if (bad) {
      this.fail("bad_options", bad);
      return;
    }
    this.ui = new EmbedUi(this.env.doc, this.opts.branding);
    this.setState("consent");
    this.ui.consent(
      this.askedMode,
      () => void this.shared(),
      () => this.end("declined"),
    );
  }

  /** The consent dialog's "Share this tab" (inside the click's user gesture). */
  private async shared(): Promise<void> {
    this.setState("starting");
    const share = this.env.share ?? shareThisTab;
    // Ask the browser FIRST, synchronously inside the click.
    const asked = share(this.env.nav, this.env.win.location.origin);
    try {
      this.captured = await asked;
    } catch (e) {
      const err = e as CaptureError;
      if (err.code === "declined") return this.end("declined");
      return this.fail(err.code ?? "capture_failed", err.message ?? "The tab could not be shared.");
    }
    if (this.ending) return this.cleanup();
    this.captured.track.addEventListener("ended", () => this.stop());
    this.comp = (this.env.composite ?? composite)(this.captured.track, this.env.doc);
    try {
      this.comp.track.contentHint = "detail";
    } catch {
      // not supported
    }
    let token: string;
    try {
      token = this.opts.embedToken ?? (await this.createSession());
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return this.fail(err.code ?? "create_failed", err.message ?? "The support session could not be created.");
    }
    if (this.ending) return this.cleanup();
    this.connect(token);
  }

  /** `POST /v1/support/sessions` with the publishable key. */
  private async createSession(): Promise<string> {
    const { api } = endpoints(this.opts.server);
    const body: Record<string, unknown> = { mode: this.askedMode };
    if (this.opts.customer) body.customer = this.opts.customer;
    if (this.opts.expiresIn) body.expires_in = this.opts.expiresIn;
    const r = await this.env.fetch(`${api}/support/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.publishableKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as { embed_token?: string; error?: { reason?: string; message?: string } };
    if (!r.ok || typeof j.embed_token !== "string") {
      throw { code: j.error?.reason ?? `http_${r.status}`, message: j.error?.message ?? "The support session could not be created." };
    }
    return j.embed_token;
  }

  private send(m: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  private connect(token: string): void {
    const { ws: base } = endpoints(this.opts.server);
    const ws = new this.env.WebSocket(`${base}?embed=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onmessage = (ev) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      void this.onSignal(m);
    };
    ws.onclose = () => {
      if (!this.ending) this.end(this.state === "starting" ? "error" : "disconnected", this.state === "starting" ? { code: "connect_failed", message: "Could not reach GaiaDesk." } : undefined);
    };
  }

  private async onSignal(m: Record<string, unknown>): Promise<void> {
    switch (m.type) {
      case "support_session": {
        this.info = {
          session_id: String(m.session_id),
          join_code: String(m.join_code),
          mode: m.mode === "cobrowse" ? "cobrowse" : "view",
          expires_at: Number(m.expires_at),
          ice_servers: Array.isArray(m.ice_servers) ? (m.ice_servers as RTCIceServer[]) : [],
        };
        const instance = `embed-${Math.random().toString(36).slice(2, 10)}`;
        this.send({ type: "register_host", instance_id: instance });
        return;
      }
      case "registered": {
        if (!this.info) return;
        this.setState("waiting");
        this.ui?.showBar({ onStop: () => this.stop(), onToggleControl: (a) => this.setControl(a) }, this.info.mode, this.info.join_code);
        this.ui?.setStatus(`Sharing with ${this.company} support · waiting for an agent`);
        this.emit("ready", { sessionId: this.info.session_id, joinCode: this.info.join_code, mode: this.info.mode });
        return;
      }
      case "connect_request":
        return this.onConnect(String(m.access_code ?? ""), typeof m.controller_email === "string" ? m.controller_email : null);
      case "answer":
        if (this.pc && typeof m.sdp === "string") {
          await this.pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
          for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => undefined);
        }
        return;
      case "ice": {
        const c = m.candidate as RTCIceCandidateInit | undefined;
        if (!this.pc || !c) return;
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(c).catch(() => undefined);
        else this.pendingIce.push(c);
        return;
      }
      case "peer_left":
        this.dropPeer();
        this.ui?.setStatus(`Sharing with ${this.company} support · waiting for an agent`);
        this.ui?.hidePointer();
        this.setState("waiting");
        this.emit("left", {});
        return;
      case "error": {
        const msg = String(m.message ?? "");
        if (/expired/.test(msg)) this.end("expired");
        else if (/ended/.test(msg)) this.end("stopped");
        else this.emit("error", { code: "server", message: msg });
        return;
      }
      default:
        return;
    }
  }

  /** An agent wants in: the support code must be this session's. */
  private async onConnect(code: string, agent: string | null): Promise<void> {
    if (!this.info || !this.comp) return;
    if (code !== this.info.join_code) {
      this.send({ type: "reject", reason: "wrong support code" });
      return;
    }
    this.dropPeer();
    this.agent = agent;
    const pc = new this.env.RTCPeerConnection({ iceServers: this.info.ice_servers });
    this.pc = pc;
    this.pendingIce = [];
    pc.addTrack(this.comp.track, new MediaStream([this.comp.track]));
    const dc = pc.createDataChannel(CHANNEL, { ordered: true });
    this.dc = dc;
    dc.onopen = () => {
      this.sendDc({ t: "hello", mode: this.info?.mode ?? "view", cobrowse: this.cobrowseAvailable(), control: this.allowed, verified: Boolean(this.captured?.verified) });
      this.setState("connected");
      this.ui?.setStatus(`Sharing with ${this.company} support${agent ? ` · ${agent}` : ""}`);
      this.emit("joined", { agent });
    };
    dc.onmessage = (ev) => this.onAction(ev.data);
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.send({ type: "ice", candidate: ev.candidate.toJSON() });
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send({ type: "offer", sdp: offer.sdp });
  }

  private cobrowseAvailable(): boolean {
    return this.info?.mode === "cobrowse" && Boolean(this.captured?.verified);
  }

  private sendDc(m: Record<string, unknown>): void {
    if (this.dc && this.dc.readyState === "open") this.dc.send(JSON.stringify(m));
  }

  /** One request from the agent's console. */
  onAction(data: unknown): Outcome | null {
    let raw: unknown;
    try {
      raw = typeof data === "string" ? JSON.parse(data) : null;
    } catch {
      return null;
    }
    const a: Action | null = parseAction(raw);
    if (!a || !this.info) return null;
    const id = "id" in a ? a.id : undefined;
    const answer = (out: Outcome) => {
      if (a.t !== "pointer") {
        this.emit("action", { type: a.t, applied: out.applied, reason: out.applied ? undefined : out.reason });
        if (id !== undefined) this.sendDc({ t: "ack", id, ok: out.applied, reason: out.applied ? undefined : out.reason });
      }
      return out;
    };
    if (!this.limit.take(Date.now())) return answer({ applied: false, reason: "rate_limited" });
    const win = this.env.win;
    const out = apply(
      a,
      { doc: this.env.doc, elementAt: (x, y) => this.env.doc.elementFromPoint(x, y), isOwnUi: (el) => this.ui?.owns(el) ?? false },
      { mode: this.info.mode, allowed: this.allowed, verified: Boolean(this.captured?.verified) },
    );
    if (out.applied && "x" in a && "y" in a) {
      const [x, y] = [a.x * win.innerWidth, a.y * win.innerHeight];
      if (a.t === "pointer") this.ui?.pointer(x, y, `${this.company} support`);
      else this.ui?.ring(x, y);
    }
    return answer(out);
  }

  /** The customer paused (or allowed) co-browsing. */
  setControl(allowed: boolean): void {
    this.allowed = allowed;
    this.ui?.setControl(allowed);
    this.sendDc({ t: "control", allowed });
    this.emit("control", { allowed });
  }

  private dropPeer(): void {
    try {
      this.dc?.close();
    } catch {
      // already closed
    }
    try {
      this.pc?.close();
    } catch {
      // already closed
    }
    this.dc = null;
    this.pc = null;
    this.agent = null;
  }

  /** The customer's Stop (the bar, the API, or the browser's own button). */
  stop(): void {
    if (this.ending) return;
    this.send({ type: "leave" });
    this.end("stopped");
  }

  private fail(code: string, message: string): void {
    this.end("error", { code, message });
  }

  private end(reason: EndReason, err?: { code: string; message: string }): void {
    if (this.ending) return;
    this.ending = true;
    if (err) this.emit("error", err);
    this.cleanup();
    this.setState("ended");
    this.emit("ended", { reason });
  }

  private cleanup(): void {
    this.dropPeer();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    this.comp?.stop();
    this.comp = null;
    for (const t of this.captured?.stream.getTracks() ?? []) t.stop();
    this.captured = null;
    this.ui?.remove();
    this.ui = null;
  }

  /** For the demo and tests: who joined. */
  get agentEmail(): string | null {
    return this.agent;
  }

  /** For tests: the UI. */
  get view(): EmbedUi | null {
    return this.ui;
  }
}
