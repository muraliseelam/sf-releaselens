/**
 * Records what GitHub knows about this repository today.
 *
 *   npm run evidence            append today's reading
 *   npm run evidence -- --force replace today's reading
 *
 * Adoption that was never measured cannot be evidenced later, and GitHub keeps
 * clone and view traffic for **fourteen days only** — so a month nobody
 * snapshots is a month permanently lost. This is the snapshot.
 *
 * ## What it is not
 *
 * Not telemetry. Nothing here comes from the extension or from any user;
 * everything is data GitHub publishes about a public repository, read by its
 * owner through the `gh` credential that owner already has. No new secret, no
 * service, nothing stored in CI.
 *
 * ## Failure posture
 *
 * Two failures, treated differently, following the project's usual rule.
 *
 * Cannot establish a baseline at all — no `gh`, not authenticated, repository
 * unreadable — aborts and writes nothing. A record that says "0 stars" because
 * a command failed is worse than no record, because in six months it will be
 * read as a measurement.
 *
 * One metric unavailable — traffic denied, a rate limit on one endpoint —
 * records `null` and the reason, and carries on. A partial record dated today
 * beats no record at all, as long as the gap is visible.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRecord, measured, renderSummary, unavailable } from './lib/evidence.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EVIDENCE = join(projectRoot, 'evidence');

/** Read from the git remote so the script cannot drift from the repository. */
function repositorySlug() {
  const url = run('git', ['remote', 'get-url', 'origin']).trim();
  const match = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url);
  if (match === null) {
    throw new Fatal(`Could not read an owner/repo from the origin remote: ${url}`);
  }
  return `${match[1]}/${match[2]}`;
}

class Fatal extends Error {}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

/**
 * Runs `gh` directly, never through a shell.
 *
 * The first version of this went through `cmd /c` on Windows, which is the
 * usual workaround for a `.cmd` shim — and `cmd` then split every API path at
 * the `&` in `?per_page=100&anon=false`, so three metrics came back
 * "unavailable" for a reason that had nothing to do with GitHub. `gh` ships as
 * a real executable on every platform, so no shell is needed and none is used.
 */
function gh(args) {
  return run('gh', args);
}

function ghJson(path) {
  return JSON.parse(gh(['api', path, '--cache', '0']));
}

/**
 * Everything that must work before a record is worth writing.
 *
 * Deliberately separate from collection: these are the conditions under which
 * silence is the honest answer.
 */
function preflight() {
  try {
    gh(['--version']);
  } catch (cause) {
    void cause;
    throw new Fatal(
      'The GitHub CLI (`gh`) is not available.\n' +
        '  Install it from https://cli.github.com and run `gh auth login`.',
    );
  }

  try {
    gh(['auth', 'status']);
  } catch (cause) {
    void cause;
    throw new Fatal(
      '`gh` is installed but not authenticated.\n' +
        '  Run `gh auth login`. Nothing has been written.',
    );
  }
}

/** An optional metric: unavailable is a result, not a failure. */
function attempt(fn) {
  try {
    return measured(fn());
  } catch (cause) {
    const message = String(cause?.message ?? cause)
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim();
    return unavailable(message ?? 'unknown error');
  }
}

/**
 * Open and closed counts from the search API.
 *
 * The repository object's `open_issues_count` includes pull requests, which is
 * a long-standing trap; search separates them properly.
 */
function searchCount(slug, type, state) {
  const query = encodeURIComponent(`repo:${slug} type:${type} state:${state}`);
  return ghJson(`/search/issues?q=${query}&per_page=1`).total_count ?? 0;
}

async function main() {
  preflight();

  const slug = repositorySlug();
  let repository;
  try {
    repository = ghJson(`/repos/${slug}`);
  } catch (cause) {
    throw new Fatal(
      `Could not read /repos/${slug}: ${String(cause?.message ?? cause).split('\n')[0]}\n` +
        '  Nothing has been written.',
    );
  }

  const record = buildRecord({
    repository,
    collectedAt: new Date().toISOString(),
    issues: attempt(() => ({
      open: searchCount(slug, 'issue', 'open'),
      closed: searchCount(slug, 'issue', 'closed'),
    })),
    pullRequests: attempt(() => ({
      open: searchCount(slug, 'pr', 'open'),
      closed: searchCount(slug, 'pr', 'closed'),
    })),
    // Counted, never listed. A dated list of who contributed to what is a
    // social graph this project has no use for.
    contributors: attempt(
      () => ghJson(`/repos/${slug}/contributors?per_page=100&anon=false`).length,
    ),
    releases: attempt(() => ghJson(`/repos/${slug}/releases?per_page=100`)),
    // Owner-only endpoints. A 403 here is expected for anyone else and is
    // recorded as unavailable rather than as zero.
    clones: attempt(() => ghJson(`/repos/${slug}/traffic/clones`)),
    views: attempt(() => ghJson(`/repos/${slug}/traffic/views`)),
  });

  await mkdir(EVIDENCE, { recursive: true });
  const date = record.collectedAt.slice(0, 10);
  const target = join(EVIDENCE, `${date}.json`);

  if (existsSync(target) && !process.argv.includes('--force')) {
    throw new Fatal(
      `${target} already exists.\n` +
        '  A past reading is not revised: that is what makes the series worth\n' +
        '  anything. Pass --force only if today\'s reading was itself wrong.',
    );
  }

  await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await writeFile(join(EVIDENCE, 'SUMMARY.md'), renderSummary(readSeries()), 'utf8');

  report(record, target);
}

/** Every record on disk, oldest first. */
function readSeries() {
  return readdirSync(EVIDENCE)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(EVIDENCE, name), 'utf8')));
}

function report(record, target) {
  const line = (label, value) => `  ${label.padEnd(22)} ${value}\n`;
  const optional = (metric, render = (v) => String(v)) =>
    metric.value === null ? `unavailable (${metric.error})` : render(metric.value);

  process.stdout.write(
    `\n${record.repository} at ${record.collectedAt}\n\n` +
      line('Stars', record.stars) +
      line('Forks', record.forks) +
      line('Watchers', record.watchers) +
      line('Contributors', optional(record.contributors)) +
      line('Issues', optional(record.issues, (v) => `${v.open} open, ${v.closed} closed`)) +
      line('Pull requests', optional(record.pullRequests, (v) => `${v.open} open, ${v.closed} closed`)) +
      line('Releases', optional(record.releases.count)) +
      line('Asset downloads', optional(record.releases.totalAssetDownloads)) +
      line('Clones (14d)', optional(record.traffic.clones, (v) => `${v.total} (${v.unique} unique)`)) +
      line('Views (14d)', optional(record.traffic.views, (v) => `${v.total} (${v.unique} unique)`)) +
      `\nWrote ${target}\n` +
      `Wrote ${join(EVIDENCE, 'SUMMARY.md')}\n`,
  );
}

try {
  await main();
} catch (cause) {
  if (cause instanceof Fatal) {
    process.stderr.write(`\nsf-releaselens: ${cause.message}\n`);
    process.exitCode = 1;
  } else {
    throw cause;
  }
}
