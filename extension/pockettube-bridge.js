// Content script — injected into https://*.youtube.com/*
// Reads PocketTube's LIVE subscription data off the page message bus by posting
// the one READ-ONLY request type the Subscription Manager (YSM,
// kdmnjgijlmjgmimahnillepgcgeemffb) answers: `get_channel_data`.
//
// Nothing here mutates PocketTube. Its bus also carries add_group,
// remove_group, update_group, update_tree, set_groups_channels,
// remove_channels, share_group, mark_watched and ysm_unsubscribe — every one of
// those WRITES. Only `get_channel_data` is ever posted.
//
// The bus is shared with every other script on youtube.com, so `event.source
// === window` proves only that the message came from this window and NOT that
// PocketTube sent it. The nonce below authenticates nothing either: it is
// broadcast on the same bus, so any page script can read it back and echo it.
// It is a STALENESS FILTER ONLY — it lets a reply to an earlier request be told
// apart from a reply to this one. Acceptance is therefore a content test: an
// object that actually carries `groupTree` or `channelList`.
//
// YSM answers only once it has seen `window.parseSubscriptionListPageDone`,
// retrying internally for about 3 seconds, so the reply can be several seconds
// late. The reply also carries `finish: false` alongside a COMPLETE payload —
// `finish` is not a completion signal and is never read here. What ends the
// collection is a quiet bus (the idle window) or the hard cap.

(() => {
const PT_REQUEST_TYPE = 'get_channel_data';
// How long to wait for the first reply before giving up entirely.
const PT_HARD_TIMEOUT_MS = 20000;
// Once a reply has landed, a short quiet window is enough to notice a second,
// contradicting answer from some other script on the bus.
const PT_IDLE_TIMEOUT_MS = 1500;
const PT_MAX_IGNORED_LOGGED = 40;
const PT_COLLECT_MESSAGE = 'PT_COLLECT_CHANNEL_DATA';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Acceptance is a content test, not a trust decision: the reply is whatever
// carries PocketTube's collection data in a shape this extension can read.
function looksLikeChannelData(data) {
  if (!isPlainObject(data)) return false;
  return Array.isArray(data.groupTree) || isPlainObject(data.channelList);
}

function ptNonce() {
  const source = typeof crypto !== 'undefined' ? crypto : null;
  if (source && typeof source.randomUUID === 'function') return source.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sameJson(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (error) {
    return false;
  }
}

function summariseMessage(data, reason) {
  const summary = { reason };
  if (isPlainObject(data)) {
    summary.type = typeof data.type === 'string' ? data.type.slice(0, 80) : '(none)';
    summary.keys = Object.keys(data).slice(0, 20);
  } else {
    summary.type = `(${Array.isArray(data) ? 'array' : typeof data})`;
    summary.keys = [];
  }
  return summary;
}

// Returns the RAW reply. Interpreting it is the worker's job — this script only
// decides which page message is the reply.
function collectChannelData() {
  return new Promise((resolve) => {
    const nonce = ptNonce();
    const ignored = [];
    let raw = null;
    let received = 0;
    let conflict = false;
    let hitHardCap = false;
    let settled = false;
    let posted = false;
    let postedAt = Infinity;
    let idleTimer = null;
    let hardTimer = null;

    const note = (data, reason) => {
      if (ignored.length >= PT_MAX_IGNORED_LOGGED) return;
      ignored.push(summariseMessage(data, reason));
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);

      const meta = { messages: received, hitHardCap, ignored };
      if (conflict) {
        resolve({
          ok: false,
          error: 'Two conflicting get_channel_data replies arrived on the page ' +
            'bus. Disable other YouTube extensions here.',
          ...meta,
        });
        return;
      }
      if (!raw) {
        resolve({
          ok: false,
          error: 'PocketTube did not answer get_channel_data. Is the ' +
            'Subscription Manager enabled here?',
          ...meta,
        });
        return;
      }
      resolve({ ok: true, raw, ...meta });
    };

    const onMessage = (event) => {
      if (event.source !== window) return;
      // Anything from before the request went out answers someone else's
      // question, or nobody's.
      if (!posted || event.timeStamp < postedAt) {
        note(event.data, 'arrived before the request was posted');
        return;
      }
      const data = event.data;
      if (isPlainObject(data) && data.type === PT_REQUEST_TYPE) {
        note(data, 'echo of our own request');
        return;
      }
      // Staleness filter only — see the file header. A reply carrying a
      // DIFFERENT nonce answered an earlier request; one carrying none is
      // simply how YSM replies.
      if (isPlainObject(data) && data.nonce !== undefined && data.nonce !== null &&
          data.nonce !== nonce) {
        note(data, 'wrong nonce');
        return;
      }
      if (!looksLikeChannelData(data)) {
        note(data, 'no groupTree or channelList in it');
        return;
      }

      received += 1;
      if (!raw) {
        raw = data;
      } else if (!sameJson(raw, data)) {
        conflict = true;
        finish();
        return;
      } else {
        note(data, 'duplicate of the reply already accepted');
      }

      // Deliberately no short-circuit on `finish`: it is false in a complete
      // reply, and a hostile reply could claim completion first. The idle
      // window always runs so a contradicting second answer surfaces.
      clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, PT_IDLE_TIMEOUT_MS);
    };

    window.addEventListener('message', onMessage);
    hardTimer = setTimeout(() => {
      hitHardCap = true;
      finish();
    }, PT_HARD_TIMEOUT_MS);

    postedAt = typeof performance !== 'undefined' ? performance.now() : 0;
    posted = true;
    window.postMessage({ type: PT_REQUEST_TYPE, nonce }, window.location.origin);
  });
}

// Unknown message types fall through to `undefined`: an explicit `false` can
// close the shared port before a sibling listener's async sendResponse lands.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== PT_COLLECT_MESSAGE) return;

  collectChannelData().then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error?.message || String(error), ignored: [] });
  });

  return true; // Keep the message channel open for the async response
});
})();
