import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Annotate } from "./scenes/Annotate";
import { Hook } from "./scenes/Hook";
import { Iterate } from "./scenes/Iterate";
import { Notify } from "./scenes/Notify";
import { Outro } from "./scenes/Outro";
import { Publish } from "./scenes/Publish";

export const SCENES = [
  ["Hook", Hook, 110],
  ["Publish", Publish, 150],
  ["Annotate", Annotate, 200],
  ["Notify", Notify, 130],
  ["Iterate", Iterate, 165],
  ["Outro", Outro, 120],
] as const;
export const FADE = 15;
export const TOTAL = SCENES.reduce((n, s) => n + s[2], 0) - FADE * (SCENES.length - 1);

export const Promo: React.FC = () => (
  <TransitionSeries>
    {SCENES.flatMap(([id, Scene, d], i) => [
      ...(i ? [<TransitionSeries.Transition key={`t${id}`} presentation={fade()} timing={linearTiming({ durationInFrames: FADE })} />] : []),
      <TransitionSeries.Sequence key={id} durationInFrames={d} name={id}><Scene /></TransitionSeries.Sequence>,
    ])}
  </TransitionSeries>
);
