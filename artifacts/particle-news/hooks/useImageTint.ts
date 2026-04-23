import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { getColors } from "react-native-image-colors";

const cache = new Map<string, string>();

function clamp(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.replace("#", "").trim();
  if (m.length === 3) {
    const r = parseInt(m[0]! + m[0]!, 16);
    const g = parseInt(m[1]! + m[1]!, 16);
    const b = parseInt(m[2]! + m[2]!, 16);
    return [r, g, b];
  }
  if (m.length === 6) {
    const r = parseInt(m.slice(0, 2), 16);
    const g = parseInt(m.slice(2, 4), 16);
    const b = parseInt(m.slice(4, 6), 16);
    return [r, g, b];
  }
  return null;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      case bn:
        h = (rn - gn) / d + 4;
        break;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = clamp(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    clamp(hue2rgb(p, q, h + 1 / 3) * 255),
    clamp(hue2rgb(p, q, h) * 255),
    clamp(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

export type Tint = {
  cardBg: string;
  border: string;
  glow: string;
  accent: string;
};

function buildTint(hex: string): Tint {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return {
      cardBg: "rgba(255,255,255,0.05)",
      border: "rgba(255,255,255,0.08)",
      glow: "rgba(255,255,255,0.06)",
      accent: "rgba(255,255,255,0.6)",
    };
  }
  let [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  // boost saturation & cap lightness so muddy images still produce vivid tint
  s = Math.min(1, Math.max(s, 0.45));
  // bring base color into mid-tone for accent
  const accentL = Math.min(0.7, Math.max(0.55, l));
  const [ar, ag, ab] = hslToRgb(h, s, accentL);
  // dark tinted background for the card
  const [br, bg, bb] = hslToRgb(h, s * 0.9, 0.12);
  return {
    cardBg: `rgba(${br},${bg},${bb},0.55)`,
    border: `rgba(${ar},${ag},${ab},0.22)`,
    glow: `rgba(${ar},${ag},${ab},0.18)`,
    accent: `rgb(${ar},${ag},${ab})`,
  };
}

export function useImageTint(imageUrl: string | null | undefined): Tint | null {
  const [tint, setTint] = useState<Tint | null>(() => {
    if (!imageUrl) return null;
    const cached = cache.get(imageUrl);
    return cached ? buildTint(cached) : null;
  });

  useEffect(() => {
    let cancelled = false;
    if (!imageUrl) {
      setTint(null);
      return;
    }
    const cached = cache.get(imageUrl);
    if (cached) {
      setTint(buildTint(cached));
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
        let pick: string | undefined;
        if (result.platform === "android") {
          pick =
            result.vibrant ?? result.dominant ?? result.average ?? result.muted;
        } else if (result.platform === "ios") {
          pick = result.primary ?? result.detail ?? result.background;
        } else if (result.platform === "web") {
          pick =
            result.vibrant ??
            result.darkVibrant ??
            result.lightVibrant ??
            result.muted ??
            result.dominant;
        }
        if (pick) {
          cache.set(imageUrl, pick);
          setTint(buildTint(pick));
        }
      })
      .catch(() => {
        // ignore
      });

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  return tint;
}
