/**
 * What a screen reader should hear when the panel changes.
 *
 * Pure, and separate from rendering, for one structural reason: the panel
 * rebuilds its whole body on every state change, and a live region that is
 * destroyed and recreated announces nothing reliably. So the regions are
 * created once, outside the rebuilt subtree, and this function decides what
 * text they should hold. Rendering puts pixels on screen; this decides what is
 * said.
 *
 * Two channels, because the distinction matters to someone who cannot see the
 * panel:
 *
 *  - `polite` waits for a pause. Counts, results, decisions recorded.
 *  - `assertive` interrupts. Only for a failure, where continuing to act on a
 *    stale reading of the panel would waste the user's time.
 *
 * A field that repeats its previous value is not re-announced by the caller,
 * so a re-render triggered by an unrelated keystroke stays silent.
 */

import { summariseByStatus } from '../core/releases.js';
import { pluralise } from './format.js';
import type { ViewState } from './state.js';

export interface Announcement {
  readonly polite: string;
  readonly assertive: string;
}

export function describeAnnouncement(state: ViewState): Announcement {
  return { polite: politeText(state), assertive: assertiveText(state) };
}

function assertiveText(state: ViewState): string {
  if (state.load.status === 'error') {
    return `Could not load release data. ${state.load.error.message}`;
  }
  if (state.approvals.error !== null) {
    return `Could not record the decision. ${state.approvals.error.message}`;
  }
  if (state.org.error !== null) {
    return `Org connection problem. ${state.org.error.message}`;
  }
  return '';
}

function politeText(state: ViewState): string {
  // A failure is already carried by the assertive channel; saying it twice is
  // worse than saying it once.
  if (assertiveText(state) !== '') return '';

  if (state.org.busy !== null) return ORG_BUSY[state.org.busy];
  if (state.load.status === 'idle' || state.load.status === 'loading') {
    return 'Loading release data.';
  }
  if (state.load.status === 'ready') {
    // The decision the user just took comes first: they know how many releases
    // there are, and they are waiting to hear whether the write landed.
    if (state.approvals.lastOutcome !== null) {
      return `Decision recorded. ${state.approvals.lastOutcome}`;
    }
    const summary = summariseByStatus(state.load.snapshot.releases);
    const attention =
      summary.needsAttention === 0
        ? 'none need attention'
        : `${summary.needsAttention} ${summary.needsAttention === 1 ? 'needs' : 'need'} attention`;
    return `${pluralise(summary.total, 'release')} loaded, ${attention}.`;
  }
  return '';
}

const ORG_BUSY: Readonly<Record<'connecting' | 'refreshing' | 'disconnecting', string>> = {
  connecting: 'Connecting to the org. A sign-in window will open.',
  refreshing: 'Refreshing from the org.',
  disconnecting: 'Disconnecting from the org.',
};
