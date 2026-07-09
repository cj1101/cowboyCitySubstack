const firebaseConfig = {
  apiKey: "AIzaSyB_OQ5sK4xwThN5a5wYndlByyZ6PnKsTCU",
  authDomain: "cowboycityrealm.firebaseapp.com",
  projectId: "cowboycityrealm",
  storageBucket: "cowboycityrealm.firebasestorage.app",
  messagingSenderId: "667575114868",
  appId: "1:667575114868:web:f5f9f6ec0268bc9e3b4521",
  measurementId: "G-YY1DK60FW8"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
