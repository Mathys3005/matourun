/* MatouRun service worker: offline reading and push reminders. */
const SHELL = "mr-shell-v2";
const API = "mr-api-v1";
/** Read-only API responses kept for offline use (never auth routes). */
const API_CACHEABLE = /^\/api\/(sessions|runs|profile|config|progress)(\/|\?|$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(["/", "/theme.js", "/icon.svg", "/icon-192.png", "/manifest.webmanifest"]))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL && k !== API).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request.url, response.clone());
    }
    return response;
  } catch {
    const hit = await caches.match(request.url);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("X-MatouRun-Offline", "1");
      return new Response(await hit.blob(), { status: hit.status, headers });
    }
    return new Response(JSON.stringify({ error: "Hors ligne" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
}

async function cacheFirst(request, cacheName) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) (await caches.open(cacheName)).put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    if (API_CACHEABLE.test(url.pathname)) event.respondWith(networkFirst(request, API));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, SHELL));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL).then((c) => c.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }
  // Other static files (theme.js, icons, manifest): fresh when online, cached when offline.
  event.respondWith(networkFirst(request, SHELL));
});

/** Logout: forget every cached API response. */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "logout") event.waitUntil(caches.delete(API));
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/";
  event.waitUntil(
    self.registration.showNotification(typeof data.title === "string" ? data.title : "MatouRun", {
      body: typeof data.body === "string" ? data.body : "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.navigate(url).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
