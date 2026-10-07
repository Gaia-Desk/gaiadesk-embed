// Masking: which elements are painted over in the shared picture, and where.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isMasked, MaskHistory, maskedRects, toFrame, MASK_PAD } from "../dist/mask.js";
import { box, page } from "./helpers.js";

test("passwords, data-gaiadesk-mask (and all inside it) and secret autocompletes are masked", () => {
  const { doc } = page(`
    <input id="pw" type="password"><input id="PW" type="PASSWORD">
    <section data-gaiadesk-mask><p id="inner">secret</p></section>
    <input id="otp" autocomplete="one-time-code"><input id="cc" autocomplete="cc-number">
    <input id="newpw" autocomplete="new-password">
    <input id="plain" type="text"><p id="text">hello</p>`);
  for (const id of ["pw", "PW", "inner", "otp", "cc", "newpw"]) assert.equal(isMasked(doc.getElementById(id)), true, id);
  for (const id of ["plain", "text"]) assert.equal(isMasked(doc.getElementById(id)), false, id);
});

test("masked rectangles come from the layout, descendants included, empty boxes skipped", () => {
  const { doc } = page(`<input id="pw" type="password"><div id="m" data-gaiadesk-mask><span id="child"></span></div><input id="hidden" type="password"><input id="plain">`);
  box(doc.getElementById("pw")!, 10, 20, 100, 30);
  box(doc.getElementById("m")!, 0, 100, 50, 50);
  // A positioned child drawn outside its masked parent is masked too.
  box(doc.getElementById("child")!, 600, 400, 40, 20);
  box(doc.getElementById("hidden")!, 0, 0, 0, 0);
  box(doc.getElementById("plain")!, 300, 300, 100, 30);
  const rects = maskedRects(doc).sort((a, b) => a.x - b.x || a.y - b.y);
  assert.deepEqual(rects, [
    { x: 0, y: 100, w: 50, h: 50 },
    { x: 10, y: 20, w: 100, h: 30 },
    { x: 600, y: 400, w: 40, h: 20 },
  ]);
});

test("viewport rectangles map onto the captured frame, padded and clipped", () => {
  // A 1000x500 CSS viewport captured at 2000x1000 (a 2x display).
  const out = toFrame([{ x: 10, y: 20, w: 100, h: 30 }], { w: 1000, h: 500 }, { w: 2000, h: 1000 });
  assert.deepEqual(out, [{ x: (10 - MASK_PAD) * 2, y: (20 - MASK_PAD) * 2, w: (100 + 2 * MASK_PAD) * 2, h: (30 + 2 * MASK_PAD) * 2 }]);
  const edge = toFrame([{ x: 995, y: -10, w: 50, h: 20 }], { w: 1000, h: 500 }, { w: 1000, h: 500 });
  assert.deepEqual(edge, [{ x: 989, y: 0, w: 11, h: 16 }], "clipped to the frame");
  assert.deepEqual(toFrame([{ x: 2000, y: 0, w: 10, h: 10 }], { w: 1000, h: 500 }, { w: 1000, h: 500 }), [], "off screen");
  assert.deepEqual(toFrame([{ x: 0, y: 0, w: 10, h: 10 }], { w: 0, h: 0 }, { w: 1000, h: 500 }), []);
});

test("a rectangle stays masked for a few frames after it moved (scrolling)", () => {
  const h = new MaskHistory(3);
  const a = { x: 0, y: 0, w: 1, h: 1 };
  const b = { x: 0, y: 50, w: 1, h: 1 };
  assert.deepEqual(h.push([a]), [a]);
  assert.deepEqual(h.push([b]), [a, b], "the old place too");
  h.push([b]);
  assert.deepEqual(h.push([b]), [b, b, b], "until it has aged out");
});
