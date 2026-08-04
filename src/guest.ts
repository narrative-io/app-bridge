/**
 * Third-party app side of the bridge. This is the module an app developer
 * imports; it has zero dependencies and makes no network calls of its own.
 *
 * ```js
 * import { connect } from '@narrative.io/app-bridge/guest'
 *
 * const bridge = await connect({ platformOrigin: 'https://app.narrative.io' })
 * const { token } = await bridge.getToken()
 * const res = await fetch(`${bridge.context.apiBaseUrl}/datasets`, {
 *   headers: { Authorization: `Bearer ${token}` },
 * })
 * ```
 *
 * Call `connect()` as early as possible — before your framework boots — so the
 * handshake overlaps your app's own startup. The handshake already carries the
 * initial context, so there is no round-trip before first render.
 */

import {
	BridgeError,
	type BridgeLogEntry,
	type Context,
	type GuestEventMessage,
	type HelloMessage,
	HOST_EVENT_VALIDATORS,
	isEventMessage,
	isHandshakeMessage,
	isHelloRejectedMessage,
	isKnownHostEvent,
	isResponseMessage,
	METHOD_RESULT_VALIDATORS,
	type MethodName,
	type MethodParams,
	type MethodResult,
	PROTOCOL_VERSION,
	type RequestMessage,
	type SessionEndReason,
	type TokenGrant,
} from './protocol.js'

/** Structural subset of `Window` the guest runs against. Injectable for tests. */
export interface GuestWindowLike {
	parent: { postMessage(message: unknown, targetOrigin: string): void }
	addEventListener(type: 'message', listener: (evt: MessageEvent) => void): void
	removeEventListener(type: 'message', listener: (evt: MessageEvent) => void): void
}

export interface ConnectOptions {
	/**
	 * The origin(s) the Narrative platform may embed this app from, e.g.
	 * `'https://app.narrative.io'` or `['https://app.narrative.io',
	 * 'https://app-dev.narrative.io']`. Required: it pins both the outbound
	 * `hello` and the inbound handshake check, so the app never talks to a
	 * page that merely managed to frame it. With multiple candidates the
	 * guest says hello to each; only the window actually embedding it can
	 * receive its own, and the handshake is accepted only from a candidate.
	 */
	platformOrigin: string | string[]
	/** How long to wait for the platform's handshake. Default 15s. */
	connectTimeoutMs?: number
	/** Per-request timeout. Default 10s. */
	requestTimeoutMs?: number
	/**
	 * Observe every message crossing the bridge (both directions, handshake
	 * included) — for a devtools panel or console logging. Instrumentation
	 * only: exceptions from the callback are swallowed, and rendering is the
	 * app's job.
	 */
	onLogEntry?: (entry: BridgeLogEntry) => void
	/** Test injection point. Defaults to the real `window`. */
	windowRef?: GuestWindowLike
}

export interface AppBridge {
	/** Live context — starts from the handshake, updated on `contextChanged`. */
	readonly context: Context
	readonly hasInstallation: boolean
	/** Methods the embedding platform supports. Feature-detect against this. */
	readonly capabilities: readonly string[]
	/**
	 * A token for calling the Narrative API. Cached; a fresh one is fetched
	 * automatically when the cached token has less than `minTtlSeconds`
	 * (default 30) of life left.
	 */
	getToken(params?: { minTtlSeconds?: number }): Promise<TokenGrant>
	/** Re-read the context from the platform. Rarely needed — see `onContextChange`. */
	getContext(): Promise<Context>
	/** Tell the platform this app navigated internally (mirrored into the platform URL). */
	pathChanged(path: string): void
	/** The platform URL changed; show this path. Returns an unsubscribe function. */
	onNavigate(callback: (path: string) => void): () => void
	onContextChange(callback: (context: Context) => void): () => void
	onSessionEnd(callback: (reason: SessionEndReason) => void): () => void
	close(): void
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_TOKEN_MIN_TTL_SECONDS = 30

interface PendingRequest {
	method: MethodName
	resolve: (value: never) => void
	reject: (reason: BridgeError) => void
	timer: ReturnType<typeof setTimeout>
}

export function connect(options: ConnectOptions): Promise<AppBridge> {
	const candidates = Array.isArray(options?.platformOrigin) ? options.platformOrigin : [options?.platformOrigin]
	if (
		candidates.length === 0 ||
		candidates.some((origin) => typeof origin !== 'string' || origin === '' || origin === '*')
	) {
		return Promise.reject(
			new BridgeError(
				'bad_request',
				`connect() requires one or more specific platform origins (e.g. 'https://app.narrative.io'), received ${JSON.stringify(options?.platformOrigin)}.`,
			),
		)
	}
	const windowRef = options.windowRef ?? (globalThis as unknown as GuestWindowLike)
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
	const log = (direction: 'sent' | 'received', transport: 'window' | 'port', label: string, message: unknown) => {
		try {
			options.onLogEntry?.({ at: Date.now(), direction, transport, label, message })
		} catch {
			// A broken observer must never break the bridge.
		}
	}

	return new Promise<AppBridge>((resolveConnect, rejectConnect) => {
		const connectTimer = setTimeout(() => {
			windowRef.removeEventListener('message', onWindowMessage)
			rejectConnect(
				new BridgeError(
					'timeout',
					`No handshake from ${candidates.join(' or ')} within ${options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS}ms. ` +
						'Either this app is not embedded in the Narrative platform, or platformOrigin does not match the embedding page.',
				),
			)
		}, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)

		function onWindowMessage(evt: MessageEvent) {
			if (!candidates.includes(evt.origin)) return
			const data: unknown = evt.data
			if (isHelloRejectedMessage(data)) {
				log('received', 'window', `hello-rejected (${data.error.code})`, data)
				clearTimeout(connectTimer)
				windowRef.removeEventListener('message', onWindowMessage)
				rejectConnect(new BridgeError(data.error.code, data.error.message))
				return
			}
			if (!isHandshakeMessage(data)) return
			const port = evt.ports[0]
			if (!port) return
			log('received', 'window', `handshake (capabilities: ${data.capabilities.join(', ')})`, data)
			clearTimeout(connectTimer)
			windowRef.removeEventListener('message', onWindowMessage)
			resolveConnect(createBridge(port, data.context, data.hasInstallation, data.capabilities))
		}

		windowRef.addEventListener('message', onWindowMessage)
		const hello: HelloMessage = { kind: 'nio-bridge:hello', v: PROTOCOL_VERSION }
		// One hello per candidate: the browser only delivers a post whose
		// targetOrigin matches the actual parent, so at most one arrives.
		for (const candidate of candidates) {
			log('sent', 'window', `hello → ${candidate}`, hello)
			windowRef.parent.postMessage(hello, candidate)
		}
	})

	function createBridge(
		port: MessagePort,
		initialContext: Context,
		hasInstallation: boolean,
		capabilities: MethodName[],
	): AppBridge {
		let context = initialContext
		let closed = false
		let requestSequence = 0
		const pending = new Map<string, PendingRequest>()
		const listeners = {
			navigate: new Set<(path: string) => void>(),
			contextChanged: new Set<(context: Context) => void>(),
			sessionEnded: new Set<(reason: SessionEndReason) => void>(),
		}

		let cachedGrant: TokenGrant | undefined
		let grantInFlight: Promise<TokenGrant> | undefined

		port.onmessage = (evt: MessageEvent) => {
			const data: unknown = evt.data
			if (isResponseMessage(data)) {
				const entry = pending.get(data.id)
				log(
					'received',
					'port',
					`res ${entry?.method ?? '?'} (${data.id}, ${data.ok ? 'ok' : `error: ${data.error.code}`})`,
					data,
				)
				if (!entry) return
				pending.delete(data.id)
				clearTimeout(entry.timer)
				if (!data.ok) {
					entry.reject(new BridgeError(data.error.code, data.error.message))
					return
				}
				if (!METHOD_RESULT_VALIDATORS[entry.method](data.result)) {
					entry.reject(
						new BridgeError('bad_request', `The platform returned a malformed result for "${entry.method}".`),
					)
					return
				}
				entry.resolve(data.result as never)
				return
			}
			if (isEventMessage(data)) {
				log('received', 'port', `evt ${data.name}`, data)
				if (!isKnownHostEvent(data.name)) return
				if (!HOST_EVENT_VALIDATORS[data.name](data.payload)) return
				switch (data.name) {
					case 'navigate': {
						const { path } = data.payload as { path: string }
						for (const callback of listeners.navigate) callback(path)
						break
					}
					case 'contextChanged': {
						context = data.payload as Context
						for (const callback of listeners.contextChanged) callback(context)
						break
					}
					case 'sessionEnded': {
						// Tokens minted through the dead session will stop working;
						// don't serve them from cache.
						cachedGrant = undefined
						const { reason } = data.payload as { reason: SessionEndReason }
						for (const callback of listeners.sessionEnded) callback(reason)
						break
					}
				}
			}
		}

		function request<M extends MethodName>(method: M, params: MethodParams[M]): Promise<MethodResult[M]> {
			if (closed) {
				return Promise.reject(new BridgeError('closed', `Cannot call "${method}" — the bridge has been closed.`))
			}
			return new Promise<MethodResult[M]>((resolve, reject) => {
				const id = `req-${++requestSequence}`
				const timer = setTimeout(() => {
					pending.delete(id)
					reject(new BridgeError('timeout', `The platform did not answer "${method}" within ${requestTimeoutMs}ms.`))
				}, requestTimeoutMs)
				pending.set(id, { method, resolve: resolve as (value: never) => void, reject, timer })
				const message: RequestMessage<M> = { kind: 'req', id, method, params }
				log('sent', 'port', `req ${method} (${id})`, message)
				port.postMessage(message)
			})
		}

		function subscribe<T>(set: Set<T>, callback: T): () => void {
			set.add(callback)
			return () => {
				set.delete(callback)
			}
		}

		return Object.freeze({
			get context() {
				return context
			},
			hasInstallation,
			capabilities: Object.freeze([...capabilities]),
			getToken(params?: { minTtlSeconds?: number }) {
				if (params !== undefined && (typeof params !== 'object' || params === null)) {
					return Promise.reject(
						new BridgeError('bad_request', `getToken() expects an options object, received ${typeof params}.`),
					)
				}
				const minTtlMs = (params?.minTtlSeconds ?? DEFAULT_TOKEN_MIN_TTL_SECONDS) * 1000
				if (cachedGrant && new Date(cachedGrant.expiresAt).getTime() - Date.now() > minTtlMs) {
					return Promise.resolve(cachedGrant)
				}
				// Single-flight: concurrent callers share one renewal.
				grantInFlight ??= request('getToken', params ?? {})
					.then((grant) => {
						cachedGrant = grant
						return grant
					})
					.finally(() => {
						grantInFlight = undefined
					})
				return grantInFlight
			},
			getContext() {
				return request('getContext', {})
			},
			pathChanged(path: string) {
				if (typeof path !== 'string') {
					throw new BridgeError('bad_request', `pathChanged() expects a string path, received ${typeof path}.`)
				}
				if (closed) return
				const message: GuestEventMessage = { kind: 'evt', name: 'pathChanged', payload: { path } }
				log('sent', 'port', 'evt pathChanged', message)
				port.postMessage(message)
			},
			onNavigate(callback: (path: string) => void) {
				return subscribe(listeners.navigate, callback)
			},
			onContextChange(callback: (context: Context) => void) {
				return subscribe(listeners.contextChanged, callback)
			},
			onSessionEnd(callback: (reason: SessionEndReason) => void) {
				return subscribe(listeners.sessionEnded, callback)
			},
			close() {
				if (closed) return
				closed = true
				cachedGrant = undefined
				grantInFlight = undefined
				for (const [, entry] of pending) {
					clearTimeout(entry.timer)
					entry.reject(new BridgeError('closed', 'The bridge was closed before the platform answered.'))
				}
				pending.clear()
				port.onmessage = null
				port.close()
			},
		})
	}
}
