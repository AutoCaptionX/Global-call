import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

// Safe dynamic loader check for environment variables with robust production fallbacks
const getEnvVar = (key: string): string => {
  try {
    if (typeof import.meta !== "undefined" && import.meta.env) {
      return (import.meta.env[key] as string) || "";
    }
  } catch (e) {
    // Fail silently in non-Vite environments
  }
  return "";
};

export const firebaseConfig = {
  apiKey: getEnvVar("VITE_FIREBASE_API_KEY") || "AIzaSyAnqAlazCqPlinYjv2_zlGwqABJ7JL0VqM",
  authDomain: getEnvVar("VITE_FIREBASE_AUTH_DOMAIN") || "global-call-20f94.firebaseapp.com",
  projectId: getEnvVar("VITE_FIREBASE_PROJECT_ID") || "global-call-20f94",
  storageBucket: getEnvVar("VITE_FIREBASE_STORAGE_BUCKET") || "global-call-20f94.firebasestorage.app",
  messagingSenderId: getEnvVar("VITE_FIREBASE_MESSAGING_SENDER_ID") || "475612643356",
  appId: getEnvVar("VITE_FIREBASE_APP_ID") || "1:475612643356:web:8e1d88e4440d96c4c89fd9",
  measurementId: getEnvVar("VITE_FIREBASE_MEASUREMENT_ID") || "G-435GZZ371L"
};

// Dynamic Cloudinary configuration fallback to prevent silent runtime JS errors if imported or called
export const cloudinaryConfig = {
  cloudName: getEnvVar("VITE_CLOUDINARY_CLOUD_NAME") || "demo",
  apiKey: getEnvVar("VITE_CLOUDINARY_API_KEY") || "",
  uploadPreset: getEnvVar("VITE_CLOUDINARY_UPLOAD_PRESET") || "default-preset"
};

export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);

// Initialize Firestore with robust, modern multi-tab local caching for elegant offline resilience
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});

