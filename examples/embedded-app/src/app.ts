/**
 * The app itself: everything that happens once `connect()` has resolved, plus
 * the two states that exist before it does.
 *
 * Deliberately separate from `main.ts`. This file is the part a real app would
 * write; `main.ts` is the composition root — where the platform origins are
 * pinned and the bridge is created — and that is the part every deployment does
 * differently. Keeping the seam there means the app code can be lifted wholesale
 * while the wiring stays yours.
 *
 * Nothing here imports anything but the bridge's types and two local helpers.
 */

import type { AppBridge } from '@narrative.io/app-bridge/guest'
import type { Context } from '@narrative.io/app-bridge/protocol'
import { definitionRows, el } from './dom.js'
import { normalizePath, VIEWS, viewFor } from './views.js'

/** The endpoint made for installation tokens: it reports who the token is. */
const WHOAMI_PATH = '/installations/whoami'

export function renderShell(root: HTMLElement): { main: HTMLElement; nav: HTMLElement } {
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

/**
 * Rendered synchronously, before the handshake resolves.
 *
 * Worth copying: `connect()` waits up to 15 seconds before giving up, so an app
 * that renders nothing until it settles shows a blank page for that whole time
 * whenever it is opened outside a platform. Paint something first.
 */
export function renderConnecting(root: HTMLElement, origins: readonly string[]): void {
	const { main } = renderShell(root)
	const section = el('<section><h2>Connecting…</h2><p>Waiting for the platform to answer the handshake.</p></section>')
	const list = el('<dl></dl>')
	list.append(...definitionRows({ 'origins accepted': origins.join(', ') || '(none configured)' }))
	section.append(list)
	main.append(section)
}

/**
 * An embedded app will sometimes be opened outside the platform — someone pastes
 * the URL, or the origin is not registered yet. Say so rather than hanging.
 */
export function renderNotEmbedded(root: HTMLElement, error: unknown, origins: readonly string[]): void {
	const { main } = renderShell(root)
	const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown'
	const section = el('<section><h2>Not embedded</h2><p>This app runs inside the Narrative platform.</p></section>')
	const list = el('<dl></dl>')
	list.append(
		...definitionRows({
			code,
			reason: error instanceof Error ? error.message : String(error),
			'origins tried': origins.join(', ') || '(none configured)',
		}),
	)
	section.append(list)
	main.append(section)
}

/** The connected app. Returns a teardown for anything that needs stopping. */
export function runEmbedded(root: HTMLElement, bridge: AppBridge): () => void {
	const { main, nav } = renderShell(root)
	let currentPath = normalizePath(location.pathname)
	let ticker: ReturnType<typeof setInterval> | undefined

	/* --- calling the API ---------------------------------------------------- */
	// The whole pattern: a bearer token from the bridge, and fetch. Note that
	// getToken() is called INSIDE the request rather than once at startup — it
	// caches internally and only crosses the bridge when the cached token is near
	// expiry, so this is cheap, and it is what keeps working past the first
	// expiry. Holding the token in a variable is the classic bug.
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
	const tokenSection = el(`<section>
		<h2>Installation token</h2>
		<dl id="tok"><dt>state</dt><dd>none requested yet</dd></dl>
		<p>
			<button id="get-token" type="button">bridge.getToken()</button>
			<button id="whoami" type="button">GET ${WHOAMI_PATH}</button>
		</p>
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
				'api base': context.apiBaseUrl,
				installed: String(bridge.hasInstallation),
				// Feature-detect against this rather than sniffing a version.
				capabilities: bridge.capabilities.join(', '),
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

	/* --- tokens ------------------------------------------------------------- */
	async function showToken() {
		const list = tokenSection.querySelector('#tok') as HTMLElement
		clearInterval(ticker)
		try {
			const grant = await bridge.getToken()
			const expiresAt = new Date(grant.expiresAt).getTime()
			const paint = () => {
				const secondsLeft = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
				list.replaceChildren(
					...definitionRows({
						// Never render a token in full. It is a live credential, and this
						// panel ends up on screens and in screenshots.
						token: `${grant.token.slice(0, 8)}… (${grant.token.length} chars)`,
						scopes: grant.scopes.join(', ') || '(none)',
						'expires in': `${secondsLeft}s — getToken() mints a fresh one once under 30s remain`,
					}),
				)
			}
			paint()
			ticker = setInterval(paint, 1000)
		} catch (error) {
			list.replaceChildren(...definitionRows({ error: error instanceof Error ? error.message : String(error) }))
		}
	}

	tokenSection.querySelector('#get-token')?.addEventListener('click', () => void showToken())
	tokenSection.querySelector('#whoami')?.addEventListener('click', async () => {
		const out = tokenSection.querySelector('#out') as HTMLElement
		out.className = ''
		out.textContent = '…'
		try {
			const response = await api(WHOAMI_PATH)
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
		clearInterval(ticker)
		main.prepend(el(`<div class="banner">Your platform session ended (${reason}). Please sign in again.</div>`))
	})

	// Render an install prompt from the handshake rather than by making a call
	// you already know will fail.
	if (!bridge.hasInstallation) {
		main.append(el('<div class="banner">This app is not installed for your company yet.</div>'))
	}

	main.append(contextSection, tokenSection, viewSection)
	paintContext(bridge.context)
	paintView()

	return () => clearInterval(ticker)
}
