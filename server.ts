import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import admin from 'firebase-admin';
import { getMessaging } from 'firebase-admin/messaging';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');

// Initialize Firebase Admin SDK
try {
  admin.initializeApp();
  console.log("Firebase Admin initialized with default credentials.");
} catch (e) {
  console.warn("Firebase Admin fallback initialization (ADC not available)...");
  try {
    admin.initializeApp({
      projectId: "global-call-20f94"
    });
  } catch (err) {
    console.error("All Firebase Admin initialization attempts failed:", err);
  }
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // API endpoint to send FCM push notification
  app.post('/api/send-push', async (req, res) => {
    const { token, title, body, data } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: "FCM token is required." });
    }

    console.log("FCM server received push request to:", token);

    try {
      const message = {
        token: token,
        notification: {
          title: title || "Global Call",
          body: body || "Incoming call..."
        },
        data: data || {},
        webpush: {
          headers: {
            Urgency: "high"
          },
          notification: {
            body: body || "Incoming call...",
            requireInteraction: true,
            icon: "/pwa-192x192.png",
            badge: "/favicon.ico"
          }
        }
      };

      const response = await getMessaging().send(message);
      console.log("FCM notification sent successfully! Msg ID:", response);
      return res.json({ success: true, messageId: response });
    } catch (err: any) {
      console.error("FCM Send failed with error:", err);
      return res.status(500).json({ error: err.message || String(err) });
    }
  });

  if (!isProd) {
    // DEVELOPMENT MODE with Vite Middleware
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
    
    // SPA Fallback for Development
    app.use('*', async (req, res) => {
      const url = req.originalUrl;
      try {
        const rawHtml = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
        const template = await vite.transformIndexHtml(url, rawHtml);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e: any) {
        vite.ssrFixStacktrace(e);
        res.status(500).end(e.message);
      }
    });
  } else {
    // PRODUCTION MODE - Serve Static Dist Files
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    
    // SPA Fallback for Production (Serve index.html directly)
    app.use('*', (req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  const port = 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`[Server] Running in ${isProd ? 'production' : 'development'} mode on port ${port}`);
  });
}

startServer();
