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
  signInWithRedirect,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import firebaseConfig from "@/firebase-applet-config.json";

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

export type GoogleAuthPayload = {
  user: User;
  idToken: string;
  accessToken: string | null;
};

let authInstance: Auth | null = null;
let prewarmPromise: Promise<GoogleAuthPayload | null> | null = null;
let pendingRedirectPayload: GoogleAuthPayload | null = null;
let redirectConsumed = false;

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

function isEmbeddedFrame(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Pre-initializes Firebase Auth and resolves any completed signInWithRedirect
 * flow without discarding the credential.
 */
export function prewarmGoogleAuth(): Promise<GoogleAuthPayload | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (!prewarmPromise) {
    prewarmPromise = (async () => {
      try {
        const auth = getFirebaseAuth();
        await auth.authStateReady();
        const result = await getRedirectResult(
          auth,
          browserPopupRedirectResolver,
        );
        if (result?.user) {
          const credential = GoogleAuthProvider.credentialFromResult(result);
          const idToken = await result.user.getIdToken();
          const payload: GoogleAuthPayload = {
            user: result.user,
            idToken,
            accessToken: credential?.accessToken ?? null,
          };
          if (!redirectConsumed) {
            pendingRedirectPayload = payload;
          }
          return payload;
        }
      } catch {
        // Non-fatal: signInWithPopup initializes on demand if prewarm fails.
      }
      return null;
    })();
  }
  return prewarmPromise;
}

/**
 * Consumes a pending Google redirect sign-in credential once on page mount.
 */
export async function consumeGoogleRedirectResult(): Promise<GoogleAuthPayload | null> {
  const fromPrewarm = await prewarmGoogleAuth();
  if (redirectConsumed) return null;
  const payload = pendingRedirectPayload ?? fromPrewarm;
  if (payload) {
    redirectConsumed = true;
    pendingRedirectPayload = null;
  }
  return payload;
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
 * Accepts any Google account (`prompt: select_account`). Falls back to
 * top-level redirect if popups are blocked outside embedded iframes.
 */
export async function googleSignIn(options?: {
  includeGmailScopes?: boolean;
}): Promise<GoogleAuthPayload> {
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

    try {
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
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (
        (code === "auth/popup-blocked" ||
          code === "auth/web-storage-unsupported") &&
        !isEmbeddedFrame()
      ) {
        redirectConsumed = false;
        await signInWithRedirect(auth, provider, browserPopupRedirectResolver);
        // Browser navigates away on redirect; keep promise pending briefly.
        return await new Promise<GoogleAuthPayload>(() => {});
      }
      throw err;
    }
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
