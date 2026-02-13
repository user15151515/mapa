// firebase.js (ESM module)
// 1) Paste your Firebase config below (from Firebase Console)
// 2) Make sure Anonymous Auth, Firestore, and Storage are enabled.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore,
  serverTimestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  increment,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import {
  getStorage,
  ref,
  uploadBytesResumable,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

// TODO: Replace with your Firebase project config:
export const firebaseConfig = {
  apiKey: "AIzaSyAw8Nbwns-V7ESW1BTpmjEm3UoIEUCBlfM",
  authDomain: "sushi4life.firebaseapp.com",
  projectId: "sushi4life",
  storageBucket: "sushi4life.appspot.com",
  messagingSenderId: "183741813132",
  appId: "1:183741813132:web:f4aff55a7078be62c406a9",
  measurementId: "G-R9F91CEGFQ"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);

// Re-export helpers used across app
export const fs = {
  serverTimestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  increment,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
};

export const st = { ref, uploadBytesResumable, getDownloadURL };

export async function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      try {
        if (!user) {
          await signInAnonymously(auth);
          // user will be available in next auth state callback
        } else {
          unsub();
          resolve(user);
        }
      } catch (e) {
        unsub();
        reject(e);
      }
    });
  });
}
