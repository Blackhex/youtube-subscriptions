// Stubbed-chrome / stubbed-fetch harness for the extension's service worker and
// content scripts. No build step and no dependencies: run it with
//   node extension/tests/harness.mjs
// It loads background.js, content.js and pockettube-bridge.js as plain source,
// injects fake `chrome`, `fetch`, `window` and `tabs` objects, and asserts the
// security-critical behaviour.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8')
);

const results = [];
async function test(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

// --- loaders -----------------------------------------------------------------

function loadBackground(chromeStub, fetchStub, timers = {}) {
  const src = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
  const selfStub = { crypto: globalThis.crypto };
  const setTimeoutStub = timers.setTimeout || globalThis.setTimeout;
  const clearTimeoutStub = timers.clearTimeout || globalThis.clearTimeout;
  // background.js pulls the live transform in with importScripts(); in a real
  // service worker that is a global, here it is an injected parameter.
  const importScripts = (...files) => {
    files.forEach((file) => {
      const libSrc = fs.readFileSync(path.join(extensionDir, file), 'utf8');
      new Function('self', libSrc)(selfStub);
    });
  };
  const factory = new Function(
    'chrome', 'fetch', 'self', 'importScripts', 'setTimeout', 'clearTimeout', `${src}
    return {
      previewFromPocketTube,
      commitPreparedImport,
      handleGetYoutubeCookies,
      buildShippableBackup,
      summariseBackup,
      readCappedText,
      normaliseImportMode,
      resolveImportSource,
      buildLiveBackup,
      maybeHealStaleWorker,
      validateAndNormaliseOrigin,
      originMatchPattern,
      configureAppOrigin,
      ensureAppBridgeRegistration,
      getAppOrigin,
      parseOAuthCallback,
      isTerminalOAuthRelayResponse,
      handleOAuthCallbackNavigation,
      startKeepalive,
      stopKeepalive,
      BACKUP_VERSION,
      WORKER_BUILD,
      live: self,
    };`
  );
  return factory(
    chromeStub, fetchStub, selfStub, importScripts, setTimeoutStub, clearTimeoutStub
  );
}

function loadContent(windowStub, chromeStub) {
  const src = fs.readFileSync(path.join(extensionDir, 'content.js'), 'utf8');
  new Function('window', 'chrome', src)(windowStub, chromeStub);
}

function loadBridge(windowStub, chromeStub) {
  const src = fs.readFileSync(path.join(extensionDir, 'pockettube-bridge.js'), 'utf8');
  new Function('window', 'chrome', src)(windowStub, chromeStub);
}

// popup.js is a plain script over `document` and `chrome`, so a tiny DOM stub is
// enough to drive it. Only what popup.js actually touches is implemented.
function makeElement(tag) {
  const el = {
    tagName: tag,
    id: '',
    children: [],
    parent: null,
    value: '',
    checked: false,
    className: '',
    hidden: false,
    disabled: false,
    attributes: {},
    focused: false,
    _text: '',
    _listeners: {},
    get textContent() { return el._text; },
    set textContent(next) {
      el._text = `${next}`;
      el.children.splice(0, el.children.length);
    },
    appendChild(child) {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    remove() {
      const siblings = el.parent ? el.parent.children : null;
      if (!siblings) return;
      const index = siblings.indexOf(el);
      if (index >= 0) siblings.splice(index, 1);
      el.parent = null;
    },
    focus() {
      el.focused = true;
      if (el.ownerDocument) el.ownerDocument.activeElement = el;
    },
    setAttribute(name, value) { el.attributes[name] = `${value}`; },
    getAttribute(name) { return el.attributes[name] ?? null; },
    addEventListener(type, fn) {
      (el._listeners[type] = el._listeners[type] || []).push(fn);
    },
    // Awaited so an async handler's storage writes and worker round-trip land
    // before the assertions look at the DOM.
    async fire(type, event) {
      for (const fn of el._listeners[type] || []) await fn(event);
    },
    descendants() {
      return el.children.reduce((all, child) => all.concat([child], child.descendants()), []);
    },
    querySelectorAll(selector) {
      const wanted = selector.replace(/^\./, '');
      return el.descendants()
        .filter((child) => `${child.className}`.split(/\s+/).includes(wanted));
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] || null;
    },
  };
  return el;
}

// Which view of popup.html each element id sits in, read out of the markup
// itself: the run view and the settings view are sibling sections, so an id's
// character offset decides which one owns it. That is what keeps "the backup
// picker is not in the run view" an assertion about the shipped HTML rather
// than about a hand-maintained list.
function popupViews() {
  const html = fs.readFileSync(path.join(extensionDir, 'popup.html'), 'utf8');
  const runAt = html.indexOf('id="run-view"');
  const settingsAt = html.indexOf('id="settings-view"');
  assert.ok(runAt > 0, 'popup.html has no run view');
  assert.ok(settingsAt > runAt, 'popup.html has no settings view after the run view');
  const views = new Map();
  for (const match of html.matchAll(/id="([\w-]+)"/g)) {
    views.set(match[1],
      match.index > settingsAt ? 'settings' : (match.index > runAt ? 'run' : 'header'));
  }
  return views;
}

const POPUP_VIEWS = popupViews();

// Elements popup.html marks hidden at rest.
const POPUP_HIDDEN_IDS = [
  'live-fallback', 'backup-picker', 'confirm', 'build-warning', 'build-reload',
  'settings-view', 'paddle-fields',
];

function makeDocument(ids) {
  const byId = new Map();
  const doc = {
    byId,
    activeElement: null,
    el: (id) => byId.get(id),
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => {
      const el = makeElement(tag);
      el.ownerDocument = doc;
      return el;
    },
  };
  ids.forEach((id) => {
    const el = makeElement('div');
    el.id = id;
    el.ownerDocument = doc;
    byId.set(id, el);
  });
  return doc;
}

function makePopupDocument() {
  const doc = makeDocument(Array.from(POPUP_VIEWS.keys()));
  doc.viewOf = (id) => POPUP_VIEWS.get(id);
  const liveFallbackHint = makeElement('p');
  liveFallbackHint.className = 'hint';
  liveFallbackHint.ownerDocument = doc;
  doc.el('live-fallback').appendChild(liveFallbackHint);
  POPUP_HIDDEN_IDS.forEach((id) => {
    assert.ok(doc.el(id), `popup.html no longer defines #${id}`);
    doc.el(id).hidden = true;
  });
  return doc;
}

function loadPopup(chromeStub) {
  const src = fs.readFileSync(path.join(extensionDir, 'popup.js'), 'utf8');
  const doc = makePopupDocument();
  const selfStub = { crypto: globalThis.crypto };
  new Function('document', 'chrome', 'self', src)(doc, chromeStub, selfStub);
  return doc;
}

// popup.js reads its settings through promise chains at load time; nothing is
// settled until those microtasks have run.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function submitOrigin(doc) {
  return doc.el('app-origin-form').fire('submit', { preventDefault() {} });
}

function dispatchRuntimeMessage(chromeStub, message, sender = {}) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const sendResponse = (response) => {
      answered = true;
      resolve(response);
    };
    try {
      const keepOpen = chromeStub._listeners.message(message, sender, sendResponse);
      if (keepOpen !== true && !answered) resolve(undefined);
    } catch (error) {
      reject(error);
    }
  });
}

// A chrome stub for the popup: no service worker, just a scripted answer to the
// messages popup.js sends. `options.workerBuild` is what the (stubbed) worker
// reports out of its own source; null stands for a worker that never answers.
// It defaults to the manifest version, i.e. a healthy pair. `options.youtubeTabs`
// is what chrome.tabs.query reports — empty by default, which is the case where
// reading the live source would have to OPEN a tab.
function popupChrome(answer, options = {}) {
  const local = options.storage ? options.storage.local : makeStorageArea();
  const session = options.storage ? options.storage.session : makeStorageArea();
  const sent = [];
  const tabQueries = [];
  const createdTabs = [];
  const openedOptions = [];
  const manifestVersion = options.manifestVersion || MANIFEST.version;
  const workerBuild = Object.prototype.hasOwnProperty.call(options, 'workerBuild')
    ? options.workerBuild
    : manifestVersion;
  const permissions = options.permissions || makePermissions(options);
  return {
    _sent: sent,
    _tabQueries: tabQueries,
    _createdTabs: createdTabs,
    _openedOptions: openedOptions,
    storage: { local, session },
    permissions,
    tabs: {
      query: async (query) => {
        tabQueries.push(query);
        if (options.tabsQueryThrows) throw new Error('no tabs permission');
        return options.youtubeTabs || [];
      },
      // Only here to prove the popup never reaches for it.
      create: async (info) => {
        createdTabs.push(info);
        return { id: 900, ...info };
      },
    },
    runtime: {
      lastError: null,
      getManifest: () => ({ version: manifestVersion }),
      openOptionsPage: () => { openedOptions.push(true); },
      sendMessage: async (message) => {
        // Answered here rather than by `answer`, and kept out of `_sent`, so the
        // build probe stays invisible to the sync assertions.
        if (message && message.type === 'GET_WORKER_BUILD') {
          return workerBuild === null ? undefined : { ok: true, build: workerBuild };
        }
        if (message && message.type === 'CONFIGURE_APP_ORIGIN') {
          if (options.configureAnswer) return options.configureAnswer(message);
          await local.set({ appOrigin: message.appOrigin });
          return { ok: true, origin: message.appOrigin, cleanupWarning: '' };
        }
        sent.push(message);
        return typeof answer === 'function' ? answer(message) : answer;
      },
    },
  };
}

// --- stubs -------------------------------------------------------------------

function makeStorageArea() {
  const data = new Map();
  return {
    data,
    async get(key) {
      if (key === null || key === undefined) return Object.fromEntries(data);
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      keys.forEach((k) => { if (data.has(k)) out[k] = data.get(k); });
      return out;
    },
    async set(obj) { Object.keys(obj).forEach((k) => data.set(k, obj[k])); },
    async remove(key) {
      (Array.isArray(key) ? key : [key]).forEach((k) => data.delete(k));
    },
  };
}

function patternCovers(granted, requested) {
  if (granted === requested) return true;
  const escaped = granted.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(requested);
}

function makePermissions(options = {}) {
  const granted = new Set(MANIFEST.host_permissions || []);
  (options.grantedOrigins || []).forEach((origin) => granted.add(origin));
  const requested = [];
  const removed = [];
  const contained = [];
  const callOrder = [];
  const added = [];
  const fireAdded = (details) => {
    added.push(details);
  };
  const permissions = {
    _granted: granted,
    _requested: requested,
    _removed: removed,
    _contained: contained,
    _added: added,
    _callOrder: callOrder,
    _grantRequests: options.permissionGranted !== false,
    _removeResult: options.permissionRemoveResult !== false,
    async contains(details) {
      callOrder.push('contains');
      contained.push(details);
      if (options.permissionContainsThrows) {
        throw new Error(options.permissionContainsThrows);
      }
      return (details.origins || []).every((origin) =>
        Array.from(granted).some((entry) => patternCovers(entry, origin))
      );
    },
    async request(details) {
      callOrder.push('request');
      requested.push(details);
      if (options.permissionRequestThrows) {
        throw new Error(options.permissionRequestThrows);
      }
      if (!permissions._grantRequests) return false;
      (details.origins || []).forEach((origin) => {
        const alreadyGranted = Array.from(granted).some((entry) =>
          patternCovers(entry, origin)
        );
        if (!alreadyGranted) {
          granted.add(origin);
          fireAdded({ origins: [origin] });
        }
      });
      if (options.permissionRequestThrowsAfterGrant) {
        throw new Error(options.permissionRequestThrowsAfterGrant);
      }
      return true;
    },
    async remove(details) {
      removed.push(details);
      if (options.permissionRemoveThrows) {
        throw new Error(options.permissionRemoveThrows);
      }
      if (!permissions._removeResult) return false;
      (details.origins || []).forEach((origin) => granted.delete(origin));
      return true;
    },
  };
  return permissions;
}

function makeScripting() {
  const registrations = new Map();
  return {
    _registrations: registrations,
    async getRegisteredContentScripts(filter = {}) {
      const ids = filter.ids || Array.from(registrations.keys());
      return ids.filter((id) => registrations.has(id)).map((id) => registrations.get(id));
    },
    async registerContentScripts(scripts) {
      scripts.forEach((script) => {
        if (registrations.has(script.id)) throw new Error(`duplicate registration: ${script.id}`);
        registrations.set(script.id, { ...script });
      });
    },
    async updateContentScripts(scripts) {
      scripts.forEach((script) => {
        if (!registrations.has(script.id)) throw new Error(`missing registration: ${script.id}`);
        registrations.set(script.id, { ...registrations.get(script.id), ...script });
      });
    },
    async unregisterContentScripts(filter = {}) {
      (filter.ids || Array.from(registrations.keys())).forEach((id) => registrations.delete(id));
    },
  };
}

// A chrome.tabs stub. `reply` is what the bridge content script would answer;
// leaving it out makes sendMessage fail the way an un-bridged tab does.
function makeTabs(options = {}) {
  const state = {
    created: [],
    removed: [],
    sent: [],
    queryResult: options.queryResult || [],
    reply: options.reply || null,
    queryThrows: !!options.queryThrows,
    createThrows: !!options.createThrows,
    updated: [],
  };
  const noopListeners = { addListener: () => {}, removeListener: () => {} };
  return {
    _state: state,
    query: async () => {
      if (state.queryThrows) throw new Error('no tabs permission');
      return state.queryResult;
    },
    create: async ({ url }) => {
      if (state.createThrows) throw new Error('could not create a tab');
      const tab = { id: 900 + state.created.length, url, status: 'complete' };
      state.created.push(tab);
      return tab;
    },
    get: async (id) => ({ id, status: 'complete' }),
    remove: async (id) => {
      state.removed.push(id);
      if (options.removeThrows) throw new Error(options.removeError || 'could not remove tab');
    },
    update: async (id, changes) => {
      state.updated.push({ id, changes });
      if (options.updateThrows) throw new Error(options.updateError || 'could not update tab');
      return { id, ...changes };
    },
    sendMessage: async (tabId, message) => {
      state.sent.push({ tabId, message });
      if (typeof state.reply !== 'function') {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      return state.reply(tabId, message);
    },
    onUpdated: noopListeners,
    onRemoved: noopListeners,
  };
}

function makeChrome(overrides = {}) {
  const local = makeStorageArea();
  // The shipped default is "live"; every pre-existing test below exercises the
  // cloud path, so it is pinned here rather than left to the default.
  local.data.set('importSource', 'cloud');
  const listeners = {};
  const reloads = [];
  const stub = {
    _local: local,
    _listeners: listeners,
    _reloads: reloads,
    storage: { local, session: makeStorageArea() },
    permissions: makePermissions(overrides),
    scripting: makeScripting(),
    tabs: makeTabs(overrides.tabsOptions),
    webNavigation: {
      onBeforeNavigate: {
        addListener: (fn) => { listeners.beforeNavigate = fn; },
      },
    },
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
      onStartup: { addListener: (fn) => { listeners.startup = fn; } },
      getPlatformInfo: () => Promise.resolve({ os: 'test' }),
      sendMessage: () => {},
      // Defaults to the shipped manifest, i.e. a worker that is NOT stale.
      getManifest: () => ({ version: overrides.manifestVersion || MANIFEST.version }),
      reload: () => { reloads.push(Date.now()); },
    },
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {},
      openPopup: () => Promise.resolve(),
    },
    contextMenus: {
      removeAll: (cb) => cb && cb(),
      create: () => {},
      onClicked: { addListener: () => {} },
    },
    cookies: {
      getAll: (_query, cb) => cb([
        { name: 'SAPISID', value: 'secret', domain: '.youtube.com', path: '/', secure: true },
      ]),
    },
  };
  return Object.assign(stub, overrides);
}

const APP_ORIGIN = 'http://127.0.0.1:8001';

function sampleBackup() {
  const channelA = 'UCaaaaaaaaaaaaaaaaaaaaaa';
  const channelB = 'UCbbbbbbbbbbbbbbbbbbbbbb';
  const channelC = 'UCcccccccccccccccccccccc';
  return {
    // Credential material PocketTube's own backup writer leaves behind.
    patreon: { accessToken: 'PATREON-SECRET' },
    yu: { email: 'user@example.com', tokens: ['PADDLE-SECRET'] },
    ysc_token_google: { access_token: 'GOOGLE-SECRET', refresh_token: 'GOOGLE-REFRESH' },
    ysc_settings: { patreon: { accessToken: 'NESTED' }, yu: { email: 'n@e' }, theme: 'dark' },
    ysc_channel_metadata: {
      [channelA]: { title: 'A', img: 'a.png' },
      [channelB]: { title: 'B', img: 'b.png' },
    },
    // Category lists — including one whose NAME matches the redaction regex.
    Tech: [channelA, channelB],
    Authors: [channelA, channelC],
    'Tech_ysm_1': [channelC],
  };
}

// What the PlayList Manager's backup set looks like once summarised: a
// category list with no channels in it, i.e. an import that would create
// nothing.
function emptyCategoryBackup() {
  return {
    ysc_settings: { theme: 'dark' },
    ysc_channel_metadata: {},
    Test: [],
  };
}

// What PocketTube's Subscription Manager answers `get_channel_data` with. Shape
// verified live: groupTree is an ARRAY of root nodes nested through `child`,
// channelList is CHANNEL metadata, metaList is GROUP metadata, and `finish` is
// false even though the payload is complete.
const LIVE_A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const LIVE_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const LIVE_C = 'UCcccccccccccccccccccccc';

function sampleLiveReply() {
  return {
    finish: false,
    unSelectedGroups: [],
    selectedGroups: [],
    videoTypes: {},
    channelList: {
      [LIVE_A]: { img: 'https://img.example/a.jpg', title: 'Alpha', count: 3 },
      [LIVE_B]: { img: 'https://img.example/b.jpg', title: 'Beta', count: 1 },
      [LIVE_C]: { img: '//img.example/c.jpg', title: 'Gamma', count: 0 },
    },
    // GROUP metadata keyed by category name — never channel metadata.
    metaList: {
      Construction: { img: 'https://img.example/group.jpg', position: 0 },
      Authors: { img: '', position: 1 },
    },
    settings: {
      patreon: '{"access_token":"PATREON-SECRET"}',
      yu: { email: 'user@example.com', tokens: ['PADDLE-SECRET'] },
      theme: 'dark',
      sub_groups: { Construction: { Concrete: {}, 'Tiny House': {} } },
    },
    groupTree: [
      {
        titleGroup: 'Construction',
        newVideoInGroup: 0,
        countSubInGroup: 1,
        positionGroup: 0,
        channelsList: [
          {
            channelId: LIVE_A, title: 'Alpha', img: 'https://img.example/a.jpg',
            newVideoCount: 0, subscriberCount: '1.2M', styleCount: 0, position: 0,
          },
        ],
        child: [
          {
            titleGroup: 'Concrete',
            positionGroup: 3,
            channelsList: [
              {
                channelId: LIVE_B, title: 'Beta', img: '//img.example/b.jpg',
                subscriberCount: 4200,
              },
            ],
            child: [],
          },
          { titleGroup: 'Tiny House', channelsList: [], child: [] },
        ],
      },
      {
        titleGroup: 'Authors',
        channelsList: [
          // No usable title or image here — the fallback is channelList.
          { channelId: LIVE_C, title: '', img: '', subscriberCount: null },
          { channelId: 'not-a-channel-id', title: 'junk' },
        ],
        child: [],
      },
    ],
  };
}

// Groups whose names collide with the credential deny-list and with a reserved
// PocketTube storage key.
function credentialNamedLiveReply() {
  return {
    finish: false,
    channelList: {},
    settings: { sub_groups: {} },
    groupTree: [
      {
        titleGroup: 'patreon',
        channelsList: [{ channelId: LIVE_A, title: 'Alpha', img: '' }],
        child: [],
      },
      {
        titleGroup: 'ysc_token_google',
        channelsList: [{ channelId: LIVE_B, title: 'Beta', img: '' }],
        child: [],
      },
      {
        titleGroup: 'Authors',
        channelsList: [{ channelId: LIVE_C, title: 'Gamma', img: '' }],
        child: [],
      },
    ],
  };
}

// A youtube.com tab that is open and answers the bridge with `response`.
function liveTabs(response, options = {}) {
  return makeTabs({
    queryResult: [{ id: 7, url: 'https://www.youtube.com/feed/channels' }],
    reply: () => response,
    ...options,
  });
}

async function liveChrome(response, tabsOverride) {
  const chromeStub = makeChrome({ tabs: tabsOverride || liveTabs(response) });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  return chromeStub;
}

function jsonResponse(body, init = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers ?? { 'content-type': 'application/json' },
  });
}

function makeFetch(options = {}) {
  const calls = [];
  const backup = options.backup ?? sampleBackup();
  const backupsById = options.backupsById || null;
  const keys = options.keys ?? [1700000000, 1600000000];
  // What GET /api/categories/ answers, in the app's nested shape.
  const appCategories = options.appCategories ?? [];
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/backup/list')) {
      if (options.listHeaders) {
        return jsonResponse({ keys: [1700000000] }, { headers: options.listHeaders });
      }
      return jsonResponse({ keys });
    }
    if (url.endsWith('/backup/download')) {
      const id = init.body.get('id');
      const chosen = backupsById ? backupsById[id] : backup;
      return jsonResponse({ data: JSON.stringify(chosen ?? backup) });
    }
    if (url.endsWith('/api/categories/import/')) {
      return jsonResponse({
        mode: init.body.get('mode'),
        created_categories: 2, created_subscriptions: 2,
        assignments_added: 4, unmatched_channels: 2,
        deleted_categories: 3, deleted_assignments: 9,
      });
    }
    if (url.endsWith('/api/categories/')) {
      if (options.categoriesFailure === 'network') throw new Error('connection refused');
      if (options.categoriesFailure === 'status') return jsonResponse({}, { status: 500 });
      if (options.categoriesFailure === 'garbage') return jsonResponse('not json');
      return jsonResponse({
        categories: appCategories,
        total_count: 0,
        uncategorized_count: 0,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  fetchStub.calls = calls;
  return fetchStub;
}

function deepKeys(value, out = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => deepKeys(entry, out));
  } else if (value && typeof value === 'object') {
    Object.keys(value).forEach((key) => {
      out.add(key);
      deepKeys(value[key], out);
    });
  }
  return out;
}

// --- background: BLOCKER-1 ---------------------------------------------------

await test('committed payload contains no credential key at any depth', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'PATREON-SECRET' },
  });
  const backup = sampleBackup();
  backup.transportFixture = {
    label: 'keep-root',
    entries: [
      { label: 'keep-array-neighbor', accessToken: 'ARBITRARY-ACCESS-SECRET' },
      {
        nested: {
          count: 2,
          refresh_token: 'ARBITRARY-REFRESH-SECRET',
          sessionState: 'ARBITRARY-SESSION-SECRET',
        },
      },
    ],
  };
  const fetchStub = makeFetch({ backup });
  const bg = loadBackground(chromeStub, fetchStub);

  const preview = await bg.previewFromPocketTube();
  await bg.commitPreparedImport(preview.token);

  const posted = fetchStub.calls.find((c) => c.url.endsWith('/api/categories/import/'));
  assert.ok(posted, 'the import was never POSTed');
  const file = posted.init.body.get('file');
  const text = await file.text();

  [
    'patreon', 'yu', 'ysc_token_google', 'accessToken', 'refresh_token', 'sessionState',
    'PATREON-SECRET', 'GOOGLE-SECRET', 'PADDLE-SECRET',
    'ARBITRARY-ACCESS-SECRET', 'ARBITRARY-REFRESH-SECRET', 'ARBITRARY-SESSION-SECRET',
  ]
    .forEach((needle) => {
      assert.ok(!text.includes(needle), `the POSTed body still contains "${needle}"`);
    });

  const parsed = JSON.parse(text);
  const keys = deepKeys(parsed);
  ['patreon', 'yu', 'ysc_token_google', 'accessToken', 'refresh_token', 'sessionState']
    .forEach((key) => {
    assert.ok(!keys.has(key), `key "${key}" survives at some depth`);
  });
  assert.equal(parsed.ysc_settings.theme, 'dark', 'non-secret settings were dropped');
  assert.deepEqual(parsed.transportFixture, {
    label: 'keep-root',
    entries: [
      { label: 'keep-array-neighbor' },
      { nested: { count: 2 } },
    ],
  }, 'neighboring nested transport data was dropped');
  assert.deepEqual(parsed.Tech, sampleBackup().Tech, 'category data was dropped');
  assert.ok(parsed.Authors, 'a category whose name matches the redaction regex was dropped');
});

await test('preview reports withheld keys only in redaction stats', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const bg = loadBackground(chromeStub, makeFetch());
  const preview = await bg.previewFromPocketTube();
  ['patreon', 'yu', 'ysc_token_google', 'ysc_settings.patreon', 'ysc_settings.yu']
    .forEach((key) => assert.ok(preview.stats.withheld.includes(key),
      `redaction stats do not name ${key}`));
  assert.ok(!(preview.warnings || []).some((warning) => warning.startsWith('Withheld:')),
    'a withheld-keys warning was surfaced');
  assert.deepEqual(preview.stats.withheld.includes('Authors'), false);
});

// --- background: the product the backup API is asked about -------------------

await test('every backup API call asks for the subscription backup set', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const fetchStub = makeFetch();
  const bg = loadBackground(chromeStub, fetchStub);
  await bg.previewFromPocketTube();

  assert.equal(bg.BACKUP_VERSION, 'subscriptions');
  const backupCalls = fetchStub.calls.filter((c) => c.url.includes('/backup/'));
  assert.equal(backupCalls.length, 2, 'list + download were not both called');
  backupCalls.forEach((call) => {
    assert.equal(call.init.body.get('version'), 'subscriptions',
      `${call.url} asked for the wrong PocketTube product`);
  });
});

await test('sensitive backup and app fetches reject redirects', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const fetchStub = makeFetch();
  const bg = loadBackground(chromeStub, fetchStub);
  const preview = await bg.previewFromPocketTube();
  await bg.commitPreparedImport(preview.token);

  const sensitive = fetchStub.calls.filter((call) =>
    call.url.includes('p.yousub.info') || call.url.startsWith(APP_ORIGIN)
  );
  assert.equal(sensitive.length, 4, 'expected backup list/download and app list/import');
  sensitive.forEach((call) => {
    assert.equal(call.init.redirect, 'error', `${call.url} can still follow redirects`);
  });
});

// --- background: import mode --------------------------------------------------

await test('the chosen import mode is sent in the multipart body', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const fetchStub = makeFetch();
  const bg = loadBackground(chromeStub, fetchStub);

  const additive = await bg.previewFromPocketTube();
  const result = await bg.commitPreparedImport(additive.token, 'additive');
  const posted = fetchStub.calls.filter((c) => c.url.endsWith('/api/categories/import/'));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].init.body.get('mode'), 'additive',
    'the chosen mode never reached the request body');
  assert.equal(result.mode, 'additive');
  assert.equal(result.result.mode, 'additive');

  const replacing = await bg.previewFromPocketTube();
  await bg.commitPreparedImport(replacing.token, 'replace');
  assert.equal(
    fetchStub.calls.filter((c) => c.url.endsWith('/api/categories/import/'))[1]
      .init.body.get('mode'),
    'replace'
  );
});

await test('a missing mode is sent explicitly as replace, a bad one is refused', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const fetchStub = makeFetch();
  const bg = loadBackground(chromeStub, fetchStub);

  assert.equal(bg.normaliseImportMode(undefined), 'replace');
  assert.equal(bg.normaliseImportMode(''), 'replace');
  assert.equal(bg.normaliseImportMode('ADDITIVE'), 'additive');
  assert.throws(() => bg.normaliseImportMode('merge'), /Unknown import mode/);

  const preview = await bg.previewFromPocketTube();
  await assert.rejects(
    () => bg.commitPreparedImport(preview.token, 'merge'), /Unknown import mode/
  );
  assert.ok(
    !fetchStub.calls.some((c) => c.url.endsWith('/api/categories/import/')),
    'an unknown mode was POSTed anyway'
  );

  // The rejected mode must not have burned the one-shot token.
  await bg.commitPreparedImport(preview.token);
  const posted = fetchStub.calls.find((c) => c.url.endsWith('/api/categories/import/'));
  assert.equal(posted.init.body.get('mode'), 'replace',
    'the default was left to the server instead of being sent');
});

// --- background: what replace mode would delete -------------------------------

await test('the preview counts the categories replace mode would delete', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const fetchStub = makeFetch({
    appCategories: [
      { id: 1, name: 'Tech', children: [{ id: 3, name: 'Podcasts', children: [] }] },
      { id: 2, name: 'Music', children: [] },
    ],
  });
  const bg = loadBackground(chromeStub, fetchStub);
  const preview = await bg.previewFromPocketTube();

  const asked = fetchStub.calls.filter((c) => c.url.endsWith('/api/categories/'));
  assert.equal(asked.length, 1, 'the app was not asked for its current categories');
  assert.equal(asked[0].url, `${APP_ORIGIN}/api/categories/`);
  assert.equal(asked[0].init.method, 'GET');

  // The backup holds Tech + Authors (Tech_ysm_1 merges into Tech).
  assert.equal(preview.existing.ok, true);
  assert.equal(preview.existing.categories, 3);
  assert.equal(preview.existing.kept, 1);
  assert.equal(preview.existing.removed, 2, 'nested categories were not counted');
  assert.deepEqual(preview.existing.removedSample.sort(), ['Music', 'Podcasts']);
  assert.equal(preview.existing.added, 1);

  // The full name list is a comparison input, not something the popup needs.
  assert.equal(preview.stats.categoryNames, undefined);
});

await test('a failed category lookup is reported but does not block the import', async () => {
  for (const failure of ['network', 'status', 'garbage']) {
    const chromeStub = makeChrome();
    await chromeStub.storage.local.set({
      appOrigin: APP_ORIGIN,
      pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
    });
    const fetchStub = makeFetch({ categoriesFailure: failure });
    const bg = loadBackground(chromeStub, fetchStub);

    const preview = await bg.previewFromPocketTube();
    assert.equal(preview.existing.ok, false, `${failure}: a failed lookup was reported as ok`);
    assert.ok(preview.existing.error, `${failure}: no reason was given`);
    assert.equal(preview.existing.removed, undefined,
      `${failure}: an unknown removal count was reported as a number`);
    assert.equal(preview.committable, true, `${failure}: a failed lookup blocked the import`);

    await bg.commitPreparedImport(preview.token, 'replace');
    assert.ok(
      fetchStub.calls.some((c) => c.url.endsWith('/api/categories/import/')),
      `${failure}: the import never ran`
    );
  }
});

// --- background: a backup that would import nothing ---------------------------

await test('a preview with zero assignments is not committable', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const fetchStub = makeFetch({ backup: emptyCategoryBackup() });
  const bg = loadBackground(chromeStub, fetchStub);

  const preview = await bg.previewFromPocketTube();
  assert.equal(preview.stats.categories, 1);
  assert.equal(preview.stats.assignments, 0);
  assert.equal(preview.committable, false, 'an empty backup was offered for import');
  assert.ok(
    (preview.warnings || []).some((w) => /0 assignments/.test(w)),
    'no warning named the zero-assignment counts'
  );

  await assert.rejects(() => bg.commitPreparedImport(preview.token), /cannot be imported/);
  assert.ok(
    !fetchStub.calls.some((c) => c.url.endsWith('/api/categories/import/')),
    'an empty backup was POSTed to the app anyway'
  );
});

// --- background: choosing which backup to preview -----------------------------

await test('the preview lists the backups and honours an explicit id', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const fetchStub = makeFetch({
    keys: [1600000000, 1700000000],
    backupsById: { 1700000000: emptyCategoryBackup(), 1600000000: sampleBackup() },
  });
  const bg = loadBackground(chromeStub, fetchStub);

  const newest = await bg.previewFromPocketTube();
  assert.deepEqual(newest.backups.map((b) => b.id), [1700000000, 1600000000],
    'the backup list is not newest-first');
  assert.equal(newest.stats.backupId, 1700000000, 'the default is not the newest backup');
  assert.equal(newest.committable, false);

  const chosen = await bg.previewFromPocketTube('1600000000');
  assert.equal(chosen.stats.backupId, 1600000000, 'the chosen backup was not downloaded');
  assert.equal(chosen.committable, true);

  await assert.rejects(() => bg.previewFromPocketTube('1234'), /no longer lists backup/);
});

// --- background: MINOR-13 ----------------------------------------------------

await test('preview reports the expected unmatched channels', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const bg = loadBackground(chromeStub, makeFetch());
  const { stats, warnings } = await bg.previewFromPocketTube();
  // channelC appears in Authors and Tech_ysm_1 but has no metadata entry.
  assert.equal(stats.channels, 3);
  assert.equal(stats.knownChannels, 2);
  assert.equal(stats.unmatchedChannels, 1);
  assert.equal(stats.unmatchedAssignments, 2);
  assert.ok(!(warnings || []).some((warning) => /lack metadata|unmatched/i.test(warning)),
    'unmatched metadata was surfaced as an informational warning');
});

// --- background: PocketTube caches are not categories -------------------------

// Shaped after the user's real dump: ysc_collection / ysc_meta are PocketTube's
// own category registry, and liveStreamsCurrent / nvl / nvlo / ysc_deck are
// top-level lists that are NOT categories. Fun is an empty category, Top is
// chunked, and Top / Programming each hold a malformed entry.
const CACHE_A = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const CACHE_B = 'UCbbbbbbbbbbbbbbbbbbbbbb';
const CACHE_LIVE = 'UCdddddddddddddddddddddd';
const MALFORMED_YOUTUBE_ROOT = 'https://www.youtube.com/';

function malformedUrlBackup() {
  return {
    ysc_collection: {
      Tech: 'Tech',
      Authors: 'Authors',
      UrlOnly: 'UrlOnly',
    },
    ysc_meta: {
      Tech: { img: '', position: 0 },
      Authors: { img: '', position: 1 },
      UrlOnly: { img: '', position: 2 },
    },
    ysc_channel_metadata: {
      [CACHE_A]: { title: 'A', img: 'a.png' },
      [CACHE_B]: { title: 'B', img: 'b.png' },
    },
    Tech: [CACHE_A, MALFORMED_YOUTUBE_ROOT],
    Tech_ysm_1: [CACHE_B, MALFORMED_YOUTUBE_ROOT],
    Authors: [CACHE_A, MALFORMED_YOUTUBE_ROOT],
    UrlOnly: [MALFORMED_YOUTUBE_ROOT],
    unrelatedArray: [MALFORMED_YOUTUBE_ROOT],
    patreon: [CACHE_A],
    yu: [CACHE_A, CACHE_B],
    ysc_token_google: [CACHE_B],
  };
}

function registryBackup() {
  return {
    ysc_collection: { Fun: 'Fun', Top: 'Top', Programming: 'Programming' },
    ysc_meta: {
      Fun: { img: '', position: 0 },
      Top: { img: '', position: 1 },
      Programming: { img: '', position: 2 },
    },
    ysc_channel_metadata: {
      [CACHE_A]: { title: 'A', img: 'a.png' },
      [CACHE_B]: { title: 'B', img: 'b.png' },
    },
    Fun: [],
    Top: [CACHE_A],
    Top_ysm_1: [CACHE_B, 'not-a-channel-id'],
    Programming: [CACHE_A, 42],
    liveStreamsCurrent: [CACHE_LIVE],
    nvl: [{ contentType: 'video', idChannel: CACHE_A, img: 'x.jpg' }],
    nvlo: ['2C_KGNTgc_c', 'TbvjrEXz3Fs'],
    ysc_deck: ['deck'],
  };
}

function prototypeSensitiveBackup() {
  return JSON.parse(`{
    "ysc_collection": {
      "__proto__": "__proto__",
      "constructor": "constructor",
      "prototype": "prototype"
    },
    "ysc_meta": {
      "__proto__": { "img": "proto.png", "accessToken": "META-PROTO-SECRET" },
      "constructor": { "img": "constructor.png", "sessionId": "META-CONSTRUCTOR-SECRET" },
      "prototype": { "img": "prototype.png", "refresh_token": "META-PROTOTYPE-SECRET" }
    },
    "ysc_channel_metadata": {
      "${CACHE_A}": { "title": "A", "img": "a.png" },
      "${CACHE_B}": { "title": "B", "img": "b.png" }
    },
    "ysc_settings": {
      "sub_groups": {
        "__proto__": { "constructor": { "prototype": {} } }
      },
      "layout": {
        "__proto__": { "label": "keep-proto", "accessToken": "LAYOUT-PROTO-SECRET" }
      }
    },
    "__proto__": ["${CACHE_A}", "${MALFORMED_YOUTUBE_ROOT}"],
    "constructor": ["${CACHE_B}", "${MALFORMED_YOUTUBE_ROOT}"],
    "prototype": ["${CACHE_A}"]
  }`);
}

function dottedKeySpoofBackup() {
  return {
    ysc_collection: {
      'Auth.Parent': 'Auth.Parent',
      'Tokens.Child': 'Tokens.Child',
    },
    ysc_meta: {
      'Auth.Parent': {
        img: 'auth-parent.png',
        position: 0,
        accessToken: 'REAL-META-ACCESS-SECRET',
      },
      'Tokens.Child': { img: 'tokens-child.png', position: 1 },
    },
    ysc_channel_metadata: {
      [CACHE_A]: { title: 'Safe Channel', img: 'safe-channel.png' },
    },
    ysc_settings: {
      theme: 'safe-theme',
      'sub_groups.fake': {
        accessToken: 'DOTTED-SETTINGS-ACCESS-SECRET',
        refresh_token: 'DOTTED-SETTINGS-REFRESH-SECRET',
        sessionSecret: 'DOTTED-SETTINGS-SESSION-SECRET',
        safeNeighbor: { label: 'keep-settings-neighbor' },
      },
      // Every object key below sub_groups is a category name in the current
      // tree shape, so dotted and credential-pattern names remain user data.
      sub_groups: {
        'Auth.Parent': {
          'Tokens.Child': {},
        },
      },
    },
    transportFixture: {
      'ysc_meta.fake': {
        accessToken: 'DOTTED-META-ACCESS-SECRET',
        safeNeighbor: 'keep-meta-neighbor',
      },
      'ysc_channel_metadata.fake': {
        refresh_token: 'DOTTED-CHANNEL-REFRESH-SECRET',
        safeNeighbor: 'keep-channel-neighbor',
      },
    },
    'Auth.Parent': [CACHE_A],
    'Tokens.Child': [CACHE_A],
  };
}

function withoutRegistry() {
  const backup = registryBackup();
  delete backup.ysc_collection;
  delete backup.ysc_meta;
  return backup;
}

await test('the registry decides what is a category, not "is it a list"', async () => {
  const bg = loadBackground(makeChrome(), makeFetch());
  const stats = bg.summariseBackup(registryBackup(), 1700000000);

  assert.deepEqual(stats.categoryNames.sort(), ['Fun', 'Programming', 'Top'],
    'a PocketTube cache was counted as a category');
  assert.equal(stats.categories, 3);
  // Fun is empty and still a category; Top_ysm_1 folded into Top; the malformed
  // entries did not disqualify their categories.
  assert.equal(stats.assignments, 4);
  assert.equal(stats.channels, 3, 'a cached channel or video id leaked in');
  assert.ok(!stats.categoryNames.includes('Top_ysm_1'), 'a chunk key stayed separate');
});

await test('without a registry the denylist still excludes the caches', async () => {
  const bg = loadBackground(makeChrome(), makeFetch());
  const stats = bg.summariseBackup(withoutRegistry(), 1700000000);

  assert.deepEqual(stats.categoryNames.sort(), ['Fun', 'Programming', 'Top'],
    'the fallback path counted liveStreamsCurrent / nvl / nvlo');
  assert.equal(stats.categories, 3);
  assert.equal(stats.assignments, 4, 'the fallback path merged the chunks differently');
});

await test('registered categories filter only the exact malformed YouTube root', async () => {
  const bg = loadBackground(makeChrome(), makeFetch());
  const backup = malformedUrlBackup();
  backup.Tech.push(
    'https://www.youtube.com',
    'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa',
    'not-a-channel-id'
  );
  const original = structuredClone(backup);

  const { shipped, withheld } = bg.buildShippableBackup(backup);

  assert.deepEqual(backup, original, 'the raw backup was mutated');
  assert.deepEqual(shipped.Tech, [
    CACHE_A,
    'https://www.youtube.com',
    'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa',
    'not-a-channel-id',
  ]);
  assert.deepEqual(shipped.Tech_ysm_1, [CACHE_B]);
  assert.deepEqual(shipped.Authors, [CACHE_A],
    'a credential-pattern category name was redacted');
  assert.deepEqual(shipped.UrlOnly, [], 'a URL-only category was removed entirely');
  assert.deepEqual(shipped.unrelatedArray, [MALFORMED_YOUTUBE_ROOT],
    'a non-category array was filtered');
  assert.ok(withheld.includes('patreon'));
  assert.ok(withheld.includes('yu'));
  assert.ok(withheld.includes('ysc_token_google'));
  assert.ok(!Object.hasOwn(shipped, 'patreon'));
  assert.ok(!Object.hasOwn(shipped, 'yu'));
  assert.ok(!Object.hasOwn(shipped, 'ysc_token_google'));
});

await test('credential-pattern categories retain near matches and remove only the exact root', async () => {
  const bg = loadBackground(makeChrome(), makeFetch());
  const retained = [
    CACHE_A,
    'https://www.youtube.com',
    'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa',
    'arbitrary malformed string',
  ];

  for (const categoryName of ['Tokens', 'Auth']) {
    for (const nearMatch of retained.slice(1)) {
      const backup = {
        ysc_collection: { [categoryName]: categoryName },
        ysc_meta: { [categoryName]: { img: '', position: 0 } },
        [categoryName]: [CACHE_A, MALFORMED_YOUTUBE_ROOT, nearMatch],
      };
      const original = structuredClone(backup);

      const { shipped, withheld } = bg.buildShippableBackup(backup);

      assert.deepEqual(shipped[categoryName], [CACHE_A, nearMatch],
        `${categoryName} did not preserve ${nearMatch}`);
      assert.ok(!withheld.includes(categoryName), `${categoryName} was reported as withheld`);
      assert.deepEqual(backup, original, `${categoryName} raw fixture was mutated`);
    }
  }
});

await test('dynamic registry keys survive while nested transport secrets are withheld by path', async () => {
  const bg = loadBackground(makeChrome(), makeFetch());
  const backup = {
    ysc_collection: {
      Authors: 'Authors',
      Tokens: 'Tokens',
    },
    ysc_meta: {
      Authors: { img: 'authors.png', position: 1, accessToken: 'META-AUTHORS-SECRET' },
      Tokens: { img: 'tokens.png', position: 2, sessionId: 'META-TOKENS-SECRET' },
    },
    ysc_title_id: {
      'Auth Session Channel': CACHE_A,
    },
    ysc_channel_metadata: {
      [CACHE_A]: {
        title: 'Auth Session Channel',
        img: 'channel.png',
        accessToken: 'CHANNEL-ACCESS-SECRET',
        refresh_token: 'CHANNEL-REFRESH-SECRET',
      },
    },
    ysc_settings: {
      theme: 'dark',
      sub_groups: {
        Auth: { Tokens: { Session: {} } },
        yu: {},
      },
      layout: {
        panels: [
          { title: 'keep-panel', authSession: 'PANEL-AUTH-SECRET' },
          { title: 'keep-neighbor', visible: true },
        ],
      },
    },
    patreon: { label: 'must-not-ship' },
    yu: { label: 'must-not-ship' },
    ysc_token_google: { label: 'must-not-ship' },
    Authors: [CACHE_A],
    Tokens: [CACHE_A],
  };
  const original = structuredClone(backup);

  const { shipped, withheld } = bg.buildShippableBackup(backup);

  assert.deepEqual(shipped.ysc_collection, backup.ysc_collection);
  assert.deepEqual(shipped.ysc_meta, {
    Authors: { img: 'authors.png', position: 1 },
    Tokens: { img: 'tokens.png', position: 2 },
  });
  assert.deepEqual(shipped.ysc_title_id, backup.ysc_title_id);
  assert.deepEqual(shipped.ysc_settings.sub_groups, {
    Auth: { Tokens: { Session: {} } },
  });
  assert.deepEqual(shipped.ysc_channel_metadata[CACHE_A], {
    title: 'Auth Session Channel',
    img: 'channel.png',
  });
  assert.deepEqual(shipped.ysc_settings.layout, {
    panels: [
      { title: 'keep-panel' },
      { title: 'keep-neighbor', visible: true },
    ],
  });
  [
    'ysc_meta.Authors.accessToken',
    'ysc_meta.Tokens.sessionId',
    `ysc_channel_metadata.${CACHE_A}.accessToken`,
    `ysc_channel_metadata.${CACHE_A}.refresh_token`,
    'ysc_settings.layout.panels.0.authSession',
    'ysc_settings.sub_groups.yu',
    'patreon',
    'yu',
    'ysc_token_google',
  ].forEach((path) => assert.ok(withheld.includes(path), `${path} was not withheld`));
  assert.deepEqual(backup, original, 'the path-aware raw fixture was mutated');
});

await test('literal dotted keys cannot spoof dynamic sanitizer paths', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const backup = dottedKeySpoofBackup();
  const originalText = JSON.stringify(backup);
  const fetchStub = makeFetch({ backup });
  const bg = loadBackground(chromeStub, fetchStub);

  const { shipped, withheld } = bg.buildShippableBackup(backup);
  assert.deepEqual(shipped.ysc_settings['sub_groups.fake'], {
    safeNeighbor: { label: 'keep-settings-neighbor' },
  });
  assert.deepEqual(shipped.ysc_settings.sub_groups, {
    'Auth.Parent': { 'Tokens.Child': {} },
  });
  assert.deepEqual(shipped.ysc_meta, {
    'Auth.Parent': { img: 'auth-parent.png', position: 0 },
    'Tokens.Child': { img: 'tokens-child.png', position: 1 },
  });
  assert.deepEqual(shipped.transportFixture, {
    'ysc_meta.fake': { safeNeighbor: 'keep-meta-neighbor' },
    'ysc_channel_metadata.fake': { safeNeighbor: 'keep-channel-neighbor' },
  });
  assert.ok(withheld.length >= 6, 'the dotted-key omissions were not recorded');
  assert.ok(withheld.some((path) => path.endsWith('.accessToken')),
    'accessToken omission was not recorded');
  assert.ok(withheld.some((path) => path.endsWith('.refresh_token')),
    'refresh_token omission was not recorded');
  assert.ok(withheld.some((path) => path.endsWith('.sessionSecret')),
    'sessionSecret omission was not recorded');
  assert.equal(JSON.stringify(backup), originalText, 'direct sanitization mutated the raw fixture');

  const preview = await bg.previewFromPocketTube();
  assert.ok(preview.stats.withheld.length >= 6,
    'preview stats did not record the dotted-key omissions');
  assert.equal(JSON.stringify(backup), originalText, 'preview mutated the raw fixture');
  await bg.commitPreparedImport(preview.token, 'replace');

  const posted = fetchStub.calls.find((call) =>
    call.url.endsWith('/api/categories/import/'));
  assert.ok(posted, 'the import was never POSTed');
  const payloadText = await posted.init.body.get('file').text();
  [
    'REAL-META-ACCESS-SECRET',
    'DOTTED-SETTINGS-ACCESS-SECRET',
    'DOTTED-SETTINGS-REFRESH-SECRET',
    'DOTTED-SETTINGS-SESSION-SECRET',
    'DOTTED-META-ACCESS-SECRET',
    'DOTTED-CHANNEL-REFRESH-SECRET',
  ].forEach((secret) => assert.ok(!payloadText.includes(secret), `${secret} was POSTed`));

  const payload = JSON.parse(payloadText);
  const payloadKeys = deepKeys(payload);
  ['accessToken', 'refresh_token', 'sessionSecret'].forEach((key) => {
    assert.ok(!payloadKeys.has(key), `key "${key}" survives in the multipart payload`);
  });
  assert.deepEqual(payload.ysc_settings['sub_groups.fake'], {
    safeNeighbor: { label: 'keep-settings-neighbor' },
  });
  assert.deepEqual(payload.ysc_settings.sub_groups, {
    'Auth.Parent': { 'Tokens.Child': {} },
  });
  assert.deepEqual(payload.transportFixture, {
    'ysc_meta.fake': { safeNeighbor: 'keep-meta-neighbor' },
    'ysc_channel_metadata.fake': { safeNeighbor: 'keep-channel-neighbor' },
  });
  assert.deepEqual(payload['Auth.Parent'], [CACHE_A]);
  assert.deepEqual(payload['Tokens.Child'], [CACHE_A]);
  assert.equal(payload.ysc_settings.theme, 'safe-theme');
  assert.equal(JSON.stringify(backup), originalText, 'commit mutated the raw fixture');
});

await test('prototype-sensitive untrusted keys remain own data properties on sanitized objects', async () => {
  const bg = loadBackground(makeChrome(), makeFetch());
  const backup = prototypeSensitiveBackup();
  const originalText = JSON.stringify(backup);

  const { shipped, withheld } = bg.buildShippableBackup(backup);

  assert.equal(Object.getPrototypeOf(shipped), Object.prototype);
  assert.ok(Object.hasOwn(shipped, '__proto__'));
  assert.ok(Object.keys(shipped).includes('__proto__'));
  assert.deepEqual(shipped.__proto__, [CACHE_A],
    'the recognized __proto__ category did not filter only the exact malformed root');
  assert.deepEqual(shipped.constructor, [CACHE_B]);
  assert.deepEqual(shipped.prototype, [CACHE_A]);

  const assertNormalSanitizedPrototypes = (value) => {
    if (Array.isArray(value)) {
      value.forEach(assertNormalSanitizedPrototypes);
      return;
    }
    if (!value || typeof value !== 'object') return;
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    Object.keys(value).forEach((key) => assertNormalSanitizedPrototypes(value[key]));
  };
  assertNormalSanitizedPrototypes(shipped);
  ['ysc_collection', 'ysc_meta'].forEach((mapName) => {
    assert.ok(Object.hasOwn(shipped[mapName], '__proto__'), `${mapName} lost __proto__`);
    assert.ok(Object.keys(shipped[mapName]).includes('__proto__'));
  });
  assert.ok(Object.hasOwn(shipped.ysc_settings.sub_groups, '__proto__'));
  assert.ok(Object.hasOwn(shipped.ysc_settings.layout, '__proto__'));
  assert.deepEqual(shipped.ysc_settings.layout.__proto__, { label: 'keep-proto' });
  [
    'ysc_meta.__proto__.accessToken',
    'ysc_meta.constructor.sessionId',
    'ysc_meta.prototype.refresh_token',
    'ysc_settings.layout.__proto__.accessToken',
  ].forEach((path) => assert.ok(withheld.includes(path), `${path} was not withheld`));
  assert.equal(JSON.stringify(backup), originalText, 'the raw JSON fixture was mutated');
  assert.equal(Object.getPrototypeOf(backup), Object.prototype);
  assert.ok(Object.hasOwn(backup, '__proto__'));
});

await test('registry-less category arrays filter the exact URL including chunks', async () => {
  const bg = loadBackground(makeChrome(), makeFetch());
  const backup = {
    Base: [CACHE_A, MALFORMED_YOUTUBE_ROOT],
    Base_ysm_1: [CACHE_B, MALFORMED_YOUTUBE_ROOT],
  };
  const original = structuredClone(backup);

  const { shipped } = bg.buildShippableBackup(backup);

  assert.deepEqual(shipped.Base, [CACHE_A]);
  assert.deepEqual(shipped.Base_ysm_1, [CACHE_B]);
  assert.deepEqual(backup, original, 'the registry-less raw backup was mutated');
});

await test('preview and multipart payload use the filtered registered categories', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const backup = malformedUrlBackup();
  delete backup.unrelatedArray;
  const original = structuredClone(backup);
  const fetchStub = makeFetch({ backup });
  const bg = loadBackground(chromeStub, fetchStub);

  const preview = await bg.previewFromPocketTube();
  assert.equal(preview.stats.categories, 3);
  assert.equal(preview.stats.channels, 2, 'the URL was counted as a channel');
  assert.equal(preview.stats.assignments, 3, 'the URL was counted as an assignment');
  assert.equal(preview.stats.unmatchedChannels, 0);
  assert.deepEqual(backup, original, 'preview mutated the downloaded backup');

  await bg.commitPreparedImport(preview.token, 'replace');
  const posted = fetchStub.calls.find((call) =>
    call.url.endsWith('/api/categories/import/'));
  const payloadText = await posted.init.body.get('file').text();
  assert.ok(!payloadText.includes(MALFORMED_YOUTUBE_ROOT),
    'the malformed URL survives in the POSTed payload');
  const payload = JSON.parse(payloadText);
  assert.deepEqual(payload.Tech, [CACHE_A]);
  assert.deepEqual(payload.Tech_ysm_1, [CACHE_B]);
  assert.deepEqual(payload.Authors, [CACHE_A]);
  assert.deepEqual(payload.UrlOnly, []);
});

await test('preview and commit multipart round-trip prototype-sensitive category keys', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const backup = prototypeSensitiveBackup();
  const originalText = JSON.stringify(backup);
  const fetchStub = makeFetch({ backup });
  const bg = loadBackground(chromeStub, fetchStub);

  const preview = await bg.previewFromPocketTube();
  assert.equal(preview.stats.categories, 3);
  assert.equal(preview.stats.assignments, 3);
  await bg.commitPreparedImport(preview.token, 'replace');

  const posted = fetchStub.calls.find((call) =>
    call.url.endsWith('/api/categories/import/'));
  const payloadText = await posted.init.body.get('file').text();
  [
    'META-PROTO-SECRET',
    'META-CONSTRUCTOR-SECRET',
    'META-PROTOTYPE-SECRET',
    'LAYOUT-PROTO-SECRET',
  ].forEach((secret) => assert.ok(!payloadText.includes(secret), `${secret} was POSTed`));
  const payload = JSON.parse(payloadText);
  assert.equal(Object.getPrototypeOf(payload), Object.prototype);
  assert.ok(Object.hasOwn(payload, '__proto__'));
  assert.deepEqual(payload.__proto__, [CACHE_A]);
  assert.deepEqual(payload.constructor, [CACHE_B]);
  assert.deepEqual(payload.prototype, [CACHE_A]);
  ['ysc_collection', 'ysc_meta'].forEach((mapName) => {
    assert.equal(Object.getPrototypeOf(payload[mapName]), Object.prototype);
    assert.ok(Object.hasOwn(payload[mapName], '__proto__'), `${mapName} lost __proto__`);
    assert.ok(Object.keys(payload[mapName]).includes('__proto__'));
    assert.ok(Object.hasOwn(payload[mapName], 'constructor'));
    assert.ok(Object.hasOwn(payload[mapName], 'prototype'));
  });
  assert.equal(Object.getPrototypeOf(payload.ysc_settings.sub_groups), Object.prototype);
  assert.ok(Object.hasOwn(payload.ysc_settings.sub_groups, '__proto__'));
  assert.equal(JSON.stringify(backup), originalText, 'preview or commit mutated the raw fixture');
});

await test('a payload of nothing but caches is refused', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const fetchStub = makeFetch({
    backup: {
      liveStreamsCurrent: [CACHE_LIVE],
      nvl: [{ contentType: 'video', idChannel: CACHE_A }],
      nvlo: ['2C_KGNTgc_c'],
    },
  });
  const bg = loadBackground(chromeStub, fetchStub);
  await assert.rejects(() => bg.previewFromPocketTube(), /no channel lists/);
});

// --- background: MINOR-6 -----------------------------------------------------


await test('a null confirmToken is rejected instead of previewing', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const fetchStub = makeFetch();
  loadBackground(chromeStub, fetchStub);

  const response = await new Promise((resolve) => {
    chromeStub._listeners.message(
      { type: 'SYNC_POCKETTUBE', confirmToken: null, requestId: 'r1' },
      { id: 'popup' },
      resolve
    );
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /No preview token/);
  assert.equal(fetchStub.calls.length, 0, 'a rejected confirmation still hit the network');
});

await test('an empty confirmToken is rejected', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const bg = loadBackground(chromeStub, makeFetch());
  await assert.rejects(() => bg.commitPreparedImport(''), /No preview token/);
});

await test('a preview token is one-shot', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const bg = loadBackground(chromeStub, makeFetch());
  const preview = await bg.previewFromPocketTube();
  await bg.commitPreparedImport(preview.token);
  await assert.rejects(() => bg.commitPreparedImport(preview.token), /no longer available/);
});

// --- background: MINOR-8 -----------------------------------------------------

await test('an oversized declared body is refused before parsing', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const fetchStub = makeFetch({
    listHeaders: { 'content-type': 'application/json', 'content-length': `${1024 ** 3}` },
  });
  const bg = loadBackground(chromeStub, fetchStub);
  await assert.rejects(() => bg.previewFromPocketTube(), /more than \d+ MB/);
});

await test('a streamed body over the cap is refused', async () => {
  const chromeStub = makeChrome();
  const bg = loadBackground(chromeStub, makeFetch());
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(64));
      controller.enqueue(new Uint8Array(64));
      controller.close();
    },
  });
  await assert.rejects(
    () => bg.readCappedText(new Response(stream), 100, 'test'),
    /more than/
  );
});

// --- background: cookie sender gate (MAJOR-5, worker side) -------------------

function askForCookies(bg, sender, appOrigin = sender.origin) {
  return new Promise((resolve) => {
    bg.handleGetYoutubeCookies({ appOrigin }, sender, resolve);
  });
}

await test('cookies are served only to the exact configured sender origin', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN });
  const bg = loadBackground(chromeStub, makeFetch());

  const allowed = await askForCookies(bg, { origin: APP_ORIGIN });
  assert.ok(Array.isArray(allowed.cookies), 'the configured origin was refused');

  const denied = await askForCookies(bg, { origin: 'https://other.example.com' });
  assert.ok(!denied.cookies, 'cookies leaked to another valid HTTPS origin');
  assert.match(denied.error, /not served/);

  const forged = await askForCookies(bg, { origin: APP_ORIGIN }, 'https://other.example.com');
  assert.ok(!forged.cookies, 'a forged message.appOrigin bypassed the sender check');
  assert.match(forged.error, /not served/);
});

await test('cookies reject a wrong port despite a shared hostname permission', async () => {
  const configured = 'https://app.home.example:8443';
  const wrongPort = 'https://app.home.example:9443';
  const permission = 'https://app.home.example/*';
  const chromeStub = makeChrome({ grantedOrigins: [permission] });
  await chromeStub.storage.local.set({ appOrigin: configured });
  const bg = loadBackground(chromeStub, makeFetch());

  assert.equal(await chromeStub.permissions.contains({ origins: [permission] }), true,
    'the shared hostname permission was not granted');
  const denied = await askForCookies(bg, { origin: wrongPort }, wrongPort);
  assert.ok(!denied.cookies, 'cookies leaked to the same hostname on another port');
  assert.match(denied.error, /not served/);

  const allowed = await askForCookies(bg, { origin: configured }, configured);
  assert.ok(Array.isArray(allowed.cookies), 'the configured port was refused');
});

await test('a pending cookie request fails closed when its host grant is revoked', async () => {
  const remote = 'https://app.home.example';
  const permission = 'https://app.home.example/*';
  const chromeStub = makeChrome({ grantedOrigins: [permission] });
  await chromeStub.storage.local.set({ appOrigin: remote });
  let releaseCookies;
  chromeStub.cookies.getAll = (_query, callback) => { releaseCookies = callback; };
  const bg = loadBackground(chromeStub, makeFetch());

  const pending = askForCookies(bg, { origin: remote });
  await settle();
  await chromeStub.permissions.remove({ origins: [permission] });
  releaseCookies([
    { name: 'SAPISID', value: 'secret', domain: '.youtube.com', path: '/', secure: true },
  ]);
  const denied = await pending;
  assert.ok(!denied.cookies);
  assert.match(denied.error, /not granted/);
});

// --- background: remote app origin and dynamic bridge ------------------------

await test('HTTPS LAN IP and hostname origins normalize, remote HTTP and credentials reject', async () => {
  const bg = loadBackground(makeChrome(), makeFetch());
  assert.equal(bg.validateAndNormaliseOrigin(' https://192.168.50.5/path?q=1#x '),
    'https://192.168.50.5');
  assert.equal(bg.validateAndNormaliseOrigin('HTTPS://APP.HOME.EXAMPLE:8443/settings'),
    'https://app.home.example:8443');
  assert.equal(bg.validateAndNormaliseOrigin('http://localhost:5173/path'),
    'http://localhost:5173');
  assert.throws(() => bg.validateAndNormaliseOrigin('http://192.168.50.5'), /must use HTTPS/);
  assert.throws(() => bg.validateAndNormaliseOrigin('ftp://app.home.example'), /HTTP or HTTPS/);
  assert.throws(() => bg.validateAndNormaliseOrigin('https://user:pass@app.home.example'),
    /credentials/);
  assert.throws(() => bg.validateAndNormaliseOrigin('https://*.example.com'), /wildcards/);
  assert.throws(() => bg.validateAndNormaliseOrigin('https://*'), /wildcards/);
  assert.throws(() => bg.validateAndNormaliseOrigin('https://[2001:db8::1]'), /IPv6/);
  assert.throws(() => bg.validateAndNormaliseOrigin('not an origin'), /malformed/);
});

await test('the manifest uses optional HTTPS access and no static app content script', async () => {
  assert.deepEqual(MANIFEST.optional_host_permissions, ['https://*/*']);
  assert.ok(!MANIFEST.host_permissions.includes('https://*/*'));
  assert.ok(!MANIFEST.host_permissions.includes('<all_urls>'));
  assert.ok(!MANIFEST.host_permissions.includes('https://*.github.dev/*'));
  assert.ok(!MANIFEST.host_permissions.includes('https://*.codespaces.dev/*'));
  assert.deepEqual(MANIFEST.host_permissions, [
    'https://*.youtube.com/*',
    'https://p.yousub.info/*',
    'http://localhost/*',
    'http://127.0.0.1/*',
  ]);
  assert.ok(MANIFEST.permissions.includes('scripting'));
  assert.ok(MANIFEST.permissions.includes('webNavigation'));
  assert.ok(MANIFEST.content_scripts.every((entry) => !entry.js.includes('content.js')),
    'content.js is still statically injected');
  assert.ok(MANIFEST.content_scripts.some((entry) => entry.js.includes('pockettube-bridge.js')),
    'the YouTube PocketTube bridge was removed');
});

// --- background: remote OAuth callback relay --------------------------------

const OAUTH_CALLBACK =
  'http://localhost:8085/?state=private-state&code=private-code&scope=youtube';
const OAUTH_SUCCESS = {
  status: 'completed', authenticated: true, in_progress: false, auth_url: null, error: null,
};
const OAUTH_FAILURE = {
  status: 'failed', authenticated: false, in_progress: false, auth_url: null,
  error: 'OAuth callback state did not match.',
};

await test('terminal OAuth relay responses accept exactly the two authoritative shapes', async () => {
  const { isTerminalOAuthRelayResponse } = loadBackground(makeChrome(), makeFetch());
  const accepted = [
    ['HTTP 200 completed', 200, OAUTH_SUCCESS],
    ['HTTP 400 failed', 400, OAUTH_FAILURE],
    ['HTTP 400 failed with 1024-character error', 400, {
      ...OAUTH_FAILURE, error: 'x'.repeat(1024),
    }],
  ];

  for (const [label, status, data] of accepted) {
    assert.equal(isTerminalOAuthRelayResponse(status, data), true, label);
  }
});

await test('terminal OAuth relay responses reject every non-authoritative shape', async () => {
  const { isTerminalOAuthRelayResponse } = loadBackground(makeChrome(), makeFetch());
  const without = (data, key) => Object.fromEntries(
    Object.entries(data).filter(([candidate]) => candidate !== key)
  );
  const rejected = [
    ['completed with wrong HTTP status', 201, OAUTH_SUCCESS],
    ['failed with wrong HTTP status', 401, OAUTH_FAILURE],
    ['failure authenticated true', 400, { ...OAUTH_FAILURE, authenticated: true }],
    ['failure error empty', 400, { ...OAUTH_FAILURE, error: '' }],
    ['failure error null', 400, { ...OAUTH_FAILURE, error: null }],
    ['failure error non-string', 400, { ...OAUTH_FAILURE, error: 42 }],
    ['failure error 1025 characters', 400, { ...OAUTH_FAILURE, error: 'x'.repeat(1025) }],
    ['completed in progress', 200, { ...OAUTH_SUCCESS, in_progress: true }],
    ['failed in progress', 400, { ...OAUTH_FAILURE, in_progress: true }],
    ['completed with auth URL', 200, { ...OAUTH_SUCCESS, auth_url: 'https://example.test' }],
    ['failed with auth URL', 400, { ...OAUTH_FAILURE, auth_url: 'https://example.test' }],
    ['extra key', 200, { ...OAUTH_SUCCESS, callback_url: OAUTH_CALLBACK }],
    ['missing key', 200, without(OAUTH_SUCCESS, 'error')],
    ['array', 200, []],
    ['null', 200, null],
    ['string', 200, 'completed'],
    ['number', 200, 200],
    ['completed with error', 200, { ...OAUTH_SUCCESS, error: 'unexpected' }],
    ['failed on HTTP 200', 200, OAUTH_FAILURE],
    ['completed on HTTP 400', 400, OAUTH_SUCCESS],
  ];

  for (const [label, status, data] of rejected) {
    assert.equal(isTerminalOAuthRelayResponse(status, data), false, label);
  }
});

function relayFetch(response, options = {}) {
  const calls = [];
  let release;
  const gate = options.pending ? new Promise((resolve) => { release = resolve; }) : null;
  const fetchStub = async (url, init) => {
    calls.push({ url, init });
    if (options.waitForAbort) {
      return new Promise((resolve, reject) => {
        const rejectAborted = () => reject(new DOMException('timed out', 'AbortError'));
        if (init.signal.aborted) rejectAborted();
        else init.signal.addEventListener('abort', rejectAborted, { once: true });
      });
    }
    if (gate) await gate;
    if (options.error) throw new Error(options.error);
    return typeof response === 'function' ? response() : response;
  };
  fetchStub.calls = calls;
  fetchStub.release = release;
  return fetchStub;
}

async function remoteRelay(response, options = {}) {
  const origin = options.origin || 'https://app.home.example:8443';
  const parsed = new URL(origin);
  const permission = `${parsed.protocol}//${parsed.hostname}/*`;
  const chromeStub = makeChrome({
    grantedOrigins: [permission],
    tabsOptions: options.tabsOptions,
  });
  await chromeStub.storage.local.set({ appOrigin: origin });
  const fetchStub = options.fetchStub || relayFetch(response);
  const bg = loadBackground(chromeStub, fetchStub);
  await settle();
  return { bg, chromeStub, fetchStub, origin, permission };
}

await test('manifest and worker are 2.5 with the minimal navigation permission', async () => {
  const { bg, chromeStub } = await remoteRelay(jsonResponse(OAUTH_SUCCESS));
  assert.equal(MANIFEST.version, '2.5');
  assert.equal(bg.WORKER_BUILD, MANIFEST.version);
  assert.equal(MANIFEST.permissions.filter((permission) => permission === 'webNavigation').length, 1);
  assert.equal(typeof chromeStub._listeners.beforeNavigate, 'function',
    'the callback listener was not installed at worker load');
});

await test('remote OAuth success relays only the exact callback and replaces the same tab', async () => {
  const { chromeStub, fetchStub, origin } = await remoteRelay(jsonResponse(OAUTH_SUCCESS));
  await chromeStub._listeners.beforeNavigate({ tabId: 41, frameId: 0, url: OAUTH_CALLBACK });

  assert.equal(fetchStub.calls.length, 1);
  const call = fetchStub.calls[0];
  assert.equal(call.url, `${origin}/api/auth/oauth/callback/`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.deepEqual(call.init.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(call.init.body), { callback_url: OAUTH_CALLBACK });
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual(chromeStub.tabs._state.updated,
    [{ id: 41, changes: { url: `${origin}/` } }]);
});

await test('a valid OAuth denial response still clears the callback tab safely', async () => {
  const callback = 'http://localhost:8085/?state=private-state&error=access_denied';
  const { chromeStub, fetchStub, origin } = await remoteRelay(
    jsonResponse(OAUTH_FAILURE, { status: 400 })
  );
  await chromeStub._listeners.beforeNavigate({ tabId: 42, frameId: 0, url: callback });
  assert.deepEqual(JSON.parse(fetchStub.calls[0].init.body), { callback_url: callback });
  assert.deepEqual(chromeStub.tabs._state.updated,
    [{ id: 42, changes: { url: `${origin}/` } }]);
});

await test('an update failure closes the callback tab before relaying', async () => {
  const { chromeStub, fetchStub, origin } = await remoteRelay(jsonResponse(OAUTH_SUCCESS), {
    tabsOptions: {
      updateThrows: true,
      updateError: 'update failed private-code private-state',
    },
  });
  const beforeStorage = {
    local: await chromeStub.storage.local.get(null),
    session: await chromeStub.storage.session.get(null),
  };
  let surfacedError = null;
  const captured = await captureConsole(async () => {
    try {
      await chromeStub._listeners.beforeNavigate({
        tabId: 44, frameId: 0, url: OAUTH_CALLBACK,
      });
    } catch (error) {
      surfacedError = error;
    }
  });
  const afterStorage = {
    local: await chromeStub.storage.local.get(null),
    session: await chromeStub.storage.session.get(null),
  };
  const observable = JSON.stringify({
    logs: captured.lines,
    storage: afterStorage,
    destinations: chromeStub.tabs._state.updated,
    surfacedError: surfacedError?.message || null,
  });

  assert.deepEqual(chromeStub.tabs._state.updated,
    [{ id: 44, changes: { url: `${origin}/` } }]);
  assert.deepEqual(chromeStub.tabs._state.removed, [44]);
  assert.equal(fetchStub.calls.length, 1);
  assert.deepEqual(JSON.parse(fetchStub.calls[0].init.body), { callback_url: OAUTH_CALLBACK });
  assert.deepEqual(afterStorage, beforeStorage);
  assert.equal(surfacedError, null);
  assert.ok(!observable.includes('private-code'));
  assert.ok(!observable.includes('private-state'));
});

await test('failed update and removal abort callback relay without exposing secrets', async () => {
  const { chromeStub, fetchStub } = await remoteRelay(jsonResponse(OAUTH_SUCCESS), {
    tabsOptions: {
      updateThrows: true,
      removeThrows: true,
      updateError: 'update failed private-code private-state',
      removeError: 'remove failed private-code private-state',
    },
  });
  const beforeStorage = {
    local: await chromeStub.storage.local.get(null),
    session: await chromeStub.storage.session.get(null),
  };
  let surfacedError = null;
  const captured = await captureConsole(async () => {
    try {
      await chromeStub._listeners.beforeNavigate({
        tabId: 45, frameId: 0, url: OAUTH_CALLBACK,
      });
    } catch (error) {
      surfacedError = error;
    }
  });
  const afterStorage = {
    local: await chromeStub.storage.local.get(null),
    session: await chromeStub.storage.session.get(null),
  };
  const observable = JSON.stringify({
    logs: captured.lines,
    storage: afterStorage,
    destinations: chromeStub.tabs._state.updated,
    surfacedError: surfacedError?.message || null,
  });

  assert.equal(fetchStub.calls.length, 0);
  assert.deepEqual(chromeStub.tabs._state.removed, [45]);
  assert.deepEqual(afterStorage, beforeStorage);
  assert.equal(surfacedError, null);
  assert.ok(!observable.includes('private-code'));
  assert.ok(!observable.includes('private-state'));
});

await test('local configured origins leave OAuth callbacks to the backend listener', async () => {
  for (const origin of ['http://localhost:8001', 'http://127.0.0.1:8001']) {
    const chromeStub = makeChrome();
    await chromeStub.storage.local.set({ appOrigin: origin });
    const fetchStub = relayFetch(jsonResponse(OAUTH_SUCCESS));
    loadBackground(chromeStub, fetchStub);
    await chromeStub._listeners.beforeNavigate({ tabId: 43, frameId: 0, url: OAUTH_CALLBACK });
    assert.equal(fetchStub.calls.length, 0);
    assert.deepEqual(chromeStub.tabs._state.updated, []);
  }
});

await test('non-exact OAuth callback locations and subframes are ignored', async () => {
  const { chromeStub, fetchStub } = await remoteRelay(jsonResponse(OAUTH_SUCCESS));
  const ignored = [
    'https://localhost:8085/?state=s&code=c',
    'http://example.com:8085/?state=s&code=c',
    'http://127.0.0.1:8085/?state=s&code=c',
    'http://localhost:8086/?state=s&code=c',
    'http://localhost:8085/callback?state=s&code=c',
    'http://localhost:8085/?state=s&code=c#fragment',
    'http://user@localhost:8085/?state=s&code=c',
  ];
  for (const [index, url] of ignored.entries()) {
    await chromeStub._listeners.beforeNavigate({ tabId: 50 + index, frameId: 0, url });
  }
  await chromeStub._listeners.beforeNavigate({ tabId: 60, frameId: 1, url: OAUTH_CALLBACK });
  assert.equal(fetchStub.calls.length, 0);
});

await test('malformed, ambiguous, and oversized OAuth callbacks are ignored', async () => {
  const { chromeStub, fetchStub } = await remoteRelay(jsonResponse(OAUTH_SUCCESS));
  const ignored = [
    'not a url',
    'http://localhost:8085/?code=c',
    'http://localhost:8085/?state=s',
    'http://localhost:8085/?state=&code=c',
    'http://localhost:8085/?state=s&code=',
    'http://localhost:8085/?state=s&error=',
    'http://localhost:8085/?state=s&state=t&code=c',
    'http://localhost:8085/?state=s&code=c&code=d',
    'http://localhost:8085/?state=s&error=x&error=y',
    'http://localhost:8085/?state=s&code=c&error=x',
    `http://localhost:8085/?state=s&code=c&padding=${'x'.repeat(8192)}`,
  ];
  for (const [index, url] of ignored.entries()) {
    await chromeStub._listeners.beforeNavigate({ tabId: 70 + index, frameId: 0, url });
  }
  assert.equal(fetchStub.calls.length, 0);
});

await test('OAuth callback query length 4096 is accepted and 4097 is ignored', async () => {
  const callbackAtLength = (length) => {
    const prefix = 'state=s&code=c&padding=';
    assert.ok(length >= prefix.length);
    const query = prefix + 'x'.repeat(length - prefix.length);
    assert.equal(query.length, length);
    return `http://localhost:8085/?${query}`;
  };
  const { chromeStub, fetchStub } = await remoteRelay(jsonResponse(OAUTH_SUCCESS));
  await chromeStub._listeners.beforeNavigate({
    tabId: 88, frameId: 0, url: callbackAtLength(4096),
  });
  await chromeStub._listeners.beforeNavigate({
    tabId: 89, frameId: 0, url: callbackAtLength(4097),
  });

  assert.equal(fetchStub.calls.length, 1);
  assert.deepEqual(chromeStub.tabs._state.updated,
    [{ id: 88, changes: { url: 'https://app.home.example:8443/' } }]);
});

await test('concurrent repeated navigation events relay once per tab', async () => {
  const fetchStub = relayFetch(jsonResponse(OAUTH_SUCCESS), { pending: true });
  const { chromeStub } = await remoteRelay(jsonResponse(OAUTH_SUCCESS), { fetchStub });
  const first = chromeStub._listeners.beforeNavigate({ tabId: 90, frameId: 0, url: OAUTH_CALLBACK });
  const duplicate = chromeStub._listeners.beforeNavigate({
    tabId: 90, frameId: 0, url: OAUTH_CALLBACK,
  });
  await settle();
  assert.equal(duplicate, undefined);
  assert.equal(fetchStub.calls.length, 1);
  fetchStub.release();
  await first;
  assert.equal(chromeStub.tabs._state.updated.length, 1);
});

await test('a completed relay releases its per-tab deduplication entry', async () => {
  const { chromeStub, fetchStub } = await remoteRelay(() => jsonResponse(OAUTH_SUCCESS));
  await chromeStub._listeners.beforeNavigate({ tabId: 91, frameId: 0, url: OAUTH_CALLBACK });
  await chromeStub._listeners.beforeNavigate({ tabId: 91, frameId: 0, url: OAUTH_CALLBACK });
  assert.equal(fetchStub.calls.length, 2);
  assert.equal(chromeStub.tabs._state.updated.length, 2);
});

await test('network, redirect, read, size, and malformed relay failures still scrub once', async () => {
  const unreadableResponse = {
    status: 200,
    headers: new Headers(),
    body: null,
    text: async () => { throw new Error('response read failed private-code'); },
  };
  const cases = [
    ['network', relayFetch(null, { error: 'network failed private-state' })],
    ['redirect', relayFetch(null, { error: 'redirect blocked private-code' })],
    ['read', relayFetch(unreadableResponse)],
    ['oversized', relayFetch(jsonResponse('x'.repeat(17 * 1024)))],
    ['malformed shape', relayFetch(jsonResponse({ status: 'completed', authenticated: false }))],
    ['extra response data', relayFetch(jsonResponse({
      ...OAUTH_SUCCESS, callback_url: OAUTH_CALLBACK,
    }))],
  ];
  for (const [index, [label, fetchStub]] of cases.entries()) {
    const { chromeStub } = await remoteRelay(jsonResponse(OAUTH_SUCCESS), { fetchStub });
    await chromeStub._listeners.beforeNavigate({ tabId: 100 + index, frameId: 0, url: OAUTH_CALLBACK });
    assert.deepEqual(chromeStub.tabs._state.updated, [{
      id: 100 + index, changes: { url: 'https://app.home.example:8443/' },
    }], `${label} did not scrub exactly once`);
  }
});

await test('OAuth relay timeout scrubs once without claiming authentication success', async () => {
  const fetchStub = relayFetch(null, { waitForAbort: true });
  const chromeStub = makeChrome({ grantedOrigins: ['https://app.home.example/*'] });
  await chromeStub.storage.local.set({ appOrigin: 'https://app.home.example' });
  const timers = {
    setTimeout: (callback, delay) => {
      if (delay === 15000) queueMicrotask(callback);
      return 1;
    },
    clearTimeout: () => {},
  };
  loadBackground(chromeStub, fetchStub, timers);
  await settle();
  const relay = chromeStub._listeners.beforeNavigate({
    tabId: 110, frameId: 0, url: OAUTH_CALLBACK,
  });
  await relay;

  assert.deepEqual(chromeStub.tabs._state.updated,
    [{ id: 110, changes: { url: 'https://app.home.example/' } }]);
  assert.deepEqual(await chromeStub.storage.local.get(null), {
    appOrigin: 'https://app.home.example', importSource: 'cloud',
  });
});

await test('origin changes and permission loss before send scrub but prevent callback leakage', async () => {
  for (const mode of ['origin', 'permission', 'permission-error']) {
    const origin = 'https://app.home.example';
    const permission = 'https://app.home.example/*';
    const chromeStub = makeChrome({ grantedOrigins: [permission] });
    await chromeStub.storage.local.set({ appOrigin: origin });
    const fetchStub = relayFetch(jsonResponse(OAUTH_SUCCESS));
    loadBackground(chromeStub, fetchStub);
    await settle();
    if (mode === 'origin') {
      const realGet = chromeStub.storage.local.get;
      let reads = 0;
      chromeStub.storage.local.get = async (key) => {
        const stored = await realGet(key);
        if (key === 'appOrigin' && ++reads === 2) {
          await chromeStub.storage.local.set({ appOrigin: 'https://other.example' });
          return { appOrigin: 'https://other.example' };
        }
        return stored;
      };
    } else {
      chromeStub.permissions.contains = async () => {
        chromeStub.permissions._granted.delete(permission);
        if (mode === 'permission-error') throw new Error('permission check unavailable');
        return false;
      };
    }
    await chromeStub._listeners.beforeNavigate({ tabId: 120, frameId: 0, url: OAUTH_CALLBACK });
    assert.equal(fetchStub.calls.length, 0, `${mode} change leaked the callback`);
    assert.equal(chromeStub.tabs._state.updated.length, 1, `${mode} did not scrub once`);
    assert.ok(!chromeStub.tabs._state.updated[0].changes.url.includes('private-'));
  }
});

await test('an unavailable configured origin uses the deterministic scrub fallback', async () => {
  const origin = 'https://app.home.example';
  const chromeStub = makeChrome({ grantedOrigins: [`${origin}/*`] });
  await chromeStub.storage.local.set({ appOrigin: origin });
  const fetchStub = relayFetch(jsonResponse(OAUTH_SUCCESS));
  loadBackground(chromeStub, fetchStub);
  await settle();

  const realGet = chromeStub.storage.local.get;
  let reads = 0;
  chromeStub.storage.local.get = async (key) => {
    if (key === 'appOrigin' && ++reads > 1) throw new Error('storage unavailable');
    return realGet(key);
  };
  await chromeStub._listeners.beforeNavigate({ tabId: 121, frameId: 0, url: OAUTH_CALLBACK });

  assert.equal(fetchStub.calls.length, 0);
  assert.deepEqual(chromeStub.tabs._state.updated,
    [{ id: 121, changes: { url: 'about:blank' } }]);
});

await test('relay secrets never reach tab updates, logs, storage, or badges', async () => {
  for (const fetchStub of [
    relayFetch(jsonResponse(OAUTH_SUCCESS)),
    relayFetch(null, { error: 'network private-code private-state' }),
  ]) {
    const { chromeStub } = await remoteRelay(jsonResponse(OAUTH_SUCCESS), { fetchStub });
    const badgeCalls = [];
    chromeStub.action.setBadgeText = (value) => badgeCalls.push(value);
    const beforeStorage = {
      local: await chromeStub.storage.local.get(null),
      session: await chromeStub.storage.session.get(null),
    };
    const captured = await captureConsole(() => chromeStub._listeners.beforeNavigate({
      tabId: 130, frameId: 0, url: OAUTH_CALLBACK,
    }));
    const afterStorage = {
      local: await chromeStub.storage.local.get(null),
      session: await chromeStub.storage.session.get(null),
    };
    const serialized = JSON.stringify({
      logs: captured.lines,
      storage: afterStorage,
      destinations: chromeStub.tabs._state.updated,
      badges: badgeCalls,
    });
    assert.deepEqual(afterStorage, beforeStorage);
    assert.ok(!serialized.includes('private-code'));
    assert.ok(!serialized.includes('private-state'));
    assert.deepEqual(badgeCalls, []);
    assert.equal(chromeStub.tabs._state.updated.length, 1);
  }
});

await test('remote configuration updates one dynamic registration without duplicates', async () => {
  const remote = 'https://192.168.50.5';
  const chromeStub = makeChrome({ grantedOrigins: ['https://192.168.50.5/*'] });
  const bg = loadBackground(chromeStub, makeFetch());
  await settle();

  const result = await bg.configureAppOrigin(`${remote}/settings?from=popup`);
  assert.equal(result.origin, remote);
  assert.equal(await chromeStub.storage.local.get('appOrigin').then((s) => s.appOrigin), remote);
  assert.equal(chromeStub.scripting._registrations.size, 1);
  assert.deepEqual(chromeStub.scripting._registrations.get('app-bridge').matches,
    ['https://192.168.50.5/*']);

  await bg.ensureAppBridgeRegistration(remote);
  assert.equal(chromeStub.scripting._registrations.size, 1,
    'restoring the same origin duplicated the registration');
});

await test('a saved remote optional grant restores its bridge on worker startup', async () => {
  const remote = 'https://app.home.example:8443';
  const chromeStub = makeChrome({ grantedOrigins: ['https://app.home.example/*'] });
  await chromeStub.storage.local.set({ appOrigin: remote });
  loadBackground(chromeStub, makeFetch());
  await settle();

  assert.deepEqual(chromeStub.scripting._registrations.get('app-bridge').matches,
    ['https://app.home.example/*']);
  chromeStub._listeners.startup();
  await settle();
  assert.equal(chromeStub.scripting._registrations.size, 1);
  assert.deepEqual(chromeStub.scripting._registrations.get('app-bridge').matches,
    ['https://app.home.example/*']);
});

await test('a failed dynamic setup keeps the previous origin and registration working', async () => {
  const chromeStub = makeChrome({ grantedOrigins: ['https://new.example/*'] });
  const bg = loadBackground(chromeStub, makeFetch());
  await settle();
  chromeStub.scripting.updateContentScripts = async () => { throw new Error('registration failed'); };

  await assert.rejects(() => bg.configureAppOrigin('https://new.example'), /registration failed/);
  assert.deepEqual(await chromeStub.storage.local.get('appOrigin'), {},
    'the failed setup overwrote the previous default');
  assert.deepEqual(chromeStub.scripting._registrations.get('app-bridge').matches,
    ['http://127.0.0.1/*']);
  assert.equal(await chromeStub.permissions.contains({ origins: ['https://new.example/*'] }),
    true, 'the worker removed permission owned by the popup transaction');
  assert.deepEqual(chromeStub.permissions._removed, []);
});

await test('a storage failure rolls the dynamic registration back to the previous origin', async () => {
  const chromeStub = makeChrome({ grantedOrigins: ['https://new.example/*'] });
  const bg = loadBackground(chromeStub, makeFetch());
  await settle();
  const realSet = chromeStub.storage.local.set;
  chromeStub.storage.local.set = async (value) => {
    if (Object.prototype.hasOwnProperty.call(value, 'appOrigin')) {
      throw new Error('storage unavailable');
    }
    return realSet(value);
  };

  await assert.rejects(() => bg.configureAppOrigin('https://new.example'), /storage unavailable/);
  assert.deepEqual(chromeStub.scripting._registrations.get('app-bridge').matches,
    ['http://127.0.0.1/*']);
  assert.deepEqual(await chromeStub.storage.local.get('appOrigin'), {});
  assert.equal(await chromeStub.permissions.contains({ origins: ['https://new.example/*'] }),
    true, 'the worker removed permission owned by the popup transaction');
  assert.deepEqual(chromeStub.permissions._removed, []);
});

await test('changing remote hosts removes the obsolete optional host grant', async () => {
  const chromeStub = makeChrome({
    grantedOrigins: ['https://old.example/*', 'https://new.example/*'],
  });
  await chromeStub.storage.local.set({ appOrigin: 'https://old.example:8443' });
  const bg = loadBackground(chromeStub, makeFetch());
  await settle();

  await bg.configureAppOrigin('https://new.example:9443');
  assert.deepEqual(chromeStub.permissions._removed,
    [{ origins: ['https://old.example/*'] }]);
  assert.equal(await chromeStub.permissions.contains({ origins: ['https://old.example/*'] }), false);
  assert.equal(await chromeStub.permissions.contains({ origins: ['https://new.example/*'] }), true);
});

await test('concurrent configurations commit FIFO and leave the latest accepted origin aligned', async () => {
  const chromeStub = makeChrome({
    grantedOrigins: ['https://first.example/*', 'https://second.example/*'],
  });
  const bg = loadBackground(chromeStub, makeFetch());
  await settle();

  const realUpdate = chromeStub.scripting.updateContentScripts.bind(chromeStub.scripting);
  let releaseFirst;
  let markFirstEntered;
  const firstEntered = new Promise((resolve) => { markFirstEntered = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let updateCount = 0;
  chromeStub.scripting.updateContentScripts = async (scripts) => {
    updateCount += 1;
    if (updateCount === 1) {
      markFirstEntered();
      await firstGate;
    }
    return realUpdate(scripts);
  };

  const first = bg.configureAppOrigin('https://first.example');
  await firstEntered;
  const second = bg.configureAppOrigin('https://second.example');
  releaseFirst();
  assert.equal((await first).origin, 'https://first.example');
  assert.equal((await second).origin, 'https://second.example');

  assert.equal(await chromeStub.storage.local.get('appOrigin').then((s) => s.appOrigin),
    'https://second.example');
  assert.deepEqual(chromeStub.scripting._registrations.get('app-bridge').matches,
    ['https://second.example/*']);
  assert.equal(await chromeStub.permissions.contains({ origins: ['https://first.example/*'] }),
    false, 'the superseded optional permission survived cleanup');
});

await test('permission cleanup false is surfaced without rolling back the new origin', async () => {
  const chromeStub = makeChrome({
    grantedOrigins: ['https://old.example/*', 'https://new.example/*'],
    permissionRemoveResult: false,
  });
  await chromeStub.storage.local.set({ appOrigin: 'https://old.example' });
  const bg = loadBackground(chromeStub, makeFetch());
  await settle();

  const captured = await captureConsole(() => bg.configureAppOrigin('https://new.example'));
  assert.match(captured.value.cleanupWarning, /could not be removed/);
  assert.ok(captured.lines.some((line) => line.includes('cleanup failed')));
  assert.equal(await chromeStub.storage.local.get('appOrigin').then((s) => s.appOrigin),
    'https://new.example');
  assert.deepEqual(chromeStub.scripting._registrations.get('app-bridge').matches,
    ['https://new.example/*']);
  assert.equal(await chromeStub.permissions.contains({ origins: ['https://old.example/*'] }), true);
});

await test('PocketTube preview and import use a granted remote configured origin', async () => {
  const remote = 'https://app.home.example:8443';
  const chromeStub = makeChrome({ grantedOrigins: ['https://app.home.example/*'] });
  await chromeStub.storage.local.set({
    appOrigin: remote,
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const fetchStub = makeFetch();
  const bg = loadBackground(chromeStub, fetchStub);
  const preview = await bg.previewFromPocketTube();
  await bg.commitPreparedImport(preview.token);

  assert.ok(fetchStub.calls.some((call) => call.url === `${remote}/api/categories/`));
  assert.ok(fetchStub.calls.some((call) => call.url === `${remote}/api/categories/import/`));
});

await test('configured remote cookies fail closed when Chrome host access is absent', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({ appOrigin: 'https://app.home.example' });
  const bg = loadBackground(chromeStub, makeFetch());
  const denied = await askForCookies(bg, { origin: 'https://app.home.example' });
  assert.ok(!denied.cookies);
  assert.match(denied.error, /not granted/);
});

// --- background: the live source ---------------------------------------------

await test('the default import source is live', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.remove('importSource');
  const bg = loadBackground(chromeStub, makeFetch());
  assert.equal(await bg.resolveImportSource(), 'live');
  assert.equal(await bg.resolveImportSource('cloud'), 'cloud');
  assert.equal(await bg.resolveImportSource('LIVE'), 'live');
  await assert.rejects(() => bg.resolveImportSource('drive'), /Unknown import source/);
});

await test('a live reply becomes the right categories, channels and hierarchy', async () => {
  const chromeStub = await liveChrome({ ok: true, raw: sampleLiveReply() });
  const fetchStub = makeFetch();
  const bg = loadBackground(chromeStub, fetchStub);

  const preview = await bg.previewFromPocketTube();
  assert.equal(preview.source, 'live');
  assert.equal(preview.stats.source, 'live');
  assert.deepEqual(preview.backups, [], 'a live preview offered a backup list');

  // Construction + Concrete + Tiny House (empty, but in the hierarchy) + Authors.
  assert.equal(preview.stats.categories, 4);
  assert.equal(preview.stats.channels, 3);
  assert.equal(preview.stats.assignments, 3);
  assert.equal(preview.stats.unmatchedChannels, 0);
  assert.equal(preview.committable, true);

  await bg.commitPreparedImport(preview.token, 'replace');
  const posted = fetchStub.calls.find((c) => c.url.endsWith('/api/categories/import/'));
  const payload = JSON.parse(await posted.init.body.get('file').text());

  assert.deepEqual(payload.Construction, [LIVE_A]);
  assert.deepEqual(payload.Concrete, [LIVE_B]);
  assert.deepEqual(payload['Tiny House'], [], 'an empty hierarchy member was dropped');
  assert.deepEqual(payload.Authors, [LIVE_C]);
  assert.deepEqual(payload.ysc_settings, {
    sub_groups: { Construction: { Concrete: {}, 'Tiny House': {} } },
  });

  // channelsList wins; channelList backfills; metaList is GROUP metadata and
  // must never be read as channel metadata.
  assert.deepEqual(Object.keys(payload.ysc_channel_metadata).sort(),
    [LIVE_A, LIVE_B, LIVE_C].sort());
  assert.deepEqual(payload.ysc_channel_metadata[LIVE_A],
    { title: 'Alpha', img: 'https://img.example/a.jpg' });
  assert.deepEqual(payload.ysc_channel_metadata[LIVE_B],
    { title: 'Beta', img: 'https://img.example/b.jpg' }, 'a protocol-relative img was not fixed');
  assert.deepEqual(payload.ysc_channel_metadata[LIVE_C],
    { title: 'Gamma', img: 'https://img.example/c.jpg' }, 'the channelList fallback did not apply');

  // subscriberCount only ships where sanitiseSubsCount accepts it.
  assert.deepEqual(payload.ysc_subs_count, {
    [LIVE_A]: { t: [], sc: '1.2M' },
    [LIVE_B]: { t: [], sc: '4200' },
  });

  assert.equal(payload.theme, undefined, 'the rest of the settings blob was forwarded');
  assert.equal(payload.metaList, undefined, 'metaList was forwarded as a category');
  assert.equal(payload.channelList, undefined, 'channelList was forwarded as a category');
  assert.equal(payload.finish, undefined, '`finish` was treated as data');

  // PocketTube's ordering, in the same field the cloud dump ships verbatim:
  // metaList first, the node's positionGroup second, nothing third.
  assert.deepEqual(payload.ysc_meta, {
    Construction: { position: 0 },
    Concrete: { position: 3 },
    'Tiny House': {},
    Authors: { position: 1 },
  });
});

await test('the live ysc_meta registers every category and never shrinks the count', async () => {
  const reply = sampleLiveReply();
  // Diverged on purpose: metaList is PocketTube's own ordering, so it has to
  // outrank the tree node's positionGroup.
  reply.metaList.Construction.position = 7;
  const bg = loadBackground(makeChrome(), makeFetch());

  const { payload, stats } = bg.live.buildLivePayload(reply);
  assert.equal(payload.ysc_meta.Construction.position, 7,
    'positionGroup overrode metaList');
  assert.equal(payload.ysc_meta.Concrete.position, 3,
    'a category missing from metaList lost its positionGroup fallback');
  assert.deepEqual(payload.ysc_meta['Tiny House'], {},
    'a category with no known position was left out of the registry');

  // ysc_meta is half the registry summariseBackup counts with; a category
  // missing from it would be silently dropped.
  const categoryKeys = Object.keys(payload).filter((key) => Array.isArray(payload[key]));
  assert.deepEqual(categoryKeys.sort(), Object.keys(payload.ysc_meta).sort(),
    'the synthesized ysc_meta does not cover every emitted category');
  assert.equal(stats.categories, categoryKeys.length,
    'ysc_meta was counted as a category');

  const withoutMeta = { ...payload };
  delete withoutMeta.ysc_meta;
  const before = bg.summariseBackup(withoutMeta, 1700000000);
  const after = bg.summariseBackup(payload, 1700000000);
  assert.equal(after.categories, 4);
  assert.equal(after.categories, before.categories,
    'adding ysc_meta changed the previewed category count');
  assert.deepEqual(after.categoryNames.sort(), before.categoryNames.sort());
  assert.equal(after.assignments, before.assignments);
});

await test('a credential-named live group stays out of the synthesized registry', async () => {
  const bg = loadBackground(makeChrome(), makeFetch());
  const { payload } = bg.live.buildLivePayload(credentialNamedLiveReply());

  assert.deepEqual(payload.patreon, [LIVE_A],
    'the deny-filter, not the transform, has to be the one withholding this');
  assert.equal(payload.ysc_meta.patreon, undefined,
    'a withheld key was registered in ysc_meta, leaking the name');
  assert.deepEqual(Object.keys(payload.ysc_meta), ['Authors']);

  const { shipped } = bg.buildShippableBackup(payload);
  assert.deepEqual(bg.summariseBackup(shipped, 1700000000).categoryNames, ['Authors']);
});

await test('a live preview never calls PocketTube\u2019s backup API', async () => {
  // No credential is stored at all: the live path must work end to end without one.
  const chromeStub = await liveChrome({ ok: true, raw: sampleLiveReply() });
  const fetchStub = makeFetch();
  const bg = loadBackground(chromeStub, fetchStub);

  const preview = await bg.previewFromPocketTube();
  assert.equal(preview.source, 'live');
  assert.equal(
    fetchStub.calls.filter((c) => c.url.includes('p.yousub.info')).length, 0,
    'the live source hit PocketTube\u2019s backup API'
  );
  // The removal forecast is a deliberate exception: it is a local GET against
  // the app itself, and the confirmation depends on it.
  assert.deepEqual(
    fetchStub.calls.map((c) => c.url), [`${APP_ORIGIN}/api/categories/`],
    'the live preview made a request other than the app-side removal forecast'
  );
});

await test('a failing live source errors out and never calls the backup API', async () => {
  const chromeStub = await liveChrome({ ok: false, error: 'PocketTube did not answer.' });
  // A credential IS stored, so a fallback would have everything it needs to run:
  // the only thing stopping it must be that there is no fallback.
  await chromeStub.storage.local.set({
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const fetchStub = makeFetch();
  const bg = loadBackground(chromeStub, fetchStub);

  const error = await bg.previewFromPocketTube().then(
    () => { throw new Error('the live failure was swallowed and a preview returned'); },
    (err) => err
  );
  assert.match(error.message, /Live read failed/);
  assert.match(error.message, /PocketTube did not answer/);
  assert.match(error.message, /cloud backup not used/);
  assert.equal(error.ptLiveFailure, true,
    'the popup has no way to offer the cloud backup as an explicit action');

  assert.equal(
    fetchStub.calls.filter((c) => c.url.includes('p.yousub.info')).length, 0,
    'a failed live run reached PocketTube\u2019s backup API'
  );
  assert.equal(
    fetchStub.calls.filter((c) => c.url.includes('/backup/')).length, 0,
    'a failed live run listed or downloaded a cloud backup'
  );
  assert.ok(
    !fetchStub.calls.some((c) => c.url.endsWith('/api/categories/import/')),
    'a failed live run still POSTed something'
  );
});

await test('a live failure with no tab is reported as such, not as a cloud failure', async () => {
  // No tab to talk to, no tab creatable, and no credential stored either.
  const chromeStub = await liveChrome(null, makeTabs({ createThrows: true }));
  const fetchStub = makeFetch();
  const bg = loadBackground(chromeStub, fetchStub);

  await assert.rejects(
    () => bg.previewFromPocketTube(),
    /Live read failed[\s\S]*No youtube.com tab could be reached/
  );
  assert.equal(fetchStub.calls.length, 0,
    'a live failure with no tab still made a network call');
});

await test('an explicit cloud source never touches a youtube.com tab', async () => {
  const tabs = liveTabs({ ok: true, raw: sampleLiveReply() });
  const chromeStub = makeChrome({ tabs });
  await chromeStub.storage.local.set({
    appOrigin: APP_ORIGIN,
    importSource: 'live',
    pocketTubeCredentials: { mode: 'patreon', accessToken: 'x' },
  });
  const bg = loadBackground(chromeStub, makeFetch());

  const preview = await bg.previewFromPocketTube(null, 'cloud');
  assert.equal(preview.source, 'cloud');
  assert.equal(tabs._state.sent.length, 0, 'the cloud source queried the page bus');
});

await test('the deny-filter still strips credential keys from a live payload', async () => {
  const chromeStub = await liveChrome({ ok: true, raw: credentialNamedLiveReply() });
  const fetchStub = makeFetch();
  const bg = loadBackground(chromeStub, fetchStub);

  const preview = await bg.previewFromPocketTube();
  assert.ok(preview.stats.withheld.includes('patreon'),
    'a group named "patreon" was not withheld');
  assert.ok(
    (preview.warnings || []).some((w) => /ysc_token_google/.test(w)),
    'a group colliding with a reserved key was not reported'
  );

  await bg.commitPreparedImport(preview.token, 'replace');
  const posted = fetchStub.calls.find((c) => c.url.endsWith('/api/categories/import/'));
  const text = await posted.init.body.get('file').text();
  ['"patreon"', 'ysc_token_google', 'PATREON-SECRET', 'PADDLE-SECRET']
    .forEach((needle) => {
      assert.ok(!text.includes(needle), `the POSTed live body still contains ${needle}`);
    });
  assert.deepEqual(JSON.parse(text).Authors, [LIVE_C], 'ordinary categories were dropped too');
});

await test('a live run opens a background tab when none is open, then closes it', async () => {
  const tabs = makeTabs({ queryResult: [], reply: () => ({ ok: true, raw: sampleLiveReply() }) });
  const chromeStub = await liveChrome(null, tabs);
  const bg = loadBackground(chromeStub, makeFetch());

  const preview = await bg.previewFromPocketTube();
  assert.equal(preview.source, 'live');
  assert.equal(tabs._state.created.length, 1);
  assert.equal(tabs._state.created[0].url, 'https://www.youtube.com/feed/channels');
  assert.deepEqual(tabs._state.removed, [tabs._state.created[0].id],
    'the background tab was left open');
});

await test('a tab opened for a live run is closed even when the run fails', async () => {
  const tabs = makeTabs({
    queryResult: [],
    reply: () => ({ ok: false, error: 'PocketTube did not answer.' }),
  });
  const chromeStub = await liveChrome(null, tabs);
  const bg = loadBackground(chromeStub, makeFetch());

  await assert.rejects(() => bg.previewFromPocketTube(), /Live read failed/);
  assert.equal(tabs._state.created.length, 1);
  assert.deepEqual(tabs._state.removed, [tabs._state.created[0].id],
    'a failed live run leaked its background tab');
});

// --- live transform: shapes it must refuse ------------------------------------

await test('an unusable settings.sub_groups is replaced by the derived hierarchy', async () => {
  const reply = sampleLiveReply();
  reply.settings.sub_groups = { Construction: 'Concrete' };
  const chromeStub = await liveChrome({ ok: true, raw: reply });
  const fetchStub = makeFetch();
  const bg = loadBackground(chromeStub, fetchStub);

  const preview = await bg.previewFromPocketTube();
  assert.ok(
    (preview.warnings || []).some((w) => /settings.sub_groups/.test(w)),
    'a bad sub_groups was accepted silently'
  );
  await bg.commitPreparedImport(preview.token, 'replace');
  const posted = fetchStub.calls.find((c) => c.url.endsWith('/api/categories/import/'));
  const payload = JSON.parse(await posted.init.body.get('file').text());
  assert.deepEqual(payload.ysc_settings.sub_groups,
    { Construction: { Concrete: {}, 'Tiny House': {} } },
    'the hierarchy was not derived from the child edges');
});

await test('a live reply without a groupTree is refused', async () => {
  const chromeStub = await liveChrome({ ok: true, raw: { channelList: {}, finish: false } });
  const bg = loadBackground(chromeStub, makeFetch());
  await assert.rejects(() => bg.previewFromPocketTube(), /no groupTree array/);
});

// --- bridge content script ----------------------------------------------------

function makeBridgeWindow(origin = 'https://www.youtube.com') {
  const posted = [];
  let listeners = [];
  const win = {
    location: { origin },
    posted,
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    removeEventListener: (type, fn) => { listeners = listeners.filter((l) => l !== fn); },
    postMessage: (data, targetOrigin) => { posted.push({ data, targetOrigin }); },
    dispatch: (event) => listeners.slice().forEach((fn) => fn(event)),
  };
  win.self = win;
  return win;
}

function bridgeChrome() {
  const listeners = {};
  return {
    _listeners: listeners,
    runtime: { onMessage: { addListener: (fn) => { listeners.message = fn; } } },
  };
}

function startBridgeCollection() {
  const win = makeBridgeWindow();
  const chromeStub = bridgeChrome();
  loadBridge(win, chromeStub);
  const done = new Promise((resolve) => {
    chromeStub._listeners.message({ type: 'PT_COLLECT_CHANNEL_DATA' }, {}, resolve);
  });
  return { win, done };
}

await test('the bridge asks only for get_channel_data, on this origin', async () => {
  const { win, done } = startBridgeCollection();
  assert.equal(win.posted.length, 1, 'the bridge posted more than the one request');
  assert.equal(win.posted[0].data.type, 'get_channel_data');
  assert.equal(win.posted[0].targetOrigin, 'https://www.youtube.com',
    'the request was broadcast instead of being aimed at this origin');
  assert.ok(win.posted[0].data.nonce, 'no staleness nonce was attached');

  win.dispatch({ source: win, timeStamp: performance.now(), data: sampleLiveReply() });
  const response = await done;
  assert.equal(response.ok, true);
  assert.equal(response.raw.groupTree.length, 2);
});

await test('a reply that predates the request is ignored', async () => {
  const { win, done } = startBridgeCollection();
  const stale = sampleLiveReply();
  stale.marker = 'stale';
  const fresh = sampleLiveReply();
  fresh.marker = 'fresh';

  // timeStamp 0 is before the request went out, whatever performance.now() said.
  win.dispatch({ source: win, timeStamp: 0, data: stale });
  win.dispatch({ source: win, timeStamp: performance.now(), data: fresh });

  const response = await done;
  assert.equal(response.ok, true);
  assert.equal(response.raw.marker, 'fresh', 'a pre-request reply was accepted');
  assert.equal(response.messages, 1, 'the stale reply was counted');
  assert.ok(
    response.ignored.some((entry) => /before the request was posted/.test(entry.reason)),
    'the stale reply was not reported as ignored'
  );
});

await test('the bridge ignores foreign senders and non-replies', async () => {
  const { win, done } = startBridgeCollection();
  const other = { location: { origin: 'https://www.youtube.com' } };
  win.dispatch({ source: other, timeStamp: performance.now(), data: sampleLiveReply() });
  win.dispatch({ source: win, timeStamp: performance.now(), data: { finish: true } });
  win.dispatch({
    source: win, timeStamp: performance.now(),
    data: { type: 'get_channel_data', nonce: win.posted[0].data.nonce },
  });
  assert.equal(win.posted.length, 1, 'the bridge answered something it should have ignored');

  win.dispatch({ source: win, timeStamp: performance.now(), data: sampleLiveReply() });
  const response = await done;
  assert.equal(response.ok, true);
  assert.equal(response.messages, 1, 'a non-reply was counted as a reply');
});

// --- content script (MAJOR-5) ------------------------------------------------

function makeWindow(origin) {
  const posted = [];
  const listeners = [];
  const win = {
    location: { origin },
    posted,
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: (data, targetOrigin) => { posted.push({ data, targetOrigin }); },
    dispatch: (event) => listeners.forEach((fn) => fn(event)),
  };
  win.self = win;
  return win;
}

function contentChrome(appOrigin = APP_ORIGIN, options = {}) {
  const local = makeStorageArea();
  local.data.set('appOrigin', appOrigin);
  return {
    storage: {
      local: options.storage || local,
    },
    runtime: {
      lastError: null,
      sendMessage: (_message, cb) => cb({
        cookies: [{ name: 'SAPISID', value: 'secret' }],
      }),
    },
  };
}

await test('the content script never broadcasts to "*"', async () => {
  const win = makeWindow('http://127.0.0.1:8001');
  loadContent(win, contentChrome());
  await settle();
  win.dispatch({
    source: win,
    origin: 'http://127.0.0.1:8001',
    data: { type: 'YT_SUBS_GET_COOKIES' },
  });
  assert.ok(win.posted.length >= 2, 'no ready + response messages were posted');
  win.posted.forEach((message) => {
    assert.equal(message.targetOrigin, 'http://127.0.0.1:8001',
      `postMessage used targetOrigin ${message.targetOrigin}`);
  });
  const response = win.posted.find((m) => m.data.type === 'YT_SUBS_COOKIES_RESPONSE');
  assert.ok(response.data.cookies, 'the allowed page was not served');
});

await test('the content script ignores a cross-origin requester', async () => {
  const win = makeWindow('http://127.0.0.1:8001');
  loadContent(win, contentChrome());
  await settle();
  win.posted.length = 0;
  win.dispatch({
    source: win,
    origin: 'https://evil.example.com',
    data: { type: 'YT_SUBS_GET_COOKIES' },
  });
  assert.equal(win.posted.length, 0, 'a cross-origin request got an answer');
});

await test('the content script stays inert on a non-configured page origin', async () => {
  const win = makeWindow('https://evil.example.com');
  loadContent(win, contentChrome());
  await settle();
  assert.equal(win.posted.length, 0, 'the ready ping was announced on a disallowed origin');
  win.dispatch({
    source: win,
    origin: 'https://evil.example.com',
    data: { type: 'YT_SUBS_GET_COOKIES' },
  });
  assert.equal(win.posted.length, 0, 'a non-configured page activated the bridge');
});

await test('a remote configured content bridge activates while another HTTPS origin stays inert', async () => {
  const configured = 'https://app.home.example:8443';
  const remote = makeWindow(configured);
  loadContent(remote, contentChrome(configured));
  await settle();
  assert.equal(remote.posted[0].data.type, 'YT_SUBS_EXTENSION_READY');
  assert.equal(remote.posted[0].targetOrigin, configured);
  remote.dispatch({
    source: remote,
    origin: configured,
    data: { type: 'YT_SUBS_GET_COOKIES' },
  });
  assert.ok(remote.posted.some((entry) => entry.data.cookies),
    'the configured remote bridge did not deliver cookies');

  const other = makeWindow('https://other.home.example:8443');
  loadContent(other, contentChrome(configured));
  await settle();
  other.dispatch({
    source: other,
    origin: other.location.origin,
    data: { type: 'YT_SUBS_GET_COOKIES' },
  });
  assert.deepEqual(other.posted, [], 'another valid HTTPS origin activated the bridge');
});

await test('the content bridge rejects another port on its configured hostname', async () => {
  const configured = 'https://app.home.example:8443';
  const wrongPortOrigin = 'https://app.home.example:9443';
  const hostPermission = 'https://app.home.example/*';
  const chromeStub = makeChrome({ grantedOrigins: [hostPermission] });
  const bg = loadBackground(chromeStub, makeFetch());
  await settle();

  assert.equal(chromeStub.permissions._granted.has(hostPermission), true,
    'the exact shared-host permission was not granted');
  await bg.configureAppOrigin(configured);
  const registrations = await chromeStub.scripting.getRegisteredContentScripts({
    ids: ['app-bridge'],
  });
  assert.equal(registrations.length, 1, 'the background did not register the app bridge');
  assert.deepEqual(registrations[0].matches, [hostPermission],
    'the dynamic match unexpectedly preserved the configured port');
  assert.deepEqual(registrations[0].js, ['content.js']);

  // Chrome's host-wide match can inject this registered script at :9443.
  const contentStub = contentChrome(configured, { storage: chromeStub.storage.local });
  const wrongPort = makeWindow(wrongPortOrigin);
  loadContent(wrongPort, contentStub);
  await settle();
  wrongPort.dispatch({
    source: wrongPort,
    origin: wrongPort.location.origin,
    data: { type: 'YT_SUBS_GET_COOKIES' },
  });
  assert.deepEqual(wrongPort.posted, [],
    'the bridge announced ready or forwarded cookies on another port');

  const allowed = makeWindow(configured);
  loadContent(allowed, contentStub);
  await settle();
  assert.equal(allowed.posted[0].data.type, 'YT_SUBS_EXTENSION_READY');
  assert.equal(allowed.posted[0].targetOrigin, configured);
  allowed.dispatch({
    source: allowed,
    origin: configured,
    data: { type: 'YT_SUBS_GET_COOKIES' },
  });
  assert.ok(allowed.posted.some((entry) => entry.data.cookies),
    'the bridge did not activate on the configured port');
});

await test('content requests are ignored until async storage initialization completes', async () => {
  let resolveStorage;
  const storage = {
    get: () => new Promise((resolve) => { resolveStorage = resolve; }),
  };
  const win = makeWindow(APP_ORIGIN);
  loadContent(win, contentChrome(APP_ORIGIN, { storage }));
  win.dispatch({
    source: win,
    origin: APP_ORIGIN,
    data: { type: 'YT_SUBS_GET_COOKIES' },
  });
  assert.deepEqual(win.posted, [], 'the bridge accepted a request before reading storage');

  resolveStorage({ appOrigin: APP_ORIGIN });
  await settle();
  assert.equal(win.posted.length, 1, 'the bridge did not announce readiness after initialization');
});

// --- popup: one click, and the two sources stay detached ----------------------

const CLOUD_PREVIEW = {
  ok: true,
  dryRun: true,
  source: 'cloud',
  origin: APP_ORIGIN,
  token: 'tok',
  committable: true,
  warnings: [],
  existing: { ok: true, categories: 1, kept: 1, removed: 0, added: 1, removedSample: [] },
  stats: {
    source: 'cloud', backupId: 1700000000, backupAt: '2023-11-14 22:13',
    categories: 2, channels: 3, assignments: 4,
  },
  backups: [
    { id: 1700000000, at: '2023-11-14 22:13' },
    { id: 1600000000, at: '2020-09-13 12:26' },
  ],
};

const LIVE_PREVIEW = {
  ok: true,
  dryRun: true,
  source: 'live',
  origin: APP_ORIGIN,
  token: 'tok',
  committable: true,
  warnings: [],
  existing: { ok: true, categories: 1, kept: 1, removed: 0, added: 1, removedSample: [] },
  stats: { source: 'live', categories: 2, channels: 3, assignments: 4 },
  backups: [],
};

const IMPORTED = {
  ok: true,
  dryRun: false,
  mode: 'replace',
  source: 'cloud',
  origin: APP_ORIGIN,
  warnings: [],
  stats: CLOUD_PREVIEW.stats,
  result: {
    mode: 'replace', created_categories: 2, created_subscriptions: 3,
    assignments_added: 4, unmatched_channels: 0,
    deleted_categories: 0, deleted_assignments: 0,
  },
};

// One open youtube.com tab, which is what lets the live source auto-preview.
const OPEN_YT_TAB = [{ id: 7, url: 'https://www.youtube.com/feed/channels' }];

// Answers a preview with `preview` and any commit with IMPORTED.
function previewThenImport(preview) {
  return (message) => (message.confirmToken ? IMPORTED : preview);
}

await test('the popup previews the cloud source as soon as it opens', async () => {
  const chromeStub = popupChrome(previewThenImport(CLOUD_PREVIEW));
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.equal(doc.activeElement, null,
    'the automatic cloud preview stole focus for its status update');
  assert.equal(doc.el('sync').focused, false,
    'the automatic cloud preview focused the primary action');
  assert.equal(chromeStub._sent.length, 1, 'the popup did not preview on open');
  assert.equal(chromeStub._sent[0].type, 'SYNC_POCKETTUBE');
  assert.equal(chromeStub._sent[0].source, 'cloud');
  assert.equal(chromeStub._sent[0].confirmToken, undefined,
    'the popup sent an import without a click');

  // Everything the user needs is already on screen — that is the first click.
  const status = doc.el('status').textContent;
  assert.match(status, /^Cloud \(2023-11-14 22:13\) · 2 categories, 3 channels, 4 assignments · 1 kept, 0 removed, 1 new$/,
    'the one-line preview summary is not what the run view shows');
  assert.equal(doc.el('backup-picker').hidden, false, 'the cloud picker was not offered');
  assert.equal(doc.el('backup-id').children.length, 2);

  // And the button already says what it would do.
  assert.match(doc.el('sync').textContent, /^Import 2 categories \(replace\)$/);
  assert.equal(doc.el('confirm').hidden, true);
});

await test('additive non-dry-run without a preview uses the exact generic import label', async () => {
  const chromeStub = popupChrome(previewThenImport(LIVE_PREVIEW), { youtubeTabs: [] });
  await chromeStub.storage.local.set({
    importSource: 'live', importMode: 'additive', dryRunOnly: false,
  });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.equal(chromeStub._sent.length, 0, 'the unarmed state unexpectedly previewed');
  assert.equal(doc.el('dry-run').checked, false);
  assert.equal(doc.el('sync').textContent, 'Import categories (additive)');
});

await test('additive non-dry-run previews use the exact count-aware import label', async () => {
  for (const [source, preview, youtubeTabs] of [
    ['cloud', CLOUD_PREVIEW, []],
    ['live', LIVE_PREVIEW, OPEN_YT_TAB],
  ]) {
    const chromeStub = popupChrome(previewThenImport(preview), { youtubeTabs });
    await chromeStub.storage.local.set({
      importSource: source, importMode: 'additive', dryRunOnly: false,
    });
    const doc = loadPopup(chromeStub);
    await settle();

    assert.equal(chromeStub._sent.length, 1, `${source} did not produce one armed preview`);
    assert.equal(doc.el('dry-run').checked, false);
    assert.equal(doc.el('sync').textContent, 'Import 2 categories (additive)');
  }
});

await test('a successful cloud preview offers the newest snapshot and current live data', async () => {
  const chromeStub = popupChrome((message) => message.source === 'live'
    ? { ...LIVE_PREVIEW, token: 'live-token' }
    : CLOUD_PREVIEW);
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.match(doc.el('backup-id').children[0].textContent,
    /\(newest cloud snapshot\)$/);
  assert.equal(doc.el('live-fallback').hidden, false);
  assert.equal(doc.el('live-fallback-use-cloud').textContent, 'Use current live data');
  assert.match(doc.el('live-fallback').querySelector('.hint').textContent,
    /scheduled snapshot.*up to a day old/i);
  assert.equal(chromeStub._sent.length, 1, 'Live was requested before the explicit click');
  assert.equal(chromeStub._sent[0].source, 'cloud');

  const sourceAlternative = doc.el('live-fallback-use-cloud');
  sourceAlternative.focus();
  await sourceAlternative.fire('click');

  assert.equal(await chromeStub.storage.local.get('importSource')
    .then((stored) => stored.importSource), 'live');
  assert.equal(chromeStub._sent.length, 2, 'the source click sent more than one preview');
  assert.equal(chromeStub._sent[1].source, 'live');
  assert.equal(chromeStub._sent[1].confirmToken, undefined,
    'the cloud token was reused instead of being disarmed');
  assert.ok(chromeStub._sent.every((message) => message.confirmToken === undefined),
    'switching to Live committed instead of previewing');
  assert.equal(doc.activeElement, doc.el('sync'),
    'the completed explicit Live preview did not return focus to the primary action');
  assert.equal(doc.el('sync').focused, true,
    'the primary action did not record focus after the explicit Live preview');
});

await test('a non-destructive preview imports on a single click', async () => {
  const chromeStub = popupChrome(previewThenImport(CLOUD_PREVIEW));
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.match(doc.el('primary-note').textContent, /Sends exactly what is previewed/,
    'the button does not say the click imports directly');

  await doc.el('sync').fire('click');

  assert.equal(chromeStub._sent.length, 2, 'the single click did not commit');
  assert.equal(chromeStub._sent[1].confirmToken, 'tok',
    'the commit did not reuse the automatic preview\u2019s one-shot token');
  assert.equal(chromeStub._sent[1].mode, 'replace', 'the mode was not sent explicitly');
  assert.equal(doc.el('confirm').hidden, true, 'a harmless import still asked to confirm');
  assert.match(doc.el('status').textContent, /^Imported \(replace\) · /);
});

// --- popup: the dry-run switch ------------------------------------------------

await test('dry run is off by default, so one click still imports', async () => {
  const chromeStub = popupChrome(previewThenImport(CLOUD_PREVIEW));
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.equal(doc.el('dry-run').checked, false, 'dry run does not default to off');
  assert.match(doc.el('sync').textContent, /^Import 2 categories \(replace\)$/,
    'the default button no longer offers the import');

  await doc.el('sync').fire('click');
  assert.equal(chromeStub._sent.length, 2, 'the unchecked single click did not commit');
  assert.equal(chromeStub._sent[1].confirmToken, 'tok');
  assert.match(doc.el('status').textContent, /^Imported \(replace\) · /);
});

await test('dry run previews and can never import', async () => {
  const chromeStub = popupChrome(previewThenImport(CLOUD_PREVIEW));
  await chromeStub.storage.local.set({ importSource: 'cloud', dryRunOnly: true });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.equal(doc.el('dry-run').checked, true, 'the stored dry-run choice was not restored');
  // The very preview that imports on one click when the box is unchecked.
  assert.equal(chromeStub._sent.length, 1, 'the popup did not auto-preview');
  assert.equal(doc.el('sync').textContent, 'Preview only',
    'the button does not say it can only preview');
  assert.match(doc.el('primary-note').textContent, /nothing is sent/i);

  await doc.el('sync').fire('click');

  assert.equal(doc.el('confirm').hidden, true, 'dry run showed the confirmation panel');
  assert.ok(chromeStub._sent.every((message) => message.confirmToken === undefined),
    'dry run sent an import request');
  assert.equal(chromeStub._sent.length, 2, 'the dry-run click did not re-preview');
  assert.equal(chromeStub._sent[1].source, 'cloud');
  assert.equal(doc.el('sync').textContent, 'Preview only');
  assert.match(doc.el('status').textContent, /^Cloud \(/);
});

await test('dry run gates a destructive preview by refusing it, not by confirming', async () => {
  const destructive = {
    ...CLOUD_PREVIEW,
    existing: {
      ok: true, categories: 5, kept: 2, removed: 3, added: 0,
      removedSample: ['Music', 'Podcasts', 'News'],
    },
  };
  const chromeStub = popupChrome(previewThenImport(destructive));
  await chromeStub.storage.local.set({ importSource: 'cloud', dryRunOnly: true });
  const doc = loadPopup(chromeStub);
  await settle();

  await doc.el('sync').fire('click');
  assert.equal(doc.el('confirm').hidden, true,
    'dry run offered the confirmation that leads to an import');
  assert.equal(doc.el('confirm-text').textContent, '');
  assert.ok(chromeStub._sent.every((message) => message.confirmToken === undefined),
    'a destructive dry run still sent the import');
});

await test('the dry-run choice persists across popup opens', async () => {
  const storage = { local: makeStorageArea(), session: makeStorageArea() };
  await storage.local.set({ importSource: 'cloud' });

  const first = popupChrome(previewThenImport(CLOUD_PREVIEW), { storage });
  const firstDoc = loadPopup(first);
  await settle();
  assert.equal(firstDoc.el('dry-run').checked, false);

  firstDoc.el('dry-run').checked = true;
  await firstDoc.el('dry-run').fire('change');
  assert.equal(await storage.local.get('dryRunOnly').then((s) => s.dryRunOnly), true,
    'the dry-run choice was not written to chrome.storage.local');
  assert.equal(firstDoc.el('sync').textContent, 'Preview only',
    'ticking the box did not disarm the button');

  // A second popup over the SAME storage area is a reopen.
  const second = popupChrome(previewThenImport(CLOUD_PREVIEW), { storage });
  const secondDoc = loadPopup(second);
  await settle();
  assert.equal(secondDoc.el('dry-run').checked, true,
    'the dry-run choice did not survive reopening the popup');
  await secondDoc.el('sync').fire('click');
  assert.ok(second._sent.every((message) => message.confirmToken === undefined),
    'a reopened popup imported despite the stored dry run');

  // And unticking it puts the one-click import back.
  secondDoc.el('dry-run').checked = false;
  await secondDoc.el('dry-run').fire('change');
  assert.equal(await storage.local.get('dryRunOnly').then((s) => s.dryRunOnly), false);
  assert.match(secondDoc.el('sync').textContent, /^Import 2 categories \(replace\)$/);
  const before = second._sent.length;
  await secondDoc.el('sync').fire('click');
  assert.equal(second._sent.length, before + 1, 'unticking did not restore the one-click import');
  assert.equal(second._sent[before].confirmToken, 'tok');
});

// --- popup: the static copy budget --------------------------------------------

await test('popup statuses are atomic polite live regions', async () => {
  const html = fs.readFileSync(path.join(extensionDir, 'popup.html'), 'utf8');
  for (const id of ['status', 'settings-status']) {
    assert.match(html,
      new RegExp(`id="${id}" role="status" aria-live="polite" aria-atomic="true"`),
      `#${id} is not an atomic polite live region`);
  }
});

await test('destructive confirmation has accessible alert-dialog markup', async () => {
  const html = fs.readFileSync(path.join(extensionDir, 'popup.html'), 'utf8');
  const confirmTag = html.match(/<[^>]+id="confirm"[^>]*>/)?.[0] || '';
  assert.match(confirmTag, /\brole="alertdialog"/,
    '#confirm is not exposed as an alert dialog');
  assert.match(confirmTag, /\baria-(?:label|labelledby)="[^"]+"/,
    '#confirm has no accessible name');
  assert.match(confirmTag, /\baria-describedby="confirm-text"/,
    '#confirm is not described by its warning text');
});

// Anything longer than this belongs in a title= tooltip or in the console.
// Comments are documentation, and the credential-extraction snippet is a
// command to paste, so neither is prose that has to fit.
const POPUP_TEXT_BUDGET = 60;

await test('no static text in popup.html is over the length budget', async () => {
  const html = fs.readFileSync(path.join(extensionDir, 'popup.html'), 'utf8');
  const offenders = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<code[\s\S]*?<\/code>/gi, ' ')
    .split(/<[^>]+>/)
    .map((chunk) => chunk.replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > POPUP_TEXT_BUDGET);

  assert.deepEqual(offenders, [],
    `static popup copy over ${POPUP_TEXT_BUDGET} characters:\n` +
    offenders.map((text) => `  ${text.length}: ${text}`).join('\n'));
});

await test('the replace warning is stated in exactly one place', async () => {
  const html = fs.readFileSync(path.join(extensionDir, 'popup.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  assert.ok(!/DELETES/.test(html),
    'popup.html repeats the replace warning outside the confirmation');

  // Where it does belong, it stays explicit.
  const chromeStub = popupChrome(previewThenImport({
    ...CLOUD_PREVIEW,
    existing: {
      ok: true, categories: 5, kept: 2, removed: 3, added: 0,
      removedSample: ['Music', 'Podcasts', 'News'],
    },
  }));
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();
  await doc.el('sync').fire('click');
  assert.match(doc.el('confirm-text').textContent,
    /REPLACE DELETES every category and every channel-to-category assignment/);
  assert.match(doc.el('confirm-text').textContent, /Cannot be undone\. Continue\?/);
});

await test('a preview that would delete categories needs a second confirmation', async () => {
  const destructive = {
    ...CLOUD_PREVIEW,
    existing: {
      ok: true, categories: 5, kept: 2, removed: 3, added: 0,
      removedSample: ['Music', 'Podcasts', 'News'],
    },
  };
  const chromeStub = popupChrome(previewThenImport(destructive));
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.match(doc.el('status').textContent, /2 kept, 3 removed, 0 new/);
  assert.match(doc.el('primary-note').textContent, /deletes 3 categories/,
    'the button does not warn that a confirmation follows');

  await doc.el('sync').fire('click');
  assert.equal(doc.el('confirm').hidden, false, 'a destructive import was not gated');
  assert.equal(chromeStub._sent.length, 1, 'the destructive import was sent unconfirmed');
  assert.equal(doc.activeElement, doc.el('confirm-send'),
    'the destructive gate did not focus its confirm action');
  assert.notEqual(doc.el('confirm-text').textContent, '',
    'the destructive warning was not populated before focus entered the gate');
  // Shortened, never softened: the confirmation still spells the deletion out.
  assert.match(doc.el('confirm-text').textContent, /REPLACE DELETES every category/);
  assert.match(doc.el('confirm-text').textContent, /Deletes 3 of 5 categories/);
  assert.match(doc.el('confirm-text').textContent, /Music, Podcasts, News/);
  assert.match(doc.el('confirm-text').textContent, /Cannot be undone/);

  await doc.el('confirm-cancel').fire('click');
  assert.equal(doc.el('confirm').hidden, true);
  assert.equal(doc.el('confirm-text').textContent, '');
  assert.equal(doc.activeElement, doc.el('sync'),
    'cancelling did not restore focus to the primary action');
  assert.equal(chromeStub._sent.length, 1, 'cancelling sent the import anyway');

  await doc.el('sync').fire('click');
  await doc.el('confirm-send').fire('click');
  assert.equal(chromeStub._sent.length, 2, 'the confirmed import never ran');
  assert.equal(chromeStub._sent[1].confirmToken, 'tok');
  assert.match(doc.el('status').textContent, /^Imported \(replace\)/);
  assert.equal(doc.activeElement, doc.el('sync'),
    'a successful confirmed import did not restore focus to the primary action');
});

await test('failed destructive commit restores focus to the primary action', async () => {
  const destructive = {
    ...CLOUD_PREVIEW,
    existing: {
      ok: true, categories: 5, kept: 2, removed: 3, added: 0,
      removedSample: ['Music', 'Podcasts', 'News'],
    },
  };
  const chromeStub = popupChrome((message) => message.confirmToken
    ? { ok: false, error: 'commit failed' }
    : destructive);
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  await doc.el('sync').fire('click');
  await doc.el('confirm-send').fire('click');

  assert.equal(doc.el('confirm').hidden, true);
  assert.equal(doc.el('confirm-text').textContent, '');
  assert.match(doc.el('status').textContent, /commit failed/);
  assert.equal(doc.activeElement, doc.el('sync'),
    'a failed confirmed import did not restore focus to the primary action');
});

await test('deferred destructive commit preserves visible Settings focus', async () => {
  const destructive = {
    ...CLOUD_PREVIEW,
    existing: {
      ok: true, categories: 5, kept: 2, removed: 3, added: 0,
      removedSample: ['Music', 'Podcasts', 'News'],
    },
  };
  const commit = deferred();
  const chromeStub = popupChrome((message) => message.confirmToken
    ? commit.promise
    : destructive);
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  await doc.el('sync').fire('click');
  assert.equal(doc.activeElement, doc.el('confirm-send'));
  const pendingCommit = doc.el('confirm-send').fire('click');
  await doc.el('open-settings').fire('click');

  assert.equal(doc.el('settings-view').hidden, false);
  assert.equal(doc.el('run-view').hidden, true);
  assert.equal(doc.activeElement, doc.el('app-origin'),
    'opening Settings during import did not focus a visible Settings control');

  commit.resolve({ ok: true, imported: 2 });
  await pendingCommit;

  assert.notEqual(doc.activeElement, doc.el('sync'),
    'commit completion moved focus to hidden #sync');
  assert.equal(doc.activeElement, doc.el('app-origin'),
    'commit completion moved focus away from the visible Settings control');
});

await test('changing import mode dismisses and rebuilds a gated confirmation', async () => {
  const destructive = {
    ...CLOUD_PREVIEW,
    existing: {
      ok: true, categories: 5, kept: 2, removed: 3, added: 0,
      removedSample: ['Music', 'Podcasts', 'News'],
    },
  };
  const chromeStub = popupChrome(previewThenImport(destructive));
  await chromeStub.storage.local.set({ importSource: 'cloud', importMode: 'additive' });
  const doc = loadPopup(chromeStub);
  await settle();

  await doc.el('sync').fire('click');
  assert.equal(doc.el('confirm').hidden, false);
  assert.match(doc.el('confirm-text').textContent, /in additive mode/);
  assert.match(doc.el('confirm-text').textContent, /ADDITIVE: nothing is deleted/);
  assert.equal(chromeStub._sent.length, 1, 'the additive gate committed early');

  await doc.el('open-settings').fire('click');
  doc.el('import-mode').focus();
  doc.el('import-mode').value = 'replace';
  await doc.el('import-mode').fire('change');
  assert.equal(doc.el('confirm').hidden, true, 'the additive confirmation survived mode change');
  assert.equal(doc.el('confirm-text').textContent, '');
  assert.equal(doc.activeElement, doc.el('import-mode'),
    'changing import mode moved focus away from the visible mode control');

  await doc.el('settings-back').fire('click');
  await doc.el('sync').fire('click');
  assert.equal(doc.el('confirm').hidden, false);
  assert.match(doc.el('confirm-text').textContent, /in replace mode/);
  assert.match(doc.el('confirm-text').textContent, /REPLACE DELETES every category/);
  assert.equal(chromeStub._sent.length, 1, 'the replacement committed before confirmation');

  await doc.el('confirm-send').fire('click');
  assert.equal(chromeStub._sent.length, 2);
  assert.equal(chromeStub._sent[1].confirmToken, 'tok');
  assert.equal(chromeStub._sent[1].mode, 'replace');
});

await test('an undeterminable removal count is gated too', async () => {
  const unknown = {
    ...CLOUD_PREVIEW,
    existing: { ok: false, error: 'could not reach the app' },
  };
  const chromeStub = popupChrome(previewThenImport(unknown));
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.match(doc.el('primary-note').textContent, /removals unknown/);
  await doc.el('sync').fire('click');
  assert.equal(doc.el('confirm').hidden, false,
    'an unknown removal count went straight through');
  assert.equal(chromeStub._sent.length, 1);
});

await test('a stale-backup warning is gated, a warning-free preview is not', async () => {
  const stale = {
    ...CLOUD_PREVIEW,
    warnings: ['Backup is 42 days old (2023-11-14 22:13).'],
  };
  const staleChrome = popupChrome(previewThenImport(stale));
  await staleChrome.storage.local.set({ importSource: 'cloud' });
  const staleDoc = loadPopup(staleChrome);
  await settle();
  await staleDoc.el('sync').fire('click');
  assert.equal(staleDoc.el('confirm').hidden, false, 'a stale backup was not gated');
  assert.equal(staleChrome._sent.length, 1);

  const quiet = {
    ...CLOUD_PREVIEW,
    warnings: [],
  };
  const quietChrome = popupChrome(previewThenImport(quiet));
  await quietChrome.storage.local.set({ importSource: 'cloud' });
  const quietDoc = loadPopup(quietChrome);
  await settle();
  await quietDoc.el('sync').fire('click');
  assert.equal(quietDoc.el('confirm').hidden, true,
    'a warning-free preview added a confirmation click');
  assert.equal(quietChrome._sent.length, 2, 'the harmless import did not go through');
});

await test('the live source does not open a youtube.com tab just to preview', async () => {
  const chromeStub = popupChrome(previewThenImport(LIVE_PREVIEW), { youtubeTabs: [] });
  await chromeStub.storage.local.set({ importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.deepEqual(chromeStub._tabQueries, [{ url: 'https://*.youtube.com/*' }],
    'the popup did not check for an open youtube.com tab');
  assert.equal(chromeStub._sent.length, 0,
    'the popup read the live source on open with no youtube.com tab');
  assert.deepEqual(chromeStub._createdTabs, [],
    'the popup opened a youtube.com tab merely because it was opened');
  assert.match(doc.el('status').textContent, /No youtube\.com tab/);
  assert.equal(doc.el('sync').textContent, 'Import categories (replace)');
  assert.doesNotMatch(doc.el('sync').textContent,
    /Preview and import|Read live data and import/);

  // The single click still does preview-then-commit in one go.
  await doc.el('sync').fire('click');
  assert.equal(chromeStub._sent.length, 2, 'the click did not preview and then import');
  assert.equal(chromeStub._sent[0].source, 'live');
  assert.equal(chromeStub._sent[0].confirmToken, undefined);
  assert.equal(chromeStub._sent[1].confirmToken, 'tok');
});

await test('the live source auto-previews when a youtube.com tab is already open', async () => {
  const chromeStub = popupChrome(previewThenImport(LIVE_PREVIEW), { youtubeTabs: OPEN_YT_TAB });
  await chromeStub.storage.local.set({ importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.equal(doc.activeElement, null,
    'the automatic Live preview stole focus for its status update');
  assert.equal(doc.el('sync').focused, false,
    'the automatic Live preview focused the primary action');
  assert.equal(chromeStub._sent.length, 1, 'the popup did not preview the open tab');
  assert.equal(chromeStub._sent[0].source, 'live');
  assert.match(doc.el('status').textContent, /^Live · 2 categories, 3 channels, 4 assignments/);
  assert.match(doc.el('sync').textContent, /^Import 2 categories \(replace\)$/);
});

await test('the popup never shows the cloud picker in a live run', async () => {
  // The preview is made to carry cloud backups: the picker must be gated on the
  // source the WORKER reports, not on the list happening to be empty.
  const liveWithBackups = { ...LIVE_PREVIEW, backups: CLOUD_PREVIEW.backups };
  const chromeStub = popupChrome(previewThenImport(liveWithBackups),
    { youtubeTabs: OPEN_YT_TAB });
  await chromeStub.storage.local.set({ importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.equal(chromeStub._sent[0].backupId, null,
    'a cloud backup id leaked into the live run');
  assert.equal(doc.el('backup-picker').hidden, true,
    'the picker appeared during a live run');
  assert.equal(doc.el('backup-id').children.length, 0,
    'the picker holds cloud backup ids during a live run');
});

await test('changing source disarms to the exact generic import label', async () => {
  const chromeStub = popupChrome(previewThenImport(CLOUD_PREVIEW));
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('import-source').value = 'live';
  await doc.el('import-source').fire('change');

  assert.equal(doc.el('sync').textContent, 'Import categories (replace)');
  assert.doesNotMatch(doc.el('sync').textContent,
    /Preview and import|Read live data and import/);
});

await test('changing the cloud backup re-previews and re-arms the button', async () => {
  const other = {
    ...CLOUD_PREVIEW,
    token: 'tok-2',
    stats: { ...CLOUD_PREVIEW.stats, backupId: 1600000000, categories: 9 },
  };
  const chromeStub = popupChrome((message) => {
    if (message.confirmToken) return IMPORTED;
    return message.backupId === '1600000000' ? other : CLOUD_PREVIEW;
  });
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('backup-id').value = '1600000000';
  await doc.el('backup-id').fire('change');

  assert.equal(chromeStub._sent.length, 2, 'changing the backup did not re-preview');
  assert.equal(chromeStub._sent[1].source, 'cloud');
  assert.equal(chromeStub._sent[1].backupId, '1600000000');
  assert.match(doc.el('sync').textContent, /^Import 9 categories \(replace\)$/);

  await doc.el('sync').fire('click');
  assert.equal(chromeStub._sent[2].confirmToken, 'tok-2',
    'the button still held the previous preview\u2019s token');
});

await test('a live failure in the popup offers cloud instead of switching to it', async () => {
  const chromeStub = popupChrome((message) => (message.source === 'cloud'
    ? CLOUD_PREVIEW
    : {
      ok: false,
      liveFailure: true,
      error: 'Live read failed; cloud backup not used. PocketTube did not answer.',
    }), { youtubeTabs: OPEN_YT_TAB });
  await chromeStub.storage.local.set({ importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.equal(doc.el('status').className, 'error');
  assert.match(doc.el('status').textContent, /Live read failed/);
  assert.equal(doc.el('backup-picker').hidden, true,
    'a live failure showed the cloud backup picker');
  assert.equal(doc.el('live-fallback').hidden, false,
    'the cloud backup was not offered as an explicit action');
  assert.equal(chromeStub._sent.length, 1,
    'the popup ran a second, unasked-for preview');
  assert.equal(await chromeStub.storage.local.get('importSource')
    .then((s) => s.importSource), 'live',
    'the popup switched the stored source on its own');

  // Only pressing the button switches — and then it is stored, so it sticks.
  await doc.el('live-fallback-use-cloud').fire('click');
  assert.equal(chromeStub._sent[1].source, 'cloud');
  assert.equal(doc.el('live-fallback').hidden, false,
    'the successful cloud preview did not offer the source alternative again');
  assert.equal(doc.el('live-fallback-use-cloud').textContent, 'Use current live data');
  assert.match(doc.el('live-fallback').querySelector('.hint').textContent,
    /scheduled snapshot.*up to a day old/i);
  assert.equal(await chromeStub.storage.local.get('importSource')
    .then((s) => s.importSource), 'cloud');
  assert.equal(doc.el('backup-picker').hidden, false,
    'the picker is missing from the run the user explicitly asked for');
  assert.equal(chromeStub._sent.length, 2, 'the cloud preview automatically requested Live');
  assert.equal(chromeStub._sent.filter((message) => message.source === 'live').length, 1,
    'a second Live request occurred without an explicit click');
});

await test('a failed explicit source-alternative preview returns focus to sync', async () => {
  const chromeStub = popupChrome((message) => (message.source === 'live'
    ? {
      ok: false,
      liveFailure: true,
      error: 'Live read failed; cloud backup not used. PocketTube did not answer.',
    }
    : CLOUD_PREVIEW));
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  const sourceAlternative = doc.el('live-fallback-use-cloud');
  sourceAlternative.focus();
  await sourceAlternative.fire('click');

  assert.equal(doc.el('status').className, 'error');
  assert.match(doc.el('status').textContent, /Live read failed/);
  assert.equal(doc.el('sync').textContent, 'Import categories (replace)');
  assert.doesNotMatch(doc.el('sync').textContent,
    /Preview and import|Read live data and import/);
  assert.equal(doc.activeElement, doc.el('sync'),
    'the failed explicit Live preview did not return focus to the primary action');
  assert.equal(doc.el('sync').focused, true,
    'the primary action did not record focus after the failed explicit Live preview');
});

await test('deferred source-alternative preview preserves visible Settings focus', async () => {
  const live = deferred();
  const chromeStub = popupChrome((message) => message.source === 'live'
    ? live.promise
    : CLOUD_PREVIEW);
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.equal(doc.el('live-fallback-use-cloud').textContent, 'Use current live data');
  const pendingPreview = doc.el('live-fallback-use-cloud').fire('click');
  await doc.el('open-settings').fire('click');
  doc.el('app-origin').focus();

  assert.equal(doc.el('settings-view').hidden, false);
  assert.equal(doc.el('run-view').hidden, true);
  assert.equal(doc.activeElement, doc.el('app-origin'),
    'opening Settings during preview did not focus a visible Settings control');

  live.resolve(LIVE_PREVIEW);
  await pendingPreview;

  assert.equal(doc.el('settings-view').hidden, false,
    'preview completion hid the Settings view');
  assert.equal(doc.el('run-view').hidden, true,
    'preview completion made the run view active');
  assert.notEqual(doc.activeElement, doc.el('sync'),
    'preview completion moved focus to hidden #sync');
  assert.equal(doc.activeElement, doc.el('app-origin'),
    'preview completion moved focus away from the visible Settings control');
});

async function assertStaleCloudCannotOvertakeLive(completeCloud) {
  const cloud = deferred();
  const live = deferred();
  const chromeStub = popupChrome((message) => {
    if (message.confirmToken) return IMPORTED;
    return message.source === 'cloud' ? cloud.promise : live.promise;
  });
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('import-source').value = 'live';
  await doc.el('import-source').fire('change');
  const liveRun = doc.el('sync').fire('click');
  await settle();
  assert.equal(chromeStub._sent.length, 2);
  assert.equal(chromeStub._sent[1].source, 'live');

  completeCloud(cloud);
  await settle();
  assert.equal(doc.el('status').textContent, 'Reading live data…',
    'the stale cloud completion replaced the newer status');
  assert.equal(doc.el('sync').textContent, 'Reading…',
    'the stale cloud completion replaced the newer action');
  assert.equal(doc.el('sync').disabled, true,
    'the stale cloud completion cleared busy for the newer preview');
  assert.equal(doc.el('live-fallback').hidden, true,
    'the stale cloud completion exposed an obsolete action');
  assert.equal(doc.el('backup-picker').hidden, true,
    'the stale cloud completion restored obsolete backup choices');

  live.resolve({
    ...LIVE_PREVIEW,
    token: 'new-live-token',
    existing: {
      ok: true, categories: 5, kept: 2, removed: 3, added: 0,
      removedSample: ['Music', 'Podcasts', 'News'],
    },
  });
  await liveRun;
  assert.match(doc.el('status').textContent, /^Live ·/);
  assert.match(doc.el('sync').textContent, /^Import 2 categories/);
  assert.equal(doc.el('confirm').hidden, false,
    'the newer destructive Live preview did not retain its gated action');
  await doc.el('confirm-send').fire('click');
  assert.equal(chromeStub._sent[2].confirmToken, 'new-live-token',
    'the stale cloud token overwrote the newer Live token');
}

await test('a resolved stale cloud preview cannot overtake a newer Live preview', async () => {
  await assertStaleCloudCannotOvertakeLive((cloud) => cloud.resolve(CLOUD_PREVIEW));
});

await test('a rejected stale cloud preview cannot overtake a newer Live preview', async () => {
  await assertStaleCloudCannotOvertakeLive((cloud) => cloud.reject(new Error('old cloud failed')));
});

await test('rapid source-alternative clicks start one Live preview and no import', async () => {
  const live = deferred();
  const chromeStub = popupChrome((message) => message.source === 'live'
    ? live.promise
    : CLOUD_PREVIEW);
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  const firstClick = doc.el('live-fallback-use-cloud').fire('click');
  const secondClick = doc.el('live-fallback-use-cloud').fire('click');
  await secondClick;
  assert.equal(chromeStub._sent.filter((message) => message.source === 'live').length, 1,
    'rapid clicks started duplicate Live previews');
  assert.ok(chromeStub._sent.every((message) => message.confirmToken === undefined),
    'a rapid source click committed an import');

  live.resolve(LIVE_PREVIEW);
  await firstClick;
  assert.equal(chromeStub._sent.length, 2);
});

await test('the settings button swaps views instead of opening a tab', async () => {
  const chromeStub = popupChrome(previewThenImport(CLOUD_PREVIEW));
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.equal(doc.el('settings-view').hidden, true, 'the popup opened on the settings view');
  await doc.el('open-settings').fire('click');
  assert.equal(doc.el('settings-view').hidden, false,
    'the Settings button did not show the settings view');
  assert.equal(doc.el('run-view').hidden, true, 'both views were on screen at once');
  assert.equal(doc.activeElement, doc.el('app-origin'),
    'opening Settings did not focus the first settings control');
  assert.equal(chromeStub._openedOptions.length, 0, 'the Settings button opened a tab');

  await doc.el('settings-back').fire('click');
  assert.equal(doc.el('settings-view').hidden, true, 'Done did not return to the run view');
  assert.equal(doc.el('run-view').hidden, false);
  assert.equal(doc.activeElement, doc.el('open-settings'),
    'Done did not return focus to the visible Settings button');
  assert.equal(chromeStub._openedOptions.length, 0);
  assert.deepEqual(chromeStub._createdTabs, [], 'switching views opened a tab');
});

await test('nothing can open an options page any more', async () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8')
  );
  assert.equal(manifest.options_ui, undefined, 'the manifest still declares options_ui');
  assert.equal(manifest.options_page, undefined, 'the manifest still declares options_page');

  ['options.html', 'options.js'].forEach((file) => {
    assert.equal(fs.existsSync(path.join(extensionDir, file)), false,
      `${file} is still shipped`);
  });

  ['background.js', 'popup.js', 'content.js', 'pockettube-bridge.js', 'pockettube-live.js']
    .forEach((file) => {
      const src = fs.readFileSync(path.join(extensionDir, file), 'utf8');
      assert.ok(!src.includes('openOptionsPage'), `${file} still calls openOptionsPage`);
    });
});

await test('shipped popup source contains no legacy primary-button label literals', async () => {
  const src = fs.readFileSync(path.join(extensionDir, 'popup.js'), 'utf8');
  assert.equal(src.includes('Preview and import'), false);
  assert.equal(src.includes('Read live data and import'), false);
});

await test('the backup picker lives in the settings view, not the run view', async () => {
  const chromeStub = popupChrome(previewThenImport(CLOUD_PREVIEW));
  await chromeStub.storage.local.set({ importSource: 'cloud' });
  const doc = loadPopup(chromeStub);
  await settle();

  // With one-click sync the run view is a status line and a button; every
  // choice, the cloud backup included, belongs next to the import source.
  ['backup-picker', 'backup-id', 'import-source', 'import-mode', 'app-origin',
    'cred-fieldset', 'settings-status'].forEach((id) => {
    assert.equal(doc.viewOf(id), 'settings', `#${id} is not in the settings view`);
  });
  ['sync', 'primary-note', 'status', 'confirm', 'live-fallback', 'dry-run'].forEach((id) => {
    assert.equal(doc.viewOf(id), 'run', `#${id} is not in the run view`);
  });

  assert.equal(doc.el('backup-picker').hidden, false,
    'the cloud preview did not fill the picker in the settings view');
  assert.equal(doc.el('backup-id').children.length, 2);
});

// --- settings view: the settings the run view gave up -------------------------

// One chrome for a popup and a worker that share a storage area, so what the
// settings view writes is what the worker reads back.
function settingsChrome(answer, options = {}) {
  const worker = makeChrome();
  const popup = popupChrome(answer, { ...options, storage: worker.storage });
  return {
    ...worker,
    ...popup,
    storage: worker.storage,
    runtime: { ...worker.runtime, ...popup.runtime },
    tabs: { ...worker.tabs, ...popup.tabs },
  };
}

await test('app origin uses one explicit form action with an accessible status', async () => {
  const html = fs.readFileSync(path.join(extensionDir, 'popup.html'), 'utf8');
  assert.match(html,
    /<form id="app-origin-form"[\s\S]*<input[^>]+id="app-origin"[\s\S]*<button id="app-origin-save" type="submit">Apply<\/button>[\s\S]*<\/form>/,
    'the origin input and Apply submit action are not in one Enter-capable form');
  assert.match(html,
    /id="settings-status" role="status" aria-live="polite" aria-atomic="true"/,
    'the settings status is not an atomic polite live region');
  assert.match(html, /Host access connects this origin to the cookie bridge\./,
    'the host-access reason is missing');

  const chromeStub = popupChrome(LIVE_PREVIEW);
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://explicit.example/path';
  await doc.el('app-origin').fire('change');
  assert.equal(await chromeStub.storage.local.get('appOrigin').then((s) => s.appOrigin),
    APP_ORIGIN, 'change/blur implicitly saved the origin');
  assert.deepEqual(chromeStub.permissions._requested, []);

  // The browser dispatches this same form event for an Apply click or Enter.
  await submitOrigin(doc);
  assert.equal(await chromeStub.storage.local.get('appOrigin').then((s) => s.appOrigin),
    'https://explicit.example');
});

await test('origin submission is single-flight and Settings cannot close while pending', async () => {
  let finishConfiguration;
  let configureCalls = 0;
  const configuration = new Promise((resolve) => { finishConfiguration = resolve; });
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    configureAnswer: async () => {
      configureCalls += 1;
      return configuration;
    },
  });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();
  await doc.el('open-settings').fire('click');

  doc.el('app-origin').value = 'https://pending.example';
  const pending = submitOrigin(doc);
  await settle();
  assert.equal(doc.el('app-origin').disabled, true);
  assert.equal(doc.el('app-origin-save').disabled, true);
  assert.equal(doc.el('settings-back').disabled, true);
  assert.equal(doc.el('open-settings').disabled, true);
  assert.equal(doc.el('app-origin-form').getAttribute('aria-busy'), 'true');
  assert.match(doc.el('settings-status').textContent, /Checking app origin/);

  await submitOrigin(doc);
  await doc.el('settings-back').fire('click');
  await doc.el('open-settings').fire('click');
  assert.equal(configureCalls, 1, 'a duplicate origin configuration was dispatched');
  assert.equal(doc.el('settings-view').hidden, false,
    'Done/Back hid an in-flight origin operation');

  finishConfiguration({
    ok: true,
    origin: 'https://pending.example',
    cleanupWarning: '',
  });
  await pending;
  assert.equal(doc.el('app-origin').disabled, false);
  assert.equal(doc.el('app-origin-save').disabled, false);
  assert.equal(doc.el('settings-back').disabled, false);
  assert.equal(doc.el('app-origin-form').getAttribute('aria-busy'), 'false');
});

await test('settings saved in the popup persist and are read by the worker', async () => {
  const chromeStub = settingsChrome(previewThenImport(CLOUD_PREVIEW));
  chromeStub._local.data.delete('importSource');
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = ' HTTP://127.0.0.1:8001/ ';
  await submitOrigin(doc);
  doc.el('import-source').value = 'cloud';
  await doc.el('import-source').fire('change');
  doc.el('import-mode').value = 'additive';
  await doc.el('import-mode').fire('change');

  doc.el('cred-mode').value = 'patreon';
  await doc.el('cred-mode').fire('change');
  doc.el('cred-access-token').value = 'PATREON-SECRET';
  await doc.el('cred-save').fire('click');

  // Every safety property the separate options page used to hold.
  assert.equal(doc.el('cred-access-token').value, '',
    'the token input was not cleared after saving');
  assert.ok(!doc.el('credential-state').textContent.includes('PATREON-SECRET'),
    'the stored secret was rendered back into the page');
  assert.match(doc.el('credential-state').textContent, /hidden/);
  assert.equal(doc.el('cred-fieldset').hidden, false,
    'the credentials are hidden for the cloud source');

  const stored = await chromeStub.storage.local.get(
    ['appOrigin', 'importSource', 'importMode', 'pocketTubeCredentials']
  );
  assert.equal(stored.appOrigin, APP_ORIGIN, 'the origin was not normalised and stored');
  assert.equal(stored.importSource, 'cloud');
  assert.equal(stored.importMode, 'additive');
  assert.deepEqual(stored.pocketTubeCredentials,
    { mode: 'patreon', accessToken: 'PATREON-SECRET' });

  // The run view picks the new mode up without being reopened.
  assert.match(doc.el('sync').textContent, /\(additive\)$/,
    'the primary button still names the old import mode');

  // Remote plaintext HTTP is refused where it is typed, and does not overwrite.
  doc.el('app-origin').value = 'http://app.home.example:8080';
  await submitOrigin(doc);
  assert.equal(doc.el('settings-status').className, 'error');
  assert.equal(doc.el('app-origin').value, APP_ORIGIN,
    'validation failure did not restore the active origin');
  assert.equal(doc.activeElement, doc.el('app-origin'));
  assert.match(doc.el('settings-status').textContent,
    /Previous origin remains active: http:\/\/127\.0\.0\.1:8001/);
  assert.equal(await chromeStub.storage.local.get('appOrigin').then((s) => s.appOrigin),
    APP_ORIGIN, 'a disallowed origin was stored anyway');

  // And the worker reads exactly what the settings view wrote.
  const fetchStub = makeFetch();
  const bg = loadBackground(chromeStub, fetchStub);
  assert.equal(await bg.resolveImportSource(), 'cloud');
  const preview = await bg.previewFromPocketTube();
  assert.equal(preview.origin, APP_ORIGIN);
  assert.equal(preview.source, 'cloud');
  const listCall = fetchStub.calls.find((c) => c.url.endsWith('/backup/list'));
  assert.equal(listCall.init.body.get('access_token'), 'PATREON-SECRET',
    'the credential saved in the settings view never reached the backup API');

  await bg.commitPreparedImport(preview.token, stored.importMode);
  const posted = fetchStub.calls.find((c) => c.url.endsWith('/api/categories/import/'));
  assert.equal(posted.init.body.get('mode'), 'additive',
    'the mode saved in the settings view never reached the import');
});

await test('popup denial does not overwrite the previous app origin', async () => {
  const chromeStub = popupChrome(LIVE_PREVIEW, { permissionGranted: false });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://192.168.50.5';
  await submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._requested,
    [{ origins: ['https://192.168.50.5/*'] }]);
  assert.equal(await chromeStub.storage.local.get('appOrigin').then((s) => s.appOrigin),
    APP_ORIGIN);
  assert.equal(doc.el('app-origin').value, APP_ORIGIN,
    'permission denial left the rejected origin displayed');
  assert.equal(doc.activeElement, doc.el('app-origin'));
  assert.match(doc.el('settings-status').textContent,
    /denied[\s\S]*previous origin remains active: http:\/\/127\.0\.0\.1:8001/i);
});

await test('popup requests the minimum remote host grant and reports tab reload', async () => {
  const chromeStub = popupChrome(LIVE_PREVIEW);
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://app.home.example:8443/path?q=1';
  await submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._requested,
    [{ origins: ['https://app.home.example/*'] }]);
  assert.equal(chromeStub.permissions._callOrder[0], 'request');
  assert.equal(await chromeStub.storage.local.get('appOrigin').then((s) => s.appOrigin),
    'https://app.home.example:8443');
  assert.equal(doc.el('app-origin').value, 'https://app.home.example:8443');
  assert.match(doc.el('settings-status').textContent,
    /App origin saved: https:\/\/app\.home\.example:8443\. Reload an already-open app tab\./);
  assert.equal(doc.activeElement, doc.el('app-origin'));
});

await test('popup configuration dispatches through the real worker transaction', async () => {
  const workerChrome = makeChrome();
  loadBackground(workerChrome, makeFetch());
  await settle();
  await workerChrome.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const responses = [];
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    storage: workerChrome.storage,
    permissions: workerChrome.permissions,
    configureAnswer: async (message) => {
      const response = await dispatchRuntimeMessage(workerChrome, message);
      responses.push(response);
      return response;
    },
  });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://audit-blocker.github.dev/path';
  await submitOrigin(doc);
  assert.deepEqual(workerChrome.permissions._requested,
    [{ origins: ['https://audit-blocker.github.dev/*'] }]);
  assert.deepEqual(responses, [{
    ok: true,
    origin: 'https://audit-blocker.github.dev',
    cleanupWarning: '',
  }]);
  assert.equal(await workerChrome.storage.local.get('appOrigin').then((s) => s.appOrigin),
    'https://audit-blocker.github.dev');
  assert.deepEqual(workerChrome.scripting._registrations.get('app-bridge').matches,
    ['https://audit-blocker.github.dev/*']);

  workerChrome.permissions._grantRequests = false;
  doc.el('app-origin').value = 'https://denied.example';
  await submitOrigin(doc);
  assert.equal(responses.length, 1, 'a denied permission was dispatched to the worker');
  assert.equal(await workerChrome.storage.local.get('appOrigin').then((s) => s.appOrigin),
    'https://audit-blocker.github.dev');
  assert.deepEqual(workerChrome.scripting._registrations.get('app-bridge').matches,
    ['https://audit-blocker.github.dev/*']);
  assert.match(doc.el('settings-status').textContent, /denied/i);
});

await test('popup rejects wildcard and IPv6 hosts before requesting permission', async () => {
  const chromeStub = popupChrome(LIVE_PREVIEW);
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  for (const value of ['https://*.example.com', 'https://*', 'https://[2001:db8::1]']) {
    doc.el('app-origin').value = value;
    await submitOrigin(doc);
    assert.equal(await chromeStub.storage.local.get('appOrigin').then((s) => s.appOrigin),
      APP_ORIGIN);
  }
  assert.deepEqual(chromeStub.permissions._requested, []);
});

await test('popup setup failure removes its newly granted permission', async () => {
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    configureAnswer: async () => ({ ok: false, error: 'registration failed' }),
  });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://new.example';
  await submitOrigin(doc);
  assert.equal(await chromeStub.storage.local.get('appOrigin').then((s) => s.appOrigin),
    APP_ORIGIN);
  assert.deepEqual(chromeStub.permissions._removed,
    [{ origins: ['https://new.example/*'] }]);
  assert.deepEqual(chromeStub.permissions._added,
    [{ origins: ['https://new.example/*'] }]);
  assert.match(doc.el('settings-status').textContent, /registration failed/);
  assert.equal(doc.el('app-origin').value, APP_ORIGIN);
  assert.match(doc.el('settings-status').textContent,
    /Previous origin remains active: http:\/\/127\.0\.0\.1:8001/);
  assert.equal(doc.activeElement, doc.el('app-origin'));
});

await test('popup failure retains a same-host grant and the old full origin across ports', async () => {
  const activeOrigin = 'https://app.example:8443';
  const sharedPermission = 'https://app.example/*';
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    grantedOrigins: [sharedPermission],
    configureAnswer: async () => ({ ok: false, error: 'registration failed' }),
  });
  await chromeStub.storage.local.set({ appOrigin: activeOrigin, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://app.example:9443';
  await submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._removed, []);
  assert.equal(await chromeStub.permissions.contains({ origins: [sharedPermission] }), true);
  assert.equal(await chromeStub.storage.local.get('appOrigin').then((s) => s.appOrigin),
    activeOrigin);
  assert.equal(doc.el('app-origin').value, activeOrigin);
  assert.match(doc.el('settings-status').textContent,
    /registration failed[\s\S]*Previous origin remains active: https:\/\/app\.example:8443/);
});

async function exerciseWorkerConfigureFailure(failureType, preExistingPermission) {
  const target = `https://${failureType}-${preExistingPermission ? 'existing' : 'new'}.example`;
  const targetPermission = `${target}/*`;
  const workerChrome = makeChrome({
    grantedOrigins: preExistingPermission ? [targetPermission] : [],
  });
  await workerChrome.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  loadBackground(workerChrome, makeFetch());
  await settle();

  if (failureType === 'registration') {
    const realUpdate = workerChrome.scripting.updateContentScripts.bind(workerChrome.scripting);
    workerChrome.scripting.updateContentScripts = async (scripts) => {
      if (scripts.some((script) => script.matches.includes(targetPermission))) {
        throw new Error('registration failed');
      }
      return realUpdate(scripts);
    };
  } else {
    const realSet = workerChrome.storage.local.set.bind(workerChrome.storage.local);
    workerChrome.storage.local.set = async (value) => {
      if (value.appOrigin === target) throw new Error('storage unavailable');
      return realSet(value);
    };
  }

  const responses = [];
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    storage: workerChrome.storage,
    permissions: workerChrome.permissions,
    configureAnswer: async (message) => {
      const response = await dispatchRuntimeMessage(workerChrome, message);
      responses.push(response);
      return response;
    },
  });
  const doc = loadPopup(chromeStub);
  await settle();
  doc.el('app-origin').value = target;
  await submitOrigin(doc);

  assert.equal(responses[0]?.ok, false);
  assert.match(responses[0]?.error || '',
    failureType === 'registration' ? /registration failed/ : /storage unavailable/);
  assert.equal(await workerChrome.storage.local.get('appOrigin').then((s) => s.appOrigin),
    APP_ORIGIN);
  assert.deepEqual(workerChrome.scripting._registrations.get('app-bridge').matches,
    ['http://127.0.0.1/*']);
  assert.equal(await workerChrome.permissions.contains({ origins: [targetPermission] }), false);
  assert.deepEqual(workerChrome.permissions._removed,
    [{ origins: [targetPermission] }]);
  assert.deepEqual(workerChrome.permissions._added,
    preExistingPermission ? [] : [{ origins: [targetPermission] }]);
  assert.match(doc.el('settings-status').textContent,
    /Previous origin remains active: http:\/\/127\.0\.0\.1:8001/);
}

for (const failureType of ['registration', 'storage']) {
  for (const preExistingPermission of [false, true]) {
    const grantState = preExistingPermission ? 'stale pre-existing' : 'newly granted';
    await test(`popup removes ${grantState} permission after worker ${failureType} failure`, async () => {
      await exerciseWorkerConfigureFailure(failureType, preExistingPermission);
    });
  }
}

await test('popup runtime failure removes a newly granted permission and retains the active origin', async () => {
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    configureAnswer: async () => { throw new Error('message port closed'); },
  });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://runtime-failure.example';
  await submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._removed,
    [{ origins: ['https://runtime-failure.example/*'] }]);
  assert.equal(await chromeStub.permissions.contains({
    origins: ['https://runtime-failure.example/*'],
  }), false);
  assert.equal(await chromeStub.storage.local.get('appOrigin').then((s) => s.appOrigin),
    APP_ORIGIN);
  assert.equal(doc.el('app-origin').value, APP_ORIGIN);
  assert.match(doc.el('settings-status').textContent,
    /message port closed[\s\S]*Previous origin remains active: http:\/\/127\.0\.0\.1:8001/);
  assert.equal(doc.activeElement, doc.el('app-origin'));
});

await test('popup reconciles a committed origin when the worker reply is lost', async () => {
  let chromeStub;
  chromeStub = popupChrome(LIVE_PREVIEW, {
    configureAnswer: async (message) => {
      await chromeStub.storage.local.set({ appOrigin: message.appOrigin });
      throw new Error('reply channel closed');
    },
  });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://committed.example/path';
  await submitOrigin(doc);
  assert.equal(doc.el('app-origin').value, 'https://committed.example');
  assert.match(doc.el('settings-status').textContent,
    /App origin saved: https:\/\/committed\.example\. Reload an already-open app tab\./);
  assert.equal(doc.el('settings-status').className, 'success');
  assert.deepEqual(chromeStub.permissions._removed, []);
  assert.equal(await chromeStub.permissions.contains({
    origins: ['https://committed.example/*'],
  }), true);
  assert.ok(chromeStub.permissions._contained.length >= 2,
    'the popup did not verify live permission before accepting the lost-reply commit');
  assert.equal(doc.activeElement, doc.el('app-origin'));
});

await test('popup does not report success when a same-origin request is denied and access is absent', async () => {
  const activeOrigin = 'https://same-origin.example:8443';
  const permission = 'https://same-origin.example/*';
  const chromeStub = popupChrome(LIVE_PREVIEW, { permissionGranted: false });
  await chromeStub.storage.local.set({ appOrigin: activeOrigin, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = activeOrigin;
  await submitOrigin(doc);
  assert.equal(doc.el('settings-status').className, 'error');
  assert.equal(doc.el('app-origin').value, activeOrigin);
  assert.match(doc.el('settings-status').textContent,
    /configured as https:\/\/same-origin\.example:8443[\s\S]*Chrome access is missing[\s\S]*Apply again/);
  assert.deepEqual(chromeStub.permissions._removed, []);
  assert.deepEqual(chromeStub.permissions._contained, [{ origins: [permission] }]);
});

for (const verification of [
  { name: 'is false', options: {} },
  { name: 'rejects', options: { permissionContainsThrows: 'permissions API unavailable' } },
]) {
  await test(`popup reports a reconciled configured origin as unavailable when contains ${verification.name}`, async () => {
    let chromeStub;
    chromeStub = popupChrome(LIVE_PREVIEW, {
      ...verification.options,
      configureAnswer: async (message) => {
        await chromeStub.storage.local.set({ appOrigin: message.appOrigin });
        chromeStub.permissions._granted.delete(`${message.appOrigin}/*`);
        throw new Error('reply channel closed');
      },
    });
    await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
    const doc = loadPopup(chromeStub);
    await settle();

    const target = `https://contains-${verification.name === 'is false' ? 'false' : 'reject'}.example`;
    doc.el('app-origin').value = target;
    await submitOrigin(doc);
    assert.equal(await chromeStub.storage.local.get('appOrigin').then((s) => s.appOrigin), target);
    assert.equal(doc.el('app-origin').value, target);
    assert.equal(doc.el('settings-status').className, 'error');
    assert.match(doc.el('settings-status').textContent, /configured as[\s\S]*Apply again/);
    assert.doesNotMatch(doc.el('settings-status').textContent, /App origin saved:/);
    assert.deepEqual(chromeStub.permissions._removed, []);
  });
}

await test('popup verifies explicit worker success and rejects a post-commit revocation race', async () => {
  const target = 'https://revoked-after-worker.example';
  const permission = `${target}/*`;
  let chromeStub;
  chromeStub = popupChrome(LIVE_PREVIEW, {
    configureAnswer: async (message) => {
      await chromeStub.storage.local.set({ appOrigin: message.appOrigin });
      chromeStub.permissions._granted.delete(permission);
      return { ok: true, origin: message.appOrigin, cleanupWarning: '' };
    },
  });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = target;
  await submitOrigin(doc);
  assert.equal(doc.el('settings-status').className, 'error');
  assert.equal(doc.el('app-origin').value, target);
  assert.match(doc.el('settings-status').textContent, /Chrome access is missing[\s\S]*Apply again/);
  assert.doesNotMatch(doc.el('settings-status').textContent, /Reload an already-open app tab/);
  assert.deepEqual(chromeStub.permissions._removed, []);
});

await test('popup treats normalized committed storage as authoritative over explicit failure', async () => {
  let chromeStub;
  chromeStub = popupChrome(LIVE_PREVIEW, {
    configureAnswer: async (message) => {
      await chromeStub.storage.local.set({ appOrigin: `${message.appOrigin}/settings?q=1` });
      return { ok: false, error: 'reply contradicted committed storage' };
    },
  });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://normalized-commit.example/path';
  await submitOrigin(doc);
  assert.equal(doc.el('app-origin').value, 'https://normalized-commit.example');
  assert.equal(doc.el('settings-status').className, 'success');
  assert.deepEqual(chromeStub.permissions._removed, []);
});

await test('popup does not claim commit from a valid worker reply without persisted storage', async () => {
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    configureAnswer: async (message) => ({ ok: true, origin: message.appOrigin }),
  });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://unpersisted-success.example';
  await submitOrigin(doc);
  assert.equal(doc.el('settings-status').className, 'error');
  assert.equal(doc.el('app-origin').value, APP_ORIGIN);
  assert.deepEqual(chromeStub.permissions._removed,
    [{ origins: ['https://unpersisted-success.example/*'] }]);
  assert.match(doc.el('settings-status').textContent,
    /persisted origin did not match the worker response/);
});

await test('popup fails safely on malformed worker response and nonmatching storage', async () => {
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    configureAnswer: async () => ({ ok: true, origin: 'not an origin' }),
  });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://malformed-response.example';
  await submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._removed,
    [{ origins: ['https://malformed-response.example/*'] }]);
  assert.equal(doc.el('app-origin').value, APP_ORIGIN);
  assert.match(doc.el('settings-status').textContent,
    /worker did not return a valid answer[\s\S]*Previous origin remains active/);
});

await test('popup fails safely when persisted storage is malformed', async () => {
  let chromeStub;
  chromeStub = popupChrome(LIVE_PREVIEW, {
    configureAnswer: async () => {
      await chromeStub.storage.local.set({ appOrigin: 'malformed persisted origin' });
      return undefined;
    },
  });
  await chromeStub.storage.local.set({ appOrigin: 'also malformed', importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  assert.equal(doc.el('app-origin').value, APP_ORIGIN);
  doc.el('app-origin').value = 'https://malformed-storage.example';
  await submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._removed,
    [{ origins: ['https://malformed-storage.example/*'] }]);
  assert.equal(doc.el('app-origin').value, APP_ORIGIN);
  assert.match(doc.el('settings-status').textContent,
    /Previous origin remains active: http:\/\/127\.0\.0\.1:8001/);
});

await test('popup removes a stale pre-existing permission after message failure', async () => {
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    grantedOrigins: ['https://pre-existing.example/*'],
    configureAnswer: async () => undefined,
  });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://pre-existing.example';
  await submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._added, [],
    'request changed a pre-existing grant');
  assert.deepEqual(chromeStub.permissions._removed,
    [{ origins: ['https://pre-existing.example/*'] }]);
  assert.equal(await chromeStub.permissions.contains({
    origins: ['https://pre-existing.example/*'],
  }), false);
  assert.equal(doc.el('app-origin').value, APP_ORIGIN);
  assert.match(doc.el('settings-status').textContent,
    /worker did not answer[\s\S]*Previous origin remains active: http:\/\/127\.0\.0\.1:8001/i);
});

await test('popup request rejection cleans the unconfigured requested origin', async () => {
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    permissionRequestThrows: 'request API failed',
  });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://request-rejected.example';
  await submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._added, []);
  assert.deepEqual(chromeStub.permissions._removed,
    [{ origins: ['https://request-rejected.example/*'] }]);
  assert.match(doc.el('settings-status').textContent, /request API failed/);
});

await test('popup cleans an uncommitted grant when request rejects after granting', async () => {
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    permissionRequestThrowsAfterGrant: 'request result lost',
  });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://grant-then-reject.example';
  await submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._added,
    [{ origins: ['https://grant-then-reject.example/*'] }]);
  assert.deepEqual(chromeStub.permissions._removed,
    [{ origins: ['https://grant-then-reject.example/*'] }]);
  assert.match(doc.el('settings-status').textContent, /request result lost/);
});

await test('popup needs no permissions onAdded API to clean a stale grant', async () => {
  const targetPermission = 'https://no-events.example/*';
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    grantedOrigins: [targetPermission],
    configureAnswer: async () => ({ ok: false, error: 'registration failed' }),
  });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://no-events.example';
  await submitOrigin(doc);
  assert.equal('onAdded' in chromeStub.permissions, false);
  assert.deepEqual(chromeStub.permissions._added, []);
  assert.deepEqual(chromeStub.permissions._removed, [{ origins: [targetPermission] }]);
  assert.equal(await chromeStub.permissions.contains({ origins: [targetPermission] }), false);
});

await test('popup storage rejection uses the prior active origin and cleans a different request', async () => {
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    configureAnswer: async () => { throw new Error('message port closed'); },
  });
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();
  chromeStub.storage.local.get = async () => { throw new Error('storage read failed'); };

  doc.el('app-origin').value = 'https://storage-read-failure.example';
  await submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._removed,
    [{ origins: ['https://storage-read-failure.example/*'] }]);
  assert.equal(doc.el('settings-status').className, 'error');
  assert.match(doc.el('settings-status').textContent,
    /Could not verify whether https:\/\/storage-read-failure\.example was saved: storage read failed/);
});

await test('popup retains the prior active permission when its request rejects', async () => {
  const activeOrigin = 'https://active-request.example';
  const activePermission = `${activeOrigin}/*`;
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    grantedOrigins: [activePermission],
    permissionRequestThrows: 'request API failed',
  });
  await chromeStub.storage.local.set({ appOrigin: activeOrigin, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = activeOrigin;
  await submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._removed, []);
  assert.equal(await chromeStub.permissions.contains({ origins: [activePermission] }), true);
  assert.equal(doc.el('app-origin').value, activeOrigin);
  assert.equal(doc.el('settings-status').className, 'success');
});

await test('popup storage rejection retains the known prior active permission on retry', async () => {
  const activeOrigin = 'https://active-storage-fallback.example';
  const activePermission = `${activeOrigin}/*`;
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    grantedOrigins: [activePermission],
    permissionRequestThrows: 'request API failed',
  });
  await chromeStub.storage.local.set({ appOrigin: activeOrigin, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();
  chromeStub.storage.local.get = async () => { throw new Error('storage read failed'); };

  doc.el('app-origin').value = activeOrigin;
  await submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._removed, []);
  assert.equal(await chromeStub.permissions.contains({ origins: [activePermission] }), true);
  assert.equal(doc.el('app-origin').value, activeOrigin);
  assert.match(doc.el('settings-status').textContent,
    /Could not verify whether https:\/\/active-storage-fallback\.example was saved: storage read failed/);
});

await test('popup storage rejection retains a requested grant sharing the known active pattern', async () => {
  const activeOrigin = 'https://shared-storage.example:8443';
  const activePermission = 'https://shared-storage.example/*';
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    grantedOrigins: [activePermission],
    permissionRequestThrows: 'request API failed',
  });
  await chromeStub.storage.local.set({ appOrigin: activeOrigin, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();
  chromeStub.storage.local.get = async () => { throw new Error('storage read failed'); };

  doc.el('app-origin').value = 'https://shared-storage.example:9443';
  await submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._removed, []);
  assert.equal(chromeStub.permissions._removeResult, true);
  assert.equal(doc.el('app-origin').value, activeOrigin);
  assert.match(doc.el('settings-status').textContent, /storage read failed/);
});

await test('popup never attempts failed cleanup for a requested pattern shared by the active origin', async () => {
  const activeOrigin = 'https://shared-cleanup.example:8443';
  const activePermission = 'https://shared-cleanup.example/*';
  const chromeStub = popupChrome(LIVE_PREVIEW, {
    grantedOrigins: [activePermission],
    permissionRemoveResult: false,
    configureAnswer: async () => ({ ok: false, error: 'registration failed' }),
  });
  await chromeStub.storage.local.set({ appOrigin: activeOrigin, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://shared-cleanup.example:9443';
  await submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._removed, [],
    'cleanup was attempted despite the active origin sharing the permission pattern');
  assert.doesNotMatch(doc.el('settings-status').textContent, /could not remove/i);
  assert.equal(doc.el('app-origin').value, activeOrigin);
});

await test('popup invokes permission request synchronously from the submit gesture', async () => {
  const chromeStub = popupChrome(LIVE_PREVIEW);
  await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();

  doc.el('app-origin').value = 'https://synchronous-request.example';
  const submission = submitOrigin(doc);
  assert.deepEqual(chromeStub.permissions._requested,
    [{ origins: ['https://synchronous-request.example/*'] }],
    'request was deferred past the synchronous submit dispatch');
  await submission;
});

for (const cleanup of [
  { name: 'returns false', options: { permissionRemoveResult: false }, warning: /could not remove/i },
  { name: 'rejects', options: { permissionRemoveThrows: 'permissions API unavailable' }, warning: /permissions API unavailable/i },
]) {
  await test(`popup reports when permission cleanup ${cleanup.name} without changing the active origin`, async () => {
    const chromeStub = popupChrome(LIVE_PREVIEW, {
      ...cleanup.options,
      configureAnswer: async () => { throw new Error('message port closed'); },
    });
    await chromeStub.storage.local.set({ appOrigin: APP_ORIGIN, importSource: 'live' });
    const doc = loadPopup(chromeStub);
    await settle();

    doc.el('app-origin').value = 'https://cleanup-warning.example';
    await submitOrigin(doc);
    assert.deepEqual(chromeStub.permissions._removed,
      [{ origins: ['https://cleanup-warning.example/*'] }]);
    assert.equal(doc.el('app-origin').value, APP_ORIGIN);
    assert.match(doc.el('settings-status').textContent, cleanup.warning);
    assert.match(doc.el('settings-status').textContent,
      /Previous origin remains active: http:\/\/127\.0\.0\.1:8001/);
    assert.equal(doc.activeElement, doc.el('app-origin'));
  });
}

await test('the settings view hides the credentials for the live source', async () => {
  const chromeStub = settingsChrome(previewThenImport(LIVE_PREVIEW));
  await chromeStub.storage.local.set({ importSource: 'live' });
  const doc = loadPopup(chromeStub);
  await settle();
  assert.equal(doc.el('cred-fieldset').hidden, true,
    'the cloud credentials are showing for the live source');

  // Switching away from cloud drops the cloud-only picker with it.
  doc.el('import-source').value = 'cloud';
  await doc.el('import-source').fire('change');
  assert.equal(doc.el('cred-fieldset').hidden, false);
  doc.el('import-source').value = 'live';
  await doc.el('import-source').fire('change');
  assert.equal(doc.el('backup-picker').hidden, true,
    'a cloud backup picker survived the switch to live');
});

// --- build / stale-worker footer ---------------------------------------------

await test('the worker answers its own build constant, in step with the manifest', async () => {
  const chromeStub = makeChrome();
  const bg = loadBackground(chromeStub, async () => { throw new Error('no fetch here'); });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8')
  );

  assert.equal(bg.WORKER_BUILD, manifest.version,
    'background.js WORKER_BUILD drifted from the manifest version — bump both');

  let answer;
  const returned = chromeStub._listeners.message(
    { type: 'GET_WORKER_BUILD' }, {}, (payload) => { answer = payload; }
  );
  assert.equal(returned, undefined, 'the dispatcher must never return false');
  assert.deepEqual(answer, { ok: true, build: manifest.version });
});

await test('a worker build differing from the manifest is called out as stale', async () => {
  // Exactly the case that fooled us: the manifest already reads new while
  // Chrome keeps running the cached old worker.
  const chromeStub = popupChrome(LIVE_PREVIEW, { manifestVersion: '1.7', workerBuild: '1.6' });
  const doc = loadPopup(chromeStub);
  await settle();

  const versions = doc.el('build-versions');
  const warning = doc.el('build-warning');
  assert.match(versions.textContent, /1\.7/, 'the manifest version is missing from the footer');
  assert.match(versions.textContent, /worker 1\.6/, 'the worker build is missing from the footer');
  assert.equal(warning.hidden, false, 'the mismatch was not reported');
  assert.match(warning.textContent, /STALE SERVICE WORKER/);
  assert.match(warning.textContent, /1\.7[\s\S]*1\.6/, 'the warning does not name both builds');
  assert.match(warning.textContent, /chrome:\/\/extensions/,
    'the warning does not say how to fix it');
  assert.equal(chromeStub._sent.length, 0, 'the build probe ran a sync request');});

await test('matching builds are stated quietly and a silent worker is stated loudly', async () => {
  const healthy = popupChrome(LIVE_PREVIEW, { manifestVersion: '1.7', workerBuild: '1.7' });
  const healthyDoc = loadPopup(healthy);
  await settle();
  assert.match(healthyDoc.el('build-versions').textContent, /1\.7[\s\S]*worker 1\.7/);
  assert.equal(healthyDoc.el('build-warning').hidden, true,
    'a healthy pair raised a stale-worker warning');

  const silent = popupChrome(LIVE_PREVIEW, { manifestVersion: '1.7', workerBuild: null });
  const silentDoc = loadPopup(silent);
  await settle();
  assert.match(silentDoc.el('build-versions').textContent, /no answer/,
    'an unresponsive worker left the footer looking normal');
  assert.equal(silentDoc.el('build-warning').hidden, false,
    'an unresponsive worker was not reported');
  assert.match(silentDoc.el('build-warning').textContent, /chrome:\/\/extensions/);
});

// --- self-healing stale worker ------------------------------------------------
//
// The verified failure mode: getManifest() reports the NEW version while Chrome
// keeps running the CACHED old worker script. The worker sees that from the
// inside, because WORKER_BUILD travels with its source.

// Captures every console channel for the duration of `run`.
async function captureConsole(run) {
  const lines = [];
  const realLog = console.log;
  const realInfo = console.info;
  const realError = console.error;
  const realWarn = console.warn;
  console.log = (...args) => { lines.push(args.join(' ')); };
  console.info = (...args) => { lines.push(args.join(' ')); };
  console.error = (...args) => { lines.push(args.join(' ')); };
  console.warn = (...args) => { lines.push(args.join(' ')); };
  try {
    return { value: await run(), lines };
  } finally {
    console.log = realLog;
    console.info = realInfo;
    console.error = realError;
    console.warn = realWarn;
  }
}

await test('a worker stale against the manifest reloads itself exactly once', async () => {
  const chromeStub = makeChrome({ manifestVersion: '99.0' });
  await captureConsole(async () => {
    loadBackground(chromeStub, makeFetch());
    await settle();
  });

  assert.equal(chromeStub._reloads.length, 1,
    'the stale worker did not reload itself exactly once');
  // Local, not session: chrome.runtime.reload() would wipe a session record
  // before the worker that has to read it ever starts.
  const record = await chromeStub.storage.local.get('staleWorkerReload');
  assert.equal(record.staleWorkerReload?.target, '99.0',
    'the reload attempt was not recorded against the manifest version it aimed at');
  assert.equal(record.staleWorkerReload?.from, MANIFEST.version,
    'the recorded attempt does not name the worker build it started from');
});

await test('a worker that comes back still stale gives up instead of looping', async () => {
  const chromeStub = makeChrome({ manifestVersion: '99.0' });
  await captureConsole(async () => {
    loadBackground(chromeStub, makeFetch());
    await settle();
  });
  assert.equal(chromeStub._reloads.length, 1);

  // Second startup, same storage, same manifest: the record is already there.
  const second = await captureConsole(async () => {
    loadBackground(chromeStub, makeFetch());
    await settle();
  });

  assert.equal(chromeStub._reloads.length, 1,
    'the worker reloaded itself a second time — that is a reload loop');
  const shout = second.lines.find((line) => line.includes('STALE'));
  assert.ok(shout, 'the give-up case said nothing');
  assert.match(shout, /99\.0/, 'the give-up message does not name the manifest version');
  assert.match(shout, new RegExp(MANIFEST.version.replace('.', '\\.')),
    'the give-up message does not name the running worker build');
  assert.match(shout, /chrome:\/\/extensions/,
    'the give-up message does not say how to fix it by hand');
});

await test('matching builds never reload, and clear an earlier attempt', async () => {
  const chromeStub = makeChrome();
  await chromeStub.storage.local.set({
    staleWorkerReload: { target: '98.0', from: '97.0', at: Date.now() },
  });
  const bg = loadBackground(chromeStub, makeFetch());
  await settle();

  assert.equal(chromeStub._reloads.length, 0,
    'a worker in step with the manifest reloaded itself');
  assert.deepEqual(await chromeStub.storage.local.get('staleWorkerReload'), {},
    'a stale attempt record survived a healthy startup');
  assert.equal(await bg.maybeHealStaleWorker(), 'current');
});

await test('a stale worker defers its reload while a run is in flight', async () => {
  const chromeStub = makeChrome({ manifestVersion: '99.0' });
  await captureConsole(async () => {
    const bg = loadBackground(chromeStub, makeFetch());
    // Synchronous, so the run is already in flight when the startup check
    // finishes reading storage — exactly the mid-preview case.
    bg.startKeepalive();
    await settle();
    assert.equal(chromeStub._reloads.length, 0,
      'the worker reloaded mid-run and destroyed the prepared import');
    assert.deepEqual(await chromeStub.storage.local.get('staleWorkerReload'), {},
      'a deferred reload was recorded as if it had happened');

    // The run ends; the deferred reload is taken then.
    bg.stopKeepalive();
    await settle();
  });

  assert.equal(chromeStub._reloads.length, 1,
    'the deferred reload never happened after the run finished');
});

await test('the settings view offers a one-click extension reload', async () => {
  const chromeStub = popupChrome(LIVE_PREVIEW);
  const reloads = [];
  chromeStub.runtime.reload = () => { reloads.push(true); };
  const doc = loadPopup(chromeStub);
  await settle();

  assert.equal(doc.viewOf('reload-extension'), 'settings',
    'the reload control is not in the settings view');
  await doc.el('reload-extension').fire('click');
  assert.equal(reloads.length, 1, 'the settings reload button did not restart the extension');
});

await test('a footer mismatch surfaces the reload button', async () => {
  const healthy = popupChrome(LIVE_PREVIEW, { manifestVersion: '1.7', workerBuild: '1.7' });
  const healthyDoc = loadPopup(healthy);
  await settle();
  assert.equal(healthyDoc.el('build-reload').hidden, true,
    'the reload button is offered when nothing is wrong');

  const chromeStub = popupChrome(LIVE_PREVIEW, { manifestVersion: '1.7', workerBuild: '1.6' });
  const reloads = [];
  chromeStub.runtime.reload = () => { reloads.push(true); };
  const doc = loadPopup(chromeStub);
  await settle();

  assert.equal(doc.el('build-reload').hidden, false,
    'the stale-worker warning did not surface the reload button');
  await doc.el('build-reload').fire('click');
  assert.equal(reloads.length, 1, 'the footer reload button did not restart the extension');
});

// --- report ------------------------------------------------------------------

let failed = 0;
results.forEach((result) => {
  if (result.ok) {
    console.log(`PASS  ${result.name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${result.name}\n      ${result.error?.message || result.error}`);
  }
});
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
