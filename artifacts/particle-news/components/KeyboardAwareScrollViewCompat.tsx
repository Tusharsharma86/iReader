import {
  KeyboardAwareScrollView,
  KeyboardAwareScrollViewProps,
} from "react-native-keyboard-controller";
import { Platform, ScrollView, ScrollViewProps } from "react-native";
import type { ReactNode } from "react";

type Props = Omit<KeyboardAwareScrollViewProps, "children"> &
  Omit<ScrollViewProps, "children"> & {
    children?: ReactNode;
  };

export function KeyboardAwareScrollViewCompat({
  children,
  keyboardShouldPersistTaps = "handled",
  ...props
}: Props) {
  const content = children as any;

  if (Platform.OS === "web") {
    return (
      <ScrollView keyboardShouldPersistTaps={keyboardShouldPersistTaps} {...props}>
        {content}
      </ScrollView>
    );
  }
  return (
    <KeyboardAwareScrollView
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      {...props}
    >
      {content}
    </KeyboardAwareScrollView>
  );
}
