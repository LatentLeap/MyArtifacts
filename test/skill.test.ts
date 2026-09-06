// The HTTP seam, from the agent's side: the skill is one file in the repo, handed out verbatim
// and unauthenticated, and the round it documents — publish, link, read, next Version, addressed
// — is walked here with the calls exactly as the skill spells them.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { mintToken, start } from '../src/server.ts';

let dir: string;
let server: Awaited<ReturnType<typeof start>>;
let token: string;

const SKILL = readFileSync(new URL('../skills/myartifacts/SKILL.md', import.meta.url), 'utf8');

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'myartifacts-'));
  token = mintToken(dir, 'alice');
  server = await start({ dataDir: dir, shellPort: 0, usercontentPort: 0 });
});
after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the skill as served', () => {
  test('/skill.md is the repo file, verbatim and without a token', async () => {
    const res = await fetch(`${server.shellOrigin}/skill.md`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/markdown/);
    assert.equal(await res.text(), SKILL);
  });

  test('names no host and no token: only the two variables', () => {
    assert.equal(SKILL.match(/https?:\/\//g), null);
    // A token and a Reader secret are both 43 base64url characters, so nothing that long and that
    // shaped belongs in a file served to anyone who asks — prose never runs that far without a break.
    assert.equal(SKILL.match(/[A-Za-z0-9_-]{32,}/g), null);
    assert.match(SKILL, /\$MYARTIFACTS_URL/);
    assert.match(SKILL, /\$MYARTIFACTS_TOKEN/);
  });

  test('every curl carries -fsS and the bearer variable', () => {
    const calls = SKILL.split('\n').filter((l) => l.includes('curl '));
    assert.ok(calls.length >= 6);
    for (const call of calls) assert.match(call, /curl -fsS -H "Authorization: Bearer \$MYARTIFACTS_TOKEN"/);
  });
});

// One agent, two environment variables, one round. Every call below is copied from the skill's
// own text, so a step that drifts out of the server fails here rather than in front of a customer.
describe('the round the skill documents', () => {
  test('publish, link, read, publish again, address', async () => {
    const auth = { authorization: `Bearer ${token}` };

    // Entry 0's health check ends at a Canvas and a body under the cap; entry 1 step 2 publishes it.
    const first = await fetch(`${server.shellOrigin}/api/artifacts?canvas=960`, {
      method: 'POST', headers: { 'content-type': 'text/html', ...auth },
      body: '<title>官网改版</title><h1 id="hero">Hello</h1>',
    });
    assert.equal(first.status, 201);
    const { artifact, version, preview } = (await first.json()) as
      { artifact: string; version: number; preview: string };
    assert.equal(version, 1);
    assert.equal(preview, `${server.shellOrigin}/a/${artifact}/v/1`);

    // Step 4: the first publish gets a Reader link, and the Publisher forwards it.
    const made = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ name: '王工' }),
    });
    assert.equal(made.status, 201);
    const { url } = (await made.json()) as { url: string };

    // The customer pins one. (Not a skill call — this is the other half of the round.)
    const pinned = await fetch(`${url}/annotations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, anchor: { path: '#hero', pin: { x: 0.25, y: 0.5 }, sig: '0123456789abcdef' }, text: 'logo 太小了' }),
    });
    assert.equal(pinned.status, 201);

    // Entry 2: trust the list.
    const open = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/annotations?status=open`, { headers: auth });
    assert.equal(open.status, 200);
    const items = (await open.json()) as { annotation: string; version: number; text: string }[];
    assert.equal(items.length, 1);
    const [item] = items;
    assert.ok(item);
    assert.equal(item.text, 'logo 太小了');

    // Entry 1 again: the next Version says what changed, and no second Reader is made.
    const second = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/versions?canvas=960`, {
      method: 'POST', headers: { 'content-type': 'text/html', ...auth },
      body: '<title>官网改版</title><p>本版改动：logo 放大。</p><h1 id="hero">Hello</h1>',
    });
    assert.equal(second.status, 201);
    assert.equal(((await second.json()) as { version: number }).version, 2);

    // Step 5: published first, addressed second.
    const flip = await fetch(`${server.shellOrigin}/api/annotations/${item.annotation}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ status: 'addressed' }),
    });
    assert.equal(flip.status, 200);
    assert.equal(((await flip.json()) as { status: string }).status, 'addressed');

    const left = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/annotations?status=open`, { headers: auth });
    assert.deepEqual(await left.json(), []);

    // The readers list still holds exactly the one link the first publish made.
    const readers = await fetch(`${server.shellOrigin}/api/artifacts/${artifact}/readers`, { headers: auth });
    assert.equal(((await readers.json()) as unknown[]).length, 1);
  });
});
