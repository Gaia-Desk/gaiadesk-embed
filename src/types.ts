// Public types of @gaiadesk/embed.

/** What the support team may do in this page. */
export type SupportMode = "view" | "cobrowse";

/**
 * Who the customer is, as your app knows them: a flat object of short
 * strings, numbers and booleans (at most 16 fields). Shown to your own
 * support agents only. Used when the embed creates its own session with a
 * publishable key; with an `embedToken` your backend already said it.
 */
export type Customer = Record<string, string | number | boolean | null>;

/** Your company's look for the consent dialog and the sharing bar. */
export interface Branding {
  /** Your company's name: "Sharing with <name> support". */
  name: string;
  /** Accent colour (`#rgb`, `#rrggbb`): buttons and the bar. */
  color?: string;
  /** Text colour on the accent (default white). */
  textColor?: string;
  /** An `https:` (or `data:image/…`) logo shown in the dialog. */
  logoUrl?: string;
}

export interface StartOptions {
  /**
   * A publishable key (`ak_…`, minted as publishable on your GaiaDesk
   * account page, registered for this page's origin): the embed creates its
   * own support session. Give this OR `embedToken`.
   */
  publishableKey?: string;
  /**
   * An embed token (`gdemb_…`) your backend got from
   * `POST /v1/support/sessions`. Give this OR `publishableKey`.
   */
  embedToken?: string;
  customer?: Customer;
  /** Asked for when the embed creates the session (publishable key). With an
   * embed token the session's own mode applies. Default `view`. */
  mode?: SupportMode;
  branding?: Branding;
  /** Seconds the session lives (publishable key only; 60 to 3600). */
  expiresIn?: number;
  /** The GaiaDesk server (default `https://gaiadesk.net`). */
  server?: string;
}

/** Where a session is. */
export type State = "idle" | "consent" | "starting" | "waiting" | "connected" | "ended";

/** Why a session ended. */
export type EndReason =
  | "stopped" // the customer pressed Stop (or the browser's own "Stop sharing")
  | "declined" // the customer said no in the consent dialog or the browser prompt
  | "expired" // the session reached its expiry
  | "disconnected" // the connection to GaiaDesk was lost
  | "error"; // something failed: see the `error` event

export interface EmbedError {
  code: string;
  message: string;
}

/** A request from the support agent, as the embed handled it. */
export interface ActionReport {
  type: string;
  applied: boolean;
  /** Why it was not applied (`masked`, `control_paused`, `navigation_blocked`, …). */
  reason?: string;
}

export interface EventMap {
  state: { state: State };
  /** The session exists; `joinCode` is what the customer can read to an agent. */
  ready: { sessionId: string; joinCode: string; mode: SupportMode };
  joined: { agent: string | null };
  left: Record<string, never>;
  control: { allowed: boolean };
  action: ActionReport;
  ended: { reason: EndReason };
  error: EmbedError;
}

export type EventName = keyof EventMap;
export type Listener<K extends EventName> = (detail: EventMap[K]) => void;
