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

const REDIRECT_PENDING_KEY = "ct_google_redirect_pending_ts";
const REDIRECT_PENDING_TTL_MS = 10 * 60 * 1000;

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

function markRedirectPending(): void {
  try {
    sessionStorage.setItem(REDIRECT_PENDING_KEY, String(Date.now()));
  } catch {
    // Ignore restricted sessionStorage
  }
}

function consumeRedirectPendingFlag(): boolean {
  try {
    const raw = sessionStorage.getItem(REDIRECT_PENDING_KEY);
    if (!raw) return false;
    sessionStorage.removeItem(REDIRECT_PENDING_KEY);
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() - ts < REDIRECT_PENDING_TTL_MS;
  } catch {
    return false;
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
      const wasRedirectPending = consumeRedirectPendingFlag();
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

        // Recover signed-in Firebase user if modern browser storage partitioning
        // cleared Firebase's redirect metadata while still hydrating auth.currentUser.
        if (wasRedirectPending && auth.currentUser) {
          const idToken = await auth.currentUser.getIdToken();
          const payload: GoogleAuthPayload = {
            user: auth.currentUser,
            idToken,
            accessToken: null,
          };
          if (!redirectConsumed) {
            pendingRedirectPayload = payload;
          }
          return payload;
        }

        if (wasRedirectPending) {
          const err = new Error(
            "Google sign-in redirect did not finish because your browser blocked third-party redirect storage. Allow popups or sign in with email below.",
          ) as Error & { code?: string };
          err.code = "auth/web-storage-unsupported";
          throw err;
        }
      } catch (err) {
        if (wasRedirectPending) {
          throw err;
        }
        // Non-fatal during passive prewarm when no redirect was pending.
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
  void prewarmGoogleAuth().catch(() => {});
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
      const canRedirectFallback =
        code === "auth/popup-blocked" ||
        code === "auth/web-storage-unsupported" ||
        code === "auth/operation-not-supported-in-this-environment";
      if (canRedirectFallback && !isEmbeddedFrame()) {
        redirectConsumed = false;
        markRedirectPending();
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
