# test-quality

What this capability is for: making it possible to tell a test that pins
behaviour from a test that merely visits a line, and making the credential paths
the first thing measured rather than the only thing unmeasured.

## ADDED Requirements

### Requirement: every source directory that ships is measured

The coverage `include` list SHALL name every directory under `src/` whose code
reaches the packaged extension, `src/auth/**` included. A file may be excluded
only when it is wiring with no logic of its own, and the exclusion SHALL carry a
comment saying so.

#### Scenario: the auth directory is measured
- **WHEN** `npm run test:coverage` runs
- **THEN** `src/auth/oauth.ts` and `src/auth/pkce.ts` appear in the report.

#### Scenario: the reported number changes
- **WHEN** including a previously unmeasured directory moves the totals
- **THEN** the thresholds are set from the new totals, and the comment beside
  them states the real figures.

### Requirement: the session is cleared whenever a connection cannot complete

Every path that abandons a connection SHALL clear the stored session before
raising. A half-connected state that keeps a refresh token is the failure this
requirement exists to prevent, and each such path SHALL have a test that asserts
storage is empty afterwards — not merely that an error was thrown.

#### Scenario: the org returns tokens but no instance URL
- **WHEN** the token response carries an access and refresh token and no
  `instance_url`
- **THEN** connecting fails with a named error **and** the session storage key
  is gone.

#### Scenario: the refresh response cannot be adopted
- **WHEN** a refresh returns HTTP 200 with a body carrying no access token
- **THEN** the call fails as expired auth, the session is cleared, and no retry
  is attempted.

#### Scenario: the refresh request itself fails
- **WHEN** the token endpoint rejects the refresh
- **THEN** the failure names the reason, the session is cleared, and the
  message contains no part of the refresh token.

### Requirement: a failure that cannot be described must still be reported

Error construction SHALL survive any cause: a string, a number, a boolean,
`null`, `undefined`, a symbol, and an object that cannot be serialised. In no
case may describing the cause replace the original failure with a serialisation
failure.

#### Scenario: a circular object is the cause
- **WHEN** an error is constructed with a cause containing a cycle
- **THEN** the message says the object could not be serialised, and the error is
  still the original error type.

#### Scenario: storage rejects a value that cannot be measured
- **WHEN** `chrome.storage` reports a quota failure while writing a value that
  `JSON.stringify` throws on
- **THEN** a quota error is raised, sized zero rather than crashing in the
  measurement.

### Requirement: mutation testing runs against the logic, and its score is published

Stryker SHALL run against `src/core/**` and `src/data/**` only, through
`npm run mutate`. It SHALL NOT run in `npm run check` or in the default CI job,
because it takes minutes; a manually-triggered workflow is where it belongs.

`docs/MUTATION.md` SHALL record the score as measured, the date, and the
survivors that represent a real gap — distinguished from those that are
equivalent mutants. A score presented without its survivors is a number, not a
finding.

#### Scenario: the score is worse than the coverage figure suggests
- **WHEN** mutation testing reports a score below the statement coverage
- **THEN** the difference is written down rather than the run being re-scoped
  until the number improves.

#### Scenario: a survivor reveals a test that asserts nothing
- **WHEN** a mutant survives because a test calls a function without asserting
  on its result
- **THEN** that test is fixed and the fix is named in `docs/MUTATION.md`.
