import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  FlatList,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { StoryCardView } from "@/components/StoryCard";
import { useSaved } from "@/contexts/SavedContext";
import { useColors } from "@/hooks/useColors";

const TAB_BAR_HEIGHT = Platform.OS === "web" ? 84 : 60;

export default function SavedScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const topInset = Platform.OS === "web" ? Math.max(insets.top, 12) : insets.top;
  const { saved } = useSaved();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <FlatList
        data={saved}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => (
          <StoryCardView story={item} index={index} />
        )}
        contentContainerStyle={{
          paddingTop: topInset + 4,
          paddingHorizontal: 16,
          paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24,
        }}
        ListHeaderComponent={
          <ScreenHeader
            eyebrow="Library"
            title="Saved"
            subtitle={
              saved.length === 0
                ? "Your bookmarked stories live here."
                : `${saved.length} ${saved.length === 1 ? "story" : "stories"} saved.`
            }
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Feather name="bookmark" size={36} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
              No saved stories yet
            </Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              Tap the bookmark icon on any story card to keep it here.
            </Text>
          </View>
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 80,
    gap: 10,
  },
  emptyTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
    marginTop: 8,
  },
  emptyText: {
    fontFamily: "Inter_500Medium",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 21,
  },
});
