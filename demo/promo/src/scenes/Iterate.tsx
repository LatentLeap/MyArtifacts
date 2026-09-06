import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Kicker } from "../Kicker";
import { c, ease, font, pop } from "../theme";

const Page: React.FC<{ x: number; label: string; fade: number; lines: number[] }> = ({ x, label, fade, lines }) => (
  <div style={{ position: "absolute", left: x, top: 520, width: 660, height: 440, borderRadius: 24, background: c.paper, opacity: fade, boxShadow: "0 40px 90px rgba(0,0,0,.6)", overflow: "hidden" }}>
    <div style={{ background: c.ink, color: c.paper, fontFamily: font.sans, fontSize: 26, fontWeight: 600, padding: "14px 24px" }}>Kiln — Fall classes <span style={{ color: c.muted, marginLeft: 10 }}>{label}</span></div>
    <div style={{ padding: 30 }}>
      <div style={{ height: 34, width: 300, background: c.ink, borderRadius: 6, marginBottom: 26 }} />
      {lines.map((w, i) => <div key={i} style={{ height: 18, width: w, background: "#d9d6cf", borderRadius: 5, marginBottom: 16 }} />)}
    </div>
  </div>
);

const Pin: React.FC<{ x: number; y: number; state?: "ok" | "lost" }> = ({ x, y, state }) => (
  <div style={{ position: "absolute", left: x, top: y, width: 60, height: 60, borderRadius: "50% 50% 50% 0", background: c.accent, border: "4px solid #fff", boxShadow: "0 8px 20px rgba(0,0,0,.35)", color: "#fff", fontFamily: font.sans, fontWeight: 700, fontSize: 26, display: "flex", alignItems: "center", justifyContent: "center" }}>
    M
    {state ? (
      <span style={{ position: "absolute", left: 54, top: -6, whiteSpace: "nowrap", fontSize: 22, fontWeight: 600, padding: "4px 12px", borderRadius: 999, background: state === "ok" ? c.green : "#6b6863", color: state === "ok" ? "#0b3d1f" : "#fff" }}>
        {state === "ok" ? "✓ carried over" : "Detached"}
      </span>
    ) : null}
  </div>
);

export const Iterate: React.FC = () => {
  const frame = useCurrentFrame();
  const v2 = ease(frame, 30, 55);
  const move = pop(frame, 60, 100);
  const lost = ease(frame, 105, 125);
  const dx = 880; // v1 pin → its place on v2, badge still inside the card
  return (
    <AbsoluteFill style={{ backgroundColor: c.bg }}>
      <Kicker n="04" label="Iterate" title="v2 answers v1's pins." sub="Pins that still match carry over. The rest are marked Detached — never silently misplaced." />
      <Page x={120} label="v1" fade={ease(frame, 0, 20)} lines={[520, 480, 500, 300, 460, 380]} />
      <Page x={1140} label="v2" fade={v2} lines={[520, 480, 380, 460, 380]} />
      <Pin x={120 + 470} y={520 + 150 - move * 0} />
      <div style={{ position: "absolute", left: 0, top: 0, translate: `${move * dx}px 0`, opacity: move > 0.02 ? 1 : 0 }}>
        <Pin x={120 + 470} y={520 + 150} state={move > 0.95 ? "ok" : undefined} />
      </div>
      <div style={{ position: "absolute", left: 0, top: 0, translate: `${move * dx}px ${move * 56}px`, opacity: move > 0.02 ? 1 : 0 }}>
        <Pin x={120 + 430} y={520 + 218} state={move > 0.95 ? "ok" : undefined} />
      </div>
      <Pin x={120 + 430} y={520 + 218} />
      <div style={{ position: "absolute", left: 0, top: 0, opacity: 1 - lost * 0.55 }}>
        <Pin x={120 + 200} y={520 + 320} state={lost > 0.5 ? "lost" : undefined} />
      </div>
    </AbsoluteFill>
  );
};
