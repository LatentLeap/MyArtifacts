// Markdown publishing, at the same HTTP seam as ticket 01. A Version file is always HTML:
// the render happens once, on the way in, and nothing downstream can tell how it arrived.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { mintToken, start } from '../src/server.ts';

const MD = '# Kickoff notes\n\nBody copy with **bold** and a [link](https://example.com).\n';

let dir: string;
let server: Awaited<ReturnType<typeof start>>;
let token: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'myartifacts-md-'));
  token = mintToken(dir, 'alice');
  server = await start({ dataDir: dir, shellPort: 0, usercontentPort: 0 });
});
after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

type Published = { artifact: string; version: number; canvas: number; title: string | null; preview: string };

const post = (path: string, body: string, type = 'text/markdown', canvas = '1200') =>
  fetch(new URL(`${path}?canvas=${canvas}`, server.shellOrigin), {
    method: 'POST',
    headers: { 'content-type': type, authorization: `Bearer ${token}` },
    body,
  });

const publishMd = async (body = MD): Promise<Published> => {
  const res = await post('/api/artifacts', body);
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return JSON.parse(text) as Published;
};

describe('publishing Markdown', () => {
  test('POST /api/artifacts takes text/markdown and titles it from the first #', async () => {
    const body = await publishMd();
    assert.equal(body.version, 1);
    assert.equal(body.canvas, 1200);
    assert.equal(body.title, 'Kickoff notes');
  });

  test('a Markdown page with no # is refused: there is nowhere else to take a title from', async () => {
    const res = await post('/api/artifacts', 'Just a paragraph, no heading anywhere.\n');
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'invalid_argument');
  });

  test('the Version on disk is HTML, not the Markdown that was sent', async () => {
    const { artifact } = await publishMd();
    const file = readFileSync(join(dir, 'versions', artifact, '1.html'), 'utf8');
    assert.ok(file.includes('<h1>Kickoff notes</h1>'), file.slice(0, 200));
    assert.ok(!file.includes('# Kickoff notes'), 'the Markdown source is not what is kept');
  });

  test('the Reader gets the same wrapped HTML an HTML publish would have given', async () => {
    const { artifact } = await publishMd();
    const res = await fetch(`${server.usercontentOrigin(artifact)}/v/1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    const html = await res.text();
    assert.match(html, /^<!doctype html>/i);
    assert.ok(html.includes('<h1>Kickoff notes</h1>'));
    assert.ok(html.includes('<strong>bold</strong>'), 'the Markdown really was rendered');
    assert.ok(html.includes('<script>'), 'and it carries the same injected runtime');
  });

  test('a new Version takes Markdown too, over an Artifact that started as HTML', async () => {
    const first = await post('/api/artifacts', '<title>Started as HTML</title><p>hi</p>', 'text/html');
    const { artifact } = (await first.json()) as Published;
    const res = await post(`/api/artifacts/${artifact}/versions`, '# Now in Markdown\n\nSecond pass.\n');
    const text = await res.text();
    assert.equal(res.status, 201, text);
    const v2 = JSON.parse(text) as Published;
    assert.equal(v2.version, 2);
    assert.equal(v2.title, 'Now in Markdown');
    const html = await (await fetch(`${server.usercontentOrigin(artifact)}/v/2`)).text();
    assert.ok(html.includes('<h1>Now in Markdown</h1>'));
    // ...and the version before it is untouched: a Version is immutable whatever it was written in.
    assert.ok((await (await fetch(`${server.usercontentOrigin(artifact)}/v/1`)).text()).includes('<p>hi</p>'));
  });

  test('a new Version with no # is refused, and mints nothing', async () => {
    const { artifact } = await publishMd();
    assert.equal((await post(`/api/artifacts/${artifact}/versions`, 'no heading here\n')).status, 400);
    assert.equal((await fetch(`${server.usercontentOrigin(artifact)}/v/2`)).status, 404);
  });

  test('a # inside a fenced code block is not the title', async () => {
    const fenced = '```\n# Not the title\n```\n\n# The real title\n\ndone\n';
    assert.equal((await publishMd(fenced)).title, 'The real title');
    assert.equal((await post('/api/artifacts', '```\n# Only in a fence\n```\n')).status, 400);
  });

  test('the rendered page is self-contained: nothing in it reaches the network', async () => {
    const { artifact } = await publishMd('# Style check\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n');
    const html = await (await fetch(`${server.usercontentOrigin(artifact)}/v/1`)).text();
    // The link in the body copy is the author's own text; what must not appear is anything we
    // added that fetches — a stylesheet, a font, a script from somewhere else.
    assert.ok(!/<link\b/i.test(html), 'no external stylesheet');
    assert.ok(!/<script[^>]+\bsrc=/i.test(html), 'no external script');
    assert.ok(!/@import|url\(\s*['\"]?https?:/i.test(html), 'no CSS that fetches');
    assert.ok(html.includes('<style>'), 'the document typography is inlined instead');
  });

  test('a byte-order mark ahead of the # does not cost the document its title', async () => {
    // Agents write these files; some editors and writers put a BOM on the front.
    assert.equal((await publishMd('\uFEFF# Marked up front\n\nbody\n')).title, 'Marked up front');
  });

  test('the 16 MiB cap counts the rendered page, which is what a Reader downloads', async () => {
    // Table rows expand about 5.5x on the way through the renderer, so a body that arrives
    // comfortably under the cap can still land over it.
    const rows = '|a|\n'.repeat(3 * 1024 * 1024 / 4);
    const src = `# Too big rendered\n\n|a|\n|-|\n${rows}`;
    assert.ok(src.length < 16 * 1024 * 1024, 'the request body itself is under the cap');
    const res = await post('/api/artifacts', src);
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'too_large');
  });
});
