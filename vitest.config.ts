import { defineConfig } from 'vitest/config'

// `environment: 'node'` is deliberate. The bridge has no DOM dependency beyond
// the structural interfaces it declares (`GuestWindowLike`, `FrameLike`), and
// running the suite under plain node is what proves it: a stray `document` or
// `window` reference fails here rather than in someone's bundler.
//
// `MessageChannel` and `MessagePort` come from node's own globals, so port
// traffic in the tests is genuinely asynchronous rather than a stubbed queue.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.spec.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			// The test harness and the `<script>`-tag entry are not the protocol.
			exclude: ['src/testing/**', 'src/global.ts'],
			reporter: ['text', 'lcov'],
			// A ratchet, not a target. The protocol is a security boundary; a
			// newly added line with no test is a gap worth failing CI over.
			thresholds: {
				lines: 99,
				functions: 95,
				branches: 88,
				statements: 95,
			},
		},
	},
})
