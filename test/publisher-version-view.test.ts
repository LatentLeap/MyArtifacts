// The HTTP seam of the Publisher's Version view, `/a/{id}/v/{n}` (spec §12): the Reader's Shell
// page served under a cookie, with a header of its own and an annotation layer that only reads.
// What is asserted is what a browser is handed — the header, the constants the Shell script
// starts from, and the doors it will call — since the layer itself runs in that browser.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { mintToken, start } from '../src/server.ts';

let dir: string;
let server: Awaited<ReturnType<typeof start>>;
let root: string; // internal, minted on the box
let acme: string; // Client "acme"

const api = (path: string, token: string, init: RequestInit = {}) =>
  fetch(`${server.shellOrigin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

/** The view, as a browser asks for it: a cookie and no redirect-following. */
const view = (artifact: string, n: number, cookie: string | null = root) =>
  fetch(`${server.shellOrigin}/a/${artifact}/v/${n}`, {
    redirect: 'manual',
    headers: cookie ? { cookie: `myartifacts=${cookie}` } : {},
  });
const viewText = async (artifact: string, n: number, cookie: string | null = root) => {
  const res = await view(artifact, n, cookie);
  assert.equal(res.status, 200);
  return res.text();
};
/** One constant of the Shell script, as the page defines it. */
const constant = (page: string, name: string): unknown => {
  const m = new RegExp(`(?:^|[,;])${name}=(.*?)(?=,[A-Z_]+=|;\\n)`, 's').exec(page);
  assert.ok(m, `${name} is defined`);
  return JSON.parse(m[1]!);
};

async function publish(token: string, html: string, client?: string): Promise<string> {
  const url = new URL('/api/artifacts', server.shellOrigin);
  url.searchParams.set('canvas', '1200');
  if (client !== undefined) url.searchParams.set('client', client);
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/html', authorization: `Bearer ${token}` }, body: html });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return (JSON.parse(text) as { artifact: string }).artifact;
}
async function republish(artifact: string, html: string): Promise<number> {
  const res = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/versions?canvas=1200`, {
    method: 'POST', headers: { 'content-type': 'text/html', authorization: `Bearer ${root}` }, body: html,
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { version: number }).version;
}
const freeze = (artifact: string, version: number | null) =>
  api(`/api/artifacts/${artifact}/pinned`, root, { method: 'PUT', body: JSON.stringify({ version }) });
async function link(artifact: string, name = '王工'): Promise<string> {
  const res = await api(`/api/artifacts/${artifact}/readers`, root, { method: 'POST', body: JSON.stringify({ name }) });
  assert.equal(res.status, 201);
  return ((await res.json()) as { url: string }).url;
}
async function pin(url: string, text = 'logo 太小了'): Promise<string> {
  const res = await fetch(`${url}/annotations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, anchor: { path: '#hero', pin: { x: 0.25, y: 0.5 }, sig: '0123456789abcdef' }, text }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { annotation: string }).annotation;
}

const HTML = '<title>官网改版</title><h1 id="hero">Hello</h1>';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'myartifacts-'));
  root = mintToken(dir, 'alice');
  server = await start({ dataDir: dir, shellPort: 0, usercontentPort: 0 });
  acme = ((await (await api('/api/tokens', root, { method: 'POST', body: JSON.stringify({ name: 'acme-designer', client: 'acme' }) })).json()) as { token: string }).token;
});
after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('/a/{id}/v/{n}', () => {
  test('a browser without a cookie is sent to /login, not handed a 401', async () => {
    const artifact = await publish(root, HTML);
    const res = await view(artifact, 1, null);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
  });

  test('the header: back to the Artifact page, vN, 只读 — and no annotate button', async () => {
    const artifact = await publish(root, HTML);
    const page = await viewText(artifact, 1);
    assert.ok(page.includes(`href="/a/${artifact}"`), 'links back to the Artifact page');
    assert.ok(page.includes('v1'));
    assert.ok(page.includes('只读'));
    assert.ok(!page.includes('id="cbtn"'), 'no annotate button');
    // The drawer is still there: pins are read here, just never made.
    assert.ok(page.includes('id="drawer"'));
  });

  test('ready: me is the token name and owner; caps carry artifact on every Version', async () => {
    const artifact = await publish(root, HTML);
    await republish(artifact, HTML);
    for (const n of [1, 2]) {
      const ready = constant(await viewText(artifact, n), 'READY') as { caps: string[]; me: unknown };
      assert.deepEqual(ready.me, { id: 'alice', canEdit: true, isOwner: true });
      assert.ok(ready.caps.includes('artifact'));
    }
  });

  test("the annotation layer reads this Artifact's own list, whose items carry no `mine`", async () => {
    const artifact = await publish(root, HTML);
    await pin(await link(artifact));
    const page = await viewText(artifact, 1);
    const url = constant(page, 'API') as string;
    assert.equal(url, `${server.shellOrigin}/api/artifacts/${artifact}/annotations`);
    // The same door the Shell will call, under the same cookie — and no item claims to be
    // the holder's, so no card grows a flip or delete button.
    const res = await fetch(url, { headers: { cookie: `myartifacts=${root}` } });
    assert.equal(res.status, 200);
    const items = (await res.json()) as Record<string, unknown>[];
    assert.equal(items.length, 1);
    assert.ok(!('mine' in items[0]!));
  });

  test('frozen: said in the header, on the frozen Version and away from it', async () => {
    const artifact = await publish(root, HTML);
    await republish(artifact, HTML);
    assert.equal((await freeze(artifact, 1)).status, 200);
    assert.ok((await viewText(artifact, 1)).includes('冻结在此版'));
    assert.ok((await viewText(artifact, 2)).includes('冻结在 v1'));
    assert.equal((await freeze(artifact, null)).status, 200);
    assert.ok(!(await viewText(artifact, 2)).includes('冻结'));
  });

  test('only the live Version may publish itself: the view knows at load whether it is the writer', async () => {
    const artifact = await publish(root, HTML);
    await republish(artifact, HTML);
    const stale = await viewText(artifact, 1);
    assert.equal(constant(stale, 'WRITER'), false);
    assert.equal(constant(await viewText(artifact, 2), 'WRITER'), true);
    // Frozen — even on the live Version — is the same fact the server would answer with a 423.
    await freeze(artifact, 2);
    assert.equal(constant(await viewText(artifact, 2), 'WRITER'), false);
    // The refusal is the Shell's, before any request: the contract's `not_writer`.
    assert.ok(/if\(!WRITER\)return\{error:\{code:'not_writer'/.test(stale), 'the Shell refuses a stale publish as not_writer');
  });

  test("the same cross-version rule as the Reader's Shell, and the webhook's fragment opens its card", async () => {
    const artifact = await publish(root, HTML);
    const page = await viewText(artifact, 1);
    assert.ok(page.includes('strict:a.version!==VERSION'));
    assert.ok(page.includes('location.hash'));
  });

  test("another Client's Artifact, and a deleted one, are 404", async () => {
    const artifact = await publish(root, HTML);
    assert.equal((await view(artifact, 1, acme)).status, 404);
    assert.equal((await api(`/api/artifacts/${artifact}`, root, { method: 'DELETE' })).status, 204);
    assert.equal((await view(artifact, 1)).status, 404);
  });
});
