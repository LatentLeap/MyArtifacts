import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Kicker } from "../Kicker";
import { c, ease, font, pop } from "../theme";

export const Notify: React.FC = () => {
  const frame = useCurrentFrame();
  const drop = pop(frame, 20, 50);
  return (
    <AbsoluteFill style={{ backgroundColor: c.bg }}>
      <Kicker n="03" label="Notify" title="One POST to the chat you already use." sub="Every new Annotation fires a webhook. No email, no provider SDK." />
      <div
        style={{
          position: "absolute", left: 120, top: 520, width: 1000, borderRadius: 28, background: c.paper, color: c.ink, padding: "30px 36px",
          fontFamily: font.sans, boxShadow: "0 40px 90px rgba(0,0,0,.6)", opacity: Math.min(1, drop), translate: `0 ${(1 - drop) * -60}px`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 26, color: c.muted }}>
          <span style={{ width: 14, height: 14, borderRadius: 7, background: c.accent }} /> MyArtifacts <span style={{ marginLeft: "auto" }}>now</span>
        </div>
        <div style={{ fontSize: 38, fontWeight: 600, marginTop: 14 }}>Maya Ortiz pinned on Kiln — Fall classes · v1</div>
        <div style={{ fontSize: 32, marginTop: 10, color: "#4a4844" }}>“Can we say six weeks? The fall course got shorter.”</div>
        <div style={{ fontSize: 28, marginTop: 18, color: c.accent, fontWeight: 600 }}>Open the pin →</div>
      </div>
      <div style={{ position: "absolute", left: 1220, top: 560, display: "flex", flexDirection: "column", gap: 26, fontFamily: font.sans }}>
        {["WeCom", "Feishu", "Slack", "anything with a URL"].map((t, i) => {
          const s = ease(frame, 50 + i * 10, 72 + i * 10);
          return (
            <div key={t} style={{ opacity: s, translate: `${(1 - s) * 40}px 0`, fontSize: 34, fontWeight: 600, color: c.paper, padding: "14px 30px", borderRadius: 999, border: `2px solid ${i === 3 ? c.accent : c.line}`, background: "#181818", alignSelf: "flex-start" }}>
              {t}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
