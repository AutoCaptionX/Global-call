import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

export const firebaseConfig = {
  apiKey: "AIzaSyAnqAlazCqPlinYjv2_zlGwqABJ7JL0VqM",
  authDomain: "global-call-20f94.firebaseapp.com",
  projectId: "global-call-20f94",
  storageBucket: "global-call-20f94.firebasestorage.app",
  messagingSenderId: "475612643356",
  appId: "1:475612643356:web:8e1d88e4440d96c4c89fd9",
  measurementId: "G-435GZZ371L"
};

export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);

// Initialize Firestore with robust, modern multi-tab local caching for elegant offline resilience
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});

