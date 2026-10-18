import { initializeApp, getApps, getApp } from 'firebase/app';
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User,
  Auth
} from 'firebase/auth';
import rawFirebaseConfig from '@/firebase-applet-config.json';
const firebaseConfig = (rawFirebaseConfig as any).default || rawFirebaseConfig;

// Lazily initialize Firebase app only on the client
let firebaseAppInstance: any = null;
export const getFirebaseApp = () => {
  if (typeof window === 'undefined') return null;
  if (!firebaseAppInstance) {
    try {
      firebaseAppInstance = !getApps().length ? initializeApp(firebaseConfig) : getApp();
    } catch (e) {
      console.warn('[Firebase Init Warning]', e);
    }
  }
  return firebaseAppInstance;
};

export const getFirebaseAuth = (): Auth | null => {
  if (typeof window === 'undefined') return null;
  const app = getFirebaseApp();
  if (!app) return null;
  try {
    return getAuth(app);
  } catch {
    return null;
  }
};

// Configure Google Auth Provider with Drive File Scope lazily
export const getDriveProvider = () => {
  const provider = new GoogleAuthProvider();
  provider.addScope('https://www.googleapis.com/auth/drive.file');
  provider.setCustomParameters({
    prompt: 'select_account',
  });
  return provider;
};

// Configure Standard Google Auth Provider for general login lazily
export const getStandardGoogleProvider = () => {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({
    prompt: 'select_account',
  });
  return provider;
};

/**
 * Sign in with standard Google Account (popup-based, email & profile only)
 */
export const signInWithGoogleAccount = async (): Promise<User> => {
  const auth = getFirebaseAuth();
  if (!auth) {
    throw new Error('Firebase Auth is not initialized.');
  }
  const result = await signInWithPopup(auth, getStandardGoogleProvider());
  return result.user;
};

// In-memory token caching (Strictly in memory per security guidelines)
let cachedAccessToken: string | null = null;
let isSigningIn = false;

/**
 * Initialize auth state listener.
 */
export const initDriveAuth = (
  onSuccess?: (user: User, token: string | null) => void,
  onFailure?: () => void
) => {
  const auth = getFirebaseAuth();
  if (!auth) {
    if (onFailure) onFailure();
    return () => {};
  }
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (onSuccess) onSuccess(user, cachedAccessToken);
    } else {
      cachedAccessToken = null;
      if (onFailure) onFailure();
    }
  });
};

/**
 * Sign in with Google and request Google Drive file scope.
 * Caches access token in memory.
 */
export const signInWithGoogleDrive = async (): Promise<{ user: User; accessToken: string }> => {
  try {
    isSigningIn = true;
    const auth = getFirebaseAuth();
    if (!auth) throw new Error('Firebase Auth is not initialized.');
    const result = await signInWithPopup(auth, getDriveProvider());
    const credential = GoogleAuthProvider.credentialFromResult(result);
    
    if (!credential?.accessToken) {
      throw new Error('Google did not return an access token for Drive. Please ensure Drive permissions are approved.');
    }

    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('[Google Drive Auth Error]', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

/**
 * Get current in-memory access token.
 */
export const getDriveAccessToken = (): string | null => {
  return cachedAccessToken;
};

/**
 * Set in-memory access token.
 */
export const setDriveAccessToken = (token: string | null) => {
  cachedAccessToken = token;
};

/**
 * Sign out and clear in-memory tokens.
 */
export const signOutDrive = async () => {
  const auth = getFirebaseAuth();
  if (auth) {
    await signOut(auth);
  }
  cachedAccessToken = null;
};
