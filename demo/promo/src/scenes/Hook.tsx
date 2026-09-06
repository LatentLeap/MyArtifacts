import { AbsoluteFill, useCurrentFrame } from "remotion";
import { c, ease, font } from "../theme";

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const strike = ease(frame, 40, 60);
  return (
    <AbsoluteFill style={{ backgroundColor: c.bg, justifyContent: "center", alignItems: "center", fontFamily: font.sans }}>
      <div style={{ position: "relative", opacity: ease(frame, 0, 22), fontSize: 96, fontWeight: 800, color: c.paper, letterSpacing: -3 }}>
        Your customer can't open{" "}
        <span style={{ position: "relative", display: "inline-block" }}>
          claude.ai
          <span style={{ position: "absolute", left: 0, top: "52%", height: 10, width: `${strike * 100}%`, background: c.accent, borderRadius: 5 }} />
        </span>
        .
      </div>
      <div style={{ opacity: ease(frame, 62, 84), translate: `0 ${(1 - ease(frame, 62, 84)) * 30}px`, fontSize: 64, fontWeight: 600, color: c.accent, marginTop: 40 }}>
        Bring the page to them.
      </div>
    </AbsoluteFill>
  );
};
