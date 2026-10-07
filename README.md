# @gaiadesk/embed

A **"Get help" button for your web app**. Your customer clicks it and agrees; their browser tab is
shared with **your** support team, who see it in the GaiaDesk console and, if you allow it, guide
it: point, highlight, scroll, click and type **inside your page only**.

- TypeScript, **zero runtime dependencies**, ESM and a `<script>` build.
- The browser's own share prompt (`getDisplayMedia`) plus an in-page consent dialog in your
  company's colours and name.
- A visible **"Sharing with Acme support · Stop"** bar for as long as it lasts.
- Passwords and anything you mark `data-gaiadesk-mask` are **painted over** before a single frame
  leaves the page.
- Co-browsing is DOM-level (synthetic events in your page), never operating-system input, and the
  customer can pause it or stop the whole session at any time.

```sh
npm install @gaiadesk/embed
```

## Quick start

### With a publishable key (the page creates its own session)

Mint a **publishable key** on your GaiaDesk account page (API keys → *Publishable*), and register
the page origins it may be used from (`https://app.example.com`). It can do one thing: create
support sessions, from those origins.

```ts
import { GaiaDeskEmbed } from "@gaiadesk/embed";

helpButton.addEventListener("click", () => {
  const help = GaiaDeskEmbed.start({
    publishableKey: "ak_…",
    customer: { name: user.name, account: user.id },
    mode: "cobrowse", // or "view"
    branding: { name: "Acme", color: "#0f766e", logoUrl: "https://acme.example/logo.svg" },
  });
  help.on("ready", ({ joinCode }) => console.log("support code", joinCode));
  help.on("ended", ({ reason }) => console.log("ended:", reason));
});
```

### With an embed token (your backend creates the session)

Your server calls the GaiaDesk API with a secret API key (scope `support`) and hands the page the
`embed_token`:

```sh
curl -s -X POST https://api.gaiadesk.net/v1/support/sessions \
  -H "Authorization: Bearer $GAIADESK_API_KEY" -H "Content-Type: application/json" \
  -d '{"mode": "cobrowse", "customer": {"name": "Ada", "plan": "pro"}, "origin": "https://app.example.com"}'
# → {"id": "ss_…", "join_code": "123456789", "join_url": "…", "embed_token": "gdemb_…", …}
```

```ts
GaiaDeskEmbed.start({ embedToken, branding: { name: "Acme" } });
```

This is the stronger form: your backend vouches for who the customer is (`customer_verified:
true` in the console), and the session's mode is whatever your backend asked for.

### `<script>` tag

```html
<script src="https://cdn.jsdelivr.net/npm/@gaiadesk/embed@0.1.0/dist/gaiadesk-embed.min.js"></script>
<script>
  document.querySelector("#help").onclick = () =>
    GaiaDeskEmbed.start({ publishableKey: "ak_…", branding: { name: "Acme" } });
</script>
```

## API

`GaiaDeskEmbed.start(options)` shows the consent dialog at once (call it from your button's click)
and returns a handle: `handle.state`, `handle.on(event, fn)` (returns an unsubscribe function) and
`handle.stop()`. `GaiaDeskEmbed.stop()` ends the running session; `GaiaDeskEmbed.state()` reads it.
One session runs per page at a time.

| Option | |
|---|---|
| `publishableKey` | a publishable key (`ak_…`) registered for this page's origin, **or** |
| `embedToken` | an embed token (`gdemb_…`) from your backend |
| `customer` | flat object of short strings, numbers and booleans (at most 16 fields), shown to your agents |
| `mode` | `"view"` (default) or `"cobrowse"` (with a publishable key; an embed token's session has its own) |
| `branding` | `{ name, color?, textColor?, logoUrl? }`: colours `#rgb`/`#rrggbb`, logo `https:` or `data:image/…` |
| `expiresIn` | seconds the session lives (publishable key, 60 to 3600; default 3600) |
| `server` | the GaiaDesk server (default `https://gaiadesk.net`) |

| Event | Detail |
|---|---|
| `state` | `{ state }`: `consent`, `starting`, `waiting`, `connected`, `ended` |
| `ready` | `{ sessionId, joinCode, mode }`: the session is up; `joinCode` is the support code |
| `joined` / `left` | `{ agent }` (the agent's email) / `{}` |
| `control` | `{ allowed }`: the customer paused or allowed co-browsing |
| `action` | `{ type, applied, reason? }`: an agent request and what became of it |
| `error` | `{ code, message }` |
| `ended` | `{ reason }`: `stopped`, `declined`, `expired`, `disconnected` or `error` |

## What the agent sees, and what they can do

- **Only this tab.** The share must be a browser tab; a window or a whole screen is refused at once
  (their content around your page could not be masked). The embed asks the browser for *this* tab
  (`preferCurrentTab`) and verifies the pick with the Capture Handle API; co-browsing is offered
  only when the shared tab is verified to be this one (Chromium-based browsers today). Elsewhere the
  agent can still see, but not act.
- **Masking.** Every frame is drawn into a canvas with masks painted over before it is sent:
  `input[type=password]`, inputs whose `autocomplete` is `current-password`, `new-password`,
  `one-time-code`, `cc-number` or `cc-csc`, and every element with `data-gaiadesk-mask` (and
  everything inside it). Masks are padded and held for a few frames, so a field that just scrolled
  stays covered.

  ```html
  <div data-gaiadesk-mask>Account balance: $12,345.67</div>
  ```

- **Co-browsing** (`cobrowse` mode, verified tab, control not paused). The agent's pointer and
  highlights appear in your page, labelled with your company's name. Their clicks, scrolls, typing
  and a few keys (Enter, Tab, Backspace, Delete, Escape, arrows, Home, End) are applied as
  synthetic DOM events to what is under the point. Never:
  - outside this document, or on the embed's own dialog and bar;
  - on a masked element or a password (no clicks, no typing, no keys);
  - a file picker, a `javascript:` link, or a link or form that leaves your origin;
  - more than 500 characters at once or 20 requests a second.

  The customer can **Pause control** (and allow it again) from the bar, and **Stop** ends
  everything: the share, the connection and the session.

## How it works

The page connects to GaiaDesk's signaling server (`wss://gaiadesk.net/ws?embed=<token>`) as a
short-lived, QuickSupport-style host for this one session; the token is good for that session only,
until it ends. Your support agents — the members of the account or team that owns the key — see the
session in the GaiaDesk console and join with its support code; the page checks the code itself.
Video and the co-browsing channel go over WebRTC (with GaiaDesk's TURN relay when a direct path
fails). Every session is audited, and your webhooks hear `support.session.joined` and
`support.session.ended`.

## Development

```sh
npm ci
npm test         # build (tsc + the <script> bundle) and run the tests (jsdom, faked WebRTC)
npm run typecheck
```

`demo/index.html` is a small shop page with a "Get help" button: build, serve the repository root,
and open `demo/index.html?server=https://gaiadesk.net&pk=ak_…` (or `&token=gdemb_…`).

## License

MIT
