const CACHE_NAME = 'for-got-cache-v1';
const CORE_ASSETS = [
    './',
    './index.html',
    './app.js',
    './style.css',
    './manifest.json',
    './favicon.ico',
    './icons/icon-512.png'
];

// IndexedDB mirrors the web page's "ForGotDB" / "attachments" store.
const DB_NAME = 'ForGotDB';
const DB_VERSION = 1;
const STORE_NAME = 'attachments';

async function precache(urls) {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(
        urls.map(async (url) => {
            try {
                const res = await fetch(url, { cache: 'reload' });
                if (res && res.ok) await cache.put(url, res.clone());
            } catch {
                // Best-effort: skip missing assets.
            }
        })
    );
}

async function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = e => reject(e.target.error);
    });
}

async function getBlobLocal(key) {
    try {
        const db = await openDB();
        return new Promise(resolve => {
            const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    } catch {
        return null;
    }
}

async function resolveNotificationImage(imagePath) {
    if (!imagePath) return null;
    if (typeof imagePath !== 'string') return null;
    if (imagePath.startsWith('local:')) {
        const key = imagePath.slice('local:'.length);
        const blob = await getBlobLocal(key);
        if (!blob) return null;
        return URL.createObjectURL(blob);
    }
    return imagePath;
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            await precache(CORE_ASSETS);
            self.skipWaiting();
        })()
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(
                keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k)))
            );
            await self.clients.claim();
        })()
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;

    // Navigation fallback to app shell.
    if (event.request.mode === 'navigate') {
        event.respondWith(
            (async () => {
                const cache = await caches.open(CACHE_NAME);
                const cachedIndex = await cache.match('./index.html');

                try {
                    const fresh = await fetch(event.request);
                    if (fresh && fresh.ok) {
                        cache.put(event.request, fresh.clone()).catch(() => {});
                        return fresh;
                    }
                } catch {
                    // Fall through to cached response.
                }

                if (cachedIndex) return cachedIndex;
                throw new Error('Offline and index.html not cached');
            })()
        );
        return;
    }

    event.respondWith(
        (async () => {
            const cache = await caches.open(CACHE_NAME);
            const cached = await cache.match(event.request);
            if (cached) return cached;

            const fresh = await fetch(event.request);
            if (fresh && fresh.ok) {
                cache.put(event.request, fresh.clone()).catch(() => {});
            }
            return fresh;
        })()
    );
});

self.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'SHOW_NOTIFICATION') return;

    event.waitUntil(
        (async () => {
            const data = event.data;
            const mood = data.mood;
            const moodGif = data.moodGif;

            let resolvedImage = null;
            try {
                resolvedImage = await resolveNotificationImage(data.image);
            } catch {
                resolvedImage = null;
            }

            // Default Options
            let options = {
                body: data.text,
                icon: 'icons/default.png',
                badge: 'icons/default-badge.png',
                vibrate: [300, 200, 300],
                tag: 'default-alarm',
                image: resolvedImage,
                renotify: true,
                requireInteraction: true,
                data: {
                    id: data.id,
                    mood: mood
                },
                actions: [
                    { action: 'snooze', title: '💤 Snooze (5m)' },
                    { action: 'dismiss', title: '❌ Dismiss' }
                ]
            };

            // Mood Override
            if (mood) {
                if (mood === 'funny') {
                    options.body = "😜 " + data.text;
                    options.vibrate = [200, 100, 200, 100, 200];
                    options.tag = "funny-alarm";
                } else if (mood === 'strict') {
                    options.body = "⛔ " + data.text;
                    options.vibrate = [800, 300, 800];
                    options.tag = "strict-alarm";
                } else if (mood === 'cute') {
                    options.body = "🐰 " + data.text;
                    options.vibrate = [150, 150, 150];
                    options.tag = "cute-alarm";
                } else if (mood === 'motivational') {
                    options.body = "🔥 " + data.text;
                    options.vibrate = [400, 200, 400];
                    options.tag = "motivational-alarm";
                }

                if (moodGif) {
                    options.icon = moodGif;
                    options.badge = moodGif;
                    options.image = moodGif;
                } else {
                    if (mood === 'funny') {
                        options.icon = "icons/funny.png";
                        options.badge = "icons/funny-badge.png";
                    } else if (mood === 'strict') {
                        options.icon = "icons/strict.png";
                        options.badge = "icons/strict-badge.png";
                    } else if (mood === 'cute') {
                        options.icon = "icons/cute.png";
                        options.badge = "icons/cute-badge.png";
                    } else if (mood === 'motivational') {
                        options.icon = "icons/motivational.png";
                        options.badge = "icons/motivational-badge.png";
                    }
                }
            }

            try {
                await self.registration.showNotification('For-Got Alarm', options);
            } catch {
                // If user denied permission, showNotification may reject.
            }
        })()
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const action = event.action;
    const notificationId = event.notification.data && event.notification.data.id;

    const message = {
        type: 'NOTIFICATION_ACTION',
        action: action || 'open',
        id: notificationId
    };

    event.waitUntil(
        (async () => {
            // Snooze/Dismiss: post to all open clients.
            if (action === 'snooze' || action === 'dismiss') {
                const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
                clientList.forEach((client) => client.postMessage(message));
                return;
            }

            // Body click: focus an existing window, otherwise open and post.
            const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            for (const client of clientList) {
                if (client.url && client.url.startsWith(self.location.origin) && 'focus' in client) {
                    const focusedClient = await client.focus();
                    (focusedClient || client).postMessage(message);
                    return;
                }
            }

            if (self.clients.openWindow) {
                const newClient = await self.clients.openWindow('./');
                if (newClient) newClient.postMessage(message);
            }
        })()
    );
});
