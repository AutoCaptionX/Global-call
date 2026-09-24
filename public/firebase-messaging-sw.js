// Firebase Messaging Service Worker for background notifications
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// Initialize Firebase with the same config
firebase.initializeApp({
  apiKey: "AIzaSyAnqAlazCqPlinYjv2_zlGwqABJ7JL0VqM",
  authDomain: "global-call-20f94.firebaseapp.com",
  projectId: "global-call-20f94",
  storageBucket: "global-call-20f94.firebasestorage.app",
  messagingSenderId: "475612643356",
  appId: "1:475612643356:web:8e1d88e4440d96c4c89fd9",
  measurementId: "G-435GZZ371L"
});

const messaging = firebase.messaging();

// Background message handler
messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message: ', payload);
  
  const notificationTitle = payload.notification?.title || payload.data?.title || 'Global Call';
  const notificationOptions = {
    body: payload.notification?.body || payload.data?.body || 'Incoming video/audio call...',
    icon: '/pwa-192x192.png',
    badge: '/favicon.ico',
    data: payload.data,
    requireInteraction: true,
    tag: payload.data?.type === 'call' ? 'incoming-call' : 'chat-message'
  };

  return self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification click to focus or open app window
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  const targetUrl = '/';
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // If a window is already open, focus it and navigate
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      // If no window is open, open a new one
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
