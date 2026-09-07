# Schema versioning

The trace schema is the contract between everything that produces or consumes events: the SDK,
the API, the engine, exported bundles, the CLI and the web app. It is versioned independently of
the package versions.

## The version string

`SCHEMA_VERSION` in `packages/schemas/src/version.ts` is `"1.0"`, of the form `MAJOR.MINOR`.

- Every event carries `schemaVersion`; the ingestion API defaults it to the current version when
  omitted.
- Every trace records the `schemaVersion` it was created with.
- Every `shadow.trace` bundle records the `schemaVersion` it was exported with.

`isCompatibleSchemaVersion(version)` returns true when the major number equals the reader's
`SCHEMA_MAJOR`. Bundle import rejects incompatible bundles with a validation error naming the
version.

## Compatibility policy

### MINOR: additive, backwards compatible

A minor bump covers changes an old reader can ignore:

- new optional top-level event fields;
- new known event types and payload schemas;
- new override kinds or comparison fields;
- widening an enum (a new `severity`, a new `source`).

Guarantees that make this safe:

- Readers ignore unknown fields. Event and payload schemas are `looseObject`s.
- The API stores unknown top-level event fields in the `extra` column and returns them verbatim.
- Unknown event types are stored, listed and displayed generically; the engine treats them as
  inert (not state-mutating, not program operations, not span openers).
- Old bundles (same major) import into a newer server without transformation.

A newer producer talking to an older server loses nothing: unknown fields land in `extra`.

### MAJOR: breaking

A major bump is required when an old reader would misinterpret data:

- renaming or removing a field;
- changing a field's type or meaning (for example `sequence` semantics, patch operation set);
- changing span or `parentEventId` conventions;
- changing how `metadata.shadow` is interpreted.

Requirements for a major bump:

1. Update `SCHEMA_VERSION` and `SCHEMA_MAJOR`.
2. Provide a **stored-data migration** in `apps/api/drizzle` that rewrites existing rows, or
   proves none is needed.
3. Provide a **bundle upgrader** used by `parseBundle` so bundles exported by the previous major
   can still be imported (or reject them with a clear message and document the upgrade path).
4. Update the SDK and CLI; older SDKs will be rejected or adapted by the API depending on the
   change (documented per release).
5. Mark the change with a `BREAKING CHANGE:` footer and a changelog entry, and update this
   document and [Events](./events.md).

## Relationship to package versions

Shadow packages follow SemVer. Before 1.0:

- a package minor release may change TypeScript or HTTP APIs (with changelog notice);
- a package release may bump the schema minor freely;
- a package release may **not** bump the schema major without shipping the migration described
  above. Stored traces are never silently invalidated.

After 1.0, a schema major bump implies a package major bump.

## Practical guidance

- Producers: always send `schemaVersion` explicitly so that traces from older SDKs are
  distinguishable after an upgrade.
- Integrations: put framework-specific data in `metadata` or in your own event types rather than
  overloading known payload fields; that keeps you inside the minor-version envelope.
- Readers: check `isCompatibleSchemaVersion` on bundles and per-event versions if you process
  raw exports outside Shadow.
- When adding a known event type, follow the checklist in
  [CONTRIBUTING.md](../../CONTRIBUTING.md#adding-an-event-type).
