// Co-browsing's safety rules: what an agent's request may and may not do.

import { test } from "node:test";
import assert from "node:assert/strict";

import { apply, parseAction, RateLimit, type Action, type Page, type Permission } from "../dist/cobrowse.js";
import { page, type Win } from "./helpers.js";

const ON: Permission = { mode: "cobrowse", allowed: true, verified: true };

const HTML = `
  <button id="buy">Buy</button>
  <input id="name" type="text" maxlength="8">
  <input id="pw" type="password">
  <input id="code" autocomplete="one-time-code">
  <input id="ro" type="text" readonly>
  <input id="file" type="file">
  <div data-gaiadesk-mask><span id="ssn">123-45-6789</span><input id="inmask" type="text"></div>
  <a id="here" href="/orders">Orders</a>
  <a id="away" href="https://evil.example.net/phish">Elsewhere</a>
  <a id="js" href="javascript:alert(1)">JS</a>
  <form id="f" action="/pay"><input id="q" type="text"><button id="go" type="submit">Pay</button></form>
  <form id="xf" action="https://evil.example.net/steal"><input id="xq" type="text"><button id="xgo" type="submit">Send</button></form>
  <gaiadesk-embed id="ui"></gaiadesk-embed>
`;

/** A page where point (x, y) in [0,1]² hits whatever `at` says. */
function setup(): { doc: Document; win: Win; at: (id: string) => Page; focus: (id: string) => HTMLElement } {
  const { doc, win } = page(HTML);
  const ui = doc.getElementById("ui")!;
  const at = (id: string): Page => ({ doc, elementAt: () => doc.getElementById(id), isOwnUi: (el) => el === ui || ui.contains(el) });
  const focus = (id: string) => {
    const el = doc.getElementById(id) as HTMLElement;
    el.focus();
    return el;
  };
  return { doc, win, at, focus };
}

const click = (x = 0.5, y = 0.5): Action => ({ t: "click", x, y });

test("requests are parsed strictly", () => {
  assert.deepEqual(parseAction({ t: "click", x: 0.2, y: 0.9, id: 3 }), { t: "click", x: 0.2, y: 0.9, id: 3 });
  assert.equal(parseAction({ t: "click", x: 1.2, y: 0.5 }), null, "outside the page");
  assert.equal(parseAction({ t: "click", x: -0.1, y: 0.5 }), null);
  assert.equal(parseAction({ t: "click", x: "0.5", y: 0.5 }), null);
  assert.equal(parseAction({ t: "type", text: "a".repeat(501) }), null, "at most 500 characters");
  assert.equal(parseAction({ t: "type", text: "line\nbreak" }), null, "no control characters");
  assert.equal(parseAction({ t: "key", key: "F12" }), null, "only listed keys");
  assert.equal(parseAction({ t: "eval", code: "x" }), null);
  assert.equal(parseAction(null), null);
  assert.deepEqual(parseAction({ t: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 99999 }), { t: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 2000, id: undefined }, "clamped");
});

test("a click lands on the element under the point, as synthetic events", () => {
  const { doc, at } = setup();
  const seen: string[] = [];
  const buy = doc.getElementById("buy")!;
  for (const t of ["mousedown", "mouseup", "click"]) buy.addEventListener(t, (e) => seen.push(`${t}:${(e as MouseEvent).isTrusted}`));
  assert.deepEqual(apply(click(), at("buy"), ON), { applied: true });
  assert.deepEqual(seen, ["mousedown:false", "mouseup:false", "click:false"], "untrusted, never OS input");
});

test("never a masked element, a password, a one-time code, or anything inside a mask", () => {
  const { at } = setup();
  for (const id of ["pw", "code", "ssn", "inmask"]) assert.deepEqual(apply(click(), at(id), ON), { applied: false, reason: "masked" }, id);
});

test("never the embed's own UI, never a file picker, never another origin", () => {
  const { doc, at } = setup();
  assert.deepEqual(apply(click(), at("ui"), ON), { applied: false, reason: "embed_ui" });
  assert.deepEqual(apply(click(), at("file"), ON), { applied: false, reason: "file_picker_blocked" });
  assert.deepEqual(apply(click(), at("away"), ON), { applied: false, reason: "navigation_blocked" });
  assert.deepEqual(apply(click(), at("js"), ON), { applied: false, reason: "navigation_blocked" });
  assert.deepEqual(apply(click(), at("xgo"), ON), { applied: false, reason: "navigation_blocked" }, "a form posting elsewhere");
  doc.getElementById("here")!.addEventListener("click", (e) => e.preventDefault());
  assert.deepEqual(apply(click(), at("here"), ON), { applied: true }, "a same-origin link is fine");
  assert.deepEqual(apply(click(), { ...at("buy"), elementAt: () => null }, ON), { applied: false, reason: "nothing_there" });
});

test("only in cobrowse mode, only on a verified tab, only while the customer allows it", () => {
  const { at } = setup();
  assert.deepEqual(apply(click(), at("buy"), { ...ON, mode: "view" }), { applied: false, reason: "view_only" });
  assert.deepEqual(apply(click(), at("buy"), { ...ON, verified: false }), { applied: false, reason: "surface_unverified" });
  assert.deepEqual(apply(click(), at("buy"), { ...ON, allowed: false }), { applied: false, reason: "control_paused" });
  assert.deepEqual(apply({ t: "pointer", x: 0.5, y: 0.5 }, at("buy"), { ...ON, allowed: false }), { applied: true }, "pointing is not control");
  assert.deepEqual(apply({ t: "pointer", x: 0.5, y: 0.5 }, at("buy"), { ...ON, mode: "view" }), { applied: false, reason: "view_only" });
});

test("typing goes into the focused text field the way a framework sees it", () => {
  const { doc, win, at, focus } = setup();
  const name = focus("name") as HTMLInputElement;
  const inputs: string[] = [];
  name.addEventListener("input", (e) => inputs.push((e as InputEvent).data ?? ""));
  assert.deepEqual(apply({ t: "type", text: "Ada" }, at("name"), ON), { applied: true });
  assert.equal(name.value, "Ada");
  assert.deepEqual(apply({ t: "type", text: " Lovelace" }, at("name"), ON), { applied: true });
  assert.equal(name.value, "Ada Love", "maxlength holds");
  assert.deepEqual(inputs, ["Ada", " Love"]);
  assert.deepEqual(apply({ t: "key", key: "Backspace" }, at("name"), ON), { applied: true });
  assert.equal(name.value, "Ada Lov");
  // A framework's own value tracking sees the native setter.
  let tracked = "";
  const desc = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!;
  Object.defineProperty(name, "value", { configurable: true, get: () => desc.get!.call(name), set: (v: string) => { tracked = v; desc.set!.call(name, v); } });
  apply({ t: "type", text: "!" }, at("name"), ON);
  assert.equal(tracked, "", "the instance's own setter was bypassed: the prototype's was used");
  assert.equal(name.value, "Ada Lov!");
  void doc;
});

test("typing never reaches a password, a masked field, a read-only field or the embed", () => {
  const { at, focus } = setup();
  focus("pw");
  assert.deepEqual(apply({ t: "type", text: "hunter2" }, at("pw"), ON), { applied: false, reason: "masked" });
  assert.equal((focus("pw") as HTMLInputElement).value, "");
  focus("inmask");
  assert.deepEqual(apply({ t: "type", text: "x" }, at("inmask"), ON), { applied: false, reason: "masked" });
  focus("pw");
  assert.deepEqual(apply({ t: "key", key: "Backspace" }, at("pw"), ON), { applied: false, reason: "masked" }, "no keys into a password either");
  focus("ro");
  assert.deepEqual(apply({ t: "type", text: "x" }, at("ro"), ON), { applied: false, reason: "not_editable" });
  focus("buy");
  assert.deepEqual(apply({ t: "type", text: "x" }, at("buy"), ON), { applied: false, reason: "not_editable" });
});

test("Tab moves focus; Enter submits a same-origin form and never one posting elsewhere", () => {
  const { doc, at, focus } = setup();
  focus("name");
  apply({ t: "key", key: "Tab" }, at("name"), ON);
  assert.equal(doc.activeElement?.id, "pw", "focus moved (typing there is still refused)");
  let submitted = 0;
  doc.getElementById("f")!.addEventListener("submit", (e) => {
    e.preventDefault();
    submitted++;
  });
  focus("q");
  assert.deepEqual(apply({ t: "key", key: "Enter" }, at("q"), ON), { applied: true });
  assert.equal(submitted, 1);
  let away = 0;
  doc.getElementById("xf")!.addEventListener("submit", (e) => {
    e.preventDefault();
    away++;
  });
  focus("xq");
  assert.deepEqual(apply({ t: "key", key: "Enter" }, at("xq"), ON), { applied: false, reason: "navigation_blocked" });
  assert.equal(away, 0);
});

test("scrolling scrolls the page (clamped), even over a masked area, never the embed", () => {
  const { win, at } = setup();
  const calls: unknown[] = [];
  (win as unknown as { scrollBy: (o: unknown) => void }).scrollBy = (o) => calls.push(o);
  assert.deepEqual(apply({ t: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 300 }, at("buy"), ON), { applied: true });
  assert.deepEqual(apply({ t: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 300 }, at("ssn"), ON), { applied: true });
  assert.deepEqual(apply({ t: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 300 }, at("ui"), ON), { applied: false, reason: "embed_ui" });
  assert.deepEqual(calls, [{ left: 0, top: 300 }, { left: 0, top: 300 }]);
});

test("at most 20 requests a second", () => {
  const r = new RateLimit();
  const taken = Array.from({ length: 25 }, () => r.take(1000)).filter(Boolean).length;
  assert.equal(taken, 20);
  assert.equal(r.take(2001), true, "a second later");
});
