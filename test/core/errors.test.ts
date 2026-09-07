/**
 * Error messages are product surface: they are rendered verbatim in a 400px
 * panel. These tests assert that each one names the offending record and says
 * what to do next, because a message that only says "invalid data" sends someone
 * to the storage inspector.
 */

import { describe, expect, it } from 'vitest';

import {
  ApprovalNotPermittedError,
  ImportFormatError,
  InvalidApprovalTransitionError,
  MissingRejectionCommentError,
  RecordNotFoundError,
  SnapshotValidationError,
  StorageQuotaExceededError,
  StorageUnavailableError,
  UnknownMessageError,
  UnsupportedSchemaVersionError,
  isReleaseLensError,
} from '../../src/core/errors.js';

describe('isReleaseLensError', () => {
  it('recognises our errors and rejects everything else', () => {
    expect(isReleaseLensError(new RecordNotFoundError('release', 'rel-1'))).toBe(true);
    expect(isReleaseLensError(new Error('plain'))).toBe(false);
    expect(isReleaseLensError('a string')).toBe(false);
    expect(isReleaseLensError(null)).toBe(false);
    expect(isReleaseLensError(undefined)).toBe(false);
  });
});

describe('error identity', () => {
  it('every error is a real Error with its own class name, so stacks are readable', () => {
    const error = new SnapshotValidationError('snapshot.actor.name', 'expected a non-empty string');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SnapshotValidationError');
    expect(error.stack).toContain('SnapshotValidationError');
  });

  it('exposes stable machine codes that the panel branches on', () => {
    const codes = [
      new SnapshotValidationError('p', 'd').code,
      new UnsupportedSchemaVersionError(2, 1).code,
      new RecordNotFoundError('release', 'r').code,
      new InvalidApprovalTransitionError('a', 'approved', 'rejected').code,
      new ApprovalNotPermittedError('a', 'cab-approver', 'Ada').code,
      new MissingRejectionCommentError('a').code,
      new StorageUnavailableError('reading', new Error('x')).code,
      new StorageQuotaExceededError(10).code,
      new UnknownMessageError('nope').code,
      new ImportFormatError('bad.').code,
    ];

    expect(codes).toEqual([
      'SNAPSHOT_VALIDATION',
      'UNSUPPORTED_SCHEMA_VERSION',
      'RECORD_NOT_FOUND',
      'INVALID_APPROVAL_TRANSITION',
      'APPROVAL_NOT_PERMITTED',
      'MISSING_REJECTION_COMMENT',
      'STORAGE_UNAVAILABLE',
      'STORAGE_QUOTA_EXCEEDED',
      'UNKNOWN_MESSAGE',
      'IMPORT_FORMAT',
    ]);
    // Codes must be unique, or branching on them is ambiguous.
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('message content', () => {
  it('SnapshotValidationError names the path and keeps it queryable', () => {
    const error = new SnapshotValidationError('snapshot.items[3].type', 'expected a string');

    expect(error.message).toBe(
      'Snapshot is not valid at "snapshot.items[3].type": expected a string',
    );
    expect(error.path).toBe('snapshot.items[3].type');
  });

  it('UnsupportedSchemaVersionError names both versions and advises exporting first', () => {
    const error = new UnsupportedSchemaVersionError(7, 1);

    expect(error.message).toContain('schema version 7');
    expect(error.message).toContain('version 1');
    expect(error.message).toMatch(/Export the raw data before resetting/);
  });

  it('InvalidApprovalTransitionError names the earlier decider when there was one', () => {
    const withDecider = new InvalidApprovalTransitionError('apr-1', 'approved', 'rejected', 'Tomas');
    const withoutDecider = new InvalidApprovalTransitionError('apr-1', 'cancelled', 'approved');

    expect(withDecider.message).toContain('(decided by Tomas)');
    expect(withDecider.message).toMatch(/Reload the panel/);
    expect(withoutDecider.message).toContain('is already cancelled and cannot become approved.');
    expect(withoutDecider.message).not.toContain('decided by');
  });

  it('ApprovalNotPermittedError names the role and the actor, not "permission denied"', () => {
    const error = new ApprovalNotPermittedError('apr-1', 'cab-approver', 'Ada Kensington');

    expect(error.message).toBe(
      'Ada Kensington does not hold the "cab-approver" role required to decide approval "apr-1".',
    );
  });

  it('StorageQuotaExceededError names the size and offers a way out', () => {
    const error = new StorageQuotaExceededError(1234567);

    expect(error.message).toContain((1234567).toLocaleString());
    expect(error.message).toMatch(/Export the snapshot/);
  });

  it('StorageUnavailableError keeps the original cause attached and readable', () => {
    const cause = new Error('disk on fire');
    const error = new StorageUnavailableError('writing "k"', cause);

    expect(error.message).toContain('writing "k"');
    expect(error.message).toContain('disk on fire');
    expect(error.cause).toBe(cause);
  });

  it('StorageUnavailableError describes a non-Error cause rather than printing [object Object]', () => {
    const error = new StorageUnavailableError('reading', { weird: true });

    expect(error.message).not.toContain('[object Object]');
  });

  it('ImportFormatError promises the existing snapshot is untouched', () => {
    const error = new ImportFormatError('the file is not valid JSON.');

    expect(error.message).toMatch(/Nothing was changed — the existing snapshot is untouched\./);
  });

  it('RecordNotFoundError names the kind and the id', () => {
    expect(new RecordNotFoundError('approval', 'apr-9').message).toBe(
      'No approval with id "apr-9" exists in the current snapshot.',
    );
  });

  it('MissingRejectionCommentError says why the comment is wanted', () => {
    expect(new MissingRejectionCommentError('apr-1').message).toBe(
      'Rejecting approval "apr-1" requires a comment explaining why.',
    );
  });

  it('UnknownMessageError quotes what it received', () => {
    expect(new UnknownMessageError('launch.rockets').message).toContain('"launch.rockets"');
  });
});
