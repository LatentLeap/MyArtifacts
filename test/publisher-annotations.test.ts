// The Publisher's half of an Annotation, the half an agent reads: list what came back on an
// Artifact, flip one addressed, and — for a new one only — hear about it on the webhook in the
// environment. Real HTTP on both sides: the receiver is a listener on a real port, not a stub.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

import { mintToken, start } from '../src/server.ts';

import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

type Annotation = {
  annotation: string; reader: string; version: number;
  anchor: { path: string; pin: { x: number; y: number }; sig: string };
  text: string; status: 'open' | 'addressed'; created_at: string; mine?: boolean;
};
type Delivery = { contentType?: string; body: Record<string, unknown> };

let dir: string;
let server: Awaited<ReturnType<typeof start>>;
let receiver: Server;
let token: string;
let hits: Delivery[] = [];
/** How the receiver answers, swapped per test: 200 by default, a refusal, or never. */
let answer: (res: ServerResponse) => void | Promise<void>;
const ok = (res: ServerResponse) => { res.writeHead(200); res.end('ok'); };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'myartifacts-'));
  token = mintToken(dir, 'alice');
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const hit: Delivery = {
        contentType: req.headers['content-type'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      };
      hits.push(hit);
      void answer(res);
    });
  });
  await new Promise<void>((r) => receiver.listen(0, r));
  server = await start({
    dataDir: dir, shellPort: 0, usercontentPort: 0,
    webhookUrl: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`,
  });
});
after(async () => {
  await server.close();
  receiver.closeAllConnections();
  await new Promise<void>((r) => receiver.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { hits = []; answer = ok; });

const auth = (t = token) => ({ authorization: `Bearer ${t}` });
const api = (path: string, t = token, init: RequestInit = {}) =>
  fetch(`${server.shellOrigin}${path}`, { ...init, headers: { ...auth(t), ...init.headers } });

async function publish(t = token, client?: string): Promise<string> {
  const url = new URL(`${server.shellOrigin}/api/artifacts?canvas=1200`);
  if (client !== undefined) url.searchParams.set('client', client);
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'text/html', ...auth(t) },
    body: '<title>官网改版</title><h1 id="hero">Hello</h1>',
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { artifact: string }).artifact;
}
async function link(artifact: string, name = '王工'): Promise<string> {
  const res = await api(`/api/artifacts/${artifact}/readers`, token, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { url: string }).url;
}
const ANCHOR = { path: '#hero', pin: { x: 0.25, y: 0.5 }, sig: '0123456789abcdef' };
async function pinned(url: string, text = 'logo 太小了'): Promise<Annotation> {
  const res = await fetch(`${url}/annotations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, anchor: ANCHOR, text }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as Annotation;
}
const readerList = async (url: string): Promise<Annotation[]> =>
  (await (await fetch(`${url}/annotations`)).json()) as Annotation[];
async function publisherList(artifact: string, query = '', t = token): Promise<Annotation[]> {
  const res = await api(`/api/artifacts/${artifact}/annotations${query}`, t);
  assert.equal(res.status, 200);
  return (await res.json()) as Annotation[];
}
let minted = 0;
/** A token confined to a Client of its own: everything of ours is invisible to it (ADR-0008). */
async function outsider(client: string): Promise<string> {
  const res = await api('/api/tokens', token, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${client}-${++minted}`, client }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { token: string }).token;
}
const flip = (aid: string, status: unknown, t = token) =>
  api(`/api/annotations/${aid}`, t, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }),
  });
/** Waits for the nth delivery — the POST goes out after the Reader's 201, so it lands later. */
async function delivered(n = 1): Promise<Delivery> {
  const deadline = Date.now() + 2000;
  while (hits.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.ok(hits.length >= n, `expected ${n} webhook deliveries, got ${hits.length}`);
  return hits[n - 1]!;
}
/** Gives anything the pin set off a chance to arrive, for the tests that expect nothing. */
const quiet = () => new Promise((r) => setTimeout(r, 150));

describe('GET /api/artifacts/{id}/annotations', () => {
  test('lists what the Readers pinned, oldest first, by name, with no `mine`', async () => {
    const artifact = await publish();
    const wang = await link(artifact, '王工');
    const li = await link(artifact, '李总');
    const first = await pinned(wang, 'logo 太小了');
    const second = await pinned(li, '这段文案再短一点');

    const rows = await publisherList(artifact);
    assert.deepEqual(rows.map((a) => a.annotation), [first.annotation, second.annotation]);
    assert.deepEqual(rows.map((a) => a.reader), ['王工', '李总']);
    // The same serializer the Reader gets, minus the one field that means "yours".
    assert.ok(!('mine' in rows[0]!), 'a Publisher is nobody’s author');
    delete first.mine;
    assert.deepEqual(rows[0], first);
    assert.deepEqual(rows[1]?.anchor, ANCHOR);
  });

  test('?status= narrows to open or addressed; anything else is a 400', async () => {
    const artifact = await publish();
    const url = await link(artifact);
    const stale = await pinned(url, '这条已经改了');
    await pinned(url, '这条还没改');
    assert.equal((await flip(stale.annotation, 'addressed')).status, 200);

    assert.deepEqual((await publisherList(artifact, '?status=open')).map((a) => a.text), ['这条还没改']);
    assert.deepEqual((await publisherList(artifact, '?status=addressed')).map((a) => a.text), ['这条已经改了']);
    assert.equal((await publisherList(artifact)).length, 2);
    assert.equal((await api(`/api/artifacts/${artifact}/annotations?status=all`)).status, 400);
  });

  test('another Client’s Artifact, a soft-deleted one and no token are all a miss', async () => {
    const artifact = await publish();
    await pinned(await link(artifact));
    assert.equal((await api(`/api/artifacts/${artifact}/annotations`, await outsider('globex'))).status, 404);
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/annotations`)).status, 401);

    assert.equal((await api(`/api/artifacts/${artifact}`, token, { method: 'DELETE' })).status, 204);
    assert.equal((await api(`/api/artifacts/${artifact}/annotations`)).status, 404);
  });

  test('a Publisher cannot create or delete an Annotation', async () => {
    const artifact = await publish();
    const a = await pinned(await link(artifact));
    const post = await api(`/api/artifacts/${artifact}/annotations`, token, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, anchor: ANCHOR, text: '我替客户说一句' }),
    });
    assert.equal(post.status, 404);
    assert.equal((await api(`/api/annotations/${a.annotation}`, token, { method: 'DELETE' })).status, 404);
    assert.equal((await publisherList(artifact)).length, 1);
  });
});

describe('PATCH /api/annotations/{aid}', () => {
  test('flips addressed and back, and the Reader sees it', async () => {
    const artifact = await publish();
    const url = await link(artifact);
    const a = await pinned(url);

    const res = await flip(a.annotation, 'addressed');
    assert.equal(res.status, 200);
    delete a.mine;
    assert.deepEqual(await res.json(), { ...a, status: 'addressed' });
    assert.equal((await readerList(url))[0]?.status, 'addressed');
    const detail = (await (await api(`/api/artifacts/${artifact}`)).json()) as { open_annotations: number };
    assert.equal(detail.open_annotations, 0);

    assert.equal((await flip(a.annotation, 'open')).status, 200);
    assert.equal((await readerList(url))[0]?.status, 'open');
  });

  test('a bad status → 400; an unknown or out-of-bounds Annotation → 404; no token → 401', async () => {
    const artifact = await publish();
    const a = await pinned(await link(artifact));
    assert.equal((await flip(a.annotation, 'done')).status, 400);
    assert.equal((await flip(a.annotation, null)).status, 400);
    assert.equal((await flip('f'.repeat(32), 'addressed')).status, 404);
    assert.equal((await flip(a.annotation, 'addressed', await outsider('globex'))).status, 404, 'another Client’s Annotation is simply absent');
    assert.equal(
      (await fetch(`${server.shellOrigin}/api/annotations/${a.annotation}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"status":"addressed"}',
      })).status,
      401,
    );

    assert.equal((await api(`/api/artifacts/${artifact}`, token, { method: 'DELETE' })).status, 204);
    assert.equal((await flip(a.annotation, 'addressed')).status, 404, 'a soft-deleted Artifact takes its Annotations with it');
  });
});

describe('the webhook', () => {
  test('a new Annotation arrives as the list item plus Artifact, title, Client and Publisher URL', async () => {
    const artifact = await publish(token, 'acme');
    const a = await pinned(await link(artifact, '王工'), 'logo 太小了');

    const hit = await delivered();
    assert.match(hit.contentType ?? '', /^application\/json/);
    assert.deepEqual(hit.body, {
      annotation: a.annotation, reader: '王工', version: 1, anchor: ANCHOR,
      text: 'logo 太小了', status: 'open', created_at: a.created_at,
      artifact, title: '官网改版', client: 'acme',
      url: `${server.shellOrigin}/a/${artifact}/v/1#${a.annotation}`,
    });
    // Not a Reader link, not a secret, not "mine".
    assert.ok(!JSON.stringify(hit.body).includes('/r/'), 'the Reader’s link never leaves the Shell');
  });

  test('an Artifact of ours carries a null Client', async () => {
    await pinned(await link(await publish()));
    assert.equal((await delivered()).body['client'], null);
  });

  test('nothing else announces: a withdrawal, a Reader’s flip, a Publisher’s flip', async () => {
    const artifact = await publish();
    const url = await link(artifact);
    const a = await pinned(url);
    await delivered();

    const patch = { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"status":"addressed"}' };
    assert.equal((await fetch(`${url}/annotations/${a.annotation}`, patch)).status, 200);
    assert.equal((await flip(a.annotation, 'open')).status, 200);
    const b = await pinned(url, '第二条');
    assert.equal((await fetch(`${url}/annotations/${b.annotation}`, { method: 'DELETE' })).status, 204);

    await quiet();
    assert.deepEqual(hits.map((h) => h.body['annotation']), [a.annotation, b.annotation], 'only the two pins');
  });

  test('the row is already listed when the POST lands', async () => {
    const url = await link(await publish());
    // Resolved by the receiver itself once it has looked: `delivered()` returns on the hit,
    // which on a slow runner is before the receiver's own GET has come back.
    const listedWhenItLanded = new Promise<string[]>((resolve) => {
      answer = async (res) => {
        resolve((await readerList(url)).map((a) => a.annotation));
        ok(res);
      };
    });
    const a = await pinned(url);

    await delivered();
    assert.deepEqual(await listedWhenItLanded, [a.annotation], 'stored before it was announced');
  });

  test('a receiver that never answers does not hold up the Reader', async () => {
    // The proof of order as much as of speed: were the POST awaited, this pin would never return.
    answer = () => {};
    const url = await link(await publish());
    const started = performance.now();
    await pinned(url);
    assert.ok(performance.now() - started < 1000, 'the 201 does not wait on a 5 s timeout');
    await delivered();
  });

  test('a receiver that refuses is one log line, not a retry', async () => {
    answer = (res) => { res.writeHead(500); res.end('nope'); };
    await pinned(await link(await publish()));
    await delivered();
    await quiet();
    assert.equal(hits.length, 1, 'nothing is queued and nothing is tried again');
  });
});

describe('no MYARTIFACTS_WEBHOOK_URL', () => {
  let bare: Awaited<ReturnType<typeof start>>;
  let bareDir: string;
  let bareToken: string;

  before(async () => {
    bareDir = mkdtempSync(join(tmpdir(), 'myartifacts-'));
    bareToken = mintToken(bareDir, 'alice');
    bare = await start({ dataDir: bareDir, shellPort: 0, usercontentPort: 0 });
  });
  after(async () => {
    await bare.close();
    rmSync(bareDir, { recursive: true, force: true });
  });

  test('nothing is sent', async () => {
    const created = await fetch(`${bare.shellOrigin}/api/artifacts?canvas=1200`, {
      method: 'POST', headers: { 'content-type': 'text/html', authorization: `Bearer ${bareToken}` }, body: '<title>t</title><p>x</p>',
    });
    const { artifact } = (await created.json()) as { artifact: string };
    const reader = await fetch(`${bare.shellOrigin}/api/artifacts/${artifact}/readers`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bareToken}` },
      body: JSON.stringify({ name: '王工' }),
    });
    const { url } = (await reader.json()) as { url: string };
    const res = await fetch(`${url}/annotations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, anchor: ANCHOR, text: '没有人在听' }),
    });
    assert.equal(res.status, 201);
    await quiet();
    assert.equal(hits.length, 0);
  });
});
