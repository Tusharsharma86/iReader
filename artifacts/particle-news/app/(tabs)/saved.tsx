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
          <View>
            <ScreenHeader
              eyebrow="Reading shelf"
              title="Saved"
              subtitle={
                saved.length === 0
                  ? "Your bookmarked stories live here for deeper reading."
                  : `${saved.length} ${saved.length === 1 ? "story" : "stories"} held for later.`
              }
            />
            <View style={[styles.libraryStrip, { backgroundColor: colors.card, borderColor: colors.cardBorder }]}>
              <Feather name="archive" size={18} color={colors.primary} />
              <Text style={[styles.libraryStripText, { color: colors.mutedForeground }]}>
                Saved clusters keep their summaries, sources, and original article links.
              </Text>
            </View>
          </View>
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
  libraryStrip: {
    marginHorizontal: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderRadius: 18,
    padding: 15,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  libraryStripText: {
    flex: 1,
    fontFamily: "Inter_500Medium",
    fontSize: 12.5,
    lineHeight: 18,
  },
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
