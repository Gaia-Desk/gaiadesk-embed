// The consent dialog and the sharing bar: branded, and never markup.

import { test } from "node:test";
import assert from "node:assert/strict";

import { consentText, EmbedUi, safeColor, safeLogo, safeName } from "../dist/ui.js";
import { page } from "./helpers.js";

test("branding is validated", () => {
  assert.equal(safeColor("#0F766E", "#000"), "#0F766E");
  assert.equal(safeColor("#abc", "#000"), "#abc");
  for (const bad of ["red; background:url(x)", "expression(alert(1))", "#12345", "", undefined]) assert.equal(safeColor(bad, "#000"), "#000");
  assert.equal(safeLogo("https://cdn.example.com/logo.png"), "https://cdn.example.com/logo.png");
  assert.equal(safeLogo("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  for (const bad of ["javascript:alert(1)", "http://cdn.example.com/l.png", "data:text/html,<b>", "not a url"]) assert.equal(safeLogo(bad), null, bad);
  assert.equal(safeName("  Acme\u0007 Corp "), "Acme Corp");
  assert.equal(safeName(""), "our");
  assert.equal(safeName("x".repeat(80)).length, 60);
});

test("the consent says what is shared, and co-browsing only when asked", () => {
  const view = consentText("Acme", "view");
  assert.equal(view.title, "Share this tab with Acme support?");
  assert.ok(view.body.join(" ").includes("this browser tab only"));
  assert.ok(view.body.join(" ").includes("stay hidden"));
  assert.ok(!view.body.join(" ").includes("click and type"));
  assert.ok(consentText("Acme", "cobrowse").body.join(" ").includes("click and type inside this page"));
});

test("a company name full of markup is shown as text", () => {
  const { doc } = page("");
  const ui = new EmbedUi(doc, { name: `<img src=x onerror="window.pwned=1">Acme`, color: "#0f766e" });
  ui.consent("view", () => undefined, () => undefined);
  const text = ui.dialogText() ?? "";
  assert.ok(text.includes(`<img src=x onerror="window.pwned=1">Acme support`), text);
  assert.equal(doc.querySelectorAll("img").length, 0);
  assert.equal(ui.host.getAttribute("style")?.includes("--accent: #0f766e"), true);
  ui.remove();
  assert.equal(doc.querySelector("gaiadesk-embed"), null);
});

test("the bar names the company, shows the support code, and Stop / Pause work", () => {
  const { doc } = page("");
  const ui = new EmbedUi(doc, { name: "Acme" });
  let stopped = 0;
  const toggles: boolean[] = [];
  ui.showBar({ onStop: () => stopped++, onToggleControl: (a) => toggles.push(a) }, "cobrowse", "123456789");
  assert.equal(ui.barText(), "Sharing with Acme support· Code 123 456 789Pause controlStop");
  assert.ok(ui.press("Pause control"));
  assert.ok(ui.press("Allow control"));
  assert.deepEqual(toggles, [false, true]);
  assert.ok(ui.press("Stop"));
  assert.equal(stopped, 1);
  const viewOnly = new EmbedUi(doc, { name: "Acme" });
  viewOnly.showBar({ onStop: () => undefined, onToggleControl: () => undefined }, "view", null);
  assert.equal(viewOnly.barText(), "Sharing with Acme supportStop", "no control button in view mode");
  assert.equal(ui.owns(ui.host), true);
  assert.equal(ui.owns(doc.body), false);
});
