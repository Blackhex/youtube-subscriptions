// Popup script — ONE click runs the PocketTube category import, and the SAME
// document holds the settings as a second view. Nothing here opens a tab: the
// header button swaps the run view for the settings view and back.
//
// The run view owns nothing but the run. It PREVIEWS AUTOMATICALLY when it
// opens, so the source, the backup time, the category / channel / assignment
// counts, the removal forecast from GET {appOrigin}/api/categories/ and every
// warning are already on screen before anything can be pressed — that is what
// removes the first click. The single primary button then commits THAT preview
// through its one-shot token, so the bytes that ship are byte-for-byte the
// bytes that were shown; nothing is ever read a second time.
//
// A second confirmation is asked for only when it earns its place: a preview
// that would delete categories, one whose removal count could not be
// determined, or one carrying a zero-assignment / oversized / stale-backup
// warning. Everything else imports on the single click, and the button and the
// note under it always say which case applies.
//
// The run view's "Dry run" checkbox is the opt-out from all of that. While it
// is checked the primary button can only ever PREVIEW: no confirmation panel is
// shown, no token is spent, nothing is POSTed. It is stored in
// chrome.storage.local so the choice survives the popup closing, and it
// defaults to OFF, which is the one-click import behaviour.
//
// Two FULLY DETACHED sources: "live" (default) reads PocketTube's current data
// off a youtube.com tab and needs no credential; "cloud" downloads the
// paid-plan cloud backup. Neither switches to the other on its own — a live
// failure says what went wrong and offers a button the user must press to try
// the cloud backup. The backup picker belongs to the cloud source alone, lives
// in the settings view next to the source, and is cleared whenever the source
// is not cloud.
//
// The live source is the one thing that cannot always auto-preview: with no
// youtube.com tab open it would have to open one, which is too surprising and
// too slow to do just because the popup was opened. In that case the popup
// shows a ready state and the single click does preview-then-commit in one go,
// still applying the confirmation gate before it sends anything.
//
// The settings half keeps every safety property it had as a separate page:
// token fields are type="password", a stored secret is NEVER rendered back (it
// only reports that one exists), the inputs are cleared the moment a credential
// is saved, everything rendered goes through textContent, and the app origin is
// validated against the same anchored allow-list the worker enforces before it
// is stored.

const DRY_RUN_RESULT_KEY = 'lastDryRun';
const DRY_RUN_RESULT_MAX_AGE_MS = 5 * 60 * 1000;
// The user-set "preview only, never import" switch. Distinct from
// DRY_RUN_RESULT_KEY, which is the context menu's one-off handoff.
const DRY_RUN_ONLY_KEY = 'dryRunOnly';
const RUN_STATE_KEY = 'pocketTubeRunState';
const CREDENTIALS_KEY = 'pocketTubeCredentials';
const IMPORT_MODE_KEY = 'importMode';
const DEFAULT_IMPORT_MODE = 'replace';
const IMPORT_SOURCE_KEY = 'importSource';
const DEFAULT_IMPORT_SOURCE = 'live';
const DEFAULT_APP_ORIGIN = 'http://127.0.0.1:8001';
const RECOVERY_WINDOW_MS = 5000;
const RECOVERY_POLL_MS = 400;
const YOUTUBE_TAB_PATTERN = 'https://*.youtube.com/*';

// --- run view ---
const runView = document.getElementById('run-view');
const syncButton = document.getElementById('sync');
const dryRunCheckbox = document.getElementById('dry-run');
const primaryNote = document.getElementById('primary-note');
const settingsButton = document.getElementById('open-settings');
const statusBox = document.getElementById('status');
const confirmBox = document.getElementById('confirm');
const confirmText = document.getElementById('confirm-text');
const confirmSend = document.getElementById('confirm-send');
const confirmCancel = document.getElementById('confirm-cancel');
const liveFallbackBox = document.getElementById('live-fallback');
const liveFallbackButton = document.getElementById('live-fallback-use-cloud');
const liveFallbackHint = liveFallbackBox.querySelector('.hint');
const buildVersions = document.getElementById('build-versions');
const buildWarning = document.getElementById('build-warning');
const buildReload = document.getElementById('build-reload');

// --- settings view ---
const settingsView = document.getElementById('settings-view');
const settingsBack = document.getElementById('settings-back');
const settingsStatus = document.getElementById('settings-status');
const originForm = document.getElementById('app-origin-form');
const originInput = document.getElementById('app-origin');
const originSaveButton = document.getElementById('app-origin-save');
const importSourceSelect = document.getElementById('import-source');
const importModeSelect = document.getElementById('import-mode');
const backupPicker = document.getElementById('backup-picker');
const backupSelect = document.getElementById('backup-id');
const credFieldset = document.getElementById('cred-fieldset');
const credModeSelect = document.getElementById('cred-mode');
const patreonFields = document.getElementById('patreon-fields');
const paddleFields = document.getElementById('paddle-fields');
const accessTokenInput = document.getElementById('cred-access-token');
const emailInput = document.getElementById('cred-email');
const tokenList = document.getElementById('cred-token-list');
const tokenAddButton = document.getElementById('cred-token-add');
const credSaveButton = document.getElementById('cred-save');
const credClearButton = document.getElementById('cred-clear');
const credentialState = document.getElementById('credential-state');
const reloadExtensionButton = document.getElementById('reload-extension');

// The one-shot token of the preview the button would commit. Null means the
// button has to preview first.
let pendingToken = null;
let lastPreview = null;
// null means "whatever PocketTube reports as newest" — the default path.
let selectedBackupId = null;
let importMode = DEFAULT_IMPORT_MODE;
let importSource = DEFAULT_IMPORT_SOURCE;
let alternativeSource = null;
// The dry-run switch. While it is on the primary button reads the source and
// stops: no confirmation panel, no commit, no token spent. Off by default, so
// the shipped behaviour is the one-click import.
let dryRunOnly = false;
// Set when the live source has no youtube.com tab to read: the click has to
// open one, so it is announced instead of happening on popup open.
let liveNeedsTab = false;
let busy = false;
let previewGeneration = 0;
let activePreviewGeneration = null;
let savedAppOrigin = DEFAULT_APP_ORIGIN;
let originBusy = false;

function setStatus(text, kind) {
  statusBox.textContent = text;
  statusBox.className = kind || '';
}

function setSettingsStatus(text, kind) {
  settingsStatus.textContent = text;
  settingsStatus.className = kind || '';
}

function hideConfirm() {
  confirmBox.hidden = true;
  confirmText.textContent = '';
}

// The picker lists CLOUD backups and nothing else, so it is emptied rather than
// merely hidden: a leftover option would otherwise pin a cloud backup id onto a
// later run. Called at the start of every run and on every source change, so it
// never depends on "the live preview happened to carry no backups".
function clearBackupPicker() {
  backupPicker.hidden = true;
  backupSelect.textContent = '';
  selectedBackupId = null;
}

function hideLiveFallback() {
  liveFallbackBox.hidden = true;
  liveFallbackButton.textContent = '';
  if (liveFallbackHint) liveFallbackHint.textContent = '';
  alternativeSource = null;
}

function showSourceAlternative(source) {
  const useLive = source === 'live';
  liveFallbackButton.textContent = useLive ? 'Use current live data' : 'Use the cloud backup';
  if (liveFallbackHint) {
    liveFallbackHint.textContent = useLive
      ? 'Cloud is a scheduled snapshot and may be up to a day old.'
      : 'Different data, up to a day old.';
  }
  alternativeSource = source;
  liveFallbackBox.hidden = false;
}

// Drops the armed preview: whatever it quoted is no longer what the button
// would send.
function disarm() {
  pendingToken = null;
  lastPreview = null;
  hideConfirm();
}

// --- switching views ----------------------------------------------------------

function showSettings() {
  if (originBusy) return;
  runView.hidden = true;
  settingsView.hidden = false;
  settingsButton.textContent = 'Back';
  originInput.focus();
}

function showRun() {
  if (originBusy) return;
  settingsView.hidden = true;
  runView.hidden = false;
  settingsButton.textContent = 'Settings';
  settingsButton.focus();
}

function focusPrimaryIfRunVisible() {
  if (runView.hidden === false) syncButton.focus();
}

settingsButton.addEventListener('click', () => {
  if (settingsView.hidden) showSettings();
  else showRun();
});

settingsBack.addEventListener('click', showRun);

// --- reloading the extension --------------------------------------------------
// The one-click alternative to hunting for the card on chrome://extensions.
// This restarts the extension — the worker is dropped and re-read from disk —
// so the popup goes with it.
function reloadExtension() {
  try {
    chrome.runtime.reload();
  } catch (error) {
    setStatus(`Could not restart the extension: ${error?.message || error}`, 'error');
  }
}

reloadExtensionButton.addEventListener('click', reloadExtension);
buildReload.addEventListener('click', reloadExtension);

// --- what the button says and does -------------------------------------------

// Deliberate allow-list: only zero/absent assignments, oversized payloads,
// and stale snapshots trigger extra confirmation; other informational warnings do not.
const GATE_WARNING_RE = /0 assignments|No category lists|MB limit|days old/;

// Why this preview needs an explicit second confirmation. Empty means the
// single click imports directly.
function gateReasons(preview) {
  const reasons = [];
  const existing = preview.existing;
  const replacing = importMode !== 'additive';

  if (!existing || existing.ok !== true) {
    const detail = existing && existing.error ? ` (${existing.error})` : '';
    reasons.push(`removals unknown${detail}`);
  } else if (existing.removed > 0) {
    const plural = existing.removed === 1 ? 'y' : 'ies';
    reasons.push(replacing
      ? `deletes ${existing.removed} categor${plural} the app has`
      : `${existing.removed} categor${plural} in the app are missing here`);
  }

  (preview.warnings || []).forEach((warning) => {
    if (GATE_WARNING_RE.test(warning)) reasons.push(warning);
  });

  return reasons;
}

function renderPrimary() {
  if (busy) return;

  // Checked, this button cannot import, so nothing about the preview changes
  // what it says.
  if (dryRunOnly) {
    syncButton.disabled = false;
    syncButton.textContent = 'Preview only';
    primaryNote.textContent = 'Dry run — nothing is sent.';
    return;
  }

  if (!lastPreview) {
    syncButton.disabled = false;
    syncButton.textContent = `Import categories (${importMode})`;
    primaryNote.textContent = liveNeedsTab
      ? 'Opens a youtube.com tab, previews, then imports.'
      : 'Previews first, then imports.';
    return;
  }

  const stats = lastPreview.stats || {};
  if (!lastPreview.committable) {
    syncButton.disabled = true;
    syncButton.textContent = 'Nothing to import';
    primaryNote.textContent = 'Cannot be imported — see the warnings.';
    return;
  }

  const count = stats.categories ?? 0;
  const reasons = gateReasons(lastPreview);
  syncButton.disabled = false;
  syncButton.textContent =
    `Import ${count} categor${count === 1 ? 'y' : 'ies'} (${importMode})`;
  primaryNote.textContent = reasons.length
    ? `Confirms first: ${reasons[0]}.`
    : 'Sends exactly what is previewed.';
}

function setBusy(on, label) {
  busy = on;
  if (on) hideLiveFallback();
  syncButton.disabled = on;
  backupSelect.disabled = on;
  confirmSend.disabled = on;
  confirmCancel.disabled = on;
  if (on && label) syncButton.textContent = label;
  if (!on) renderPrimary();
}

function invalidatePreview() {
  previewGeneration += 1;
  if (activePreviewGeneration !== null) {
    activePreviewGeneration = null;
    setBusy(false);
  }
}

// --- describing a result ------------------------------------------------------

// The source the WORKER used. It is always the one that was asked for — the two
// sources never substitute for each other — but it is read back from the result
// rather than from this popup's state, so what is named is what was read.
function describeSource(data) {
  const stats = data.stats || {};
  const used = data.source || stats.source;
  if (used === 'live') return 'Live';
  return `Cloud (${stats.backupAt || 'time unknown'})`;
}

// The counts the app reports today, measured against the previewed payload, so
// the user sees what replace mode is about to remove rather than a vague
// warning. A failed lookup is stated as such instead of being rounded to zero.
function describeRemovals(existing) {
  if (!existing || existing.ok !== true) {
    const reason = existing && existing.error ? ` (${existing.error})` : '';
    return `removals unknown${reason}`;
  }
  return `${existing.kept} kept, ${existing.removed} removed, ${existing.added} new`;
}

function describePreview(data) {
  const stats = data.stats || {};
  const lines = [
    `${describeSource(data)} \u00b7 ${stats.categories ?? 0} categories, ` +
    `${stats.channels ?? 0} channels, ${stats.assignments ?? 0} assignments ` +
    `\u00b7 ${describeRemovals(data.existing)}`,
  ];
  (data.warnings || []).forEach((warning) => lines.push(`! ${warning}`));
  return lines.join('\n');
}

function describeImport(data) {
  const result = data.result || {};
  const mode = result.mode || data.mode || 'replace';
  const parts = [
    `Imported (${mode}) \u00b7 ${result.created_categories ?? 0} categories, ` +
    `${result.created_subscriptions ?? 0} channels, ` +
    `${result.assignments_added ?? 0} assignments added`,
  ];
  if (mode === 'replace') {
    parts.push(`${result.deleted_categories ?? 0} categories, ` +
      `${result.deleted_assignments ?? 0} assignments deleted`);
  }
  if (result.unmatched_channels) parts.push(`${result.unmatched_channels} unmatched`);
  const lines = [parts.join(' \u00b7 ')];
  (data.warnings || []).forEach((warning) => lines.push(`! ${warning}`));
  return lines.join('\n');
}

// The worker's message is the whole message. Where to read more is a standing
// fact about this extension, not something worth repeating in every error, so
// it goes to the console once per failure instead.
function describeError(message) {
  console.info('[PocketTube sync] details: chrome://extensions \u2192 YouTube ' +
    'Subscriptions Helper \u2192 "Service worker". The log is redacted, but it ' +
    'does contain your category names.');
  return message;
}

// --- talking to the worker ----------------------------------------------------

// The worker mirrors every outcome into storage before it answers, so a lost
// message port is recoverable instead of being reported as a dead worker.
function runStateStore() {
  return chrome.storage.session || chrome.storage.local;
}

function newRequestId() {
  return (self.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRunState() {
  try {
    const stored = await runStateStore().get(RUN_STATE_KEY);
    return stored[RUN_STATE_KEY] || null;
  } catch (error) {
    return null;
  }
}

async function recoverRunResult(requestId) {
  const deadline = Date.now() + RECOVERY_WINDOW_MS;
  let sawRunning = false;
  for (;;) {
    const state = await readRunState();
    if (state && state.requestId === requestId) {
      if (state.status === 'done') {
        try {
          await runStateStore().remove(RUN_STATE_KEY);
        } catch (error) {
          // Leaving it behind is harmless; the next run overwrites it.
        }
        return { result: state, sawRunning };
      }
      sawRunning = true;
    }
    if (Date.now() >= deadline) return { result: null, sawRunning };
    await delay(RECOVERY_POLL_MS);
  }
}

function lostRunMessage(sawRunning, sendError) {
  if (sawRunning) return 'The worker restarted mid-run. Try again.';
  if (sendError) {
    return `The worker is unreachable (${sendError.message || sendError}).`;
  }
  return 'The worker never answered. Reload the extension.';
}

async function sendSyncRequest(payload) {
  const requestId = newRequestId();
  let response = null;
  let sendError = null;

  try {
    response = await chrome.runtime.sendMessage({ ...payload, requestId });
    if (!response && chrome.runtime.lastError) {
      console.warn('[PocketTube sync] sendMessage resolved with no response:',
        chrome.runtime.lastError.message);
    }
  } catch (error) {
    sendError = error;
    console.warn('[PocketTube sync] sendMessage rejected:', error?.message || error);
  }

  if (!response) {
    const recovered = await recoverRunResult(requestId);
    if (!recovered.result) throw new Error(lostRunMessage(recovered.sawRunning, sendError));
    response = recovered.result;
  }

  if (!response.ok) {
    const error = new Error(response.error || 'Unknown error.');
    // Set by the worker when a LIVE read failed; it is what lets the popup offer
    // the cloud backup as a button instead of switching sources by itself.
    error.liveFailure = !!response.liveFailure;
    throw error;
  }
  return response;
}

function requestPreview(backupId, sourceOverride) {
  return sendSyncRequest({
    type: 'SYNC_POCKETTUBE',
    backupId: backupId || null,
    source: sourceOverride || importSource,
  });
}

function confirmImport(token) {
  return sendSyncRequest({ type: 'SYNC_POCKETTUBE', confirmToken: token, mode: importMode });
}

// --- the run ------------------------------------------------------------------

// Newest first, as the worker lists them. The selected option is the backup the
// preview actually downloaded, so the picker never disagrees with the status.
// Gated on the source the WORKER reports, not on the list being empty: the
// picker belongs to the cloud source and must never appear in a live run.
function renderBackupChoices(preview) {
  const backups = Array.isArray(preview.backups) ? preview.backups : [];
  if (preview.source !== 'cloud' || !backups.length) {
    clearBackupPicker();
    return;
  }
  backupSelect.textContent = '';
  backups.forEach((backup, index) => {
    const option = document.createElement('option');
    option.value = String(backup.id);
    option.textContent = index === 0 ? `${backup.at} (newest cloud snapshot)` : backup.at;
    backupSelect.appendChild(option);
  });
  const current = String(preview.stats?.backupId ?? backups[0].id);
  backupSelect.value = current;
  selectedBackupId = backupSelect.value || null;
  backupPicker.hidden = false;
}

async function runPreview(backupId, sourceOverride, focusPrimaryWhenDone = false) {
  const generation = ++previewGeneration;
  activePreviewGeneration = generation;
  const source = sourceOverride || importSource;
  disarm();
  hideLiveFallback();
  // Never carry a cloud backup list into a run that is not a cloud run.
  if (source !== 'cloud') clearBackupPicker();
  setBusy(true, 'Reading…');
  setStatus(source === 'live' ? 'Reading live data…' : 'Downloading backup…');

  try {
    const preview = await requestPreview(backupId, sourceOverride);
    if (generation !== previewGeneration) return null;
    renderBackupChoices(preview);
    lastPreview = preview;
    pendingToken = preview.token || null;
    // The read succeeded, so whatever tab it needed was found or opened.
    if (preview.source === 'live') liveNeedsTab = false;
    setStatus(describePreview(preview), 'success');
    if (preview.source === 'cloud') showSourceAlternative('live');
    return preview;
  } catch (error) {
    if (generation !== previewGeneration) return null;
    clearBackupPicker();
    setStatus(describeError(error?.message || String(error)), 'error');
    // Offered, never taken automatically: the cloud backup is different data.
    if (error?.liveFailure) showSourceAlternative('cloud');
    return null;
  } finally {
    if (generation === previewGeneration) {
      activePreviewGeneration = null;
      setBusy(false);
      if (focusPrimaryWhenDone) focusPrimaryIfRunVisible();
    }
  }
}

function showConfirmation(preview, reasons) {
  const stats = preview.stats || {};
  const replacing = importMode !== 'additive';
  const lines = [
    `Send ${stats.categories ?? 0} categories / ${stats.channels ?? 0} channels ` +
    `to ${preview.origin} in ${importMode} mode. Source: ${describeSource(preview)}.`,
    `Why confirm: ${reasons.join('; ')}.`,
  ];
  if (replacing) {
    lines.push(
      'REPLACE DELETES every category and every channel-to-category assignment ' +
      'in the app, then rebuilds them from this payload. Anything missing from ' +
      'it is gone.'
    );
    const existing = preview.existing;
    if (!existing || existing.ok !== true) {
      lines.push('How many categories that deletes could not be determined.');
    } else if (existing.removed > 0) {
      const sample = Array.isArray(existing.removedSample) ? existing.removedSample : [];
      lines.push(`Deletes ${existing.removed} of ${existing.categories} categories` +
        (sample.length
          ? `: ${sample.join(', ')}${existing.removed > sample.length ? ', …' : ''}`
          : '.'));
    }
  } else {
    lines.push('ADDITIVE: nothing is deleted.');
  }
  lines.push('Cannot be undone. Continue?');
  confirmText.textContent = lines.join('\n');
  confirmBox.hidden = false;
  confirmSend.focus();
}

async function commitNow() {
  const restoringConfirmationFocus = !confirmBox.hidden;
  // The dry-run switch is a hard stop, not just a different button label: the
  // confirmation panel is never shown while it is on, so this only fires if
  // something else reached here.
  if (dryRunOnly) {
    hideConfirm();
    setStatus('Dry run — nothing was imported.');
    if (restoringConfirmationFocus) focusPrimaryIfRunVisible();
    return;
  }
  const token = pendingToken;
  // Without a token the worker would have nothing to send; committing anyway
  // used to run a second preview and report it as a completed import.
  if (!token) {
    disarm();
    setStatus('Preview expired — nothing was sent.', 'error');
    renderPrimary();
    if (restoringConfirmationFocus) focusPrimaryIfRunVisible();
    return;
  }
  hideConfirm();
  setBusy(true, 'Importing…');
  setStatus('Importing…');

  try {
    const result = await confirmImport(token);
    // The token is spent either way, so nothing stays armed after a commit.
    disarm();
    setStatus(describeImport(result), 'success');
  } catch (error) {
    disarm();
    setStatus(describeError(error?.message || String(error)), 'error');
  } finally {
    setBusy(false);
    if (restoringConfirmationFocus) focusPrimaryIfRunVisible();
  }
}

// The single click. It previews first only when there is nothing armed — with
// the cloud source, and with a live source that had a youtube.com tab to read,
// the preview already ran when the popup opened.
async function onPrimaryClick() {
  if (busy) return;
  // Dry run: read and report, then stop. No gate to pass, no token to spend.
  if (dryRunOnly) {
    await runPreview(selectedBackupId);
    return;
  }
  if (!lastPreview) {
    const preview = await runPreview(selectedBackupId);
    if (!preview) return;
  }
  if (!lastPreview.committable) {
    setStatus('Cannot be imported — see the warnings. Nothing was sent.', 'error');
    return;
  }
  const reasons = gateReasons(lastPreview);
  if (reasons.length) {
    showConfirmation(lastPreview, reasons);
    return;
  }
  await commitNow();
}

syncButton.addEventListener('click', onPrimaryClick);
confirmSend.addEventListener('click', commitNow);

// Stored, so the choice survives closing the popup. Turning it on also drops
// any confirmation already on screen — that panel can only lead to an import.
dryRunCheckbox.addEventListener('change', async () => {
  dryRunOnly = !!dryRunCheckbox.checked;
  if (dryRunOnly) hideConfirm();
  await chrome.storage.local.set({ [DRY_RUN_ONLY_KEY]: dryRunOnly });
  renderPrimary();
});

confirmCancel.addEventListener('click', () => {
  hideConfirm();
  setStatus('Cancelled — nothing was imported.');
  focusPrimaryIfRunVisible();
});

// Source alternatives are explicit: the preview stays armed until the user
// presses this, then it is discarded before the newly selected source is read.
liveFallbackButton.addEventListener('click', async () => {
  const source = alternativeSource;
  if (source !== 'cloud' && source !== 'live') return;
  hideLiveFallback();
  disarm();
  importSource = source;
  liveNeedsTab = false;
  applyImportSource(importSource);
  const persistSource = chrome.storage.local.set({ [IMPORT_SOURCE_KEY]: importSource });
  const preview = runPreview(null, importSource, true);
  await Promise.all([persistSource, preview]);
});

// Re-previewing on a change is the point of the picker: the newest backup can
// be the near-empty one, and only a download tells you what is in it. It also
// re-arms the button with the new preview's token, so returning to the run view
// shows the new numbers behind the same single click. The picker only ever
// lists CLOUD backups, so the choice pins the source too — otherwise a live
// retry would quietly ignore it.
backupSelect.addEventListener('change', () => {
  selectedBackupId = backupSelect.value || null;
  runPreview(selectedBackupId, 'cloud');
});

// --- settings: app origin -----------------------------------------------------

// URL parsing lowercases scheme and host and drops any path, so the anchored
// patterns stay strict while "HTTP://LOCALHOST:8001" is still accepted.
function normaliseOrigin(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return DEFAULT_APP_ORIGIN;
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      throw new Error('The app origin must not contain credentials.');
    }
    if (parsed.origin === 'null' || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Use an HTTP or HTTPS app origin.');
    }
    if (parsed.hostname.includes('*')) {
      throw new Error('The app origin hostname must not contain wildcards.');
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
    if (error instanceof TypeError) throw new Error('Enter a valid app origin.');
    throw error;
  }
}

function originPermission(origin) {
  const parsed = new URL(origin);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

function isRequiredOrigin(origin) {
  const parsed = new URL(origin);
  return parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
}

function setOriginBusy(on) {
  originBusy = on;
  originInput.disabled = on;
  originSaveButton.disabled = on;
  settingsBack.disabled = on;
  settingsButton.disabled = on;
  originForm.setAttribute('aria-busy', String(on));
}

function rejectOrigin(message) {
  originInput.value = savedAppOrigin;
  setSettingsStatus(
    `${message} Previous origin remains active: ${savedAppOrigin}.`,
    'error'
  );
  originInput.focus();
}

function acceptOrigin(origin, cleanupWarning = '') {
  savedAppOrigin = origin;
  originInput.value = savedAppOrigin;
  setSettingsStatus(
    `App origin saved: ${origin}. Reload an already-open app tab.${cleanupWarning}`,
    'success'
  );
  originInput.focus();
}

function reportConfiguredOriginWithoutAccess(origin, message) {
  savedAppOrigin = origin;
  originInput.value = savedAppOrigin;
  setSettingsStatus(
    `App origin is configured as ${origin}, but ${message} Apply again to restore Chrome access.`,
    'error'
  );
  originInput.focus();
}

async function verifyOriginPermission(origin, permission) {
  try {
    const available = await chrome.permissions.contains({ origins: [permission] });
    if (!available) {
      reportConfiguredOriginWithoutAccess(origin, 'Chrome access is missing.');
      return false;
    }
  } catch (error) {
    reportConfiguredOriginWithoutAccess(
      origin,
      `Chrome access could not be verified: ${error?.message || String(error)}.`
    );
    return false;
  }
  return true;
}

async function readPersistedOrigin() {
  const stored = await chrome.storage.local.get('appOrigin');
  if (typeof stored.appOrigin !== 'string') return null;
  try {
    return normaliseOrigin(stored.appOrigin);
  } catch (error) {
    return null;
  }
}

async function reconcileOriginFailure(
  value,
  permission,
  needsOptionalAccess,
  message,
  committedCleanupWarning = ''
) {
  let persistedOrigin;
  let verificationWarning = '';
  try {
    persistedOrigin = await readPersistedOrigin();
  } catch (error) {
    verificationWarning = ` Could not verify whether ${value} was saved: ${error?.message || String(error)}.`;
    console.warn(`[App origin]${verificationWarning}`);
  }

  if (persistedOrigin === value) {
    if (await verifyOriginPermission(value, permission)) {
      acceptOrigin(value, committedCleanupWarning);
    }
    return;
  }

  const activeOrigin = persistedOrigin || savedAppOrigin;
  savedAppOrigin = activeOrigin;
  const activePermission = originPermission(activeOrigin);
  let cleanupWarning = '';
  // This host grant is extension-scoped, so least privilege removes any unused
  // requested origin even when the grant was stale or pre-existing.
  if (needsOptionalAccess && permission !== activePermission) {
    try {
      const removed = await chrome.permissions.remove({ origins: [permission] });
      if (!removed) {
        cleanupWarning = ` Chrome could not remove access to ${value}.`;
      }
    } catch (error) {
      cleanupWarning = ` Chrome could not remove access to ${value}: ${error?.message || String(error)}.`;
    }
  }
  if (cleanupWarning) console.warn(`[App origin]${cleanupWarning}`);
  rejectOrigin(`${message}${verificationWarning}${cleanupWarning}`);
}

originForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (originBusy) return;

  setOriginBusy(true);
  setSettingsStatus('Checking app origin and Chrome host access…');
  let value;
  try {
    value = normaliseOrigin(originInput.value);
  } catch (error) {
    setOriginBusy(false);
    rejectOrigin(error?.message || String(error));
    return;
  }
  originInput.value = value;
  const permission = originPermission(value);
  const needsOptionalAccess = !isRequiredOrigin(value);
  try {
    if (needsOptionalAccess) {
      let permissionRequest;
      try {
        // Keep this call before the first await so Chrome sees the form's user gesture.
        permissionRequest = Promise.resolve(
          chrome.permissions.request({ origins: [permission] })
        );
      } catch (error) {
        permissionRequest = Promise.reject(error);
      }
      let permissionGranted;
      try {
        permissionGranted = await permissionRequest;
      } catch (error) {
        await reconcileOriginFailure(
          value,
          permission,
          needsOptionalAccess,
          `Chrome could not request access to ${value}: ${error?.message || String(error)}.`
        );
        return;
      }
      if (!permissionGranted) {
        await reconcileOriginFailure(
          value,
          permission,
          needsOptionalAccess,
          `Access to ${value} was denied.`
        );
        return;
      }
    }

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'CONFIGURE_APP_ORIGIN',
        appOrigin: value,
      });
    } catch (error) {
      await reconcileOriginFailure(
        value,
        permission,
        needsOptionalAccess,
        `Could not configure ${value}: ${error?.message || String(error)}.`
      );
      return;
    }

    if (response?.ok === false) {
      await reconcileOriginFailure(
        value,
        permission,
        needsOptionalAccess,
        `Could not configure ${value}: ${response.error || 'setup failed'}.`
      );
      return;
    }

    let responseOrigin = null;
    if (response?.ok === true && typeof response.origin === 'string') {
      try {
        responseOrigin = normaliseOrigin(response.origin);
      } catch (error) {
        responseOrigin = null;
      }
    }
    if (responseOrigin !== value) {
      const responseProblem = response === undefined || response === null
        ? 'the worker did not answer'
        : 'the worker did not return a valid answer';
      await reconcileOriginFailure(
        value,
        permission,
        needsOptionalAccess,
        `Could not configure ${value}: ${responseProblem}.`
      );
      return;
    }

    await reconcileOriginFailure(
      value,
      permission,
      needsOptionalAccess,
      `Could not configure ${value}: persisted origin did not match the worker response.`,
      response.cleanupWarning || ''
    );
  } finally {
    setOriginBusy(false);
  }
});

// --- settings: import source --------------------------------------------------
// The credentials only mean anything to the cloud source; with the live source
// no credential is needed at all.

function applyImportSource(source) {
  importSource = source === 'cloud' ? 'cloud' : DEFAULT_IMPORT_SOURCE;
  importSourceSelect.value = importSource;
  credFieldset.hidden = importSource !== 'cloud';
}

importSourceSelect.addEventListener('change', async () => {
  invalidatePreview();
  applyImportSource(importSourceSelect.value);
  // A backup list belongs to the cloud source, and an armed preview belongs to
  // the source it was read from — neither survives a switch.
  if (importSource !== 'cloud') clearBackupPicker();
  hideLiveFallback();
  disarm();
  liveNeedsTab = false;
  await chrome.storage.local.set({ [IMPORT_SOURCE_KEY]: importSource });
  setSettingsStatus(importSource === 'cloud'
    ? 'Source: cloud backup.'
    : 'Source: live.', 'success');
  renderPrimary();
});

// --- settings: import mode -----------------------------------------------------
// Replace is the backend default, so it is the default here too — but it is
// stored and sent explicitly, never inferred from the server.

function applyImportMode(mode) {
  importMode = mode === 'additive' ? 'additive' : DEFAULT_IMPORT_MODE;
  importModeSelect.value = importMode;
}

importModeSelect.addEventListener('change', async () => {
  applyImportMode(importModeSelect.value);
  hideConfirm();
  await chrome.storage.local.set({ [IMPORT_MODE_KEY]: importMode });
  setSettingsStatus(`Mode: ${importMode}.`, 'success');
  renderPrimary();
});

// --- settings: credentials ------------------------------------------------------
// The stored secret is never rendered back into the DOM, not even masked
// character-for-character: this view only ever reports that one exists.

function applyCredentialMode(mode) {
  const isPatreon = mode !== 'paddle';
  credModeSelect.value = isPatreon ? 'patreon' : 'paddle';
  patreonFields.hidden = !isPatreon;
  paddleFields.hidden = isPatreon;
}

// Paddle tokens are secrets like any other, so each one gets its own masked
// field instead of a plain-text textarea.
let tokenRowSeq = 0;

function addTokenRow() {
  const row = document.createElement('div');
  row.className = 'token-row';

  const input = document.createElement('input');
  input.type = 'password';
  input.id = `cred-token-${tokenRowSeq}`;
  tokenRowSeq += 1;
  input.className = 'cred-token';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'yu.tokens entry';
  row.appendChild(input);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'secondary';
  remove.title = 'Remove this token';
  remove.textContent = '\u00d7';
  remove.addEventListener('click', () => {
    row.remove();
    if (!tokenList.querySelector('.cred-token')) addTokenRow();
  });
  row.appendChild(remove);

  tokenList.appendChild(row);
  return input;
}

function resetTokenRows() {
  tokenList.textContent = '';
  // Restart the ids so the label keeps pointing at the first row.
  tokenRowSeq = 0;
  addTokenRow();
}

function readTokenInputs() {
  return Array.from(tokenList.querySelectorAll('.cred-token'))
    .map((input) => input.value.trim())
    .filter(Boolean);
}

tokenAddButton.addEventListener('click', () => {
  addTokenRow().focus();
});

resetTokenRows();

function describeStoredCredential(creds) {
  if (!creds || typeof creds !== 'object') return 'No credentials saved.';
  if (creds.mode === 'patreon') return 'Patreon token saved (hidden).';
  const tokenCount = Array.isArray(creds.tokens) ? creds.tokens.length : 0;
  return `Paddle credentials saved (hidden, ${tokenCount} token` +
    `${tokenCount === 1 ? '' : 's'}).`;
}

function clearCredentialInputs() {
  accessTokenInput.value = '';
  emailInput.value = '';
  resetTokenRows();
}

async function renderCredentialState() {
  const stored = await chrome.storage.local.get(CREDENTIALS_KEY);
  const creds = stored[CREDENTIALS_KEY];
  applyCredentialMode(creds?.mode || 'patreon');
  credentialState.textContent = describeStoredCredential(creds);
}

credModeSelect.addEventListener('change', () => {
  applyCredentialMode(credModeSelect.value);
});

credSaveButton.addEventListener('click', async () => {
  const mode = credModeSelect.value === 'paddle' ? 'paddle' : 'patreon';
  let creds;

  if (mode === 'patreon') {
    const accessToken = accessTokenInput.value.trim();
    if (!accessToken) {
      setSettingsStatus('Enter the Patreon access token first.', 'error');
      return;
    }
    creds = { mode, accessToken };
  } else {
    const email = emailInput.value.trim();
    const tokens = readTokenInputs();
    if (!email || !tokens.length) {
      setSettingsStatus('Enter the email and at least one token first.', 'error');
      return;
    }
    creds = { mode, email, tokens };
  }

  await chrome.storage.local.set({ [CREDENTIALS_KEY]: creds });
  clearCredentialInputs();
  await renderCredentialState();
  setSettingsStatus('Credentials saved.', 'success');
});

credClearButton.addEventListener('click', async () => {
  await chrome.storage.local.remove(CREDENTIALS_KEY);
  clearCredentialInputs();
  await renderCredentialState();
  setSettingsStatus('Credentials cleared.');
});

// --- opening ------------------------------------------------------------------

// Reading the live source opens a youtube.com tab when none is open. Doing that
// merely because the popup was opened would be surprising and slow, so the
// auto-preview is skipped in that one case — never because the query failed
// open.
async function hasYouTubeTab() {
  try {
    const tabs = await chrome.tabs.query({ url: YOUTUBE_TAB_PATTERN });
    return Array.isArray(tabs) && tabs.some((tab) => tab && tab.id != null);
  } catch (error) {
    return false;
  }
}

// A preview started from the context menu leaves its result here for us. It
// carries no token by design, so it is shown but never armed — the button
// re-reads before it sends anything.
async function consumeHandoff() {
  let pending = null;
  try {
    const stored = await chrome.storage.local.get(DRY_RUN_RESULT_KEY);
    pending = stored[DRY_RUN_RESULT_KEY] || null;
  } catch (error) {
    return null;
  }
  if (!pending) return null;
  await chrome.storage.local.remove(DRY_RUN_RESULT_KEY);
  if (Date.now() - (pending.at || 0) > DRY_RUN_RESULT_MAX_AGE_MS) return null;

  if (pending.ok) {
    renderBackupChoices(pending);
    setStatus(describePreview(pending), 'success');
    if (pending.source === 'cloud') showSourceAlternative('live');
  } else {
    clearBackupPicker();
    setStatus(describeError(pending.error || 'Unknown error.'), 'error');
    if (pending.liveFailure) showSourceAlternative('cloud');
  }
  return pending;
}

async function initSettings() {
  const stored = await chrome.storage.local.get(
    [IMPORT_SOURCE_KEY, IMPORT_MODE_KEY, DRY_RUN_ONLY_KEY, 'appOrigin']
  );
  applyImportSource(stored[IMPORT_SOURCE_KEY]);
  applyImportMode(stored[IMPORT_MODE_KEY]);
  dryRunOnly = stored[DRY_RUN_ONLY_KEY] === true;
  dryRunCheckbox.checked = dryRunOnly;
  try {
    savedAppOrigin = normaliseOrigin(stored.appOrigin || DEFAULT_APP_ORIGIN);
  } catch (error) {
    savedAppOrigin = DEFAULT_APP_ORIGIN;
  }
  originInput.value = savedAppOrigin;
  await renderCredentialState();
}

async function init() {
  await initSettings();

  if (await consumeHandoff()) {
    renderPrimary();
    return;
  }

  if (importSource === 'live' && !(await hasYouTubeTab())) {
    liveNeedsTab = true;
    setStatus('Ready. No youtube.com tab — the button opens one.');
    renderPrimary();
    return;
  }

  renderPrimary();
  await runPreview(selectedBackupId);
}

init();

// --- build footer ------------------------------------------------------------
// Chrome's service-worker script cache has repeatedly kept an OLD background.js
// running — once while chrome.runtime.getManifest() already reported the new
// version — so the manifest on its own proves nothing. The popup's own files are
// re-read from disk every time it opens, so it reads the manifest here and
// compares it against a constant the WORKER returns out of its own loaded
// source. Only agreement is evidence that the running worker is the code on
// disk; disagreement, or silence, is the stale-worker condition itself. The
// worker tries to reload itself out of that state once; when it cannot, the
// warning here comes with the button that does it by hand.

const WORKER_BUILD_TIMEOUT_MS = 1500;
const RELOAD_HINT = 'Reload it below, or at chrome://extensions.';

function manifestVersion() {
  try {
    return chrome.runtime.getManifest().version || 'unknown';
  } catch (error) {
    return 'unknown';
  }
}

// Resolves to null for every kind of non-answer — rejection, no response, no
// build in it, or a worker that never replies at all.
async function askWorkerBuild() {
  let request;
  try {
    request = Promise.resolve(chrome.runtime.sendMessage({ type: 'GET_WORKER_BUILD' }));
  } catch (error) {
    return null;
  }
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), WORKER_BUILD_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([request.catch(() => null), timeout]);
    return response && response.build ? String(response.build) : null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function renderBuildFooter(version, workerBuild) {
  if (!workerBuild) {
    buildVersions.textContent = `Build ${version} (manifest) \u00b7 worker: no answer`;
    buildWarning.textContent = `The worker did not answer. ${RELOAD_HINT}`;
    buildWarning.hidden = false;
    buildReload.hidden = false;
    return;
  }
  buildVersions.textContent =
    `Build ${version} (manifest) \u00b7 worker ${workerBuild}`;
  if (workerBuild !== version) {
    buildWarning.textContent =
      `STALE SERVICE WORKER: manifest ${version}, worker ${workerBuild}. ` +
      RELOAD_HINT;
    buildWarning.hidden = false;
    buildReload.hidden = false;
    return;
  }
  buildWarning.textContent = '';
  buildWarning.hidden = true;
  buildReload.hidden = true;
}

(async () => {
  const version = manifestVersion();
  buildVersions.textContent = `Build ${version} (manifest) \u00b7 worker: checking\u2026`;
  renderBuildFooter(version, await askWorkerBuild());
})();
