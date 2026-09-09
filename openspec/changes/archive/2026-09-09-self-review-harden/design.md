# Design

## How the org-data search was done, so it can be checked

"We looked and found nothing" is worth as much as the description of the
looking. Four passes over the diff from `67d9e7c` to `HEAD`:

1. **Every new string that reaches a user.** The three new empty-state messages,
   the telemetry footer note, the connect-form link, the verifier's output, the
   evidence summary. None interpolates a value derived from an org: they are
   literals, or they quote the transport's own `describe`, or they name a file
   path inside `dist/`.
2. **Every new value that crosses a boundary.** The telemetry envelope is
   rebuilt from an allow-list, and a property test throws arbitrary JSON at it
   and asserts the output keys. The evidence record contains public GitHub
   counts. The verifier writes nothing at all.
3. **Every new storage key.** One: the telemetry key, holding a flag and a
   random id. It joins `DIAGNOSTIC_STORAGE_KEYS`, which measures **sizes** — so
   a diagnostic report now says how large that key is, which reveals whether
   telemetry is on and nothing else. That is the user's own setting, and a
   support report saying so is useful rather than leaky.
4. **Every new outbound path.** None, except an anchor a user can click. Which
   is the documentation finding below.

## The remote-code scan, and the shape of its failure

The scan reads `.js`, `.html`, `.css` and `.json` and skips everything else in
silence. It was written that way to avoid trying to read a PNG as text, which is
right — but "skip quietly" and "skip and say so" are different, and only the
second survives a new file type arriving.

So the scanner now partitions: scanned, or unscanned with a reason. Anything
whose extension is not on the known-inert list — images, fonts, archives — fails
the run rather than being waved through. The list is small and explicit, which
means adding a new asset type is a deliberate edit by somebody who has thought
about whether it can execute.

This matters more than its size suggests. The output of this check is pasted
into a store submission as a declaration that the extension contains no remotely
hosted code. A declaration backed by a check that silently stopped covering part
of the build is worse than one backed by nothing, because nobody is looking.

## The link, and why it is worth a paragraph in SECURITY.md

`SECURITY.md` lists what the extension deliberately does not do, and each entry
is phrased absolutely because each is enforced by something checkable. Increment
5 put an anchor to GitHub in the connect form. It is not a request the extension
makes, it fires only when a user clicks it, and `rel="noreferrer"` keeps the
extension id out of the destination's logs.

None of that changes the guarantee. But a document that lists every outbound
path and does not mention the one link is a document that will be read as wrong
by the first person who finds the anchor — and a security document loses more
from one unexplained omission than it gains from brevity.

## Why the weak assertions were weak

Both share a shape: they assert that *something* happened rather than *what*.

`expect(findings.length).toBeGreaterThan(0)` passes on a screening function that
rejects every entry in the archive, including the legitimate ones — a bug that
would break packaging entirely and that this test would not notice.

`await expect(dataSource.refresh()).resolves.toBeDefined()` passes on a refresh
that returns an empty snapshot, when the point of the test is that an unreadable
version list must not cost the user their releases.

Neither is a mistake of carelessness so much as of aim: they were written to
cover a branch, and covering a branch is what coverage measures. It is the same
gap mutation testing exists to find, arrived at by reading instead.
