/**
 * The store-policy checks.
 *
 * A verifier that only ever passes is decoration. Every test here is a failure
 * case: it constructs the mistake and asserts the check catches it and names
 * it. The one positive test is the real repository, which would otherwise be
 * the only thing the check had ever been run against.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface Finding {
  check: string;
  message: string;
}

interface StorePolicyLib {
  classifyShippedFile: (name: string) => 'scan' | 'inert' | 'unknown';
  reportUnscannable: (shipped: readonly string[]) => Finding[];
  NAME_LIMIT: number;
  DESCRIPTION_LIMIT: number;
  MIN_JUSTIFICATION: number;
  parseJustifications: (markdown: string) => Map<string, string>;
  diffPermissions: (input: {
    requested: readonly string[];
    justified: Map<string, string>;
  }) => Finding[];
  requestedPermissions: (manifest: Record<string, unknown>) => string[];
  scanForRemoteCode: (name: string, text: string) => Finding[];
  checkManifest: (
    manifest: Record<string, unknown>,
    context: { packageVersion: string; iconExists: (path: string) => boolean },
  ) => Finding[];
  screenZipEntries: (entries: readonly string[], shipped: readonly string[]) => Finding[];
}

/** A plain `.mjs` helper with no types of its own; its shape is asserted here. */
const lib = (await import('../../scripts/lib/store-policy.mjs')) as unknown as StorePolicyLib;
const {
  DESCRIPTION_LIMIT,
  MIN_JUSTIFICATION,
  checkManifest,
  classifyShippedFile,
  diffPermissions,
  reportUnscannable,
  parseJustifications,
  requestedPermissions,
  scanForRemoteCode,
  screenZipEntries,
} = lib;

const projectRoot = new URL('../../', import.meta.url);

/** Long enough to clear the threshold, so length is never the thing under test. */
const GOOD = 'x'.repeat(MIN_JUSTIFICATION + 10);

const MANIFEST = {
  manifest_version: 3,
  name: 'sf-releaselens',
  description: 'Release dashboard for Salesforce release managers.',
  version: '0.6.0',
  icons: { '128': 'icons/icon-128.png' },
  permissions: ['storage'],
};

const context = { packageVersion: '0.6.0', iconExists: () => true };
const messages = (findings: readonly Finding[]): string => findings.map((f) => f.message).join('\n');

describe('parsing the justification tables', () => {
  it('reads a permission row and ignores every other table in the document', () => {
    const parsed = parseJustifications(
      [
        '| Permission | Justification to paste |',
        '| --- | --- |',
        '| `storage` | `Because of reasons.` |',
        '| `https://*.salesforce.com/*` (optional) | `Only when connecting an org.` |',
        '',
        '| Question | Answer |',
        '| --- | --- |',
        '| Does it collect location? | **No** |',
        '| 1 | Release dashboard | The headline |',
      ].join('\n'),
    );

    expect([...parsed.keys()]).toEqual(['storage', 'https://*.salesforce.com/*']);
    expect(parsed.get('storage')).toBe('Because of reasons.');
  });
});

describe('permissions and justifications must agree in both directions', () => {
  it('fails a permission with no justification, naming it', () => {
    const findings = diffPermissions({ requested: ['tabs'], justified: new Map() });

    expect(findings).toHaveLength(1);
    expect(messages(findings)).toContain('tabs');
  });

  it('fails a justification for a permission that is not requested', () => {
    // The direction nobody catches by eye, and the worse of the two: it tells a
    // reviewer the paperwork describes a different extension.
    const findings = diffPermissions({
      requested: ['storage'],
      justified: new Map([
        ['storage', GOOD],
        ['scripting', GOOD],
      ]),
    });

    expect(findings).toHaveLength(1);
    expect(messages(findings)).toContain('scripting');
  });

  it('fails a justification too short to tell a reviewer anything', () => {
    const findings = diffPermissions({
      requested: ['storage'],
      justified: new Map([['storage', 'Needed.']]),
    });

    expect(messages(findings)).toContain('7 characters');
  });

  it('passes when they match', () => {
    expect(
      diffPermissions({ requested: ['storage'], justified: new Map([['storage', GOOD]]) }),
    ).toEqual([]);
  });

  it('collects optional and host permissions, which a reviewer also sees', () => {
    expect(
      requestedPermissions({
        permissions: ['storage'],
        optional_permissions: ['downloads'],
        host_permissions: ['https://a.example/*'],
        optional_host_permissions: ['https://b.example/*'],
      }),
    ).toEqual(['storage', 'downloads', 'https://a.example/*', 'https://b.example/*']);
  });
});

describe('the remote-code scan', () => {
  it.each([
    ['eval', 'const value = eval(payload);'],
    ['new Function', 'const fn = new Function("return 1");'],
    ['dynamic import of a non-relative target', 'await import(specifier);'],
    ['chrome.scripting', 'chrome.scripting.executeScript({});'],
  ])('catches %s', (label, line) => {
    const findings = scanForRemoteCode('ui/panel.js', line);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain(label);
    expect(findings[0]?.message).toContain('ui/panel.js:1');
  });

  it.each([
    '<script src="https://cdn.example/x.js"></script>',
    '<link rel="stylesheet" href="https://fonts.example/x.css">',
    '<script src="//cdn.example/x.js"></script>',
  ])('catches a remote reference: %s', (line) => {
    expect(scanForRemoteCode('ui/sidepanel.html', line)).toHaveLength(1);
  });

  it.each([
    "import { render } from './render.js';",
    "await import('./lazy.js');",
    '<script src="panel.js" type="module"></script>',
    '<link rel="icon" href="../icons/icon-32.png">',
    'const url = retrieval(record);',
  ])('leaves ordinary code alone: %s', (line) => {
    expect(scanForRemoteCode('ui/panel.js', line)).toEqual([]);
  });

  it('reports the line number, because a bare verdict is not actionable', () => {
    const findings = scanForRemoteCode('a.js', ['ok', 'ok', 'eval(x)'].join('\n'));

    expect(findings[0]?.message).toContain('a.js:3');
  });
});

describe('manifest limits', () => {
  it('accepts the shape the store wants', () => {
    expect(checkManifest(MANIFEST, context)).toEqual([]);
  });

  it('fails manifest v2', () => {
    expect(messages(checkManifest({ ...MANIFEST, manifest_version: 2 }, context))).toContain(
      'accepts 3 only',
    );
  });

  it('fails a description past the limit, reporting both numbers', () => {
    const long = 'x'.repeat(DESCRIPTION_LIMIT + 1);

    expect(messages(checkManifest({ ...MANIFEST, description: long }, context))).toContain(
      `${DESCRIPTION_LIMIT + 1} characters`,
    );
  });

  it('fails a blank description, which is an explicit rejection reason', () => {
    expect(messages(checkManifest({ ...MANIFEST, description: '' }, context))).toContain('blank');
  });

  it('fails a version that has drifted from package.json', () => {
    expect(messages(checkManifest({ ...MANIFEST, version: '0.5.0' }, context))).toContain(
      'does not match package.json',
    );
  });

  it('fails a declared icon that is not in the build', () => {
    const findings = checkManifest(MANIFEST, { ...context, iconExists: () => false });

    expect(messages(findings)).toContain('not in the build');
  });

  it.each(['key', 'update_url'])('fails on `%s`, which the store rejects', (field) => {
    expect(messages(checkManifest({ ...MANIFEST, [field]: 'x' }, context))).toContain(field);
  });

  it.each(["script-src 'self' 'unsafe-eval'", "script-src 'self' https://cdn.example"])(
    'fails a content security policy that permits what MV3 forbids: %s',
    (policy) => {
      const findings = checkManifest(
        { ...MANIFEST, content_security_policy: { extension_pages: policy } },
        context,
      );

      expect(findings.some((finding) => finding.check === 'remote-code')).toBe(true);
    },
  );
});

describe('screening the packaged archive', () => {
  const shipped = ['manifest.json', 'ui/panel.js'];

  it('passes an archive that is exactly what was built', () => {
    expect(screenZipEntries(shipped, shipped)).toEqual([]);
  });

  it.each([
    ['ui/panel.js.map', 'source map'],
    ['ui/panel.d.ts', 'type declaration'],
    ['.env', 'dotfile'],
    ['node_modules/left-pad/index.js', 'node_modules'],
  ])('fails on %s, and names it', (entry, why) => {
    /*
     * On the entry and the reason, not on the length of the finding list. The
     * earlier version asserted only that something was found, which passes
     * unchanged on a screening function that rejects every entry in the
     * archive — a much worse bug with the same test result.
     */
    const findings = screenZipEntries([...shipped, entry], shipped);

    expect(messages(findings)).toContain(entry);
    expect(messages(findings)).toContain(why);
    // The legitimate entries are still accepted.
    expect(screenZipEntries(shipped, shipped)).toEqual([]);
  });

  it('fails an entry that is not in dist, which means it came from somewhere else', () => {
    expect(messages(screenZipEntries([...shipped, 'notes.txt'], shipped))).toContain(
      'not in dist/',
    );
  });

  it('fails an empty archive rather than reporting nothing wrong with it', () => {
    expect(messages(screenZipEntries([], shipped))).toContain('empty');
  });
});

describe('the repository itself', () => {
  it('justifies every permission its manifest requests', async () => {
    /*
     * The check running against the real files, so a permission added without a
     * justification fails here as well as in `npm run check` — a contributor
     * who reads a test failure gets the same answer as one who reads a script's
     * output.
     */
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('src/manifest.json', projectRoot)), 'utf8'),
    ) as Record<string, unknown>;
    const listing = await readFile(
      fileURLToPath(new URL('docs/STORE-LISTING.md', projectRoot)),
      'utf8',
    );

    const findings = diffPermissions({
      requested: requestedPermissions(manifest),
      justified: parseJustifications(listing),
    });

    expect(messages(findings)).toBe('');
    expect(requestedPermissions(manifest).length).toBeGreaterThan(0);
  });
});

/*
 * The scan has to account for the whole build.
 *
 * It read four extensions and skipped everything else in silence, so a `.mjs`
 * arriving in `dist/` tomorrow would go unscanned while the run still printed
 * `ok` — and that run's output is pasted into a store submission as a
 * declaration that the extension contains no remotely hosted code. A
 * declaration backed by a check that quietly stopped covering part of the build
 * is worse than one backed by nothing, because nobody is looking.
 */
describe('every shipped file is accounted for', () => {
  it.each([
    ['ui/panel.js', 'scan'],
    ['ui/sidepanel.html', 'scan'],
    ['ui/styles.css', 'scan'],
    ['manifest.json', 'scan'],
    ['icons/icon-128.png', 'inert'],
    ['fonts/inter.woff2', 'inert'],
    ['ui/panel.mjs', 'unknown'],
    ['background/worker.wasm', 'unknown'],
    ['README', 'unknown'],
  ])('classifies %s as %s', (name, expected) => {
    expect(classifyShippedFile(name)).toBe(expected);
  });

  it('fails on a file it cannot vouch for, naming it and saying what to do', () => {
    const findings = reportUnscannable(['ui/panel.js', 'icons/a.png', 'ui/late.mjs']);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('ui/late.mjs');
    expect(findings[0]?.message).toContain('was not scanned');
    expect(findings[0]?.message).toContain('store-policy.mjs');
  });

  it('says nothing about a build of only readable and known-inert files', () => {
    expect(reportUnscannable(['manifest.json', 'ui/panel.js', 'icons/icon-16.png'])).toEqual([]);
  });

  it('is case-insensitive, because Windows builds are', () => {
    expect(classifyShippedFile('icons/ICON-128.PNG')).toBe('inert');
    expect(classifyShippedFile('ui/PANEL.JS')).toBe('scan');
  });
});
