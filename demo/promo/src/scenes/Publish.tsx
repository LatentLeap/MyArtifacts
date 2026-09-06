import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { Kicker } from "../Kicker";
import { c, ease, font } from "../theme";

const CMD = [
  'curl -fsS -H "Authorization: Bearer $MYARTIFACTS_TOKEN" \\',
  "     -H 'Content-Type: text/html' --data-binary @page.html \\",
  '     -X POST "$MYARTIFACTS_URL/api/artifacts?canvas=720"',
].join("\n");

export const Publish: React.FC = () => {
  const frame = useCurrentFrame();
  const typed = Math.floor(interpolate(frame, [15, 80], [0, CMD.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const shown = ease(frame, 92, 108);
  return (
    <AbsoluteFill style={{ backgroundColor: c.bg }}>
      <Kicker n="01" label="Publish" title="One POST. One immutable Version." sub="HTML or Markdown, straight from the agent's shell. Nothing is public by default." />
      <div
        style={{
          position: "absolute", left: 120, right: 120, top: 520, height: 420, borderRadius: 20, background: "#181818",
          border: `1px solid ${c.line}`, boxShadow: "0 40px 100px rgba(0,0,0,.6)", padding: "28px 40px",
          fontFamily: font.mono, fontSize: 30, color: "#d8d5cf", lineHeight: 1.6,
          opacity: ease(frame, 4, 24), translate: `0 ${(1 - ease(frame, 4, 24)) * 40}px`,
        }}
      >
        <div style={{ display: "flex", gap: 12, marginBottom: 22 }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((k) => <span key={k} style={{ width: 16, height: 16, borderRadius: 8, background: k }} />)}
        </div>
        <pre style={{ margin: 0, fontFamily: "inherit", whiteSpace: "pre-wrap" }}>
          <span style={{ color: c.muted }}>$ </span>
          {CMD.slice(0, typed)}
          <span style={{ opacity: frame % 20 < 10 && frame < 92 ? 1 : 0, color: c.accent }}>▍</span>
        </pre>
        <div style={{ opacity: shown, translate: `0 ${(1 - shown) * 14}px`, marginTop: 20 }}>
          <span style={{ color: c.green, fontWeight: 700 }}>201 Created</span>
          <span style={{ color: c.muted }}>{"  "}</span>
          {'{"artifact":"26f8b360…","version":1,"canvas":720,"title":"官网改版方案"}'}
        </div>
      </div>
    </AbsoluteFill>
  );
};
