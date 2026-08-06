# Making your app frameable

The single most common reason an embedded app shows a blank frame is a response
header, not a bug in the code. This page is the configuration you need on your
own server.

It is worth stating plainly because it surprises people: **the platform cannot
make your app embeddable.** If your server tells the browser "refuse to frame
this", the browser refuses, and no amount of bridge configuration, origin
registration, or platform CSP changes that. The check happens before your
JavaScript ever runs.

## The one header that matters

Send a CSP `frame-ancestors` directive naming the platform:

```http
Content-Security-Policy: frame-ancestors https://app.narrative.io;
```

That says: only `app.narrative.io` may put this page in a frame. Everyone else is
refused by the browser.

**Do not send `X-Frame-Options`.** It is the older mechanism and it cannot
express an allow-list — its only useful values are `DENY` and `SAMEORIGIN`, both
of which make your app unembeddable. If a framework or host adds it by default,
remove it. Where both headers are present, browsers that support
`frame-ancestors` prefer it, but older ones do not, so leaving `X-Frame-Options`
in place is a portability bug rather than a belt-and-braces measure.

### Why not just omit both?

Omitting them works — the default is that anyone may frame you — and it is the
wrong choice. Without `frame-ancestors`, any site can embed your app and attempt
clickjacking against whatever it renders. Your `platformOrigin` pin stops that
site completing a bridge handshake, so it cannot reach your context or your
token, but it can still frame the page. Send the header.

## Configuration by host

### Cloudflare Pages / Workers

A `_headers` file at the root of your build output:

```
/*
  Content-Security-Policy: frame-ancestors https://app.narrative.io;
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

### nginx

```nginx
add_header Content-Security-Policy "frame-ancestors https://app.narrative.io;" always;
# If a parent block sets X-Frame-Options, clear it here.
proxy_hide_header X-Frame-Options;
```

### Vercel

In `vercel.json`:

```json
{
	"headers": [
		{
			"source": "/(.*)",
			"headers": [
				{ "key": "Content-Security-Policy", "value": "frame-ancestors https://app.narrative.io;" }
			]
		}
	]
}
```

### Netlify

In `netlify.toml`:

```toml
[[headers]]
  for = "/*"
  [headers.values]
    Content-Security-Policy = "frame-ancestors https://app.narrative.io;"
```

### Express

`helmet` sets `X-Frame-Options: SAMEORIGIN` by default, which will break
embedding. Turn it off and set the directive instead:

```js
app.use(
	helmet({
		frameguard: false, // removes X-Frame-Options
		contentSecurityPolicy: {
			directives: { frameAncestors: ["'self'", 'https://app.narrative.io'] },
		},
	}),
)
```

### Django, Rails, and other batteries-included frameworks

Most send `X-Frame-Options: DENY` or `SAMEORIGIN` out of the box. Django:
`X_FRAME_OPTIONS` and the `XFrameOptionsMiddleware`. Rails:
`config.action_dispatch.default_headers`. Find the default before assuming it
isn't there — this is the usual cause of "it works locally, it's blank in
production", because dev servers rarely send it and production configurations do.

## The rest of the checklist

**Serve over HTTPS.** A page on `https://` cannot frame content from `http://`;
browsers block the mixed content. `localhost` is exempt during development.

**Do not set `X-Frame-Options` anywhere in the chain.** A CDN, a reverse proxy,
or a WAF may add it after your application server. Check what actually arrives.

**Cookies need `SameSite=None; Secure`** if your app relies on them, because in a
frame they are third-party cookies. Better still, do not rely on cookies at all —
the bridge hands you a token, which is not subject to third-party cookie
restrictions and will not be blocked by tracking protection.

**Storage may be partitioned.** Browsers increasingly isolate `localStorage`,
`IndexedDB`, and cookies per top-level site for framed content. Do not assume
your app's storage is shared with the same app opened in its own tab. (You should
not be persisting the bridge token anyway — see the
[security model](security.md).)

## Checking your configuration

Look at what your server actually sends, from the deployed origin rather than
from a dev server:

```bash
curl -sI https://your-app.example | grep -iE "content-security-policy|x-frame-options"
```

You want to see a `frame-ancestors` directive naming the platform, and no
`X-Frame-Options` line at all.

If the frame is still blank, open the browser console **on the platform page**,
not on yours. A refused frame is reported by the embedding page, which is why the
error is easy to miss — your own devtools will show nothing, because your page
never loaded.

## When it is the platform's side

Your app also has to be registered with Narrative. The platform will only frame
an origin it knows about, and derives its own CSP `frame-src` allow-list from the
same registration, so an unregistered origin is refused by the platform's policy
before yours is ever consulted. If your headers are correct and the frame is
still empty, that is the next thing to check.

See [troubleshooting](troubleshooting.md) for the failure modes that are *not*
header-related.
