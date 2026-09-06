# MyArtifacts

A client review tool. An agent publishes a page — a design mockup, a document —
to our own infrastructure; a customer opens a link, reads it, and pins comments
on it; we revise and publish again. Claude Code Artifacts is the model for the
publishing half. The feedback half is the part that can't be bought, and it is
why this exists.

Read before designing or building anything:

- `CONTEXT.md` — glossary / ubiquitous language. Use these terms exactly.
- `docs/adr/` — why the load-bearing choices were made. Don't re-litigate settled ADRs without new facts.

## Architecture

An **Artifact** (agent-generated HTML or Markdown) is published as an immutable
**Version** and served cross-origin inside an iframe. The **Shell** wraps it:
our code, our origin, holding the annotation layer and every network call. A
**Reader** is a labeled revocable link, not an account. **Annotations** are
normalized coordinates on the Version's fixed **Canvas**.

Agents publish and read Annotations over the Shell's own HTTP API, driven by a
skill rather than a client library — a CLI and an MCP server are planned as
wrappers over that API, not as separate paths into it. Keep the token in
`$MYARTIFACTS_TOKEN`; never inline it, or it lands in shell history and session
transcripts.

A new Annotation fires a `POST` to a webhook URL held in the environment — no
provider-specific code, and no email (see ADR-0001).

Publishers authenticate with a personal token, serving both the API and a
browser session on the Shell.

Settled in ADRs 0001–0010. Annotations take no replies, Versions are kept
forever with a soft delete on the Artifact, and the publisher-side Shell is a
flat gallery, one page per Artifact, and a members page for tokens (see
`.scratch/myartifacts-v1/`, local and untracked).

## Hard rules

- **Origin isolation**: every Artifact gets its own origin — isolated from the
  Shell, and from every other Artifact (ADR-0007). The one non-negotiable, and
  the reason Annotations anchor to coordinates rather than the DOM (ADR-0005).
- **The Artifact is inert, the Shell does the work.** Artifacts get
  `default-src 'none'` and no `connect-src`; all network access belongs to the
  Shell. The only script we inject into an Artifact is the runtime: the height
  beacon, the `claude.use` stub, and the comment client, all speaking to the
  Shell over one origin-checked `postMessage` transport (ADR-0010). Anything a
  page seems to need beyond this goes through the Shell, never through a
  loosened policy.
- Publish requires an explicit token. An Artifact is never public by default.

## Generating Artifacts

- Compose for the declared **Canvas** width and make it legible when that canvas
  is scaled down to a phone — most first opens are in WeChat's in-app browser.
- Keep pages small. Readers are behind a cross-border hop (ADR-0001), so page
  weight is reader-facing here in a way it isn't on a CDN. Cap at 16 MiB;
  prefer SVG and CSS over embedded raster images.
- Self-contained: inline all CSS and JS, embed images as data URIs.

## Agent skills

### Issue tracker

Local, untracked markdown under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
