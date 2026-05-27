import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

const DAILY_DIGEST_ID = "particle-daily-digest";

// Configure how foreground notifications are presented. iOS needs banner/list
// flags explicitly so the digest pops up even while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync("default", {
      name: "iReader",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#A78BFA",
    });
  } catch {
    // best-effort
  }
}

// Cancel any existing daily-digest trigger so we don't stack duplicates after
// a settings change.
async function cancelDailyDigest(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(DAILY_DIGEST_ID);
  } catch {
    // ignore — notification may not have been scheduled
  }
}

export async function scheduleDailyDigest(
  hour: number,
  minute: number,
): Promise<void> {
  await cancelDailyDigest();
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: DAILY_DIGEST_ID,
      content: {
        title: "Today's top stories",
        body: "Tap to read your morning digest.",
        sound: "default",
        data: { kind: "daily-digest" },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour,
        minute,
      },
    });
  } catch {
    // best-effort — scheduling can fail on web/sim without permission
  }
}

export async function cancelDailyDigestIfScheduled(): Promise<void> {
  await cancelDailyDigest();
}
