# Promo video

The 27-second tour at the top of the repo README, as a [Remotion](https://remotion.dev) project.
One composition, `Promo`, made of six scenes under `src/scenes/`; each scene is also registered on
its own so it can be scrubbed in Studio.

```bash
npm install
npx remotion studio                                   # preview
npx remotion render Promo ../../docs/media/promo.mp4   # 1920×1080, 30 fps
npx remotion render Promo ../../docs/media/promo.gif --codec=gif --scale=0.5 --every-nth-frame=2
```

`public/reader.png` and the README's `docs/media/reader.png` are real screenshots of a Reader
link: `fixture/shoot.mjs` starts the walkthrough's demo server, publishes `fixture/kiln.html`
(a landing-page mockup composed for a 1200 Canvas), pins three Annotations through the Reader API
and prints where the Shell drew them, which is what `src/scenes/Annotate.tsx` animates.

```bash
node demo/promo/fixture/shoot.mjs   # from the repo root; needs Playwright on the path it imports
```
