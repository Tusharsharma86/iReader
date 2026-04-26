import AsyncStorage from "@react-native-async-storage/async-storage";

const SUMMARY_PREFIX = "ai_summary_v1_";
const SUMMARY_TTL_MS = 24 * 60 * 60 * 1000;

export async function getCachedSummary(url: string) {
  try {
    const raw = await AsyncStorage.getItem(SUMMARY_PREFIX + url);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      at: number;
      bullets: string[];
      summary: string;
    };
    if (Date.now() - parsed.at > SUMMARY_TTL_MS) {
      await AsyncStorage.removeItem(SUMMARY_PREFIX + url);
      return null;
    }
    return { bullets: parsed.bullets, summary: parsed.summary };
  } catch {
    return null;
  }
}

export async function saveSummaryToCache(
  url: string,
  bullets: string[],
  summary: string
) {
  try {
    await AsyncStorage.setItem(
      SUMMARY_PREFIX + url,
      JSON.stringify({ at: Date.now(), bullets, summary })
    );
  } catch {
    // ignore storage errors
  }
}
