/**
 * A page's service worker (the storefront's at `/`, the staff page's at `/staff`): that page's own files cache-first (served at once, so a slow network still opens the
 * page), updated as a whole set when a new build's worker installs; icons, typefaces and images cached as they are
 * first used; the theme sheet stale-while-revalidating; the API never cached (a stale order status is worse than
 * none). Built by scripts/build-client.ts, which fills in the version and the file list.
 */

declare const BUILD_VERSION: string;
declare const BUILD_ASSETS: string[];
/** The page this worker serves on a navigation: `/` (storefront) or `/staff`. */
declare const BUILD_PAGE: string;
/** This worker's cache-name prefix, so the two workers never delete each other's caches. */
declare const BUILD_CACHE: string;

interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(r: Promise<Response> | Response): void;
}
interface WorkerScope {
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  location: Location;
}

const scope = self as unknown as WorkerScope;
const CACHE = `${BUILD_CACHE}${BUILD_VERSION}`;

/** Fetches one file of this build, refusing a reply from any other build (a deploy can land mid-install). */
async function fetchOwn(path: string): Promise<Response> {
  const res = await fetch(path, { cache: "reload" });
  const build = res.headers.get("x-ibow-build");
  if (!res.ok || build !== BUILD_VERSION) {
    throw new Error(`sw: expected ${path} from build ${BUILD_VERSION}, found ${res.status} from build ${build}`);
  }
  return res;
}

scope.addEventListener("install", (e) => {
  // All or nothing: a failed install is retried on the next visit, and the old worker keeps serving its own build.
  e.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.all(BUILD_ASSETS.map(async (path) => cache.put(path, await fetchOwn(path)))))
      .then(() => scope.skipWaiting()),
  );
});

scope.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith(BUILD_CACHE) && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => scope.clients.claim()),
  );
});

/** Icons, typefaces and the config's images: cached the first time a page asks, served from the cache after. */
const RUNTIME = ["/assets/", "/media/"];

scope.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== scope.location.origin || url.pathname.startsWith("/api/")) return;
  // Only this worker's own page: the storefront's scope `/` also covers `/owner`, which must never get the storefront.
  if (e.request.mode === "navigate" && url.pathname !== BUILD_PAGE) return;
  if (url.pathname === "/theme.css") {
    // The look: the cached sheet at once, refreshed behind it. A request with ?v= (the owner just saved a new look)
    // goes to the network, because the cached sheet is the old one.
    e.respondWith(themeSheet(url.searchParams.has("v")));
    return;
  }
  if (RUNTIME.some((p) => url.pathname.startsWith(p))) {
    e.respondWith(cachedOrFetch(e.request));
    return;
  }
  // `/?kiosk=1` and `/#/order` are the same page: the query string only changes what the script does.
  const key = e.request.mode === "navigate" ? BUILD_PAGE : url.pathname;
  // Cache-first from this build's own set, which only a new worker (a new build) replaces, never a background
  // fetch, so files of two builds can't mix. Anything not in the set goes to the network, uncached.
  e.respondWith(caches.match(key, { cacheName: CACHE }).then((cached) => cached ?? fetch(e.request)));
});

/** Keeps a reply in this build's cache, only if it came from this build. */
async function keep(path: string, res: Response): Promise<void> {
  if (res.ok && res.headers.get("x-ibow-build") === BUILD_VERSION)
    await (await caches.open(CACHE)).put(path, res.clone());
}

async function cachedOrFetch(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  const cached = await caches.match(path, { cacheName: CACHE });
  if (cached) return cached;
  const res = await fetch(req);
  await keep(path, res);
  return res;
}

async function themeSheet(fresh: boolean): Promise<Response> {
  const cached = await caches.match("/theme.css", { cacheName: CACHE });
  const network = fetch("/theme.css", { cache: "no-cache" }).then(async (res) => {
    await keep("/theme.css", res);
    return res;
  });
  if (fresh || !cached) return network.catch(() => cached ?? Response.error());
  // Stale while revalidating: the answer is the cached sheet; the refresh lands for the next load.
  network.catch(() => undefined);
  return cached;
}

export {};
