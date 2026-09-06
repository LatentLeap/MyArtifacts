// The HTTP seam: an in-process server, a temp SQLite file, a temp data directory.
// Everything here goes in over real HTTP and comes out as HTTP, files on disk, or nothing.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { mintToken, start } from '../src/server.ts';

const HTML = '<title>Kickoff deck</title><h1>Hello</h1><p>Body copy.</p>';

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

const publish = (body: string | Uint8Array, opts: { canvas?: string | null; type?: string; token?: string | null } = {}) => {
  const { canvas = '1200', type = 'text/html', token: t = token } = opts;
  const url = new URL('/api/artifacts', server.shellOrigin);
  if (canvas !== null) url.searchParams.set('canvas', canvas);
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': type, ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body,
  });
};

const publishOk = async (body = HTML, canvas = '1200') => {
  const res = await publish(body, { canvas });
  assert.equal(res.status, 201);
  return (await res.json()) as { artifact: string; version: number; canvas: number; title: string | null; preview: string };
};

describe('minting the first token', () => {
  test('prints a token the API accepts, and stores only a hash', async () => {
    assert.match(token, /^[A-Za-z0-9_-]{20,}$/);
    const db = readFileSync(join(dir, 'myartifacts.db'));
    assert.ok(!db.includes(Buffer.from(token)), 'plaintext token must not be in the database');
    assert.ok(db.includes(Buffer.from('alice')), 'the token name is stored');
  });

  test('a name can only be minted once', () => {
    assert.throws(() => mintToken(dir, 'alice'));
  });
});

describe('POST /api/artifacts', () => {
  test('no token → 401', async () => {
    assert.equal((await publish(HTML, { token: null })).status, 401);
  });

  test('wrong token → 401', async () => {
    assert.equal((await publish(HTML, { token: 'not-a-real-token' })).status, 401);
  });

  test('missing canvas → 400', async () => {
    assert.equal((await publish(HTML, { canvas: null })).status, 400);
  });

  test('non-numeric canvas → 400', async () => {
    assert.equal((await publish(HTML, { canvas: 'wide' })).status, 400);
    assert.equal((await publish(HTML, { canvas: '0' })).status, 400);
    assert.equal((await publish(HTML, { canvas: '-5' })).status, 400);
  });

  // text/markdown is the other accepted type; it has its own file.
  test('a media type other than text/html or text/markdown → 415', async () => {
    assert.equal((await publish(HTML, { type: 'text/plain' })).status, 415);
    assert.equal((await publish(HTML, { type: 'application/json' })).status, 415);
  });

  test('text/html with a charset is accepted', async () => {
    assert.equal((await publish(HTML, { type: 'text/html; charset=utf-8' })).status, 201);
  });

  test('over 16 MiB → 413', async () => {
    const tooBig = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61);
    assert.equal((await publish(tooBig)).status, 413);
  });

  test('201 carries the published shape', async () => {
    const body = await publishOk();
    assert.match(body.artifact, /^[a-z0-9]{16,}$/);
    assert.equal(body.version, 1);
    assert.equal(body.canvas, 1200);
    assert.equal(body.title, 'Kickoff deck');
    assert.equal(body.preview, `${server.shellOrigin}/a/${body.artifact}/v/1`);
  });

  test('the response never leaks a usercontent URL', async () => {
    const body = await publishOk();
    assert.ok(!JSON.stringify(body).includes('usercontent'), JSON.stringify(body));
  });

  test('title comes from <title> within the first 8 KB, and nowhere else', async () => {
    const late = 'x'.repeat(8 * 1024) + '<title>Too late</title>';
    assert.equal((await publishOk(late)).title, null);
    const early = '<title>In time</title>' + 'x'.repeat(9000);
    assert.equal((await publishOk(early)).title, 'In time');
  });

  test('a <title> inside inline SVG is not the page title', async () => {
    const svg = '<svg viewBox="0 0 10 10"><title>Logo</title><circle r="5"/></svg><title>Q3 Review</title><h1>hi</h1>';
    assert.equal((await publishOk(svg)).title, 'Q3 Review');
    assert.equal((await publishOk('<svg><title>Only a logo</title></svg><p>no title</p>')).title, null);
  });

  test('a tag inside <title> is text, the way a browser reads it', async () => {
    // <title> is RCDATA: a browser renders the tag as characters instead of parsing it.
    assert.equal((await publishOk('<title>Deck <b>v2</b></title><p>x</p>')).title, 'Deck <b>v2</b>');
  });

  test('entities in the title are decoded exactly once', async () => {
    const { artifact, title } = await publishOk('<title>Q3 &amp; Q4 &lt;draft&gt; &#8212; v2</title><p>x</p>');
    assert.equal(title, 'Q3 & Q4 <draft> — v2');
    const page = await (await fetch(`${server.shellOrigin}/a/${artifact}/v/1`, { headers: { authorization: `Bearer ${token}` } })).text();
    assert.ok(page.includes('Q3 &amp; Q4 &lt;draft&gt; — v2'), 'the Shell escapes it once, on the way out');
  });

  test('every artifact gets its own id', async () => {
    const [a, b] = await Promise.all([publishOk(), publishOk()]);
    assert.notEqual(a.artifact, b.artifact);
  });
});

describe('the data directory holds the whole system state', () => {
  test('the version lands on disk under the data directory', async () => {
    const { artifact } = await publishOk();
    const file = join(dir, 'versions', artifact, '1.html');
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file, 'utf8'), HTML);
    assert.ok(existsSync(join(dir, 'myartifacts.db')));
  });
});

describe('serving the artifact from its own origin', () => {
  test('the artifact body comes back with the fragment wrapped in a skeleton', async () => {
    const { artifact } = await publishOk();
    const res = await fetch(`${server.usercontentOrigin(artifact)}/v/1`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /^<!doctype html>/i);
    assert.ok(html.includes('<h1>Hello</h1>'));
  });

  test('CSP is default-src none with nothing that reaches the network', async () => {
    const { artifact } = await publishOk();
    const res = await fetch(`${server.usercontentOrigin(artifact)}/v/1`);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes("default-src 'none'"), csp);
    assert.ok(!csp.includes('connect-src'), csp);
    // No directive may name a scheme or host that could carry bytes off the box.
    // `frame-ancestors` is the exception: it names who may frame us, not where we may reach.
    for (const directive of csp.split(';').map((d) => d.trim())) {
      if (directive.startsWith('frame-ancestors')) continue;
      assert.ok(!/https?:|wss?:|\*/.test(directive), `directive reaches the network: ${directive}`);
    }
    assert.ok(csp.includes("form-action 'none'"), csp);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('set-cookie'), null);
  });

  test('one origin per artifact: another artifact’s host does not serve it', async () => {
    const a = await publishOk();
    const b = await publishOk('<title>Other</title><p>Other body</p>');
    const res = await fetch(`${server.usercontentOrigin(b.artifact)}/v/1`);
    assert.ok((await res.text()).includes('Other body'));
    const bogus = await fetch(`${server.usercontentOrigin('0'.repeat(32))}/v/1`);
    assert.equal(bogus.status, 404);
    assert.equal((await fetch(`${server.usercontentOrigin(a.artifact)}/v/2`)).status, 404);
  });

  test('a 404 from the usercontent origin is inert too', async () => {
    const res = await fetch(`${server.usercontentOrigin('0'.repeat(32))}/v/1`);
    assert.equal(res.status, 404);
    assert.ok((res.headers.get('content-security-policy') ?? '').includes("default-src 'none'"));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('an unknown host on the usercontent port serves nothing', async () => {
    const { port } = new URL(server.usercontentOrigin('x'));
    assert.equal((await fetch(`http://localhost:${port}/v/1`)).status, 404);
  });

  test('artifact content never comes out of the Shell origin', async () => {
    const { artifact } = await publishOk();
    assert.equal((await fetch(`${server.shellOrigin}/v/1`)).status, 404);
    const preview = await fetch(`${server.shellOrigin}/a/${artifact}/v/1`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(preview.status, 200);
    const page = await preview.text();
    assert.ok(!page.includes('<h1>Hello</h1>'), 'the Shell page must frame the artifact, not inline it');
    assert.ok(page.includes(`${server.usercontentOrigin(artifact)}/v/1`));
  });
});

describe('the injected runtime', () => {
  test('is the first script in <head> and runs before any body content', async () => {
    const { artifact } = await publishOk();
    const html = await (await fetch(`${server.usercontentOrigin(artifact)}/v/1`)).text();
    const script = html.indexOf('<script>');
    assert.ok(script > 0);
    assert.ok(script < html.indexOf('</head>'), 'runtime is in <head>');
    assert.ok(script < html.indexOf('<body'), 'runtime precedes <body>');
    assert.equal(html.slice(0, html.indexOf('<body')).match(/<script/g)?.length, 1, 'exactly one injected script');
    const runtime = html.slice(script, html.indexOf('</script>'));
    assert.ok(runtime.includes("'hello'"));
    assert.ok(!/\bdocument\.body\b/.test(runtime.split('DOMContentLoaded')[0]!), 'must not touch document.body before it exists');
  });

  test('the runtime targets the Shell origin and nothing else', async () => {
    const { artifact } = await publishOk();
    const html = await (await fetch(`${server.usercontentOrigin(artifact)}/v/1`)).text();
    assert.ok(html.includes(JSON.stringify(server.shellOrigin)));
  });
});

describe('the Shell preview page', () => {
  test('needs a token — a browser without one is sent to /login', async () => {
    const { artifact } = await publishOk();
    assert.equal((await fetch(`${server.shellOrigin}/a/${artifact}/v/1`, { redirect: 'manual' })).status, 302);
    const cookied = await fetch(`${server.shellOrigin}/a/${artifact}/v/1`, { headers: { cookie: `myartifacts=${token}` } });
    assert.equal(cookied.status, 200);
  });

  test('404 for an artifact or version that does not exist', async () => {
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${server.shellOrigin}/a/${'0'.repeat(32)}/v/1`, { headers: auth })).status, 404);
    const { artifact } = await publishOk();
    assert.equal((await fetch(`${server.shellOrigin}/a/${artifact}/v/9`, { headers: auth })).status, 404);
  });

  test('frames the artifact sandboxed, at the declared canvas width', async () => {
    const { artifact } = await publishOk(HTML, '900');
    const page = await (await fetch(`${server.shellOrigin}/a/${artifact}/v/1`, { headers: { authorization: `Bearer ${token}` } })).text();
    assert.ok(page.includes('sandbox="allow-scripts allow-same-origin allow-forms"'), page);
    // The attribute, not the page: the Shell's own source explains why the flag is missing (ticket 12).
    assert.ok(!/sandbox="[^"]*allow-downloads/.test(page));
    assert.ok(page.includes('900'));
  });
});
