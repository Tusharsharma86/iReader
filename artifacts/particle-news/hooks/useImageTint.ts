import { useEffect, useState } from "react";
import { getColors } from "react-native-image-colors";

export type Tint = {
  dominant: string;
  vibrant: string;
};

const FALLBACK: Tint = { dominant: "#1A1A1A", vibrant: "#3A3A3A" };
const cache = new Map<string, Tint>();

function isValidHex(value: unknown): value is string {
  return (
    typeof value === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
  );
}

function pickColors(result: Awaited<ReturnType<typeof getColors>>): Tint {
  let dominant: string | undefined;
  let vibrant: string | undefined;

  if (result.platform === "android") {
    dominant = result.dominant ?? result.average ?? result.muted;
    vibrant = result.vibrant ?? result.darkVibrant ?? result.lightVibrant;
  } else if (result.platform === "ios") {
    dominant = result.background ?? result.primary;
    vibrant = result.detail ?? result.secondary ?? result.primary;
  } else {
    dominant =
      result.dominant ??
      result.darkMuted ??
      result.muted ??
      result.darkVibrant;
    vibrant =
      result.vibrant ??
      result.lightVibrant ??
      result.darkVibrant ??
      result.muted;
  }

  return {
    dominant: isValidHex(dominant) ? dominant : FALLBACK.dominant,
    vibrant: isValidHex(vibrant)
      ? vibrant
      : isValidHex(dominant)
        ? dominant
        : FALLBACK.vibrant,
  };
}

export function useImageTint(imageUrl: string | null | undefined): Tint {
  const [tint, setTint] = useState<Tint>(() => {
    if (!imageUrl) return FALLBACK;
    return cache.get(imageUrl) ?? FALLBACK;
  });

  useEffect(() => {
    let cancelled = false;
    if (!imageUrl) {
      setTint(FALLBACK);
      return;
    }
    const cached = cache.get(imageUrl);
    if (cached) {
      setTint(cached);
      return;
    }

    getColors(imageUrl, {
      fallback: "#1A1A1A",
      cache: true,
      key: imageUrl,
      quality: "low",
    })
      .then((result) => {
        if (cancelled) return;
        const picked = pickColors(result);
        cache.set(imageUrl, picked);
        setTint(picked);
      })
      .catch(() => {
        // ignore — keep fallback
      });

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  return tint;
}
