import "./index.css";
import { Composition, Folder } from "remotion";
import { Promo, SCENES, TOTAL } from "./Promo";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="Promo" component={Promo} durationInFrames={TOTAL} fps={30} width={1920} height={1080} />
    <Folder name="Scenes">
      {SCENES.map(([id, Scene, d]) => <Composition key={id} id={id} component={Scene} durationInFrames={d} fps={30} width={1920} height={1080} />)}
    </Folder>
  </>
);
