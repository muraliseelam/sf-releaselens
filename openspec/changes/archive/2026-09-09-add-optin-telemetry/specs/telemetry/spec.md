# Telemetry

## ADDED Requirements

### Requirement: Off unless explicitly enabled
Telemetry SHALL be disabled on a fresh install and SHALL remain disabled until a
user explicitly enables it through the panel. The system SHALL NOT prompt for
it, pre-check it, or present it as recommended.

#### Scenario: A fresh install
- **WHEN** the extension is installed and the panel is opened
- **THEN** telemetry reports disabled
- **AND** no install id exists in any storage area
- **AND** no telemetry event is recorded by anything

#### Scenario: The control itself
- **WHEN** the panel renders the privacy control
- **THEN** it is an unchecked checkbox
- **AND** its label states exactly what would be sent
- **AND** nothing in the UI encourages enabling it

### Requirement: An identifier exists only if telemetry is on
The system SHALL generate the random install id lazily, on first enablement, and
SHALL delete it when telemetry is disabled.

#### Scenario: Enabling
- **WHEN** a user enables telemetry
- **THEN** a random id is generated and stored
- **AND** it is a random value with no relation to the user, browser or org

#### Scenario: Disabling
- **WHEN** a user disables telemetry
- **THEN** the install id is deleted, not merely unused
- **AND** re-enabling produces a different id

### Requirement: Events cannot carry org data
A telemetry event SHALL be a closed union of literal-valued shapes. The only
data SHALL be: the install id, the extension version, the event name, one of the
three view names, and a timestamp. The system SHALL enforce this at runtime as
well as in the type system.

#### Scenario: The allow-list holds
- **WHEN** an envelope reaches the transport
- **THEN** its keys are exactly the allow-listed keys, recursively
- **AND** any other key is dropped before the transport sees it

#### Scenario: An attempt to smuggle org data
- **WHEN** an event is constructed carrying an org id, instance URL, release
  name, component name, deploy id, token or metadata count
- **THEN** none of those values reaches the transport

#### Scenario: An unknown view name
- **WHEN** an event names a view outside the three
- **THEN** it is refused rather than forwarded

### Requirement: No endpoint is configured
The shipped extension SHALL wire telemetry to a transport that sends nothing,
and SHALL report that no endpoint is configured. The system SHALL NOT contain a
URL to which telemetry would be sent.

#### Scenario: The shipped wiring
- **WHEN** the built extension is inspected
- **THEN** the transport in use discards every event
- **AND** no telemetry code performs a network call
- **AND** the panel states that no endpoint is configured

#### Scenario: Enabled, with events recorded
- **WHEN** telemetry is enabled and all three views are opened
- **THEN** no network request is made by the extension

### Requirement: Recording is refused, not silently dropped, when off
When telemetry is disabled, the system SHALL report that an event was not
recorded rather than pretending it was.

#### Scenario: An event while disabled
- **WHEN** a view is opened with telemetry disabled
- **THEN** the recorder reports that nothing was recorded
- **AND** the transport is not called at all
