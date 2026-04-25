import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";

import {
  registerPushToken,
  unregisterPushToken,
  updatePushPreferences,
  type NotificationPrefs,
} from "@/lib/api";
import {
  cancelDailyDigestIfScheduled,
  ensureAndroidChannel,
  scheduleDailyDigest,
} from "@/lib/notifications";

const PREFS_STORAGE_KEY = "@particle/notification-prefs";
const TOKEN_STORAGE_KEY = "@particle/push-token";

const DEFAULT_PREFS: NotificationPrefs = {
  digestEnabled: false,
  digestHour: 8,
  digestMinute: 0,
  breakingEnabled: false,
  topicsEnabled: false,
  topicsKeywords: [],
};

type Status = "idle" | "requesting" | "granted" | "denied" | "unsupported";

type Ctx = {
  prefs: NotificationPrefs;
  status: Status;
  token: string | null;
  ready: boolean;
  requestPermission: () => Promise<boolean>;
  setPrefs: (next: Partial<NotificationPrefs>) => Promise<void>;
};

const NotificationsContext = createContext<Ctx | null>(null);

async function getExpoPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  try {
    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
        ?.eas?.projectId ??
      (Constants.easConfig as { projectId?: string } | undefined)?.projectId;
    const result = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    return result.data ?? null;
  } catch {
    return null;
  }
}

export function NotificationsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [prefs, setPrefsState] = useState<NotificationPrefs>(DEFAULT_PREFS);
  const [status, setStatus] = useState<Status>("idle");
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState<boolean>(false);
  // Debounce server pref updates so rapid toggle/time-picker changes don't
  // hammer the API.
  const serverSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate prefs + token from AsyncStorage on first mount.
  useEffect(() => {
    (async () => {
      try {
        const [rawPrefs, rawToken] = await Promise.all([
          AsyncStorage.getItem(PREFS_STORAGE_KEY),
          AsyncStorage.getItem(TOKEN_STORAGE_KEY),
        ]);
        if (rawPrefs) {
          const parsed = JSON.parse(rawPrefs) as Partial<NotificationPrefs>;
          setPrefsState({ ...DEFAULT_PREFS, ...parsed });
        }
        if (rawToken) setToken(rawToken);
      } catch {
        // ignore
      } finally {
        setReady(true);
      }
    })();
    ensureAndroidChannel().catch(() => {});
  }, []);

  // On mount, check current permission status without prompting.
  useEffect(() => {
    if (!Device.isDevice) {
      setStatus("unsupported");
      return;
    }
    (async () => {
      try {
        const { status: current } = await Notifications.getPermissionsAsync();
        if (current === "granted") {
          setStatus("granted");
          // Refresh the push token in case it rotated.
          const fresh = await getExpoPushToken();
          if (fresh) {
            setToken(fresh);
            await AsyncStorage.setItem(TOKEN_STORAGE_KEY, fresh);
            await registerPushToken(fresh, Platform.OS);
          }
        } else if (current === "denied") {
          setStatus("denied");
        } else {
          setStatus("idle");
        }
      } catch {
        setStatus("idle");
      }
    })();
  }, []);

  // Holds the latest prefs for synchronous reads from inside async callbacks
  // (useState's `prefs` capture would otherwise lose rapid sequential updates).
  const prefsRef = useRef<NotificationPrefs>(DEFAULT_PREFS);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  // Holds the latest token similarly so setPrefs can sync to the server right
  // after permission grant without waiting for a re-render cycle.
  const tokenRef = useRef<string | null>(null);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!Device.isDevice) {
      setStatus("unsupported");
      return false;
    }
    setStatus("requesting");
    try {
      const { status: current } = await Notifications.getPermissionsAsync();
      let final = current;
      if (current !== "granted") {
        const { status: next } = await Notifications.requestPermissionsAsync();
        final = next;
      }
      if (final !== "granted") {
        setStatus("denied");
        return false;
      }
      setStatus("granted");
      const fresh = await getExpoPushToken();
      if (fresh) {
        setToken(fresh);
        tokenRef.current = fresh;
        await AsyncStorage.setItem(TOKEN_STORAGE_KEY, fresh);
        // Register and immediately push the user's current prefs so server
        // and client are in sync the moment the token exists.
        await registerPushToken(fresh, Platform.OS);
        await updatePushPreferences(fresh, prefsRef.current).catch(() => {});
      }
      return true;
    } catch {
      setStatus("denied");
      return false;
    }
  }, []);

  // setPrefs persists to AsyncStorage immediately for snappy UI, syncs the
  // local daily-digest schedule synchronously, and debounces the server push.
  // Uses prefsRef + tokenRef so rapid consecutive edits never lose updates.
  const setPrefs = useCallback(
    async (patch: Partial<NotificationPrefs>) => {
      const merged: NotificationPrefs = { ...prefsRef.current, ...patch };
      prefsRef.current = merged;
      setPrefsState(merged);
      try {
        await AsyncStorage.setItem(
          PREFS_STORAGE_KEY,
          JSON.stringify(merged),
        );
      } catch {
        // ignore
      }

      // A) Local daily digest scheduling — only run if permission is granted.
      // We re-schedule on every change so the trigger time stays in sync.
      if (status === "granted") {
        if (merged.digestEnabled) {
          await scheduleDailyDigest(merged.digestHour, merged.digestMinute);
        } else {
          await cancelDailyDigestIfScheduled();
        }
      }

      // B/C) Server-side prefs (breaking + topics). Debounce by 600ms. We
      // always send the FULL merged prefs object so out-of-order debounced
      // calls converge on the latest state.
      const liveToken = tokenRef.current;
      if (liveToken) {
        if (serverSyncTimer.current) clearTimeout(serverSyncTimer.current);
        serverSyncTimer.current = setTimeout(() => {
          updatePushPreferences(liveToken, prefsRef.current).catch(() => {});
        }, 600);
      }
    },
    [status],
  );

  // After permission grant + token, ensure the daily digest schedule reflects
  // the persisted prefs (e.g. user enabled it before granting permission).
  useEffect(() => {
    if (!ready || status !== "granted") return;
    if (prefs.digestEnabled) {
      scheduleDailyDigest(prefs.digestHour, prefs.digestMinute).catch(() => {});
    } else {
      cancelDailyDigestIfScheduled().catch(() => {});
    }
  }, [ready, status, prefs.digestEnabled, prefs.digestHour, prefs.digestMinute]);

  // Cleanup pending debounced server sync on unmount so we don't fire after
  // the provider is gone.
  useEffect(() => {
    return () => {
      if (serverSyncTimer.current) clearTimeout(serverSyncTimer.current);
    };
  }, []);

  // Suppress unused-warn for unregisterPushToken; expose nothing to consumers
  // for now (uninstall path handled elsewhere).
  void unregisterPushToken;

  const value = useMemo<Ctx>(
    () => ({ prefs, status, token, ready, requestPermission, setPrefs }),
    [prefs, status, token, ready, requestPermission, setPrefs],
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): Ctx {
  const ctx = useContext(NotificationsContext);
  if (!ctx)
    throw new Error(
      "useNotifications must be used within NotificationsProvider",
    );
  return ctx;
}
