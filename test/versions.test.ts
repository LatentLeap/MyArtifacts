// The HTTP seam again: the second Version and every one after it, the freeze switch,
// the two read endpoints, and the soft delete. Same rules as the other two files —
// real HTTP in, HTTP out, plus the disk and the database rows the soft delete promises
// not to touch.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  server = await start({ dataDir: dir, shellPort: 0, usercontentPort: 0 });
});
after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });

type Published = { artifact: string; version: number; canvas: number; title: string | null; preview: string };
type Detail = {
  artifact: string; title: string | null; client: string | null; pinned: number | null;
  versions: { version: number; canvas: number; title: string | null; published_by: string; created_at: string }[];
  readers: number; open_annotations: number;
};
type GalleryRow = {
  artifact: string; title: string | null; client: string | null; pinned: number | null; latest: number;
  open_annotations: number; readers: number; last_published_at: string; last_published_by: string;
};

const post = (path: string, body: string | Uint8Array, opts: { canvas?: string | null; type?: string; token?: string | null } = {}) => {
  const { canvas = '1200', type = 'text/html', token: t = token } = opts;
  const url = new URL(path, server.shellOrigin);
  if (canvas !== null) url.searchParams.set('canvas', canvas);
  return fetch(url, { method: 'POST', headers: { 'content-type': type, ...(t ? { authorization: `Bearer ${t}` } : {}) }, body });
};

async function create(html = '<title>v1</title><h1>One</h1>', canvas = '1200'): Promise<string> {
  const res = await post('/api/artifacts', html, { canvas });
  assert.equal(res.status, 201);
  return ((await res.json()) as Published).artifact;
}

async function addVersion(artifact: string, html: string, canvas = '1200'): Promise<Published> {
  const res = await post(`/api/artifacts/${artifact}/versions`, html, { canvas });
  const body = (await res.json()) as Published;
  assert.equal(res.status, 201, JSON.stringify(body));
  return body;
}

const detail = (artifact: string) => fetch(`${server.shellOrigin}/api/artifacts/${artifact}`, { headers: auth() });
const list = () => fetch(`${server.shellOrigin}/api/artifacts`, { headers: auth() });
const pin = (artifact: string, body: unknown) =>
  fetch(`${server.shellOrigin}/api/artifacts/${artifact}/pinned`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...auth() },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const softDelete = (artifact: string) => fetch(`${server.shellOrigin}/api/artifacts/${artifact}`, { method: 'DELETE', headers: auth() });

async function makeReader(artifact: string, name = '王工'): Promise<{ reader: string; url: string }> {
  const res = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth() },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { reader: string; url: string };
}

/** Which Version the Reader's Shell page is framing. */
const framedVersion = async (readerUrl: string): Promise<number> => {
  const page = await (await fetch(readerUrl)).text();
  return Number(/\/v\/(\d+)"/.exec(page)?.[1]);
};

const MISSING = '0'.repeat(32);

describe('POST /api/artifacts/{id}/versions', () => {
  test('needs a token, and mints nothing without one', async () => {
    const artifact = await create();
    assert.equal((await post(`/api/artifacts/${artifact}/versions`, '<p>two</p>', { token: null })).status, 401);
    assert.equal((await post(`/api/artifacts/${artifact}/versions`, '<p>two</p>', { token: 'nope' })).status, 401);
    assert.equal(((await (await detail(artifact)).json()) as Detail).versions.length, 1);
  });

  test('an artifact that does not exist → 404', async () => {
    assert.equal((await post(`/api/artifacts/${MISSING}/versions`, '<p>two</p>')).status, 404);
  });

  test('the version number climbs from 1, one at a time', async () => {
    const artifact = await create();
    assert.equal((await addVersion(artifact, '<title>v2</title>')).version, 2);
    assert.equal((await addVersion(artifact, '<title>v3</title>')).version, 3);
    const other = await create();
    assert.equal((await addVersion(other, '<title>other v2</title>')).version, 2, 'numbering is per artifact');
  });

  test('201 carries the same shape as the first publish', async () => {
    const artifact = await create();
    const body = await addVersion(artifact, '<title>第二稿</title><p>two</p>', '900');
    assert.equal(body.artifact, artifact);
    assert.equal(body.version, 2);
    assert.equal(body.canvas, 900, 'canvas is declared per version, not inherited');
    assert.equal(body.title, '第二稿');
    assert.equal(body.preview, `${server.shellOrigin}/a/${artifact}/v/2`);
    assert.ok(!JSON.stringify(body).includes('usercontent'));
  });

  test('the same argument checks as the first publish', async () => {
    const artifact = await create();
    assert.equal((await post(`/api/artifacts/${artifact}/versions`, '<p>x</p>', { canvas: null })).status, 400);
    assert.equal((await post(`/api/artifacts/${artifact}/versions`, '<p>x</p>', { canvas: '-5' })).status, 400);
    assert.equal((await post(`/api/artifacts/${artifact}/versions`, '<p>x</p>', { type: 'text/plain' })).status, 415);
    assert.equal((await post(`/api/artifacts/${artifact}/versions`, Buffer.alloc(16 * 1024 * 1024 + 1, 0x61))).status, 413);
    assert.equal(((await (await detail(artifact)).json()) as Detail).versions.length, 1, 'no rejected call left a version behind');
  });

  test('an old version stays readable at its own address, forever', async () => {
    const artifact = await create('<title>v1</title><h1>One</h1>');
    await addVersion(artifact, '<title>v2</title><h1>Two</h1>');
    await addVersion(artifact, '<title>v3</title><h1>Three</h1>');
    for (const [n, marker] of [[1, 'One'], [2, 'Two'], [3, 'Three']] as const) {
      const res = await fetch(`${server.usercontentOrigin(artifact)}/v/${n}`);
      assert.equal(res.status, 200);
      assert.ok((await res.text()).includes(`<h1>${marker}</h1>`), `v${n} still serves its own bytes`);
    }
  });
});

describe('the Reader sees the live version', () => {
  test('a new version reaches an already-issued link', async () => {
    const artifact = await create();
    const reader = await makeReader(artifact);
    assert.equal(await framedVersion(reader.url), 1);
    await addVersion(artifact, '<title>v2</title>');
    assert.equal(await framedVersion(reader.url), 2);
  });
});

describe('PUT /api/artifacts/{id}/pinned', () => {
  test('freezing stops the Reader on that version, and unfreezing lets go', async () => {
    const artifact = await create();
    await addVersion(artifact, '<title>v2</title>');
    const reader = await makeReader(artifact);

    const frozen = await pin(artifact, { version: 1 });
    assert.equal(frozen.status, 200);
    assert.deepEqual(await frozen.json(), { pinned: 1 });
    assert.equal(await framedVersion(reader.url), 1);

    await addVersion(artifact, '<title>v3</title>');
    assert.equal(await framedVersion(reader.url), 1, 'a frozen artifact does not follow the newest version');

    const thawed = await pin(artifact, { version: null });
    assert.equal(thawed.status, 200);
    assert.deepEqual(await thawed.json(), { pinned: null });
    assert.equal(await framedVersion(reader.url), 3);
  });

  test('the freeze can point at any existing version, including backwards', async () => {
    const artifact = await create();
    await addVersion(artifact, '<title>v2</title>');
    await addVersion(artifact, '<title>v3</title>');
    assert.equal((await pin(artifact, { version: 3 })).status, 200);
    assert.equal((await pin(artifact, { version: 1 })).status, 200);
    assert.equal(((await (await detail(artifact)).json()) as Detail).pinned, 1);
  });

  test('a version that does not exist → 400, and the freeze does not move', async () => {
    const artifact = await create();
    await pin(artifact, { version: 1 });
    for (const version of [2, 0, -1, 1.5, '1', true, 1e21, Number.MAX_SAFE_INTEGER + 2]) {
      assert.equal((await pin(artifact, { version })).status, 400, `version: ${JSON.stringify(version)}`);
    }
    assert.equal((await pin(artifact, {})).status, 400, 'a missing key is not the same as null');
    assert.equal((await pin(artifact, 'not json')).status, 400);
    assert.equal(((await (await detail(artifact)).json()) as Detail).pinned, 1);
  });

  test('needs a token; an artifact that does not exist → 404', async () => {
    const artifact = await create();
    const res = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/pinned`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"version":1}',
    });
    assert.equal(res.status, 401);
    assert.equal((await pin(MISSING, { version: 1 })).status, 404);
  });
});

describe('GET /api/artifacts/{id}', () => {
  test('needs a token; an artifact that does not exist → 404', async () => {
    const artifact = await create();
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts/${artifact}`)).status, 401);
    assert.equal((await detail(MISSING)).status, 404);
  });

  test('carries the spec fields, with every version in order', async () => {
    const artifact = await create('<title>官网改版</title>', '900');
    await addVersion(artifact, '<title>官网改版 v2</title>', '1200');
    await makeReader(artifact, '王工');
    await makeReader(artifact, '李工');

    const body = (await (await detail(artifact)).json()) as Detail;
    assert.equal(body.artifact, artifact);
    assert.equal(body.title, '官网改版 v2', 'the title comes from the newest version');
    assert.equal(body.client, null);
    assert.equal(body.pinned, null);
    assert.equal(body.readers, 2);
    assert.equal(body.open_annotations, 0);
    assert.deepEqual(body.versions.map((v) => v.version), [1, 2]);
    assert.deepEqual(body.versions.map((v) => v.canvas), [900, 1200]);
    assert.deepEqual(body.versions.map((v) => v.title), ['官网改版', '官网改版 v2']);
    assert.deepEqual(body.versions.map((v) => v.published_by), ['alice', 'alice']);
    assert.match(body.versions[0]?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });

  test('a revoked reader is not a reader you can still reach', async () => {
    const artifact = await create();
    const reader = await makeReader(artifact);
    await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers/${reader.reader}`, { method: 'DELETE', headers: auth() });
    assert.equal(((await (await detail(artifact)).json()) as Detail).readers, 0);
  });
});

describe('GET /api/artifacts', () => {
  test('needs a token', async () => {
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts`)).status, 401);
  });

  test('newest publish first, whichever artifact it belonged to', async () => {
    const a = await create('<title>A</title>');
    const b = await create('<title>B</title>');
    const c = await create('<title>C</title>');
    const order = async () => ((await (await list()).json()) as GalleryRow[]).map((r) => r.artifact);
    assert.deepEqual((await order()).slice(0, 3), [c, b, a]);

    await addVersion(a, '<title>A v2</title>');
    assert.deepEqual((await order()).slice(0, 3), [a, c, b], 'republishing moves an artifact to the front');
  });

  test('each row carries the spec fields', async () => {
    const artifact = await create('<title>只有一版</title>');
    const v2 = await addVersion(artifact, '<title>两版了</title>');
    await makeReader(artifact);
    await pin(artifact, { version: 1 });

    const row = ((await (await list()).json()) as GalleryRow[]).find((r) => r.artifact === artifact);
    assert.ok(row, 'the artifact is listed');
    assert.equal(row.title, '两版了');
    assert.equal(row.client, null);
    assert.equal(row.pinned, 1);
    assert.equal(row.latest, 2, 'latest is the newest version, not the frozen one');
    assert.equal(row.readers, 1);
    assert.equal(row.open_annotations, 0);
    assert.equal(row.last_published_by, 'alice');
    assert.match(row.last_published_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(!JSON.stringify(row).includes('usercontent'));
    assert.equal(v2.version, 2);
  });
});

describe('DELETE /api/artifacts/{id}', () => {
  const gone = async (artifact: string, reader: { reader: string; url: string }) => {
    assert.equal((await detail(artifact)).status, 404, 'GET /api/artifacts/{id}');
    assert.equal((await pin(artifact, { version: 1 })).status, 404, 'PUT .../pinned');
    assert.equal((await softDelete(artifact)).status, 404, 'a second delete');
    assert.equal((await post(`/api/artifacts/${artifact}/versions`, '<p>x</p>')).status, 404, 'POST .../versions');
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`, { headers: auth() })).status, 404, 'GET .../readers');
    const made = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify({ name: '新人' }),
    });
    assert.equal(made.status, 404, 'POST .../readers');
    const revoked = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers/${reader.reader}`, { method: 'DELETE', headers: auth() });
    assert.equal(revoked.status, 404, 'DELETE .../readers/{rid}');
    assert.equal((await fetch(`${server.shellOrigin}/a/${artifact}/v/1`, { headers: auth() })).status, 404, 'the publisher preview');
    assert.equal((await fetch(`${server.usercontentOrigin(artifact)}/v/1`)).status, 404, 'the artifact’s own origin');
    assert.ok(!((await (await list()).json()) as GalleryRow[]).some((r) => r.artifact === artifact), 'still listed');
  };

  test('204, and afterwards every endpoint for that id is a 404', async () => {
    const artifact = await create();
    await addVersion(artifact, '<title>v2</title>');
    const reader = await makeReader(artifact);
    assert.equal((await softDelete(artifact)).status, 204);
    await gone(artifact, reader);
  });

  test('the reader link says the link is dead, exactly like a revoked one', async () => {
    const artifact = await create();
    const reader = await makeReader(artifact);
    await softDelete(artifact);

    const res = await fetch(reader.url);
    assert.equal(res.status, 404);
    const page = await res.text();
    assert.ok(page.includes('链接已失效'), page);
    assert.ok(!page.includes('<iframe'), page);
    assert.ok(!page.includes(server.usercontentOrigin(artifact)), page);
    assert.equal(page, await (await fetch(`${server.shellOrigin}/r/${'z'.repeat(43)}`)).text());
  });

  test('not one byte of the history moves', async () => {
    const artifact = await create('<title>v1</title><h1>One</h1>');
    await addVersion(artifact, '<title>v2</title><h1>Two</h1>');
    await makeReader(artifact);
    const files = [1, 2].map((n) => join(dir, 'versions', artifact, `${n}.html`));
    const before = files.map((f) => readFileSync(f));

    assert.equal((await softDelete(artifact)).status, 204);

    for (const [i, f] of files.entries()) {
      assert.ok(existsSync(f), `${f} is still on disk`);
      assert.deepEqual(readFileSync(f), before[i]);
    }
    const db = new DatabaseSync(join(dir, 'myartifacts.db'), { readOnly: true });
    try {
      const count = (sql: string) => (db.prepare(sql).get(artifact) as { c: number }).c;
      assert.equal(count('SELECT COUNT(*) AS c FROM versions WHERE artifact = ?'), 2, 'version rows stay');
      assert.equal(count('SELECT COUNT(*) AS c FROM readers WHERE artifact = ? AND revoked_at IS NULL'), 1, 'readers are not revoked one by one');
      assert.equal(count('SELECT COUNT(*) AS c FROM artifacts WHERE id = ? AND deleted_at IS NOT NULL'), 1, 'only deleted_at changed');
    } finally {
      db.close();
    }
  });

  test('there is no way back', async () => {
    const artifact = await create();
    await softDelete(artifact);
    for (const call of [
      fetch(`${server.shellOrigin}/api/artifacts/${artifact}/undelete`, { method: 'POST', headers: auth() }),
      fetch(`${server.shellOrigin}/api/artifacts/${artifact}`, { method: 'PUT', headers: auth(), body: '{}' }),
      fetch(`${server.shellOrigin}/api/artifacts/${artifact}?undelete=1`, { method: 'PATCH', headers: auth(), body: '{}' }),
    ]) {
      assert.equal((await call).status, 404);
    }
    assert.equal((await detail(artifact)).status, 404);
  });

  test('needs a token; an artifact that does not exist → 404', async () => {
    const artifact = await create();
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts/${artifact}`, { method: 'DELETE' })).status, 401);
    assert.equal((await softDelete(MISSING)).status, 404);
    assert.equal((await detail(artifact)).status, 200, 'the unauthorized call deleted nothing');
  });
});

// These two need a data directory of their own — one that predates the columns, and one
// arranged so the file write fails — so they start their own server rather than share.
describe('a data directory that came from an earlier version of this server', () => {
  test('gains the new columns instead of refusing to boot', async () => {
    const old = mkdtempSync(join(tmpdir(), 'myartifacts-old-'));
    const db = new DatabaseSync(join(old, 'myartifacts.db'));
    db.exec('CREATE TABLE artifacts (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)');
    db.exec('CREATE TABLE tokens (name TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)');
    db.prepare('INSERT INTO artifacts (id, created_at) VALUES (?, ?)').run('a'.repeat(32), new Date().toISOString());
    db.close();

    const older = mintToken(old, 'bob');
    const up = await start({ dataDir: old, shellPort: 0, usercontentPort: 0 });
    try {
      const res = await fetch(`${up.shellOrigin}/api/artifacts`, { headers: { authorization: `Bearer ${older}` } });
      assert.equal(res.status, 200, 'the server serves the old directory');
      assert.deepEqual(await res.json(), [], 'the artifact with no versions is not a gallery row');
    } finally {
      await up.close();
      rmSync(old, { recursive: true, force: true });
    }
  });
});

describe('a publish whose bytes cannot be written', () => {
  test('leaves no artifact behind', async () => {
    const blocked = mkdtempSync(join(tmpdir(), 'myartifacts-blocked-'));
    // A file where the versions directory belongs: mkdir under it fails with ENOTDIR.
    writeFileSync(join(blocked, 'versions'), 'not a directory');
    const other = mintToken(blocked, 'carol');
    const up = await start({ dataDir: blocked, shellPort: 0, usercontentPort: 0 });
    try {
      const res = await fetch(`${up.shellOrigin}/api/artifacts?canvas=1200`, {
        method: 'POST',
        headers: { 'content-type': 'text/html', authorization: `Bearer ${other}` },
        body: '<title>doomed</title>',
      });
      assert.equal(res.status, 500);
      const db = new DatabaseSync(join(blocked, 'myartifacts.db'), { readOnly: true });
      try {
        assert.equal((db.prepare('SELECT COUNT(*) AS c FROM artifacts').get() as { c: number }).c, 0);
      } finally {
        db.close();
      }
    } finally {
      await up.close();
      rmSync(blocked, { recursive: true, force: true });
    }
  });
});
