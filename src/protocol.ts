/**
 * Wire protocol between the Narrative platform (host) and an embedded
 * third-party app UI (guest).
 *
 * Shared by `./host` and `./guest`; a third-party developer normally never
 * touches this module directly, but it is exported so both sides of the
 * conversation are typed against one source of truth.
 *
 * Two invariants the rest of the package is built on:
 *
 * 1. **The guest is untrusted.** Types vanish at runtime and a guest can post
 *    arbitrary garbage, so every inbound message is validated by the
 *    predicates in this file before it is acted on. The validator tables are
 *    keyed `Record<MethodName, …>` / `Record<EventName, …>` so that adding a
 *    message without a validator is a build error, not a latent hole.
 *
 * 2. **Nothing fails silently.** An unknown method returns an
 *    `unsupported_method` error to the caller, and an unknown event is warned
 *    about rather than dropped. A bridge that swallows messages it does not
 *    recognise lets one side's feature rot undetected while the other side
 *    keeps sending it, so this one refuses to do that.
 */

export const PROTOCOL_VERSION = 1 as const

// ---------------------------------------------------------------------------
// Domain objects
// ---------------------------------------------------------------------------

/** A short-lived, installation-scoped API credential. */
export interface TokenGrant {
	token: string
	/** ISO-8601 timestamp after which the token is no longer valid. */
	expiresAt: string
	/** Scopes the token carries, as `access:resource` strings. */
	scopes: string[]
}

/**
 * What an embedded app is told about where it is running.
 *
 * `user` is deliberately much narrower than the platform's internal user
 * object — an embedded frame gets the fields it needs to render and nothing
 * else.
 *
 * **Look & feel is deliberately absent.** Nothing in this protocol describes
 * styling, theming, or any other visual concern, and nothing should be added
 * that does: the bridge carries identity, authorization, and navigation —
 * facts, not presentation. If Narrative ever offers embedded apps a shared
 * visual language, that ships as a separate UI package, not as protocol
 * fields.
 */
export interface Context {
	user: { id: number; name: string; email: string }
	company: { id: number; name: string }
	/** The installation's tier id, e.g. `'free'`. */
	tier: string
	/** Base URL the app should call the Narrative API on. */
	apiBaseUrl: string
	protocolVersion: typeof PROTOCOL_VERSION
}

export type SessionEndReason = 'expired' | 'logout'

/**
 * One observed bridge message, emitted through the optional `onLogEntry`
 * hooks on `connect()` (guest) and `createBridgeHost()` (host).
 * Instrumentation only — never part of the wire protocol, and rendering it
 * is the consumer's job (the bridge carries no UI).
 */
export interface BridgeLogEntry {
	/** Epoch milliseconds. */
	at: number
	direction: 'sent' | 'received'
	transport: 'window' | 'port'
	/** Short human-readable summary, e.g. `req getToken (req-1)`. */
	label: string
	/** The raw message as seen on the wire. Untrusted when received. */
	message: unknown
}

// ---------------------------------------------------------------------------
// Methods (guest asks, host answers)
// ---------------------------------------------------------------------------

export interface MethodParams {
	getToken: { minTtlSeconds?: number }
	getContext: Record<string, never>
}

export interface MethodResult {
	getToken: TokenGrant
	getContext: Context
}

export type MethodName = keyof MethodParams

export const METHOD_NAMES: readonly MethodName[] = ['getToken', 'getContext']

// ---------------------------------------------------------------------------
// Events (fire-and-forget, both directions)
// ---------------------------------------------------------------------------

/** Guest → host. */
export interface GuestEventPayload {
	/** The guest navigated internally; the host mirrors it into the platform URL. */
	pathChanged: { path: string }
}

/** Host → guest. */
export interface HostEventPayload {
	/** The platform URL changed; the guest should show this path. */
	navigate: { path: string }
	/** Live context change (e.g. a View-As company switch). */
	contextChanged: Context
	/** The signed-in user's platform session ended; tokens will stop working. */
	sessionEnded: { reason: SessionEndReason }
}

export type GuestEventName = keyof GuestEventPayload
export type HostEventName = keyof HostEventPayload

export const GUEST_EVENT_NAMES: readonly GuestEventName[] = ['pathChanged']
export const HOST_EVENT_NAMES: readonly HostEventName[] = ['navigate', 'contextChanged', 'sessionEnded']

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ErrorCode =
	| 'unauthorized'
	| 'no_installation'
	| 'session_ended'
	| 'unsupported_method'
	| 'unsupported_version'
	| 'bad_request'
	| 'timeout'
	| 'closed'
	| 'internal'

/**
 * The one error type the package throws. `code` is stable API; `message` is
 * human-facing and may change. For a plain-JS consumer the message is the
 * type system, so both sides put effort into naming what actually went wrong.
 */
export class BridgeError extends Error {
	readonly code: ErrorCode

	constructor(code: ErrorCode, message: string) {
		super(message)
		this.name = 'BridgeError'
		this.code = code
	}
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/**
 * Window-level messages. Exactly two window-level posts ever happen — the
 * guest's `hello` and the host's reply — after which everything moves to the
 * transferred `MessagePort` and window messages are ignored.
 */
export interface HelloMessage {
	kind: 'nio-bridge:hello'
	v: number
}

export interface HandshakeMessage {
	kind: 'nio-bridge:handshake'
	v: typeof PROTOCOL_VERSION
	/** Methods this host implements — guests feature-detect, never version-sniff. */
	capabilities: MethodName[]
	/** Initial context, so the guest renders without a round-trip. */
	context: Context
	/** Whether the app has an installation for this company. */
	hasInstallation: boolean
}

/**
 * Host refuses the handshake — a protocol version it does not speak, or a
 * failure assembling the context.
 *
 * `v` is the version the *host* speaks, which is precisely the version a
 * rejected guest may not share. Guests must therefore not validate it, or a
 * version mismatch would be reported as a connection timeout instead of the
 * `unsupported_version` error that explains it.
 */
export interface HelloRejectedMessage {
	kind: 'nio-bridge:hello-rejected'
	v: number
	error: { code: ErrorCode; message: string }
}

/** Port-level: request (guest → host). */
export interface RequestMessage<M extends MethodName = MethodName> {
	kind: 'req'
	id: string
	method: M
	params: MethodParams[M]
}

/** Port-level: successful response (host → guest). */
export interface ResultMessage<M extends MethodName = MethodName> {
	kind: 'res'
	id: string
	ok: true
	result: MethodResult[M]
}

/** Port-level: failed response (host → guest). */
export interface ErrorMessage {
	kind: 'res'
	id: string
	ok: false
	error: { code: ErrorCode; message: string }
}

/** Port-level: fire-and-forget event (either direction). */
export interface EventMessage<N extends string = string, P = unknown> {
	kind: 'evt'
	name: N
	payload: P
}

export type GuestEventMessage = { [N in GuestEventName]: EventMessage<N, GuestEventPayload[N]> }[GuestEventName]
export type HostEventMessage = { [N in HostEventName]: EventMessage<N, HostEventPayload[N]> }[HostEventName]

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------
//
// Hand-written structural predicates, not a schema library: third parties
// bundle this package, so it ships zero runtime dependencies. The Record
// keying below is what keeps the predicates honest — a method or event added
// to the tables above without a matching validator fails compilation here.

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function isTokenGrant(value: unknown): value is TokenGrant {
	return (
		isRecord(value) &&
		typeof value.token === 'string' &&
		typeof value.expiresAt === 'string' &&
		isStringArray(value.scopes)
	)
}

export function isContext(value: unknown): value is Context {
	if (!isRecord(value)) return false
	const { user, company } = value
	return (
		isRecord(user) &&
		typeof user.id === 'number' &&
		typeof user.name === 'string' &&
		typeof user.email === 'string' &&
		isRecord(company) &&
		typeof company.id === 'number' &&
		typeof company.name === 'string' &&
		typeof value.tier === 'string' &&
		typeof value.apiBaseUrl === 'string' &&
		value.protocolVersion === PROTOCOL_VERSION
	)
}

const ERROR_CODES: readonly ErrorCode[] = [
	'unauthorized',
	'no_installation',
	'session_ended',
	'unsupported_method',
	'unsupported_version',
	'bad_request',
	'timeout',
	'closed',
	'internal',
]

function isErrorShape(value: unknown): value is { code: ErrorCode; message: string } {
	return (
		isRecord(value) &&
		typeof value.message === 'string' &&
		typeof value.code === 'string' &&
		(ERROR_CODES as readonly string[]).includes(value.code)
	)
}

/** Per-method request-params validators. Keyed so a missing one is a build error. */
export const METHOD_PARAM_VALIDATORS: { [M in MethodName]: (params: unknown) => params is MethodParams[M] } = {
	getToken: (params): params is MethodParams['getToken'] =>
		isRecord(params) && (params.minTtlSeconds === undefined || typeof params.minTtlSeconds === 'number'),
	getContext: (params): params is MethodParams['getContext'] => isRecord(params),
}

/** Per-method result validators, applied by the guest to host responses. */
export const METHOD_RESULT_VALIDATORS: { [M in MethodName]: (result: unknown) => result is MethodResult[M] } = {
	getToken: isTokenGrant,
	getContext: isContext,
}

/** Guest → host event payload validators. */
export const GUEST_EVENT_VALIDATORS: {
	[N in GuestEventName]: (payload: unknown) => payload is GuestEventPayload[N]
} = {
	pathChanged: (payload): payload is GuestEventPayload['pathChanged'] =>
		isRecord(payload) && typeof payload.path === 'string',
}

/** Host → guest event payload validators. */
export const HOST_EVENT_VALIDATORS: {
	[N in HostEventName]: (payload: unknown) => payload is HostEventPayload[N]
} = {
	navigate: (payload): payload is HostEventPayload['navigate'] => isRecord(payload) && typeof payload.path === 'string',
	contextChanged: isContext,
	sessionEnded: (payload): payload is HostEventPayload['sessionEnded'] =>
		isRecord(payload) && (payload.reason === 'expired' || payload.reason === 'logout'),
}

export function isHelloMessage(value: unknown): value is HelloMessage {
	return isRecord(value) && value.kind === 'nio-bridge:hello' && typeof value.v === 'number'
}

export function isHandshakeMessage(value: unknown): value is HandshakeMessage {
	return (
		isRecord(value) &&
		value.kind === 'nio-bridge:handshake' &&
		value.v === PROTOCOL_VERSION &&
		isStringArray(value.capabilities) &&
		isContext(value.context) &&
		typeof value.hasInstallation === 'boolean'
	)
}

export function isHelloRejectedMessage(value: unknown): value is HelloRejectedMessage {
	return isRecord(value) && value.kind === 'nio-bridge:hello-rejected' && isErrorShape(value.error)
}

/** Structural check only — `method` and `params` are validated separately. */
export function isRequestMessage(value: unknown): value is RequestMessage {
	return (
		isRecord(value) &&
		value.kind === 'req' &&
		typeof value.id === 'string' &&
		typeof value.method === 'string' &&
		'params' in value
	)
}

export function isResponseMessage(value: unknown): value is ResultMessage | ErrorMessage {
	if (!isRecord(value) || value.kind !== 'res' || typeof value.id !== 'string') return false
	if (value.ok === true) return 'result' in value
	if (value.ok === false) return isErrorShape(value.error)
	return false
}

/** Structural check only — `name` and `payload` are validated separately. */
export function isEventMessage(value: unknown): value is EventMessage {
	return isRecord(value) && value.kind === 'evt' && typeof value.name === 'string' && 'payload' in value
}

export function isKnownMethod(name: string): name is MethodName {
	return (METHOD_NAMES as readonly string[]).includes(name)
}

export function isKnownGuestEvent(name: string): name is GuestEventName {
	return (GUEST_EVENT_NAMES as readonly string[]).includes(name)
}

export function isKnownHostEvent(name: string): name is HostEventName {
	return (HOST_EVENT_NAMES as readonly string[]).includes(name)
}
