// An anchor is made on one Version and re-resolved against whatever is on screen (ADR-0011).
// Drawing the pin is the runtime's job inside the Artifact, so the rule itself is verified in a
// browser; what this seam owns is everything around it — the list keeps every Annotation whatever
// Version it was pinned on, its author keeps hold of one that no longer draws, and the two lines
// that carry the rule are shipped to the page that runs them.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { mintToken, start } from '../src/server.ts';

let dir: string;
let server: Awaited<ReturnType<typeof start>>;
let token: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'myartifacts-'));
  token = mintToken(dir, 'alice');
  server = await start({ dataDir: dir, shellPort: 0, usercontentPort: 0 });
});
after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

type Annotation = {
  annotation: string; reader: string; version: number;
  anchor: { path: string; pin: { x: number; y: number }; sig: string };
  text: string; status: 'open' | 'addressed'; created_at: string; mine?: boolean;
};

const auth = () => ({ authorization: `Bearer ${token}` });
const ANCHOR = { path: '#hero', pin: { x: 0.25, y: 0.5 }, sig: '0123456789abcdef' };

async function publish(): Promise<string> {
  const res = await fetch(`${server.shellOrigin}/api/artifacts?canvas=1200`, {
    method: 'POST', headers: { 'content-type': 'text/html', ...auth() }, body: '<title>v1</title><h1 id="hero">One</h1>',
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { artifact: string }).artifact;
}
async function mint(artifact: string, html: string): Promise<number> {
  const res = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/versions?canvas=1200`, {
    method: 'POST', headers: { 'content-type': 'text/html', ...auth() }, body: html,
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { version: number }).version;
}
async function link(artifact: string, name: string): Promise<string> {
  const res = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { url: string }).url;
}
const freeze = (artifact: string, version: number | null) =>
  fetch(`${server.shellOrigin}/api/artifacts/${artifact}/pinned`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify({ version }),
  });
async function pinned(url: string, version: number, text: string): Promise<Annotation> {
  const res = await fetch(`${url}/annotations`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version, anchor: ANCHOR, text }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as Annotation;
}
const list = async (url: string): Promise<Annotation[]> => {
  const res = await fetch(`${url}/annotations`);
  assert.equal(res.status, 200);
  return (await res.json()) as Annotation[];
};
/** Which Version the Reader's Shell page is framing — read off the constant it compares each Annotation's against. */
async function framedVersion(url: string): Promise<number> {
  const res = await fetch(url);
  assert.equal(res.status, 200);
  return Number(/\bVERSION=(\d+)/.exec(await res.text())?.[1]);
}

describe('an Annotation outlives the Version it was pinned on', () => {
  test('a new Version leaves the list alone and moves the Version on screen', async () => {
    const artifact = await publish();
    const url = await link(artifact, '王工');
    const a = await pinned(url, 1, 'logo 太小了');
    assert.equal(await framedVersion(url), 1, 'pinned on the Version on screen');

    await mint(artifact, '<title>v2</title><h1 id="hero">Two</h1>');
    assert.equal(await framedVersion(url), 2, 'the Reader has moved on');
    const seen = await list(url);
    assert.deepEqual(seen, [a], 'the same Annotation, untouched by the new Version');
    assert.equal(seen[0]!.version, 1, 'still pinned on v1, which is what makes the Shell ask for a strict match');
  });

  test('its author still flips and withdraws it once its Version has scrolled past', async () => {
    const artifact = await publish();
    const url = await link(artifact, '王工');
    const a = await pinned(url, 1, '这里的间距');
    await mint(artifact, '<title>v2</title><p>gone</p>');

    const flip = (status: string) => fetch(`${url}/annotations/${a.annotation}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }),
    });
    assert.equal((await flip('addressed')).status, 200);
    assert.equal((await list(url))[0]!.status, 'addressed');
    assert.equal((await flip('open')).status, 200);
    assert.equal((await fetch(`${url}/annotations/${a.annotation}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await list(url), []);
  });

  test('frozen on an old Version, a Reader gets the pins made on newer ones too', async () => {
    const artifact = await publish();
    const wang = await link(artifact, '王工');
    const li = await link(artifact, '李工');
    const v2 = await mint(artifact, '<title>v2</title><h1 id="hero">Two</h1>');
    const late = await pinned(li, v2, 'v2 上钉的');

    assert.equal((await freeze(artifact, 1)).status, 200);
    assert.equal(await framedVersion(wang), 1, 'frozen back on v1');
    // Same rule in both directions: the Shell hands the runtime every anchor and marks strict the
    // ones whose Version is not the one on screen — a later Version is as much "not this one".
    assert.deepEqual((await list(wang)).map((x) => [x.annotation, x.version]), [[late.annotation, 2]]);
  });

  test('the rule ships in the two files that run it: path plus exact sig, nothing else', async () => {
    const artifact = await publish();
    const url = await link(artifact, '王工');
    // Which Version an Annotation was pinned on is the whole of `strict`, and it is decided here
    // (the Shell never parses an anchor); the strict match itself is the runtime's, and it is
    // equality — no distance, no threshold, nothing to fall back to when it fails (ADR-0011).
    assert.ok((await (await fetch(url)).text()).includes('strict:a.version!==VERSION'), 'the Shell marks every anchor from another Version');
    const runtime = await (await fetch(`${server.usercontentOrigin(artifact)}/v/1`)).text();
    assert.ok(runtime.includes('a.strict && sigOf(el) !== a.sig'), 'exact equality, not fuzzy matching');
  });

  test('nothing but the anchor is kept: no coordinate to fall back on', async () => {
    const artifact = await publish();
    const url = await link(artifact, '王工');
    // The one thing a fallback layer would need is a rectangle to remember (ADR-0011). Offer one
    // and it does not survive the way in, so a Detached pin has nowhere to be drawn but nowhere.
    const res = await fetch(`${url}/annotations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, anchor: { ...ANCHOR, rect: { x: 10, y: 20, w: 30, h: 40 } }, text: '带坐标的锚' }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(((await res.json()) as Annotation).anchor, ANCHOR);
    assert.deepEqual((await list(url))[0]!.anchor, ANCHOR);
  });

  test('the Publisher still reads the Version it was pinned on', async () => {
    const artifact = await publish();
    const a = await pinned(await link(artifact, '王工'), 1, '标题改一下');
    await mint(artifact, '<title>v2</title><h1 id="hero">Two</h1>');

    const res = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/annotations`, { headers: auth() });
    assert.equal(res.status, 200);
    const { mine: _m, ...item } = a;
    assert.deepEqual(await res.json(), [item], 'the Publisher list is what it was before the new Version');
  });
});
