// The HTTP seam at the RPC door: one shape, two mountings (spec §10). The Bridge's `call`
// is the same body an agent sends with curl, so everything the page can do is testable here
// without a browser — the runtime that wraps this in `claude.use("db")` is asserted in the
// source we serve, and exercised for real in a browser (see the ticket).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';

import { mintToken, start } from '../src/server.ts';

let dir: string;
let server: Awaited<ReturnType<typeof start>>;
let token: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'myartifacts-'));
  token = mintToken(dir, 'alice');
  // A bucket wide enough to be invisible: spec §10's rate limit is a knob, and it has its own tests.
  server = await start({ dataDir: dir, shellPort: 0, usercontentPort: 0, ratePerSecond: 1000, rateBurst: 100000 });
});
after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function publish(): Promise<string> {
  const res = await fetch(`${server.shellOrigin}/api/artifacts?canvas=1200`, {
    method: 'POST',
    headers: { 'content-type': 'text/html', ...auth() },
    body: '<title>周五团建投票</title>',
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { artifact: string }).artifact;
}

async function makeReader(artifact: string, name = '王工'): Promise<{ reader: string; url: string }> {
  const res = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth() },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { reader: string; url: string };
}

/** The Publisher's door: a token, and the Client scoping every `/api/*` route already has. */
const asPublisher = (artifact: string, body: unknown, t: string | null = token) =>
  fetch(`${server.shellOrigin}/api/artifacts/${artifact}/db`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify(body),
  });
/** The Reader's door: the link is the whole credential (ADR-0002). */
const asReader = (url: string, body: unknown) =>
  fetch(`${url}/db`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

type Doc = { exists: boolean; data?: Record<string, unknown>; version?: number };
type Rows = { docs: { id: string; path: string; data: Record<string, unknown>; version: number }[] };
type Fail = { error: { code: string; message: string } };

/** Every call in these tests goes through here: the body, and the code when it was refused. */
async function call<T>(res: Promise<Response>, expect = 200): Promise<T> {
  const r = await res;
  const text = await r.text();
  assert.equal(r.status, expect, text);
  return JSON.parse(text) as T;
}
const refused = async (res: Promise<Response>, code: string, status = 400): Promise<string> => {
  const body = await call<Fail>(res, status);
  assert.equal(body.error.code, code, JSON.stringify(body));
  return body.error.message;
};

describe('the RPC door', () => {
  test('no credential is a 401 on one door and a 404 on the other', async () => {
    const artifact = await publish();
    assert.equal((await asPublisher(artifact, { method: 'get', path: 'a/b' }, null)).status, 401);
    // A Reader door is a secret in a URL: a wrong one is indistinguishable from a revoked one.
    assert.equal((await asReader(`${server.shellOrigin}/r/${'x'.repeat(43)}`, { method: 'get', path: 'a/b' })).status, 404);
  });

  test('an artifact nobody may see has no door', async () => {
    assert.equal((await asPublisher('0'.repeat(32), { method: 'get', path: 'a/b' })).status, 404);
  });

  test('a client token cannot reach another client’s store', async () => {
    const artifact = await publish(); // internal token, no client
    const minted = await call<{ token: string }>(
      fetch(`${server.shellOrigin}/api/tokens`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...auth() },
        body: JSON.stringify({ name: 'acme-designer', client: 'acme' }),
      }),
      201,
    );
    assert.equal((await asPublisher(artifact, { method: 'get', path: 'a/b' }, minted.token)).status, 404);
  });

  test('an unknown method is a method this runtime does not serve', async () => {
    const artifact = await publish();
    await refused(asPublisher(artifact, { method: 'truncate', path: 'a/b' }), 'capability_removed');
  });
});

describe('get / set / update / delete', () => {
  test('set writes the whole document and get reads it back, version climbing on every write', async () => {
    const artifact = await publish();
    assert.deepEqual(await call<Doc>(asPublisher(artifact, { method: 'get', path: 'notes/weekly' })), { exists: false });

    await call(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { text: 'draft', n: 1 } }));
    const first = await call<Doc>(asPublisher(artifact, { method: 'get', path: 'notes/weekly' }));
    assert.deepEqual(first, { exists: true, data: { text: 'draft', n: 1 }, version: 1 });

    // A full replace, Firestore-style: the field that is not in the body is gone.
    await call(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { text: 'final' } }));
    assert.deepEqual(await call<Doc>(asPublisher(artifact, { method: 'get', path: 'notes/weekly' })), {
      exists: true, data: { text: 'final' }, version: 2,
    });
  });

  test('update merges into an existing document, and refuses to create one', async () => {
    const artifact = await publish();
    await refused(asPublisher(artifact, { method: 'update', path: 'notes/weekly', data: { text: 'x' } }), 'invalid_argument');

    await call(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { by: { name: '王工', seat: 3 }, tags: ['a', 'b'] } }));
    await call(asPublisher(artifact, { method: 'update', path: 'notes/weekly', data: { by: { seat: 4 }, tags: ['c'] } }));
    // Nested objects merge recursively; anything else — arrays included — replaces wholesale.
    assert.deepEqual((await call<Doc>(asPublisher(artifact, { method: 'get', path: 'notes/weekly' }))).data, {
      by: { name: '王工', seat: 4 }, tags: ['c'],
    });
  });

  test('delete is idempotent and does not cascade', async () => {
    const artifact = await publish();
    await call(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { text: 'x' } }));
    await call(asPublisher(artifact, { method: 'set', path: 'notes/weekly/lines/l1', data: { text: 'nested' } }));
    await call(asPublisher(artifact, { method: 'delete', path: 'notes/weekly' }));
    await call(asPublisher(artifact, { method: 'delete', path: 'notes/weekly' }));
    assert.equal((await call<Doc>(asPublisher(artifact, { method: 'get', path: 'notes/weekly' }))).exists, false);
    assert.equal((await call<Doc>(asPublisher(artifact, { method: 'get', path: 'notes/weekly/lines/l1' }))).exists, true);
  });

  test('a document body is a JSON object, and nothing else', async () => {
    const artifact = await publish();
    for (const data of [['a'], 'text', 7, null, undefined]) {
      await refused(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data }), 'invalid_argument');
    }
  });

  test('a `__proto__` key is data nobody merges, here or anywhere else in the process', async () => {
    const artifact = await publish();
    await call(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { text: 'x' } }));
    // `JSON.parse` makes this an ordinary own key; assigning it would write through to a prototype.
    const poison = JSON.parse('{"__proto__":{"polluted":true},"text":"y"}') as Record<string, unknown>;
    await call(asPublisher(artifact, { method: 'update', path: 'notes/weekly', data: poison }));
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'no object in this process grew a field');
    assert.deepEqual((await call<Doc>(asPublisher(artifact, { method: 'get', path: 'notes/weekly' }))).data, { text: 'y' });
  });

  test('a path that is not a document path is refused where the runtime cannot catch it', async () => {
    const artifact = await publish();
    // The runtime throws a TypeError on these synchronously; the door is what an agent's curl hits.
    for (const path of ['notes', 'notes/weekly/lines', '', 'notes//weekly', 'notes/../weekly', 'notes/we ekly']) {
      await refused(asPublisher(artifact, { method: 'get', path }), 'invalid_argument');
    }
  });
});

describe('query', () => {
  const seed = async (artifact: string) => {
    for (const [id, data] of [
      ['t1', { title: 'b', done: false, n: 2, tags: ['x'] }],
      ['t2', { title: 'a', done: true, n: 1, tags: ['x', 'y'] }],
      ['t3', { title: 'c', done: false, n: 3, tags: [] }],
      ['t4', { done: false, n: 4, tags: ['y'] }],
    ] as const) {
      await call(asPublisher(artifact, { method: 'set', path: `tasks/${id}`, data }));
    }
  };

  test('a collection reads back in document-id order, with only its own documents', async () => {
    const artifact = await publish();
    await seed(artifact);
    await call(asPublisher(artifact, { method: 'set', path: 'tasks/t1/notes/n1', data: { deeper: true } }));
    const { docs } = await call<Rows>(asPublisher(artifact, { method: 'query', collection: 'tasks' }));
    assert.deepEqual(docs.map((d) => d.id), ['t1', 't2', 't3', 't4']);
    assert.deepEqual(docs[0]?.data, { title: 'b', done: false, n: 2, tags: ['x'] });
  });

  test('the nine operators filter on top-level fields', async () => {
    const artifact = await publish();
    await seed(artifact);
    const ids = async (where: unknown[][]) =>
      (await call<Rows>(asPublisher(artifact, { method: 'query', collection: 'tasks', where }))).docs.map((d) => d.id);
    assert.deepEqual(await ids([['done', '==', false]]), ['t1', 't3', 't4']);
    assert.deepEqual(await ids([['done', '!=', false]]), ['t2']);
    assert.deepEqual(await ids([['n', '<', 2]]), ['t2']);
    assert.deepEqual(await ids([['n', '<=', 2]]), ['t1', 't2']);
    assert.deepEqual(await ids([['n', '>', 3]]), ['t4']);
    assert.deepEqual(await ids([['n', '>=', 3]]), ['t3', 't4']);
    assert.deepEqual(await ids([['title', 'in', ['a', 'c']]]), ['t2', 't3']);
    assert.deepEqual(await ids([['title', 'not-in', ['a', 'c']]]), ['t1']);
    assert.deepEqual(await ids([['tags', 'array-contains', 'y']]), ['t2', 't4']);
    assert.deepEqual(await ids([['done', '==', false], ['n', '>', 2]]), ['t3', 't4']);
    await refused(asPublisher(artifact, { method: 'query', collection: 'tasks', where: [['n', '~', 1]] }), 'invalid_argument');
  });

  test('orderBy takes one field, and documents missing it sort last', async () => {
    const artifact = await publish();
    await seed(artifact);
    const ids = async (orderBy: unknown, limit?: number) =>
      (await call<Rows>(asPublisher(artifact, { method: 'query', collection: 'tasks', orderBy, limit }))).docs.map((d) => d.id);
    assert.deepEqual(await ids(['title', 'asc']), ['t2', 't1', 't3', 't4']);
    assert.deepEqual(await ids(['title', 'desc']), ['t3', 't1', 't2', 't4']);
    assert.deepEqual(await ids(['n', 'asc'], 2), ['t2', 't1']);
  });

  test('the query caps are the contract’s: ten filters, a page of 1–1000', async () => {
    const artifact = await publish();
    const where = Array.from({ length: 11 }, () => ['n', '>', 0]);
    await refused(asPublisher(artifact, { method: 'query', collection: 'tasks', where }), 'invalid_argument');
    await refused(asPublisher(artifact, { method: 'query', collection: 'tasks', limit: 0 }), 'invalid_argument');
    await refused(asPublisher(artifact, { method: 'query', collection: 'tasks', limit: 1001 }), 'invalid_argument');
    await call(asPublisher(artifact, { method: 'query', collection: 'tasks', limit: 1000 }));
  });

  test('a collection path has an odd number of segments', async () => {
    const artifact = await publish();
    await refused(asPublisher(artifact, { method: 'query', collection: 'tasks/t1' }), 'invalid_argument');
  });
});

describe('the private subtree', () => {
  test('`me` becomes the caller, on both doors', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    await call(asReader(reader.url, { method: 'set', path: 'data/users/me/vote', data: { choice: '火锅' } }));
    // The same document under the id the page would get from `user.id()`.
    assert.deepEqual((await call<Doc>(asReader(reader.url, { method: 'get', path: `data/users/${reader.reader}/vote` }))).data, { choice: '火锅' });
    // The Publisher's `me` is the token's name, so the two callers do not collide.
    await call(asPublisher(artifact, { method: 'set', path: 'data/users/me/vote', data: { choice: '日料' } }));
    assert.deepEqual((await call<Doc>(asPublisher(artifact, { method: 'get', path: 'data/users/alice/vote' }))).data, { choice: '日料' });
    assert.deepEqual((await call<Doc>(asReader(reader.url, { method: 'get', path: 'data/users/me/vote' }))).data, { choice: '火锅' });
  });

  test('another reader’s subtree does not exist, and cannot be written', async () => {
    const artifact = await publish();
    const a = await makeReader(artifact, '王工');
    const b = await makeReader(artifact, '李工');
    await call(asReader(a.url, { method: 'set', path: 'data/users/me/vote', data: { choice: '火锅' } }));

    assert.deepEqual(await call<Doc>(asReader(b.url, { method: 'get', path: `data/users/${a.reader}/vote` })), { exists: false });
    for (const method of ['set', 'update', 'delete']) {
      await refused(asReader(b.url, { method, path: `data/users/${a.reader}/vote`, data: { choice: '烧烤' } }), 'invalid_argument');
    }
    // The write that was refused changed nothing.
    assert.deepEqual((await call<Doc>(asReader(a.url, { method: 'get', path: 'data/users/me/vote' }))).data, { choice: '火锅' });
  });

  test('the publisher cannot see through it either — that is what makes a sealed vote sealed', async () => {
    const artifact = await publish();
    const a = await makeReader(artifact);
    await call(asReader(a.url, { method: 'set', path: 'data/users/me/vote', data: { choice: '火锅' } }));
    assert.deepEqual(await call<Doc>(asPublisher(artifact, { method: 'get', path: `data/users/${a.reader}/vote` })), { exists: false });
    await refused(asPublisher(artifact, { method: 'set', path: `data/users/${a.reader}/vote`, data: { choice: '烧烤' } }), 'invalid_argument');
  });

  test('a query omits what the caller cannot see', async () => {
    const artifact = await publish();
    const a = await makeReader(artifact, '王工');
    const b = await makeReader(artifact, '李工');
    await call(asReader(a.url, { method: 'set', path: 'data/users/me/vote', data: { choice: '火锅' } }));
    await call(asReader(b.url, { method: 'set', path: 'data/users/me/vote', data: { choice: '烧烤' } }));

    const mine = await call<Rows>(asReader(a.url, { method: 'query', collection: `data/users/${a.reader}` }));
    assert.deepEqual(mine.docs.map((d) => d.data), [{ choice: '火锅' }]);
    assert.deepEqual((await call<Rows>(asReader(a.url, { method: 'query', collection: `data/users/${b.reader}` }))).docs, []);
  });

  test('a shared path is shared: it is where a revealed vote goes', async () => {
    const artifact = await publish();
    const a = await makeReader(artifact, '王工');
    const b = await makeReader(artifact, '李工');
    await call(asReader(a.url, { method: 'set', path: `votes/${a.reader}`, data: { choice: '火锅' } }));
    assert.deepEqual((await call<Doc>(asReader(b.url, { method: 'get', path: `votes/${a.reader}` }))).data, { choice: '火锅' });
    assert.equal((await call<Rows>(asPublisher(artifact, { method: 'query', collection: 'votes' }))).docs.length, 1);
  });
});

describe('acquire', () => {
  test('the first caller holds it, the second is told only when it frees up', async () => {
    const artifact = await publish();
    const a = await makeReader(artifact, '王工');
    const b = await makeReader(artifact, '李工');

    const granted = await call<{ acquired: boolean; version: number; expiresAt: string; holder: string }>(
      asReader(a.url, { method: 'acquire', path: 'notes/weekly', holder: a.reader, ttlMs: 8000 }),
    );
    assert.equal(granted.acquired, true);
    assert.equal(granted.holder, a.reader);
    assert.ok(Date.parse(granted.expiresAt) > Date.now());

    const busy = await call<{ acquired: boolean; expiresAt: string; holder?: string }>(
      asReader(b.url, { method: 'acquire', path: 'notes/weekly', holder: b.reader }),
    );
    assert.equal(busy.acquired, false);
    assert.equal(busy.holder, undefined, 'the platform reveals when, never who');
    assert.equal(busy.expiresAt, granted.expiresAt);

    // Renewal is the same holder asking again, and it is a write like any other.
    const renewed = await call<{ acquired: boolean; version: number }>(
      asReader(a.url, { method: 'acquire', path: 'notes/weekly', holder: a.reader, ttlMs: 8000 }),
    );
    assert.equal(renewed.acquired, true);
    assert.equal(renewed.version, granted.version + 1);
  });

  test('a lapsed lease is free, and `data` merges only when the lease is granted', async () => {
    const artifact = await publish();
    const a = await makeReader(artifact, '王工');
    const b = await makeReader(artifact, '李工');
    // Below the contract's floor, so it is clamped to 1 s rather than refused… and 0 means 30 s.
    await call(asReader(a.url, { method: 'acquire', path: 'notes/weekly', holder: a.reader, ttlMs: 1 }));
    await new Promise((r) => setTimeout(r, 1100));
    const after = await call<{ acquired: boolean }>(
      asReader(b.url, { method: 'acquire', path: 'notes/weekly', holder: b.reader, data: { by: '李工' } }),
    );
    assert.equal(after.acquired, true);
    assert.deepEqual((await call<Doc>(asReader(a.url, { method: 'get', path: 'notes/weekly' }))).data, { by: '李工' });
    await refused(asReader(a.url, { method: 'acquire', path: 'notes/weekly' }), 'invalid_argument');
  });
});

describe('who a caller is', () => {
  test('a token may not be named like a reader id — both are identities in one store', async () => {
    const res = await fetch(`${server.shellOrigin}/api/tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth() },
      body: JSON.stringify({ name: 'a'.repeat(32) }),
    });
    const text = await res.text();
    assert.equal(res.status, 400, text);
    // Because if it were allowed, `data/users/me` under that token would resolve into the
    // subtree of the Reader with that id — the one place a Publisher is not allowed to look.
    assert.equal((JSON.parse(text) as Fail).error.code, 'invalid_argument');
  });

  test('an identity that is not one path segment simply has no subtree', async () => {
    const artifact = await publish();
    const odd = await call<{ token: string }>(
      fetch(`${server.shellOrigin}/api/tokens`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...auth() },
        body: JSON.stringify({ name: '客户 A / 王工' }),
      }),
      201,
    );
    // A token name is free text; spliced into a path it need not be legal, and nothing is stored.
    await refused(asPublisher(artifact, { method: 'set', path: 'data/users/me/vote', data: { x: 1 } }, odd.token), 'invalid_argument');
    await refused(asPublisher(artifact, { method: 'query', collection: 'data/users/me' }, odd.token), 'invalid_argument');
    // Everything outside the prefix is untouched: this is about `me`, not about the token.
    await call(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { x: 1 } }, odd.token));
  });
});

describe('the store’s reach', () => {
  test('one store per artifact, seen the same through both doors', async () => {
    const artifact = await publish();
    const other = await publish();
    const reader = await makeReader(artifact);
    await call(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { text: 'seeded by the agent' } }));
    assert.deepEqual((await call<Doc>(asReader(reader.url, { method: 'get', path: 'notes/weekly' }))).data, { text: 'seeded by the agent' });
    // A second Artifact is a second store: same path, nothing there.
    assert.equal((await call<Doc>(asPublisher(other, { method: 'get', path: 'notes/weekly' }))).exists, false);
  });

  test('a new version does not touch the store', async () => {
    const artifact = await publish();
    await call(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { text: 'kept' } }));
    const res = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/versions?canvas=1200`, {
      method: 'POST', headers: { 'content-type': 'text/html', ...auth() }, body: '<title>v2</title>',
    });
    assert.equal(res.status, 201);
    assert.deepEqual((await call<Doc>(asPublisher(artifact, { method: 'get', path: 'notes/weekly' }))).data, { text: 'kept' });
  });

  test('a soft-deleted artifact keeps every document and answers on neither door', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    await call(asPublisher(artifact, { method: 'set', path: 'notes/weekly', data: { text: 'kept' } }));
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts/${artifact}`, { method: 'DELETE', headers: auth() })).status, 204);

    assert.equal((await asPublisher(artifact, { method: 'get', path: 'notes/weekly' })).status, 404);
    assert.equal((await asReader(reader.url, { method: 'get', path: 'notes/weekly' })).status, 404);
    // Nothing on the box is deleted (ADR-0006): the rows are where they were.
    const db = new DatabaseSync(join(dir, 'myartifacts.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT path, json FROM docs WHERE artifact = ?').all(artifact) as { path: string; json: string }[];
      assert.deepEqual(rows.map((r) => ({ path: r.path, json: r.json })), [{ path: 'notes/weekly', json: '{"text":"kept"}' }]);
    } finally {
      db.close();
    }
  });
});

describe('what the page is handed', () => {
  test('every artifact is offered the same four capabilities, declared by nobody', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    const page = await (await fetch(reader.url)).text();
    const ready = JSON.parse(/READY\s*=\s*(\{.*?\})[,;]/.exec(page)?.[1] ?? 'null') as { caps: string[] };
    assert.deepEqual(ready.caps, ['db', 'user', 'downloads', 'artifact']);
    // The Shell makes the call; the page's own origin still has no network of its own. The door is
    // one path under the caller's own mount, which is what the Shell page is handed.
    assert.ok(page.includes(`MOUNT=${JSON.stringify(reader.url)}`), 'the reader page carries its own door');

    const preview = await (await fetch(`${server.shellOrigin}/a/${artifact}/v/1`, { headers: auth() })).text();
    assert.ok(preview.includes(`MOUNT=${JSON.stringify(`${server.shellOrigin}/api/artifacts/${artifact}`)}`), 'and the publisher theirs');
  });

  test('a link that died under a running page is `revoked`, not a code the contract lacks', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    const page = await (await fetch(reader.url)).text();
    const onCall = page.slice(page.indexOf('async function onCall'), page.indexOf('// --- annotation layer'));
    assert.ok(/r\.status===404\|\|r\.status===401/.test(onCall), onCall);
    assert.ok(onCall.includes("code:'revoked'"), onCall);
    // The door itself still 404s; it is the Shell that speaks the page's language.
    assert.equal((await asReader(reader.url + 'x', { method: 'get', path: 'a/b' })).status, 404);
  });

  test('the runtime resolves a name the Shell does not offer to null, and freezes what it hands back', async () => {
    const artifact = await publish();
    const runtime = await (await fetch(`${server.usercontentOrigin(artifact)}/v/1`)).text();
    assert.ok(runtime.includes('caps.includes(key)'), 'a name outside caps is null');
    assert.ok(runtime.includes('setTimeout(() => r(null), 10000)'), 'a Shell that never answers is null after ten seconds');
    assert.ok(runtime.includes('if (!memo.has(key)) memo.set(key'), 'the same name yields the same promise');
    assert.ok(/window\.claude\s*=\s*Object\.freeze/.test(runtime), 'window.claude carries `use` and nothing else');
  });
});
