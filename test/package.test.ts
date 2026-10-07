// The package: zero runtime dependencies, an ESM entry, and a <script>
// build that defines the global `GaiaDeskEmbed`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, unknown>;

test("zero runtime dependencies", () => {
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.license, "MIT");
});

test("the ESM entry exports the API", async () => {
  const m = (await import("../dist/index.js")) as Record<string, unknown>;
  for (const k of ["GaiaDeskEmbed", "start", "stop", "state", "VERSION", "MASK_SELECTOR", "CHANNEL"]) assert.ok(k in m, k);
  assert.equal(m.VERSION, pkg.version, "VERSION is the package's");
  assert.equal(m.CHANNEL, "gaiadesk-cobrowse");
});

test("the <script> build defines window.GaiaDeskEmbed", () => {
  for (const file of ["gaiadesk-embed.js", "gaiadesk-embed.min.js"]) {
    const src = readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8");
    const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", url: "https://shop.example.com/" });
    // As a <script> tag runs it: its top-level `var GaiaDeskEmbed` is the global.
    const g = dom.window.eval(`${src}\n;GaiaDeskEmbed`) as Record<string, unknown> | undefined;
    assert.ok(g, file);
    assert.equal(typeof g.start, "function", file);
    assert.equal(typeof g.stop, "function", file);
    assert.equal((g.state as () => string)(), "idle", file);
  }
});
