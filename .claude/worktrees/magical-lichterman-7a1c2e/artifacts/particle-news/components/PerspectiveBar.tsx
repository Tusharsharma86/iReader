import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";
import type { Source, SourceType } from "@/lib/api";

type Props = {
  sources: Source[];
};

const ORDER: SourceType[] = ["mainstream", "tech", "niche"];
const LABELS: Record<SourceType, string> = {
  mainstream: "Mainstream",
  tech: "Tech",
  niche: "Niche",
};

export function PerspectiveBar({ sources }: Props) {
  const colors = useColors();
  const colorMap = useMemo<Record<SourceType, string>>(
    () => ({
      mainstream: colors.sourceMainstream,
      tech: colors.sourceTech,
      niche: colors.sourceNiche,
    }),
    [colors],
  );

  const counts = useMemo(() => {
    const c: Record<SourceType, number> = { mainstream: 0, tech: 0, niche: 0 };
    sources.forEach((s) => {
      c[s.type] = (c[s.type] ?? 0) + 1;
    });
    return c;
  }, [sources]);

  const total = Math.max(sources.length, 1);

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={[styles.label, { color: colors.mutedForeground }]}>
          Perspective
        </Text>
        <Text style={[styles.count, { color: colors.mutedForeground }]}>
          {sources.length} {sources.length === 1 ? "source" : "sources"}
        </Text>
      </View>
      <View
        style={[styles.bar, { backgroundColor: "rgba(255,255,255,0.04)" }]}
      >
        {ORDER.map((type) => {
          const c = counts[type];
          if (c === 0) return null;
          return (
            <View
              key={type}
              style={{
                flex: c / total,
                backgroundColor: colorMap[type],
              }}
            />
          );
        })}
      </View>
      <View style={styles.legend}>
        {ORDER.map((type) => {
          if (counts[type] === 0) return null;
          return (
            <View key={type} style={styles.legendItem}>
              <View
                style={[styles.dot, { backgroundColor: colorMap[type] }]}
              />
              <Text
                style={[styles.legendText, { color: colors.mutedForeground }]}
              >
                {LABELS[type]} {counts[type]}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  label: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  count: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
  },
  bar: {
    flexDirection: "row",
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 2,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
});
