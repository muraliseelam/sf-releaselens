/**
 * The evidence record, and the one thing it must never do.
 *
 * A record is read months after it was written, by someone who was not there
 * when it was collected. So the assertions that matter are about
 * **distinguishability**: `0` and "could not read it" are different facts, and
 * a series that collapses them turns a failed API call into a measurement of
 * zero adoption.
 *
 * The `gh` calls are not tested here — they are exercised by running the script
 * for real, which is how the committed baseline was produced. What is tested is
 * everything that could be wrong without the network noticing.
 */

import { describe, expect, it } from 'vitest';

interface OptionalMetric<T> {
  value: T | null;
  error: string | null;
}

interface EvidenceLib {
  RECORD_VERSION: number;
  measured: <T>(value: T) => OptionalMetric<T>;
  unavailable: (reason: unknown) => OptionalMetric<never>;
  buildRecord: (input: Record<string, unknown>) => Record<string, never> & Record<string, unknown>;
  renderSummary: (records: readonly unknown[]) => string;
}

/** A plain `.mjs` helper with no types of its own; its shape is asserted here. */
const lib = (await import('../../scripts/lib/evidence.mjs')) as unknown as EvidenceLib;
const { buildRecord, measured, renderSummary, unavailable } = lib;

const REPOSITORY = {
  full_name: 'someone/some-repo',
  stargazers_count: 12,
  forks_count: 3,
  subscribers_count: 4,
  created_at: '2026-01-01T00:00:00Z',
  pushed_at: '2026-09-09T00:00:00Z',
  visibility: 'public',
  license: { spdx_id: 'MIT' },
};

const RELEASES = [
  {
    tag_name: 'v0.5.3',
    published_at: '2026-09-09T00:00:00Z',
    assets: [{ name: 'app.zip', download_count: 7, size: 1024 }],
  },
  {
    tag_name: 'v0.5.2',
    published_at: '2026-09-08T00:00:00Z',
    assets: [{ name: 'app.zip', download_count: 2, size: 1000 }],
  },
];

function record(overrides: Record<string, unknown> = {}) {
  return buildRecord({
    repository: REPOSITORY,
    collectedAt: '2026-09-09T04:00:00.000Z',
    issues: measured({ open: 1, closed: 5 }),
    pullRequests: measured({ open: 7, closed: 0 }),
    contributors: measured(2),
    releases: measured(RELEASES),
    clones: measured({ count: 9, uniques: 4 }),
    views: measured({ count: 30, uniques: 11 }),
    ...overrides,
  });
}

describe('buildRecord', () => {
  it('records the repository-level counts', () => {
    const built = record() as unknown as {
      recordVersion: number;
      repository: string;
      stars: number;
      forks: number;
      watchers: number;
      licence: string;
    };

    expect(built.recordVersion).toBe(lib.RECORD_VERSION);
    expect(built.repository).toBe('someone/some-repo');
    expect(built.stars).toBe(12);
    expect(built.forks).toBe(3);
    expect(built.watchers).toBe(4);
    expect(built.licence).toBe('MIT');
  });

  it('totals downloads across every asset of every release', () => {
    const built = record() as unknown as {
      releases: {
        count: OptionalMetric<number>;
        latestTag: OptionalMetric<string>;
        totalAssetDownloads: OptionalMetric<number>;
        assets: { tag: string; asset: string; downloads: number }[];
      };
    };

    expect(built.releases.count.value).toBe(2);
    expect(built.releases.latestTag.value).toBe('v0.5.3');
    expect(built.releases.totalAssetDownloads.value).toBe(9);
    expect(built.releases.assets).toHaveLength(2);
    expect(built.releases.assets[0]).toMatchObject({ tag: 'v0.5.3', downloads: 7 });
  });

  it('keeps "unavailable" distinct from zero, per metric', () => {
    const built = record({
      contributors: unavailable('HTTP 403'),
      clones: unavailable('HTTP 403: Must have push access'),
    }) as unknown as {
      contributors: OptionalMetric<number>;
      traffic: { clones: OptionalMetric<unknown>; views: OptionalMetric<unknown> };
    };

    // The whole point. `value: 0` would be read as a measurement.
    expect(built.contributors).toEqual({ value: null, error: 'HTTP 403' });
    expect(built.traffic.clones.value).toBeNull();
    expect(built.traffic.clones.error).toContain('403');
    // An unrelated metric is unaffected.
    expect(built.traffic.views.value).toEqual({ total: 30, unique: 11 });
  });

  it('survives releases being unreadable without inventing assets', () => {
    const built = record({ releases: unavailable('rate limited') }) as unknown as {
      releases: { total: OptionalMetric<number>; assets: unknown[] };
    };

    expect(built.releases.total.value).toBeNull();
    expect(built.releases.assets).toEqual([]);
  });

  it('names no person, whatever the payloads contain', () => {
    // Contributors are counted, never listed: a dated list of who starred or
    // contributed to a project is a social graph this has no use for.
    const serialised = JSON.stringify(record());

    expect(serialised).not.toContain('login');
    expect(serialised).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });
});

describe('renderSummary', () => {
  it('says so plainly when there is nothing yet', () => {
    expect(renderSummary([])).toContain('No records yet');
  });

  it('shows one row per reading, oldest first', () => {
    const first = record();
    const second = buildRecord({
      repository: { ...REPOSITORY, stargazers_count: 20 },
      collectedAt: '2026-10-09T04:00:00.000Z',
      issues: measured({ open: 1, closed: 5 }),
      pullRequests: measured({ open: 7, closed: 0 }),
      contributors: measured(3),
      releases: measured(RELEASES),
      clones: measured({ count: 9, uniques: 4 }),
      views: measured({ count: 30, uniques: 11 }),
    });

    const summary = renderSummary([first, second]);
    const rows = summary.split('\n').filter((line) => line.startsWith('| 2026-'));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('2026-09-09');
    expect(rows[1]).toContain('2026-10-09');
  });

  it('shows the change since the previous reading', () => {
    const first = record();
    const second = buildRecord({
      repository: { ...REPOSITORY, stargazers_count: 20 },
      collectedAt: '2026-10-09T04:00:00.000Z',
      issues: measured({ open: 1, closed: 5 }),
      pullRequests: measured({ open: 7, closed: 0 }),
      contributors: measured(2),
      releases: measured(RELEASES),
      clones: measured({ count: 9, uniques: 4 }),
      views: measured({ count: 30, uniques: 11 }),
    });

    const summary = renderSummary([first, second]);

    // 12 → 20. A series whose rows do not show movement is a table nobody
    // reads twice.
    expect(summary).toContain('20 (+8)');
    // Unchanged values carry no delta, so the eye goes to what moved.
    expect(summary).not.toContain('2 (+0)');
  });

  it('renders an unavailable metric as unavailable, never as 0', () => {
    const summary = renderSummary([record({ clones: unavailable('HTTP 403') })]);
    const row = summary.split('\n').find((line) => line.startsWith('| 2026-'))!;

    expect(row).toContain('unavailable');
    // The views column beside it is a real zero and must still say 0.
    expect(row).toContain('30 (11 unique)');
  });

  it('lists the assets of the most recent reading, busiest first', () => {
    const summary = renderSummary([record()]);
    const assetRows = summary.split('\n').filter((line) => line.includes('app.zip'));

    expect(assetRows).toHaveLength(2);
    expect(assetRows[0]).toContain('v0.5.3');
  });

  it('explains the fourteen-day traffic window, which is why cadence matters', () => {
    const summary = renderSummary([record()]);

    expect(summary).toContain('fourteen days');
    expect(summary).toContain('unmeasured');
  });
});
