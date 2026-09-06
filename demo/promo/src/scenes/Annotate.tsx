import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { Kicker } from "../Kicker";
import { c, ease, font, pop } from "../theme";

// Pins in the phone screenshot, in CSS px of the 390-wide capture.
const PINS = [
  { x: 253, y: 112, at: 70, text: "两栏之间的留白还是太宽，手机上看像断开了" },
  { x: 156, y: 174, at: 125, text: "备案号用灰色小字就行，别太显眼" },
];
const PHONE_W = 440;
const S = PHONE_W / 390;

export const Annotate: React.FC = () => {
  const frame = useCurrentFrame();
  const rise = ease(frame, 0, 30);
  return (
    <AbsoluteFill style={{ backgroundColor: c.bg }}>
      <Kicker n="02" label="Share · Annotate" title="A named link. No account." sub="The Reader taps the page. The pin lands on an element, not a pixel." />
      <div
        style={{
          position: "absolute", right: 200, top: 250, width: PHONE_W + 28, height: 820, borderRadius: 64, background: "#000",
          padding: 14, boxShadow: "0 60px 120px rgba(0,0,0,.7), inset 0 0 0 3px #2b2b2b", opacity: rise, translate: `0 ${(1 - rise) * 80}px`,
        }}
      >
        <div style={{ width: PHONE_W, height: 792, borderRadius: 50, overflow: "hidden", position: "relative", background: c.paper }}>
          <Img src={staticFile("phone.png")} style={{ width: PHONE_W, display: "block" }} />
          {PINS.map((p) => {
            const ring = ease(frame, p.at, p.at + 30);
            return (
              <div key={p.at} style={{ position: "absolute", left: p.x * S, top: p.y * S, width: 0, height: 0 }}>
                <div style={{ position: "absolute", left: -60, top: -60, width: 120, height: 120, borderRadius: 60, border: `4px solid ${c.accent}`, scale: String(0.3 + ring), opacity: 1 - ring }} />
              </div>
            );
          })}
        </div>
      </div>
      {PINS.map((p, i) => {
        const s = pop(frame, p.at + 8, p.at + 30);
        return (
          <div
            key={p.at}
            style={{
              position: "absolute", right: 700, top: 560 + i * 200, width: 620, borderRadius: 24, background: c.paper, color: c.ink,
              padding: "26px 32px", fontFamily: font.sans, boxShadow: "0 30px 60px rgba(0,0,0,.5)", opacity: Math.min(1, s), scale: String(s),
              transformOrigin: "100% 50%",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
              <span style={{ width: 44, height: 44, borderRadius: 22, background: c.accent, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 24 }}>李</span>
              <span style={{ fontWeight: 600, fontSize: 30 }}>李工</span>
              <span style={{ color: c.muted, fontSize: 24, marginLeft: "auto" }}>just now</span>
            </div>
            <div style={{ fontSize: 32, lineHeight: 1.4 }}>{p.text}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
