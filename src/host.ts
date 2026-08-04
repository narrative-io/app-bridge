/**
 * Platform side of the bridge — the half a third-party app never imports.
 *
 * Framework-free on purpose. The Narrative platform wraps this in a Vue
 * composable, but nothing in this package knows about Vue, or about any other
 * framework: the host is a plain state machine over `postMessage`, which also
 * makes it testable without a DOM.
 *
 * Lifecycle:
 *
 * 1. `createBridgeHost` installs a window `message` listener and waits for the
 *    guest's `hello` (guest-initiated, so there is no listener/load race).
 * 2. On a valid `hello` — origin AND source window both checked — the host
 *    builds the handshake (context, capabilities, hasInstallation), creates a
 *    `MessageChannel`, and makes its one and only window-level post,
 *    transferring `port2` to the guest.
 * 3. All further traffic is port-level. Window messages other than a fresh
 *    `hello` are ignored entirely.
 * 4. A fresh `hello` (iframe reload, KeepAlive reactivation) tears down the
 *    old port and issues a new channel.
 */

import {
	BridgeError,
	type BridgeLogEntry,
	type Context,
	type ErrorCode,
	type ErrorMessage,
	GUEST_EVENT_VALIDATORS,
	type HandshakeMessage,
	type HelloRejectedMessage,
	type HostEventMessage,
	isEventMessage,
	isHelloMessage,
	isKnownGuestEvent,
	isKnownMethod,
	isRequestMessage,
	METHOD_NAMES,
	METHOD_PARAM_VALIDATORS,
	type MethodParams,
	PROTOCOL_VERSION,
	type ResultMessage,
	type SessionEndReason,
	type TokenGrant,
} from './protocol.js'

/** What the host needs from the platform to answer the guest. */
export interface BridgeHostHandlers {
	getToken(params: MethodParams['getToken']): Promise<TokenGrant>
	getContext(): Promise<Context>
	/** The guest navigated internally; mirror it into the platform URL. */
	onPathChanged(path: string): void
}

export type BridgeHostState = 'connecting' | 'connected' | 'failed' | 'closed'

/**
 * Structural subset of `HTMLIFrameElement` — keeps the host testable under
 * plain node and free of a hard DOM dependency.
 */
export interface FrameLike {
	contentWindow: {
		postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void
	} | null
}

/** Structural subset of `Window` used for listening. Defaults to `globalThis`. */
export interface MessageListenTarget {
	addEventListener(type: 'message', listener: (evt: MessageEvent) => void): void
	removeEventListener(type: 'message', listener: (evt: MessageEvent) => void): void
}

export interface CreateBridgeHostOptions {
	/** The iframe hosting the guest. */
	frame: FrameLike
	/** The registered origin the guest is served from. The security boundary. */
	appOrigin: string
	handlers: BridgeHostHandlers
	/** Whether the app has an installation for the current company. */
	hasInstallation: () => boolean
	/**
	 * How long to wait for the guest's `hello` before giving up and entering
	 * the `failed` state (an app that never loads, or one that does not speak
	 * the protocol). Default 15s.
	 */
	helloTimeoutMs?: number
	/** Where the window `message` listener is installed. Defaults to `globalThis`. */
	listenTarget?: MessageListenTarget
	onStateChange?: (state: BridgeHostState) => void
	/**
	 * Observe every message crossing the bridge (both directions, handshake
	 * included). Instrumentation only; exceptions from the callback are
	 * swallowed.
	 */
	onLogEntry?: (entry: BridgeLogEntry) => void
	/**
	 * Protocol anomalies (unknown events, malformed messages) are reported
	 * here rather than thrown — they come from the untrusted guest and must
	 * never take the host down. Defaults to `console.warn`.
	 */
	onProtocolWarning?: (message: string) => void
}

export interface BridgeHost {
	readonly state: BridgeHostState
	/** The platform URL changed; tell the guest to show this path. */
	navigate(path: string): void
	/** Live context change (e.g. a View-As company switch). */
	contextChanged(context: Context): void
	/** The signed-in user's platform session ended. */
	sessionEnded(reason: SessionEndReason): void
	destroy(): void
}

const DEFAULT_HELLO_TIMEOUT_MS = 15_000

export function createBridgeHost(options: CreateBridgeHostOptions): BridgeHost {
	const { frame, appOrigin, handlers, hasInstallation } = options
	const listenTarget: MessageListenTarget = options.listenTarget ?? (globalThis as unknown as MessageListenTarget)
	const warn = options.onProtocolWarning ?? ((message: string) => console.warn(`[app-bridge host] ${message}`))

	if (typeof appOrigin !== 'string' || appOrigin === '' || appOrigin === '*') {
		throw new BridgeError(
			'bad_request',
			`createBridgeHost expects a specific appOrigin, received ${JSON.stringify(appOrigin)}`,
		)
	}

	const log = (direction: 'sent' | 'received', transport: 'window' | 'port', label: string, message: unknown) => {
		try {
			options.onLogEntry?.({ at: Date.now(), direction, transport, label, message })
		} catch {
			// A broken observer must never break the bridge.
		}
	}

	let state: BridgeHostState = 'connecting'
	let port: MessagePort | undefined
	/** Guards the async gap between receiving `hello` and posting the handshake. */
	let helloSequence = 0

	const helloTimer = setTimeout(() => {
		if (state === 'connecting') {
			setState('failed')
		}
	}, options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS)

	function setState(next: BridgeHostState) {
		if (state === next) return
		state = next
		options.onStateChange?.(next)
	}

	function teardownPort() {
		if (port) {
			port.onmessage = null
			port.close()
			port = undefined
		}
	}

	function respond(message: ResultMessage | ErrorMessage) {
		const summary = message.ok ? 'ok' : `error: ${message.error.code}`
		log('sent', 'port', `res (${message.id}, ${summary})`, message)
		port?.postMessage(message)
	}

	function respondError(id: string, code: ErrorCode, message: string) {
		respond({ kind: 'res', id, ok: false, error: { code, message } })
	}

	async function dispatchRequest(id: string, method: string, params: unknown) {
		if (!isKnownMethod(method)) {
			respondError(
				id,
				'unsupported_method',
				`Unknown method "${method}". This host supports: ${METHOD_NAMES.join(', ')}.`,
			)
			return
		}
		if (!METHOD_PARAM_VALIDATORS[method](params)) {
			respondError(id, 'bad_request', `Malformed params for "${method}".`)
			return
		}
		try {
			// Both methods funnel through the handlers; the switch keeps each
			// call typed against its own params/result pair.
			const result =
				method === 'getToken'
					? await handlers.getToken(params as MethodParams['getToken'])
					: await handlers.getContext()
			respond({ kind: 'res', id, ok: true, result } as ResultMessage)
		} catch (error) {
			if (error instanceof BridgeError) {
				respondError(id, error.code, error.message)
			} else {
				// Never leak platform internals into a third-party frame.
				warn(`handler for "${method}" threw: ${error instanceof Error ? error.message : String(error)}`)
				respondError(id, 'internal', `The platform failed to answer "${method}".`)
			}
		}
	}

	function onPortMessage(evt: MessageEvent) {
		const data: unknown = evt.data
		if (isRequestMessage(data)) {
			log('received', 'port', `req ${data.method} (${data.id})`, data)
			void dispatchRequest(data.id, data.method, data.params)
			return
		}
		if (isEventMessage(data)) {
			log('received', 'port', `evt ${data.name}`, data)
			if (!isKnownGuestEvent(data.name)) {
				warn(`ignoring unknown guest event "${data.name}"`)
				return
			}
			if (!GUEST_EVENT_VALIDATORS[data.name](data.payload)) {
				warn(`ignoring guest event "${data.name}" with malformed payload`)
				return
			}
			handlers.onPathChanged(data.payload.path)
			return
		}
		warn('ignoring malformed port message')
	}

	/**
	 * Refuse the handshake, telling the guest why. Without this the guest's only
	 * signal would be a connect timeout, which reports "nothing embedded me"
	 * for what is really "the platform could not answer".
	 */
	function rejectHello(contentWindow: NonNullable<FrameLike['contentWindow']>, code: ErrorCode, message: string) {
		const rejection: HelloRejectedMessage = {
			kind: 'nio-bridge:hello-rejected',
			v: PROTOCOL_VERSION,
			error: { code, message },
		}
		log('sent', 'window', `hello-rejected (${code})`, rejection)
		contentWindow.postMessage(rejection, appOrigin)
		setState('failed')
	}

	async function acceptHello(helloVersion: number) {
		const contentWindow = frame.contentWindow
		if (!contentWindow) {
			warn('received hello but the frame has no contentWindow')
			return
		}
		if (helloVersion !== PROTOCOL_VERSION) {
			rejectHello(
				contentWindow,
				'unsupported_version',
				`This platform speaks bridge protocol v${PROTOCOL_VERSION}; the app said hello with v${helloVersion}.`,
			)
			return
		}

		const sequence = ++helloSequence
		let context: Context
		try {
			context = await handlers.getContext()
		} catch (error) {
			// The platform could not describe itself — no signed-in user, for
			// instance. Nothing to hand the guest, so refuse rather than let the
			// rejection escape unhandled and leave the guest waiting for a
			// handshake that will never come.
			if (sequence !== helloSequence || state === 'closed') return
			const code = error instanceof BridgeError ? error.code : 'internal'
			warn(`could not build the handshake context: ${error instanceof Error ? error.message : String(error)}`)
			rejectHello(contentWindow, code, 'The platform could not open a bridge session for this app.')
			return
		}
		// A newer hello arrived while we were building the handshake — let it win.
		if (sequence !== helloSequence || state === 'closed') return

		teardownPort()
		const channel = new MessageChannel()
		port = channel.port1
		port.onmessage = onPortMessage

		const handshake: HandshakeMessage = {
			kind: 'nio-bridge:handshake',
			v: PROTOCOL_VERSION,
			capabilities: [...METHOD_NAMES],
			context,
			hasInstallation: hasInstallation(),
		}
		log('sent', 'window', 'handshake', handshake)
		contentWindow.postMessage(handshake, appOrigin, [channel.port2])
		clearTimeout(helloTimer)
		setState('connected')
	}

	function onWindowMessage(evt: MessageEvent) {
		// Origin AND source are both checked: origin says who sent it, source
		// says which window it came from. A message failing either is not ours.
		if (evt.origin !== appOrigin) return
		if (evt.source !== frame.contentWindow) return
		// The only window-level message the host ever acts on is `hello` —
		// everything else (including anything posted after the handshake)
		// is ignored by construction.
		if (!isHelloMessage(evt.data)) return
		log('received', 'window', `hello (v${evt.data.v})`, evt.data)
		void acceptHello(evt.data.v)
	}

	listenTarget.addEventListener('message', onWindowMessage)

	function postEvent(message: HostEventMessage, description: string) {
		if (state !== 'connected' || !port) {
			warn(`dropping "${description}" — bridge is ${state}`)
			return
		}
		log('sent', 'port', `evt ${message.name}`, message)
		port.postMessage(message)
	}

	return Object.freeze({
		get state() {
			return state
		},
		navigate(path: string) {
			postEvent({ kind: 'evt', name: 'navigate', payload: { path } }, 'navigate')
		},
		contextChanged(context: Context) {
			postEvent({ kind: 'evt', name: 'contextChanged', payload: context }, 'contextChanged')
		},
		sessionEnded(reason: SessionEndReason) {
			postEvent({ kind: 'evt', name: 'sessionEnded', payload: { reason } }, 'sessionEnded')
		},
		destroy() {
			clearTimeout(helloTimer)
			listenTarget.removeEventListener('message', onWindowMessage)
			teardownPort()
			setState('closed')
		},
	})
}
