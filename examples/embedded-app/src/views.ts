/**
 * The app's own routes. Ordinary application code — the only thing worth
 * noticing is that these paths end up in the platform's URL, so they should be
 * stable enough for someone to bookmark.
 */

export interface View {
	label: string
	body: string
}

export const VIEWS: Record<string, View> = {
	'/': { label: 'Overview', body: 'Your reports would be summarised here.' },
	'/reports': { label: 'Reports', body: 'A report would render here.' },
	'/settings': { label: 'Settings', body: 'Settings that belong to this app, not to the platform.' },
}

export const DEFAULT_PATH = '/'

/**
 * The platform can send any path — a stale bookmark, a hand-edited URL — so an
 * unknown one must render something rather than nothing.
 *
 * `Object.hasOwn` rather than `in`, which walks the prototype chain and would
 * accept `'constructor'` or `'__proto__'` as views.
 */
export function normalizePath(path: string): string {
	return Object.hasOwn(VIEWS, path) ? path : DEFAULT_PATH
}

export function viewFor(path: string): View {
	return VIEWS[normalizePath(path)] as View
}
