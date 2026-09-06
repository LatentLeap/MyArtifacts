# Readers are links, not accounts

A Reader is a labeled, revocable, unguessable link to one Artifact. There is no signup, no
password, no email verification, and no account for the people who read what we publish.

This is deliberate and load-bearing. The project exists to replace a workflow where
customers screenshot a page and send comments over WeChat; a customer who is asked to
create an account will do exactly that instead. Friction at the comment box does not lower
the quality of feedback, it removes the feedback — and the feedback loop is the entire
justification for building this rather than sending a zip file.

Do not add customer accounts to make attribution stronger. Attribution here is an
assertion about who a link was sent to, and that is the right strength for the job.

## Consequences

Per-Reader links rather than one link per Artifact means a forward into a WeChat group is
attributable and individually revocable, instead of exposing the work to an unbounded
audience with no signal that it happened. The ceiling is real and accepted: if a Reader
hands their link to a colleague, the colleague's comments arrive under the Reader's name.
Detecting that would require authentication, which is the thing we just declined to build.

Publishers get personal tokens rather than accounts, for related but different reasons: a
token serves both the API and, pasted once, a browser session on the Shell, which means
Versions carry the name of whoever published them and one colleague's access can be
withdrawn without rotating everyone else's. A login system with password resets, for fewer
than ten people who all have SSH to the box, is machinery maintained forever against a
problem we do not have.

Publishers are not assumed to have SSH, or to be engineers at all (noted 2026-09-02: a
designer publishing mockups through an agent is a Publisher). Tokens are therefore minted
and revoked from the Shell by anyone who already holds one, with no admin role above that;
only the first token, at deployment, comes from a command on the box. The trust model
changed later: tokens now carry an optional Client, and only Client-less tokens mint or
revoke tokens (ADR-0008).

This does mean the Shell origin holds an auth cookie — precisely the credential ADR-0007
keeps Artifacts away from. No Artifact content may ever be served from the Shell origin,
not even as a preview.
