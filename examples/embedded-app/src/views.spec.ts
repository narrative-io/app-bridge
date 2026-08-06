import { describe, expect, it } from 'bun:test'
import { DEFAULT_PATH, normalizePath, VIEWS, viewFor } from './views.js'

describe('normalizePath', () => {
	it('keeps a known path', () => {
		expect(normalizePath('/reports')).toBe('/reports')
	})

	it('falls back to the default for anything unknown', () => {
		expect(normalizePath('/does-not-exist')).toBe(DEFAULT_PATH)
		expect(normalizePath('')).toBe(DEFAULT_PATH)
	})

	it('does not treat inherited object properties as views', () => {
		expect(normalizePath('constructor')).toBe(DEFAULT_PATH)
		expect(normalizePath('__proto__')).toBe(DEFAULT_PATH)
	})
})

describe('viewFor', () => {
	it('always returns something renderable', () => {
		for (const path of [...Object.keys(VIEWS), '/nope', '__proto__']) {
			expect(viewFor(path).label.length).toBeGreaterThan(0)
		}
	})
})
