/**
 * Entry point for the bundled `<script>` build, for app developers with no
 * bundler in their stack. It attaches a single global and nothing else:
 *
 * ```html
 * <script src="https://unpkg.com/@narrative.io/app-bridge/dist/app-bridge.global.js"></script>
 * <script>
 *   NarrativeAppBridge.connect({ platformOrigin: 'https://app.narrative.io' })
 *     .then((bridge) => console.log(bridge.context.company.name))
 * </script>
 * ```
 *
 * Only the guest surface is exposed. The host half of the protocol is the
 * embedding platform's side of the conversation and has no business in an
 * app's page, so it has no global build — same reason the package publishes
 * no root export.
 */

import { connect } from './guest.js'
import { BridgeError, PROTOCOL_VERSION } from './protocol.js'

const api = Object.freeze({ connect, BridgeError, PROTOCOL_VERSION })

export type NarrativeAppBridgeGlobal = typeof api

declare global {
	var NarrativeAppBridge: NarrativeAppBridgeGlobal
}

globalThis.NarrativeAppBridge = api

export { api as NarrativeAppBridge }
