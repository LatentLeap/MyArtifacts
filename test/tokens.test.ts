// The HTTP seam: tokens and the Client boundary (ADR-0008). One internal token minted on
// the box, two Client tokens and a second internal one minted through the API, and then
// the boundary walked from every side: a Client token must never learn that the other
// Client's Artifact exists, so every crossing is a 404 and never a 403.
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
let globex: string; // Client "globex"
let staff: string; // a second internal token

type Minted = { name: string; client: string | null; token: string };
type Published = { artifact: string; version: number };
type Row = { artifact: string; client: string | null };

const api = (path: string, token: string | null, init: RequestInit = {}) =>
  fetch(`${server.shellOrigin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
const mint = (token: string, body: unknown) => api('/api/tokens', token, { method: 'POST', body: JSON.stringify(body) });

async function publish(token: string, client?: string): Promise<Response> {
  const url = new URL('/api/artifacts', server.shellOrigin);
  url.searchParams.set('canvas', '1200');
  if (client !== undefined) url.searchParams.set('client', client);
  return fetch(url, { method: 'POST', headers: { 'content-type': 'text/html', authorization: `Bearer ${token}` }, body: '<title>t</title>' });
}
async function created(token: string, client?: string): Promise<string> {
  const res = await publish(token, client);
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return (JSON.parse(text) as Published).artifact;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'myartifacts-'));
  root = mintToken(dir, 'root');
  server = await start({ dataDir: dir, shellPort: 0, usercontentPort: 0 });
  for (const [name, client] of [['acme-designer', 'acme'], ['globex-designer', 'globex'], ['staff', undefined]] as const) {
    const res = await mint(root, client ? { name, client } : { name });
    const text = await res.text();
    assert.equal(res.status, 201, text);
    const body = JSON.parse(text) as Minted;
    if (client === 'acme') acme = body.token;
    else if (client === 'globex') globex = body.token;
    else staff = body.token;
  }
});
after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('/api/tokens', () => {
  test('POST mints once: the plaintext is in the 201 and nowhere else', async () => {
    const res = await mint(root, { name: 'once', client: 'acme' });
    assert.equal(res.status, 201);
    const body = (await res.json()) as Minted;
    assert.deepEqual({ name: body.name, client: body.client }, { name: 'once', client: 'acme' });
    assert.match(body.token, /^[A-Za-z0-9_-]{43}$/);
    const rows = (await (await api('/api/tokens', root)).json()) as (Minted & { created_at: string })[];
    const row = rows.find((r) => r.name === 'once');
    assert.ok(row?.created_at && !JSON.stringify(rows).includes(body.token), 'the list never carries the plaintext');
    assert.equal((await api('/api/artifacts', body.token)).status, 200, 'the minted token works');
  });

  test('a token without a client is internal', async () => {
    const rows = (await (await api('/api/tokens', root)).json()) as Minted[];
    assert.equal(rows.find((r) => r.name === 'staff')?.client, null);
  });

  test('a bad name, a bad client or a taken name → 400 / 409', async () => {
    assert.equal((await mint(root, {})).status, 400);
    assert.equal((await mint(root, { name: '  ' })).status, 400);
    assert.equal((await mint(root, { name: 'x', client: 'Acme Inc' })).status, 400, 'client is a short lowercase slug');
    assert.equal((await mint(root, { name: 'x', client: '' })).status, 400);
    assert.equal((await mint(root, { name: 'root' })).status, 409);
  });

  test('DELETE cuts the API off at once; revoked and unknown names → 404', async () => {
    const t = ((await (await mint(root, { name: 'brief' })).json()) as Minted).token;
    assert.equal((await api('/api/artifacts', t)).status, 200);
    assert.equal((await api('/api/tokens/brief', root, { method: 'DELETE' })).status, 204);
    assert.equal((await api('/api/artifacts', t)).status, 401);
    assert.equal((await api('/api/tokens/brief', root, { method: 'DELETE' })).status, 404);
    assert.equal((await api('/api/tokens/never', root, { method: 'DELETE' })).status, 404);
    const rows = (await (await api('/api/tokens', root)).json()) as Minted[];
    assert.ok(!rows.some((r) => r.name === 'brief'), 'a revoked token drops out of the list');
    assert.equal((await mint(root, { name: 'brief' })).status, 409, 'and its name is not reusable');
  });

  test('all three endpoints are 403 for a Client token, its own name included', async () => {
    assert.equal((await api('/api/tokens', acme)).status, 403);
    assert.equal((await mint(acme, { name: 'acme-2', client: 'acme' })).status, 403);
    assert.equal((await api('/api/tokens/acme-designer', acme, { method: 'DELETE' })).status, 403);
    assert.equal((await api('/api/artifacts', acme)).status, 200, 'and it was not revoked');
  });

  test('no token at all → 401, before any 403', async () => {
    assert.equal((await api('/api/tokens', null)).status, 401);
  });
});

describe('publishing into a Client', () => {
  test('an internal token places an Artifact with ?client=, or nowhere', async () => {
    const inAcme = await created(root, 'acme');
    const nowhere = await created(root);
    const rows = (await (await api('/api/artifacts', root)).json()) as Row[];
    assert.equal(rows.find((r) => r.artifact === inAcme)?.client, 'acme');
    assert.equal(rows.find((r) => r.artifact === nowhere)?.client, null);
    assert.equal(((await (await api(`/api/artifacts/${inAcme}`, root)).json()) as Row).client, 'acme');
  });

  test("a Client token's publish is forced to its own Client", async () => {
    const a = await created(acme);
    assert.equal(((await (await api(`/api/artifacts/${a}`, acme)).json()) as Row).client, 'acme');
    assert.equal((await publish(acme, 'acme')).status, 201, 'naming its own Client is fine');
    assert.equal((await publish(acme, 'globex')).status, 400, 'naming another is a 400');
  });

  test('a malformed ?client= → 400 for anyone', async () => {
    assert.equal((await publish(root, 'Acme')).status, 400);
    assert.equal((await publish(root, '')).status, 400);
  });
});

describe('the Client boundary', () => {
  let acmeArt: string;
  let globexArt: string;
  let internalArt: string;
  let acmeReader: string;
  before(async () => {
    acmeArt = await created(acme);
    globexArt = await created(root, 'globex');
    internalArt = await created(root);
    const res = await api(`/api/artifacts/${acmeArt}/readers`, acme, { method: 'POST', body: JSON.stringify({ name: '王工' }) });
    assert.equal(res.status, 201);
    acmeReader = ((await res.json()) as { reader: string }).reader;
  });

  test('GET /api/artifacts lists only your own Client; internal tokens see everything', async () => {
    const ids = async (t: string) => ((await (await api('/api/artifacts', t)).json()) as Row[]).map((r) => r.artifact);
    const mine = await ids(acme);
    assert.ok(mine.includes(acmeArt));
    assert.ok(!mine.includes(globexArt) && !mine.includes(internalArt));
    const theirs = await ids(globex);
    assert.ok(theirs.includes(globexArt) && !theirs.includes(acmeArt) && !theirs.includes(internalArt));
    for (const t of [root, staff]) {
      const all = await ids(t);
      assert.ok(all.includes(acmeArt) && all.includes(globexArt) && all.includes(internalArt));
    }
  });

  test('every endpoint with an id: 404 across the boundary, never 403, and 2xx inside it', async () => {
    const calls = (art: string, reader: string): [string, RequestInit][] => [
      [`/api/artifacts/${art}`, {}],
      [`/api/artifacts/${art}/versions?canvas=1200`, { method: 'POST', headers: { 'content-type': 'text/html' }, body: '<p>2</p>' }],
      [`/api/artifacts/${art}/pinned`, { method: 'PUT', body: JSON.stringify({ version: null }) }],
      [`/a/${art}/v/1`, {}],
      [`/api/artifacts/${art}/readers`, {}],
      [`/api/artifacts/${art}/readers`, { method: 'POST', body: JSON.stringify({ name: 'x' }) }],
      [`/api/artifacts/${art}/readers/${reader}`, { method: 'DELETE' }],
      [`/api/artifacts/${art}`, { method: 'DELETE' }],
    ];
    // Each Client against the other's Artifact and the internal-only one. The Reader id is
    // acme's own, which makes the revoke a miss for the Artifact rather than for the Reader.
    for (const [t, art] of [[acme, globexArt], [acme, internalArt], [globex, acmeArt], [globex, internalArt]] as const) {
      for (const [path, init] of calls(art, acmeReader)) {
        const res = await api(path, t, init);
        assert.equal(res.status, 404, `${init.method ?? 'GET'} ${path} from the wrong Client`);
      }
    }
    for (const art of [acmeArt, globexArt, internalArt]) {
      assert.equal((await api(`/api/artifacts/${art}`, root)).status, 200, 'nothing above was deleted');
    }

    // The same calls on acme's own Artifact, from acme and from an internal token, all land.
    for (const t of [acme, staff]) {
      const res = await api(`/api/artifacts/${acmeArt}/readers`, t, { method: 'POST', body: JSON.stringify({ name: 'y' }) });
      assert.equal(res.status, 201);
      const rid = ((await res.json()) as { reader: string }).reader;
      for (const [path, init] of calls(acmeArt, rid).slice(0, -1)) {
        const s = (await api(path, t, init)).status;
        assert.ok(s >= 200 && s < 300, `${init.method ?? 'GET'} ${path} → ${s}`);
      }
    }
  });

  test("a Client token's Reader opens the link like any other", async () => {
    const res = await api(`/api/artifacts/${acmeArt}/readers`, acme, { method: 'POST', body: JSON.stringify({ name: '李总' }) });
    const { url } = (await res.json()) as { url: string };
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('李总'));
  });

  test('a malformed percent-escape in a token name is a miss, not a crash', async () => {
    assert.equal((await api('/api/tokens/%E0%A4%A', root, { method: 'DELETE' })).status, 404);
  });

  test('an internal token has every power on every Artifact, including the delete', async () => {
    const doomed = await created(acme);
    assert.equal((await api(`/api/artifacts/${doomed}`, staff, { method: 'DELETE' })).status, 204);
    assert.equal((await api(`/api/artifacts/${doomed}`, acme)).status, 404, 'and the Client no longer sees it');
  });
});
