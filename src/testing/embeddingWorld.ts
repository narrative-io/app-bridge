import type { GuestWindowLike } from '../guest.js'
import type { FrameLike, MessageListenTarget } from '../host.js'

type Listener = (evt: MessageEvent) => void

export interface EmbeddingWorld {
	/** What the platform passes to `createBridgeHost`. */
	frame: FrameLike
	platformWindow: MessageListenTarget
	/** What the guest passes to `connect` as `windowRef`. */
	guestWindow: GuestWindowLike
	/** Craft an arbitrary event on the platform window (attacker simulation). */
	deliverToPlatform(evt: Partial<MessageEvent>): void
	/** Craft an arbitrary event on the guest window. */
	deliverToGuest(evt: Partial<MessageEvent>): void
}

/**
 * Two fake windows wired the way a real embedding is: the guest's
 * `parent.postMessage` arrives on the platform window with the guest's origin
 * and the frame's `contentWindow` as `source`; the platform's
 * `frame.contentWindow.postMessage` arrives on the guest window with the
 * platform's origin and any transferred ports attached.
 *
 * `targetOrigin` is honoured: a post whose targetOrigin matches neither `'*'`
 * nor the receiving window's origin is dropped, as a browser would.
 * `MessagePort` objects are the real thing (node globals), so port traffic is
 * genuinely asynchronous.
 */
export function createEmbeddingWorld({
	appOrigin,
	platformOrigin,
}: {
	appOrigin: string
	platformOrigin: string
}): EmbeddingWorld {
	const platformListeners = new Set<Listener>()
	const guestListeners = new Set<Listener>()

	function deliver(listeners: Set<Listener>, evt: Partial<MessageEvent>) {
		for (const listener of [...listeners]) {
			listener({ ports: [], ...evt } as MessageEvent)
		}
	}

	const guestContentWindow = {
		postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]) {
			if (targetOrigin !== '*' && targetOrigin !== appOrigin) return
			deliver(guestListeners, { origin: platformOrigin, data: message, ports: (transfer ?? []) as MessagePort[] })
		},
	}

	return {
		frame: { contentWindow: guestContentWindow },
		platformWindow: {
			addEventListener: (_type, listener) => platformListeners.add(listener),
			removeEventListener: (_type, listener) => platformListeners.delete(listener),
		},
		guestWindow: {
			parent: {
				postMessage(message: unknown, targetOrigin: string) {
					if (targetOrigin !== '*' && targetOrigin !== platformOrigin) return
					deliver(platformListeners, {
						origin: appOrigin,
						source: guestContentWindow as unknown as Window,
						data: message,
					})
				},
			},
			addEventListener: (_type, listener) => guestListeners.add(listener),
			removeEventListener: (_type, listener) => guestListeners.delete(listener),
		},
		deliverToPlatform: (evt) => deliver(platformListeners, evt),
		deliverToGuest: (evt) => deliver(guestListeners, evt),
	}
}
