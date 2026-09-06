// The stream at the RPC door (spec §10): one SSE event per write to the Artifact's store, filtered
// by the private-subtree rule before it leaves, never stored and never replayed. What the Shell
// does with an event — the subscription table, the re-run, the animation-frame debounce — lives
// in the browser and is asserted in the source we serve, then exercised for real (see the ticket).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { mintToken, start } from '../src/server.ts';

let dir: string;
let server: Awaited<ReturnType<typeof start>>;
let token: string;
const streams: AbortController[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'myartifacts-'));
  token = mintToken(dir, 'alice');
  // A bucket wide enough to be invisible: spec §10's rate limit is a knob, and it has its own tests.
  server = await start({ dataDir: dir, shellPort: 0, usercontentPort: 0, ratePerSecond: 1000, rateBurst: 100000 });
});
after(async () => {
  streams.forEach((c) => c.abort());
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function publish(): Promise<string> {
  const res = await fetch(`${server.shellOrigin}/api/artifacts?canvas=1200`, {
    method: 'POST', headers: { 'content-type': 'text/html', ...auth() }, body: '<title>周五团建投票</title>',
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { artifact: string }).artifact;
}
async function makeReader(artifact: string, name = '王工'): Promise<{ reader: string; url: string }> {
  const res = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { reader: string; url: string };
}
const asPublisher = (artifact: string, body: unknown) =>
  fetch(`${server.shellOrigin}/api/artifacts/${artifact}/db`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify(body),
  });
const asReader = (url: string, body: unknown) =>
  fetch(`${url}/db`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function ok<T>(res: Promise<Response>): Promise<T> {
  const r = await res;
  const text = await r.text();
  assert.equal(r.status, 200, text);
  return JSON.parse(text) as T;
}

type Event = { path: string; doc: Record<string, unknown> | null; version: number; updated_at: string };

/** One open stream: events as they arrive, a way to say "and nothing else came", and its end. */
type Stream = { next: () => Promise<Event>; quiet: () => Promise<void>; closed: () => Promise<void> };

async function openStream(url: string, headers: Record<string, string> = {}): Promise<Stream> {
  const ctl = new AbortController();
  streams.push(ctl);
  const res = await fetch(url, { headers, signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const queue: Event[] = [];
  const waiting: ((e: Event) => void)[] = [];
  let buf = '';
  const { promise: ended, resolve: endStream } = Promise.withResolvers<void>();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return endStream();
      buf += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data) continue; // a comment line — the `:ok` greeting, a heartbeat
        const e = JSON.parse(data) as Event;
        const w = waiting.shift();
        if (w) w(e); else queue.push(e);
      }
    }
  })();
  return {
    next: () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<Event>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no event within 1500 ms')), 1500);
      waiting.push((e) => { clearTimeout(t); resolve(e); });
    }),
    quiet: async () => {
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(queue, [], 'an event arrived that should have been filtered');
    },
    closed: () => Promise.race([ended, new Promise<void>((_, reject) => setTimeout(() => reject(new Error('the stream stayed open')), 1500))]),
  };
}
const readerStream = (url: string) => openStream(`${url}/db/stream`);
const publisherStream = (artifact: string) => openStream(`${server.shellOrigin}/api/artifacts/${artifact}/db/stream`, auth());

describe('the stream’s two mountings', () => {
  test('the same credentials as the door: none is a 401 on one and a 404 on the other', async () => {
    const artifact = await publish();
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/db/stream`)).status, 401);
    assert.equal((await fetch(`${server.shellOrigin}/r/${'x'.repeat(43)}/db/stream`)).status, 404);
  });

  test('a soft-deleted artifact streams on neither', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts/${artifact}`, { method: 'DELETE', headers: auth() })).status, 204);
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/db/stream`, { headers: auth() })).status, 404);
    assert.equal((await fetch(`${reader.url}/db/stream`)).status, 404);
  });
});

describe('a stream that has lost its credential', () => {
  test('revoking a link closes its stream, and only its stream', async () => {
    const artifact = await publish();
    const a = await makeReader(artifact, '王工');
    const b = await makeReader(artifact, '李工');
    const sa = await readerStream(a.url);
    const sb = await readerStream(b.url);
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers/${b.reader}`, { method: 'DELETE', headers: auth() })).status, 204);
    await sb.closed();
    // The other link is untouched, and hears the next write as before.
    await ok(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { text: 'still here' } }));
    assert.deepEqual((await sa.next()).doc, { text: 'still here' });
    // The browser's EventSource reconnects on its own — into the 404 that tells the Shell the link is dead.
    assert.equal((await fetch(`${b.url}/db/stream`)).status, 404);
  });

  test('revoking a token closes that publisher’s streams on every artifact', async () => {
    const res = await fetch(`${server.shellOrigin}/api/tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify({ name: 'bob' }),
    });
    assert.equal(res.status, 201);
    const minted = (await res.json()) as { token: string };
    const artifact = await publish();
    const s = await openStream(`${server.shellOrigin}/api/artifacts/${artifact}/db/stream`, { authorization: `Bearer ${minted.token}` });
    const mine = await publisherStream(artifact);
    assert.equal((await fetch(`${server.shellOrigin}/api/tokens/bob`, { method: 'DELETE', headers: auth() })).status, 204);
    await s.closed();
    await ok(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { text: 'x' } }));
    assert.equal((await mine.next()).path, 'notes/weekly');
  });

  test('soft-deleting the artifact closes every stream on it', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    const sr = await readerStream(reader.url);
    const sp = await publisherStream(artifact);
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts/${artifact}`, { method: 'DELETE', headers: auth() })).status, 204);
    await sr.closed();
    await sp.closed();
  });
});

describe('what a write sends', () => {
  test('every write is one event — set, update, delete — with the document as it now is', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    const s = await readerStream(reader.url);

    await ok(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { text: 'draft' } }));
    const first = await s.next();
    assert.deepEqual({ path: first.path, doc: first.doc, version: first.version }, { path: 'notes/weekly', doc: { text: 'draft' }, version: 1 });
    assert.ok(!Number.isNaN(Date.parse(first.updated_at)));

    await ok(asReader(reader.url, { method: 'update', path: 'notes/weekly', data: { n: 2 } }));
    assert.deepEqual((await s.next()).doc, { text: 'draft', n: 2 });

    await ok(asPublisher(artifact, { method: 'delete', path: 'notes/weekly' }));
    const gone = await s.next();
    assert.equal(gone.doc, null);
    assert.equal(gone.version, 3);
    // Idempotent delete: nothing was written, so nothing is sent.
    await ok(asPublisher(artifact, { method: 'delete', path: 'notes/weekly' }));
    await s.quiet();

    // Recreated, the version climbs on: a snapshot cache keyed on it can never mistake the new
    // body for the one it held before the delete.
    await ok(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { text: 'again' } }));
    const again = await s.next();
    assert.deepEqual({ doc: again.doc, version: again.version }, { doc: { text: 'again' }, version: 4 });
    assert.deepEqual(await ok(asPublisher(artifact, { method: 'get', path: 'notes/weekly' })), { exists: true, data: { text: 'again' }, version: 4 });
    // And the tombstone is invisible to a query, while a sibling is not.
    await ok(asPublisher(artifact, { method: 'delete', path: 'notes/weekly' }));
    await s.next();
    await ok(asPublisher(artifact, { method: 'set', path: 'notes/daily', data: { text: 'd' } }));
    await s.next();
    const { docs } = await ok<{ docs: { id: string }[] }>(asPublisher(artifact, { method: 'query', collection: 'notes' }));
    assert.deepEqual(docs.map((d) => d.id), ['daily']);
  });

  test('nothing is replayed: a stream opened after the write hears nothing of it', async () => {
    const artifact = await publish();
    await ok(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { text: 'before' } }));
    const s = await publisherStream(artifact);
    await s.quiet();
    await ok(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { text: 'after' } }));
    assert.deepEqual((await s.next()).doc, { text: 'after' });
  });

  test('one store per artifact: a write elsewhere is silent here', async () => {
    const artifact = await publish();
    const other = await publish();
    const s = await publisherStream(artifact);
    await ok(asPublisher(other, { method: 'set', path: 'notes/weekly', data: { text: 'x' } }));
    await s.quiet();
  });
});

describe('the private subtree, on the wire', () => {
  test('a private write reaches its owner and nobody else — the publisher included', async () => {
    const artifact = await publish();
    const a = await makeReader(artifact, '王工');
    const b = await makeReader(artifact, '李工');
    const sa = await readerStream(a.url);
    const sb = await readerStream(b.url);
    const sp = await publisherStream(artifact);

    await ok(asReader(a.url, { method: 'set', path: 'data/users/me/vote', data: { choice: '火锅' } }));
    const mine = await sa.next();
    // `me` was resolved before it was sent: the path on the wire is the one the page subscribed to.
    assert.equal(mine.path, `data/users/${a.reader}/vote`);
    assert.deepEqual(mine.doc, { choice: '火锅' });
    await sb.quiet();
    await sp.quiet();

    // A revealed vote is a shared path, and everyone hears it.
    await ok(asReader(a.url, { method: 'set', path: `votes/${a.reader}`, data: { choice: '火锅' } }));
    for (const s of [sa, sb, sp]) assert.equal((await s.next()).path, `votes/${a.reader}`);
  });
});

describe('acquire on the wire', () => {
  test('a grant is announced, a bare renewal is not, and data always is', async () => {
    const artifact = await publish();
    const a = await makeReader(artifact, '王工');
    const b = await makeReader(artifact, '李工');
    const s = await readerStream(b.url);

    await ok(asReader(a.url, { method: 'acquire', path: 'notes/weekly', holder: a.reader, ttlMs: 8000 }));
    assert.equal((await s.next()).version, 1);
    // The editor renewing every few seconds is not news to anyone watching the document.
    await ok(asReader(a.url, { method: 'acquire', path: 'notes/weekly', holder: a.reader, ttlMs: 8000 }));
    await ok(asReader(a.url, { method: 'acquire', path: 'notes/weekly', holder: a.reader, ttlMs: 8000, data: {} }));
    await s.quiet();
    // Carrying a body makes it a write like any other.
    await ok(asReader(a.url, { method: 'acquire', path: 'notes/weekly', holder: a.reader, ttlMs: 8000, data: { by: '王工' } }));
    const carried = await s.next();
    assert.deepEqual(carried.doc, { by: '王工' });
    assert.equal(carried.version, 4, 'the silent renewals still counted as writes');
    // Busy is not a write.
    const busy = await ok<{ acquired: boolean }>(asReader(b.url, { method: 'acquire', path: 'notes/weekly', holder: b.reader }));
    assert.equal(busy.acquired, false);
    await s.quiet();
  });

  test('a lapsed lease taken by someone else is a first grant again', async () => {
    const artifact = await publish();
    const a = await makeReader(artifact, '王工');
    const b = await makeReader(artifact, '李工');
    const s = await publisherStream(artifact);
    await ok(asReader(a.url, { method: 'acquire', path: 'notes/weekly', holder: a.reader, ttlMs: 1 }));
    await s.next();
    await new Promise((r) => setTimeout(r, 1100));
    // Expiry itself sends nothing: the document did not change, the lease just stopped mattering.
    await s.quiet();
    await ok(asReader(b.url, { method: 'acquire', path: 'notes/weekly', holder: b.reader }));
    assert.equal((await s.next()).version, 2);
  });
});

describe('what the browser is handed', () => {
  test('the Shell holds the subscription table and the stream; the runtime holds the snapshots', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    const page = await (await fetch(reader.url)).text();
    assert.ok(page.includes("new EventSource(DB+'/stream')"), 'one stream per view, at the door');
    assert.ok(/es\.onopen=/.test(page) && /for\(const \[sub,s\] of subs\)rerun/.test(page), 'a reconnect reruns every live subscription');
    assert.ok(page.includes('requestAnimationFrame'), 'query re-runs are debounced to a frame');
    assert.ok(/m\.type==='hello'\)\{.*subs\.clear\(\)/.test(page), 'a reload drops the subscriptions with the page');

    const runtime = await (await fetch(`${server.usercontentOrigin(artifact)}/v/1`)).text();
    assert.ok(runtime.includes('subs.size >= 64'), 'the 65th listener is refused');
    assert.ok(runtime.includes("code: 'resource_exhausted'"), 'with the contract’s code');
    assert.ok(runtime.includes('onSnapshot:'), 'and onSnapshot exists at all');
    assert.ok(runtime.includes('if (subs.delete(sub)) post'), 'unsubscribe is idempotent');
  });
});
