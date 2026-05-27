import { useEffect, useState } from "react";

export type Tint = {
  dominant: string;
  vibrant: string;
};

const FALLBACK: Tint = { dominant: "#1A1A1A", vibrant: "#3A3A3A" };
const cache = new Map<string, Tint>();

const TINTS: Tint[] = [
  { dominant: "#1F363D", vibrant: "#5DD9C1" },
  { dominant: "#2E2B45", vibrant: "#8EA7FF" },
  { dominant: "#3A3020", vibrant: "#E8C36A" },
  { dominant: "#253A2E", vibrant: "#55D08A" },
  { dominant: "#3B252B", vibrant: "#FF8A8A" },
];

function tintFromKey(key: string): Tint {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return TINTS[hash % TINTS.length] ?? FALLBACK;
}

export function useImageTint(imageUrl: string | null | undefined): Tint {
  const [tint, setTint] = useState<Tint>(() => {
    if (!imageUrl) return FALLBACK;
    return cache.get(imageUrl) ?? FALLBACK;
  });

  useEffect(() => {
    if (!imageUrl) {
      setTint(FALLBACK);
      return;
    }
    const cached = cache.get(imageUrl);
    if (cached) {
      setTint(cached);
      return;
    }

    const picked = tintFromKey(imageUrl);
    cache.set(imageUrl, picked);
    setTint(picked);
  }, [imageUrl]);

  return tint;
}
