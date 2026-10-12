"use strict";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Server থেকে Web Push এলে notification দেখাবে।
self.addEventListener("push", (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      title: "New message on Privy",
      body: event.data ? event.data.text() : "You have a new message."
    };
  }

  const title = data.title || "New message on Privy";

  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "You received a new message.",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: data.tag || "privy-message",
      data: { url: data.url || "./" },
      renotify: false
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = new URL(
    event.notification.data?.url || "./",
    self.location.origin
  ).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    for (const client of windows) {
      if (client.url.startsWith(self.location.origin) && "focus" in client) {
        await client.focus();
        client.postMessage({ type: "PRIVY_NOTIFICATION_CLICK" });
        return;
      }
    }

    await self.clients.openWindow(target);
  })());
});
