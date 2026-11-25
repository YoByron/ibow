/**
 * The app shell (M13): the splash screen's hand-off and the transition between screens. The splash is plain markup in
 * each page, drawn by CSS from `/theme.css` (the business's colours, name and mark) before any script runs; this module
 * only lets it go once the first screen is on the page.
 */

/** The splash stays at least this long once shown, so it reads as a moment, not a flicker. */
const SPLASH_MIN_MS = 650;

let booted = false;
/** The splash stays at least until then (a banner on it is being read), unless let go sooner. */
let holdUntil = 0;

/** Keeps the splash up for `ms` more from now (0 lets it go at the usual time): long enough to read an event on it. */
export function holdSplash(ms: number): void {
  holdUntil = ms === 0 ? 0 : performance.now() + ms;
}

/** Hands over from the splash to the first screen (once; later calls do nothing). */
export function bootDone(): void {
  if (booted) return;
  booted = true;
  const splash = document.getElementById("splash");
  if (!splash) return;
  const wait = Math.max(0, SPLASH_MIN_MS - performance.now());
  const handOver = () => {
    if (performance.now() < holdUntil) return void setTimeout(handOver, holdUntil - performance.now());
    document.documentElement.classList.add("booted");
    // Gone from the accessibility tree and from layout once its fade has ended (or at once without motion).
    const done = () => splash.remove();
    splash.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 700);
  };
  setTimeout(handOver, wait);
}

/** Most the splash waits for a first screen before it steps aside anyway (a slow network still sees the page load). */
const SPLASH_MAX_MS = 6000;

/**
 * Ends the splash as soon as `#app` holds a real screen (anything but the boot placeholder): a menu, a sign-in, an
 * error. One call at start-up covers every route and every failure, with no hook in each of them.
 */
export function watchBoot(root: HTMLElement | null = document.getElementById("app")): void {
  if (root === null) {
    bootDone();
    return;
  }
  const ready = () => root.firstElementChild !== null && !root.firstElementChild.classList.contains("boot");
  if (ready()) {
    bootDone();
    return;
  }
  const seen = new MutationObserver(() => {
    if (!ready()) return;
    seen.disconnect();
    bootDone();
  });
  seen.observe(root, { childList: true });
  setTimeout(() => {
    seen.disconnect();
    bootDone();
  }, SPLASH_MAX_MS);
}

const reducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

interface ViewTransitionDocument {
  startViewTransition?: (update: () => void | Promise<void>) => unknown;
}

/**
 * Runs `update` (which redraws the screen) inside a view transition where the browser has them and motion is welcome,
 * so moving between screens feels like an app, not a page load. Elsewhere it simply runs.
 */
export function transition(update: () => void): void {
  const doc = document as Document & ViewTransitionDocument;
  if (!booted || typeof doc.startViewTransition !== "function" || reducedMotion()) {
    update();
    return;
  }
  doc.startViewTransition(() => update());
}
