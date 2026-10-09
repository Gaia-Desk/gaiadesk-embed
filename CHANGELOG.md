# Changelog

## 0.1.0

The first release: GaiaDesk's built-in help desk for web apps.

- `GaiaDeskEmbed.start({ publishableKey | embedToken, customer, mode, branding })`, `.stop()`,
  `.state()`, and events (`state`, `ready`, `joined`, `left`, `control`, `action`, `error`,
  `ended`).
- An in-page consent dialog in the company's colours and name, then the browser's own share prompt
  (`getDisplayMedia`, this tab preferred). Only a browser tab may be shared; the pick is verified as
  this tab with the Capture Handle API.
- A "Sharing with <company> support · Stop" bar, with the support code and, in `cobrowse` mode,
  Pause / Allow control.
- Masking: passwords, secret autocompletes and `data-gaiadesk-mask` painted over in every frame.
- Co-browsing over the `gaiadesk-cobrowse` data channel: pointer, highlight, click, scroll, typing
  and a few keys as synthetic DOM events inside the page only, never on masked elements or the
  embed's UI, never leaving the origin, rate-limited.
- Connects to GaiaDesk signaling as an ephemeral host (`/ws?embed=<token>`), checks each agent's
  support code itself, and talks WebRTC with GaiaDesk's ICE/TURN servers.
- ESM (`dist/index.js`, with types) and a `<script>` build (`dist/gaiadesk-embed.min.js`, global
  `GaiaDeskEmbed`). Zero runtime dependencies.
