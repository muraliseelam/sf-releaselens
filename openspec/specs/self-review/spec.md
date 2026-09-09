# self-review Specification

## Purpose
TBD - created by archiving change 2026-09-09-self-review-harden. Update Purpose after archive.

## Requirements

### Requirement: a check that cannot read a file must say so

The remote-code scan SHALL account for every file it ships. For each shipped
file it either scans it or records it as unscanned, and the run SHALL report the
unscanned count rather than passing silently.

An unscanned file whose extension could contain executable code — anything other
than the known-inert set of images, fonts and archives — SHALL fail the run.

This is the rule the whole verifier exists to enforce, applied to the verifier:
a check that quietly stops covering something is worse than no check, because
the store declaration it backs is still being made.

#### Scenario: a new file type arrives in the build
- **WHEN** `dist/` contains a `.mjs` file
- **THEN** verification fails naming the file as unscanned, rather than passing.

#### Scenario: images and fonts
- **WHEN** `dist/` contains `.png` files
- **THEN** they are reported as unscanned-by-design and the run still passes.

### Requirement: the credential guard names what it could not read

`test/fixtures/org/no-secrets.test.ts` walks a list of source roots. When a root
is absent it SHALL fail with a message naming the root and saying that a missing
directory is not the same fact as a clean one, rather than surfacing a raw
filesystem error.

#### Scenario: a source root has been renamed
- **WHEN** a directory in the list does not exist
- **THEN** the failure names it and explains why absence is not cleanliness.

### Requirement: a failure test asserts which failure

A test asserting that a check rejects bad input SHALL assert on **what** the
check said, not merely that it said something. Asserting a non-empty finding
list passes unchanged on a check that rejects everything, which is a different
bug with the same test result.

#### Scenario: the archive screening tests
- **WHEN** a zip entry that should be rejected is screened
- **THEN** the test asserts the finding names that entry.

### Requirement: the security document accounts for every outbound path

`SECURITY.md` SHALL state the panel's one outbound link, added with the
first-run work, and SHALL say what it is not: not a request the extension makes,
not a fetch, and carrying no referrer.

#### Scenario: a reader auditing outbound traffic
- **WHEN** a reader looks for everything that could leave the panel
- **THEN** the document names the anchor as well as the two files permitted to
  call `fetch`.
