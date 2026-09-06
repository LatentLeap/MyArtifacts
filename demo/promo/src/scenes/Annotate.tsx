import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { Kicker } from "../Kicker";
import { c, ease, font, pop } from "../theme";

// Where the Shell drew the bubbles in public/reader.png (CSS px of a 1280-wide capture), and
// what Maya said there. fixture/shoot.mjs prints these.
const PINS = [
  { x: 537, y: 290, at: 60, text: "Can we say six weeks? The fall course got shorter." },
  { x: 384, y: 1057, at: 168, text: "Ours fires almost black — this reads too brown." },
];
const W = 1180;
const S = W / 1280;
const SCROLL = PINS[1].y * S - 300; // bring the second pin to 300px inside the frame

export const Annotate: React.FC = () => {
  const frame = useCurrentFrame();
  const rise = ease(frame, 0, 30);
  const scroll = ease(frame, 128, 162) * SCROLL;
  return (
    <AbsoluteFill style={{ backgroundColor: c.bg }}>
      <Kicker n="02" label="Share · Annotate" title="A named link. No account." sub="The Reader clicks the page. The pin lands on an element, not a pixel." />
      <div
        style={{
          position: "absolute", left: 120, top: 470, width: W, height: 590, borderRadius: 18, overflow: "hidden", background: "#fff",
          boxShadow: "0 60px 120px rgba(0,0,0,.7)", opacity: rise, translate: `0 ${(1 - rise) * 80}px`,
        }}
      >
        <div style={{ height: 44, background: "#e9e6df", display: "flex", alignItems: "center", gap: 10, padding: "0 18px" }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((k) => <span key={k} style={{ width: 13, height: 13, borderRadius: 7, background: k }} />)}
          <span style={{ marginLeft: 20, flex: 1, height: 26, borderRadius: 8, background: "#fff", fontFamily: font.mono, fontSize: 16, color: "#8a8780", lineHeight: "26px", paddingLeft: 12 }}>artifacts.example.com/r/dl15x86T…</span>
        </div>
        <div style={{ position: "relative", translate: `0 ${-scroll}px` }}>
          <Img src={staticFile("reader.png")} style={{ width: W, display: "block" }} />
          {PINS.map((p) => {
            const ring = ease(frame, p.at, p.at + 30);
            return (
              <div key={p.at} style={{ position: "absolute", left: p.x * S, top: p.y * S }}>
                <div style={{ position: "absolute", left: -70, top: -70, width: 140, height: 140, borderRadius: 70, border: `4px solid ${c.accent}`, scale: String(0.25 + ring), opacity: 1 - ring }} />
              </div>
            );
          })}
        </div>
      </div>
      {PINS.map((p, i) => {
        const s = pop(frame, p.at + 8, p.at + 30);
        const gone = i === 0 ? 1 - ease(frame, 122, 134) : 1;
        return (
          <div
            key={p.at}
            style={{
              position: "absolute", left: 120 + p.x * S + 50, top: 470 + 44 + p.y * S - (i ? SCROLL : 0) - 30, width: 640, borderRadius: 24, background: "#fff", color: c.ink,
              padding: "26px 32px", fontFamily: font.sans, boxShadow: "0 30px 60px rgba(0,0,0,.45)", opacity: Math.min(1, s) * gone, scale: String(s),
              transformOrigin: "0 30%",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
              <span style={{ width: 44, height: 44, borderRadius: 22, background: c.accent, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 24 }}>M</span>
              <span style={{ fontWeight: 600, fontSize: 30 }}>Maya Ortiz</span>
              <span style={{ color: c.muted, fontSize: 24, marginLeft: "auto" }}>just now</span>
            </div>
            <div style={{ fontSize: 32, lineHeight: 1.4 }}>{p.text}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
