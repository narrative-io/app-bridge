/**
 * A complete embedded app, in about two hundred lines.
 *
 * It uses `@narrative.io/app-bridge/guest` and `fetch`, and nothing else — no
 * framework, no build plugins, no state library. That is not minimalism for its
 * own sake: it is the demonstration. If something here needed a dependency, the
 * bridge would have a gap.
 *
 * Read `PLATFORM_ORIGINS` first. Everything else is ordinary application code.
 */

import { type AppBridge, connect } from '@narrative.io/app-bridge/guest'
import type { Context } from '@narrative.io/app-bridge/protocol'
import { definitionRows, el } from './dom.js'
import { normalizePath, VIEWS, viewFor } from './views.js'

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

/* --- startup -------------------------------------------------------------- */
// `connect()` is called at module scope, before anything renders, so the
// handshake overlaps startup. In an app with a framework, this call goes before
// the framework boots, not after.
const connecting = connect({ platformOrigin: PLATFORM_ORIGINS })

// Paint immediately. connect() waits up to 15 seconds before giving up, and a
// blank page for that long is the wrong answer to "is this thing working?".
renderConnecting()

connecting.then(run, renderNotEmbedded)

function shell(): { main: HTMLElement; nav: HTMLElement } {
	root.replaceChildren(
		el('<header><h1>Example Reports</h1><span class="badge">an embedded app</span></header>'),
		el('<nav id="nav"></nav>'),
		el('<main id="main"></main>'),
	)
	return {
		main: root.querySelector('#main') as HTMLElement,
		nav: root.querySelector('#nav') as HTMLElement,
	}
}

function renderConnecting() {
	const { main } = shell()
	main.append(el('<section><h2>Connecting…</h2><p>Waiting for the platform to answer the handshake.</p></section>'))
}

/**
 * An embedded app will sometimes be opened outside the platform — someone pastes
 * the URL, or the origin is not registered yet. Say so rather than hanging.
 */
function renderNotEmbedded(error: unknown) {
	const { main } = shell()
	const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown'
	const section = el('<section><h2>Not embedded</h2><p>This app runs inside the Narrative platform.</p></section>')
	const list = el('<dl></dl>')
	list.append(
		...definitionRows({
			code,
			reason: error instanceof Error ? error.message : String(error),
			'origins tried': PLATFORM_ORIGINS.join(', '),
		}),
	)
	section.append(list)
	main.append(section)
}

function run(bridge: AppBridge) {
	const { main, nav } = shell()
	let currentPath = normalizePath(location.pathname)

	/* --- calling the API ---------------------------------------------------- */
	// The whole pattern: a bearer token from the bridge, and fetch. Note that
	// getToken() is called INSIDE the request rather than once at startup — it
	// caches internally and only crosses the bridge when the cached token is near
	// expiry, so this is cheap and it is what keeps working past the first expiry.
	async function api(path: string): Promise<{ status: number; ok: boolean; body: string }> {
		const { token } = await bridge.getToken()
		const response = await fetch(`${bridge.context.apiBaseUrl}${path}`, {
			headers: { Authorization: `Bearer ${token}` },
		})
		return { status: response.status, ok: response.ok, body: await response.text() }
	}

	/* --- navigation: this app is a controlled component --------------------- */
	// Clicking a link reports where the user went; it does not change the view.
	// The platform mirrors the path into its own URL and answers with `navigate`,
	// and that is what renders. One source of truth, so the browser's back and
	// forward buttons and deep links all work without this app touching history.
	for (const [path, view] of Object.entries(VIEWS)) {
		const link = el(`<a data-path="${path}" href="#">${view.label}</a>`)
		link.addEventListener('click', (event) => {
			event.preventDefault()
			bridge.pathChanged(path)
		})
		nav.append(link)
	}
	bridge.onNavigate((path) => {
		currentPath = normalizePath(path)
		paintView()
	})

	/* --- sections ----------------------------------------------------------- */
	const contextSection = el('<section><h2>Who is using this app</h2><dl id="ctx"></dl></section>')
	const apiSection = el(`<section>
		<h2>Calling the Narrative API</h2>
		<p><button id="whoami" type="button">GET /installations/whoami</button></p>
		<pre id="out"></pre>
	</section>`)
	const viewSection = el('<section><h2 id="view-title"></h2><p id="view-body"></p></section>')

	function paintContext(context: Context) {
		// Context arrives with the handshake, so this renders on first paint with
		// no round-trip.
		;(contextSection.querySelector('#ctx') as HTMLElement).replaceChildren(
			...definitionRows({
				user: `${context.user.name} <${context.user.email}>`,
				company: context.company.name,
				tier: context.tier,
				installed: String(bridge.hasInstallation),
			}),
		)
	}

	function paintView() {
		const view = viewFor(currentPath)
		;(viewSection.querySelector('#view-title') as HTMLElement).textContent = view.label
		;(viewSection.querySelector('#view-body') as HTMLElement).textContent = view.body
		for (const link of nav.querySelectorAll('a')) {
			link.classList.toggle('active', link.dataset.path === currentPath)
		}
	}

	apiSection.querySelector('#whoami')?.addEventListener('click', async () => {
		const out = apiSection.querySelector('#out') as HTMLElement
		out.textContent = '…'
		try {
			const response = await api('/installations/whoami')
			out.className = response.ok ? 'ok' : 'err'
			out.textContent = `HTTP ${response.status}\n${response.body || '(empty body)'}`
		} catch (error) {
			out.className = 'err'
			out.textContent = error instanceof Error ? error.message : String(error)
		}
	})

	/* --- live platform changes ---------------------------------------------- */
	// The platform tells you; you never poll.
	bridge.onContextChange(paintContext)
	bridge.onSessionEnd((reason) => {
		main.prepend(el(`<div class="banner">Your platform session ended (${reason}). Please sign in again.</div>`))
	})

	// Render an install prompt from the handshake rather than by making a call
	// you already know will fail.
	if (!bridge.hasInstallation) {
		main.append(el('<div class="banner">This app is not installed for your company yet.</div>'))
	}

	main.append(contextSection, apiSection, viewSection)
	paintContext(bridge.context)
	paintView()
}
