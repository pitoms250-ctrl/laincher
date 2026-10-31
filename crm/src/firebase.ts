import { initializeApp, getApps, getApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  getMultiFactorResolver,
  multiFactor,
  PhoneAuthProvider,
  PhoneMultiFactorGenerator,
  RecaptchaVerifier,
  signInWithPopup,
  signOut,
  type MultiFactorError,
  type PhoneMultiFactorInfo,
  type User,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  child,
  push,
  onValue,
  runTransaction,
  type Database,
} from "firebase/database";

export const RTDB_URL = "https://furry-launcher-default-rtdb.europe-west1.firebasedatabase.app";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyCbAfAp4_AydyvWZZ7CyzvLKNM_iTltTYM",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "furry-launcher.firebaseapp.com",
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || RTDB_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "furry-launcher",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "furry-launcher.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "1040994944020",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:1040994944020:web:9a916854f2d6bfd0d99301",
};

export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb: Database = getDatabase(app, RTDB_URL);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

// Realtime Database helpers with error feedback
export async function rtdbSet(path: string, data: unknown): Promise<{ success: boolean; error?: string }> {
  try {
    await set(ref(rtdb, path), data);
    return { success: true };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`RTDB set error at ${path}:`, errorMsg);
    return { success: false, error: errorMsg };
  }
}

export async function rtdbUpdate(path: string, data: object): Promise<{ success: boolean; error?: string }> {
  try {
    await update(path ? ref(rtdb, path) : ref(rtdb), data);
    return { success: true };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`RTDB update error at ${path}:`, errorMsg);
    return { success: false, error: errorMsg };
  }
}

export async function rtdbTransaction<T>(
  path: string,
  updateValue: (current: T | null) => T | null | undefined,
): Promise<{ committed: boolean; value: T | null }> {
  const result = await runTransaction(ref(rtdb, path), (current) => updateValue(current as T | null));
  return {
    committed: result.committed,
    value: result.snapshot.exists() ? result.snapshot.val() as T : null,
  };
}

export async function rtdbRemove(path: string): Promise<{ success: boolean; error?: string }> {
  try {
    await remove(ref(rtdb, path));
    return { success: true };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`RTDB remove error at ${path}:`, errorMsg);
    return { success: false, error: errorMsg };
  }
}

export async function rtdbGet<T>(path: string): Promise<T | null> {
  const snapshot = await get(ref(rtdb, path));
  return snapshot.exists() ? snapshot.val() as T : null;
}

export function rtdbSubscribe<T>(path: string, onData: (value: T | null) => void, onError?: (error: Error) => void) {
  return onValue(ref(rtdb, path), (snapshot) => onData(snapshot.exists() ? snapshot.val() as T : null), onError);
}

// Test live read/write access to RTDB
export async function rtdbTestAccess(): Promise<{ canRead: boolean; canWrite: boolean; message: string }> {
  let canRead = false;
  let canWrite = false;
  let message = "";

  try {
    await get(ref(rtdb, "config"));
    canRead = true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    message = `Чтение: ${msg}`;
  }

  try {
    const testPath = `_diagnostics/ping_${Date.now()}`;
    await set(ref(rtdb, testPath), { time: Date.now(), user: auth.currentUser?.email || "anonymous" });
    await remove(ref(rtdb, testPath));
    canWrite = true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    message = message ? `${message} | Запись: ${msg}` : `Запись: ${msg}`;
  }

  return { canRead, canWrite, message };
}

export const RTDB_RULES_URL = "https://console.firebase.google.com/project/furry-launcher/database/furry-launcher-default-rtdb/rules";
export const RTDB_DATA_URL = "https://console.firebase.google.com/project/furry-launcher/database/furry-launcher-default-rtdb/data/~2F";

export const RECOMMENDED_RTDB_RULES = `{
  "rules": {
    ".read": false,
    ".write": false,
    "staff": {
      "$uid": {
        ".read": "auth != null && (auth.uid === $uid || (auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'))",
        ".write": "auth != null && auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'"
      }
    },
    "players": {
      ".read": "auth != null && auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support')",
      "$uid": {
        ".read": "auth != null && (auth.uid === $uid || (auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support'))) ",
        ".write": "auth != null && auth.uid === $uid",
        "profile": {
          ".read": "auth != null && auth.uid === $uid",
          ".write": "auth != null && auth.uid === $uid",
          ".validate": "newData.hasChildren(['nickname', 'lastSeenAt'])",
          "$other": { ".validate": false }
        }
      }
    },
    "presence": {
      "$uid": {
        ".read": "auth != null && (auth.uid === $uid || (auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support'))) ",
        ".write": "auth != null && auth.uid === $uid"
      }
    },
    "zbtCampaigns": {
      ".read": "auth != null && auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support')",
      ".write": "auth != null && auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'",
      "$campaignId": {
        ".read": "auth != null"
      }
    },
    "zbtKeys": {
      ".read": "auth != null && auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support')",
      ".write": "auth != null && auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'"
    },
    "playerEvents": {
      "$uid": {
        ".read": "auth != null && auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support')",
        "$eventId": {
          ".write": "auth != null && auth.uid === $uid",
          ".validate": "newData.hasChildren(['eventType', 'area', 'occurredAt', 'locale', 'launcherVersion'])",
          "$other": { ".validate": false }
        }
      }
    },
    "errorReports": {
      ".read": "auth != null && auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support')",
      "$uid": {
        "$errorId": {
          ".write": "auth != null && auth.uid === $uid",
          ".validate": "newData.hasChildren(['occurredAt', 'area', 'title', 'description', 'fingerprint', 'locale', 'launcherVersion', 'device'])",
          "occurredAt": { ".validate": "newData.isNumber()" },
          "area": { ".validate": "newData.isString() && newData.val().length <= 48" },
          "title": { ".validate": "newData.isString() && newData.val().length <= 160" },
          "description": { ".validate": "newData.isString() && newData.val().length <= 4000" },
          "fingerprint": { ".validate": "newData.isString() && newData.val().length === 64" },
          "locale": { ".validate": "newData.isString() && newData.val().length <= 10" },
          "launcherVersion": { ".validate": "newData.isString() && newData.val().length <= 32" },
          "gameVersion": { ".validate": "newData.isString() && newData.val().length <= 32" },
          "stack": { ".validate": "newData.isString() && newData.val().length <= 12000" },
          "device": {
            ".validate": "newData.hasChildren(['os', 'architecture', 'ramBucket', 'logicalProcessors'])",
            "os": { ".validate": "newData.isString() && newData.val().length <= 128" },
            "architecture": { ".validate": "newData.isString() && newData.val().length <= 24" },
            "ramBucket": { ".validate": "newData.isString() && newData.val().length <= 16" },
            "logicalProcessors": { ".validate": "newData.isNumber() && newData.val() <= 256" },
            "$other": { ".validate": false }
          },
          "$other": { ".validate": false }
        }
      }
    },
    "keys": {
      ".read": "auth != null && auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support')",
      "$keyHash": {
        ".read": "auth != null && ((auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support')) || data.child('used').val() === false || data.child('usedBy').val() === auth.uid)",
        ".validate": "newData.child('used').val() !== true || root.child('config').child('zbtEnabled').val() !== false || (auth != null && auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner')",
        ".write": "auth != null && ((auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner') || (root.child('config').child('zbtEnabled').val() !== false && data.exists() && data.child('used').val() === false && data.child('status').val() === 'UNUSED' && data.child('revoked').val() !== true && newData.child('used').val() === true && newData.child('status').val() === 'ACTIVATED' && newData.child('revoked').val() !== true && newData.child('usedBy').val() === auth.uid && newData.child('installId').isString() && newData.child('campaignId').val() === data.child('campaignId').val() && root.child('zbtCampaigns').child(data.child('campaignId').val()).child('status').val() === 'ACTIVE' && newData.child('hash').val() === data.child('hash').val() && newData.child('createdAt').val() === data.child('createdAt').val() && newData.child('expiresAt').val() === data.child('expiresAt').val() && newData.child('activatedAt').isNumber()))"
      }
    },
    "shop_items": {
      ".read": "auth != null",
      ".write": "auth != null && auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'"
    },
    "shop_config": {
      ".read": "auth != null",
      ".write": "auth != null && auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'"
    },
    "case_drops": {
      ".read": "auth != null",
      ".write": "auth != null && auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'"
    },
    "orders": {
      ".indexOn": ["createdAt", "paymentMethod", "receiptReviewDeadlineAt"],
      ".read": "auth != null && auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'",
      "$orderId": {
        ".read": "auth != null && (data.child('uid').val() === auth.uid || (auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'))",
        ".write": "auth != null && ((auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner') || (!data.exists() && auth.token.firebase.sign_in_provider !== 'anonymous' && newData.child('uid').val() === auth.uid && newData.child('status').val() === 'pending' && newData.child('createdAt').isNumber() && newData.child('itemId').isString() && root.child('shop_items').child(newData.child('itemId').val()).child('enabled').val() === true && newData.child('itemType').val() === root.child('shop_items').child(newData.child('itemId').val()).child('type').val() && newData.child('baseAmount').isNumber() && newData.child('baseAmount').val() > 0 && newData.child('amount').isNumber() && ((newData.child('paymentMethod').val() === 'card' && newData.child('currency').val() === 'UAH' && newData.child('baseAmount').val() === root.child('shop_items').child(newData.child('itemId').val()).child('priceUah').val() && newData.child('amount').val() >= newData.child('baseAmount').val() && newData.child('amount').val() < newData.child('baseAmount').val() + 1) || (newData.child('paymentMethod').val() === 'crypto' && newData.child('currency').val() === 'USDT' && newData.child('baseAmount').val() === root.child('shop_items').child(newData.child('itemId').val()).child('priceUsdt').val() && newData.child('amount').val() === newData.child('baseAmount').val())) && ((newData.child('itemType').val() !== 'tag' && newData.child('tag').val() === null) || (newData.child('itemType').val() === 'tag' && newData.child('tag').isString()))) || (!newData.exists() && data.child('uid').val() === auth.uid && data.child('status').val() === 'pending'))"
      }
    },
    "analytics": {
      "sales": {
        ".read": "auth != null && auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support' || root.child('staff').child(auth.uid).child('role').val() === 'marketing')",
        ".write": "auth != null && auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'"
      }
    },
    "entitlements": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'"
      }
    },
    "tags": {
      ".read": "auth != null && auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'",
      "$tag": {
        ".read": "auth != null && (data.child('uid').val() === auth.uid || (auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'))",
        ".write": "auth != null && ((auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner') || (!data.exists() && newData.child('uid').val() === auth.uid && newData.child('status').val() === 'reserved' && newData.child('orderId').isString() && newData.child('itemId').isString() && root.child('shop_items').child(newData.child('itemId').val()).child('enabled').val() === true && root.child('shop_items').child(newData.child('itemId').val()).child('type').val() === 'tag' && root.child('orders').child(newData.child('orderId').val()).child('uid').val() === auth.uid && root.child('orders').child(newData.child('orderId').val()).child('tag').val() === $tag && root.child('orders').child(newData.child('orderId').val()).child('itemId').val() === newData.child('itemId').val() && root.child('orders').child(newData.child('orderId').val()).child('status').val() === 'pending') || (!newData.exists() && data.child('uid').val() === auth.uid && data.child('status').val() === 'reserved' && !root.child('orders').child(data.child('orderId').val()).exists()))"
      }
    },
    "news": {
      ".read": true,
      ".write": "auth != null && auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'marketing')"
    },
    "bans": {
      ".read": "auth != null && auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support')",
      ".write": "auth != null && auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support')"
    },
    "errors": {
      ".read": "auth != null && auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support')",
      ".write": "auth != null && auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support')"
    },
    "dailyAnalytics": {
      ".read": "auth != null && auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support' || root.child('staff').child(auth.uid).child('role').val() === 'marketing')",
      ".write": false
    },
    "auditLog": {
      ".read": "auth != null && auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'",
      ".write": "auth != null && auth.token.firebase.sign_in_second_factor != null && (root.child('staff').child(auth.uid).child('role').val() === 'owner' || root.child('staff').child(auth.uid).child('role').val() === 'support')"
    },
    "config": {
      ".read": true,
      ".write": "auth != null && auth.token.firebase.sign_in_second_factor != null && root.child('staff').child(auth.uid).child('role').val() === 'owner'"
    }
  }
}`;


export async function beginGoogleSignIn(): Promise<User | null> {
  try {
    const cred = await signInWithPopup(auth, googleProvider);
    return cred.user;
  } catch (error) {
    const authError = error as MultiFactorError;
    if (authError.code !== "auth/multi-factor-auth-required") {
      throw error;
    }
    const resolver = getMultiFactorResolver(auth, authError);
    const phoneHint = resolver.hints.find(
      (hint) => hint.factorId === PhoneMultiFactorGenerator.FACTOR_ID
    ) as PhoneMultiFactorInfo | undefined;

    if (!phoneHint) {
      throw new Error(
        "У аккаунта нет доступного второго фактора. Добавьте номер телефона в Firebase Authentication."
      );
    }

    const container = document.getElementById("mfa-recaptcha") || document.body;
    const verifier = new RecaptchaVerifier(auth, container, { size: "invisible" });

    try {
      const verificationId = await new PhoneAuthProvider(auth).verifyPhoneNumber(
        { multiFactorHint: phoneHint, session: resolver.session },
        verifier
      );
      const code = window.prompt(
        `Введите код подтверждения из SMS, отправленного на ${phoneHint.phoneNumber || "ваш телефон"}:`
      );
      if (!code) return null;
      const credential = PhoneAuthProvider.credential(verificationId, code.trim());
      const assertion = PhoneMultiFactorGenerator.assertion(credential);
      return (await resolver.resolveSignIn(assertion)).user;
    } finally {
      verifier.clear();
    }
  }
}

export async function enrollPhoneMfa(user: User, verificationId: string, code: string) {
  const credential = PhoneAuthProvider.credential(verificationId, code);
  await multiFactor(user).enroll(
    PhoneMultiFactorGenerator.assertion(credential),
    "CRM security phone"
  );
}

export async function isSecondFactorSession(user: User): Promise<boolean> {
  try {
    const token = await user.getIdTokenResult(true);
    const firebaseClaims = token.claims.firebase as
      | { sign_in_second_factor?: string }
      | undefined;
    return Boolean(firebaseClaims?.sign_in_second_factor);
  } catch {
    return false;
  }
}

export {
  multiFactor,
  signOut,
  RecaptchaVerifier,
  ref as rtdbRef,
  set as rtdbRawSet,
  get as rtdbRawGet,
  update as rtdbRawUpdate,
  remove as rtdbRawRemove,
  onValue as rtdbOnValue,
  push as rtdbPush,
  child as rtdbChild,
};
