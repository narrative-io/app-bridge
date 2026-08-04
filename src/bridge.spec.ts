import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AppBridge, connect } from './guest.js'
import { type BridgeHost, type BridgeHostHandlers, type CreateBridgeHostOptions, createBridgeHost } from './host.js'
import { BridgeError, type Context, isHandshakeMessage, PROTOCOL_VERSION, type TokenGrant } from './protocol.js'
import { createEmbeddingWorld, type EmbeddingWorld } from './testing/embeddingWorld.js'
import { validContext, validGrant } from './testing/fixtures.js'

const APP_ORIGIN = 'https://acme-audience-tools.example'
const PLATFORM_ORIGIN = 'https://app.narrative.io'

function flush(): Promise<void> {
	// Port traffic is genuinely async (real MessagePorts); a couple of macrotask
	// turns settle any in-flight round-trip.
	return new Promise((resolve) => setTimeout(resolve, 10))
}

interface Fixture {
	world: EmbeddingWorld
	host: BridgeHost
	handlers: {
		getToken: ReturnType<typeof vi.fn>
		getContext: ReturnType<typeof vi.fn>
		onPathChanged: ReturnType<typeof vi.fn>
	}
	warnings: string[]
	connectGuest: () => Promise<AppBridge>
}

const cleanups: Array<() => void> = []

afterEach(() => {
	while (cleanups.length) cleanups.pop()?.()
})

function setUp(overrides: Partial<CreateBridgeHostOptions> = {}): Fixture {
	const world = createEmbeddingWorld({ appOrigin: APP_ORIGIN, platformOrigin: PLATFORM_ORIGIN })
	const warnings: string[] = []
	const handlers = {
		getToken: vi.fn(async (): Promise<TokenGrant> => validGrant()),
		getContext: vi.fn(async (): Promise<Context> => validContext()),
		onPathChanged: vi.fn(),
	}
	const host = createBridgeHost({
		frame: world.frame,
		appOrigin: APP_ORIGIN,
		handlers: handlers as unknown as BridgeHostHandlers,
		hasInstallation: () => true,
		listenTarget: world.platformWindow,
		onProtocolWarning: (message) => warnings.push(message),
		...overrides,
	})
	cleanups.push(() => host.destroy())
	const connectGuest = async () => {
		const bridge = await connect({ platformOrigin: PLATFORM_ORIGIN, windowRef: world.guestWindow })
		cleanups.push(() => bridge.close())
		return bridge
	}
	return { world, host, handlers, warnings, connectGuest }
}

describe('handshake', () => {
	it('connects guest and host, delivering context without a round-trip', async () => {
		const { host, connectGuest } = setUp()
		const bridge = await connectGuest()
		expect(host.state).toBe('connected')
		expect(bridge.context.user.name).toBe('Ada')
		expect(bridge.hasInstallation).toBe(true)
		expect(bridge.capabilities).toEqual(['getToken', 'getContext'])
	})

	it('ignores a hello from the wrong origin', async () => {
		const { world, host } = setUp()
		world.deliverToPlatform({
			origin: 'https://evil.example',
			source: world.frame.contentWindow as unknown as Window,
			data: { kind: 'nio-bridge:hello', v: PROTOCOL_VERSION },
		})
		await flush()
		expect(host.state).toBe('connecting')
	})

	it('ignores a hello whose source is not the app frame, even from the right origin', async () => {
		const { world, host } = setUp()
		world.deliverToPlatform({
			origin: APP_ORIGIN,
			source: {} as Window, // some other window on the same origin
			data: { kind: 'nio-bridge:hello', v: PROTOCOL_VERSION },
		})
		await flush()
		expect(host.state).toBe('connecting')
	})

	it('rejects a protocol-version mismatch with unsupported_version, and fails the host', async () => {
		const { world, host } = setUp()
		const rejection = new Promise<unknown>((resolve) => {
			world.guestWindow.addEventListener('message', (evt) => resolve(evt.data))
		})
		world.deliverToPlatform({
			origin: APP_ORIGIN,
			source: world.frame.contentWindow as unknown as Window,
			data: { kind: 'nio-bridge:hello', v: 99 },
		})
		await flush()
		expect(await rejection).toMatchObject({
			kind: 'nio-bridge:hello-rejected',
			error: { code: 'unsupported_version' },
		})
		expect(host.state).toBe('failed')
	})

	it('guest connect() times out with a helpful error when nothing embeds it', async () => {
		const world = createEmbeddingWorld({ appOrigin: APP_ORIGIN, platformOrigin: PLATFORM_ORIGIN })
		// No host — the hello goes unanswered.
		await expect(
			connect({ platformOrigin: PLATFORM_ORIGIN, windowRef: world.guestWindow, connectTimeoutMs: 20 }),
		).rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('not embedded') })
	})

	it('host enters failed state when no hello ever arrives', async () => {
		const states: string[] = []
		setUp({ helloTimeoutMs: 20, onStateChange: (state) => states.push(state) })
		await new Promise((resolve) => setTimeout(resolve, 40))
		expect(states).toContain('failed')
	})

	it('accepts a list of candidate platform origins and connects to whichever answers', async () => {
		const { host, world } = setUp()
		const bridge = await connect({
			platformOrigin: ['https://app.other-platform.example', PLATFORM_ORIGIN, 'https://staging.example'],
			windowRef: world.guestWindow,
		})
		cleanups.push(() => bridge.close())
		expect(host.state).toBe('connected')
		expect(bridge.context.user.name).toBe('Ada')
	})

	it('refuses a wildcard origin on either side, including inside a candidate list', async () => {
		const world = createEmbeddingWorld({ appOrigin: APP_ORIGIN, platformOrigin: PLATFORM_ORIGIN })
		await expect(connect({ platformOrigin: '*', windowRef: world.guestWindow })).rejects.toMatchObject({
			code: 'bad_request',
		})
		await expect(
			connect({ platformOrigin: [PLATFORM_ORIGIN, '*'], windowRef: world.guestWindow }),
		).rejects.toMatchObject({ code: 'bad_request' })
		await expect(connect({ platformOrigin: [], windowRef: world.guestWindow })).rejects.toMatchObject({
			code: 'bad_request',
		})
		expect(() =>
			createBridgeHost({
				frame: world.frame,
				appOrigin: '*',
				handlers: {
					getToken: async () => validGrant(),
					getContext: async () => validContext(),
					onPathChanged: () => {},
				},
				hasInstallation: () => true,
				listenTarget: world.platformWindow,
			}),
		).toThrow(BridgeError)
	})

	it('refuses the handshake, with the cause, when the platform cannot build a context', async () => {
		const { world, host, handlers, warnings } = setUp()
		handlers.getContext.mockRejectedValueOnce(new BridgeError('unauthorized', 'No signed-in platform user.'))
		await expect(connect({ platformOrigin: PLATFORM_ORIGIN, windowRef: world.guestWindow })).rejects.toMatchObject({
			code: 'unauthorized',
		})
		expect(host.state).toBe('failed')
		// The platform sees the real cause; the frame gets a generic message.
		expect(warnings.some((w) => w.includes('No signed-in platform user'))).toBe(true)
	})

	it('refuses the handshake with internal when the context handler crashes unexpectedly', async () => {
		const { world, host, handlers } = setUp()
		handlers.getContext.mockRejectedValueOnce(new Error('pg: connection refused at 10.0.0.7'))
		await expect(
			connect({ platformOrigin: PLATFORM_ORIGIN, windowRef: world.guestWindow }).catch((error) => error),
		).resolves.toMatchObject({ code: 'internal', message: expect.not.stringContaining('10.0.0.7') })
		expect(host.state).toBe('failed')
	})

	it('guest ignores a handshake from an origin outside its candidate list', async () => {
		// No host: the only handshake this guest sees is the forged one below.
		const world = createEmbeddingWorld({ appOrigin: APP_ORIGIN, platformOrigin: PLATFORM_ORIGIN })
		const connecting = connect({
			platformOrigin: PLATFORM_ORIGIN,
			windowRef: world.guestWindow,
			connectTimeoutMs: 30,
		})
		world.deliverToGuest({
			origin: 'https://evil.example',
			data: {
				kind: 'nio-bridge:handshake',
				v: PROTOCOL_VERSION,
				capabilities: ['getToken'],
				context: validContext(),
				hasInstallation: true,
			},
			ports: [new MessageChannel().port2],
		})
		await expect(connecting).rejects.toMatchObject({ code: 'timeout' })
	})

	it('guest ignores a handshake that transferred no port', async () => {
		const world = createEmbeddingWorld({ appOrigin: APP_ORIGIN, platformOrigin: PLATFORM_ORIGIN })
		const connecting = connect({
			platformOrigin: PLATFORM_ORIGIN,
			windowRef: world.guestWindow,
			connectTimeoutMs: 30,
		})
		world.deliverToGuest({
			origin: PLATFORM_ORIGIN,
			data: {
				kind: 'nio-bridge:handshake',
				v: PROTOCOL_VERSION,
				capabilities: ['getToken'],
				context: validContext(),
				hasInstallation: true,
			},
			ports: [],
		})
		await expect(connecting).rejects.toMatchObject({ code: 'timeout' })
	})

	it('warns rather than throwing when a hello arrives for a frame with no contentWindow', async () => {
		const world = createEmbeddingWorld({ appOrigin: APP_ORIGIN, platformOrigin: PLATFORM_ORIGIN })
		const warnings: string[] = []
		const host = createBridgeHost({
			frame: { contentWindow: null },
			appOrigin: APP_ORIGIN,
			handlers: {
				getToken: async () => validGrant(),
				getContext: async () => validContext(),
				onPathChanged: () => {},
			},
			hasInstallation: () => true,
			listenTarget: world.platformWindow,
			onProtocolWarning: (message) => warnings.push(message),
		})
		cleanups.push(() => host.destroy())
		world.deliverToPlatform({ origin: APP_ORIGIN, source: null, data: { kind: 'nio-bridge:hello', v: 1 } })
		await flush()
		expect(warnings).toEqual([expect.stringContaining('contentWindow')])
		expect(host.state).toBe('connecting')
	})

	it('a fresh hello (iframe reload) replaces the port and the new bridge works', async () => {
		const { handlers, connectGuest } = setUp()
		const first = await connectGuest()
		expect(await first.getToken()).toMatchObject({ token: 'tok_abc' })
		// Reload: a brand-new guest says hello on the same frame.
		const second = await connectGuest()
		expect(await second.getToken({ minTtlSeconds: 0 })).toMatchObject({ token: 'tok_abc' })
		expect(handlers.getToken).toHaveBeenCalledTimes(2)
	})
})

describe('requests', () => {
	it('round-trips getToken and caches until minTtlSeconds forces a renewal', async () => {
		const { handlers, connectGuest } = setUp()
		const bridge = await connectGuest()

		const grant = await bridge.getToken()
		expect(grant.scopes).toEqual(['read:datasets'])
		await bridge.getToken()
		expect(handlers.getToken).toHaveBeenCalledTimes(1) // served from cache

		// Demand more remaining life than the grant has — forces a fresh mint.
		await bridge.getToken({ minTtlSeconds: 10 * 60 })
		expect(handlers.getToken).toHaveBeenCalledTimes(2)
	})

	it('round-trips getContext as a re-read, always asking the platform', async () => {
		const { handlers, connectGuest } = setUp()
		const bridge = await connectGuest()
		const callsAfterHandshake = handlers.getContext.mock.calls.length
		handlers.getContext.mockResolvedValueOnce(validContext({ tier: 'enterprise' }))
		await expect(bridge.getContext()).resolves.toMatchObject({ tier: 'enterprise' })
		expect(handlers.getContext).toHaveBeenCalledTimes(callsAfterHandshake + 1)
	})

	it('rejects getToken with a named argument error rather than coercing a bad options value', async () => {
		const { handlers, connectGuest } = setUp()
		const bridge = await connectGuest()
		await expect(bridge.getToken('60' as unknown as { minTtlSeconds?: number })).rejects.toMatchObject({
			code: 'bad_request',
			message: expect.stringContaining('options object'),
		})
		expect(handlers.getToken).not.toHaveBeenCalled()
	})

	it('shares one in-flight renewal between concurrent callers', async () => {
		const { handlers, connectGuest } = setUp()
		const bridge = await connectGuest()
		await Promise.all([bridge.getToken(), bridge.getToken(), bridge.getToken()])
		expect(handlers.getToken).toHaveBeenCalledTimes(1)
	})

	it('surfaces a BridgeError from the handler with its code intact', async () => {
		const { handlers, connectGuest } = setUp()
		handlers.getToken.mockRejectedValueOnce(new BridgeError('no_installation', 'Install the app first.'))
		const bridge = await connectGuest()
		await expect(bridge.getToken()).rejects.toMatchObject({
			code: 'no_installation',
			message: 'Install the app first.',
		})
	})

	it('maps an unexpected handler crash to internal without leaking the message', async () => {
		const { handlers, warnings, connectGuest } = setUp()
		handlers.getToken.mockRejectedValueOnce(new Error('pg: connection refused at 10.0.0.7'))
		const bridge = await connectGuest()
		await expect(bridge.getToken()).rejects.toMatchObject({ code: 'internal' })
		await expect(bridge.getToken().catch((e) => e.message)).resolves.not.toContain('10.0.0.7')
		expect(warnings.some((w) => w.includes('connection refused'))).toBe(true) // platform still sees the cause
	})

	it('rejects with timeout when the platform never answers', async () => {
		const { world, handlers } = setUp()
		handlers.getToken.mockImplementation(() => new Promise(() => {})) // hangs forever
		const bridge = await connect({
			platformOrigin: PLATFORM_ORIGIN,
			windowRef: world.guestWindow,
			requestTimeoutMs: 20,
		})
		cleanups.push(() => bridge.close())
		await expect(bridge.getToken()).rejects.toMatchObject({ code: 'timeout' })
	})

	it('rejects a malformed result from the host rather than handing it to the app', async () => {
		const { handlers, connectGuest } = setUp()
		handlers.getToken.mockResolvedValueOnce({ token: 'tok', scopes: 'oops' } as unknown as TokenGrant)
		const bridge = await connectGuest()
		await expect(bridge.getToken()).rejects.toMatchObject({
			code: 'bad_request',
			message: expect.stringContaining('malformed result'),
		})
	})
})

describe('host robustness against a hostile or buggy guest', () => {
	/**
	 * Speaks the window-level handshake by hand and keeps the raw port, so the
	 * test can post messages the real guest library never would.
	 */
	async function rawPort(world: EmbeddingWorld): Promise<MessagePort> {
		const port = new Promise<MessagePort>((resolve) => {
			world.guestWindow.addEventListener('message', (evt) => {
				if (isHandshakeMessage(evt.data) && evt.ports[0]) resolve(evt.ports[0])
			})
		})
		world.guestWindow.parent.postMessage({ kind: 'nio-bridge:hello', v: PROTOCOL_VERSION }, PLATFORM_ORIGIN)
		return port
	}

	function nextResponse(port: MessagePort): Promise<unknown> {
		return new Promise((resolve) => {
			port.onmessage = (evt) => resolve(evt.data)
		})
	}

	it('answers an unknown method with unsupported_method — never a silent drop', async () => {
		const { world } = setUp()
		const port = await rawPort(world)
		const answer = nextResponse(port)
		port.postMessage({ kind: 'req', id: 'x1', method: 'stealCookies', params: {} })
		expect(await answer).toMatchObject({
			id: 'x1',
			ok: false,
			error: { code: 'unsupported_method', message: expect.stringContaining('getToken') },
		})
	})

	it('answers malformed params with bad_request', async () => {
		const { world } = setUp()
		const port = await rawPort(world)
		const answer = nextResponse(port)
		port.postMessage({ kind: 'req', id: 'x2', method: 'getToken', params: { minTtlSeconds: 'lots' } })
		expect(await answer).toMatchObject({ id: 'x2', ok: false, error: { code: 'bad_request' } })
	})

	it('warns on unknown or malformed events instead of acting on them', async () => {
		const { world, warnings, handlers } = setUp()
		const port = await rawPort(world)
		port.postMessage({ kind: 'evt', name: 'formatDisk', payload: {} })
		port.postMessage({ kind: 'evt', name: 'pathChanged', payload: { path: 42 } })
		port.postMessage({ nonsense: true })
		await flush()
		expect(handlers.onPathChanged).not.toHaveBeenCalled()
		expect(warnings).toEqual([
			expect.stringContaining('formatDisk'),
			expect.stringContaining('pathChanged'),
			expect.stringContaining('malformed'),
		])
	})

	it('ignores window-level messages after the handshake', async () => {
		const { world, host, handlers } = setUp()
		await rawPort(world)
		expect(host.state).toBe('connected')
		world.deliverToPlatform({
			origin: APP_ORIGIN,
			source: world.frame.contentWindow as unknown as Window,
			data: { kind: 'req', id: 'w1', method: 'getToken', params: {} },
		})
		await flush()
		expect(handlers.getToken).not.toHaveBeenCalled()
	})
})

describe('events', () => {
	it('host navigate reaches the guest; guest pathChanged reaches the platform', async () => {
		const { host, handlers, connectGuest } = setUp()
		const bridge = await connectGuest()
		const seen: string[] = []
		bridge.onNavigate((path) => seen.push(path))

		host.navigate('/reports')
		bridge.pathChanged('/reports/42')
		await flush()

		expect(seen).toEqual(['/reports'])
		expect(handlers.onPathChanged).toHaveBeenCalledWith('/reports/42')
	})

	it('contextChanged updates bridge.context and notifies subscribers', async () => {
		const { host, connectGuest } = setUp()
		const bridge = await connectGuest()
		const next = validContext({ company: { id: 9, name: 'Viewed-As Co' } })
		const seen: Context[] = []
		bridge.onContextChange((ctx) => seen.push(ctx))

		host.contextChanged(next)
		await flush()

		expect(bridge.context.company.name).toBe('Viewed-As Co')
		expect(seen).toHaveLength(1)
	})

	it('sessionEnded notifies the guest and stops serving the cached token', async () => {
		const { host, handlers, connectGuest } = setUp()
		const bridge = await connectGuest()
		await bridge.getToken()
		expect(handlers.getToken).toHaveBeenCalledTimes(1)

		const reasons: string[] = []
		bridge.onSessionEnd((reason) => reasons.push(reason))
		host.sessionEnded('logout')
		await flush()

		expect(reasons).toEqual(['logout'])
		await bridge.getToken().catch(() => {}) // must go back to the host, not the cache
		expect(handlers.getToken).toHaveBeenCalledTimes(2)
	})

	it('unsubscribe stops delivery', async () => {
		const { host, connectGuest } = setUp()
		const bridge = await connectGuest()
		const seen: string[] = []
		const unsubscribe = bridge.onNavigate((path) => seen.push(path))
		unsubscribe()
		host.navigate('/nowhere')
		await flush()
		expect(seen).toEqual([])
	})
})

describe('message log', () => {
	it('observes the whole conversation, handshake included, with readable labels', async () => {
		const { world, host } = setUp()
		const labels: string[] = []
		const bridge = await connect({
			platformOrigin: PLATFORM_ORIGIN,
			windowRef: world.guestWindow,
			onLogEntry: (entry) => labels.push(`${entry.direction === 'sent' ? '→' : '←'} ${entry.label}`),
		})
		cleanups.push(() => bridge.close())

		await bridge.getToken()
		host.navigate('/reports')
		bridge.pathChanged('/reports/42')
		await flush()

		// Sends log synchronously; port deliveries land a tick later, so the
		// outbound pathChanged precedes the inbound navigate here.
		expect(labels).toEqual([
			`→ hello → ${PLATFORM_ORIGIN}`,
			'← handshake (capabilities: getToken, getContext)',
			'→ req getToken (req-1)',
			'← res getToken (req-1, ok)',
			'→ evt pathChanged',
			'← evt navigate',
		])
	})

	it('a throwing observer never breaks the bridge', async () => {
		const { world } = setUp()
		const bridge = await connect({
			platformOrigin: PLATFORM_ORIGIN,
			windowRef: world.guestWindow,
			onLogEntry: () => {
				throw new Error('bad observer')
			},
		})
		cleanups.push(() => bridge.close())
		await expect(bridge.getToken()).resolves.toMatchObject({ token: 'tok_abc' })
	})
})

describe('teardown', () => {
	it('guest close() rejects in-flight requests and refuses new ones', async () => {
		const { world, handlers } = setUp()
		handlers.getToken.mockImplementation(() => new Promise(() => {}))
		const bridge = await connect({ platformOrigin: PLATFORM_ORIGIN, windowRef: world.guestWindow })
		const inFlight = bridge.getToken()
		bridge.close()
		await expect(inFlight).rejects.toMatchObject({ code: 'closed' })
		await expect(bridge.getToken()).rejects.toMatchObject({ code: 'closed' })
	})

	it('host destroy() closes the bridge and drops (but warns about) later sends', async () => {
		const { host, warnings, connectGuest } = setUp()
		await connectGuest()
		host.destroy()
		expect(host.state).toBe('closed')
		host.navigate('/anywhere')
		expect(warnings.some((w) => w.includes('navigate'))).toBe(true)
	})

	it('guest pathChanged() throws a typed error on a non-string argument', async () => {
		const { connectGuest } = setUp()
		const bridge = await connectGuest()
		expect(() => bridge.pathChanged(42 as unknown as string)).toThrow(BridgeError)
		expect(() => bridge.pathChanged(42 as unknown as string)).toThrow(/expects a string path/)
	})
})
