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

`public/phone.png` and `public/reader.png` are real screenshots of a Reader link served by
`demo/walkthrough/serve.sh`, with three Annotations pinned through the Reader API.
