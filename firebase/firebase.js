// /firebase/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  serverTimestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Firebase-Konfiguration
const firebaseConfig = {
  apiKey: "AIzaSyCVABFAyHheIB2ltlhrJUXzrd8zFRWqxt0",
  authDomain: "bbq-buddy-3db59.firebaseapp.com",
  projectId: "bbq-buddy-3db59",
  storageBucket: "bbq-buddy-3db59.firebasestorage.app",
  messagingSenderId: "909607090278",
  appId: "1:909607090278:web:90da840385f81a93e355a7",
  measurementId: "G-0Z2KQ6MVB3"
};

// Firebase initialisieren
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// Re-Exports – nur EIN Block!
export {
  serverTimestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  increment,
};
