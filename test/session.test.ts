// A whole session with the browser's parts faked: consent, the share, the
// session created with a publishable key, the signaling socket, an agent
// joining over WebRTC, co-browsing requests, pause, and Stop.

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkOptions, endpoints, Session, type Env } from "../dist/session.js";
import { start } from "../dist/index.js";
import { FakePeer, FakeStream, FakeTrack, FakeWebSocket, flush, page } from "./helpers.js";

const TOKEN = `gdemb_${"ab".repeat(32)}`;

function env(html = `<button id="buy">Buy</button><input id="pw" type="password">`) {
  const { win, doc } = page(html);
  const track = new FakeTrack();
  const fetches: { url: string; init: RequestInit }[] = [];
  let shares = 0;
  const e: Env = {
    win,
    doc,
    nav: {} as Navigator,
    fetch: (async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      return { ok: true, status: 201, json: async () => ({ id: "ss_0123456789abcdef", embed_token: TOKEN, join_code: "123456789" }) } as Response;
    }) as unknown as typeof fetch,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    RTCPeerConnection: FakePeer as unknown as typeof RTCPeerConnection,
    share: async () => {
      shares++;
      return { stream: new FakeStream([track]) as unknown as MediaStream, track: track as unknown as MediaStreamTrack, verified: true };
    },
    composite: (t) => ({ track: t, stop: () => undefined }),
  };
  return { e, win, doc, track, fetches, shares: () => shares };
}

const SUPPORT = { type: "support_session", session_id: "ss_0123456789abcdef", join_code: "123456789", mode: "cobrowse", expires_at: 1, ice_servers: [{ urls: "stun:stun.example" }] };

test("options and endpoints", () => {
  assert.equal(checkOptions({ publishableKey: "ak_x" }), null);
  assert.equal(checkOptions({ embedToken: TOKEN }), null);
  assert.match(checkOptions({}) ?? "", /exactly one/);
  assert.match(checkOptions({ publishableKey: "ak_x", embedToken: TOKEN }) ?? "", /exactly one/);
  assert.match(checkOptions({ embedToken: "nope" }) ?? "", /embed token/);
  assert.match(checkOptions({ publishableKey: "k", mode: "control" as never }) ?? "", /view or cobrowse/);
  assert.match(checkOptions({ publishableKey: "k", expiresIn: 7200 }) ?? "", /3600/);
  assert.deepEqual(endpoints(undefined), { api: "https://gaiadesk.net/v1", ws: "wss://gaiadesk.net/ws" });
  assert.deepEqual(endpoints("http://127.0.0.1:9000/"), { api: "http://127.0.0.1:9000/v1", ws: "ws://127.0.0.1:9000/ws" });
  assert.throws(() => endpoints("http://gaiadesk.example"), /https/);
});

test("a publishable-key session from consent to Stop", async () => {
  const { e, doc, track, fetches } = env();
  const h = start({ publishableKey: "ak_pub", customer: { name: "Ada" }, mode: "cobrowse", branding: { name: "Acme", color: "#0f766e" }, server: "https://gaiadesk.example" }, e);
  const events: string[] = [];
  let ready: unknown = null;
  let joined: unknown = null;
  let ended: unknown = null;
  h.on("state", ({ state }) => events.push(state));
  h.on("ready", (d) => (ready = d));
  h.on("joined", (d) => (joined = d));
  h.on("ended", (d) => (ended = d));
  await flush();
  assert.equal(h.state, "consent");
  assert.ok(doc.querySelector("gaiadesk-embed"), "the embed's UI is on the page");

  // Consent → the browser's prompt → the session → the socket.
  const session = sessionOf(doc);
  assert.ok(session.press("Share this tab"));
  await flush();
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, "https://gaiadesk.example/v1/support/sessions");
  assert.equal((fetches[0].init.headers as Record<string, string>).Authorization, "Bearer ak_pub");
  assert.deepEqual(JSON.parse(String(fetches[0].init.body)), { mode: "cobrowse", customer: { name: "Ada" } });
  const ws = FakeWebSocket.last!;
  assert.equal(ws.url, `wss://gaiadesk.example/ws?embed=${TOKEN}`);

  await ws.deliver(SUPPORT);
  assert.deepEqual(ws.types(), ["register_host"]);
  await ws.deliver({ type: "registered", host_id: "987654321" });
  assert.equal(h.state, "waiting");
  assert.deepEqual(ready, { sessionId: "ss_0123456789abcdef", joinCode: "123456789", mode: "cobrowse" });
  assert.match(session.barText() ?? "", /^Sharing with Acme support · waiting for an agent· Code 123 456 789/);

  // A wrong code is rejected by the tab itself; the right one gets an offer.
  FakePeer.all = [];
  await ws.deliver({ type: "connect_request", access_code: "000000000", controller_email: "eve@x.test" });
  assert.deepEqual(ws.sent.at(-1), { type: "reject", reason: "wrong support code" });
  assert.equal(FakePeer.all.length, 0);
  await ws.deliver({ type: "connect_request", access_code: "123456789", controller_email: "agent@acme.test" });
  const pc = FakePeer.all[0];
  assert.deepEqual(pc.config.iceServers, [{ urls: "stun:stun.example" }]);
  assert.equal(pc.tracks.length, 1, "the masked track");
  assert.deepEqual(ws.sent.at(-1), { type: "offer", sdp: "v=0 fake offer" });
  await ws.deliver({ type: "ice", candidate: { candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 } });
  await ws.deliver({ type: "answer", sdp: "v=0 answer" });
  assert.equal(pc.remoteDescription?.sdp, "v=0 answer");
  assert.deepEqual(pc.candidates, [{ candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 }], "an early candidate waited for the answer");

  // The channel opens: hello, joined.
  const dc = pc.channels[0];
  assert.equal(dc.label, "gaiadesk-cobrowse");
  dc.open();
  assert.deepEqual(dc.sent[0], { t: "hello", mode: "cobrowse", cobrowse: true, control: true, verified: true });
  assert.equal(h.state, "connected");
  assert.deepEqual(joined, { agent: "agent@acme.test" });

  // Requests: a click lands; a password is refused; pausing stops them.
  let bought = 0;
  doc.getElementById("buy")!.addEventListener("click", () => bought++);
  (doc as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => doc.getElementById("buy");
  await dc.agentSays({ t: "click", x: 0.5, y: 0.5, id: 1 });
  assert.equal(bought, 1);
  assert.deepEqual(dc.sent.at(-1), { t: "ack", id: 1, ok: true });
  (doc as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => doc.getElementById("pw");
  await dc.agentSays({ t: "click", x: 0.5, y: 0.5, id: 2 });
  assert.deepEqual(dc.sent.at(-1), { t: "ack", id: 2, ok: false, reason: "masked" });
  assert.ok(session.press("Pause control"));
  assert.deepEqual(dc.sent.at(-1), { t: "control", allowed: false });
  (doc as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => doc.getElementById("buy");
  await dc.agentSays({ t: "click", x: 0.5, y: 0.5, id: 3 });
  assert.deepEqual(dc.sent.at(-1), { t: "ack", id: 3, ok: false, reason: "control_paused" });
  assert.equal(bought, 1);

  // The agent leaves: back to waiting. Then Stop.
  await ws.deliver({ type: "peer_left" });
  assert.equal(pc.closed, true);
  assert.equal(h.state, "waiting");
  assert.ok(session.press("Stop"));
  assert.deepEqual(ws.sent.at(-1), { type: "leave" });
  assert.equal(ws.closed, true);
  assert.equal(track.stopped, true, "the capture is stopped");
  assert.equal(doc.querySelector("gaiadesk-embed"), null, "the UI is gone");
  assert.deepEqual(ended, { reason: "stopped" });
  assert.deepEqual(events, ["consent", "starting", "waiting", "connected", "waiting", "ended"]);
});

/** The session's UI (closed shadow root) through the Session the page holds. */
function sessionOf(doc: Document): { press(label: string): boolean; barText(): string | null } {
  const s = live.get(doc);
  if (!s) throw new Error("no session");
  return { press: (l) => s.view!.press(l), barText: () => s.view!.barText() };
}
const live = new WeakMap<Document, Session>();
// Remember each Session by its document (the public handle hides it).
const origBegin = Session.prototype.begin;
Session.prototype.begin = function (this: Session) {
  live.set((this as unknown as { env: Env }).env.doc, this);
  return origBegin.call(this);
};

test("an embed token: the server's mode rules, and expiry ends it", async () => {
  const { e, doc, fetches } = env();
  const s = new Session({ embedToken: TOKEN, mode: "cobrowse", branding: { name: "Acme" } }, e);
  const ends: unknown[] = [];
  s.on("ended", (d) => ends.push(d));
  s.begin();
  assert.ok(s.view!.press("Share this tab"));
  await flush();
  assert.equal(fetches.length, 0, "no session to create");
  const ws = FakeWebSocket.last!;
  assert.equal(ws.url, `wss://gaiadesk.net/ws?embed=${TOKEN}`);
  await ws.deliver({ ...SUPPORT, mode: "view" });
  await ws.deliver({ type: "registered", host_id: "987654321" });
  FakePeer.all = [];
  await ws.deliver({ type: "connect_request", access_code: "123456789", controller_email: "agent@acme.test" });
  const dc = FakePeer.all[0].channels[0];
  dc.open();
  assert.equal(dc.sent[0].cobrowse, false, "view mode: no co-browsing whatever the page asked");
  (doc as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => doc.getElementById("buy");
  await dc.agentSays({ t: "click", x: 0.5, y: 0.5, id: 1 });
  assert.deepEqual(dc.sent.at(-1), { t: "ack", id: 1, ok: false, reason: "view_only" });
  await ws.deliver({ type: "error", message: "support_session_expired" });
  assert.deepEqual(ends, [{ reason: "expired" }]);
});

test("declining, the browser's own Stop, and a lost connection", async () => {
  {
    const { e, shares } = env();
    const s = new Session({ embedToken: TOKEN }, e);
    const ends: unknown[] = [];
    s.on("ended", (d) => ends.push(d));
    FakeWebSocket.last = null;
    s.begin();
    assert.ok(s.view!.press("Not now"));
    assert.deepEqual(ends, [{ reason: "declined" }]);
    assert.equal(shares(), 0, "nothing was shared");
    assert.equal(FakeWebSocket.last, null, "nothing was connected");
  }
  {
    const { e, track } = env();
    const s = new Session({ embedToken: TOKEN }, e);
    const ends: unknown[] = [];
    s.on("ended", (d) => ends.push(d));
    s.begin();
    s.view!.press("Share this tab");
    await flush();
    const ws = FakeWebSocket.last!;
    track.dispatchEvent(new Event("ended"));
    assert.deepEqual(ws.sent.at(-1), { type: "leave" }, "the browser's Stop sharing is a Stop");
    assert.deepEqual(ends, [{ reason: "stopped" }]);
  }
  {
    const { e } = env();
    const s = new Session({ embedToken: TOKEN }, e);
    const ends: unknown[] = [];
    s.on("ended", (d) => ends.push(d));
    s.begin();
    s.view!.press("Share this tab");
    await flush();
    const ws = FakeWebSocket.last!;
    await ws.deliver(SUPPORT);
    await ws.deliver({ type: "registered", host_id: "987654321" });
    ws.onclose?.();
    assert.deepEqual(ends, [{ reason: "disconnected" }]);
  }
});

test("a publishable key the server refuses ends with its reason", async () => {
  const { e } = env();
  e.fetch = (async () => ({ ok: false, status: 403, json: async () => ({ error: { reason: "origin_not_allowed", message: "no" } }) })) as unknown as typeof fetch;
  const s = new Session({ publishableKey: "ak_pub" }, e);
  const errs: unknown[] = [];
  const ends: unknown[] = [];
  s.on("error", (d) => errs.push(d));
  s.on("ended", (d) => ends.push(d));
  s.begin();
  s.view!.press("Share this tab");
  await flush();
  assert.deepEqual(errs, [{ code: "origin_not_allowed", message: "no" }]);
  assert.deepEqual(ends, [{ reason: "error" }]);
});
