// `downloads` never touches the server: the bytes go frame → Shell over the Bridge, and the file
// is saved by an anchor on the Shell's own origin. There is no HTTP seam to test, so what these
// assert is what the Shell page carries — the sandbox that makes the Shell the only way out, and
// the rules it enforces. The behaviour itself is the browser seam, run for real (see the ticket).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { mintToken, start } from '../src/server.ts';

let dir: string;
let server: Awaited<ReturnType<typeof start>>;
let page: string;
let runtime: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'myartifacts-'));
  const token = mintToken(dir, 'alice');
  server = await start({ dataDir: dir, shellPort: 0, usercontentPort: 0 });
  const auth = { authorization: `Bearer ${token}` };
  const published = await fetch(`${server.shellOrigin}/api/artifacts?canvas=1200`, {
    method: 'POST', headers: { 'content-type': 'text/html', ...auth }, body: '<title>导出示例</title><button>下载</button>',
  });
  assert.equal(published.status, 201);
  const { artifact } = (await published.json()) as { artifact: string };
  const reader = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ name: '王工' }),
  });
  assert.equal(reader.status, 201);
  page = await (await fetch(((await reader.json()) as { url: string }).url)).text();
  runtime = await (await fetch(`${server.usercontentOrigin(artifact)}/v/1`)).text();
});
after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the frame is never allowed to save anything itself', () => {
  test('the iframe is granted no downloads', () => {
    const sandbox = /<iframe id="f"[^>]*sandbox="([^"]*)"/.exec(page)?.[1];
    assert.equal(sandbox, 'allow-scripts allow-same-origin allow-forms');
  });

  test('`downloads` is offered all the same: a refusal is on the call, never a missing namespace', () => {
    assert.ok(/"caps":\[[^\]]*"downloads"/.test(page));
  });
});

describe('the rules the Shell page carries', () => {
  /** The allowlist as it ships, read back out of the page rather than matched as a string. */
  const allowlist = (): Record<string, string> => {
    const src = /const MIME=(\{[\s\S]*?\});/.exec(page)?.[1];
    assert.ok(src, 'the Shell page carries the extension allowlist');
    return new Function(`return ${src}`)() as Record<string, string>;
  };
  /** Everything `save` can answer with, in the order the checks are written. */
  const codes = (): string[] => {
    const body = /async function save\(req\)\{[\s\S]*?\n\}/.exec(page)?.[0];
    assert.ok(body, 'the Shell page carries the save itself');
    return [...body.matchAll(/code:'(\w+)'/g)].map((m) => m[1]!);
  };

  // The contract's two groups: `gif png jpg jpeg webp mp4 webm txt json md` and
  // `docx pptx epub csv ttf html svg pdf xlsx`. Nineteen words for the eighteen formats everyone
  // counts — jpg and jpeg are one — and both spellings have to be here or a page loses `.jpeg`.
  const CONTRACT = 'gif png jpg jpeg webp mp4 webm txt json md docx pptx epub csv ttf html svg pdf xlsx'.split(' ');

  test('the contract’s extensions, and not a twentieth', () => {
    assert.deepEqual(Object.keys(allowlist()).sort(), [...CONTRACT].sort());
  });

  test('every one of them names a MIME type: the extension decides it, not the Blob', () => {
    const list = allowlist();
    for (const [ext, type] of Object.entries(list)) assert.match(type, /^[a-z]+\/[\w.+-]+$/, ext);
    assert.equal(list.jpg, list.jpeg);
  });

  test('16 MiB, the same cap the publish door counts', () => {
    assert.ok(/const MAX_SAVE=16\*1024\*1024/.test(page));
  });

  test('every code the contract names, and the Reader is asked only once nothing else has refused', () => {
    assert.deepEqual(codes(), ['bad_request', 'request_unknown', 'rejected_extension', 'too_large', 'rate_limited', 'declined'],
      'in the order they are checked: name, size and the open prompt are settled before anyone is asked');
  });

  test('the anchor that saves the file is the Shell’s own, and is in the document when it is clicked', () => {
    assert.ok(page.includes('URL.createObjectURL(blob)'), 'the bytes become a blob on our origin');
    assert.ok(page.includes('document.body.append(link);link.click()'), 'WebKit saves nothing from a detached anchor');
  });
});

describe('the little the runtime does with it', () => {
  test('an ArrayBuffer is handed over rather than copied, so the page’s own is detached after', () => {
    assert.ok(runtime.includes('r.data instanceof ArrayBuffer ? [r.data] : undefined'));
    assert.ok(runtime.includes('parent.postMessage(m, SHELL, transfer)'));
  });

  test('an argument that cannot leave the page is answered, not left pending', () => {
    assert.ok(runtime.includes("reject({ code: 'bad_request'"));
  });
});
