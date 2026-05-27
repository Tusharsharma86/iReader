import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/useColors";

type Props = {
  eyebrow?: string;
  title: string;
  subtitle?: string;
};

export function ScreenHeader({ eyebrow, title, subtitle }: Props) {
  const colors = useColors();
  return (
    <View style={styles.wrap}>
      <View style={styles.kickerRow}>
        <View style={[styles.kickerRule, { backgroundColor: colors.primary }]} />
        {eyebrow ? (
          <Text style={[styles.eyebrow, { color: colors.primary }]}>
            {eyebrow}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
      {subtitle ? (
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 18, gap: 6 },
  kickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minHeight: 14,
  },
  kickerRule: {
    width: 22,
    height: 2,
    borderRadius: 2,
  },
  eyebrow: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 1.8,
    textTransform: "uppercase",
  },
  title: {
    fontFamily: "Inter_700Bold",
    fontSize: 36,
    lineHeight: 41,
  },
  subtitle: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 2,
  },
});
