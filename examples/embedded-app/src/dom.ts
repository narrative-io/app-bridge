/** Tiny DOM helpers, so the example needs no framework to be readable. */

/** Build an element from a static HTML string. Never used with untrusted input. */
export function el(html: string): HTMLElement {
	const template = document.createElement('template')
	template.innerHTML = html.trim()
	return template.content.firstElementChild as HTMLElement
}

/**
 * Definition-list rows from a plain object. Values are set with `textContent`,
 * so anything the platform sends is rendered as text rather than markup.
 */
export function definitionRows(pairs: Record<string, string>): HTMLElement[] {
	return Object.entries(pairs).flatMap(([key, value]) => {
		const dt = document.createElement('dt')
		dt.textContent = key
		const dd = document.createElement('dd')
		dd.textContent = value
		return [dt, dd]
	})
}
