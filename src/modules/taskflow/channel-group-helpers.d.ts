/**
 * Fork-owned augment of the core `ChannelAdapter` contract.
 *
 * Adds the optional group-creation + phone-to-platform-id resolution methods
 * that TaskFlow's board provisioning consumes (auto-add of participants to a
 * fresh board) and that the WhatsApp/Baileys adapter implements. Kept out of
 * core (`src/channels/adapter.ts` stays pristine upstream v2.0.54) and carried
 * here as a TypeScript declaration-merge so the installer overlay owns it.
 *
 * All members are optional: their presence does not change runtime behavior —
 * adapters that omit them are unaffected, and the router/host treat absence as
 * a no-op. This file is types-only (no runtime registration); tsconfig's
 * `src` glob include picks it up automatically.
 *
 * skill/whatsapp-fixes-v2 extension; upstream PR pending. Drop when upstream
 * merges the methods into the core interface.
 */
export {};

declare module '../../channels/adapter.js' {
  interface ChannelAdapter {
    /**
     * Create a new group on the platform with the given subject and initial
     * participants. Returns the new group's platform id, the actual subject
     * the platform applied, and (when the platform reports partial-add)
     * the participants that didn't end up in the group + an invite link
     * the operator can share to recover them.
     *
     * Implementations should reject with an Error if the requested
     * participant count exceeds the platform's per-group cap (1024 for
     * WhatsApp).
     */
    createGroup?(
      subject: string,
      participants: string[],
    ): Promise<{
      jid: string;
      subject: string;
      droppedParticipants?: string[];
      inviteLink?: string;
    }>;

    /**
     * Validate that a phone is registered on the platform and return the
     * canonical platform handle. Returns null if the phone is not
     * registered or doesn't normalize to a valid number.
     *
     * For WhatsApp: round-trips via `sock.onWhatsApp()`. For platforms
     * that conflate phone with handle (Telegram username, etc.) this
     * may be omitted.
     */
    lookupPhoneJid?(phone: string): Promise<string | null>;

    /**
     * Construct the platform handle for a phone *without* round-tripping
     * to the server. Used in fast paths (outbound DM routing) where the
     * caller has already validated the number out-of-band.
     *
     * Throws if the phone normalizes to empty.
     */
    resolvePhoneJid?(phone: string): Promise<string>;
  }
}
