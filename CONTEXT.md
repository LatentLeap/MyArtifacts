# Context

Ubiquitous language for MyArtifacts — self-hosted publishing of agent-generated pages to
customers who cannot reach claude.ai, and the collection of their feedback.

## Language

**Artifact**:
A self-contained page produced by an agent — a design mockup, a document — that a Reader
is meant to read. Inert by design: no network access, no credentials, and it never learns
who is reading it. The sole exception is the runtime in the wrapper we serve it in, which
reports layout height, carries `claude.use` calls, and reports comment anchors to the
Shell over the Bridge — and grants the Artifact no network of its own.
_Avoid_: Page, document, file, site
_Shown as_: 工件 (zh), Artifact (en)

**Shell**:
The application surrounding an Artifact in the Reader's browser: it frames the Artifact in
a cross-origin iframe, draws the annotation layer over it, and makes every network call on
the Reader's behalf. The trust boundary of the whole system — Shell code is ours, Artifact
content is not, and the two are separated by the origin rather than by review. The Shell
can see the Artifact's rectangle and nothing inside it, which is a property to preserve
rather than a limitation to work around.
_Avoid_: Wrapper, host page, viewer frame

**Canvas**:
The layout width an Artifact is composed for, declared when it is published and scaled by
the Shell to fit whatever viewport opens it — narrow for a document, wide for a mockup.
Fixed rather than reflowing, so that a Reader on a phone, a Reader on a laptop, and the
publisher are all looking at identical geometry.
_Avoid_: Viewport, breakpoint, layout width, frame
_Shown as_: 画布 (zh), Canvas (en)

**Publisher**:
Someone on our side who creates Artifacts and decides which Version Readers see.
Authenticated by a personal token rather than an account, so a Version carries the name of
whoever published it and one person's access can be withdrawn without disturbing anyone
else's.
_Avoid_: Author, owner, admin, user
_Shown as_: 发布方 (zh), Publisher (en); the token is 令牌 (zh), token (en)

**Client**:
The customer a token publishes for. A label chosen when the token is minted and copied
onto every Artifact that token publishes; both are fixed for life. A token with no Client
is one of us and sees everything; a token with a Client sees only that Client's Artifacts
and has the full Publisher powers there. Not a table and not a place: there is nothing to
join or invite, only a value to compare. The domain a customer-side *Publisher* belongs
to — not to be confused with a Reader, who is a customer-side person who *reads*.
_Avoid_: Workspace, project, tenant, organization, team
_Shown as_: 客户 (zh), Client (en)

**Bridge**:
The one `postMessage` channel between the runtime inside an Artifact and the Shell around
it, carrying the same capability contract a page would find inside Claude Code Artifacts —
`db`, `user`, `downloads`, `artifact` — so a page written there runs here unchanged. Every
capability is offered to every Artifact without declaration; what is not offered resolves
to nothing, as the contract requires pages to expect. The Bridge is how an Artifact reaches
the world, and the Shell is on the other end of every call.
_Avoid_: API, SDK, runtime (that is the injected script, not the channel), postMessage

**Reader**:
A named recipient of one Artifact, existing only as an unguessable link. The name is fixed
by whoever created the link and is never editable by the person holding it — a Reader is
the publisher's claim about who a link was sent to, not the holder's claim about
themselves, so a forwarded link still speaks under the original name. Revocable one at a
time.
_Avoid_: Viewer, guest, invitee, recipient, share link
_Shown as_: 收件人 (zh), Reader (en)

**Version**:
One publish of an Artifact. Republishing never edits — it mints the next Version and
leaves the previous one intact and readable at its own address. Readers see the latest
Version unless the publisher has frozen the Artifact on one, in which case that one holds
until unfrozen; it is one setting per Artifact, not per Reader. A page may also publish itself through the Bridge, and that too is a Version,
attributed to whoever was holding the page — a Reader included. Interactive state a page
keeps outside itself — a survey answer, a ticked box — lives in the Bridge's `db` and
publishing does not touch it.
_Avoid_: Revision, draft, update, snapshot
_Shown as_: 版本 (zh), Version (en); frozen is 冻结 (zh)

**Annotation**:
A Reader's comment, anchored to an element of the Version it was made on — a DOM path,
a point inside that element, and a signature of its content — and carrying a status of
open or addressed. A single remark, never a thread: nobody replies to it. The publisher
answers with the next Version; a Reader with more to say pins another. Its author may
withdraw it while it is still open; once addressed it is part of the record. On every
render the anchor is resolved again against whatever Version is on screen: on its own
Version it shows wherever its path leads; on a later Version only if the same path holds
the same content, unchanged. Otherwise it is **Detached** — still listed, no longer drawn.
Belongs to the Shell, never to the Artifact: the Artifact cannot read Annotations, write
them, or know they exist, though the runtime inside it is what reports and resolves the
anchor.
_Avoid_: Comment, note, feedback, markup
_Shown as_: 批注 (zh), Annotation (en); open / addressed are 未解决 / 已解决 (zh); Detached is the sentence
位置已失效 (zh), Detached (en)

Not to be confused with Claude Code's use of the word, where an "annotated diff" means
notes the agent wrote *into* the page as content. Those are Artifact content and have no
name of their own here. An Annotation always comes from a Reader.
