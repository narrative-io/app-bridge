/**
 * Dev server. Bun only, no bundler config.
 *
 * Serve your app on a DIFFERENT origin from the platform while developing. The
 * cross-origin path is what the bridge exists for, so same-origin development
 * proves nothing and hides the differences until production.
 *
 * Note what this server does NOT send: no `X-Frame-Options`, and no
 * `frame-ancestors` directive that denies framing. See
 * docs/making-your-app-frameable.md — a real deployment must send a
 * `frame-ancestors` allow-list naming the platform.
 */

const PORT = Number(process.env.PORT ?? 5174)
const root = import.meta.dir

Bun.serve({
	port: PORT,
	async fetch(request) {
		const { pathname } = new URL(request.url)

		if (pathname === '/main.js') {
			const build = await Bun.build({
				entrypoints: [`${root}/src/main.ts`],
				target: 'browser',
				sourcemap: 'inline',
			})
			if (!build.success) {
				for (const log of build.logs) console.error(log)
				return new Response(`console.error(${JSON.stringify(build.logs.join('\n'))})`, {
					headers: { 'content-type': 'text/javascript; charset=utf-8' },
				})
			}
			return new Response(build.outputs[0], { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
		}

		if (pathname === '/styles.css') {
			return new Response(Bun.file(`${root}/styles.css`), { headers: { 'content-type': 'text/css; charset=utf-8' } })
		}

		// Any other path serves the shell, so the platform can point the frame at
		// a deep link and the app boots straight into that view.
		return new Response(Bun.file(`${root}/index.html`), { headers: { 'content-type': 'text/html; charset=utf-8' } })
	},
})

console.log(`example embedded app → http://localhost:${PORT}`)
