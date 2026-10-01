import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/**
 * The "SE" brand mark, matching the desktop sidebar's T3Wordmark SVG
 * (apps/web Sidebar.tsx). Width derives from the viewBox aspect ratio.
 */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 94.3941 / 56.96;
  return (
    <Svg
      accessibilityLabel="SE"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="15.5309 37 94.3941 56.96"
    >
      <ThemedPath
        d="M39 37C25 37 16 43 16 54C16 65 24 69 38 72C47 74 51 76 51 80C51 84 47 86 40 86C32 86 25 83 19 79L15.5309 89C22 93 30 93.96 40 93.96C55 93.96 64 88 64 77C64 66 56 62 42 59C33 57 29 55 29 51C29 47 33 45 40 45C47 45 53 47 59 50L63 41C56 38 49 37 39 37ZM72 37H109.925V48H85V59H107V70H85V83H109.925V93.96H72V37Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
