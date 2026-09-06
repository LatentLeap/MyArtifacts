import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadSC } from "@remotion/google-fonts/NotoSansSC";
import { Easing, interpolate } from "remotion";

const inter = loadInter("normal", { weights: ["400", "600", "800"], subsets: ["latin"] });
const mono = loadMono("normal", { weights: ["400", "700"], subsets: ["latin"] });
const sc = loadSC("normal", { weights: ["400", "700"], subsets: ["chinese-simplified", "latin"] });

export const font = {
  sans: `${inter.fontFamily}, ${sc.fontFamily}, system-ui, sans-serif`,
  mono: `${mono.fontFamily}, ui-monospace, monospace`,
};

export const c = {
  bg: "#101010",
  paper: "#f7f6f3",
  ink: "#161616",
  accent: "#e5532c",
  muted: "#8d8a84",
  line: "#2a2a2a",
  green: "#3ddc84",
};

/** 0→1 between two frames, eased and clamped. */
export const ease = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

/** A spring-ish pop: overshoots a touch, settles at 1. */
export const pop = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.back(1.6),
  });
