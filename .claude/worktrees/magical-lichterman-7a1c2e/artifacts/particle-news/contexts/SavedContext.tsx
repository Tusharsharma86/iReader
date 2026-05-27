import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { StoryCard } from "@/lib/api";

const STORAGE_KEY = "@particle/saved-stories";

type SavedContextValue = {
  saved: StoryCard[];
  isSaved: (id: string) => boolean;
  toggle: (story: StoryCard) => void;
  remove: (id: string) => void;
  ready: boolean;
};

const SavedContext = createContext<SavedContextValue | null>(null);

export function SavedProvider({ children }: { children: React.ReactNode }) {
  const [saved, setSaved] = useState<StoryCard[]>([]);
  const [ready, setReady] = useState<boolean>(false);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) setSaved(JSON.parse(raw) as StoryCard[]);
      } catch {
        // ignore
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const persist = useCallback((next: StoryCard[]) => {
    setSaved(next);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  const isSaved = useCallback(
    (id: string) => saved.some((s) => s.id === id),
    [saved],
  );

  const toggle = useCallback(
    (story: StoryCard) => {
      const exists = saved.some((s) => s.id === story.id);
      const next = exists
        ? saved.filter((s) => s.id !== story.id)
        : [story, ...saved];
      persist(next);
    },
    [saved, persist],
  );

  const remove = useCallback(
    (id: string) => {
      persist(saved.filter((s) => s.id !== id));
    },
    [saved, persist],
  );

  const value = useMemo<SavedContextValue>(
    () => ({ saved, isSaved, toggle, remove, ready }),
    [saved, isSaved, toggle, remove, ready],
  );

  return (
    <SavedContext.Provider value={value}>{children}</SavedContext.Provider>
  );
}

export function useSaved(): SavedContextValue {
  const ctx = useContext(SavedContext);
  if (!ctx) throw new Error("useSaved must be used within SavedProvider");
  return ctx;
}
