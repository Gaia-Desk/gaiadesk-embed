// @gaiadesk/embed: a "Get help" button that lets your support team see —
// and, if you allow it, guide — your customer's browser tab, from the
// GaiaDesk console.
//
//   import { GaiaDeskEmbed } from "@gaiadesk/embed";
//   const help = GaiaDeskEmbed.start({ publishableKey: "ak_…", customer: { name: "Ada" }, mode: "cobrowse",
//                                      branding: { name: "Acme", color: "#0f766e" } });
//   help.on("ready", ({ joinCode }) => …);
//   help.stop();

import { browserEnv, Session, type Env } from "./session.js";
import type { EventName, Listener, StartOptions, State } from "./types.js";

export type {
  ActionReport, Branding, Customer, EmbedError, EndReason, EventMap, EventName, Listener, StartOptions, State, SupportMode,
} from "./types.js";
export { MASK_SELECTOR } from "./mask.js";
export { CHANNEL } from "./session.js";

export const VERSION = "0.1.0";

/** A running (or finished) support session. */
export interface EmbedHandle {
  readonly state: State;
  /** Listen; returns a function that stops listening. */
  on<K extends EventName>(name: K, fn: Listener<K>): () => void;
  /** End the session now (the same as the bar's Stop). */
  stop(): void;
}

let current: Session | null = null;

function handle(s: Session): EmbedHandle {
  return {
    get state() {
      return s.state;
    },
    on: (name, fn) => s.on(name, fn),
    stop: () => s.stop(),
  };
}

/**
 * Start a support session: shows the consent dialog at once (call it from
 * your "Get help" click). One session per page at a time: starting again
 * while one runs returns the running one.
 */
function start(options: StartOptions, env?: Env): EmbedHandle {
  if (current && current.state !== "ended") return handle(current);
  const s = new Session(options, env ?? browserEnv());
  current = s;
  s.on("ended", () => {
    if (current === s) current = null;
  });
  // Listeners attached right after start() still hear the first state.
  queueMicrotask(() => s.begin());
  return handle(s);
}

/** End the running session, if any. */
function stop(): void {
  current?.stop();
}

/** The running session's state (`idle` when none). */
function state(): State {
  return current?.state ?? "idle";
}

export const GaiaDeskEmbed = { start, stop, state, VERSION };
export default GaiaDeskEmbed;
// Named too, so the <script> build's global `GaiaDeskEmbed` has them.
export { start, stop, state };
