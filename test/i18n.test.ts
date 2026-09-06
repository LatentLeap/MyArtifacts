// The HTTP seam, one more time, for the two languages the Shell speaks. Every page of ours is
// asked for in English and in Chinese, and what is asserted is what a browser is handed: the
// `<html lang>`, no Chinese anywhere in the English page, and no glossary term left in English
// in the Chinese one. User data in the fixtures is ASCII so it never trips either check.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { mintToken, start } from '../src/server.ts';

let dir: string;
let server: Awaited<ReturnType<typeof start>>;
let root: string;
let acme: string;
let artifact: string;
let readerUrl: string;

type Ask = { cookie?: string; method?: string; body?: string; accept?: string; lang?: 'zh' | 'en' };

/** A page, as a browser asks for it: the cookie, the `Accept-Language` it speaks, and no redirects followed. */
const get = (path: string, o: Ask = {}) =>
  fetch(`${server.shellOrigin}${path}${o.lang ? `?lang=${o.lang}` : ''}`, {
    method: o.method ?? 'GET',
    redirect: 'manual',
    headers: {
      ...(o.cookie ? { cookie: `myartifacts=${o.cookie}` } : {}),
      ...(o.accept ? { 'accept-language': o.accept } : {}),
      ...(o.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: o.body,
  });

/** CJK punctuation, the ideographs, and the full-width forms — `（非当前版）` is Chinese too. */
const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
/** The glossary's English words, whole and case-sensitive: `/api/artifacts/…` in a URL is not one. */
const TERM = /\b(Artifact|Reader|Client|Canvas|token)\b/;
/**
 * What a person can read on the page: text, the attributes a browser shows them, and the strings
 * the comment client is handed on the constants line. Everything else is code.
 */
function copyOf(html: string): string {
  const markup = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
  const attrs = [...markup.matchAll(/\b(?:title|placeholder|aria-label|data-confirm)="([^"]*)"/g)].map((m) => m[1]);
  return [markup.replace(/<[^>]+>/g, ' '), ...attrs, ...constantLines(html)].join('\n');
}
/** The page's own constants — the line the comment client, or the Publisher script, reads `T` off. */
const constantLines = (html: string) => html.split('\n').filter((l) => l.startsWith('const ART=') || l.startsWith('const T='));
/** The comment client's table, by running the line the browser runs. */
const clientTable = (html: string) =>
  new Function(`${constantLines(html)[0]};return T`)() as Record<string, string | ((...a: unknown[]) => string)>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'myartifacts-'));
  root = mintToken(dir, 'alice');
  server = await start({ dataDir: dir, shellPort: 0, usercontentPort: 0 });
  const api = (path: string, body: unknown) => fetch(`${server.shellOrigin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${root}` }, body: JSON.stringify(body),
  });
  acme = ((await (await api('/api/tokens', { name: 'acme-designer', client: 'acme' })).json()) as { token: string }).token;
  const published = await fetch(`${server.shellOrigin}/api/artifacts?canvas=1200`, {
    method: 'POST', headers: { 'content-type': 'text/html', authorization: `Bearer ${root}` },
    body: '<title>Review deck</title><h1 id="hero">Hello</h1>',
  });
  artifact = ((await published.json()) as { artifact: string }).artifact;
  const reader = (await (await api(`/api/artifacts/${artifact}/readers`, { name: 'Li' })).json()) as { url: string };
  readerUrl = reader.url;
  await fetch(`${readerUrl}/annotations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, anchor: { path: '#hero', pin: { x: 0.5, y: 0.5 }, sig: 'a'.repeat(16) }, text: 'Heading too long' }),
  });
});
after(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Every page of ours, and how a browser reaches it. */
const pages = (): [string, Ask & { path: string }][] => [
  ['dead link', { path: `/r/${'x'.repeat(43)}` }],
  ['Reader Shell', { path: new URL(readerUrl).pathname }],
  ['Publisher version view', { path: `/a/${artifact}/v/1`, cookie: root }],
  ['login', { path: '/login' }],
  ['login, refused', { path: '/login', method: 'POST', body: 'token=nope' }],
  ['gallery', { path: '/', cookie: root }],
  ['gallery, empty', { path: '/', cookie: acme }],
  ['Artifact page', { path: `/a/${artifact}`, cookie: root }],
  ['members', { path: '/members', cookie: root }],
  ['members, a Client token', { path: '/members', cookie: acme }],
  ['not found', { path: `/a/${'0'.repeat(32)}`, cookie: root }],
];

describe('every page speaks the language asked for', () => {
  test('Accept-Language: en — <html lang="en"> and not a Chinese character on the page', async () => {
    for (const [name, o] of pages()) {
      const html = await (await get(o.path, { ...o, accept: 'en-US,en;q=0.9' })).text();
      assert.match(html, /<html lang="en">/, name);
      assert.ok(!CJK.test(html), `${name}: ${html.match(new RegExp(`.{0,40}${CJK.source}.{0,40}`))?.[0]}`);
    }
  });

  test('no header — <html lang="zh"> and no glossary term left in English', async () => {
    for (const [name, o] of pages()) {
      const html = await (await get(o.path, o)).text();
      assert.match(html, /<html lang="zh">/, name);
      const copy = copyOf(html);
      assert.ok(!TERM.test(copy), `${name}: ${copy.match(new RegExp(`.{0,40}${TERM.source}.{0,40}`))?.[0]}`);
    }
  });

  test('a language we do not have falls back to Chinese', async () => {
    for (const [name, o] of pages()) {
      assert.match(await (await get(o.path, { ...o, accept: 'fr-FR,fr;q=0.8' })).text(), /<html lang="zh">/, name);
    }
  });

  test('?lang= beats the browser, so a Publisher can fix the language on a forwarded link', async () => {
    for (const [name, o] of pages()) {
      const html = await (await get(o.path, { ...o, accept: 'zh-CN,zh;q=0.9', lang: 'en' })).text();
      assert.match(html, /<html lang="en">/, name);
      assert.ok(!CJK.test(html), name);
    }
  });

  test('the strings the comment client is handed stand on their own, plurals included', async () => {
    for (const lang of ['zh', 'en'] as const) {
      // Running the page's own line is running what the browser runs: a function that reached for
      // a helper the page does not have would throw on the call.
      const T = clientTable(await (await get(new URL(readerUrl).pathname, { lang })).text());
      const said = Object.values(T).map((v) => (typeof v === 'function' ? [v(1, true), v(3, false)] : [v])).flat();
      assert.ok(said.length > 40, 'the whole client table is there');
      for (const s of said) assert.equal(typeof s, 'string');
      if (lang === 'en') assert.ok(said.every((s) => !CJK.test(s)), said.filter((s) => CJK.test(s)).join(' | '));
      else assert.ok(said.every((s) => !TERM.test(s)), said.filter((s) => TERM.test(s)).join(' | '));
    }
    const T = clientTable(await (await get(new URL(readerUrl).pathname, { lang: 'en' })).text()) as { above: (n: number) => string };
    assert.equal(T.above(1), '1 annotation above');
    assert.equal(T.above(3), '3 annotations above');
  });

  test('the answer varies by Accept-Language, so a cache never hands one language the other', async () => {
    const res = await get(`/r/${'x'.repeat(43)}`);
    assert.match(res.headers.get('vary') ?? '', /accept-language/i);
  });
});
