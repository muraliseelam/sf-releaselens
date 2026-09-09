/**
 * Classifying a Salesforce host without repeating it.
 *
 * A host is classified rather than reported because a My Domain host embeds the
 * customer's org name: `acme-finance.my.salesforce.com` identifies a company,
 * and the diagnostic report exists precisely so that a bug can be filed without
 * doing that.
 *
 * This lived in two places — `core/diagnostics.ts` and
 * `scripts/org-harness.mjs` — which disagreed. The copy in the product tested
 * `.my.salesforce.com` **first**, so the `.sandbox.` and `.develop.` branches
 * below it were unreachable and every sandbox, developer and scratch org was
 * reported as a plain My Domain org. The order here is specific-to-general, and
 * a test asserts each pattern against the one above it.
 */

/** The two published Salesforce login endpoints. Anything else is My Domain. */
export const KNOWN_LOGIN_HOSTS = ['login.salesforce.com', 'test.salesforce.com'] as const;

/**
 * Host suffixes, **most specific first**.
 *
 * Order is the whole correctness of this file: every scratch host is also a
 * `.my.salesforce.com` host, so a general pattern placed first swallows every
 * specific one.
 *
 * `covered` records whether the manifest's `optional_host_permissions` reach
 * the host. Chrome's `*.my.salesforce.com` pattern matches any subdomain of
 * `my.salesforce.com`, which includes the scratch, sandbox and develop forms —
 * confirmed by asking Chrome itself in `e2e/org.spec.ts` rather than by reading
 * the documentation.
 */
const INSTANCE_PATTERNS: readonly {
  readonly suffix: string;
  readonly label: string;
  readonly covered: boolean;
}[] = [
  { suffix: '.scratch.my.salesforce.com', label: '*.scratch.my.salesforce.com', covered: true },
  { suffix: '.sandbox.my.salesforce.com', label: '*.sandbox.my.salesforce.com', covered: true },
  { suffix: '.develop.my.salesforce.com', label: '*.develop.my.salesforce.com', covered: true },
  { suffix: '.my.salesforce.com', label: '*.my.salesforce.com', covered: true },
  { suffix: '.salesforce.com', label: '*.salesforce.com', covered: true },
  {
    suffix: '.force.com',
    label: '*.force.com (not covered by the manifest)',
    covered: false,
  },
];

const UNCOVERED = 'other (not covered by the manifest)';

/**
 * Which host *pattern* an instance matches — never the host itself.
 *
 * This is the field that decides whether the optional host permission reaches
 * the org, and getting it wrong is one of the likelier first-contact failures,
 * so the shape is worth reporting even though the value is not.
 */
export function classifyInstanceHost(instanceUrl: string | undefined): string {
  const host = hostOf(instanceUrl);
  if (host === null) return 'none';
  if (host === 'unparseable') return 'unparseable';
  return INSTANCE_PATTERNS.find((pattern) => host.endsWith(pattern.suffix))?.label ?? UNCOVERED;
}

/** Whether the manifest's host permissions can reach this instance at all. */
export function isInstanceHostCovered(instanceUrl: string | undefined): boolean {
  const host = hostOf(instanceUrl);
  if (host === null || host === 'unparseable') return false;
  return INSTANCE_PATTERNS.find((pattern) => host.endsWith(pattern.suffix))?.covered ?? false;
}

/**
 * Which login endpoint, not which URL.
 *
 * A My Domain login host embeds the customer's org name, so reporting it would
 * leak exactly what the diagnostic report exists not to leak.
 */
export function classifyLoginHost(loginUrl: string | undefined): string {
  const host = hostOf(loginUrl);
  if (host === null) return 'none';
  return (KNOWN_LOGIN_HOSTS as readonly string[]).includes(host) ? host : 'other (My Domain)';
}

function hostOf(url: string | undefined): string | null {
  if (url === undefined || url === '') return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch (cause) {
    void cause;
    // A stored URL that will not parse is itself worth knowing about, and
    // saying so leaks nothing.
    return 'unparseable';
  }
}
