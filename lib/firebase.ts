import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getAuth, connectAuthEmulator, type Auth } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, type Firestore } from "firebase/firestore";
import { getStorage, connectStorageEmulator, type FirebaseStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

function getFirebaseApp(): FirebaseApp {
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    throw new Error(
      "Missing Firebase client config. Copy .env.example to .env.local and fill in NEXT_PUBLIC_FIREBASE_* values."
    );
  }
  return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
}

let app: FirebaseApp | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;
let storage: FirebaseStorage | undefined;
let emulatorsConnected = false;

function emulatorsRequested(): boolean {
  return process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true";
}

function connectEmulators(firebaseApp: FirebaseApp) {
  if (emulatorsConnected || !emulatorsRequested()) return;
  if (typeof window === "undefined" && process.env.FIREBASE_EMULATOR_SCRIPT !== "1") return;
  connectAuthEmulator(getAuth(firebaseApp), "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(getFirestore(firebaseApp), "127.0.0.1", 8080);
  connectStorageEmulator(getStorage(firebaseApp), "127.0.0.1", 9199);
  emulatorsConnected = true;
}

export function getClientApp(): FirebaseApp {
  if (!app) app = getFirebaseApp();
  connectEmulators(app);
  return app;
}

export function getClientAuth(): Auth {
  if (!auth) auth = getAuth(getClientApp());
  return auth;
}

export function getClientDb(): Firestore {
  if (!db) db = getFirestore(getClientApp());
  return db;
}

export function getClientStorage(): FirebaseStorage {
  if (!storage) storage = getStorage(getClientApp());
  return storage;
}
