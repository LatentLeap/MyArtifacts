import { AbsoluteFill, useCurrentFrame } from "remotion";
import { c, ease, font } from "../theme";

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: c.paper, justifyContent: "center", alignItems: "center", fontFamily: font.sans, color: c.ink }}>
      <div style={{ display: "flex", alignItems: "center", gap: 28, opacity: ease(frame, 0, 24), scale: String(0.94 + ease(frame, 0, 24) * 0.06) }}>
        <span style={{ width: 96, height: 96, borderRadius: "50% 50% 50% 0", background: c.accent, border: "6px solid #fff", boxShadow: "0 16px 40px rgba(229,83,44,.35)" }} />
        <span style={{ fontSize: 132, fontWeight: 800, letterSpacing: -5 }}>MyArtifacts</span>
      </div>
      <div style={{ opacity: ease(frame, 18, 40), fontSize: 44, color: "#5c5a55", marginTop: 12, textAlign: "center", maxWidth: 1300, lineHeight: 1.35 }}>
        Self-hosted Claude Code Artifacts, with the half you can't buy: your customer's comments.
      </div>
      <div style={{ opacity: ease(frame, 40, 60), marginTop: 56, fontFamily: font.mono, fontSize: 36, background: c.ink, color: c.paper, padding: "20px 40px", borderRadius: 16 }}>
        git clone github.com/LatentLeap/MyArtifacts
      </div>
      <div style={{ opacity: ease(frame, 55, 75), marginTop: 30, fontSize: 30, color: c.muted, letterSpacing: 2 }}>MIT · Node 26 · one dependency</div>
    </AbsoluteFill>
  );
};
