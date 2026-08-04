import { describe, expect, it } from 'vitest'
import {
	GUEST_EVENT_VALIDATORS,
	HOST_EVENT_VALIDATORS,
	isContext,
	isEventMessage,
	isHandshakeMessage,
	isHelloMessage,
	isHelloRejectedMessage,
	isRequestMessage,
	isResponseMessage,
	isTokenGrant,
	METHOD_PARAM_VALIDATORS,
	METHOD_RESULT_VALIDATORS,
	PROTOCOL_VERSION,
} from './protocol.js'
import { validContext, validGrant } from './testing/fixtures.js'

describe('protocol validators', () => {
	describe('isTokenGrant', () => {
		it('accepts a well-formed grant', () => {
			expect(isTokenGrant(validGrant())).toBe(true)
		})

		it('rejects a grant with non-string scopes', () => {
			expect(isTokenGrant({ ...validGrant(), scopes: [1] })).toBe(false)
		})

		it('rejects null, arrays, and primitives', () => {
			expect(isTokenGrant(null)).toBe(false)
			expect(isTokenGrant([])).toBe(false)
			expect(isTokenGrant('token')).toBe(false)
		})
	})

	describe('isContext', () => {
		it('accepts a well-formed context', () => {
			expect(isContext(validContext())).toBe(true)
		})

		it('rejects a context with the wrong protocol version', () => {
			expect(isContext({ ...validContext(), protocolVersion: 999 })).toBe(false)
		})

		it('rejects a context with a malformed company', () => {
			expect(isContext({ ...validContext(), company: { id: '7', name: 'Example Co' } })).toBe(false)
		})
	})

	describe('window-level messages', () => {
		it('recognises hello', () => {
			expect(isHelloMessage({ kind: 'nio-bridge:hello', v: 1 })).toBe(true)
			expect(isHelloMessage({ kind: 'hello', v: 1 })).toBe(false)
			expect(isHelloMessage({ kind: 'nio-bridge:hello' })).toBe(false)
		})

		it('recognises a handshake carrying context and capabilities', () => {
			const handshake = {
				kind: 'nio-bridge:handshake',
				v: PROTOCOL_VERSION,
				capabilities: ['getToken', 'getContext'],
				context: validContext(),
				hasInstallation: true,
			}
			expect(isHandshakeMessage(handshake)).toBe(true)
			expect(isHandshakeMessage({ ...handshake, context: {} })).toBe(false)
			expect(isHandshakeMessage({ ...handshake, v: 2 })).toBe(false)
		})

		it('recognises hello-rejected and demands a known error code', () => {
			const rejected = {
				kind: 'nio-bridge:hello-rejected',
				v: PROTOCOL_VERSION,
				error: { code: 'unsupported_version', message: 'nope' },
			}
			expect(isHelloRejectedMessage(rejected)).toBe(true)
			expect(isHelloRejectedMessage({ ...rejected, error: { code: 'wat', message: 'nope' } })).toBe(false)
		})
	})

	describe('port-level messages', () => {
		it('recognises requests structurally', () => {
			expect(isRequestMessage({ kind: 'req', id: '1', method: 'getToken', params: {} })).toBe(true)
			expect(isRequestMessage({ kind: 'req', id: 1, method: 'getToken', params: {} })).toBe(false)
			expect(isRequestMessage({ kind: 'req', id: '1', method: 'getToken' })).toBe(false)
		})

		it('recognises ok and error responses, and nothing in between', () => {
			expect(isResponseMessage({ kind: 'res', id: '1', ok: true, result: {} })).toBe(true)
			expect(isResponseMessage({ kind: 'res', id: '1', ok: false, error: { code: 'internal', message: 'x' } })).toBe(
				true,
			)
			expect(isResponseMessage({ kind: 'res', id: '1', ok: 'yes', result: {} })).toBe(false)
			expect(isResponseMessage({ kind: 'res', id: '1', ok: false, error: { code: 'nope', message: 'x' } })).toBe(false)
		})

		it('recognises events structurally', () => {
			expect(isEventMessage({ kind: 'evt', name: 'pathChanged', payload: { path: '/x' } })).toBe(true)
			expect(isEventMessage({ kind: 'evt', payload: {} })).toBe(false)
		})
	})

	describe('method validators', () => {
		it('getToken params allow an optional numeric minTtlSeconds', () => {
			expect(METHOD_PARAM_VALIDATORS.getToken({})).toBe(true)
			expect(METHOD_PARAM_VALIDATORS.getToken({ minTtlSeconds: 60 })).toBe(true)
			expect(METHOD_PARAM_VALIDATORS.getToken({ minTtlSeconds: '60' })).toBe(false)
			expect(METHOD_PARAM_VALIDATORS.getToken(null)).toBe(false)
		})

		it('result validators check the domain shapes', () => {
			expect(METHOD_RESULT_VALIDATORS.getToken(validGrant())).toBe(true)
			expect(METHOD_RESULT_VALIDATORS.getToken({})).toBe(false)
			expect(METHOD_RESULT_VALIDATORS.getContext(validContext())).toBe(true)
		})
	})

	describe('event validators', () => {
		it('validates guest events', () => {
			expect(GUEST_EVENT_VALIDATORS.pathChanged({ path: '/reports' })).toBe(true)
			expect(GUEST_EVENT_VALIDATORS.pathChanged({ path: 3 })).toBe(false)
		})

		it('validates host events', () => {
			expect(HOST_EVENT_VALIDATORS.navigate({ path: '/x' })).toBe(true)
			expect(HOST_EVENT_VALIDATORS.sessionEnded({ reason: 'logout' })).toBe(true)
			expect(HOST_EVENT_VALIDATORS.sessionEnded({ reason: 'crashed' })).toBe(false)
			expect(HOST_EVENT_VALIDATORS.contextChanged(validContext())).toBe(true)
		})
	})
})
