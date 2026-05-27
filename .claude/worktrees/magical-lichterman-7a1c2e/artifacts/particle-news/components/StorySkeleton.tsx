import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { useColors } from "@/hooks/useColors";

function Shimmer({
  height,
  width,
  radius = 8,
}: {
  height: number;
  width: number | string;
  radius?: number;
}) {
  const colors = useColors();
  const opacity = useSharedValue(0.4);

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.85, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[
        {
          height,
          width: width as number,
          borderRadius: radius,
          backgroundColor: "rgba(255,255,255,0.06)",
        },
        style,
      ]}
    />
  );
}

export function StorySkeleton() {
  const colors = useColors();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.cardBorder,
          borderRadius: colors.radius,
        },
      ]}
    >
      <Shimmer height={180} width={"100%"} radius={0} />
      <View style={styles.body}>
        <Shimmer height={20} width={"85%"} />
        <Shimmer height={20} width={"60%"} />
        <View style={{ height: 8 }} />
        <Shimmer height={14} width={"95%"} />
        <Shimmer height={14} width={"90%"} />
        <Shimmer height={14} width={"75%"} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 16,
  },
  body: { padding: 18, gap: 10 },
});
