// A page publishing itself (spec §9): the same two mounts as the db door, `?base=N` in front of
// them, and one push on the stream when a Version lands. What the page sees — the reload, the
// `conflict` that follows the winner — is the browser's, and the lines that carry it are asserted
// in the source we serve, then run for real (see the ticket).
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
type Detail = {
  pinned: number | null;
  versions: { version: number; canvas: number; title: string | null; published_by: string }[];
};
type GalleryRow = { artifact: string; latest: number; last_published_by: string };
type Published = { artifact: string; version: number; canvas: number; title: string | null };
type Refusal = { error: { code: string; message: string }; live?: string };

const PAGE = '<title>周五团建投票</title><div id="app"></div>';

async function publish(canvas = '1200'): Promise<string> {
  const res = await fetch(`${server.shellOrigin}/api/artifacts?canvas=${canvas}`, {
    method: 'POST', headers: { 'content-type': 'text/html', ...auth() }, body: PAGE,
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as Published).artifact;
}
async function makeReader(artifact: string, name = '王工'): Promise<{ reader: string; url: string }> {
  const res = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { reader: string; url: string };
}
/** A door a page publishes through, with whatever credential that door takes. */
type Mount = { url: string; headers: Record<string, string> };
const readerMount = (url: string): Mount => ({ url, headers: {} });
const publisherMount = (artifact: string): Mount => ({ url: `${server.shellOrigin}/api/artifacts/${artifact}`, headers: auth() });
/** A publish the way the Shell makes one: the page's bytes, against the Version the view is running. */
const fromPage = (mount: Mount, base: number | null, body: string | Uint8Array = PAGE, extra = '') =>
  fetch(`${mount.url}/versions?${base === null ? '' : `base=${base}`}${extra}`, {
    method: 'POST', headers: { 'content-type': 'text/html', ...mount.headers }, body,
  });
/** A publish the way an agent makes one: a declared Canvas, no Version to compare against. */
const asAgent = (artifact: string, body = PAGE, canvas = '1200') =>
  fetch(`${server.shellOrigin}/api/artifacts/${artifact}/versions?canvas=${canvas}`, {
    method: 'POST', headers: { 'content-type': 'text/html', ...auth() }, body,
  });
const freeze = (artifact: string, version: number | null) =>
  fetch(`${server.shellOrigin}/api/artifacts/${artifact}/pinned`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify({ version }),
  });
const detail = async (artifact: string) =>
  (await (await fetch(`${server.shellOrigin}/api/artifacts/${artifact}`, { headers: auth() })).json()) as Detail;
const gallery = async () =>
  (await (await fetch(`${server.shellOrigin}/api/artifacts`, { headers: auth() })).json()) as GalleryRow[];
/** Which Version a Shell page is framing. */
const framedVersion = async (url: string): Promise<number> =>
  Number(/\/v\/(\d+)"/.exec(await (await fetch(url)).text())?.[1]);

describe('?base= on both mounts', () => {
  test('a page publish mints the next Version and inherits the Canvas of the one it ran', async () => {
    const artifact = await publish('900');
    const reader = await makeReader(artifact);
    for (const [mount, n, by] of [[readerMount(reader.url), 2, '王工'], [publisherMount(artifact), 3, 'alice']] as const) {
      const res = await fromPage(mount, n - 1);
      const body = (await res.json()) as Published;
      assert.equal(res.status, 201, JSON.stringify(body));
      assert.equal(body.version, n);
      assert.equal(body.canvas, 900, 'the Canvas comes from the base Version, not the caller');
      assert.equal((await detail(artifact)).versions.at(-1)!.published_by, by);
    }
  });

  test('a page cannot re-lay the Artifact: a Canvas of its own is ignored', async () => {
    const artifact = await publish('900');
    const reader = await makeReader(artifact);
    const body = (await (await fromPage(readerMount(reader.url), 1, PAGE, '&canvas=1200')).json()) as Published;
    assert.equal(body.canvas, 900, 'the base Version’s width, whatever the caller declared');
    // An agent, which has no Version on screen to inherit from, still declares one and is taken at its word.
    assert.equal(((await (await asAgent(artifact, PAGE, '1600')).json()) as Published).canvas, 1600);
  });

  test('a base that is not the live Version → 409, naming the winner, and mints nothing', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    assert.equal((await fromPage(readerMount(reader.url), 1)).status, 201);
    for (const mount of [readerMount(reader.url), publisherMount(artifact)]) {
      const res = await fromPage(mount, 1);
      assert.equal(res.status, 409);
      const body = (await res.json()) as Refusal;
      assert.equal(body.error.code, 'conflict');
      assert.equal(body.live, '2', 'the version to reload to');
    }
    assert.equal((await detail(artifact)).versions.length, 2);
  });

  test('frozen → 423 not_writer on both mounts, and nothing is minted', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    await asAgent(artifact);
    assert.equal((await freeze(artifact, 1)).status, 200);
    for (const mount of [readerMount(reader.url), publisherMount(artifact)]) {
      const res = await fromPage(mount, 2);
      assert.equal(res.status, 423);
      assert.equal(((await res.json()) as Refusal).error.code, 'not_writer');
    }
    assert.equal((await detail(artifact)).versions.length, 2);
  });

  test('a freeze after the page loaded is not pushed; the next publish is what refuses', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    assert.equal(await framedVersion(reader.url), 1);
    assert.equal((await freeze(artifact, 1)).status, 200);
    // The view is still running v1 and still thinks it may write; the refusal is the news.
    assert.equal(((await (await fromPage(readerMount(reader.url), 1)).json()) as Refusal).error.code, 'not_writer');
  });

  test('an agent publish is refused by neither: freezing is what lets a Publisher keep revising', async () => {
    const artifact = await publish();
    assert.equal((await freeze(artifact, 1)).status, 200);
    assert.equal((await asAgent(artifact)).status, 201, 'no base, no compare-and-set, no freeze check');
    assert.equal((await detail(artifact)).pinned, 1, 'and the Reader stays where the freeze put them');
  });

  test('over 16 MiB → 413 too_large', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    const huge = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61);
    assert.equal((await fromPage(readerMount(reader.url), 1, huge)).status, 413);
    assert.equal((await fromPage(publisherMount(artifact), 1, huge)).status, 413);
    assert.equal((await detail(artifact)).versions.length, 1);
  });

  test('the body is checked as it is anywhere else', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    const res = await fetch(`${reader.url}/versions?base=1`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: PAGE });
    assert.equal(res.status, 415);
  });

  test('the Reader mount publishes against a Version or not at all', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    // Nothing but a page reaches this door, and a page always knows which Version it is running:
    // without one there is no compare-and-set, and a leaked link would overwrite whatever is live.
    const res = await fromPage(readerMount(reader.url), null);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as Refusal).error.code, 'invalid_argument');
    assert.equal((await detail(artifact)).versions.length, 1);
  });

  test('the Reader mount is the link and nothing else', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    const gone = await makeReader(artifact, '李工');
    assert.equal((await fromPage(readerMount(`${server.shellOrigin}/r/${'x'.repeat(43)}`), 1)).status, 404);
    assert.equal(
      (await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers/${gone.reader}`, { method: 'DELETE', headers: auth() })).status,
      204,
    );
    assert.equal((await fromPage(readerMount(gone.url), 1)).status, 404, 'a revoked link publishes nothing');
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts/${artifact}`, { method: 'DELETE', headers: auth() })).status, 204);
    assert.equal((await fromPage(readerMount(reader.url), 1)).status, 404, 'and neither does a live link on a deleted Artifact');
  });

  test('the Publisher mount still needs a token, and stays inside its Client', async () => {
    const artifact = await publish();
    const res = await fromPage({ url: publisherMount(artifact).url, headers: {} }, 1);
    assert.equal(res.status, 401);
    const minted = await fetch(`${server.shellOrigin}/api/tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify({ name: 'acme-bot', client: 'acme' }),
    });
    assert.equal(minted.status, 201);
    const scoped = ((await minted.json()) as { token: string }).token;
    const out = await fromPage({ url: publisherMount(artifact).url, headers: { authorization: `Bearer ${scoped}` } }, 1);
    assert.equal(out.status, 404, 'another Client’s Artifact is absent, not forbidden');
  });
});

describe('the name on a page’s Version', () => {
  test('the Reader’s own name, wherever a Publisher reads it', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact, '王工');
    assert.equal((await fromPage(readerMount(reader.url), 1)).status, 201);
    assert.deepEqual((await detail(artifact)).versions.map((v) => v.published_by), ['alice', '王工']);
    assert.equal((await gallery()).find((r) => r.artifact === artifact)!.last_published_by, '王工');
  });
});

describe('every open view follows the Version that lands', () => {
  /**
   * One open stream, as the frames it has written so far. Nothing is parsed: what this seam owns is
   * that a push went out at all and carried the right shape — the subscription table that reads them
   * is the browser's, and `realtime.test.ts` is where a document event's contents are checked.
   */
  async function watch(url: string, headers: Record<string, string> = {}) {
    const ctl = new AbortController();
    streams.push(ctl);
    const res = await fetch(url, { headers, signal: ctl.signal });
    assert.equal(res.status, 200);
    let seen = '';
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of res.body!) seen += decoder.decode(chunk as Uint8Array, { stream: true });
    })().catch(() => {});
    const settle = () => new Promise((r) => setTimeout(r, 300));
    return {
      /** Everything written to this stream since it opened, once whatever is in flight has landed. */
      frames: async () => (await settle(), seen.split('\n\n').filter((f) => f.startsWith('data:')).map((f) => f.slice(5).trim())),
    };
  }

  test('a Version reaches both mounts’ streams, whoever published it', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    const mine = await watch(`${reader.url}/db/stream`);
    const theirs = await watch(`${publisherMount(artifact).url}/db/stream`, auth());
    assert.equal((await fromPage(readerMount(reader.url), 1)).status, 201);
    assert.equal((await asAgent(artifact)).status, 201);
    // The publishing view included: after an html publish this one reloads too (spec §9).
    assert.deepEqual(await mine.frames(), ['{"type":"version","n":2}', '{"type":"version","n":3}']);
    assert.deepEqual(await theirs.frames(), ['{"type":"version","n":2}', '{"type":"version","n":3}']);
  });

  test('a frozen Artifact pushes nothing: it is holding still on purpose', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    assert.equal((await freeze(artifact, 1)).status, 200);
    const s = await watch(`${reader.url}/db/stream`);
    assert.equal((await asAgent(artifact)).status, 201);
    assert.deepEqual(await s.frames(), []);
  });

  test('a document write is still its own event, and is not a Version', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    const s = await watch(`${reader.url}/db/stream`);
    await fetch(`${reader.url}/db`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'set', path: 'votes/hotpot', data: { n: 1 } }),
    });
    const [frame] = await s.frames();
    const e = JSON.parse(frame ?? 'null') as { path: string; type?: string };
    assert.equal(e.path, 'votes/hotpot');
    assert.equal(e.type, undefined, 'the version push is the only kind that names itself');
  });
});

describe('what the page keeps across its own publish', () => {
  test('the store survives, and so do the pins made on the Version it replaced', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    await fetch(`${reader.url}/db`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'set', path: 'votes/hotpot', data: { n: 3 } }),
    });
    const pin = await fetch(`${reader.url}/annotations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, anchor: { path: '#app', pin: { x: 0.5, y: 0.5 }, sig: '0123456789abcdef' }, text: '这里改一下' }),
    });
    assert.equal(pin.status, 201);

    assert.equal((await fromPage(readerMount(reader.url), 1)).status, 201);
    assert.equal(await framedVersion(reader.url), 2, 'the link follows the new Version');
    const kept = (await (await fetch(`${reader.url}/annotations`)).json()) as { version: number; anchor: { path: string } }[];
    assert.deepEqual(kept.map((a) => [a.version, a.anchor.path]), [[1, '#app']], 'pinned on v1, still in the list on v2');
    const doc = await (await fetch(`${reader.url}/db`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'get', path: 'votes/hotpot' }),
    })).json() as { data: { n: number } };
    assert.deepEqual(doc.data, { n: 3 }, 'one store per Artifact, surviving every republish');
  });
});

describe('the lines that run in the browser ship with the page', () => {
  test('the Shell publishes against the Version it is running, and follows the winner', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    const page = await (await fetch(reader.url)).text();
    assert.ok(page.includes("VERSIONS+'?base='+VERSION"), 'compare-and-set against the loaded Version');
    assert.ok(page.includes('{...b.error,live:b.live}'), 'a conflict names the winner to the page, as the contract has it');
    assert.ok(page.includes("e.type==='version'"), 'and a Version that lands elsewhere reloads this view');
    // Not on the first subscription: the poll page listens to no document and still has to hear.
    assert.ok(page.includes('fit();stream();'), 'every view holds a stream from the moment it loads');
  });

  test('`artifact` is in `caps` on a frozen Artifact too: publish is what refuses', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    assert.equal((await freeze(artifact, 1)).status, 200);
    const page = await (await fetch(reader.url)).text();
    assert.ok(/"caps":\[[^\]]*"artifact"/.test(page), 'a read-only view still resolves the namespace');
  });

  test('the runtime serves one publish: the whole page, never a files form', async () => {
    const artifact = await publish();
    const runtime = await (await fetch(`${server.usercontentOrigin(artifact)}/v/1`)).text();
    assert.ok(runtime.includes("typeof html === 'string'"), 'the files form is not this runtime’s');
    assert.ok(runtime.includes('edit: removed, sync: removed'));
  });
});
