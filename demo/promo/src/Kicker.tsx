import { useCurrentFrame } from "remotion";
import { c, ease, font } from "./theme";

/** "01 · Publish" over a headline, both rising in. */
export const Kicker: React.FC<{ n: string; label: string; title: string; sub?: string; light?: boolean }> = ({ n, label, title, sub, light }) => {
  const frame = useCurrentFrame();
  const ink = light ? c.ink : c.paper;
  return (
    <div style={{ position: "absolute", left: 120, top: 110, right: 120, fontFamily: font.sans, color: ink }}>
      <div style={{ opacity: ease(frame, 0, 20), fontSize: 30, fontWeight: 600, letterSpacing: 4, textTransform: "uppercase", color: c.accent }}>
        {n} · {label}
      </div>
      <div style={{ opacity: ease(frame, 8, 30), translate: `0 ${(1 - ease(frame, 8, 30)) * 24}px`, fontSize: 84, fontWeight: 800, lineHeight: 1.05, letterSpacing: -2, marginTop: 18 }}>
        {title}
      </div>
      {sub ? (
        <div style={{ opacity: ease(frame, 20, 42), fontSize: 40, color: light ? "#5c5a55" : c.muted, marginTop: 20, maxWidth: 1100, lineHeight: 1.35 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
};
