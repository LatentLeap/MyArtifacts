// Spec §10's quota table, at the HTTP seam: what a document may weigh, how many an Artifact may
// hold, and how fast one identity may call. The bucket is the reason the seam has to be HTTP —
// the only way to show two identities are separate is to be both of them.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';

import { mintToken, start } from '../src/server.ts';

type Box = { dir: string; server: Awaited<ReturnType<typeof start>>; token: string };
type Fail = { error: { code: string; message: string } };

const boxes: Box[] = [];
/** A whole system, with whatever bucket the test needs. Restarting one is a test of its own. */
async function boot(rate?: { ratePerSecond: number; rateBurst: number }): Promise<Box> {
  const dir = mkdtempSync(join(tmpdir(), 'myartifacts-'));
  const token = mintToken(dir, 'alice');
  const box: Box = { dir, token, server: await start({ dataDir: dir, shellPort: 0, usercontentPort: 0, ...rate }) };
  boxes.push(box);
  return box;
}

// One box whose bucket is large enough to be invisible, for the document caps; one small enough
// to empty by hand, for the rate limit. The second exists because the bucket is a config knob.
let roomy: Box;
let strict: Box;

before(async () => {
  roomy = await boot({ ratePerSecond: 1000, rateBurst: 100000 });
  strict = await boot({ ratePerSecond: 0, rateBurst: 10 });
});
after(async () => {
  for (const b of boxes) {
    await b.server.close();
    rmSync(b.dir, { recursive: true, force: true });
  }
});

const auth = (b: Box, t = b.token) => ({ authorization: `Bearer ${t}` });
const PAGE = '<title>周五团建投票</title><div id="app"></div>';

async function publish(b: Box): Promise<string> {
  const res = await fetch(`${b.server.shellOrigin}/api/artifacts?canvas=1200`, {
    method: 'POST', headers: { 'content-type': 'text/html', ...auth(b) }, body: PAGE,
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { artifact: string }).artifact;
}
async function makeReader(b: Box, artifact: string, name = '王工'): Promise<{ reader: string; url: string }> {
  const res = await fetch(`${b.server.shellOrigin}/api/artifacts/${artifact}/readers`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth(b) }, body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { reader: string; url: string };
}
async function anotherToken(b: Box, name: string): Promise<string> {
  const res = await fetch(`${b.server.shellOrigin}/api/tokens`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth(b) }, body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { token: string }).token;
}

const asPublisher = (b: Box, artifact: string, body: unknown, t = b.token) =>
  fetch(`${b.server.shellOrigin}/api/artifacts/${artifact}/db`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth(b, t) }, body: JSON.stringify(body),
  });
const asReader = (url: string, body: unknown) =>
  fetch(`${url}/db`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
/** A page publishing itself: the Version it is running, and nothing else to say. */
const fromPage = (url: string, base: number, headers: Record<string, string> = {}) =>
  fetch(`${url}/versions?base=${base}`, { method: 'POST', headers: { 'content-type': 'text/html', ...headers }, body: PAGE });

async function refused(res: Promise<Response> | Response, code: string, status: number): Promise<void> {
  const r = await res;
  const body = (await r.json()) as Fail;
  assert.equal(body.error.code, code, JSON.stringify(body));
  assert.equal(r.status, status);
}
const ok = async (res: Promise<Response> | Response): Promise<void> => assert.equal((await res).status, 200);

describe('what one document may be', () => {
  test('256 KiB of stored JSON, to the byte', async () => {
    const artifact = await publish(roomy);
    // `{"t":"…"}` is eight bytes of envelope around the string.
    const at = { t: 'x'.repeat(256 * 1024 - 8) };
    await ok(asPublisher(roomy, artifact, { method: 'set', path: 'notes/big', data: at }));
    await refused(
      asPublisher(roomy, artifact, { method: 'set', path: 'notes/bigger', data: { t: `${at.t}y` } }),
      'invalid_argument', 400,
    );
  });

  test('a merge is measured after it merges, not before', async () => {
    const artifact = await publish(roomy);
    const half = 'x'.repeat(128 * 1024);
    await ok(asPublisher(roomy, artifact, { method: 'set', path: 'notes/grow', data: { a: half } }));
    // Each half fits; the document they make does not.
    await refused(
      asPublisher(roomy, artifact, { method: 'update', path: 'notes/grow', data: { b: half } }),
      'invalid_argument', 400,
    );
  });

  test('32 levels, and not one more', async () => {
    const artifact = await publish(roomy);
    const nest = (n: number): Record<string, unknown> => {
      let v: Record<string, unknown> = {};
      for (let i = 1; i < n; i++) v = { v };
      return v;
    };
    await ok(asPublisher(roomy, artifact, { method: 'set', path: 'notes/deep', data: nest(32) }));
    await refused(asPublisher(roomy, artifact, { method: 'set', path: 'notes/deeper', data: nest(33) }), 'invalid_argument', 400);
    // Arrays are levels too — a page nesting them is nesting.
    await refused(
      asPublisher(roomy, artifact, { method: 'set', path: 'notes/arr', data: { v: JSON.parse('[[[['.repeat(8) + ']]]]'.repeat(8)) } }),
      'invalid_argument', 400,
    );
  });

  test('every verb that writes a body is held to the same shape', async () => {
    const artifact = await publish(roomy);
    const deep = (() => { let v: Record<string, unknown> = {}; for (let i = 1; i < 40; i++) v = { v }; return v; })();
    await ok(asPublisher(roomy, artifact, { method: 'set', path: 'notes/shape', data: { n: 1 } }));
    await refused(asPublisher(roomy, artifact, { method: 'update', path: 'notes/shape', data: deep }), 'invalid_argument', 400);
    await refused(
      asPublisher(roomy, artifact, { method: 'acquire', path: 'notes/shape', holder: 'w1', data: deep }),
      'invalid_argument', 400,
    );
  });
});

describe('how many documents one artifact may hold', () => {
  /**
   * 4,999 rows straight into the store. The cap itself is the spec's 5,000 and not a knob, so the
   * fixture is the only way to stand at the edge of it without five thousand round trips; every
   * assertion below still goes in and out over HTTP.
   */
  function seed(box: Box, artifact: string, n: number): void {
    const db = new DatabaseSync(join(box.dir, 'myartifacts.db'));
    try {
      db.exec('BEGIN');
      const put = db.prepare(
        'INSERT INTO docs (artifact, path, collection, json, version, updated_at, updated_by)' +
          " VALUES (?, ?, 'bulk', '{}', 1, '2026-09-03T00:00:00.000Z', 'alice')",
      );
      for (let i = 0; i < n; i++) put.run(artifact, `bulk/d${i}`);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
  }

  test('the 5,000th is written and the 5,001st is not', async () => {
    const artifact = await publish(roomy);
    const other = await publish(roomy);
    seed(roomy, artifact, 4999);

    await ok(asPublisher(roomy, artifact, { method: 'set', path: 'bulk/last', data: { n: 5000 } }));
    await refused(asPublisher(roomy, artifact, { method: 'set', path: 'bulk/over', data: { n: 5001 } }), 'quota_exceeded', 429);
    // Acquiring a lease creates a document too, and is refused for the same reason.
    await refused(
      asPublisher(roomy, artifact, { method: 'acquire', path: 'bulk/lease', holder: 'w1' }),
      'quota_exceeded', 429,
    );
    // Rewriting one already there costs nothing: the cap is on creating.
    await ok(asPublisher(roomy, artifact, { method: 'set', path: 'bulk/last', data: { n: 5000, again: true } }));
    // And it is per Artifact, not per box.
    await ok(asPublisher(roomy, other, { method: 'set', path: 'bulk/first', data: { n: 1 } }));

    // A deleted document keeps its row and gives back its slot.
    await ok(asPublisher(roomy, artifact, { method: 'delete', path: 'bulk/d0' }));
    await ok(asPublisher(roomy, artifact, { method: 'set', path: 'bulk/over', data: { n: 5000 } }));
  });
});

describe('how fast one identity may call', () => {
  test('the bucket empties, and refills for nobody else', async () => {
    const artifact = await publish(strict);
    const a = await makeReader(strict, artifact, '王工');
    const b = await makeReader(strict, artifact, '李工');

    for (let i = 0; i < 10; i++) await ok(asReader(a.url, { method: 'get', path: 'notes/weekly' }));
    await refused(asReader(a.url, { method: 'get', path: 'notes/weekly' }), 'resource_exhausted', 429);
    // The other Reader is a different identity and has spent nothing.
    await ok(asReader(b.url, { method: 'get', path: 'notes/weekly' }));
  });

  test('a token is an identity of its own', async () => {
    const artifact = await publish(strict);
    const mine = await anotherToken(strict, 'bob');
    const theirs = await anotherToken(strict, 'carol');

    for (let i = 0; i < 10; i++) await ok(asPublisher(strict, artifact, { method: 'get', path: 'notes/weekly' }, mine));
    await refused(asPublisher(strict, artifact, { method: 'get', path: 'notes/weekly' }, mine), 'resource_exhausted', 429);
    await ok(asPublisher(strict, artifact, { method: 'get', path: 'notes/weekly' }, theirs));
  });

  test('a page publish is ten calls, out of the same bucket', async () => {
    const artifact = await publish(strict);
    const r = await makeReader(strict, artifact, '张工');

    assert.equal((await fromPage(r.url, 1)).status, 201);
    // Ten of ten spent: the next publish, and the next db call, are both out of budget.
    await refused(fromPage(r.url, 2), 'rate_limited', 429);
    await refused(asReader(r.url, { method: 'get', path: 'notes/weekly' }), 'resource_exhausted', 429);
  });

  test('an agent publishing is not a page publishing', async () => {
    // No `?base=`, so no view is calling, and spec §10 puts the weight on the page's publish only.
    const artifact = await publish(strict);
    const mine = await anotherToken(strict, 'dave');
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${strict.server.shellOrigin}/api/artifacts/${artifact}/versions?canvas=1200`, {
        method: 'POST', headers: { 'content-type': 'text/html', ...auth(strict, mine) }, body: PAGE,
      });
      assert.equal(res.status, 201);
    }
  });

  test('a Reader minting Version after Version is stopped by revocation, not by a disk quota', async () => {
    // Spec §10: nothing caps what a Reader's publishes cost on disk; the operator revokes the link.
    const box = await boot({ ratePerSecond: 1000, rateBurst: 1000 });
    const artifact = await publish(box);
    const r = await makeReader(box, artifact, '王工');

    for (let n = 1; n <= 5; n++) assert.equal((await fromPage(r.url, n)).status, 201);

    assert.equal(
      (await fetch(`${box.server.shellOrigin}/api/artifacts/${artifact}/readers/${r.reader}`, {
        method: 'DELETE', headers: auth(box),
      })).status,
      204,
    );
    assert.equal((await fromPage(r.url, 6)).status, 404);
    assert.equal((await asReader(r.url, { method: 'set', path: 'notes/weekly', data: { t: 'x' } })).status, 404);
  });

  test('a refusal that is about the moment does not end a subscription', async () => {
    // The Shell re-runs every query subscription through the same metered door, and a reconnect
    // re-runs all of them at once — so an empty bucket has to be waited out, not treated as the
    // end of the listener. `end` is at most once (spec §9); spending it here would be permanent.
    const artifact = await publish(strict);
    const r = await makeReader(strict, artifact, '陈工');
    const page = await (await fetch(r.url)).text();
    const rerun = page.slice(page.indexOf('function rerun('), page.indexOf('function stream('));
    assert.ok(/TRANSIENT\s*=\s*\{resource_exhausted:1,unavailable:1\}/.test(page), page.slice(0, 200));
    assert.ok(rerun.includes('if(!TRANSIENT[r.error.code])return end(sub,r.error)'), rerun);
    assert.ok(/setTimeout\(\(\)=>\{if\(subs\.get\(sub\)===s\)rerun\(sub,s\);?\}/.test(rerun), rerun);
  });

  test('a restart is an amnesty: the bucket is in the process, not on disk', async () => {
    const box = await boot({ ratePerSecond: 0, rateBurst: 2 });
    const artifact = await publish(box);
    const r = await makeReader(box, artifact, '王工');

    await ok(asReader(r.url, { method: 'get', path: 'notes/weekly' }));
    await ok(asReader(r.url, { method: 'get', path: 'notes/weekly' }));
    await refused(asReader(r.url, { method: 'get', path: 'notes/weekly' }), 'resource_exhausted', 429);

    // The same data directory, the same link, a new process's worth of buckets. A fresh port so
    // the assertion is about the bucket and not about a keep-alive socket the old one took with it.
    const secret = r.url.split('/r/')[1];
    await box.server.close();
    box.server = await start({ dataDir: box.dir, shellPort: 0, usercontentPort: 0, ratePerSecond: 0, rateBurst: 2 });
    await ok(asReader(`${box.server.shellOrigin}/r/${secret}`, { method: 'get', path: 'notes/weekly' }));
  });
});

describe('the caps a page hears before the door does', () => {
  test('the runtime refuses an eleventh filter and a page outside 1–1000 itself', async () => {
    // Spec §10 puts the query caps in the runtime *and* the server. The server is the one that
    // has to say no; the runtime says it first, with the same code and no round trip.
    const artifact = await publish(roomy);
    const runtime = await (await fetch(`${roomy.server.usercontentOrigin(artifact)}/v/1`)).text();
    assert.ok(runtime.includes("q.where.length > 10 ? 'at most ten filters'"), 'ten filters');
    assert.ok(runtime.includes("q.limit > 1000) ? 'limit is 1–1000'"), 'a page of 1–1000');
    assert.ok(runtime.includes("refuse({ code: 'invalid_argument', message: over })"), 'and it is the contract’s code');

    // The door still refuses on its own: the runtime is a courtesy, not the enforcement.
    await refused(
      asPublisher(roomy, artifact, { method: 'query', collection: 'tasks', limit: 1001 }),
      'invalid_argument', 400,
    );
  });
});
