// The HTTP seam, from the Reader's side of an Annotation: pin one on the Version on screen,
// list what everyone pinned, flip and withdraw your own. Real HTTP in, HTTP out.
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

const auth = () => ({ authorization: `Bearer ${token}` });

type Annotation = {
  annotation: string; reader: string; version: number;
  anchor: { path: string; pin: { x: number; y: number }; sig: string };
  text: string; status: 'open' | 'addressed'; created_at: string; mine: boolean;
};

async function publish(html = '<title>官网改版</title><h1 id="hero">Hello</h1>'): Promise<string> {
  const res = await fetch(`${server.shellOrigin}/api/artifacts?canvas=1200`, {
    method: 'POST', headers: { 'content-type': 'text/html', ...auth() }, body: html,
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { artifact: string }).artifact;
}

async function link(artifact: string, name = '王工'): Promise<string> {
  const res = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { url: string }).url;
}

const ANCHOR = { path: '#hero', pin: { x: 0.25, y: 0.5 }, sig: '0123456789abcdef' };
const pin = (url: string, body: unknown) =>
  fetch(`${url}/annotations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
async function pinned(url: string, text = 'logo 太小了'): Promise<Annotation> {
  const res = await pin(url, { version: 1, anchor: ANCHOR, text });
  assert.equal(res.status, 201);
  return (await res.json()) as Annotation;
}
const list = async (url: string): Promise<Annotation[]> => {
  const res = await fetch(`${url}/annotations`);
  assert.equal(res.status, 200);
  return (await res.json()) as Annotation[];
};

describe('POST /r/{secret}/annotations', () => {
  test('201 carries the Annotation as the list will show it, marked mine', async () => {
    const url = await link(await publish());
    const a = await pinned(url, 'logo 太小了，放大一倍');
    assert.match(a.annotation, /^[a-f0-9]{32}$/);
    assert.equal(a.reader, '王工');
    assert.equal(a.version, 1);
    assert.deepEqual(a.anchor, ANCHOR);
    assert.equal(a.text, 'logo 太小了，放大一倍');
    assert.equal(a.status, 'open');
    assert.match(a.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(a.mine, true);
  });

  test('the anchor is bounded, never parsed: path ≤ 1000, sig fixed-length, text ≤ 4096', async () => {
    const url = await link(await publish());
    const bad = async (body: unknown, why: string) => assert.equal((await pin(url, body)).status, 400, why);
    await bad({ version: 1, anchor: { ...ANCHOR, path: 'x'.repeat(1001) }, text: 'hi' }, 'path over 1000');
    await bad({ version: 1, anchor: { ...ANCHOR, path: '' }, text: 'hi' }, 'empty path');
    await bad({ version: 1, anchor: { ...ANCHOR, sig: '0123456789abcde' }, text: 'hi' }, 'sig too short');
    await bad({ version: 1, anchor: { ...ANCHOR, sig: '0123456789abcdefg' }, text: 'hi' }, 'sig too long');
    await bad({ version: 1, anchor: { ...ANCHOR, pin: { x: 2, y: 0 } }, text: 'hi' }, 'pin outside the element');
    await bad({ version: 1, anchor: { path: '#hero', sig: ANCHOR.sig }, text: 'hi' }, 'no pin');
    await bad({ version: 1, anchor: ANCHOR, text: 'x'.repeat(4097) }, 'text over 4096');
    await bad({ version: 1, anchor: ANCHOR, text: '   ' }, 'blank text');
    await bad({ version: 2, anchor: ANCHOR, text: 'hi' }, 'a Version that does not exist');
    await bad({ anchor: ANCHOR, text: 'hi' }, 'no version');
    await bad('not json', 'not json');
    // A path is opaque to the Shell: anything up to the cap goes in as it came.
    const weird = { ...ANCHOR, path: 'body>div:nth-of-type(2)>p:nth-of-type(1) "quoted" <b>' };
    const res = await pin(url, { version: 1, anchor: weird, text: 'x'.repeat(4096) });
    assert.equal(res.status, 201);
    assert.deepEqual(((await res.json()) as Annotation).anchor, weird);
    assert.equal((await list(url)).length, 1);
  });

  test('a revoked link cannot pin', async () => {
    const artifact = await publish();
    const url = await link(artifact);
    const rid = ((await (await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`, { headers: auth() })).json()) as { reader: string }[])[0]?.reader;
    await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers/${rid}`, { method: 'DELETE', headers: auth() });
    assert.equal((await pin(url, { version: 1, anchor: ANCHOR, text: 'hi' })).status, 404);
    assert.equal((await fetch(`${url}/annotations`)).status, 404);
  });
});

describe('GET /r/{secret}/annotations', () => {
  test('everyone on the Artifact sees every Annotation; only the author sees mine', async () => {
    const artifact = await publish();
    const wang = await link(artifact, '王工');
    const li = await link(artifact, '李工');
    const a = await pinned(wang, '王工说');
    const b = await pinned(li, '李工说');
    await pinned(await link(await publish()), '别的 Artifact');

    const seenByWang = await list(wang);
    assert.deepEqual(seenByWang.map((x) => [x.reader, x.mine]), [['王工', true], ['李工', false]]);
    assert.deepEqual(seenByWang.map((x) => x.annotation), [a.annotation, b.annotation]);
    const { mine: _m, ...item } = seenByWang[0]!;
    const { mine: _n, ...posted } = a;
    assert.deepEqual(item, posted, 'the list item is the 201 body');
    assert.deepEqual((await list(li)).map((x) => x.mine), [false, true]);
  });

  test('a soft-deleted Artifact takes its Annotations out of reach', async () => {
    const artifact = await publish();
    const url = await link(artifact);
    await pinned(url);
    await fetch(`${server.shellOrigin}/api/artifacts/${artifact}`, { method: 'DELETE', headers: auth() });
    assert.equal((await fetch(`${url}/annotations`)).status, 404);
    assert.equal((await pin(url, { version: 1, anchor: ANCHOR, text: 'hi' })).status, 404);
  });
});

const patch = (url: string, aid: string, status: unknown) =>
  fetch(`${url}/annotations/${aid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
const del = (url: string, aid: string) => fetch(`${url}/annotations/${aid}`, { method: 'DELETE' });

describe('PATCH /r/{secret}/annotations/{aid}', () => {
  test('the author flips open → addressed → open', async () => {
    const url = await link(await publish());
    const a = await pinned(url);
    const res = await patch(url, a.annotation, 'addressed');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ...a, status: 'addressed' });
    assert.equal((await list(url))[0]?.status, 'addressed');
    assert.equal((await patch(url, a.annotation, 'open')).status, 200);
    assert.equal((await list(url))[0]?.status, 'open');
  });

  test('anything but open or addressed → 400', async () => {
    const url = await link(await publish());
    const a = await pinned(url);
    assert.equal((await patch(url, a.annotation, 'resolved')).status, 400);
    assert.equal((await patch(url, a.annotation, undefined)).status, 400);
  });

  test('somebody else’s → 403, and nothing moves', async () => {
    const artifact = await publish();
    const wang = await link(artifact, '王工');
    const li = await link(artifact, '李工');
    const a = await pinned(wang);
    assert.equal((await patch(li, a.annotation, 'addressed')).status, 403);
    assert.equal((await list(li))[0]?.status, 'open');
  });

  test('an Annotation on another Artifact, or none at all → 404', async () => {
    const url = await link(await publish());
    const other = await pinned(await link(await publish()));
    assert.equal((await patch(url, other.annotation, 'addressed')).status, 404);
    assert.equal((await patch(url, '0'.repeat(32), 'addressed')).status, 404);
  });
});

describe('DELETE /r/{secret}/annotations/{aid}', () => {
  test('the author withdraws an open one: 204, gone from the list', async () => {
    const url = await link(await publish());
    const a = await pinned(url);
    const keep = await pinned(url, '留着的');
    assert.equal((await del(url, a.annotation)).status, 204);
    assert.deepEqual((await list(url)).map((x) => x.annotation), [keep.annotation]);
    assert.equal((await del(url, a.annotation)).status, 404);
  });

  test('once addressed it is part of the record → 409', async () => {
    const url = await link(await publish());
    const a = await pinned(url);
    await patch(url, a.annotation, 'addressed');
    assert.equal((await del(url, a.annotation)).status, 409);
    assert.equal((await list(url)).length, 1);
  });

  test('somebody else’s → 403', async () => {
    const artifact = await publish();
    const a = await pinned(await link(artifact, '王工'));
    const li = await link(artifact, '李工');
    assert.equal((await del(li, a.annotation)).status, 403);
    assert.equal((await list(li)).length, 1);
  });
});

describe('the Publisher’s counts', () => {
  test('open_annotations counts open ones, on the detail and in the gallery', async () => {
    const artifact = await publish();
    const url = await link(artifact);
    await pinned(url);
    const done = await pinned(url);
    await patch(url, done.annotation, 'addressed');
    const detail = (await (await fetch(`${server.shellOrigin}/api/artifacts/${artifact}`, { headers: auth() })).json()) as { open_annotations: number };
    assert.equal(detail.open_annotations, 1);
    const gallery = (await (await fetch(`${server.shellOrigin}/api/artifacts`, { headers: auth() })).json()) as { artifact: string; open_annotations: number }[];
    assert.equal(gallery.find((r) => r.artifact === artifact)?.open_annotations, 1);
  });
});

describe('the Reader’s Shell page carries the annotation layer', () => {
  test('the page knows its Version, its annotations URL, and speaks the four comment messages', async () => {
    const artifact = await publish();
    const url = await link(artifact, '王工');
    const page = await (await fetch(url)).text();
    assert.ok(page.includes(`API=${JSON.stringify(`${url}/annotations`)}`), 'the annotations URL is inlined');
    assert.ok(page.includes('VERSION=1'), 'the Version on screen, for strict re-anchoring later');
    assert.ok(page.includes('id="cbtn"'), 'the comment-mode button');
    for (const m of ["type:'mode'", "type:'locate'", "m.type==='click'", "m.type==='located'"]) assert.ok(page.includes(m), m);
    // The Publisher's Version view shares the page and reads the Artifact's whole list — with
    // nothing to pin one by (ticket 15).
    const preview = await (await fetch(`${server.shellOrigin}/a/${artifact}/v/1`, { headers: auth() })).text();
    assert.ok(preview.includes(`API=${JSON.stringify(`${server.shellOrigin}/api/artifacts/${artifact}/annotations`)}`), preview.slice(-300));
    assert.ok(!preview.includes('id="cbtn"'));
  });

  test('the runtime intercepts clicks in comment mode and re-resolves anchors on change', async () => {
    const artifact = await publish();
    const runtime = await (await fetch(`${server.usercontentOrigin(artifact)}/v/1`)).text();
    for (const m of ["m.type === 'mode'", "m.type === 'locate'", "type: 'click'", "type: 'located'", 'MutationObserver', 'stopImmediatePropagation']) {
      assert.ok(runtime.includes(m), m);
    }
  });
});
