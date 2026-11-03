# Deployment

Prismfall is played locally on the owner's PC. **Nothing is deployed, and nothing should be deployed publicly.** This document covers three things:

- how to play locally;
- how to produce a static build;
- how to reach the game privately from another device, such as a laptop on the home network or a standalone VR headset, if that is ever wanted.

## Rules

- **No public deployment.** The game must never be reachable by anyone except the owner. A private repository does not make a website private.
- **Real access control or nothing.** Remote access must sit behind server-side authentication: an identity-aware gateway, a private network or client certificates.
  - An unguessable or "secret" URL is **not** security: URLs leak through history, logs, screenshots and link previews.
  - A password screen in the page is **not** security: the files are downloaded before the check runs, and the check can be skipped.
- **The repository stays private.** It is a local git repository with no remote. Do not add one, and do not publish it.
- **No automatic publishing.** There is no CI, no deploy script and no hosting configuration. Every step below is manual and deliberate.
- **No analytics or external calls.**
  - The game loads only its own files: models, music, workers and fonts all come from the game's own origin. Fonts are bundled through `@fontsource`.
  - `index.html` sets `referrer: no-referrer`.
  - Nothing is sent anywhere. Keep it that way: if a proxy or CDN offers to inject scripts (web analytics, script optimisers), leave that feature off.
- **Never weaken browser security as a workaround.** For example, do not use `chrome://flags/#unsafely-treat-insecure-origin-as-secure` or the `--unsafely-treat-insecure-origin-as-secure` switch to make WebGPU, AudioWorklet or WebXR work over plain HTTP. Use localhost or real HTTPS instead.
  - The Playwright and perf configs start their own automated Chrome with GPU flags (`--enable-unsafe-webgpu`, `--ignore-gpu-blocklist`). Those flags are for that test browser only. Never add them to an everyday browser.

## Local play

The supported way to play:

```bat
Play.cmd             :: install if needed, build if dist\ is missing, serve, open the game
Play.cmd --rebuild   :: rebuild first, after updating the code
```

`Play.cmd`:

1. Runs `npm install` if `node_modules\` is missing.
2. Runs `npm run build` if `dist\index.html` is missing. The build validates content and typechecks first.
3. Starts `vite preview` on http://localhost:4173, unless something already answers there.
4. Opens Chrome, or Edge if Chrome is not found, in app mode with the profile `%LOCALAPPDATA%\Prismfall\chrome-profile`. If neither browser is found, it opens the default browser.

Without the launcher, the same steps are `npm install`, `npm run build`, `npm run preview`, then open http://localhost:4173.

**Why localhost is enough:** browsers treat `http://localhost` as a secure context. WebGPU, AudioWorklet (used by the music analysis), the Gamepad API and WebXR all work there without HTTPS.

**VR on the same PC:** with a PC-tethered headset (Quest Link or Air Link, or a SteamVR headset), open the game in Chrome or Edge on the PC and use **Play in VR**. No deployment is needed for that. VR has so far been tested only under emulation (IWER), never on a real headset; see [VR_TESTING.md](VR_TESTING.md).

The dev server (5173) and the preview server (4173) both bind to `localhost` only (`vite.config.ts`). Other machines on the network cannot reach them, which is intended.

## Building a static bundle

```sh
npm run build        # prebuild: content validation; then typecheck; then vite build → dist/
```

- `dist/` is a plain static site: HTML, hashed JS, CSS, GLB models, images, an audio worklet and web workers.
  - It needs no server-side code, no special headers and no cross-origin isolation.
  - There is no service worker.
- `vite.config.ts` sets `base: './'`, so asset URLs are relative and the bundle works from any path, for example `https://host/` or `https://host/prismfall/`.
- Production builds compile out the debug hooks (`window.__PRISMFALL__`) and contain no source maps.
- **Only ever serve `dist/` remotely.**
  - Never expose the dev server: it serves the source tree and has the debug hooks.
  - Never expose the test build in `dist-test/`: it has the debug hooks and source maps.

Any static file server can serve `dist/`. `vite preview` is fine for single-user use on the PC. For an always-on setup behind a reverse proxy, the proxy can serve `dist/` directly.

## Saves on another origin

Saves live in IndexedDB, **per origin** (scheme + host + port). Each of these has a separate save:

- http://localhost:4173;
- a tailnet or tunnel address such as `https://pc.example.ts.net`;
- every browser profile, including the `Play.cmd` profile.

To carry progress over, use **Settings → Data → Export save file** on one, then **Import save file** on the other. The export holds settings, progress, lifetime statistics and high scores. Replays and music files added in the Music Room stay where they were made.

## Private access from other devices

Use this only when there is a concrete need, such as a standalone headset's own browser. Two requirements apply to every option.

**1. HTTPS is mandatory.**
- `http://192.168.x.x:4173` is not a secure context: WebGPU, AudioWorklet and WebXR will not run there.
- The certificate must be trusted by the device. A standalone headset browser practically needs a publicly trusted certificate, such as Let's Encrypt, which the options below provide.

**2. Access control must be enforced by a server or network layer before any game file is served.**

Pick **one** of the following options.

### Option A: Tailscale, tailnet only (simplest)

Every device must run the Tailscale client and be signed in to your tailnet. Nothing is reachable from the internet.

1. Install Tailscale on the PC and on the other device, signed in to the same account.
2. In the Tailscale admin console, enable MagicDNS and HTTPS certificates.
3. Start the game server on the PC, with `Play.cmd` or `npm run preview`.
4. Publish it **inside the tailnet** with HTTPS:

   ```sh
   tailscale serve --bg 4173
   ```

   It is then served at `https://<pc-name>.<tailnet>.ts.net/`. Stop it with `tailscale serve reset`.

5. Keep the tailnet's access rules (ACLs) limited to your own devices.

- **Use `tailscale serve`, never `tailscale funnel`.** Funnel publishes to the public internet.
- `vite preview` listens on `localhost`, which can resolve to `127.0.0.1` or `::1`. If the proxy cannot reach the game, check which address the server is listening on (`netstat -ano | findstr 4173`) and point `tailscale serve` at that address explicitly.

### Option B: Cloudflare Tunnel behind Cloudflare Access

Use this if a device cannot run Tailscale. It needs a domain on Cloudflare.

1. **First**, in Cloudflare Zero Trust, create an **Access application** for the hostname, for example `prismfall.example.com`. Give it a policy that allows only your own identity: your e-mail via one-time PIN, or your identity provider.
2. **Then** run a named tunnel (`cloudflared`) that routes that hostname to `http://localhost:4173`.
3. Confirm from a private browser window that the hostname shows the Cloudflare login, not the game.

- Never route a tunnel without the Access policy in place.
- Never use "quick tunnels" (`trycloudflare.com` URLs): they are public, random URLs.
- Keep script-injecting features (Web Analytics, Rocket Loader) disabled for the hostname.
- Cloudflare terminates TLS, so it carries the traffic. Decide whether that is acceptable.

### Option C: your own reverse proxy with real authentication

Use this for an always-on home server or the PC itself. Run Caddy or nginx with a valid certificate and put one of these in front of the game:

- **oauth2-proxy** (or an equivalent OIDC gateway), allowing only your account; or
- **mutual TLS**: the proxy requires a client certificate that only your devices hold.

The proxy can serve `dist/` directly, so no Node process is needed. Never forward a router port to an unauthenticated server.

### Checklist before using remote access

- [ ] Opening the address in a private window, without signing in, does **not** show the game.
- [ ] The address is HTTPS, and the device shows no certificate warning.
- [ ] Only `dist/` (a production build) is served.
- [ ] Nothing on the router forwards a port to the PC without authentication.
- [ ] The repository still has no remote.
