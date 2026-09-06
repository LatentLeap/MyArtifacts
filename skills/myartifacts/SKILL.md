---
name: myartifacts
description: Publish a self-contained page to MyArtifacts, hand a customer a link, and read the Annotations they pin on it. Use when asked to publish a page for a customer, move a Claude Code artifact onto MyArtifacts, read what a customer pinned on a published page, or mark an Annotation addressed.
---

# MyArtifacts

Publish a page as a Version, give a customer a Reader link, read what they pinned on it, publish
the next Version. Nothing here waits for feedback: a person tells you when to go read it.

## Before anything

Two environment variables, both required:

- `MYARTIFACTS_URL` — the Shell's origin.
- `MYARTIFACTS_TOKEN` — a publisher token.

Missing either one: **stop and ask.** Do not guess a host, do not look for a token anywhere else,
do not carry on with one of the two.

That token belongs to a **Publisher** — the person on our side who decides what customers see. You
act with it, so wherever this skill says to stop and ask, they are who you ask.

Every call below is the same prefix:

```bash
curl -fsS -H "Authorization: Bearer $MYARTIFACTS_TOKEN" …
```

`-fsS` on every one, so a failure is a non-zero exit and not a body you mistake for success. Keep
the token in the variable — spelling it out puts it in shell history and in this transcript.

Writing the page is not taught here. Use `artifact-design` and `artifact-diagramming` for that;
this skill covers publishing and the few places MyArtifacts differs from Claude Code Artifacts.

Three entry points. Pick by what you were handed.

---

## Entry 0 · Migration — a Claude Code artifact becomes a MyArtifact

You have HTML that ran inside Claude Code Artifacts. An Artifact here is served with
`default-src 'none'` and no network of its own, so anything it fetches at runtime is simply gone.

**Make it self-contained.**

- CDN `<script src>` (cdnjs, jsdelivr, Tailwind's play CDN, jQuery) — fetch the file once, at
  authoring time, and inline it. A pinned version is what you fetch; nothing resolves at runtime.
- Google Fonts — inline the CSS and the woff2 as data URIs, or drop the face and keep a real
  system fallback stack. A blocked stylesheet fails silently and the page reflows into something
  you never reviewed.
- Mermaid — pre-render each diagram to inline SVG. There is no diagram renderer on the other side.
- Images — data URIs. Prefer SVG and CSS; a raster image is weight a customer pays for over a
  cross-border hop.
- `favicon`, `description`, and a `title` publish parameter have no equivalent — drop them. The
  title is read from the page's own `<title>` (first 8 KB), or from a Markdown document's first
  `#` heading.

**Scan the capabilities it uses. Warn, never refuse** — the contract already requires a page to
cope with a capability that resolves to nothing, so a page that uses one still publishes.

| In the page | Here |
|---|---|
| `use("db")`, `use("user")`, `use("downloads")` | Work. `downloads.save` asks the Reader to confirm. |
| `use("artifact")`, self-publishing | Works, and **every publish mints a Version.** A page that republishes on each interaction mints a Version per interaction. Say so; keep it to deliberate saves. |
| `use("room")`, `use("sample")`, `use("mcp")` | `null`. Whatever they drove is inert. |
| Custom `rules` on `db` | Ignored. Only the defaults hold: the root is readable and writable by everyone with the link, and `data/users/{self}` is private to one caller. Anything the page assumed a rule enforced, it no longer enforces. |
| `user.profiles()`, `artifact` multi-file `files`, `edit`, `sync` | `capability_removed`. |

**Check it over.** Under 16 MiB. A Canvas you can name — the width the page was composed for; if
nothing in the page declares one, use **960**. Legible when that width is scaled down to a phone:
most first opens are in WeChat's in-app browser.

Then go to Entry 1, step 2.

---

## Entry 1 · Publish a Version, first or next

**1. When this is not the first Version, say at the top of the page what changed.** One line per
open Annotation: what changed, or *not changing, because …*. A "not changing" is the Publisher's
call, never yours — ask, and use their words.

**2. Publish.** The body is the file itself. Never send `?base=` — that parameter is for a page
publishing itself, not for you.

A new Artifact (an internal token may add `&client=<slug>` to publish on a customer's behalf):

```bash
curl -fsS -H "Authorization: Bearer $MYARTIFACTS_TOKEN" \
  -H 'Content-Type: text/html' --data-binary @page.html \
  -X POST "$MYARTIFACTS_URL/api/artifacts?canvas=1200"
```

A new Version of one that exists:

```bash
curl -fsS -H "Authorization: Bearer $MYARTIFACTS_TOKEN" \
  -H 'Content-Type: text/html' --data-binary @page.html \
  -X POST "$MYARTIFACTS_URL/api/artifacts/$ID/versions?canvas=1200"
```

Both answer `201 {artifact, version, canvas, title, preview}`. For a Markdown document, send
`-H 'Content-Type: text/markdown'` and give it a `#` heading to take a title from.

**3. Freeze, if you were asked to.** Readers see the newest Version by default. Freezing holds
them on one while you iterate:

```bash
curl -fsS -H "Authorization: Bearer $MYARTIFACTS_TOKEN" -H 'Content-Type: application/json' \
  -X PUT "$MYARTIFACTS_URL/api/artifacts/$ID/pinned" -d '{"version": 3}'
```

Unfreeze with `{"version": null}` once the new Version is the one to show. Leave it frozen and
nobody sees anything you publish afterwards.

**4. On a first publish only, create a Reader link.**

```bash
curl -fsS -H "Authorization: Bearer $MYARTIFACTS_TOKEN" -H 'Content-Type: application/json' \
  -X POST "$MYARTIFACTS_URL/api/artifacts/$ID/readers" -d '{"name": "王工"}'
```

`201 {reader, name, url}`. The name is fixed at creation and is the publisher's claim about who
the link went to. Hand the `url` to the Publisher to forward — you do not send it anywhere. Every
later Version reuses the same link: **never create a second Reader for one.**

**5. Publish first, then mark annotations addressed.** In that order, so the Reader who follows
the link sees the fix rather than a claim of one.

```bash
curl -fsS -H "Authorization: Bearer $MYARTIFACTS_TOKEN" -H 'Content-Type: application/json' \
  -X PATCH "$MYARTIFACTS_URL/api/annotations/$AID" -d '{"status":"addressed"}'
```

Mark only what you actually changed, plus what the Publisher decided not to change. Anything you
did not understand stays open.

**6. Report:** the Artifact id, the Version number, the Reader url (first publish), and how many
annotations you marked addressed.

---

## Entry 2 · Read the Annotations

When the Publisher says to go read them. There is no polling and no waiting.

```bash
curl -fsS -H "Authorization: Bearer $MYARTIFACTS_TOKEN" \
  "$MYARTIFACTS_URL/api/artifacts/$ID/annotations?status=open"
```

**Trust this list, not a webhook payload.** A webhook is a nudge to come here; it is not the
record, it is not ordered, and it is not complete.

Sort every item into one of three:

- **Understood** → onto the list for the next Version.
- **Not understood** → leave it open and give the Publisher the question to ask on WeChat. Do not
  guess at what a customer meant and do not answer in the page.
- **Nothing to respond to** ("looks good") → leave it alone.

To see what an Annotation is pointing at, open `$MYARTIFACTS_URL/a/$ID/v/$N#$AID` — the version
and the annotation id come from the list item. That page needs a browser session, so it is the
Publisher who opens it.

For state the page itself keeps — a poll's votes, a checklist's ticks — one RPC door:

```bash
curl -fsS -H "Authorization: Bearer $MYARTIFACTS_TOKEN" -H 'Content-Type: application/json' \
  -X POST "$MYARTIFACTS_URL/api/artifacts/$ID/db" -d '{"method":"query","collection":"votes"}'
```

`method` is `get`, `set`, `update`, `delete`, `query` or `acquire`. Someone else's private subtree
under `data/users/` reads as absent — that is the design, not a missing row, so never report a
sealed answer as a zero.

Then go to Entry 1.

---

## When a call fails

One action per code. **Never loop.**

| Code | What it is | Do this, once |
|---|---|---|
| `400 invalid_argument` | `canvas` missing or not a width; Markdown with no `#` heading; a malformed body | Fix it and send again. Can't see the fix → stop, ask. |
| `413 too_large` | Over 16 MiB — for Markdown, after it renders | Slim it once: drop raster images, prefer SVG. Still over → stop, ask. |
| `415 unsupported_media_type` | `Content-Type` is neither `text/html` nor `text/markdown` | Set the header and send again. |
| `401` | The token is wrong or revoked | Stop. Tell the Publisher. Never try another token. |
| `404` | No such Artifact or Annotation — or another Client's, or deleted. Deliberately indistinguishable | Stop. Tell the Publisher the id you used. |
| `409 conflict`, `423 not_writer` | Only reachable with `?base=`, which you never send | Stop. Report it — something else published, or you sent `base`. |
| `429 resource_exhausted` | You are calling faster than 20/s — the db door and its bucket | Wait a second and send it once more. Still 429 → stop. |
| `429 quota_exceeded` | This Artifact is at its 5,000-document ceiling | Stop. Tell the Publisher; nothing you send will fit. |
| `5xx`, timeout | The other end | Retry once. Then stop. |

Published the wrong thing? **Publish another Version.** Versions are never deleted and never
edited. If the webhook did not fire, that is not this skill's problem — the list is.

## Three ways a page goes wrong here

- `id="status"` on an element collides with `window.status`, which is a string. Any `id` that
  shadows a `window` property will bite; that one bites most.
- `artifact.publish` returning `conflict` means this view is behind, not that the write is bad.
  Reload to the winning Version. Never retry blind.
- Pins anchor to a DOM path plus a signature of the content there. Give every large, stable block
  a stable `id`, or a pin will detach on the next Version — still listed, no longer drawn.

## Not this skill's job

- Replying to an Annotation. Nobody can reply, you included: the answer is the next Version and an
  `addressed` status.
- Waiting for feedback.
- Deleting a Version or an Artifact, revoking a Reader, minting a token. The Publisher does those
  in the Shell.
