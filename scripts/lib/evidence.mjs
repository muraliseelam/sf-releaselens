/**
 * Building and rendering an adoption evidence record.
 *
 * Split out from `collect-evidence.mjs` so the parts that can be wrong are
 * testable without a network or a `gh` credential: what a record contains, how
 * a series renders, and — the one that matters — that "we could not read this"
 * is never rendered as zero.
 *
 * Every optional metric is `{ value, error }`. That shape exists because a
 * record is read months later by someone who was not there: `stars: 0` and
 * `stars: null, error: '403'` are different facts, and collapsing them would
 * quietly turn a failed API call into a measurement.
 */

export const RECORD_VERSION = 1;

/** An optional metric that succeeded. */
export function measured(value) {
  return { value, error: null };
}

/** An optional metric that could not be read, and why. */
export function unavailable(reason) {
  return { value: null, error: String(reason) };
}

/**
 * Assembles one dated record from already-fetched API payloads.
 *
 * Takes payloads rather than fetching, so a test can hand it exactly the shapes
 * GitHub returns — including the failures.
 *
 * @param {{
 *   repository: { full_name: string, stargazers_count: number, forks_count: number,
 *                 subscribers_count: number, created_at: string, pushed_at: string,
 *                 visibility?: string, license?: { spdx_id?: string } | null },
 *   collectedAt: string,
 *   issues: {value: {open: number, closed: number}|null, error: string|null},
 *   pullRequests: {value: {open: number, closed: number}|null, error: string|null},
 *   contributors: {value: number|null, error: string|null},
 *   releases: {value: object[]|null, error: string|null},
 *   clones: {value: object|null, error: string|null},
 *   views: {value: object|null, error: string|null},
 * }} input
 */
export function buildRecord(input) {
  const repo = input.repository;

  return {
    recordVersion: RECORD_VERSION,
    collectedAt: input.collectedAt,
    repository: repo.full_name,
    visibility: repo.visibility ?? 'unknown',
    licence: repo.license?.spdx_id ?? null,
    createdAt: repo.created_at,
    lastPushedAt: repo.pushed_at,

    stars: repo.stargazers_count,
    forks: repo.forks_count,
    watchers: repo.subscribers_count,

    issues: input.issues,
    pullRequests: input.pullRequests,
    // A count. Never a list of people — see docs/EVIDENCE.md.
    contributors: input.contributors,

    releases: summariseReleases(input.releases),

    /*
     * GitHub keeps traffic for 14 days and no longer. A month with no
     * collection is permanently unmeasured, which is the whole reason this
     * record exists rather than a note to look at the insights tab later.
     */
    traffic: {
      windowDays: 14,
      clones: summariseTraffic(input.clones),
      views: summariseTraffic(input.views),
    },
  };
}

function summariseReleases(releases) {
  if (releases.value === null) {
    return { total: unavailable(releases.error), assets: [] };
  }

  const assets = [];
  let downloads = 0;
  for (const release of releases.value) {
    for (const asset of release.assets ?? []) {
      const count = asset.download_count ?? 0;
      downloads += count;
      assets.push({
        tag: release.tag_name,
        asset: asset.name,
        downloads: count,
        sizeBytes: asset.size ?? null,
        publishedAt: release.published_at ?? null,
      });
    }
  }

  return {
    count: measured(releases.value.length),
    latestTag: measured(releases.value[0]?.tag_name ?? null),
    totalAssetDownloads: measured(downloads),
    assets,
  };
}

function summariseTraffic(traffic) {
  if (traffic.value === null) return unavailable(traffic.error);
  return measured({
    total: traffic.value.count ?? 0,
    unique: traffic.value.uniques ?? 0,
  });
}

/**
 * Renders the whole series as Markdown.
 *
 * Regenerated on every run rather than appended to, because a derived file that
 * is also hand-edited stops being derived. The JSON records are the history;
 * this is a view of them.
 *
 * @param {object[]} records oldest first
 */
export function renderSummary(records) {
  if (records.length === 0) {
    return `${HEADER}\n_No records yet. Run \`npm run evidence\`._\n`;
  }

  const rows = records.map((record, index) => {
    const previous = index === 0 ? null : records[index - 1];
    return [
      record.collectedAt.slice(0, 10),
      withDelta(record.stars, previous?.stars),
      withDelta(record.forks, previous?.forks),
      withDelta(record.watchers, previous?.watchers),
      optional(record.releases.totalAssetDownloads, previous?.releases?.totalAssetDownloads),
      optional(record.contributors, previous?.contributors),
      optionalTraffic(record.traffic.clones),
      optionalTraffic(record.traffic.views),
    ];
  });

  const latest = records[records.length - 1];
  const table = [
    '| Date | Stars | Forks | Watchers | Asset downloads | Contributors | Clones (14d) | Views (14d) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');

  return [
    HEADER,
    `Repository: \`${latest.repository}\` · ${records.length} reading${records.length === 1 ? '' : 's'} · latest ${latest.collectedAt}`,
    '',
    table,
    '',
    renderAssets(latest),
    '',
    NOTES,
  ].join('\n');
}

function renderAssets(record) {
  const assets = record.releases.assets ?? [];
  if (assets.length === 0) return '_No release assets in the latest reading._';

  const rows = assets
    .slice()
    .sort((a, b) => b.downloads - a.downloads)
    .map((asset) => `| \`${asset.tag}\` | \`${asset.asset}\` | ${asset.downloads} |`);

  return [
    `### Downloads per release asset, as of ${record.collectedAt.slice(0, 10)}`,
    '',
    '| Release | Asset | Downloads |',
    '| --- | --- | ---: |',
    ...rows,
  ].join('\n');
}

/** A plain count, with its change since the previous reading. */
function withDelta(current, previous) {
  if (typeof current !== 'number') return '—';
  if (typeof previous !== 'number') return String(current);
  const change = current - previous;
  if (change === 0) return String(current);
  return `${current} (${change > 0 ? '+' : ''}${change})`;
}

/** An optional metric. Renders "unavailable" as such, never as 0. */
function optional(metric, previousMetric) {
  if (metric === undefined || metric === null) return '—';
  if (metric.value === null) return 'unavailable';
  return withDelta(metric.value, previousMetric?.value ?? undefined);
}

function optionalTraffic(metric) {
  if (metric === undefined || metric === null) return '—';
  if (metric.value === null) return 'unavailable';
  return `${metric.value.total} (${metric.value.unique} unique)`;
}

const HEADER = `<!--
  Generated by \`npm run evidence\`. Do not edit: it is rebuilt from every
  record under evidence/. Those JSON files are the history; this is a view.
-->

# Adoption evidence
`;

const NOTES = `### Reading this

- **unavailable** means the metric could not be read on that date. It is never
  written as \`0\`; the per-date JSON records why.
- **Clones and views** cover the fourteen days before each reading, which is all
  GitHub keeps. Gaps between readings longer than fourteen days are permanently
  unmeasured — that is the reason for a monthly cadence rather than an annual
  one.
- **Contributors** is a count. No record here names a person: see
  [\`../docs/EVIDENCE.md\`](../docs/EVIDENCE.md).
- Nothing here comes from the extension or from any user. It is what GitHub
  publishes about a public repository, read by its owner.
`;
