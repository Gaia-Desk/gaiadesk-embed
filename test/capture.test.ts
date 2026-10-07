// The share: only a browser tab, verified as this one through Capture Handle.

import { test } from "node:test";
import assert from "node:assert/strict";

import { judge, shareThisTab } from "../dist/capture.js";
import { FakeStream, FakeTrack } from "./helpers.js";

function nav(track: FakeTrack | Error) {
  const calls: { config?: unknown; constraints?: unknown } = {};
  const md = {
    setCaptureHandleConfig(c: { handle: string }) {
      calls.config = c;
      if (track instanceof FakeTrack && track.handle === "MINE") track.handle = c.handle;
    },
    async getDisplayMedia(c: unknown) {
      calls.constraints = c;
      if (track instanceof Error) throw track;
      return new FakeStream([track]);
    },
  };
  return { nav: { mediaDevices: md } as unknown as Navigator, calls };
}

test("judging what was picked", () => {
  assert.deepEqual(judge({ displaySurface: "browser" }, "h", "h"), { ok: true, verified: true });
  assert.deepEqual(judge({ displaySurface: "browser" }, "other", "h"), { ok: true, verified: false });
  assert.deepEqual(judge({ displaySurface: "browser" }, undefined, "h"), { ok: true, verified: false });
  assert.deepEqual(judge({ displaySurface: "window" }, "h", "h"), { ok: false, verified: false });
  assert.deepEqual(judge({ displaySurface: "monitor" }, "h", "h"), { ok: false, verified: false });
  assert.deepEqual(judge({}, "h", "h"), { ok: false, verified: false }, "a surface that does not say is not a tab");
});

test("this tab, verified: its handle comes back on the track", async () => {
  const t = new FakeTrack({ displaySurface: "browser" }, "MINE");
  const { nav: n, calls } = nav(t);
  const got = await shareThisTab(n, "https://shop.example.com");
  assert.equal(got.verified, true);
  assert.deepEqual((calls.config as { permittedOrigins: string[] }).permittedOrigins, ["https://shop.example.com"], "only this origin may read the handle");
  const c = calls.constraints as Record<string, unknown>;
  assert.equal(c.preferCurrentTab, true);
  assert.equal(c.audio, false, "never audio");
  assert.equal(c.monitorTypeSurfaces, "exclude");
});

test("another tab: shared, but not verified (view only)", async () => {
  const got = await shareThisTab(nav(new FakeTrack({ displaySurface: "browser" }, "someone-else")).nav, "https://x.test");
  assert.equal(got.verified, false);
});

test("a window or a screen is refused and its capture stopped at once", async () => {
  for (const surface of ["window", "monitor"]) {
    const t = new FakeTrack({ displaySurface: surface }, "MINE");
    await assert.rejects(shareThisTab(nav(t).nav, "https://x.test"), (e: { code: string }) => e.code === "not_a_tab");
    assert.equal(t.stopped, true, surface);
  }
});

test("saying no in the browser's prompt is a decline; no API is unsupported", async () => {
  await assert.rejects(shareThisTab(nav(new Error("Permission denied")).nav, "https://x.test"), (e: { code: string }) => e.code === "declined");
  await assert.rejects(shareThisTab({} as Navigator, "https://x.test"), (e: { code: string }) => e.code === "unsupported");
});
