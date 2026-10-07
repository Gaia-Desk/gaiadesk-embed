// The embed's own UI, in a closed-off shadow root on one host element: the
// consent dialog, the "Sharing with <company> support · Stop" bar, and the
// agent's pointer and highlight.
//
// Every string — the company's name included — goes in with textContent;
// nothing is ever parsed as markup. Colours are accepted only as `#rgb` or
// `#rrggbb`, and a logo only as an `https:` or `data:image/` URL.

import type { Branding, SupportMode } from "./types.js";

export const HOST_TAG = "gaiadesk-embed";
const DEFAULT_COLOR = "#2563eb";

/** A safe `#rgb`/`#rrggbb` colour, else `fallback`. Pure. */
export function safeColor(c: string | undefined, fallback: string): string {
  return typeof c === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim()) ? c.trim() : fallback;
}

/** A logo URL that is `https:` or an inline image, else `null`. Pure. */
export function safeLogo(u: string | undefined): string | null {
  if (typeof u !== "string") return null;
  const s = u.trim();
  if (/^data:image\/(png|jpeg|gif|webp|svg\+xml);/i.test(s)) return s;
  try {
    return new URL(s).protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

/** The company's name, plain and short (default "our"). Pure. */
export function safeName(n: string | undefined): string {
  const s = (typeof n === "string" ? n : "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
  return s || "our";
}

/** What the consent dialog says. Pure. */
export function consentText(company: string, mode: SupportMode): { title: string; body: string[] } {
  const who = `${company} support`;
  const body = [
    `${who} will see this browser tab only — not your other tabs, windows or apps.`,
    "Fields marked private, and every password, stay hidden from them.",
  ];
  if (mode === "cobrowse") body.push(`${who} may also point, scroll, click and type inside this page to guide you. You'll see everything they do, and you can pause that at any time.`);
  body.push("Your browser will ask which tab to share: choose this one. Stop sharing whenever you like.");
  return { title: `Share this tab with ${who}?`, body };
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.backdrop { position: fixed; inset: 0; background: rgba(15, 18, 25, .45); display: flex; align-items: center; justify-content: center; pointer-events: auto; }
.dialog { width: min(440px, calc(100vw - 32px)); background: #fff; color: #1b1f29; border-radius: 12px; padding: 22px; box-shadow: 0 20px 50px rgba(0,0,0,.3); }
.dialog h2 { font-size: 17px; margin: 0 0 12px; display: flex; gap: 10px; align-items: center; }
.dialog img { width: 28px; height: 28px; object-fit: contain; }
.dialog p { font-size: 14px; line-height: 1.45; margin: 0 0 10px; color: #3b4252; }
.row { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
button { font: 600 14px system-ui, sans-serif; border-radius: 8px; padding: 9px 14px; cursor: pointer; border: 1px solid transparent; }
.primary { background: var(--accent); color: var(--on-accent); }
.secondary { background: transparent; color: #3b4252; border-color: #cfd5e0; }
.bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: flex; gap: 10px; align-items: center; background: var(--accent); color: var(--on-accent);
       border-radius: 999px; padding: 8px 10px 8px 16px; font-size: 14px; box-shadow: 0 6px 20px rgba(0,0,0,.25); pointer-events: auto; max-width: calc(100vw - 24px); }
.bar .dot { width: 8px; height: 8px; border-radius: 50%; background: #ff4d4f; box-shadow: 0 0 0 3px rgba(255,77,79,.3); flex: none; }
.bar .code { opacity: .85; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar button { padding: 6px 12px; background: rgba(255,255,255,.18); color: inherit; }
.bar button.stop { background: #fff; color: #b42318; }
.cursor { position: fixed; left: 0; top: 0; pointer-events: none; transform: translate(-2px, -2px); display: none; }
.cursor svg { display: block; }
.cursor span { position: absolute; left: 18px; top: 16px; background: var(--accent); color: var(--on-accent); font-size: 11px; padding: 2px 6px; border-radius: 6px; white-space: nowrap; }
.ring { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid var(--accent); pointer-events: none; animation: ring 1.2s ease-out forwards; }
@keyframes ring { from { transform: scale(.4); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
`;

export interface UiCallbacks {
  onStop(): void;
  onToggleControl(allowed: boolean): void;
}

/** The embed's UI, mounted on one host element. */
export class EmbedUi {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly company: string;
  private bar: HTMLElement | null = null;
  private cursor: HTMLElement | null = null;
  private controlBtn: HTMLButtonElement | null = null;

  constructor(private readonly doc: Document, branding: Branding | undefined) {
    this.company = safeName(branding?.name);
    this.host = doc.createElement(HOST_TAG);
    this.host.setAttribute("data-gaiadesk-ui", "");
    // Above the page, never intercepting clicks except on its own controls.
    this.host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = CSS;
    this.root.append(style);
    const accent = safeColor(branding?.color, DEFAULT_COLOR);
    this.host.style.setProperty("--accent", accent);
    this.host.style.setProperty("--on-accent", safeColor(branding?.textColor, "#ffffff"));
    this.logo = safeLogo(branding?.logoUrl);
    (doc.body ?? doc.documentElement).append(this.host);
  }

  private readonly logo: string | null;

  /** Whether `el` is this UI (its host; the shadow content is not reachable). */
  owns(el: Element): boolean {
    return el === this.host || this.host.contains(el);
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const e = this.doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /** Ask. Resolves `true` from the Share button's own click handler, so the
   * caller can open the browser's prompt within that user gesture. */
  consent(mode: SupportMode, onShare: () => void, onDecline: () => void): void {
    const t = consentText(this.company, mode);
    const back = this.el("div", "backdrop");
    back.setAttribute("role", "dialog");
    back.setAttribute("aria-modal", "true");
    const box = this.el("div", "dialog");
    const h = this.el("h2");
    if (this.logo) {
      const img = this.el("img");
      img.alt = "";
      img.src = this.logo;
      h.append(img);
    }
    h.append(this.doc.createTextNode(t.title));
    box.append(h, ...t.body.map((p) => this.el("p", undefined, p)));
    const row = this.el("div", "row");
    const no = this.el("button", "secondary", "Not now");
    const yes = this.el("button", "primary", "Share this tab");
    no.type = yes.type = "button";
    no.addEventListener("click", () => {
      back.remove();
      onDecline();
    });
    yes.addEventListener("click", () => {
      back.remove();
      onShare();
    });
    row.append(no, yes);
    box.append(row);
    back.append(box);
    this.root.append(back);
    yes.focus();
  }

  /** The sharing bar. `code`: the support code to read to an agent. */
  showBar(cb: UiCallbacks, mode: SupportMode, code: string | null): void {
    this.bar?.remove();
    const bar = this.el("div", "bar");
    bar.setAttribute("role", "status");
    const label = this.el("span", "label", `Sharing with ${this.company} support`);
    bar.append(this.el("span", "dot"), label);
    if (code) bar.append(this.el("span", "code", `· Code ${code.replace(/(\d{3})(?=\d)/g, "$1 ")}`));
    if (mode === "cobrowse") {
      const c = this.el("button", undefined, "Pause control");
      c.type = "button";
      c.dataset.allowed = "1";
      c.addEventListener("click", () => {
        const allowed = c.dataset.allowed !== "1";
        this.setControl(allowed);
        cb.onToggleControl(allowed);
      });
      this.controlBtn = c;
      bar.append(c);
    }
    const stop = this.el("button", "stop", "Stop");
    stop.type = "button";
    stop.addEventListener("click", () => cb.onStop());
    bar.append(stop);
    this.root.append(bar);
    this.bar = bar;
  }

  /** The bar's text (`Sharing with …`, and who joined). */
  setStatus(text: string): void {
    const l = this.bar?.querySelector(".label");
    if (l) l.textContent = text;
  }

  setControl(allowed: boolean): void {
    if (!this.controlBtn) return;
    this.controlBtn.dataset.allowed = allowed ? "1" : "0";
    this.controlBtn.textContent = allowed ? "Pause control" : "Allow control";
    if (!allowed) this.hidePointer();
  }

  /** The agent's pointer at viewport point (x, y). */
  pointer(x: number, y: number, label: string): void {
    if (!this.cursor) {
      const c = this.el("div", "cursor");
      const svgNs = "http://www.w3.org/2000/svg";
      const svg = this.doc.createElementNS(svgNs, "svg");
      svg.setAttribute("width", "20");
      svg.setAttribute("height", "22");
      svg.setAttribute("viewBox", "0 0 20 22");
      const p = this.doc.createElementNS(svgNs, "path");
      p.setAttribute("d", "M2 2 L2 18 L7 13.5 L10.5 21 L13.5 19.6 L10 12.4 L17 12.4 Z");
      p.setAttribute("fill", "currentColor");
      p.setAttribute("stroke", "#fff");
      p.setAttribute("stroke-width", "1.5");
      svg.append(p);
      c.style.color = "var(--accent)";
      c.append(svg, this.el("span", undefined, label));
      this.root.append(c);
      this.cursor = c;
    }
    this.cursor.style.display = "block";
    this.cursor.style.left = `${Math.round(x)}px`;
    this.cursor.style.top = `${Math.round(y)}px`;
  }

  hidePointer(): void {
    if (this.cursor) this.cursor.style.display = "none";
  }

  /** A short ring where the agent points something out (or clicked). */
  ring(x: number, y: number): void {
    const r = this.el("div", "ring");
    r.style.left = `${Math.round(x)}px`;
    r.style.top = `${Math.round(y)}px`;
    this.root.append(r);
    this.doc.defaultView?.setTimeout(() => r.remove(), 1300);
  }

  /** The bar's text for tests and the demo (read through the closed root). */
  barText(): string | null {
    return this.bar?.textContent ?? null;
  }

  /** The consent dialog's text, if it is showing. */
  dialogText(): string | null {
    return this.root.querySelector(".dialog")?.textContent ?? null;
  }

  /** Press a button by its label (tests and assistive automation). */
  press(label: string): boolean {
    const b = Array.from(this.root.querySelectorAll("button")).find((x) => x.textContent === label);
    b?.click();
    return Boolean(b);
  }

  remove(): void {
    this.host.remove();
  }
}
