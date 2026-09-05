# YouTube Subscriptions Helper

The companion Chrome extension imports YouTube browser-session cookies, reads PocketTube categories, and relays Desktop-app OAuth callbacks to the configured application. OAuth relay requires build **2.6** or later for HTTP loopback destinations.

## Supported App Origins

Set **App origin** in the extension popup's **Settings**, click **Apply**, then approve Chrome's host-access prompt when requested.

| Origin | Supported |
| --- | --- |
| `http://127.0.0.1:8098` | Yes, including other ports |
| `http://localhost:8098` | Yes, including other ports |
| `https://app.example.com:8443` | Yes, with Chrome host permission |
| `https://192.168.1.20` | Yes, with a trusted certificate and Chrome host permission |
| `http://192.168.1.20:8098` or `http://homeassistant.local:8098` | No, non-loopback hosts require HTTPS |
| HTTP loopback lookalikes, numeric aliases, or IPv6 | No |

HTTP accepts only the exact hostnames `localhost` and `127.0.0.1`, not `localhost.example.com`, `127.0.0.1.example.com`, `127.1`, or other aliases. HTTPS loopback destinations are not relay targets. The relay requires an explicitly saved origin; the unsaved default does not intercept OAuth callbacks. Chrome's host grants span ports, but the worker checks the configured origin including its port before forwarding.

## Home Assistant Add-on

For an app reachable from Chrome at `http://127.0.0.1:8098`, save that exact app origin in the extension. Loopback refers to the computer running Chrome: the local port must already reach the add-on, for example through a trusted local port forward. Merely entering a loopback address does not create a tunnel.

Google's Desktop-app redirect remains **`http://localhost:8085/`**. The extension observes only valid top-level callback navigations, replaces the sensitive callback URL with the app URL (or closes the tab if replacement fails), and POSTs the callback to:

```text
http://127.0.0.1:8098/api/auth/oauth/callback/
```

Do not change Google's redirect URI or publish container port 8085. The backend still needs to bind `localhost:8085` **inside its container**; host port 8085 may remain assigned to another add-on. The app endpoint on port 8098 must be reachable from Chrome.

The backend validates OAuth state against the pending in-memory flow and completes token exchange once. If a real local listener also receives the callback, concurrent completion is guarded and replay after success returns the existing result without overwriting it. The extension suppresses simultaneous duplicate events per tab; later retries and other tabs are still subject to the backend's single-use safeguards.

## Install or Reload in Chrome

1. Update the files in the directory from which Chrome loads the extension. If the repository is on the add-on host, update the copy on the Chrome computer too.
2. Open `chrome://extensions` in the Chrome profile used for sign-in and enable **Developer mode**.
3. Find **YouTube Subscriptions Helper**. For an existing installation, click the circular **Reload** arrow on its card. For a new installation, click **Load unpacked** and select the `extension/` directory containing the manifest.
4. Open the extension popup's main view. Its build footer must report both **Build 2.6 (manifest)** and **worker 2.6**. A new manifest version alone does not prove the service worker updated.
5. If the worker remains stale or does not answer, use the popup's reload button or the card's **Reload** arrow again. As a last resort, remove the extension and load the updated directory again. Removal clears saved settings and permissions, so reconfigure them afterward.
6. Open **Settings**, enter the app origin, click **Apply**, approve any requested host access, and reload the app tab so its content bridge is refreshed.
7. If the previous OAuth flow expired or the backend restarted, begin a fresh sign-in from the app. Otherwise, let the active flow complete normally. Do not paste callback URLs into consoles or issue reports.

Refreshing the app tab, pulling new files, or restarting Chrome alone is not a reliable extension update. Verify both build numbers.

## Security and Limitations

- Origin validation, Chrome host-permission checks, and configuration rechecks apply to both HTTP loopback and remote HTTPS relay destinations.
- Callback validation remains restricted to the exact Desktop callback host, port, path, bounded query, and unambiguous state/code-or-error shape. Subframes are ignored.
- The relay uses a 15-second timeout, a 16 KiB response limit, and rejects redirects. It does not log or persist callback URLs, authorization codes, state values, or tokens.
- If tab replacement and closing both fail, no callback is forwarded. Failures never count as successful authentication; the app polls the backend for the authoritative state.
- Navigation scrubbing is best-effort, not a blocking network firewall: an existing local listener can race with the extension. Only use trusted local listeners and port forwards.
- Start and completion must reach the same Django process. Restarting the backend loses the pending flow.
- Relay support does not add application authentication or make the default API safe for public exposure. Use trusted local access or properly secured HTTPS deployment.

## Tests

From the repository root:

```bash
node extension/tests/harness.mjs
python manage.py test subscriptions.tests.test_youtube_service.YouTubeServiceOAuthTest --noinput
```

These tests use synthetic callbacks, mocked network calls, and temporary backend token files. They do not initiate Google authorization.