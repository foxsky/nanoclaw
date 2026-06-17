/**
 * TaskFlow overlay registration for the ADR 0006 contract 8 dispatch-extension
 * point in `server.ts`. Importing this module (side-effect only, from the
 * `mcp-tools/index.ts` barrel) wires the fork's dispatch behavior into pristine
 * core WITHOUT core importing any fork module:
 *
 *  - the RC5-ext P3 (C7) external-actor default-deny capability gate
 *    (`denyIfExternalActorBlocked`, B6 content-confinement), as a dispatch guard;
 *  - the lone-surrogate sanitizers (`wellFormedToolResult` on every text exit,
 *    `wellFormedError` on a thrown handler error) so corrupt tool output can't
 *    wedge the session with an Anthropic API 400 ("no low surrogate ...").
 *
 * The FastAPI standalone entrypoint (`taskflow-server-entry.ts`) imports the
 * tool barrel transitively, so it gets the same registrations. The guard +
 * sanitizers are themselves no-ops outside a TaskFlow board turn / on the
 * verbatim+replay surfaces (their own internal checks), so registering them
 * unconditionally is safe.
 */
import { denyIfExternalActorBlocked } from './chat-actor-guard.js';
import { registerDispatchGuard, registerErrorTransform, registerResultTransform } from './server.js';
import { wellFormedError, wellFormedToolResult } from '../well-formed.js';

registerDispatchGuard((name, args) => denyIfExternalActorBlocked(name, args));
registerResultTransform(wellFormedToolResult);
registerErrorTransform(wellFormedError);
