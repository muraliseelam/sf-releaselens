import { describe, expect, it } from 'vitest';

import {
  absoluteTime,
  approvalStatusLabel,
  coverageLabel,
  operationLabel,
  pluralise,
  relativeTime,
  releaseStatusLabel,
  riskLabel,
} from '../../src/ui/format.js';

const NOW = Date.parse('2026-09-07T12:00:00.000Z');

describe('coverageLabel', () => {
  it('distinguishes unknown coverage from zero coverage', () => {
    expect(coverageLabel(undefined)).toBe('Coverage unknown');
    expect(coverageLabel(0)).toBe('0% covered');
  });

  it('rounds to a whole percentage', () => {
    expect(coverageLabel(0.756)).toBe('76% covered');
  });
});

describe('relativeTime', () => {
  it.each([
    ['2026-09-07T11:59:30.000Z', 'just now'],
    ['2026-09-07T11:30:00.000Z', '30m ago'],
    ['2026-09-07T09:00:00.000Z', '3h ago'],
    ['2026-09-04T12:00:00.000Z', '3d ago'],
    ['2026-09-09T12:00:00.000Z', 'in 2d'],
    ['2026-09-07T13:00:00.000Z', 'in 1h'],
  ])('formats %s as %s', (iso, expected) => {
    expect(relativeTime(iso, NOW)).toBe(expected);
  });

  it('returns the raw value rather than "NaN" for an unparseable date', () => {
    expect(relativeTime('not a date', NOW)).toBe('not a date');
  });
});

describe('absoluteTime', () => {
  it('returns the raw value for an unparseable date', () => {
    expect(absoluteTime('not a date')).toBe('not a date');
  });

  it('formats a real timestamp as something other than the ISO string', () => {
    expect(absoluteTime('2026-09-07T12:00:00.000Z')).not.toBe('2026-09-07T12:00:00.000Z');
  });
});

describe('labels', () => {
  it('renders statuses, operations and risk in prose', () => {
    expect(releaseStatusLabel('awaiting_approval')).toBe('Awaiting approval');
    expect(releaseStatusLabel('rolled_back')).toBe('Rolled back');
    expect(approvalStatusLabel('pending')).toBe('Pending');
    expect(operationLabel('delete')).toBe('Deleted');
    expect(riskLabel('high')).toBe('High risk');
  });
});

describe('pluralise', () => {
  it('handles one, many and an irregular plural', () => {
    expect(pluralise(1, 'component')).toBe('1 component');
    expect(pluralise(0, 'component')).toBe('0 components');
    expect(pluralise(2, 'entry', 'entries')).toBe('2 entries');
  });
});
