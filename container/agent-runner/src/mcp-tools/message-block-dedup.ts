import type { DestinationEntry } from '../destinations.js';
import type { RoutingContext } from '../formatter.js';

/**
 * Phase-3 #7 follow-up — refinement of the P4 dedup scope carve-out.
 *
 * The scope decision (`ba24ef23`, Codex P-Audit-2-reviewed) had ALL
 * `<message to="…">` blocks BYPASS the dedup flag, on the theory that
 * a `<message>` block is "explicit agent intent" worth preserving. The
 * 6-board sweep (thiago 6/40, seci post-#7 2/40) showed that's too
 * coarse: a `<message to="<same-conversation>">` immediately after a
 * deterministic mutation card IS the redundant model narration v1
 * never sent — the same kind of bare-text reply the dedup already
 * suppresses, just `<message>`-wrapped.
 *
 * Refined invariant: `<message>` blocks BYPASS the dedup when they
 * target a DIFFERENT conversation (the legitimate cross-board relay
 * use); they are SUPPRESSED when they target the same conversation
 * the just-emitted card already went to. Preserves the cross-board
 * relay carve-out; closes the same-conv redundant-NL case.
 *
 * Channel destinations match on `platformId` + `channelType`. Agent
 * destinations match when the inbound routing's `channelType==='agent'`
 * and its `platformId` (the originating agent group) equals the
 * destination's `agentGroupId`.
 */
export function shouldSuppressSameConvMessage(
  suppressBareFallback: boolean,
  dest: DestinationEntry,
  routing: RoutingContext,
): boolean {
  if (!suppressBareFallback) return false;
  if (!routing.platformId || !routing.channelType) return false; // no current conv
  if (dest.type === 'channel') {
    return dest.platformId === routing.platformId && dest.channelType === routing.channelType;
  }
  // agent destination: same conversation iff the inbound came from this
  // exact agent group.
  return routing.channelType === 'agent' && dest.agentGroupId === routing.platformId;
}
