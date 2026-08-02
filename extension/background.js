// Background service worker — delivers YouTube cookies to the app page, and
// runs the one-way "Sync categories from PocketTube" import, posting the result
// to the app's /api/categories/import/ endpoint.
//
// Two sources feed that import:
//   live  (default) — PocketTube's Subscription Manager answers the read-only
//                     `get_channel_data` request on youtube.com's page message
//                     bus with its LIVE storage. No credential, no network call
//                     to PocketTube, no paid plan, never stale.
//   cloud           — the user's PocketTube CLOUD BACKUP from p.yousub.info.
//                     Needs a Patreon/Paddle credential and a paid plan, and is
//                     up to a day stale.
// The live source is converted to the same flat storage-dump shape the cloud
// backup already has, so from the preview onwards both take one code path.
// The two sources are fully DETACHED: a live run that fails is reported as a
// live failure and never touches PocketTube's backup API, because the cloud
// backup is different (up to a day old) data and switching to it has to be the
// user's explicit choice. The result always names the source that was used.
//
// The earlier bridge content script was removed because it asked the PLAYLIST
// manager's `ypm_get_playlist_data`, which never carries subscription
// collections. `get_channel_data` — answered by the SUBSCRIPTION manager — does.

importScripts('pockettube-live.js');

// The build of THIS worker script, as loaded. Keep it in step with the
// manifest's version on every change, and never derive it from getManifest() —
// the gap between the two is the whole detection. Chrome's service-worker
// script cache has repeatedly kept an old background.js running while
// chrome.runtime.getManifest() already reported the new version, so the
// manifest alone cannot prove which worker code is live — only a constant that
// travels with the worker source can. On startup the worker compares the two
// and reloads itself once (see maybeHealStaleWorker); the popup shows both and
// shouts when they disagree.
const WORKER_BUILD = '2.4';

// A content script's sender origin is set by the browser and cannot be forged
// by the page, so it — not the page-supplied appOrigin — decides who may read
// the YouTube session cookies.
function senderOrigin(sender) {
  if (sender && sender.origin) return sender.origin;
  try {
    return new URL((sender && sender.url) || '').origin;
  } catch (error) {
    return '';
  }
}

// Returns true when it will answer asynchronously. Never returns false: an
// explicit false from any listener can close the shared message port before a
// sibling listener's async sendResponse lands.
function handleGetYoutubeCookies(message, sender, sendResponse) {
  (async () => {
    let configuredOrigin;
    let claimedOrigin;
    let origin;
    try {
      configuredOrigin = await getAppOrigin();
      claimedOrigin = validateAndNormaliseOrigin(message.appOrigin);
      origin = validateAndNormaliseOrigin(senderOrigin(sender));
    } catch (error) {
      sendResponse({ error: error?.message || String(error) });
      return;
    }
    if (origin !== configuredOrigin || claimedOrigin !== configuredOrigin) {
      sendResponse({
        error: `YouTube cookies are not served to ${origin || 'an unknown origin'}.`,
      });
      return;
    }

    chrome.cookies.getAll({ domain: '.youtube.com' }, (cookies) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }

      (async () => {
        const currentOrigin = await getAppOrigin();
        if (currentOrigin !== configuredOrigin ||
            origin !== currentOrigin || claimedOrigin !== currentOrigin) {
          sendResponse({
            error: `YouTube cookies are not served to ${origin || 'an unknown origin'}.`,
          });
          return;
        }

        // Convert Chrome cookie format to Playwright state format
        const playwrightCookies = cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expirationDate || -1,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite === 'no_restriction' ? 'None' :
                    c.sameSite === 'lax' ? 'Lax' :
                    c.sameSite === 'strict' ? 'Strict' : 'Lax',
        }));

        // Check if SAPISID is present
        const hasSapisid = playwrightCookies.some(
          (c) => c.name === 'SAPISID' || c.name === '__Secure-3PAPISID'
        );

        if (!hasSapisid) {
          sendResponse({ error: 'Not signed in to YouTube. Please sign in to youtube.com first.' });
          return;
        }

        sendResponse({ cookies: playwrightCookies });
      })().catch((error) => sendResponse({ error: error?.message || String(error) }));
    });
  })().catch((error) => sendResponse({ error: error?.message || String(error) }));

  return true; // Keep the message channel open for async response
}


// --- PocketTube cloud-backup sync --------------------------------------------
//
// Accepted, deliberately unfixed limitation: the action badge can go stale if
// the service worker is terminated mid-run — the popup always shows the
// authoritative result, recovered from storage.session if the port died.

const DEFAULT_APP_ORIGIN = 'http://127.0.0.1:8001';
const APP_BRIDGE_SCRIPT_ID = 'app-bridge';
const SYNC_MENU_ID = 'sync-pockettube-categories';
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
// Read cap for a network body, applied while streaming and before any parse.
// Twice the payload cap so a backup that is merely over the import limit still
// reaches the preview's "too big to import" warning instead of a read error.
const MAX_RESPONSE_BYTES = 2 * MAX_PAYLOAD_BYTES;
const MAX_IMPORT_RESPONSE_BYTES = 1024 * 1024;
const DRY_RUN_RESULT_KEY = 'lastDryRun';
const RUN_STATE_KEY = 'pocketTubeRunState';
const CREDENTIALS_KEY = 'pocketTubeCredentials';
// Records the manifest version a self-reload was already attempted for, so a
// worker that comes back still stale gives up instead of looping.
const STALE_RELOAD_KEY = 'staleWorkerReload';
const KEEPALIVE_INTERVAL_MS = 20000;
const PREPARED_TTL_MS = 5 * 60 * 1000;

// Which PocketTube data the import reads. Live is the default because it needs
// no credential and is never stale; cloud is the explicit alternative the user
// has to select. An unknown value is refused rather than guessed.
const IMPORT_SOURCES = new Set(['live', 'cloud']);
const DEFAULT_IMPORT_SOURCE = 'live';
const IMPORT_SOURCE_KEY = 'importSource';

// YSM only answers get_channel_data once it has seen
// window.parseSubscriptionListPageDone, which the subscription list page sets —
// so a tab opened just for this run is pointed straight at it.
const YOUTUBE_COLLECT_URL = 'https://www.youtube.com/feed/channels';
const TAB_LOAD_TIMEOUT_MS = 30000;
// Let PocketTube's own content script register its listener before asking.
const BRIDGE_SETTLE_MS = 1500;
const BRIDGE_SEND_ATTEMPTS = 4;
const BRIDGE_RETRY_MS = 800;

// Hardcoded on purpose and never configurable: the stored credential is a
// bearer secret, so exactly one host may ever receive it.
const BACKUP_API_ORIGIN = 'https://p.yousub.info';
const BACKUP_TIMEOUT_MS = 15000;
// Uploading a multi-megabyte backup to a local server is slower than an API
// call, but it must still not be able to hang the run forever.
const IMPORT_TIMEOUT_MS = 120000;
// Reading the app's current categories is a small, local GET.
const APP_QUERY_TIMEOUT_MS = 15000;
const MAX_CATEGORIES_RESPONSE_BYTES = 4 * 1024 * 1024;

// The backend defaults to 'replace', which DELETES every category and every
// assignment before rebuilding them. The mode is always sent explicitly so a
// change to that default cannot silently change what this extension does.
const IMPORT_MODES = new Set(['replace', 'additive']);
const DEFAULT_IMPORT_MODE = 'replace';

// PocketTube ships TWO extensions that share these endpoints and the same
// Patreon/Paddle credential; this form field is what partitions the backup
// sets. "playlists" belongs to the PlayList Manager (YPM) and returns its tiny
// playlist backups — the subscription categories only come back under
// "subscriptions", which is what YSM's own background.js sends. Do not
// "correct" this back to "playlists": that was the bug.
const BACKUP_VERSION = 'subscriptions';

// PocketTube: Youtube SUBSCRIPTION Manager (YSM) — the extension that owns the
// channel categories. The PlayList Manager is a different extension.
const POCKETTUBE_EXTENSION_ID = 'kdmnjgijlmjgmimahnillepgcgeemffb';
const POCKETTUBE_PLAYLIST_EXTENSION_ID = 'bplnofkhjdphoihfkfcddikgmecfehdd';
const POCKETTUBE_OPTIONS_URL =
  `chrome-extension://${POCKETTUBE_EXTENSION_ID}/pockettube-app/dist/index.html`;

const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
const MALFORMED_CATEGORY_ENTRY = 'https://www.youtube.com/';

// Mirrors POCKETTUBE_INTERNAL_KEYS in subscriptions/views.py: top-level keys
// that are not category → channel-id lists. Only the FALLBACK path below reads
// it; when PocketTube's own registry is present that decides instead.
// liveStreamsCurrent / nvl / nvlo are PocketTube caches that are plain
// top-level lists — without them here a registry-less dump would import three
// bogus categories.
const POCKETTUBE_INTERNAL_KEYS = new Set([
  'channelsHealth', 'topicCache',
  'ysc_channel_metadata', 'ysc_collection', 'ysc_deck', 'ysc_meta',
  'ysc_popup', 'ysc_settings', 'ysc_subs_count', 'ysc_title_id',
  'ysc_token_google',
  'liveStreamsCurrent', 'nvl', 'nvlo', 'lastWatchedId', 'api_counter',
  'backupExpired', 'channelsHealthExpired', 'topicCounter', 'topicExpired',
  'watchedCounter', 'watchedExpired',
]);

// PocketTube's own category registry: ysc_collection maps every category name
// to its display name, ysc_meta maps it to {img, position}. Their union is the
// authoritative category list, so a cache that merely happens to be a top-level
// list is never counted. Empty categories are in the registry too, so they
// survive. Mirrors the same rule in subscriptions/views.py.
function categoryRegistry(backup) {
  const registry = new Set();
  ['ysc_collection', 'ysc_meta'].forEach((key) => {
    const value = backup[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    Object.keys(value).forEach((name) => registry.add(name));
  });
  return registry;
}

// "Top_ysm_1" is the second chunk of the category "Top"; the registry only ever
// names the base.
function categoryBaseName(key) {
  const match = /^(.+?)_ysm_\d+$/.exec(key);
  return match ? match[1] : key;
}

// Deliberately says nothing about a list's CONTENTS: real categories hold a few
// malformed entries and would otherwise be dropped whole.
function isCategoryKey(key, value, registry) {
  if (!Array.isArray(value)) return false;
  if (registry.size) return registry.has(categoryBaseName(key));
  return !key.startsWith('ysc_') && !POCKETTUBE_INTERNAL_KEYS.has(key);
}

// A cloud backup is a whole chrome.storage dump: PocketTube's own backup writer
// strips ysc_settings.patreon / ysc_settings.yu but leaves the TOP-LEVEL
// credential keys and the Google OAuth token in place. The app needs none of
// them, so they never leave this worker.
const SEND_DENY_KEYS = new Set(['patreon', 'yu', 'ysc_token_google']);

// YSM keeps its credential inside ysc_settings — `patreon` is a JSON STRING
// holding access_token, `yu` is an object with email and tokens[].
const CREDENTIALS_EXTRACTION_SNIPPET =
  'chrome.storage.local.get(\'ysc_settings\').then(d => { ' +
  'const p = d.ysc_settings?.patreon; ' +
  'console.log(p ? JSON.parse(p).access_token : d.ysc_settings?.yu); });';

// What every credential error says. The full extraction procedure is numbered
// in the popup's settings view and repeated in the console below, so it does
// not have to travel inside each message.
const CREDENTIALS_HELP = 'Add them in Settings.';

function logCredentialsHelp() {
  console.info(
    '[PocketTube sync] To extract PocketTube credentials: open the options page ' +
    `of "PocketTube: Youtube Subscription Manager" (${POCKETTUBE_EXTENSION_ID}, ` +
    `${POCKETTUBE_OPTIONS_URL}), open DevTools on it, and run: ` +
    `${CREDENTIALS_EXTRACTION_SNIPPET} Paste the logged access_token (Patreon) ` +
    'or the logged email plus its tokens (Paddle) into the extension\u2019s ' +
    'settings view. It must be the SUBSCRIPTION Manager: "PocketTube: Youtube ' +
    `PlayList Manager" (${POCKETTUBE_PLAYLIST_EXTENSION_ID}) is a different ` +
    'extension whose credential lists only playlist backups, which import as ' +
    'nothing.'
  );
}

// Two network round-trips can outlast the service worker's ~30s idle timer.
// Touching any extension API resets it, so poll one while a run is in flight.
let keepaliveTimer = null;
let keepaliveHolders = 0;
// Set when a stale-worker reload was postponed because a run was in flight.
let staleReloadDeferred = false;

function startKeepalive() {
  keepaliveHolders += 1;
  if (keepaliveTimer !== null) return;
  keepaliveTimer = setInterval(() => {
    try {
      const info = chrome.runtime.getPlatformInfo();
      if (info && typeof info.catch === 'function') info.catch(() => {});
    } catch (error) {
      // Nothing to do — the next tick will try again.
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function stopKeepalive() {
  keepaliveHolders = Math.max(0, keepaliveHolders - 1);
  if (keepaliveHolders === 0 && staleReloadDeferred) {
    staleReloadDeferred = false;
    maybeHealStaleWorker().catch(() => {});
  }
  if (keepaliveHolders > 0 || keepaliveTimer === null) return;
  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

async function withKeepalive(run) {
  startKeepalive();
  try {
    return await run();
  } finally {
    stopKeepalive();
  }
}

// storage.session survives service-worker restarts (but not browser restarts)
// and never touches disk, so it is the right home for a result the popup may
// have to recover. Older Chrome builds lack it — fall back to local storage,
// which onStartup clears.
function runStateStore() {
  return chrome.storage.session || chrome.storage.local;
}

async function writeRunState(state) {
  try {
    await runStateStore().set({ [RUN_STATE_KEY]: { ...state, at: Date.now() } });
  } catch (error) {
    console.warn('[PocketTube sync] could not persist the run state:', error?.message || error);
  }
}

// The preview downloads the backup; the confirmation POSTs THAT backup.
// Nothing is ever downloaded a second time, so the numbers the user approved
// are the numbers that ship. In-memory only: if the worker restarts the token
// is gone and the user has to preview again, which is the safe way to fail.
const preparedImports = new Map();

// Zero means no preview has been prepared by THIS worker instance, which is how
// an unknown confirm token is told apart from an expired/spent one.
let preparedIssued = 0;

// Redaction for anything written to the service-worker console. A backup
// carries the PocketTube subscription credential, a Google OAuth token and the
// user's email; troubleshooting must never ask for those in an issue report.
// `accessToken` and `tokens` both match /token/i; `email`, `patreon` and `yu`
// are listed explicitly.
const REDACT_KEY_RE = /token|secret|auth|credential|password|session/i;
const REDACT_EXACT_KEYS = new Set([
  'file_id', 'fileId', 'uid', 'userId', 'user_id', 'email', 'patreon', 'yu',
]);
const REDACTED = '[redacted]';

function redactForLog(value, depth) {
  const level = depth || 0;
  if (level > 8) return '[depth limit]';
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((entry) => redactForLog(entry, level + 1));
  }
  if (!value || typeof value !== 'object') return value;
  const out = {};
  Object.keys(value).slice(0, 500).forEach((key) => {
    if (REDACT_KEY_RE.test(key) || REDACT_EXACT_KEYS.has(key)) {
      out[key] = REDACTED;
      return;
    }
    out[key] = redactForLog(value[key], level + 1);
  });
  return out;
}

const LOG_CONTENTS_NOTE =
  'The log redacts your PocketTube credential, OAuth tokens, Drive file ids, ' +
  'user ids, emails and any token/secret/auth/credential key. It still ' +
  'contains your category names, so share it only if you are comfortable ' +
  'with that.';

// Chrome's console "Copy" turns a logged object into "[object Object]", which
// makes a logged object useless when pasted into a bug report — log TEXT.
const MAX_LOG_JSON_CHARS = 200 * 1024;

function stringifyForLog(value) {
  let json;
  try {
    json = JSON.stringify(value, null, 2);
  } catch (error) {
    return `[could not stringify: ${error?.message || error}]`;
  }
  if (json === undefined) return String(value);
  if (json.length <= MAX_LOG_JSON_CHARS) return json;
  return `${json.slice(0, MAX_LOG_JSON_CHARS)}\n… truncated after ` +
    `${MAX_LOG_JSON_CHARS} of ${json.length} characters`;
}

// One-line shape sketch: type plus length/keys. A whole backup is far too big
// to dump, so the log gets this summary of it instead.
function sketchValue(value, depth) {
  const level = depth || 0;
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const inner = value.length && level < 2 ? ` of ${sketchValue(value[0], level + 1)}` : '';
    return `array(${value.length})${inner}`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    const shown = keys.slice(0, 12).join(', ');
    const more = keys.length > 12 ? `, …+${keys.length - 12} more` : '';
    return `object(${keys.length}){${shown}${more}}`;
  }
  if (typeof value === 'string') return `string(${value.length})`;
  return typeof value;
}

function structureSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `(root) ${sketchValue(value, 0)}`;
  }
  const keys = Object.keys(value);
  const lines = keys.slice(0, 60).map((key) => `  ${key}: ${sketchValue(value[key], 0)}`);
  if (keys.length > 60) lines.push(`  …+${keys.length - 60} more keys`);
  return lines.join('\n');
}

function logRedacted(level, label, value) {
  const write = console[level] || console.log;
  write(`[PocketTube sync] ${label} — structure summary:\n` +
    structureSummary(redactForLog(value)));
}

function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
}

// URL parsing lowercases the scheme and host and drops any path, so the
// anchored patterns below stay strict while "HTTP://LOCALHOST:8001" is accepted.
function validateAndNormaliseOrigin(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) throw new Error('App origin is empty.');
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      throw new Error('App origin must not contain credentials.');
    }
    if (parsed.origin === 'null' || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('App origin must use HTTP or HTTPS.');
    }
    if (parsed.hostname.includes('*')) {
      throw new Error('App origin hostname must not contain wildcards.');
    }
    if (parsed.hostname.startsWith('[') || parsed.hostname.includes(':')) {
      throw new Error('IPv6 app origins are not supported.');
    }
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol === 'http:' && !loopback) {
      throw new Error('Remote app origins must use HTTPS.');
    }
    return parsed.origin;
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`App origin "${trimmed}" is malformed.`);
    throw error;
  }
}

function originMatchPattern(origin) {
  const parsed = new URL(origin);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

function isRequiredAppOrigin(origin) {
  const parsed = new URL(origin);
  return parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
}

async function hasOriginAccess(origin) {
  return chrome.permissions.contains({ origins: [originMatchPattern(origin)] });
}

async function removeOriginAccess(origin, context) {
  const pattern = originMatchPattern(origin);
  try {
    const removed = await chrome.permissions.remove({ origins: [pattern] });
    if (!removed) throw new Error('Chrome reported that no permission was removed.');
    return '';
  } catch (error) {
    console.warn(`[App bridge] ${context} failed:`, error);
    return ` Previous access to ${pattern} could not be removed.`;
  }
}

let appBridgeRegistrationQueue = Promise.resolve();
let appOriginConfigurationQueue = Promise.resolve();

function ensureAppBridgeRegistration(origin = DEFAULT_APP_ORIGIN) {
  const register = async () => {
    if (!(await hasOriginAccess(origin))) {
      throw new Error(`Chrome access to ${origin} is not granted.`);
    }
    const matches = [originMatchPattern(origin)];
    const registration = {
      id: APP_BRIDGE_SCRIPT_ID,
      matches,
      js: ['content.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    };
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [APP_BRIDGE_SCRIPT_ID],
    });
    if (existing.length) {
      await chrome.scripting.updateContentScripts([registration]);
    } else {
      await chrome.scripting.registerContentScripts([registration]);
    }
  };
  const result = appBridgeRegistrationQueue.then(register, register);
  appBridgeRegistrationQueue = result.catch(() => {});
  return result;
}

function configureAppOrigin(value) {
  const configure = async () => {
    const origin = validateAndNormaliseOrigin(value);
    if (!(await hasOriginAccess(origin))) {
      throw new Error(`Chrome access to ${origin} was not granted.`);
    }

    const stored = await chrome.storage.local.get('appOrigin');
    const previous = validateAndNormaliseOrigin(stored.appOrigin || DEFAULT_APP_ORIGIN);
    const previousPattern = originMatchPattern(previous);
    const nextPattern = originMatchPattern(origin);
    try {
      await ensureAppBridgeRegistration(origin);
    } catch (error) {
      try {
        await ensureAppBridgeRegistration(previous);
      } catch (rollbackError) {
        console.error('[App bridge] could not restore the previous registration:', rollbackError);
      }
      throw error;
    }
    try {
      await chrome.storage.local.set({ appOrigin: origin });
    } catch (error) {
      try {
        await ensureAppBridgeRegistration(previous);
      } catch (rollbackError) {
        console.error('[App bridge] could not restore the previous registration:', rollbackError);
      }
      throw error;
    }

    let cleanupWarning = '';
    if (previousPattern !== nextPattern && !isRequiredAppOrigin(previous)) {
      cleanupWarning = await removeOriginAccess(previous, 'obsolete permission cleanup');
    }
    return { origin, cleanupWarning };
  };
  const result = appOriginConfigurationQueue.then(configure, configure);
  appOriginConfigurationQueue = result.catch(() => {});
  return result;
}

async function getAppOrigin() {
  const stored = await chrome.storage.local.get('appOrigin');
  const origin = validateAndNormaliseOrigin(stored.appOrigin || DEFAULT_APP_ORIGIN);
  if (!(await hasOriginAccess(origin))) {
    throw new Error(`Chrome access to ${origin} is not granted.`);
  }
  return origin;
}

function credentialsError(detail) {
  logCredentialsHelp();
  return new Error(`${detail} ${CREDENTIALS_HELP}`);
}

// Accepts either plan's credential shape. Nothing read here is ever logged.
async function getPocketTubeCredentials() {
  const stored = await chrome.storage.local.get(CREDENTIALS_KEY);
  const creds = stored[CREDENTIALS_KEY];
  if (!creds || typeof creds !== 'object') {
    throw credentialsError('No PocketTube credentials saved.');
  }

  if (creds.mode === 'patreon') {
    const accessToken = String(creds.accessToken || '').trim();
    if (!accessToken) throw credentialsError('The stored Patreon access token is empty.');
    return { mode: 'patreon', accessToken };
  }

  if (creds.mode === 'paddle') {
    const email = String(creds.email || '').trim();
    const tokens = Array.isArray(creds.tokens)
      ? creds.tokens.map((token) => String(token || '').trim()).filter(Boolean)
      : [];
    if (!email || !tokens.length) {
      throw credentialsError('The stored Paddle credentials are incomplete.');
    }
    return { mode: 'paddle', email, tokens };
  }

  throw credentialsError('The stored PocketTube credentials have no usable mode.');
}

// Exactly YSM's own prepareFormData(): same fields, same order, with
// BACKUP_VERSION selecting the subscription backup set.
function buildCredentialForm(credentials) {
  const form = new FormData();
  form.append('version', BACKUP_VERSION);
  if (credentials.mode === 'patreon') {
    form.append('type', 'patreon');
    form.append('access_token', credentials.accessToken);
  } else {
    form.append('type', 'paddle');
    form.append('email', credentials.email);
    credentials.tokens.forEach((token) => form.append('t[]', token));
  }
  return form;
}

// Reads a response body with a hard byte cap enforced DURING the download, so
// an oversized (or endless) body is never fully buffered nor handed to
// JSON.parse. Content-Length is only a shortcut — the streamed count is what
// actually stops the read.
async function readCappedText(response, limit, label) {
  const tooBig = () => new Error(
    `${label} returned more than ${(limit / 1048576).toFixed(0)} MB.`
  );

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw tooBig();

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    if (text.length > limit) throw tooBig();
    return text;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

async function callBackupApi(path, credentials, extraFields) {
  const form = buildCredentialForm(credentials);
  Object.keys(extraFields || {}).forEach((key) => form.append(key, extraFields[key]));

  const controller = new AbortController();
  // The timer stays armed until the body has been read: a server that sends
  // headers and then stalls would otherwise hang the run forever.
  const timer = setTimeout(() => controller.abort(), BACKUP_TIMEOUT_MS);
  const timedOut = () => new Error(
    `PocketTube did not answer ${path} within ${BACKUP_TIMEOUT_MS / 1000}s.`
  );

  try {
    let response;
    try {
      response = await fetch(`${BACKUP_API_ORIGIN}${path}`, {
        method: 'POST',
        mode: 'cors',
        redirect: 'error',
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw timedOut();
      throw new Error(
        `Could not reach PocketTube (${error?.message || 'network error'}).`
      );
    }

    if (response.status === 401 || response.status === 403) {
      logCredentialsHelp();
      throw new Error(
        `PocketTube rejected the stored credentials (HTTP ${response.status}).`
      );
    }
    if (response.status === 402) {
      throw new Error('PocketTube answered HTTP 402 — a paid plan is needed.');
    }
    if (response.status === 404) {
      throw new Error(`PocketTube has no ${path} endpoint (HTTP 404).`);
    }
    if (!response.ok) {
      throw new Error(`PocketTube returned HTTP ${response.status} for ${path}.`);
    }

    let text;
    try {
      text = await readCappedText(
        response, MAX_RESPONSE_BYTES, `PocketTube (${path})`
      );
    } catch (error) {
      if (error?.name === 'AbortError') throw timedOut();
      throw error;
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(
        `PocketTube sent a non-JSON body for ${path} — a paid plan is needed.`
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

// Backup ids are unix timestamps; newest first.
function backupIdsFrom(listResponse) {
  const keys = Array.isArray(listResponse?.keys) ? listResponse.keys : null;
  if (!keys || !keys.length) {
    throw new Error('No PocketTube cloud backups on this account.');
  }
  const numeric = keys.map((key) => Number(key)).filter((key) => Number.isFinite(key));
  if (!numeric.length) {
    throw new Error('PocketTube returned no usable backup ids.');
  }
  return numeric.sort((a, b) => b - a);
}

// The default when the user has not picked a specific backup.
function pickNewestBackupId(listResponse) {
  return backupIdsFrom(listResponse)[0];
}

// Seconds or milliseconds — both appear in the wild.
function backupIdToMillis(id) {
  const value = Number(id);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

function formatBackupTime(id) {
  const millis = backupIdToMillis(id);
  if (millis === null) return 'unknown';
  try {
    return new Date(millis).toLocaleString();
  } catch (error) {
    return new Date(millis).toISOString();
  }
}

// Deliberately light: the backend already imports this exact format, so the
// only job here is to refuse something that plainly is not a storage dump.
function assertUsableBackup(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    throw new Error('The backup is not a PocketTube storage dump.');
  }
  const keys = Object.keys(backup);
  const hasYscKey = keys.some((key) => key.startsWith('ysc_'));
  // PocketTube's own caches are skipped: liveStreamsCurrent holds channel ids
  // while something is live, so it alone must not make a junk payload look like
  // a dump. A real category is never a denylisted key, so nothing legitimate
  // stops counting here.
  const hasChannelList = keys.some((key) => {
    if (POCKETTUBE_INTERNAL_KEYS.has(key)) return false;
    const value = backup[key];
    return Array.isArray(value) && value.some(
      (entry) => typeof entry === 'string' && CHANNEL_ID_RE.test(entry)
    );
  });
  if (!hasYscKey && !hasChannelList) {
    throw new Error(
      'The backup has no PocketTube settings keys and no channel lists.'
    );
  }
}

// Same key-merging rules as the backend's import_categories, so the previewed
// counts match what the import will actually see.
function summariseBackup(backup, backupId) {
  const categoryAssignments = new Map();
  const channels = new Set();
  const registry = categoryRegistry(backup);

  Object.keys(backup).forEach((key) => {
    const value = backup[key];
    if (!isCategoryKey(key, value, registry)) return;
    const base = categoryBaseName(key);
    let count = categoryAssignments.get(base) || 0;
    value.forEach((entry) => {
      if (typeof entry !== 'string' || !entry) return;
      channels.add(entry);
      count += 1;
    });
    categoryAssignments.set(base, count);
  });

  const names = Array.from(categoryAssignments.keys());
  let assignments = 0;
  categoryAssignments.forEach((count) => { assignments += count; });

  // The backend creates subscriptions from ysc_channel_metadata only, then
  // assigns by channel id — a channel listed in a category but missing from the
  // metadata is counted as unmatched, once per assignment.
  const metadata = backup.ysc_channel_metadata;
  const known = metadata && typeof metadata === 'object' ? metadata : {};
  const unmatchedChannels = new Set();
  channels.forEach((channelId) => {
    if (!Object.prototype.hasOwnProperty.call(known, channelId)) {
      unmatchedChannels.add(channelId);
    }
  });
  let unmatchedAssignments = 0;
  Object.keys(backup).forEach((key) => {
    const value = backup[key];
    if (!isCategoryKey(key, value, registry)) return;
    value.forEach((entry) => {
      if (typeof entry === 'string' && unmatchedChannels.has(entry)) unmatchedAssignments += 1;
    });
  });

  return {
    categories: names.length,
    channels: channels.size,
    assignments,
    categoryNames: names,
    sampleCategories: names.slice(0, 6),
    backupId,
    backupAt: formatBackupTime(backupId),
    knownChannels: Object.keys(known).length,
    unmatchedChannels: unmatchedChannels.size,
    unmatchedAssignments,
  };
}

const DYNAMIC_KEY_MAP_PATHS = new Set([
  'ysc_collection', 'ysc_meta', 'ysc_title_id', 'ysc_channel_metadata',
  'channelsHealth', 'topicCache', 'ysc_subs_count',
]);

// PocketTube maps use category names or channel IDs as data keys, including
// every level of the sub_groups category tree.
function hasDynamicKeys(segments) {
  return (segments.length === 1 && DYNAMIC_KEY_MAP_PATHS.has(segments[0])) ||
    (segments.length >= 2 &&
      segments[0] === 'ysc_settings' && segments[1] === 'sub_groups');
}

function defineOwnDataProperty(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

// Return a transport-safe copy and record omitted paths without exposing values.
function sanitizeForTransport(value, segments, withheld) {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      sanitizeForTransport(entry, [...segments, `${index}`], withheld));
  }
  if (!value || typeof value !== 'object') return value;
  const cleaned = {};
  Object.keys(value).forEach((key) => {
    const childSegments = [...segments, key];
    const denied = SEND_DENY_KEYS.has(key) ||
      (!hasDynamicKeys(segments) && (REDACT_KEY_RE.test(key) || REDACT_EXACT_KEYS.has(key)));
    if (denied) {
      withheld.push(childSegments.join('.'));
      return;
    }
    defineOwnDataProperty(
      cleaned, key, sanitizeForTransport(value[key], childSegments, withheld));
  });
  return cleaned;
}

function buildShippableBackup(backup) {
  const shipped = {};
  const withheld = [];
  const registry = categoryRegistry(backup);

  Object.keys(backup).forEach((key) => {
    const value = backup[key];
    const isCategory = isCategoryKey(key, value, registry);
    const retainedValue = isCategory
      ? value.filter((entry) => entry !== MALFORMED_CATEGORY_ENTRY)
      : value;
    const denied = SEND_DENY_KEYS.has(key) ||
      (!isCategory && (REDACT_KEY_RE.test(key) || REDACT_EXACT_KEYS.has(key)));
    if (denied) {
      withheld.push(key);
      return;
    }
    defineOwnDataProperty(
      shipped, key, sanitizeForTransport(retainedValue, [key], withheld));
  });

  return { shipped, withheld };
}

// An absent mode means the popup never chose one; an unrecognised one is a bug
// or a stale popup, and guessing between "delete everything" and "create only"
// is exactly the guess that must not be made silently.
function normaliseImportMode(value) {
  if (value === undefined || value === null || `${value}`.trim() === '') {
    return DEFAULT_IMPORT_MODE;
  }
  const mode = `${value}`.trim().toLowerCase();
  if (!IMPORT_MODES.has(mode)) {
    throw new Error(
      `Unknown import mode "${value}" — expected "replace" or "additive".`
    );
  }
  return mode;
}

function flattenCategoryNames(categories, out) {
  const names = out || [];
  if (!Array.isArray(categories)) return names;
  categories.forEach((category) => {
    if (!category || typeof category !== 'object') return;
    if (typeof category.name === 'string') names.push(category.name);
    flattenCategoryNames(category.children, names);
  });
  return names;
}

// Reads what the app holds today so the confirmation can say how much of it a
// replace import will delete. Same allow-listed origin, same timeout and the
// same capped read as every other request; the PocketTube credential is not
// involved and never reaches the app.
async function fetchAppCategories(origin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APP_QUERY_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(`${origin}/api/categories/`, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(
          `the app at ${origin} did not answer within ` +
          `${APP_QUERY_TIMEOUT_MS / 1000}s`
        );
      }
      throw new Error(
        `could not reach the app at ${origin} (${error?.message || 'network error'})`
      );
    }
    if (!response.ok) {
      throw new Error(`the app at ${origin} answered HTTP ${response.status}`);
    }

    let text;
    try {
      text = await readCappedText(
        response, MAX_CATEGORIES_RESPONSE_BYTES, `The app at ${origin}`
      );
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`the app at ${origin} stalled while sending its categories`);
      }
      throw new Error(error?.message || String(error));
    }

    try {
      return flattenCategoryNames(JSON.parse(text).categories);
    } catch (error) {
      throw new Error(`the app at ${origin} returned an unreadable category list`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// What a replace import would do to the categories the app holds right now.
// Never throws: a failure here must not block a preview, it only means the
// confirmation has to admit the removal count is unknown.
async function compareWithApp(origin, backupCategoryNames) {
  const incoming = new Set(backupCategoryNames);
  let existingNames;
  try {
    existingNames = await fetchAppCategories(origin);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }

  const unique = Array.from(new Set(existingNames));
  const removed = unique.filter((name) => !incoming.has(name));
  const kept = unique.length - removed.length;
  return {
    ok: true,
    categories: unique.length,
    removed: removed.length,
    removedSample: removed.slice(0, 6),
    kept,
    added: backupCategoryNames.filter((name) => !unique.includes(name)).length,
  };
}

async function postImport(origin, json, mode) {
  const blob = new Blob([json], { type: 'application/json' });
  const form = new FormData();
  form.append('file', blob, 'pockettube_backup.json');
  form.append('mode', mode);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);
  const timedOut = () => new Error(
    `The app at ${origin} did not finish the import within ` +
    `${IMPORT_TIMEOUT_MS / 1000}s — check the app.`
  );

  try {
    let response;
    try {
      response = await fetch(`${origin}/api/categories/import/`, {
        method: 'POST',
        redirect: 'error',
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw timedOut();
      throw new Error(
        `Could not reach the app at ${origin} (${error?.message || 'network error'}).`
      );
    }

    let text;
    try {
      text = await readCappedText(
        response, MAX_IMPORT_RESPONSE_BYTES, `The app at ${origin}`
      );
    } catch (error) {
      if (error?.name === 'AbortError') throw timedOut();
      throw error;
    }

    let data = null;
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = null;
    }

    if (!response.ok) {
      const detail = data?.error || data?.detail || text.slice(0, 300) || '(no body)';
      throw new Error(`Import failed — the app returned ${response.status}: ${detail}`);
    }
    return data || {};
  } finally {
    clearTimeout(timer);
  }
}

function newPreparedToken() {
  return (self.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function prunePrepared() {
  const now = Date.now();
  preparedImports.forEach((entry, token) => {
    if (now - entry.at > PREPARED_TTL_MS) preparedImports.delete(token);
  });
}

// --- live source: PocketTube's page message bus on youtube.com ---------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveImportSource(requested) {
  if (requested !== undefined && requested !== null && `${requested}`.trim() !== '') {
    const value = `${requested}`.trim().toLowerCase();
    if (!IMPORT_SOURCES.has(value)) {
      throw new Error(
        `Unknown import source "${requested}" — expected "live" or "cloud".`
      );
    }
    return value;
  }
  const stored = await chrome.storage.local.get(IMPORT_SOURCE_KEY);
  const value = `${stored[IMPORT_SOURCE_KEY] || ''}`.trim().toLowerCase();
  return IMPORT_SOURCES.has(value) ? value : DEFAULT_IMPORT_SOURCE;
}

function waitForTabComplete(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const settleOnce = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      return true;
    };

    const timer = setTimeout(() => {
      if (settleOnce()) reject(new Error('Timed out waiting for the youtube.com tab to load.'));
    }, timeoutMs);

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      if (settleOnce()) resolve();
    };

    // Without this the run would sit out the whole timeout after the user (or
    // anything else) closed the tab from under it.
    const onRemoved = (removedTabId) => {
      if (removedTabId !== tabId) return;
      if (settleOnce()) {
        reject(new Error('The youtube.com tab was closed before it finished loading.'));
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    // The tab may already be loaded — don't sit out the whole timeout for it.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === 'complete' && settleOnce()) resolve();
    }).catch(() => {
      if (settleOnce()) reject(new Error('The youtube.com tab was closed.'));
    });
  });
}

function unreachableTabError(detail) {
  const error = new Error(
    `Could not reach the YouTube tab (${detail}). Reload youtube.com and retry.`
  );
  error.ptUnreachable = true;
  return error;
}

async function sendCollectMessage(tabId) {
  let lastError = null;
  for (let attempt = 0; attempt < BRIDGE_SEND_ATTEMPTS; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'PT_COLLECT_CHANNEL_DATA' });
    } catch (error) {
      lastError = error;
      await delay(BRIDGE_RETRY_MS);
    }
  }
  throw unreachableTabError(lastError?.message || 'unknown error');
}

async function collectFromTab(tabId) {
  const response = await sendCollectMessage(tabId);
  if (!response) throw unreachableTabError('the tab returned an empty response');
  if (!response.ok) {
    // The bridge's console.warn would land in the PAGE console, and a tab this
    // run opened is destroyed straight after — so this is the only place the
    // evidence survives.
    if (response.ignored?.length) {
      console.warn('[PocketTube sync] page messages the bridge ignored:\n' +
        stringifyForLog(redactForLog(response.ignored)));
    }
    throw new Error(response.error || 'PocketTube did not answer get_channel_data.');
  }
  return response.raw;
}

// Opens youtube.com in the background, reads, and always closes it again — on
// every error path, and without fighting an onRemoved that beat us to it.
async function collectInFreshTab() {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: YOUTUBE_COLLECT_URL, active: false });
  } catch (error) {
    const failed = new Error(
      'No youtube.com tab could be reached and Chrome refused to open one ' +
      `(${error?.message || error}).`
    );
    failed.ptUnreachable = true;
    throw failed;
  }
  const tabId = tab?.id;
  if (tabId == null) {
    throw new Error('Chrome did not return an id for the new youtube.com tab.');
  }

  let closedByBrowser = false;
  const onRemoved = (removedTabId) => {
    if (removedTabId === tabId) closedByBrowser = true;
  };
  chrome.tabs.onRemoved.addListener(onRemoved);

  try {
    await waitForTabComplete(tabId);
    await delay(BRIDGE_SETTLE_MS);
    return await collectFromTab(tabId);
  } finally {
    chrome.tabs.onRemoved.removeListener(onRemoved);
    if (!closedByBrowser) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (error) {
        // Already gone — nothing to clean up.
      }
    }
  }
}

// Reuses an open youtube.com tab when there is one; a tab that predates this
// version has no bridge script, which is the one case worth retrying in a
// fresh tab rather than reporting.
async function collectLiveReply() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://*.youtube.com/*' });
  } catch (error) {
    tabs = [];
  }
  const existing = (tabs || []).find((tab) => tab && tab.id != null);

  if (existing) {
    try {
      return await collectFromTab(existing.id);
    } catch (error) {
      if (!error?.ptUnreachable) throw error;
      console.warn(
        '[PocketTube sync] the open youtube.com tab has no bridge script; ' +
        'opening a fresh background tab instead.', error.message
      );
    }
  }
  return collectInFreshTab();
}

// Returns the live reply already converted to the flat storage-dump shape the
// cloud backup has, so everything downstream is source-agnostic.
async function buildLiveBackup() {
  const raw = await collectLiveReply();
  const built = self.buildLivePayload(raw);
  if (!built.stats.assignments) {
    throw new Error(
      'PocketTube\u2019s live data has no channel assignments. Open ' +
      'youtube.com/feed/channels, then retry.'
    );
  }
  return { backup: built.payload, warnings: built.warnings, liveStats: built.stats };
}

// Downloads one cloud backup (the newest unless the popup asked for a specific
// id) and returns it plus the id list the picker renders.
async function downloadCloudBackup(requestedBackupId) {
  const credentials = await getPocketTubeCredentials();

  const list = await callBackupApi('/backup/list', credentials);
  const ids = backupIdsFrom(list);
  const wanted = Number(requestedBackupId);
  const hasChoice = requestedBackupId !== undefined && requestedBackupId !== null &&
    `${requestedBackupId}` !== '';
  // A chosen id must still be in the list: an id from an older listing may have
  // been rotated away, and downloading a guess is worse than saying so.
  if (hasChoice && (!Number.isFinite(wanted) || !ids.includes(wanted))) {
    throw new Error(
      `PocketTube no longer lists backup ${requestedBackupId}. Preview again.`
    );
  }
  const backupId = hasChoice ? wanted : pickNewestBackupId(list);
  const backups = ids.map((id) => ({ id, at: formatBackupTime(id) }));
  const downloaded = await callBackupApi('/backup/download', credentials, {
    id: `${backupId}`,
  });

  const raw = typeof downloaded?.data === 'string' ? downloaded.data : null;
  if (!raw) {
    throw new Error('PocketTube\'s backup download returned no data.');
  }

  let backup;
  try {
    backup = JSON.parse(raw);
  } catch (error) {
    throw new Error('The downloaded backup is not valid JSON.');
  }
  return { backup, backupId, backups, warnings: [] };
}

// The single preview path both sources feed: filter, measure, compare against
// the app, and cache the exact JSON string that a confirmation would POST.
// Nothing here is ever downloaded or collected a second time.
async function finishPreview(options) {
  const { origin, source, backup, backupId, backups } = options;
  assertUsableBackup(backup);

  // Everything below measures, summarises and caches the FILTERED copy, so the
  // bytes the user approves are byte-for-byte the bytes that get POSTed.
  const { shipped, withheld } = buildShippableBackup(backup);
  const json = JSON.stringify(shipped);

  const bytes = new Blob([json]).size;
  // The full name list drives the comparison below but never travels with the
  // preview: the popup only needs counts and a short sample.
  const { categoryNames, ...stats } = summariseBackup(shipped, backupId);
  stats.bytes = bytes;
  stats.withheld = withheld;
  stats.source = source;

  const existing = await compareWithApp(origin, categoryNames);

  const warnings = (options.extraWarnings || []).slice();
  // Only a cloud backup can be stale — the live source is read at this instant.
  if (source === 'cloud') {
    const backupMillis = backupIdToMillis(backupId);
    const ageDays = backupMillis === null
      ? 0
      : Math.floor((Date.now() - backupMillis) / 86400000);
    if (ageDays >= 7) {
      warnings.push(`Backup is ${ageDays} days old (${stats.backupAt}).`);
    }
  }
  if (!stats.categories) {
    warnings.push('No category lists — nothing to import.');
  } else if (!stats.assignments) {
    warnings.push(
      `${stats.categories} categor${stats.categories === 1 ? 'y' : 'ies'}, ` +
      '0 assignments — nothing to import; try another backup.'
    );
  }
  if (bytes > MAX_PAYLOAD_BYTES) {
    warnings.push(
      `Payload is ${(bytes / 1048576).toFixed(1)} MB, over the ` +
      `${MAX_PAYLOAD_BYTES / 1048576} MB limit.`
    );
  }
  if (warnings.length) {
    console.warn(`[PocketTube sync] warnings:\n${stringifyForLog(warnings)}`);
  }

  logRedacted('log', `payload prepared for the app (${source} source)`, shipped);
  console.log(`[PocketTube sync] ${LOG_CONTENTS_NOTE}`);

  prunePrepared();
  const token = newPreparedToken();
  // A backup with no assignments imports nothing, which is exactly the useless
  // import this preview exists to stop.
  const committable = stats.categories > 0 && stats.assignments > 0 &&
    bytes <= MAX_PAYLOAD_BYTES;
  preparedIssued += 1;
  preparedImports.set(token, {
    at: Date.now(),
    origin,
    json,
    bytes,
    stats,
    warnings,
    committable,
    existing,
    source,
  });

  return {
    dryRun: true,
    stats,
    warnings,
    origin,
    token,
    committable,
    backups: backups || [],
    existing,
    source,
  };
}

// A live failure stays a live failure. The cloud backup holds DIFFERENT, up to
// a day old data, so reaching for it silently would turn the user's explicit
// choice into another one behind their back. The `ptLiveFailure` flag travels
// to the popup, which offers switching to cloud as a button the user must press.
function liveFailureError(error) {
  const detail = `${error?.message || error}`.trim();
  const failed = new Error(`Live read failed; cloud backup not used. ${detail}`);
  failed.ptLiveFailure = true;
  return failed;
}

// Always a preview: it reads ONE source, caches the exact JSON string it would
// later POST, and never POSTs anything itself. A live run never touches
// PocketTube's backup API — not even when it fails.
async function previewFromPocketTube(requestedBackupId, requestedSource) {
  const origin = await getAppOrigin();
  const source = await resolveImportSource(requestedSource);

  if (source === 'live') {
    let live;
    try {
      live = await buildLiveBackup();
    } catch (error) {
      throw liveFailureError(error);
    }
    return finishPreview({
      origin,
      source: 'live',
      backup: live.backup,
      // Live data has no backup id; the collection time is what "taken" means.
      backupId: Date.now(),
      backups: [],
      extraWarnings: live.warnings,
    });
  }

  const cloud = await downloadCloudBackup(requestedBackupId);
  return finishPreview({
    origin,
    source: 'cloud',
    backup: cloud.backup,
    backupId: cloud.backupId,
    backups: cloud.backups,
    extraWarnings: [],
  });
}

// Sends the EXACT backup the user was shown. One-shot: the token is consumed
// before anything is posted, so a failed import cannot be silently retried
// against numbers that were never re-approved.
async function commitPreparedImport(token, requestedMode) {
  // A commit that arrives without a token must fail: falling through to a fresh
  // preview would report "Import complete. 0 categories" for an import that
  // never happened.
  if (!token) {
    throw new Error('No preview token was sent. Nothing was imported.');
  }

  const mode = normaliseImportMode(requestedMode);

  prunePrepared();
  const entry = token ? preparedImports.get(token) : null;
  if (entry) preparedImports.delete(token);
  if (!entry) {
    if (preparedIssued === 0) {
      throw new Error('The worker restarted after the preview. Preview again.');
    }
    throw new Error('That preview is no longer available. Preview again.');
  }
  if (!entry.committable) {
    throw new Error('This preview cannot be imported — see its warnings.');
  }

  const origin = await getAppOrigin();
  if (origin !== entry.origin) {
    throw new Error(
      `The app origin changed from ${entry.origin} to ${origin}. Nothing was sent.`
    );
  }

  const result = await postImport(origin, entry.json, mode);
  return {
    dryRun: false,
    mode,
    stats: entry.stats,
    warnings: entry.warnings,
    result,
    origin,
    source: entry.source,
  };
}

// The popup's request id lets it recover this run's outcome from storage if the
// message port dies before sendResponse lands.
function handlePocketTubeSync(message, sendResponse) {
  const requestId = message.requestId || null;
  // Presence, not truthiness: a confirmation carrying a null token is an error,
  // not a request for a fresh preview.
  const isCommit = Object.prototype.hasOwnProperty.call(message, 'confirmToken');

  writeRunState({ requestId, status: 'running', kind: isCommit ? 'import' : 'preview' });

  const run = isCommit
    ? withKeepalive(() => commitPreparedImport(message.confirmToken, message.mode))
    : withKeepalive(() => previewFromPocketTube(message.backupId, message.source));

  run
    .then(async (data) => {
      const payload = { ok: true, ...data };
      await writeRunState({ requestId, status: 'done', ...payload });
      flashBadge(data.dryRun ? 'DRY' : 'OK', '#2e7d32');
      sendResponse(payload);
    })
    .catch(async (error) => {
      console.error('[PocketTube sync] failed:', error);
      const payload = {
        ok: false,
        error: error?.message || String(error),
        // Lets the popup offer the cloud backup as a button instead of
        // switching sources on its own.
        liveFailure: !!error?.ptLiveFailure,
      };
      await writeRunState({ requestId, status: 'done', ...payload });
      flashBadge('ERR', '#c62828');
      sendResponse(payload);
    });
}

// Answered synchronously and from nothing but this file's own constant: the
// point is to prove which worker SOURCE is running, so it must not consult the
// manifest, which the popup reads for itself.
function handleWorkerBuild(sendResponse) {
  sendResponse({ ok: true, build: WORKER_BUILD });
}

function handleConfigureAppOrigin(message, sendResponse) {
  configureAppOrigin(message.appOrigin)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
}

// One dispatcher for every message type. Returning an explicit `false` from a
// listener can close the port for the other listeners on the same message, so
// unknown types fall through to `undefined` instead.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case 'GET_YOUTUBE_COOKIES':
      return handleGetYoutubeCookies(message, sender, sendResponse);
    case 'SYNC_POCKETTUBE':
      handlePocketTubeSync(message, sendResponse);
      return true; // Keep the message channel open for async response
    case 'GET_WORKER_BUILD':
      handleWorkerBuild(sendResponse);
      return;
    case 'CONFIGURE_APP_ORIGIN':
      handleConfigureAppOrigin(message, sendResponse);
      return true;
    default:
      return;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  getAppOrigin().then(ensureAppBridgeRegistration).catch((error) => {
    console.error('[App bridge] could not register the content script:', error);
  });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: SYNC_MENU_ID,
      title: 'Preview PocketTube categories (dry run)',
      contexts: ['action'],
    });
  });
});

async function handOffToPopup(payload) {
  // The commit token is a capability. The context menu never imports, so it has
  // no use for one — never let it reach disk.
  const { token, ...storable } = payload;
  try {
    await chrome.storage.local.set({ [DRY_RUN_RESULT_KEY]: { ...storable, at: Date.now() } });
  } catch (error) {
    console.error('[PocketTube sync] could not store the dry-run result:', error);
  }
  flashBadge(payload.ok ? 'DRY' : 'ERR', payload.ok ? '#2e7d32' : '#c62828');
  try {
    await chrome.action.openPopup();
  } catch (error) {
    console.warn(
      '[PocketTube sync] could not open the popup automatically; ' +
      'click the extension icon to see the result.', error?.message || error
    );
  }
}

// The context menu never imports: a live import is irreversible, so it has to
// go through the popup's explicit confirmation step.
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== SYNC_MENU_ID) return;
  withKeepalive(() => previewFromPocketTube())
    .then((data) => handOffToPopup({ ok: true, ...data }))
    .catch((error) => {
      console.error('[PocketTube sync] failed:', error);
      return handOffToPopup({
        ok: false,
        error: error?.message || String(error),
        liveFailure: !!error?.ptLiveFailure,
      });
    });
});

// The stored dry-run result contains the user's category names. It is normally
// cleared when the popup reads it, but a run whose popup was never opened would
// otherwise keep them on disk forever. The run state only lands in local storage
// on builds without chrome.storage.session. Clearing the stale-reload record
// here allows one fresh self-heal attempt per browser session.
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove([DRY_RUN_RESULT_KEY, RUN_STATE_KEY, STALE_RELOAD_KEY]);
  getAppOrigin().then(ensureAppBridgeRegistration).catch((error) => {
    console.error('[App bridge] could not restore the content script:', error);
  });
});

getAppOrigin().then(ensureAppBridgeRegistration).catch((error) => {
  console.error('[App bridge] could not initialize the content script:', error);
});

// --- self-healing stale worker ------------------------------------------------
//
// Chrome's script cache has kept an OLD background.js running while
// chrome.runtime.getManifest() already reported the NEW version — verified
// live at manifest 1.4 against a worker whose own constants still read 1.3.
// That gap is also the cure: the running script compares the manifest against
// WORKER_BUILD, which travels with this source and is never derived from the
// manifest, and reloads itself when they disagree.

function manifestVersion() {
  try {
    return chrome.runtime.getManifest()?.version || null;
  } catch (error) {
    return null;
  }
}

// NOT storage.session, unlike the run state: chrome.runtime.reload() tears the
// extension down and takes the session area with it, so a record kept there
// would be gone in the worker that has to read it — the loop guard would guard
// nothing. It holds two version strings and a timestamp, so disk costs nothing,
// and onStartup clears it, which allows one fresh attempt per browser session.
function staleReloadStore() {
  return chrome.storage.local;
}

async function readStaleReloadRecord() {
  try {
    const stored = await staleReloadStore().get(STALE_RELOAD_KEY);
    return stored?.[STALE_RELOAD_KEY] || null;
  } catch (error) {
    return null;
  }
}

// Reloads at most once per manifest version. The attempt is recorded BEFORE the
// reload, so a worker that comes back still stale can tell that its own cure
// did not take and stop — a reload loop would be far worse than the bug.
// Returns what it decided, which is what the tests assert on.
async function maybeHealStaleWorker() {
  const version = manifestVersion();
  if (!version) return 'unknown';

  const record = await readStaleReloadRecord();

  if (version === WORKER_BUILD) {
    // Cleared so a later genuine mismatch gets its one reload too.
    if (record) {
      try {
        await staleReloadStore().remove(STALE_RELOAD_KEY);
      } catch (error) {
        // Nothing to do — a leftover record only costs one missed self-heal.
      }
    }
    return 'current';
  }

  if (record && record.target === version) {
    console.error(
      `[worker] STALE: manifest ${version}, running worker ${WORKER_BUILD}. ` +
      'A self-reload was already tried for this version and did not take. ' +
      'Reload the extension at chrome://extensions.'
    );
    return 'gave-up';
  }

  // A preview or an import in flight owns the prepared-import map and the
  // user's confirmation; reloading now would destroy both. stopKeepalive()
  // retries once the run is over.
  if (keepaliveHolders > 0) {
    staleReloadDeferred = true;
    return 'deferred';
  }

  try {
    await staleReloadStore().set({
      [STALE_RELOAD_KEY]: { target: version, from: WORKER_BUILD, at: Date.now() },
    });
  } catch (error) {
    console.warn('[worker] could not record the stale-worker reload:', error?.message || error);
  }
  console.warn(
    `[worker] STALE: manifest ${version}, running worker ${WORKER_BUILD}. Reloading.`
  );
  try {
    chrome.runtime.reload();
  } catch (error) {
    console.error('[worker] the self-reload failed:', error?.message || error);
    return 'failed';
  }
  return 'reloading';
}

maybeHealStaleWorker().catch(() => {});
