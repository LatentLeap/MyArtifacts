# Readers see the latest Version unless the publisher freezes one

Supersedes ADR-0004. Publishing a new Version is sharing it: a Reader who opens the link
sees the latest Version. The publisher may freeze an Artifact on one Version, and while it
is frozen Readers keep seeing that one no matter what is published; clearing the freeze
returns the Artifact to live. One setting per Artifact, not per Reader.

This is the default Claude Code Artifacts ships, and matching it is the point (decided
2026-09-02). The project exists to replicate what Artifacts can do for customers who
cannot reach claude.ai, and the pinned default was the one place our publishing semantics
diverged from theirs. A page that has been written for Artifacts, and a person who has
learned how Artifacts behave, should find nothing different here.

## What ADR-0004 was protecting, and where it went

ADR-0004 guarded two things: a customer opening the link mid-iteration and seeing
half-finished work, and the Annotations they left on the previous Version detaching from
the content they were about (ADR-0003). Both still happen under live, and both are
accepted. The freeze is the mitigation, and it is opt-in rather than the default: freeze,
iterate as many times as needed, unfreeze. Detachment on every publish is what ADR-0003
already handles — open Annotations carry forward as an unanchored list — so nothing new
is needed for it; it merely happens more often.

Versions themselves are not in question. An Annotation is a coordinate on one Version's
Canvas (ADR-0005), so without Versions there are no pins; and a Version costs one file and
one integer. Interactive state inside a page — a survey answer, a ticked box — is not a
Version at all: it lives in the capability bridge's `db` and never touches publishing.

## Consequences

Publishing is one call again. The `pinned` endpoint stays as the freeze: set it to a
Version to freeze, to null to unfreeze. The "no Version to show yet" placeholder page
disappears, since an Artifact is created together with its first Version.

Do not reintroduce pinned-by-default without a new fact; the trade was made knowingly.
