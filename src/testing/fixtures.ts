import { type Context, PROTOCOL_VERSION, type TokenGrant } from '../protocol.js'

export function validContext(overrides: Partial<Context> = {}): Context {
	return {
		user: { id: 42, name: 'Ada', email: 'ada@example.com' },
		company: { id: 7, name: 'Example Co' },
		tier: 'free',
		apiBaseUrl: 'https://api.narrative.io',
		protocolVersion: PROTOCOL_VERSION,
		...overrides,
	}
}

export function validGrant(overrides: Partial<TokenGrant> = {}): TokenGrant {
	return {
		token: 'tok_abc',
		expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
		scopes: ['read:datasets'],
		...overrides,
	}
}
