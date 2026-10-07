// Co-browsing: what a support agent's pointer, clicks, scrolling and typing
// may do in this page, and how.
//
// Everything here is DOM-level and synthetic (events the page's own scripts
// see as untrusted), never operating-system input. The rules, all checked
// before anything happens:
//
// * only in `cobrowse` mode, only while the customer allows control (the
//   sharing bar's "Pause control" takes it back at once), and only when the
//   shared surface is verified to be this very tab (so a point in the
//   agent's picture is a point in this page);
// * only inside this document: a point maps to the viewport, the target is
//   whatever is there (`elementFromPoint`), and nothing outside the page —
//   no other tab, no browser UI, no OS — is reachable at all;
// * never the embed's own UI (an agent cannot press "Allow" or hide "Stop");
// * never a masked element: `data-gaiadesk-mask`, passwords, one-time codes,
//   card numbers (the same rule that blacks them out of the picture);
// * no file pickers, no `javascript:` links, no navigation or form
//   submission to another origin;
// * bounded: text at most 500 characters, a small set of keys, scrolls
//   clamped, at most 20 requests a second.

import { isMasked } from "./mask.js";

/** A window with its constructors (`win.MouseEvent`, …): the page's own realm. */
type Win = Window & typeof globalThis;

export type Action =
  | { t: "pointer"; x: number; y: number }
  | { t: "highlight"; x: number; y: number }
  | { t: "click"; x: number; y: number; id?: number }
  | { t: "scroll"; x: number; y: number; dx: number; dy: number; id?: number }
  | { t: "type"; text: string; id?: number }
  | { t: "key"; key: string; id?: number };

export const MAX_TEXT = 500;
export const MAX_SCROLL = 2000;
export const MAX_PER_SECOND = 20;
/** Keys an agent may press. */
export const KEYS = ["Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"] as const;

const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optId = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

/** A request from the data channel, or `null` when it is not one. Pure. */
export function parseAction(raw: unknown): Action | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = optId(o.id);
  switch (o.t) {
    case "pointer":
    case "highlight":
      return unit(o.x) && unit(o.y) ? { t: o.t, x: o.x, y: o.y } : null;
    case "click":
      return unit(o.x) && unit(o.y) ? { t: "click", x: o.x, y: o.y, id } : null;
    case "scroll":
      if (!unit(o.x) || !unit(o.y) || !finite(o.dx) || !finite(o.dy)) return null;
      return { t: "scroll", x: o.x, y: o.y, dx: clamp(o.dx, MAX_SCROLL), dy: clamp(o.dy, MAX_SCROLL), id };
    case "type":
      if (typeof o.text !== "string" || o.text.length === 0 || o.text.length > MAX_TEXT) return null;
      // Printable text only: no control characters (Enter is a key).
      if (/[\u0000-\u001f\u007f]/.test(o.text)) return null;
      return { t: "type", text: o.text, id };
    case "key":
      return typeof o.key === "string" && (KEYS as readonly string[]).includes(o.key) ? { t: "key", key: o.key, id } : null;
    default:
      return null;
  }
}

function clamp(v: number, max: number): number {
  return Math.max(-max, Math.min(max, v));
}

/** Where co-browsing runs, so tests can give it a page without layout. */
export interface Page {
  doc: Document;
  /** What is at viewport point (x, y) in CSS px (`document.elementFromPoint`). */
  elementAt(x: number, y: number): Element | null;
  /** Whether `el` is part of the embed's own UI. */
  isOwnUi(el: Element): boolean;
}

/** Whether co-browsing may act at all right now. */
export interface Permission {
  mode: "view" | "cobrowse";
  /** The customer has not paused control. */
  allowed: boolean;
  /** The shared surface is verified to be this tab. */
  verified: boolean;
}

export type Outcome = { applied: true } | { applied: false; reason: string };
const no = (reason: string): Outcome => ({ applied: false, reason });
const yes: Outcome = { applied: true };

/** A sliding one-second budget of requests. */
export class RateLimit {
  private times: number[] = [];
  constructor(private readonly max = MAX_PER_SECOND) {}
  take(now: number): boolean {
    this.times = this.times.filter((t) => now - t < 1000);
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }
}

const TEXT_INPUTS = ["text", "search", "email", "url", "tel", "number", ""];

/** An element an agent may type into, or why not. */
function editable(el: Element | null): HTMLInputElement | HTMLTextAreaElement | HTMLElement | string {
  if (!el) return "no_focus";
  if (isMasked(el)) return "masked";
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const i = el as HTMLInputElement;
    if (!TEXT_INPUTS.includes((i.getAttribute("type") ?? "").toLowerCase())) return "not_editable";
    if (i.disabled || i.readOnly) return "not_editable";
    return i;
  }
  if (tag === "textarea") {
    const t = el as HTMLTextAreaElement;
    return t.disabled || t.readOnly ? "not_editable" : t;
  }
  if ((el as HTMLElement).isContentEditable) return el as HTMLElement;
  return "not_editable";
}

/** Where a click on `el` would take the page, if anywhere. */
function leavesPage(el: Element, doc: Document): string | null {
  const here = doc.defaultView?.location.origin;
  const link = el.closest("a[href], area[href]") as HTMLAnchorElement | null;
  if (link) {
    const href = link.getAttribute("href") ?? "";
    if (/^\s*javascript:/i.test(href)) return "navigation_blocked";
    try {
      const u = new URL(href, doc.baseURI);
      if (u.origin !== here) return "navigation_blocked";
    } catch {
      return "navigation_blocked";
    }
  }
  const submit = el.closest('button, input[type="submit" i], input[type="image" i]') as HTMLButtonElement | HTMLInputElement | null;
  const form = submit?.form ?? null;
  if (form && (submit as HTMLButtonElement).type === "submit") {
    const action = submit?.getAttribute("formaction") ?? form.getAttribute("action") ?? "";
    try {
      if (new URL(action || doc.baseURI, doc.baseURI).origin !== here) return "navigation_blocked";
    } catch {
      return "navigation_blocked";
    }
  }
  return null;
}

/** The checks every targeted action shares. */
function target(page: Page, x: number, y: number): Element | string {
  const win = page.doc.defaultView as Win | null;
  if (!win) return "no_page";
  const el = page.elementAt(x * win.innerWidth, y * win.innerHeight);
  if (!el || !page.doc.documentElement.contains(el)) return "nothing_there";
  if (page.isOwnUi(el)) return "embed_ui";
  if (isMasked(el)) return "masked";
  return el;
}

function mouse(el: Element, type: string, x: number, y: number, win: Win): void {
  const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: win };
  const Ctor = type.startsWith("pointer") && typeof win.PointerEvent === "function" ? win.PointerEvent : win.MouseEvent;
  el.dispatchEvent(new Ctor(type, init));
}

/** Set a field's value the way a framework sees typing (its native setter). */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
}

function insert(el: HTMLInputElement | HTMLTextAreaElement | HTMLElement, text: string, win: Win): void {
  if (el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement) {
    const max = el.maxLength > 0 ? el.maxLength : Infinity;
    let start = el.value.length;
    let end = start;
    try {
      start = el.selectionStart ?? start;
      end = el.selectionEnd ?? end;
    } catch {
      // number/email inputs have no selection
    }
    const room = Math.max(0, max - (el.value.length - (end - start)));
    const add = text.slice(0, room);
    setValue(el, el.value.slice(0, start) + add + el.value.slice(end));
    try {
      el.setSelectionRange(start + add.length, start + add.length);
    } catch {
      // no selection API on this type
    }
    el.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: add }));
  } else {
    el.append(el.ownerDocument.createTextNode(text));
    el.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
  }
}

function backspace(el: HTMLInputElement | HTMLTextAreaElement, forward: boolean, win: Win): void {
  let start = el.value.length;
  let end = start;
  try {
    start = el.selectionStart ?? start;
    end = el.selectionEnd ?? end;
  } catch {
    // no selection API
  }
  if (start === end) {
    if (forward) end = Math.min(el.value.length, end + 1);
    else start = Math.max(0, start - 1);
  }
  setValue(el, el.value.slice(0, start) + el.value.slice(end));
  try {
    el.setSelectionRange(start, start);
  } catch {
    // no selection API
  }
  el.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, inputType: forward ? "deleteContentForward" : "deleteContentBackward" }));
}

function scrollable(el: Element | null, win: Win): Element | null {
  for (let e = el; e && e !== e.ownerDocument.documentElement; e = e.parentElement) {
    const s = win.getComputedStyle(e);
    if (/(auto|scroll)/.test(s.overflowY + s.overflowX) && (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)) return e;
  }
  return null;
}

/**
 * Apply one request from the agent, or say why not. Pointer and highlight
 * requests move the embed's own overlay and are the caller's to draw; this
 * only checks them.
 */
export function apply(a: Action, page: Page, perm: Permission): Outcome {
  if (perm.mode !== "cobrowse") return no("view_only");
  if (!perm.verified) return no("surface_unverified");
  if (a.t === "pointer" || a.t === "highlight") return yes;
  if (!perm.allowed) return no("control_paused");
  const win = page.doc.defaultView as Win | null;
  if (!win) return no("no_page");
  switch (a.t) {
    case "click": {
      const el = target(page, a.x, a.y);
      if (typeof el === "string") return no(el);
      if (el.closest('input[type="file" i]')) return no("file_picker_blocked");
      const away = leavesPage(el, page.doc);
      if (away) return no(away);
      const [cx, cy] = [a.x * win.innerWidth, a.y * win.innerHeight];
      for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) mouse(el, t, cx, cy, win);
      const focusable = el.closest("input, textarea, select, button, a[href], [tabindex], [contenteditable]") as HTMLElement | null;
      focusable?.focus?.();
      // `click()` runs the element's default action as a click would (a
      // checkbox toggles, a same-origin link or submit button goes); the
      // event itself stays synthetic.
      (el as HTMLElement).click?.();
      return yes;
    }
    case "scroll": {
      const el = target(page, a.x, a.y);
      if (typeof el === "string" && el !== "masked") return no(el);
      const box = typeof el === "string" ? null : scrollable(el, win);
      if (box) box.scrollBy({ left: a.dx, top: a.dy });
      else win.scrollBy({ left: a.dx, top: a.dy });
      return yes;
    }
    case "type": {
      const el = editable(page.doc.activeElement);
      if (typeof el === "string") return no(el);
      if (page.isOwnUi(el)) return no("embed_ui");
      insert(el, a.text, win);
      return yes;
    }
    case "key": {
      const active = page.doc.activeElement;
      if (active && (isMasked(active) || page.isOwnUi(active))) return no(isMasked(active) ? "masked" : "embed_ui");
      const el = active ?? page.doc.body;
      if (!el) return no("no_focus");
      const init = { key: a.key, bubbles: true, cancelable: true, composed: true };
      const go = el.dispatchEvent(new win.KeyboardEvent("keydown", init));
      if (go) {
        const field = editable(el);
        const textField = field instanceof win.HTMLInputElement || field instanceof win.HTMLTextAreaElement ? field : null;
        if ((a.key === "Backspace" || a.key === "Delete") && textField) {
          backspace(textField, a.key === "Delete", win);
        } else if (a.key === "Tab") {
          // A synthetic Tab moves nothing by itself: move focus as Tab would.
          const all = Array.from(page.doc.querySelectorAll<HTMLElement>('input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])')).filter(
            (e) => !page.isOwnUi(e) && !(e as HTMLInputElement).disabled && (e as HTMLInputElement).type !== "hidden",
          );
          const next = all[(all.indexOf(el as HTMLElement) + 1) % Math.max(1, all.length)];
          next?.focus();
        } else if (a.key === "Enter" && el instanceof win.HTMLInputElement && el.form) {
          const action = el.form.getAttribute("action") ?? "";
          let same = false;
          try {
            same = new URL(action || page.doc.baseURI, page.doc.baseURI).origin === win.location.origin;
          } catch {
            same = false;
          }
          if (!same) {
            el.dispatchEvent(new win.KeyboardEvent("keyup", init));
            return no("navigation_blocked");
          }
          el.form.requestSubmit();
        }
      }
      el.dispatchEvent(new win.KeyboardEvent("keyup", init));
      return yes;
    }
  }
}
