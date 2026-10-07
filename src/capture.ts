// Sharing this tab: the browser's own prompt (getDisplayMedia), and the
// checks on what the customer picked in it.
//
// Only a browser TAB may be shared. A window or a whole screen would show
// this page at an unknown place among other things, so its masked fields
// could not be painted over: such a pick is stopped at once and refused.
// Whether the tab is THIS tab is verified through the Capture Handle API
// (Chromium): this page sets a random handle before asking, and the
// captured track reports the handle of what it captures. Only a verified
// surface gets co-browsing (a point in the picture is then a point here);
// an unverified tab is still shared, view only, its masks still applied.

export interface Captured {
  stream: MediaStream;
  track: MediaStreamTrack;
  /** The shared surface is this tab. */
  verified: boolean;
}

export type CaptureError = { code: "declined" | "not_a_tab" | "unsupported"; message: string };

/** A random handle, set before asking. */
export function newHandle(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return "gaiadesk-" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

type CaptureHandleDevices = MediaDevices & {
  setCaptureHandleConfig?: (c: { handle: string; exposeOrigin: boolean; permittedOrigins: string[] }) => void;
};
type HandleTrack = MediaStreamTrack & { getCaptureHandle?: () => { handle?: string } | null };

/** Whether `track`'s surface is acceptable, and verified as this tab. Pure. */
export function judge(settings: MediaTrackSettings & { displaySurface?: string }, handle: string | undefined, mine: string): { ok: boolean; verified: boolean } {
  if (settings.displaySurface !== "browser") return { ok: false, verified: false };
  return { ok: true, verified: handle !== undefined && handle === mine };
}

/**
 * Ask the browser to share this tab. Call it straight from the customer's
 * click (the browser requires a user gesture).
 */
export async function shareThisTab(nav: Navigator, origin: string): Promise<Captured> {
  const md = nav.mediaDevices as CaptureHandleDevices | undefined;
  if (!md?.getDisplayMedia) throw { code: "unsupported", message: "This browser cannot share a tab." } satisfies CaptureError;
  const mine = newHandle();
  try {
    md.setCaptureHandleConfig?.({ handle: mine, exposeOrigin: true, permittedOrigins: [origin] });
  } catch {
    // Not available: the share is simply not verified.
  }
  let stream: MediaStream;
  try {
    stream = await md.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false,
      // Chromium: offer this tab first, never other screens' audio.
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
      monitorTypeSurfaces: "exclude",
    } as DisplayMediaStreamOptions);
  } catch (e) {
    throw { code: "declined", message: e instanceof Error ? e.message : "The share was not allowed." } satisfies CaptureError;
  }
  const track = stream.getVideoTracks()[0] as HandleTrack | undefined;
  if (!track) throw { code: "declined", message: "Nothing was shared." } satisfies CaptureError;
  let handle: string | undefined;
  try {
    handle = track.getCaptureHandle?.()?.handle;
  } catch {
    handle = undefined;
  }
  const v = judge(track.getSettings(), handle, mine);
  if (!v.ok) {
    for (const t of stream.getTracks()) t.stop();
    throw { code: "not_a_tab", message: "Please share this browser tab (not a window or your whole screen), so private fields stay hidden." } satisfies CaptureError;
  }
  return { stream, track, verified: v.verified };
}
