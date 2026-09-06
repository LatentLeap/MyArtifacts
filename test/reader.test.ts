// The HTTP seam again, this time from the Reader's side: a Publisher mints a named link,
// lists them, revokes one; a Reader opens `/r/{secret}` and gets the Shell page — or the
// dead-link page. Same rules as `publish.test.ts`: real HTTP in, HTTP out.
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

type Reader = { reader: string; name: string; url: string; revoked?: boolean; created_at?: string };

async function publish(html = '<title>官网改版</title><h1>Hello</h1>', canvas = 1200): Promise<string> {
  const res = await fetch(`${server.shellOrigin}/api/artifacts?canvas=${canvas}`, {
    method: 'POST',
    headers: { 'content-type': 'text/html', ...auth() },
    body: html,
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { artifact: string }).artifact;
}

const postReader = (artifact: string, body: unknown, opts: { token?: string | null } = {}) => {
  const { token: t = token } = opts;
  return fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
};

async function makeReader(artifact: string, name = '王工'): Promise<Reader> {
  const res = await postReader(artifact, { name });
  assert.equal(res.status, 201);
  return (await res.json()) as Reader;
}

const listReaders = async (artifact: string): Promise<Reader[]> => {
  const res = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`, { headers: auth() });
  assert.equal(res.status, 200);
  return (await res.json()) as Reader[];
};

const revoke = (artifact: string, rid: string) =>
  fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers/${rid}`, { method: 'DELETE', headers: auth() });

describe('POST /api/artifacts/{id}/readers', () => {
  test('no token → 401, and no reader is created', async () => {
    const artifact = await publish();
    assert.equal((await postReader(artifact, { name: '王工' }, { token: null })).status, 401);
    assert.equal((await postReader(artifact, { name: '王工' }, { token: 'nope' })).status, 401);
    assert.deepEqual(await listReaders(artifact), []);
  });

  test('an artifact that does not exist → 404', async () => {
    assert.equal((await postReader('0'.repeat(32), { name: '王工' })).status, 404);
  });

  test('201 carries the reader, its name, and the link to forward', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact, '客户 A · 王工');
    assert.match(reader.reader, /^[a-f0-9]{32}$/);
    assert.equal(reader.name, '客户 A · 王工');
    assert.ok(reader.url.startsWith(`${server.shellOrigin}/r/`), reader.url);
  });

  test('the secret is at least 32 bytes of randomness, and never repeats', async () => {
    const artifact = await publish();
    const secrets = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { url } = await makeReader(artifact);
      const secret = url.slice(url.lastIndexOf('/') + 1);
      // base64url: 32 bytes is 43 characters. Anything shorter is under the bar.
      assert.match(secret, /^[A-Za-z0-9_-]{43,}$/);
      secrets.add(secret);
    }
    assert.equal(secrets.size, 5);
  });

  test('a missing, blank, or over-long name → 400', async () => {
    const artifact = await publish();
    assert.equal((await postReader(artifact, {})).status, 400);
    assert.equal((await postReader(artifact, { name: '   ' })).status, 400);
    assert.equal((await postReader(artifact, { name: 42 })).status, 400);
    assert.equal((await postReader(artifact, { name: 'x'.repeat(101) })).status, 400);
    assert.equal((await postReader(artifact, 'not json')).status, 400);
  });
});

describe('GET /api/artifacts/{id}/readers', () => {
  test('needs a token', async () => {
    const artifact = await publish();
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`)).status, 401);
  });

  test('lists this artifact’s readers and nobody else’s', async () => {
    const a = await publish();
    const b = await publish();
    const one = await makeReader(a, '王工');
    await makeReader(b, '李工');

    const list = await listReaders(a);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.reader, one.reader);
    assert.equal(list[0]?.name, '王工');
    assert.equal(list[0]?.url, one.url);
    assert.equal(list[0]?.revoked, false);
    assert.match(list[0]?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });

  test('an artifact that does not exist → 404', async () => {
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts/${'0'.repeat(32)}/readers`, { headers: auth() })).status, 404);
  });
});

describe('DELETE /api/artifacts/{id}/readers/{rid}', () => {
  test('204, and the record and the name stay in the list as revoked', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact, '王工');
    assert.equal((await revoke(artifact, reader.reader)).status, 204);

    const list = await listReaders(artifact);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.name, '王工');
    assert.equal(list[0]?.revoked, true);
  });

  test('revoking one link leaves the others alone', async () => {
    const artifact = await publish();
    const gone = await makeReader(artifact, '走了的人');
    const stays = await makeReader(artifact, '还在的人');
    await revoke(artifact, gone.reader);

    assert.equal((await fetch(gone.url)).status, 404);
    assert.equal((await fetch(stays.url)).status, 200);
  });

  test('revoking twice is still 204 — it never comes back', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    assert.equal((await revoke(artifact, reader.reader)).status, 204);
    assert.equal((await revoke(artifact, reader.reader)).status, 204);
    assert.equal((await fetch(reader.url)).status, 404);
  });

  test('a reader belongs to exactly one artifact', async () => {
    const a = await publish();
    const b = await publish();
    const reader = await makeReader(a);
    assert.equal((await revoke(b, reader.reader)).status, 404);
    assert.equal((await fetch(reader.url)).status, 200, 'the other artifact must not be able to revoke it');
  });

  test('an unknown reader id → 404', async () => {
    const artifact = await publish();
    assert.equal((await revoke(artifact, '0'.repeat(32))).status, 404);
  });

  test('needs a token', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    const res = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers/${reader.reader}`, { method: 'DELETE' });
    assert.equal(res.status, 401);
    assert.equal((await fetch(reader.url)).status, 200);
  });
});

describe('GET /r/{secret} — the Reader’s Shell page', () => {
  const pageFor = async (artifact: string, name = '王工') => {
    const reader = await makeReader(artifact, name);
    const res = await fetch(reader.url);
    assert.equal(res.status, 200);
    return { reader, page: await res.text() };
  };

  test('frames the artifact from its own origin, sandboxed, at the declared canvas', async () => {
    const artifact = await publish('<title>官网改版</title><h1>Hello</h1>', 900);
    const { page } = await pageFor(artifact);
    assert.ok(page.includes(`${server.usercontentOrigin(artifact)}/v/1`), page);
    assert.ok(page.includes('sandbox="allow-scripts allow-same-origin allow-forms"'), page);
    assert.ok(!/sandbox="[^"]*allow-downloads/.test(page), page);
    assert.ok(page.includes('900'), 'the canvas width the page was composed for');
    assert.ok(!page.includes('<h1>Hello</h1>'), 'the Shell frames the artifact, it never inlines it');
  });

  test('the header carries the reader’s name, escaped', async () => {
    const artifact = await publish();
    const { page } = await pageFor(artifact, '<img src=x onerror=alert(1)>');
    assert.ok(!page.includes('<img src=x'), page);
    assert.ok(page.includes('&lt;img src=x onerror=alert(1)&gt;'), page);
  });

  test('the ready payload is inlined, and the reader is not an owner', async () => {
    const artifact = await publish();
    const { reader, page } = await pageFor(artifact);
    const ready = JSON.parse(/READY\s*=\s*(\{.*?\})[,;]/.exec(page)?.[1] ?? 'null');
    // Zero declaration (ADR-0010): the same four for every Artifact, asked for by nobody.
    assert.deepEqual(ready, {
      caps: ['db', 'user', 'downloads', 'artifact'],
      me: { id: reader.reader, canEdit: true, isOwner: false },
    });
    assert.ok(!JSON.stringify(ready).includes('王工'), 'the reader’s name is not part of the bridge identity');
  });

  test('the bridge only listens to this artifact’s frame, on this artifact’s origin', async () => {
    const artifact = await publish();
    const { page } = await pageFor(artifact);
    const handler = page.slice(page.indexOf("addEventListener('message'"));
    assert.ok(handler.includes('e.source!==f.contentWindow'), handler.slice(0, 200));
    assert.ok(handler.includes('e.origin!==ART'), handler.slice(0, 200));
    assert.ok(page.includes(`const ART=${JSON.stringify(server.usercontentOrigin(artifact))}`), 'ART is the artifact origin');
    // The other half of the check lives in the runtime the artifact origin serves.
    const runtime = await (await fetch(`${server.usercontentOrigin(artifact)}/v/1`)).text();
    assert.ok(runtime.includes('e.origin !== SHELL'), 'the runtime only listens to the Shell');
  });

  test('a revoked link is a dead end, with no way back to the artifact', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    await revoke(artifact, reader.reader);

    const res = await fetch(reader.url);
    assert.equal(res.status, 404);
    const page = await res.text();
    assert.ok(page.includes('链接已失效'), page);
    assert.ok(!page.includes('<iframe'), page);
    assert.ok(!page.includes(server.usercontentOrigin(artifact)), page);
  });

  test('a secret nobody was ever given looks exactly like a revoked one', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    await revoke(artifact, reader.reader);

    const revoked = await fetch(reader.url);
    const unknown = await fetch(`${server.shellOrigin}/r/${'z'.repeat(43)}`);
    assert.equal(unknown.status, revoked.status);
    assert.equal(await unknown.text(), await revoked.text());
  });

  test('the secret is the whole credential — nothing else under /r/ answers', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    assert.equal((await fetch(`${reader.url}/nope`)).status, 404);
    assert.equal((await fetch(`${server.shellOrigin}/r/`)).status, 404);
    assert.equal((await fetch(`${server.shellOrigin}/r/${reader.reader}`)).status, 404, 'the reader id is not a credential');
  });

  test('the page is never cached — a revoked link must not survive in a back-button', async () => {
    const artifact = await publish();
    const reader = await makeReader(artifact);
    const res = await fetch(reader.url);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  });
});
