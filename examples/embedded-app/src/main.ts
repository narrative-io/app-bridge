/**
 * Composition root: pin the platform origins, open the bridge, hand it to the
 * app. Everything else lives in `app.ts`.
 *
 * This file is short on purpose. It is the part every deployment does
 * differently — where origins come from, what instrumentation is attached — so
 * the app code stays liftable while the wiring stays yours.
 */

import { connect } from '@narrative.io/app-bridge/guest'
import { renderConnecting, renderNotEmbedded, runEmbedded } from './app.js'

/**
 * The origins allowed to embed this app, hard-coded.
 *
 * This is the security decision the whole package is built around. An app that
 * accepts a handshake from whoever framed it hands its context and its API
 * token to any site that puts it in an iframe.
 *
 * Add your own staging platform here if you have one. Do **not** derive this
 * list at runtime from `document.location.ancestorOrigins` or
 * `document.referrer`: that is the same as trusting the attacker.
 */
const PLATFORM_ORIGINS = ['https://app.narrative.io']

const root = document.getElementById('app') as HTMLElement

// `connect()` is called at module scope, before anything renders, so the
// handshake overlaps startup. In an app with a framework, this call goes before
// the framework boots, not after it.
const connecting = connect({ platformOrigin: PLATFORM_ORIGINS })

// Paint immediately: connect() waits up to 15 seconds before giving up, and a
// blank page for that long is the wrong answer to "is this thing working?".
renderConnecting(root, PLATFORM_ORIGINS)

connecting.then(
	(bridge) => runEmbedded(root, bridge),
	(error) => renderNotEmbedded(root, error, PLATFORM_ORIGINS),
)
