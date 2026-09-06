# Annotations are scoped to a Version; anchors die, threads don't

**Amended by ADR-0011 (2026-09-02).** An anchor is still made on one Version, but it is now
shown on a later Version when its DOM path resolves *and* its element signature is unchanged
— exact equality, not the fuzzy matching rejected below. Everything else here stands.

An Annotation's anchor belongs to the Version it was made in. Republishing mints a new
Version with no anchored Annotations on it. Annotations still open carry forward into
later Versions as an unanchored list until someone marks them addressed.

The reason is that Artifacts are not edited, they are regenerated. The agent rewrites the
page wholesale on every publish, so DOM structure, class names, element order, and text
are all fresh — there is no stable identity for an anchor to survive against. Re-anchoring
comments across Versions would mean fuzzy-matching against an adversarially unstable
target: the most expensive thing available to build here, and still wrong often enough
that Readers would stop trusting the pins.

## Considered options

- **Carry anchors forward by selector or text matching.** What Figma and Pastel do — but
  they own the document model and their edits are incremental. Ours are full rewrites.
  Do not re-propose without a plan for regenerated markup.
- **Coordinate anchors carried forward blindly.** The same failure with none of the
  effort: one layout change and every pin silently points at nothing.
- **No anchoring at all — one thread per Artifact.** Survives everything, but loses
  *which* element the Reader meant, which is most of the value on a design mockup.

## Consequences

The version history becomes the record of the review: v1 and its five comments, v2 and its
two, v3 approved. That is the shape of the process anyway, so nothing has to be
reconstructed at the end.

Carrying open Annotations forward is what keeps "I asked for this to be blue and it still
isn't" checkable from the current Version, which a clean slate per Version would have
lost. It also means anchors never need to survive anything — which frees the anchoring
mechanism itself to be as simple as the content allows.
