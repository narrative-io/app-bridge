/**
 * Publish gate. `bun run build` producing files is not the same as producing
 * a usable package, and the failures that matter here are the quiet ones:
 * an export map pointing at a file the build no longer emits, or a `<script>`
 * bundle that loads without attaching its global.
 *
 * Plain node with no dependencies, so it runs identically in CI and locally.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const failures = []

function check(description, assertion) {
	try {
		assertion()
	} catch (error) {
		failures.push(`${description}: ${error.message}`)
	}
}

// 1. Every path the export map promises must actually exist in the build.
for (const [subpath, target] of Object.entries(pkg.exports)) {
	const paths = typeof target === 'string' ? [target] : Object.values(target)
	for (const relative of paths) {
		check(`exports["${subpath}"] → ${relative}`, () => readFileSync(join(root, relative)))
	}
}

// 2. The ESM entries must import cleanly and expose their documented surface.
const expectedExports = {
	'./dist/guest.js': ['connect'],
	'./dist/host.js': ['createBridgeHost'],
	'./dist/protocol.js': ['PROTOCOL_VERSION', 'BridgeError', 'METHOD_NAMES'],
}
for (const [relative, names] of Object.entries(expectedExports)) {
	const module = await import(new URL(relative, `file://${root}/`).href)
	for (const name of names) {
		check(`${relative} exports ${name}`, () => {
			if (module[name] === undefined) throw new Error('missing')
		})
	}
}

// 3. The `<script>` bundle must attach exactly one global, with the guest
//    surface on it — and must NOT carry the host half of the protocol.
const globalBundle = readFileSync(join(root, 'dist/app-bridge.global.js'), 'utf8')
const sandbox = {}
check('dist/app-bridge.global.js evaluates', () => runInNewContext(globalBundle, sandbox))
check('dist/app-bridge.global.js attaches NarrativeAppBridge.connect', () => {
	if (typeof sandbox.NarrativeAppBridge?.connect !== 'function') throw new Error('global missing or incomplete')
})
check('dist/app-bridge.global.js does not bundle the host', () => {
	if (globalBundle.includes('createBridgeHost')) throw new Error('host code leaked into the browser bundle')
})

// 4. `files` must not ship the test harness to consumers.
check('package.json files excludes the test harness', () => {
	if (!pkg.files.includes('!src/testing')) throw new Error('src/testing is not excluded')
})

if (failures.length > 0) {
	console.error(`\nBuild verification failed:\n${failures.map((failure) => `  \u2717 ${failure}`).join('\n')}\n`)
	process.exit(1)
}

console.log(`\u2713 build verified \u2014 ${Object.keys(pkg.exports).length} export paths, ESM entries, global bundle`)
