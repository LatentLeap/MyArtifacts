// The HTTP seam: the Publisher's own five pages (spec §12). A token is pasted once at
// `/login` and becomes a cookie that walks the same endpoints a Bearer header does; the
// four pages behind it are server-rendered HTML, so what is asserted here is what a
// browser is handed — the rows, the links, the columns a Client token must not be shown.
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

type Minted = { name: string; client: string | null; token: string };

const api = (path: string, token: string, init: RequestInit = {}) =>
  fetch(`${server.shellOrigin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

/** A page, as a browser asks for it: a cookie and no redirect-following. */
const page = (path: string, cookie?: string | null) =>
  fetch(`${server.shellOrigin}${path}`, {
    redirect: 'manual',
    headers: cookie ? { cookie: `myartifacts=${cookie}` } : {},
  });

const login = (token: string) =>
  fetch(`${server.shellOrigin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });

async function publish(token: string, title: string, client?: string): Promise<string> {
  const url = new URL('/api/artifacts', server.shellOrigin);
  url.searchParams.set('canvas', '1200');
  if (client !== undefined) url.searchParams.set('client', client);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'text/html', authorization: `Bearer ${token}` },
    body: `<title>${title}</title><h1 id="hero">${title}</h1>`,
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return (JSON.parse(text) as { artifact: string }).artifact;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'myartifacts-'));
  root = mintToken(dir, 'alice');
  server = await start({ dataDir: dir, shellPort: 0, usercontentPort: 0 });
  acme = ((await (await api('/api/tokens', root, { method: 'POST', body: JSON.stringify({ name: 'acme-designer', client: 'acme' }) })).json()) as Minted).token;
});
after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('/login', () => {
  test('GET is a form with one field and no "remember me"', async () => {
    const res = await page('/login');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /name="token"/);
    assert.ok(!/记住我|remember/i.test(html), html);
  });

  test('a good token becomes a long-lived cookie and lands on the gallery', async () => {
    const res = await login(root);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, new RegExp(`myartifacts=${root}(;|$)`));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=\d{6,}/i, 'long-lived, not a session cookie');
  });

  test('a bad token is one line of error, and no cookie', async () => {
    const res = await login('not-a-token');
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.match(await res.text(), /token/i);
  });

  test('退出 clears the cookie and goes back to /login', async () => {
    const res = await fetch(`${server.shellOrigin}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: `myartifacts=${root}` } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
    assert.match(res.headers.get('set-cookie') ?? '', /myartifacts=;.*Max-Age=0/i);
  });

  test('every page sends an unauthenticated browser to /login', async () => {
    for (const path of ['/', '/members', `/a/${'0'.repeat(32)}`]) {
      const res = await page(path);
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get('location'), '/login', path);
    }
  });
});

describe('the cookie is the same credential as the Bearer header', () => {
  test('it walks the same endpoints', async () => {
    const artifact = await publish(root, 'Cookie deck');
    const cookie = { cookie: `myartifacts=${root}` };
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts`, { headers: cookie })).status, 200);
    const detail = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}`, { headers: cookie });
    assert.equal(detail.status, 200);
    const flip = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/pinned`, {
      method: 'PUT', headers: { ...cookie, 'content-type': 'application/json' }, body: JSON.stringify({ version: 1 }),
    });
    assert.equal(flip.status, 200);
    await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/pinned`, {
      method: 'PUT', headers: { ...cookie, 'content-type': 'application/json' }, body: JSON.stringify({ version: null }),
    });
  });

  test('revoking a token cuts the browser session with the API', async () => {
    const t = ((await (await api('/api/tokens', root, { method: 'POST', body: JSON.stringify({ name: 'brief-session' }) })).json()) as Minted).token;
    assert.equal((await page('/', t)).status, 200);
    assert.equal((await api('/api/tokens/brief-session', root, { method: 'DELETE' })).status, 204);
    const after = await page('/', t);
    assert.equal(after.status, 302, 'a revoked cookie is no longer a session');
    assert.equal(after.headers.get('location'), '/login');
    assert.equal((await fetch(`${server.shellOrigin}/api/artifacts`, { headers: { cookie: `myartifacts=${t}` } })).status, 401);
  });
});

describe('the gallery', () => {
  test('one flat table, newest publish first, with the spec’s columns', async () => {
    const older = await publish(root, 'Older deck');
    const newer = await publish(root, 'Newer deck');
    const html = await (await page('/', root)).text();
    assert.ok(html.includes(`href="/a/${older}"`), 'the title links to the Artifact page');
    assert.ok(html.includes(`href="/a/${newer}"`));
    assert.ok(html.indexOf(newer) < html.indexOf(older), 'most recently published first');
    for (const column of ['标题', '客户', '最新版', '未解决', '收件人', '最近发布']) {
      assert.ok(html.includes(column), `missing column ${column}`);
    }
    // Not grouped, not searched, not paged: one <table> and no form to type into.
    assert.equal(html.match(/<table/g)?.length, 1);
    assert.ok(!/<input/.test(html), html);
  });

  test('a frozen Artifact says which version it is frozen at', async () => {
    const artifact = await publish(root, 'Frozen deck');
    await api(`/api/artifacts/${artifact}/versions?canvas=1200`, root, {
      method: 'POST', headers: { 'content-type': 'text/html' }, body: '<title>Frozen deck</title><p>v2</p>',
    });
    assert.equal((await api(`/api/artifacts/${artifact}/pinned`, root, { method: 'PUT', body: JSON.stringify({ version: 1 }) })).status, 200);
    const row = (await (await page('/', root)).text()).split('<tr').find((r) => r.includes(artifact)) ?? '';
    assert.match(row, /冻结在 v1/);
  });

  test('a Client token gets its own rows and no Client column', async () => {
    const mine = await publish(acme, 'Acme deck');
    const theirs = await publish(root, 'Internal deck');
    const html = await (await page('/', acme)).text();
    assert.ok(html.includes(mine));
    assert.ok(!html.includes(theirs), 'another Client’s Artifact must not exist here');
    assert.ok(!html.includes('<th>客户</th>'), html);
    assert.ok(!html.includes('href="/members"'), 'no members nav item for a Client token');
  });

  test('a soft-deleted Artifact is gone from the table', async () => {
    const artifact = await publish(root, 'Doomed deck');
    assert.ok((await (await page('/', root)).text()).includes(artifact));
    assert.equal((await api(`/api/artifacts/${artifact}`, root, { method: 'DELETE' })).status, 204);
    assert.ok(!(await (await page('/', root)).text()).includes(artifact));
  });
});

describe('/a/{id}', () => {
  let artifact: string;
  let readerUrl: string;
  let annotation: string;

  before(async () => {
    artifact = await publish(root, 'Review deck');
    await api(`/api/artifacts/${artifact}/versions?canvas=1200`, root, {
      method: 'POST', headers: { 'content-type': 'text/html' }, body: '<title>Review deck</title><h1 id="hero">v2</h1>',
    });
    const reader = (await (await api(`/api/artifacts/${artifact}/readers`, root, { method: 'POST', body: JSON.stringify({ name: '客户小李' }) })).json()) as { url: string };
    readerUrl = reader.url;
    const pinned = await fetch(`${readerUrl}/annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, anchor: { path: '#hero', pin: { x: 0.5, y: 0.5 }, sig: 'a'.repeat(16) }, text: '这里的标题太长' }),
    });
    assert.equal(pinned.status, 201);
    annotation = ((await pinned.json()) as { annotation: string }).annotation;
  });

  test('three blocks stacked: versions, annotations, readers — and nothing to reply into', async () => {
    const html = await (await page(`/a/${artifact}`, root)).text();
    assert.ok(html.includes('Review deck'));
    assert.ok(html.includes('1200'), 'the canvas is in the header');
    assert.ok(html.includes(`href="/a/${artifact}/v/1"`));
    assert.ok(html.includes(`href="/a/${artifact}/v/2"`));
    assert.ok(html.includes('客户小李'));
    assert.ok(html.includes(readerUrl), 'the Reader link is there to copy');
    assert.ok(html.includes('这里的标题太长'));
    assert.ok(!/<textarea/.test(html), 'no reply box anywhere on this page');
    assert.ok(!/docs|文档存储/.test(html), 'no docs block');
    assert.equal(html.match(/<table/g)?.length, 3, 'three blocks, no tabs');
  });

  test('freezing from a Version row, and thawing again', async () => {
    assert.equal((await api(`/api/artifacts/${artifact}/pinned`, root, { method: 'PUT', body: JSON.stringify({ version: 1 }) })).status, 200);
    const frozen = await (await page(`/a/${artifact}`, root)).text();
    assert.match(frozen, /解冻/);
    assert.match(frozen, /冻结在此版|冻结中/);
    assert.equal((await api(`/api/artifacts/${artifact}/pinned`, root, { method: 'PUT', body: JSON.stringify({ version: null }) })).status, 200);
    assert.ok(!/解冻/.test(await (await page(`/a/${artifact}`, root)).text()));
  });

  test('annotations default to open and can be switched to addressed', async () => {
    const open = await (await page(`/a/${artifact}`, root)).text();
    assert.ok(open.includes('这里的标题太长'));
    assert.equal((await api(`/api/annotations/${annotation}`, root, { method: 'PATCH', body: JSON.stringify({ status: 'addressed' }) })).status, 200);
    assert.ok(!(await (await page(`/a/${artifact}`, root)).text()).includes('这里的标题太长'), 'addressed ones are behind the switch');
    assert.ok((await (await page(`/a/${artifact}?status=addressed`, root)).text()).includes('这里的标题太长'));
    await api(`/api/annotations/${annotation}`, root, { method: 'PATCH', body: JSON.stringify({ status: 'open' }) });
  });

  test('an annotation pinned on a version that is no longer current is marked', async () => {
    // v1's pin while v2 is live. Not a `Detached` claim: with no DOM to resolve the anchor
    // against, the table cannot know that (spec §8), and an older pin whose element survived
    // is anchored fine. It marks only what it does know.
    const html = await (await page(`/a/${artifact}`, root)).text();
    assert.match(html, /（非当前版）/);
    assert.ok(!html.includes('（未锚定）'), 'the table must not claim an anchor it cannot resolve');
  });

  test('a revoked Reader stays in the table, greyed', async () => {
    const created = (await (await api(`/api/artifacts/${artifact}/readers`, root, { method: 'POST', body: JSON.stringify({ name: '临时链接' }) })).json()) as { reader: string };
    assert.equal((await api(`/api/artifacts/${artifact}/readers/${created.reader}`, root, { method: 'DELETE' })).status, 204);
    const row = (await (await page(`/a/${artifact}`, root)).text()).split('<tr').find((r) => r.includes('临时链接')) ?? '';
    assert.match(row, /已撤销/);
  });

  test('another Client’s Artifact, and a soft-deleted one, are 404', async () => {
    assert.equal((await page(`/a/${artifact}`, acme)).status, 404);
    const doomed = await publish(root, 'Gone deck');
    assert.equal((await page(`/a/${doomed}`, root)).status, 200);
    await api(`/api/artifacts/${doomed}`, root, { method: 'DELETE' });
    assert.equal((await page(`/a/${doomed}`, root)).status, 404);
  });
});

describe('/members', () => {
  test('internal only: the form, the table, and a Client token refused', async () => {
    const html = await (await page('/members', root)).text();
    assert.ok(html.includes('alice'), 'the token that minted everything is listed');
    assert.ok(html.includes('acme-designer'));
    assert.match(html, /name="mname"/);
    assert.match(html, /name="mclient"/);
    assert.equal((await page('/members', acme)).status, 403);
  });

  test('the page never carries a plaintext token', async () => {
    const fresh = ((await (await api('/api/tokens', root, { method: 'POST', body: JSON.stringify({ name: 'fresh-hand' }) })).json()) as Minted).token;
    const html = await (await page('/members', root)).text();
    assert.ok(html.includes('fresh-hand'));
    assert.ok(!html.includes(fresh), 'the plaintext is in the mint response and nowhere else');
  });
});
