"use client";

import { getApp, getApps, initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  initializeAuth,
  inMemoryPersistence,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import firebaseConfig from "@/firebase-applet-config.json";

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

let authInstance: Auth | null = null;
let prewarmPromise: Promise<void> | null = null;

function getFirebaseAuth(): Auth {
  if (typeof window === "undefined") {
    throw new Error("Google sign-in is only available in the browser.");
  }
  if (authInstance) return authInstance;

  const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  try {
    authInstance = initializeAuth(app, {
      persistence: [
        indexedDBLocalPersistence,
        browserLocalPersistence,
        browserSessionPersistence,
        inMemoryPersistence,
      ],
      popupRedirectResolver: browserPopupRedirectResolver,
    });
  } catch {
    authInstance = getAuth(app);
  }
  return authInstance;
}

/**
 * Pre-initializes Firebase Auth and the popup/redirect iframe resolver on mount
 * so clicking Sign in with Google does not have to await iframe setup before
 * opening the popup window (prevents Safari/WebKit and iframe popup blocking).
 */
export function prewarmGoogleAuth(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (!prewarmPromise) {
    prewarmPromise = (async () => {
      try {
        const auth = getFirebaseAuth();
        await auth.authStateReady();
        await getRedirectResult(auth, browserPopupRedirectResolver);
      } catch {
        // Non-fatal: signInWithPopup initializes on demand if prewarm fails.
      }
    })();
  }
  return prewarmPromise;
}

// In-memory cache ONLY (never localStorage or sessionStorage).
let isSigningIn = false;
let cachedAccessToken: string | null = null;
let cachedTokenEmail: string | null = null;

export function initGoogleAuth(
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void,
) {
  const auth = getFirebaseAuth();
  void prewarmGoogleAuth();
  return onAuthStateChanged(auth, (user: User | null) => {
    if (user && cachedAccessToken) {
      onAuthSuccess?.(user, cachedAccessToken);
    } else if (!isSigningIn) {
      if (!user) {
        cachedAccessToken = null;
        cachedTokenEmail = null;
      }
      onAuthFailure?.();
    }
  });
}

/**
 * Sign into the Control Tower workspace using Google Sign-In.
 * Optionally requests Gmail scopes in the same consent prompt.
 */
export async function googleSignIn(options?: {
  includeGmailScopes?: boolean;
}): Promise<{
  user: User;
  idToken: string;
  accessToken: string | null;
}> {
  const auth = getFirebaseAuth();
  isSigningIn = true;
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    if (options?.includeGmailScopes) {
      for (const scope of SCOPES) {
        provider.addScope(scope);
      }
    }

    const result = await signInWithPopup(
      auth,
      provider,
      browserPopupRedirectResolver,
    );
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const idToken = await result.user.getIdToken();
    const accessToken = credential?.accessToken ?? null;

    if (options?.includeGmailScopes && accessToken) {
      cachedAccessToken = accessToken;
      cachedTokenEmail = result.user.email ?? null;
    }

    return { user: result.user, idToken, accessToken };
  } finally {
    isSigningIn = false;
  }
}

/**
 * Connect Gmail support mailbox using Google OAuth with Gmail readonly + send scopes.
 */
export async function connectGmailWithGoogle(): Promise<{
  user: User;
  accessToken: string;
}> {
  const auth = getFirebaseAuth();
  isSigningIn = true;
  try {
    const provider = new GoogleAuthProvider();
    for (const scope of SCOPES) {
      provider.addScope(scope);
    }
    provider.setCustomParameters({ prompt: "consent select_account" });

    const result = await signInWithPopup(
      auth,
      provider,
      browserPopupRedirectResolver,
    );
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const accessToken = credential?.accessToken;
    if (!accessToken) {
      throw new Error("Failed to obtain Gmail access token from Google.");
    }

    cachedAccessToken = accessToken;
    cachedTokenEmail = result.user.email ?? null;

    return { user: result.user, accessToken };
  } finally {
    isSigningIn = false;
  }
}

export function getGmailAccessToken(): string | null {
  return cachedAccessToken;
}

export function getGmailAccountEmail(): string | null {
  if (cachedTokenEmail) return cachedTokenEmail;
  if (typeof window === "undefined") return null;
  return getFirebaseAuth().currentUser?.email ?? null;
}

export function getCurrentGoogleUser(): User | null {
  if (typeof window === "undefined") return null;
  return getFirebaseAuth().currentUser;
}

export async function googleSignOut(): Promise<void> {
  cachedAccessToken = null;
  cachedTokenEmail = null;
  if (typeof window === "undefined") return;
  try {
    await signOut(getFirebaseAuth());
  } catch {
    // Ignore sign-out cleanup errors
  }
}
