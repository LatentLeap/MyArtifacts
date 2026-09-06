# Annotations anchor to the DOM through the injected runtime, not to Canvas coordinates

Supersedes ADR-0005. An Annotation's anchor is `{path, pin, sig}`: a DOM path to the
element the Reader clicked, the click as a fraction of that element's box, and a signature
of the element (tag plus a hash of its normalized text). The comment client — part of the
one runtime the Shell injects into every Artifact (ADR-0010) — takes the anchor at click
time and resolves anchors back into rectangles on every render; the Shell draws the
bubble at the rectangle and never looks inside the page itself. Decided 2026-09-02, to
match Claude Code Artifacts, whose anchors have the same three parts.

ADR-0005 chose coordinates because the Shell could see nothing inside a cross-origin
Artifact. ADR-0010 made that premise false: the runtime already lives in the Artifact's
origin, and asking it for an element costs nothing more than asking it for the page
height. Coordinates were dropped entirely rather than kept as a fallback — a pin that
lands on a plausible-looking spot that is not the element the Reader meant is the
failure ADR-0003 refused to ship, and a fallback layer would reintroduce it.

## Resolution rules

- On the Version the Annotation was made on: the `path` resolves → the pin is drawn.
  It does not (the page rewrote its own DOM through `db`) → `Detached`.
- On any other Version: the `path` resolves **and** `sig` matches exactly → drawn.
  Anything else → `Detached`. This is not the fuzzy matching ADR-0003 rejected: a pin
  survives only when the same place holds the same content. ADR-0003 carries a note.
- `Detached` is a state, not a kind: the Annotation stays in the list, under
  "not shown on page", with a badge and the Version it was pinned on.

Path syntax follows Claude: a simple `#id`, else a unique `[data-id]`, else a chain of
`tag:nth-of-type(n)` segments, at most ten deep and 1000 characters. An element with no
text signs the first 2 KiB of its `outerHTML` instead.

## What was not built

No hover ring, no text-span anchors, no marquee regions, no anchorless whole-Artifact
comment. Phones have no hover, and `Detached` already is the anchorless form.

## Consequences

The Canvas stays fixed-width (carried over from ADR-0005). Rectangles come back in Canvas
pixels; the Shell scales them by the one factor it applied to the iframe, and publisher
and Reader still see identical geometry. The Shell treats `path` and `sig` as opaque
strings — stored, bounded in length, forwarded to the runtime, never parsed. The runtime
clamps nothing; the Shell clamps every rectangle to the Canvas. An Artifact whose runtime
never says hello gets no pins and no comment mode.

Anchors are reported from inside untrusted content, so a page can forge its own; Claude
has the same exposure and it is accepted. Pages that publish themselves through the
Bridge mint a Version per interaction, and the strict-match rule is what keeps pins on
the parts that did not change instead of detaching everything on every vote.
