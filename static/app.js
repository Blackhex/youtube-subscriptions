// Global state
let allCategories = [];
let totalSubscriptionCount = 0;
let uncategorizedSubscriptionCount = 0;
let allSubscriptions = [];
let selectedCategoryId = null;
let currentEditingCategoryId = null;
let selectedSubscriptionIds = [];
let draggedCategoryId = null;
let draggedParentId = null;
let draggedCategoryStartX = null;
let collapsedCategoryIds = new Set();
let currentSearchQuery = "";
let suggestedCategoryIds = [];
let subscriptionsLoadingMore = false;
const feedVideoPagination = {};
const playlistVideoPagination = {};
let allQueueItems = [];
let allPlaylists = [];
let playlistItemsLoading = false;
let queuePlaybackActive = false;
let queueSyncInterval = null;
let pendingPlaylistVideo = null;
let draggedPlaylistItemId = null;
let draggedPlaylistId = null;
let draggedQueueItemId = null;
const CAST_APPLICATION_ID = window.CAST_APPLICATION_ID || "233637DE";
const YOUTUBE_MDX_NAMESPACE = "urn:x-cast:com.google.youtube.mdx";
let castContext = null;
let castSession = null;
let castFrameworkReady = false;
let youtubeMdxListenerAttached = false;
let _receiverScreenId = null;
let _screenIdResolve = null;
let _castSessionId = null;
const CAST_SESSION_KEY = "cast_session_id";
const CAST_SCREEN_ID_KEY = "cast_screen_id";
const CAST_DEBUG_ENABLED = window.CAST_DEBUG !== false;

function logCastDebug(message, details = null) {
  if (!CAST_DEBUG_ENABLED) {
    return;
  }

  if (details !== null && details !== undefined) {
    console.log(`[Cast] ${message}`, details);
    return;
  }

  console.log(`[Cast] ${message}`);
}

window.__onGCastApiAvailable = function(isAvailable) {
  if (isAvailable) {
    initializeCastFramework();
  }
};

// API base URL
const API_BASE = "/api";

// ============================================================================
// Utility functions
// ============================================================================

function showSpinner() {
  document.getElementById("loadingSpinner").classList.remove("d-none");
}

function hideSpinner() {
  document.getElementById("loadingSpinner").classList.add("d-none");
}

function showModal(modalId) {
  const modalElement = document.getElementById(modalId);
  const modal = new bootstrap.Modal(modalElement);
  modal.show();
}

function hideModal(modalId) {
  const modalElement = document.getElementById(modalId);
  const modal = bootstrap.Modal.getInstance(modalElement);
  if (modal) {
    modal.hide();
  }
}

function getSubscriptionsEndpoint(categoryId = selectedCategoryId) {
  if (categoryId === "uncategorized") {
    return "/subscriptions?uncategorized=true";
  }
  if (categoryId) {
    return `/subscriptions?category_id=${categoryId}`;
  }
  return "/subscriptions";
}

function bindAutoLoadOnScroll(container, loadMoreFn, canLoadMoreFn, isLoadingFn) {
  if (!container) {
    return;
  }

  if (container._autoLoadScrollHandler) {
    container.removeEventListener("scroll", container._autoLoadScrollHandler);
  }

  const handler = () => {
    if (!canLoadMoreFn() || isLoadingFn()) {
      return;
    }

    const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 120;
    if (nearBottom) {
      loadMoreFn();
    }
  };

  container._autoLoadScrollHandler = handler;
  container.addEventListener("scroll", handler, { passive: true });
}

function ensureLoadMoreIndicator(container) {
  let indicator = container.querySelector(".load-more-indicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.className = "load-more-indicator d-none";
    indicator.innerHTML = `
      <div class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></div>
      <span>Loading more</span>
    `;
    container.appendChild(indicator);
  }
  return indicator;
}

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

function setLoadMoreIndicator(container, isVisible) {
  if (!container) {
    return;
  }

  const indicator = ensureLoadMoreIndicator(container);
  indicator.classList.toggle("d-none", !isVisible);
}

function getFeedVideoPagination(feedId) {
  if (!feedVideoPagination[feedId]) {
    feedVideoPagination[feedId] = {
      page: 1,
      hasMore: false,
      loading: false,
    };
  }

  return feedVideoPagination[feedId];
}

function getPlaylistVideoPagination(playlistId) {
  if (!playlistVideoPagination[playlistId]) {
    playlistVideoPagination[playlistId] = {
      page: 1,
      hasMore: false,
      loading: false,
    };
  }

  return playlistVideoPagination[playlistId];
}

function resetScrollSentinel(container) {
  if (!container) {
    return;
  }

  const sentinel = container.querySelector(".load-more-indicator");
  if (sentinel) {
    sentinel.remove();
  }
}

function initializeCastFramework() {
  if (castFrameworkReady) {
    return;
  }

  if (!window.cast || !window.cast.framework || !window.chrome || !window.chrome.cast) {
    return;
  }

  try {
    logCastDebug("Initializing Cast framework", { receiverApplicationId: CAST_APPLICATION_ID });
    castContext = cast.framework.CastContext.getInstance();
    castContext.setOptions({
      receiverApplicationId: CAST_APPLICATION_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    castContext.addEventListener(
      cast.framework.CastContextEventType.CAST_STATE_CHANGED,
      updateCastReceiverStatus
    );
    castContext.addEventListener(
      cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
      onCastSessionStateChanged
    );
    castFrameworkReady = true;
    logCastDebug("Cast framework ready", {
      castState: castContext.getCastState ? castContext.getCastState() : null,
    });
    updateCastReceiverStatus();
    tryResumeCastSession();
  } catch (error) {
    console.error("[Cast] Cast initialization failed", error);
    showToast(`Cast initialization failed: ${error.message}`, "error");
  }
}

function updateCastReceiverStatus() {
  const statusEl = document.getElementById("castReceiverStatus");
  if (!statusEl) {
    return;
  }

  if (!castContext) {
    statusEl.classList.add("d-none");
    statusEl.textContent = "";
    return;
  }

  const session = castContext.getCurrentSession ? castContext.getCurrentSession() : null;
  const deviceName = session && session.getCastDevice ? session.getCastDevice()?.friendlyName : null;

  if (deviceName) {
    statusEl.textContent = `Receiver: ${deviceName}`;
    statusEl.classList.remove("d-none");
    return;
  }

  const castState = castContext.getCastState ? castContext.getCastState() : null;
  if (castState === cast.framework.CastState.NO_DEVICES_AVAILABLE) {
    statusEl.textContent = "No Cast devices found";
  } else if (castState === cast.framework.CastState.NOT_CONNECTED) {
    statusEl.textContent = "Select a Cast receiver";
  } else {
    statusEl.textContent = "Cast ready";
  }
  statusEl.classList.remove("d-none");
}

function onCastSessionStateChanged(event) {
  if (!event) {
    return;
  }

  logCastDebug("Session state changed", {
    sessionState: event.sessionState,
    castState: castContext && castContext.getCastState ? castContext.getCastState() : null,
  });

  if (event.sessionState === cast.framework.SessionState.SESSION_STARTED ||
      event.sessionState === cast.framework.SessionState.SESSION_RESUMED) {
    castSession = castContext ? castContext.getCurrentSession() : null;
    const sessionObj = castSession && castSession.getSessionObj ? castSession.getSessionObj() : null;
    _castSessionId = sessionObj ? sessionObj.sessionId : null;
    logCastDebug("Cast session attached", {
      hasSession: Boolean(castSession),
      sessionId: _castSessionId,
      resumed: event.sessionState === cast.framework.SessionState.SESSION_RESUMED,
    });
    saveCastSession();
    attachYouTubeMdxListener(castSession);
    updateCastReceiverStatus();
    return;
  }

  if (event.sessionState === cast.framework.SessionState.SESSION_ENDED) {
    logCastDebug("Cast session ended");
    castSession = null;
    _castSessionId = null;
    _receiverScreenId = null;
    youtubeMdxListenerAttached = false;
    clearCastSession();
    stopQueueSyncPolling();
    updateCastReceiverStatus();
  }
}

function saveCastSession() {
  try {
    if (_castSessionId) {
      sessionStorage.setItem(CAST_SESSION_KEY, _castSessionId);
    }
    if (_receiverScreenId) {
      sessionStorage.setItem(CAST_SCREEN_ID_KEY, _receiverScreenId);
    }
    logCastDebug("Saved Cast session to sessionStorage", {
      sessionId: _castSessionId,
      screenId: _receiverScreenId,
    });
  } catch (e) {
    logCastDebug("Failed to save Cast session", { error: e.message });
  }
}

function clearCastSession() {
  try {
    sessionStorage.removeItem(CAST_SESSION_KEY);
    sessionStorage.removeItem(CAST_SCREEN_ID_KEY);
    logCastDebug("Cleared Cast session from sessionStorage");
  } catch (e) {
    logCastDebug("Failed to clear Cast session", { error: e.message });
  }
}

function tryResumeCastSession() {
  try {
    const savedSessionId = sessionStorage.getItem(CAST_SESSION_KEY);
    const savedScreenId = sessionStorage.getItem(CAST_SCREEN_ID_KEY);
    if (!savedSessionId) {
      return;
    }

    logCastDebug("Attempting to resume Cast session", {
      sessionId: savedSessionId,
      screenId: savedScreenId,
    });

    if (savedScreenId) {
      _receiverScreenId = savedScreenId;
    }

    chrome.cast.requestSessionById(savedSessionId);
  } catch (e) {
    logCastDebug("Failed to resume Cast session", { error: e.message });
    clearCastSession();
  }
}

async function requestCastSession() {
  if (!castContext) {
    throw new Error("Google Cast is not available in this browser");
  }

  // If there is already an active session, reuse it
  castSession = castContext.getCurrentSession ? castContext.getCurrentSession() : null;
  if (castSession) {
    logCastDebug("Reusing existing Cast session", {
      sessionId: castSession.getSessionObj ? castSession.getSessionObj()?.sessionId : null,
    });
    return castSession;
  }

  logCastDebug("Requesting Cast session");
  const maybePromise = castContext.requestSession();
  if (maybePromise && typeof maybePromise.then === "function") {
    await maybePromise;
  }

  castSession = castContext.getCurrentSession ? castContext.getCurrentSession() : null;
  if (!castSession) {
    throw new Error("Cast session was not created");
  }

  logCastDebug("Cast session available", {
    sessionId: castSession.getSessionObj ? castSession.getSessionObj()?.sessionId : null,
    deviceName: castSession.getCastDevice ? castSession.getCastDevice()?.friendlyName : null,
    namespaces: castSession.getSessionObj ? castSession.getSessionObj()?.namespaces : null,
    appId: castSession.getSessionObj ? castSession.getSessionObj()?.appId : null,
    displayName: castSession.getSessionObj ? castSession.getSessionObj()?.displayName : null,
    applicationMetadata: castSession.getApplicationMetadata ? castSession.getApplicationMetadata() : null,
  });

  return castSession;
}

function buildCastQueueItems() {
  const queueVideos = allQueueItems
    .map((item) => item.video)
    .filter((video) => video && video.video_id);

  logCastDebug("Building Cast queue items", {
    queueItemCount: allQueueItems.length,
    playableVideoCount: queueVideos.length,
  });

  return queueVideos.map((video) => {
    const youtubeUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(video.video_id)}`;
    const mediaInfo = new chrome.cast.media.MediaInfo(youtubeUrl, "video/mp4");
    mediaInfo.contentUrl = youtubeUrl;
    mediaInfo.entity = youtubeUrl;

    const metadata = new chrome.cast.media.GenericMediaMetadata();
    metadata.title = video.title || "Untitled video";
    metadata.subtitle = video.channel_title || "";
    if (video.thumbnail_url) {
      metadata.images = [new chrome.cast.Image(video.thumbnail_url)];
    }
    mediaInfo.metadata = metadata;

    const queueItem = new chrome.cast.media.QueueItem(mediaInfo);
    queueItem.autoplay = true;

    logCastDebug("Prepared Cast queue item", {
      videoId: video.video_id,
      title: video.title || "Untitled video",
      channelTitle: video.channel_title || "",
      contentId: mediaInfo.contentId,
      contentType: mediaInfo.contentType,
      hasMetadata: Boolean(mediaInfo.metadata),
    });

    return queueItem;
  });
}

function buildCastLoadRequest() {
  const queueItems = buildCastQueueItems();
  if (!queueItems.length) {
    throw new Error("Queue is empty");
  }

  logCastDebug("Creating Cast playlist request", {
    itemCount: queueItems.length,
    requestItems: queueItems.map((item) => ({
      itemId: item.itemId ?? null,
      autoplay: item.autoplay,
      contentId: item.media ? item.media.contentId : null,
      contentType: item.media ? item.media.contentType : null,
      entity: item.media ? item.media.entity : null,
      title: item.media && item.media.metadata ? item.media.metadata.title : null,
    })),
  });

  return {
    items: queueItems,
    firstMedia: queueItems[0].media,
  };
}

function getCastNamespaceNames(session) {
  const sessionObj = session && typeof session.getSessionObj === "function" ? session.getSessionObj() : session;
  const namespaces = sessionObj && Array.isArray(sessionObj.namespaces) ? sessionObj.namespaces : [];

  return namespaces
    .map((namespace) => {
      if (typeof namespace === "string") {
        return namespace;
      }

      if (namespace && typeof namespace.name === "string") {
        return namespace.name;
      }

      return null;
    })
    .filter(Boolean);
}

function buildYouTubePlaylistMessage(queuePayload) {
  const queueItems = Array.isArray(queuePayload.items) ? queuePayload.items : [];
  const videoIds = queueItems
    .map((item) => item && item.video ? item.video.video_id : null)
    .filter(Boolean);
  const firstVideoId = videoIds.length > 0 ? videoIds[0] : null;

  return {
    __sc: "setPlaylist",
    count: 1,
    videoId: firstVideoId,
    listId: queuePayload.playlist_id || "",
    currentTime: "0",
    currentIndex: -1,
    audioOnly: "false",
    req0__sc: "setPlaylist",
    req0_count: 1,
    req0_videoId: firstVideoId,
    req0_listId: queuePayload.playlist_id || "",
    req0_currentTime: "0",
    req0_currentIndex: -1,
    req0_audioOnly: "false",
    videoIds,
    playlistId: queuePayload.playlist_id || "",
    playlistTitle: queuePayload.playlist_title || "Queue playlist",
    params: queuePayload.params || "",
    ctt: queuePayload.ctt || "",
  };
}

function attachYouTubeMdxListener(session) {
  if (!session || youtubeMdxListenerAttached || typeof session.addMessageListener !== "function") {
    return;
  }

  try {
    session.addMessageListener(YOUTUBE_MDX_NAMESPACE, onYouTubeMdxMessage);
    youtubeMdxListenerAttached = true;
    logCastDebug("Attached YouTube MDX message listener", {
      namespace: YOUTUBE_MDX_NAMESPACE,
    });
  } catch (error) {
    console.error("[Cast] Failed to attach YouTube MDX listener", error);
  }
}

function onYouTubeMdxMessage(namespace, message) {
  logCastDebug("YouTube MDX message received", { namespace, message });

  try {
    const parsed = typeof message === "string" ? JSON.parse(message) : message;
    logCastDebug("Parsed MDX message", {
      type: parsed ? parsed.type : null,
      hasData: Boolean(parsed && parsed.data),
      screenId: parsed && parsed.data ? parsed.data.screenId : null,
      deviceId: parsed && parsed.data ? parsed.data.deviceId : null,
    });

    if (parsed && parsed.type === "mdxSessionStatus" && parsed.data && parsed.data.screenId) {
      _receiverScreenId = parsed.data.screenId;
      logCastDebug("Extracted screenId from MDX status", { screenId: _receiverScreenId });
      saveCastSession();
      if (_screenIdResolve) {
        _screenIdResolve(_receiverScreenId);
        _screenIdResolve = null;
      }
    }
  } catch (parseError) {
    logCastDebug("Failed to parse MDX message", { error: parseError.message });
  }
}

async function getYouTubeScreenId(session, timeoutMs = 10000) {
  if (_receiverScreenId) {
    logCastDebug("Using cached screenId", { screenId: _receiverScreenId });
    return _receiverScreenId;
  }

  logCastDebug("Requesting getMdxSessionStatus for screenId");
  const screenIdPromise = new Promise((resolve, reject) => {
    _screenIdResolve = resolve;
    setTimeout(() => {
      if (_screenIdResolve === resolve) {
        _screenIdResolve = null;
        reject(new Error("Timed out waiting for YouTube screenId (" + timeoutMs + "ms)"));
      }
    }, timeoutMs);
  });

  try {
    await sendCastMessage(session, YOUTUBE_MDX_NAMESPACE, { type: "getMdxSessionStatus" });
    logCastDebug("getMdxSessionStatus sent, waiting for response");
  } catch (sendError) {
    logCastDebug("Failed to send getMdxSessionStatus", { error: sendError.message });
  }

  return screenIdPromise;
}

function sendCastMessage(session, namespace, message) {
  return new Promise((resolve, reject) => {
    try {
      const maybeResult = session.sendMessage(namespace, message, resolve, reject);
      if (maybeResult && typeof maybeResult.then === "function") {
        maybeResult.then(resolve, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

// --- HTML-based alert/confirm/toast replacements ---

function showAlert(message, title = "Notice") {
  return new Promise((resolve) => {
    document.getElementById("alertDialogTitle").textContent = title;
    document.getElementById("alertDialogBody").textContent = message;
    const modalEl = document.getElementById("alertDialog");
    const modal = new bootstrap.Modal(modalEl);
    const handler = () => { modalEl.removeEventListener("hidden.bs.modal", handler); resolve(); };
    modalEl.addEventListener("hidden.bs.modal", handler);
    modal.show();
  });
}

function showConfirm(message, title = "Confirm") {
  return new Promise((resolve) => {
    document.getElementById("confirmDialogTitle").textContent = title;
    document.getElementById("confirmDialogBody").textContent = message;
    const modalEl = document.getElementById("confirmDialog");
    const modal = new bootstrap.Modal(modalEl);
    let resolved = false;

    const okBtn = document.getElementById("confirmDialogOk");
    const onOk = () => {
      resolved = true;
      okBtn.removeEventListener("click", onOk);
      modal.hide();
    };
    okBtn.addEventListener("click", onOk);

    const onHidden = () => {
      modalEl.removeEventListener("hidden.bs.modal", onHidden);
      okBtn.removeEventListener("click", onOk);
      resolve(resolved);
    };
    modalEl.addEventListener("hidden.bs.modal", onHidden);
    modal.show();
  });
}

function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  const bgClass = type === "error" ? "bg-danger" : type === "success" ? "bg-success" : "bg-primary";
  const id = "toast-" + Date.now();
  const html = `
    <div id="${id}" class="toast align-items-center text-white ${bgClass} border-0" role="alert">
      <div class="d-flex">
        <div class="toast-body toast-body-sm">${message}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    </div>`;
  container.insertAdjacentHTML("beforeend", html);
  const toastEl = document.getElementById(id);
  const toast = new bootstrap.Toast(toastEl, { delay: 4000 });
  toastEl.addEventListener("hidden.bs.toast", () => toastEl.remove());
  toast.show();
}

function getCategoryContainerForNode(node) {
  const parentContainer = node.closest(".category-children");
  return parentContainer || document.getElementById("categoriesTree");
}

function collectOrderedIds(container) {
  const items = Array.from(container.children);
  return items
    .map((item) => item.querySelector(":scope > .category-node"))
    .filter(Boolean)
    .map((node) => Number(node.dataset.categoryId));
}

function collectOrderedPlaylistItemIds(container) {
  const items = Array.from(container.querySelectorAll(":scope > .playlist-item[data-playlist-item-id]"));
  return items.map((item) => item.dataset.playlistItemId).filter(Boolean);
}

function collectOrderedQueueItemIds(container) {
  const items = Array.from(container.querySelectorAll(":scope > .queue-item[data-queue-item-id]"));
  return items.map((item) => item.dataset.queueItemId).filter(Boolean);
}

async function persistCategoryOrder(parentId, orderedIds) {
  await fetchAPI("/categories/reorder", {
    method: "POST",
    body: JSON.stringify({ parent_id: parentId, ordered_ids: orderedIds }),
  });
}

async function persistQueueOrder(orderedIds) {
  return fetchAPI("/queue/reorder", {
    method: "POST",
    body: JSON.stringify({ queue_item_ids: orderedIds }),
  });
}


async function fetchAPI(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || `API error: ${response.status}`);
  }

  return response.json();
}

function normalizeCategoryTree(categories) {
  if (!Array.isArray(categories)) {
    return [];
  }

  return categories.map((category) => ({
    ...category,
    children: normalizeCategoryTree(category.children),
  }));
}

function extractCategoriesPayload(payload) {
  if (Array.isArray(payload)) {
    return normalizeCategoryTree(payload);
  }

  if (payload && Array.isArray(payload.categories)) {
    return normalizeCategoryTree(payload.categories);
  }

  throw new Error("Invalid categories response");
}

// ============================================================================
// Category functions
// ============================================================================

async function loadCategories() {
  try {
    showSpinner();
    const payload = await fetchAPI("/categories");
    allCategories = extractCategoriesPayload(payload);
    totalSubscriptionCount = payload.total_count ?? 0;
    uncategorizedSubscriptionCount = payload.uncategorized_count ?? 0;
    renderCategoriesTree();
    renderCategoryParentSelect();
  } catch (error) {
    showToast(`Error loading categories: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

function renderCategoriesTree(categories = allCategories, container = null, level = 0) {
  if (!Array.isArray(categories)) return;
  const isRoot = !container;
  if (!container) {
    container = document.getElementById("categoriesTree");
    container.innerHTML = "";
  }
  
  const hasSelectedSubs = selectedSubscriptionIds.length > 0;
  const hasSingleSelection = selectedSubscriptionIds.length === 1;
  
  // Show/hide suggestions button based on selection
  if (isRoot) {
    // Update All / Uncategorized counts
    const countAllEl = document.getElementById("countAll");
    const countUncatEl = document.getElementById("countUncategorized");
    if (countAllEl) countAllEl.textContent = totalSubscriptionCount;
    if (countUncatEl) countUncatEl.textContent = uncategorizedSubscriptionCount;

    const suggestionsBtn = document.getElementById("getSuggestionsBtn");
    if (suggestionsBtn) {
      if (hasSingleSelection) {
        suggestionsBtn.classList.remove("d-none");
      } else {
        suggestionsBtn.classList.add("d-none");
      }
    }
  }
  
  // Add help message when subscriptions are selected
  if (isRoot && hasSelectedSubs) {
    const helpDiv = document.createElement("div");
    helpDiv.className = "selection-help";
    const suggestionHint = hasSingleSelection && suggestedCategoryIds.length > 0 
      ? '<span class="suggestion-active"><span class="material-icons md-sm">auto_awesome</span> Suggested categories highlighted</span>'
      : '';
    helpDiv.innerHTML = `
      <div class="selection-help-content">
        <span class="selection-count">${selectedSubscriptionIds.length} subscription${selectedSubscriptionIds.length > 1 ? 's' : ''} selected</span>
        <span class="selection-hint">Check categories below to assign</span>
        ${suggestionHint}
      </div>
    `;
    container.appendChild(helpDiv);
  }
  
  categories.forEach((category) => {
    const itemDiv = document.createElement("div");
    itemDiv.className = "category-item";

    const hasChildren = category.children && category.children.length > 0;
    const isActive = category.id === selectedCategoryId;
    const isSuggested = suggestedCategoryIds.includes(category.id);
    const isCollapsed = collapsedCategoryIds.has(category.id);
    
    // Check if all selected subscriptions are assigned to this category
    let assignmentState = "none";
    if (hasSelectedSubs) {
      const selectedSubs = allSubscriptions.filter(s => selectedSubscriptionIds.includes(s.id));
      const assignedCount = selectedSubs.filter(sub => 
        sub.categories && sub.categories.some(cat => cat.id === category.id)
      ).length;
      
      if (assignedCount === selectedSubs.length) {
        assignmentState = "all";
      } else if (assignedCount > 0) {
        assignmentState = "partial";
      }
    }

    itemDiv.innerHTML = `
        <div class="category-node ${isActive ? "active" : ""} ${isSuggested ? "suggested-category" : ""}" draggable="true" data-category-id="${category.id}" data-parent-id="${category.parent_id || ""}">
          <div class="category-drag-handle" title="Drag to reorder"><span class="material-icons">drag_indicator</span></div>
          ${hasSelectedSubs ? `<input type="checkbox" class="category-checkbox" data-category-id="${category.id}" ${assignmentState === "all" ? "checked" : ""} ${assignmentState === "partial" ? "data-indeterminate='true'" : ""} onclick="handleCategoryAssignment(${category.id}, event)">` : `<div class="category-toggle ${hasChildren ? "has-children" : ""} ${isCollapsed ? "collapsed" : ""}" data-category-id="${category.id}" role="button" tabindex="0" aria-label="${isCollapsed ? "Expand" : "Collapse"} category" aria-expanded="${!isCollapsed}">${hasChildren ? '<span class="material-icons">expand_more</span>' : ""}</div>`}
          <div class="category-name" onclick="selectCategory(${category.id})">${category.name}<span class="category-count ms-1">${category.subscription_count ?? ''}</span>${isSuggested ? ' <span class="suggestion-badge"><span class="material-icons md-sm">auto_awesome</span> Suggested</span>' : ''}</div>
          <div class="action-group">
            <button class="btn-action btn-action-sm" onclick="editCategory(${category.id})" title="Edit"><span class="material-icons">edit</span></button>
            <button class="btn-action btn-action-sm btn-action-danger" onclick="deleteCategory(${category.id})" title="Delete"><span class="material-icons">delete</span></button>
          </div>
        </div>
        ${hasChildren ? `<div class="category-children ${isCollapsed ? "hidden" : ""}" data-category-id="${category.id}"></div>` : ""}
      `;

    container.appendChild(itemDiv);

    if (hasChildren) {
      const childrenContainer = itemDiv.querySelector(".category-children");
      renderCategoriesTree(category.children, childrenContainer, level + 1);
    }
  });

  if (isRoot) {
    attachCategoryDragHandlers();
    attachCategoryCollapseHandlers();
    // Set indeterminate state for checkboxes
    if (hasSelectedSubs) {
      container.querySelectorAll('.category-checkbox[data-indeterminate="true"]').forEach(cb => {
        cb.indeterminate = true;
      });
    }
  }
}

function attachCategoryDragHandlers() {
  const tree = document.getElementById("categoriesTree");
  if (tree.dataset.dragBound === "true") {
    return;
  }
  tree.dataset.dragBound = "true";

  tree.addEventListener("dragstart", (e) => {
    const node = e.target.closest(".category-node");
    if (!node) return;
    draggedCategoryId = Number(node.dataset.categoryId);
    draggedParentId = node.dataset.parentId ? Number(node.dataset.parentId) : null;
    draggedCategoryStartX = Number.isFinite(e.clientX) ? e.clientX : null;
    node.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });

  tree.addEventListener("dragover", (e) => {
    const target = e.target.closest(".category-node");
    if (!target) return;
    e.preventDefault();

    const rect = target.getBoundingClientRect();
    const shouldNest = e.clientX > rect.left + (rect.width * 0.45);

    target.classList.toggle("drop-target", !shouldNest);
    target.classList.toggle("drop-nest-target", shouldNest);
  });

  tree.addEventListener("dragleave", (e) => {
    const target = e.target.closest(".category-node");
    if (target) target.classList.remove("drop-target", "drop-nest-target");
  });

  tree.addEventListener("dragend", () => {
    document.querySelectorAll(".category-node").forEach((node) => {
      node.classList.remove("dragging", "drop-target", "drop-nest-target");
    });
    draggedCategoryId = null;
    draggedParentId = null;
    draggedCategoryStartX = null;
  });

  tree.addEventListener("drop", async (e) => {
    const target = e.target.closest(".category-node");
    if (!target || draggedCategoryId === null) return;

    const targetCategoryId = Number(target.dataset.categoryId);
    const targetParentId = target.dataset.parentId ? Number(target.dataset.parentId) : null;
    const dropOffsetX = draggedCategoryStartX === null ? 0 : e.clientX - draggedCategoryStartX;
    const shouldNest = dropOffsetX > 24;
    const destinationParentId = shouldNest ? targetCategoryId : targetParentId;

    e.preventDefault();

    const draggedNode = tree.querySelector(`[data-category-id="${draggedCategoryId}"]`);
    if (!draggedNode) return;

    const draggedItem = draggedNode.closest(".category-item");
    const targetItem = target.closest(".category-item");
    if (!draggedItem || !targetItem || draggedItem === targetItem) return;

    if (destinationParentId === draggedParentId) {
      const container = getCategoryContainerForNode(target);
      container.insertBefore(draggedItem, targetItem);

      const orderedIds = collectOrderedIds(container);
      try {
        await persistCategoryOrder(destinationParentId, orderedIds);
        await loadCategories();
      } catch (error) {
        showToast(`Error updating category order: ${error.message}`, "error");
        await loadCategories();
      }
      return;
    }

    try {
      await fetchAPI(`/categories/${draggedCategoryId}`, {
        method: "PUT",
        body: JSON.stringify({ parent_id: destinationParentId }),
      });
      await loadCategories();
    } catch (error) {
      showToast(`Error moving category: ${error.message}`, "error");
      await loadCategories();
    }
  });
}

function attachCategoryCollapseHandlers() {
  const tree = document.getElementById("categoriesTree");
  if (!tree || tree.dataset.collapseBound === "true") {
    return;
  }

  tree.dataset.collapseBound = "true";

  tree.addEventListener("click", (event) => {
    const toggle = event.target.closest(".category-toggle[data-category-id]");
    if (!toggle) {
      return;
    }

    const categoryId = Number(toggle.dataset.categoryId);
    const children = tree.querySelector(`.category-children[data-category-id="${CSS.escape(String(categoryId))}"]`);
    if (!children) {
      return;
    }

    const isCollapsed = children.classList.toggle("hidden");
    toggle.classList.toggle("collapsed", isCollapsed);
    toggle.setAttribute("aria-expanded", String(!isCollapsed));

    if (isCollapsed) {
      collapsedCategoryIds.add(categoryId);
    } else {
      collapsedCategoryIds.delete(categoryId);
    }
  });

  tree.addEventListener("keydown", (event) => {
    const toggle = event.target.closest(".category-toggle[data-category-id]");
    if (!toggle || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }

    event.preventDefault();
    toggle.click();
  });
}

function renderCategoryParentSelect() {
  const select = document.getElementById("catParent");
  const currentValue = select.value;
  select.innerHTML = '<option value="">None (Root)</option>';

  const flatCategories = flattenCategories(allCategories);
  flatCategories.forEach((category) => {
    if (currentEditingCategoryId !== category.id) {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = "  ".repeat(getDepth(category)) + category.name;
      select.appendChild(option);
    }
  });

  if (currentValue) select.value = currentValue;
}

function flattenCategories(categories, flat = []) {
  if (!Array.isArray(categories)) {
    return flat;
  }

  categories.forEach((cat) => {
    flat.push(cat);
    if (Array.isArray(cat.children) && cat.children.length > 0) {
      flattenCategories(cat.children, flat);
    }
  });
  return flat;
}

function getDepth(category, depth = 0) {
  if (!category.parent_id) return depth;
  const parent = findCategoryById(allCategories, category.parent_id, []);
  if (!parent) return depth;
  return depth + 1;
}

function findCategoryById(categories, id, result) {
  if (!Array.isArray(categories)) {
    return null;
  }

  for (const cat of categories) {
    if (cat.id === id) return cat;
    if (Array.isArray(cat.children) && cat.children.length > 0) {
      const found = findCategoryById(cat.children, id, result);
      if (found) return found;
    }
  }
  return null;
}

async function selectCategory(categoryId) {
  selectedCategoryId = categoryId;
  await loadSubscriptions(categoryId);
  updateUI();
}

function selectSpecialFilter(filterType) {
  if (filterType === "all") {
    selectedCategoryId = null;
    loadSubscriptions(null);
  } else if (filterType === "uncategorized") {
    selectedCategoryId = "uncategorized";
    loadSubscriptions("uncategorized");
  }
  updateUI();
}

function updateUI() {
  // Update category nodes
  document.querySelectorAll(".category-node").forEach((node) => {
    node.classList.remove("active");
  });

  // Update special filters
  document.querySelectorAll(".special-filter-item").forEach((item) => {
    item.classList.remove("active");
  });

  if (selectedCategoryId === null) {
    document.getElementById("filterAll")?.classList.add("active");
  } else if (selectedCategoryId === "uncategorized") {
    document.getElementById("filterUncategorized")?.classList.add("active");
  } else {
    const selectedNode = document.querySelector(
      `.category-node[data-category-id="${selectedCategoryId}"]`
    );
    if (selectedNode) {
      selectedNode.classList.add("active");
    }
  }

  let categoryName;
  if (selectedCategoryId === null) {
    categoryName = "All";
  } else if (selectedCategoryId === "uncategorized") {
    categoryName = "Uncategorized";
  } else {
    const category = findCategoryById(allCategories, selectedCategoryId, []);
    categoryName = category ? category.name : "All";
  }

  document.getElementById("contentTitle").textContent = categoryName;
}

function openCategoryModal(categoryId = null) {
  currentEditingCategoryId = categoryId;
  const modal = document.getElementById("categoryModal");
  const form = document.getElementById("categoryForm");

  if (categoryId) {
    const category = findCategoryById(allCategories, categoryId, []);
    document.getElementById("categoryModalTitle").textContent = "Edit Category";
    document.getElementById("catName").value = category.name;
    document.getElementById("catDescription").value = category.description || "";
    document.getElementById("catParent").value = category.parent_id || "";
  } else {
    document.getElementById("categoryModalTitle").textContent = "New Category";
    form.reset();
  }

  renderCategoryParentSelect();
  showModal("categoryModal");
}

async function saveCategory(e) {
  e.preventDefault();

  const name = document.getElementById("catName").value;
  const description = document.getElementById("catDescription").value;
  const parentId = document.getElementById("catParent").value || null;

  try {
    showSpinner();

    if (currentEditingCategoryId) {
      await fetchAPI(`/categories/${currentEditingCategoryId}`, {
        method: "PUT",
        body: JSON.stringify({ name, description, parent_id: parentId }),
      });
    } else {
      await fetchAPI("/categories", {
        method: "POST",
        body: JSON.stringify({ name, description, parent_id: parentId }),
      });
    }

    await loadCategories();
    hideModal("categoryModal");
  } catch (error) {
    showToast(`Error saving category: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

async function editCategory(categoryId) {
  openCategoryModal(categoryId);
}

async function deleteCategory(categoryId) {
  if (!await showConfirm("Are you sure? This will delete the category and its children.", "Delete Category")) {
    return;
  }

  try {
    showSpinner();
    await fetchAPI(`/categories/${categoryId}`, { method: "DELETE" });
    if (selectedCategoryId === categoryId) {
      selectedCategoryId = null;
    }
    await loadCategories();
    await loadSubscriptions();
  } catch (error) {
    showToast(`Error deleting category: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

// ============================================================================
// Category Import / Export
// ============================================================================

async function exportCategories() {
  try {
    showSpinner();
    const response = await fetch(`${API_BASE}/categories/export`);
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || `Export failed: ${response.status}`);
    }
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : "categories_export.json";

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Categories exported", "success");
  } catch (error) {
    showToast(`Export error: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

async function importCategories(event) {
  const file = event.target.files[0];
  if (!file) return;

  // Reset so the same file can be re-selected
  event.target.value = "";

  const ok = await showConfirm(
    "Import categories from this file? New categories will be created and subscriptions assigned to matching channels.",
    "Import Categories"
  );
  if (!ok) return;

  try {
    showSpinner();
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch(`${API_BASE}/categories/import`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || `Import failed: ${response.status}`);
    }

    const result = await response.json();
    await loadCategories();
    await loadSubscriptions();

    const parts = [];
    if (result.created_categories) parts.push(`${result.created_categories} new categories`);
    if (result.created_subscriptions) parts.push(`${result.created_subscriptions} new subscriptions`);
    if (result.assignments_added) parts.push(`${result.assignments_added} assignments`);
    if (result.updated_channels) parts.push(`${result.updated_channels} channels updated`);
    showToast(`Import complete: ${parts.join(", ") || "no changes"}`, "success");
  } catch (error) {
    showToast(`Import error: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

// ============================================================================
// Subscription functions
// ============================================================================

let subscriptionsPage = 1;
let subscriptionsHasMore = false;

async function loadSubscriptions(categoryId = null) {
  try {
    showSpinner();
    selectedCategoryId = categoryId;
    subscriptionsPage = 1;
    subscriptionsLoadingMore = false;
    const endpoint = getSubscriptionsEndpoint(categoryId);
    const data = await fetchAPI(`${endpoint}${endpoint.includes('?') ? '&' : '?'}page=1&per_page=50`);
    allSubscriptions = data.items;
    subscriptionsHasMore = data.has_more;
    renderSubscriptions();
  } catch (error) {
    showToast(`Error loading subscriptions: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

async function loadMoreSubscriptions() {
  try {
    if (subscriptionsLoadingMore || !subscriptionsHasMore || currentSearchQuery) {
      return;
    }

    subscriptionsLoadingMore = true;
    const container = document.getElementById("subscriptionsList");
    setLoadMoreIndicator(container, true);
    const endpoint = getSubscriptionsEndpoint();
    const nextPage = subscriptionsPage + 1;
    const data = await fetchAPI(`${endpoint}${endpoint.includes('?') ? '&' : '?'}page=${nextPage}&per_page=50`);
    const newSubscriptions = data.items;
    allSubscriptions = allSubscriptions.concat(newSubscriptions);
    subscriptionsHasMore = data.has_more;
    subscriptionsPage = nextPage;

    if (container) {
      resetScrollSentinel(container);

      const fragment = document.createElement("div");
      fragment.innerHTML = newSubscriptions.map((sub) => {
        const isSelected = selectedSubscriptionIds.includes(sub.id);
        return `
        <div class="list-item subscription-item ${isSelected ? "selected" : ""}" data-subscription-id="${sub.id}" onclick="toggleSubscriptionSelection(${sub.id}, event)">
            <input type="checkbox" class="list-item-checkbox" ${isSelected ? "checked" : ""} onclick="event.stopPropagation(); toggleSubscriptionSelection(${sub.id}, event)">
            <img src="${sub.thumbnail_url || ''}" 
                 alt="${sub.channel_title}" 
                 class="list-item-thumb subscription-thumbnail"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
            <span class="material-icons list-item-thumb subscription-thumbnail subscription-thumb-fallback" style="display:none">account_circle</span>
            <div class="list-item-info" onclick="event.stopPropagation(); window.open('https://www.youtube.com/channel/${sub.channel_id}', '_blank')">
                <div class="list-item-title">${sub.channel_title}</div>
                <div class="list-item-subtitle">${sub.channel_description || "No description"}</div>
                <div class="list-item-meta">
                    ${sub.categories && sub.categories.length > 0
          ? sub.categories
            .map((cat) => `<span class="category-badge">${cat.name}</span>`)
            .join("")
          : '<span class="text-muted">Uncategorized</span>'
        }
                </div>
            </div>
            <button class="btn-action btn-action-danger btn-action-reveal" onclick="event.stopPropagation(); unsubscribeChannel(${sub.id})" title="Unsubscribe">
                <span class="material-icons">delete</span>
            </button>
        </div>
    `;
      }).join("");

      while (fragment.firstChild) {
        container.appendChild(fragment.firstChild);
      }

      if (subscriptionsHasMore && !currentSearchQuery) setLoadMoreIndicator(container, false);

      bindAutoLoadOnScroll(
        container,
        loadMoreSubscriptions,
        () => subscriptionsHasMore && !currentSearchQuery,
        () => subscriptionsLoadingMore
      );
    }
  } catch (error) {
    showToast(`Error loading more subscriptions: ${error.message}`, "error");
  } finally {
    const container = document.getElementById("subscriptionsList");
    if (container) {
      if (subscriptionsHasMore && !currentSearchQuery) {
        setLoadMoreIndicator(container, false);
      } else {
        resetScrollSentinel(container);
      }
    }
    subscriptionsLoadingMore = false;
  }
}

function renderSubscriptions(subscriptions = allSubscriptions) {
  const container = document.getElementById("subscriptionsList");

  if (subscriptions.length === 0) {
    container.innerHTML = `
            <div class="empty-state">
                <p>No subscriptions found.</p>
                <button class="btn btn-primary" onclick="syncSubscriptions()">Sync from YouTube</button>
            </div>
        `;
    return;
  }

  const html = subscriptions
    .map(
      (sub) => {
        const isSelected = selectedSubscriptionIds.includes(sub.id);
        return `
        <div class="list-item subscription-item ${isSelected ? "selected" : ""}" data-subscription-id="${sub.id}" onclick="toggleSubscriptionSelection(${sub.id}, event)">
            <input type="checkbox" class="list-item-checkbox" ${isSelected ? "checked" : ""} onclick="event.stopPropagation(); toggleSubscriptionSelection(${sub.id}, event)">
            <img src="${sub.thumbnail_url || ''}" 
                 alt="${sub.channel_title}" 
                 class="list-item-thumb subscription-thumbnail"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
            <span class="material-icons list-item-thumb subscription-thumbnail subscription-thumb-fallback" style="display:none">account_circle</span>
            <div class="list-item-info" onclick="event.stopPropagation(); window.open('https://www.youtube.com/channel/${sub.channel_id}', '_blank')">
                <div class="list-item-title">${sub.channel_title}</div>
                <div class="list-item-subtitle">${sub.channel_description || "No description"}</div>
                <div class="list-item-meta">
                    ${sub.categories && sub.categories.length > 0
          ? sub.categories
            .map((cat) => `<span class="category-badge">${cat.name}</span>`)
            .join("")
          : '<span class="text-muted">Uncategorized</span>'
        }
                </div>
            </div>
            <button class="btn-action btn-action-danger btn-action-reveal" onclick="event.stopPropagation(); unsubscribeChannel(${sub.id})" title="Unsubscribe">
                <span class="material-icons">delete</span>
            </button>
        </div>
    `;
      }
    )
    .join("");

  container.innerHTML = html;

  if (subscriptionsHasMore && !currentSearchQuery) {
    setLoadMoreIndicator(container, false);
  } else {
    const indicator = container.querySelector(".load-more-indicator");
    if (indicator) {
      indicator.remove();
    }
  }

  bindAutoLoadOnScroll(container, loadMoreSubscriptions, () => subscriptionsHasMore && !currentSearchQuery, () => subscriptionsLoadingMore);
}

// ============================================================================
// Queue functions
// ============================================================================

async function loadQueue() {
  try {
    showSpinner();
    const data = await fetchAPI("/queue");
    allQueueItems = data.items || [];
    renderQueue();
  } catch (error) {
    showToast(`Error loading queue: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

function renderQueue() {
  const container = document.getElementById("queueList");
  if (!container) {
    return;
  }

  if (!allQueueItems.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = allQueueItems.map((item, index) => renderQueueItem(item, index)).join("");
  attachQueueDragHandlers(container);
  applyWatchedState(container, allQueueItems.map((item) => item.video).filter(Boolean));
}

function renderQueueItem(item, index) {
  const video = item.video || {};
  if (!video.video_id) {
    return `
      <div class="list-item video-item queue-item watched" draggable="true" data-queue-item-id="${item.id}">
        <div class="list-item-info">
          <div class="list-item-title">Unavailable video</div>
          <div class="list-item-subtitle">This queue entry no longer has a matching video record.</div>
        </div>
        <div class="action-group video-item-actions-below">
          <button class="btn-action playlist-drag-handle" type="button" title="Drag to reorder" aria-label="Drag to reorder">
            <span class="material-icons">drag_indicator</span>
          </button>
          <button class="btn-action btn-action-danger btn-action-reveal" onclick="event.preventDefault(); event.stopPropagation(); removeQueueItem(${item.id})" title="Remove from queue">
            <span class="material-icons">close</span>
          </button>
        </div>
      </div>
    `;
  }

  return renderVideoItem(video, {
    showQueueAction: false,
    showRemoveAction: true,
    queueItemId: item.id,
    extraClass: "queue-item",
    enableQueueReorder: true,
  });
}

async function addVideoToQueue(videoId) {
  try {
    const result = await fetchAPI("/queue", {
      method: "POST",
      body: JSON.stringify({ video_id: videoId }),
    });
    allQueueItems = result.items || allQueueItems;
    renderQueue();
    showToast("Video added to queue", "success");
  } catch (error) {
    showToast(`Error adding video to queue: ${error.message}`, "error");
  }
}

async function removeQueueItem(queueItemId) {
  try {
    const result = await fetchAPI(`/queue/${queueItemId}`, { method: "DELETE" });
    allQueueItems = result.items || [];
    renderQueue();
  } catch (error) {
    showToast(`Error removing queue item: ${error.message}`, "error");
  }
}

function attachQueueDragHandlers(container) {
  if (!container || container.dataset.dragBound === "true") {
    return;
  }

  container.dataset.dragBound = "true";

  container.addEventListener("dragstart", (event) => {
    const item = event.target.closest(".queue-item[data-queue-item-id]");
    if (!item) {
      return;
    }

    draggedQueueItemId = item.dataset.queueItemId;
    item.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedQueueItemId);
  });

  container.addEventListener("dragover", (event) => {
    const target = event.target.closest(".queue-item[data-queue-item-id]");
    if (!target || !draggedQueueItemId) {
      return;
    }

    event.preventDefault();
    target.classList.add("drop-target");
  });

  container.addEventListener("dragleave", (event) => {
    const target = event.target.closest(".queue-item[data-queue-item-id]");
    if (target) {
      target.classList.remove("drop-target");
    }
  });

  container.addEventListener("dragend", () => {
    container.querySelectorAll(".queue-item").forEach((item) => {
      item.classList.remove("dragging", "drop-target");
    });
    draggedQueueItemId = null;
  });

  container.addEventListener("drop", async (event) => {
    const target = event.target.closest(".queue-item[data-queue-item-id]");
    if (!target || !draggedQueueItemId) {
      return;
    }

    event.preventDefault();

    const draggedItem = container.querySelector(`[data-queue-item-id="${CSS.escape(draggedQueueItemId)}"]`);
    if (!draggedItem || draggedItem === target) {
      return;
    }

    container.insertBefore(draggedItem, target);

    const orderedIds = collectOrderedQueueItemIds(container);
    try {
      const result = await persistQueueOrder(orderedIds);
      allQueueItems = result.items || allQueueItems;
      renderQueue();
      showToast("Queue order updated", "success");
    } catch (error) {
      showToast(`Error updating queue order: ${error.message}`, "error");
      await loadQueue();
    }
  });
}

async function createPlaylistFromQueue() {
  try {
    showSpinner();
    const result = await fetchAPI("/queue/create-playlist", { method: "POST" });
    allQueueItems = result.items || [];
    renderQueue();
    if (result.playlist_url) {
      window.open(result.playlist_url, "_blank", "noopener");
    }
    showToast(`Created playlist with ${result.added_count || 0} video${result.added_count === 1 ? "" : "s"}`, "success");
  } catch (error) {
    showToast(`Error creating playlist: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

async function castQueue() {
  try {
    showSpinner();
    if (!allQueueItems.length) {
      throw new Error("Queue is empty");
    }

    logCastDebug("Starting queue playback", {
      queueSize: allQueueItems.length,
      activePlayback: queuePlaybackActive,
    });

    // Step 1 – ensure Cast framework is ready and get a session
    initializeCastFramework();
    const session = await requestCastSession();
    logCastDebug("Cast session obtained for queue playback");

    // Step 2 – get the YouTube receiver's screenId via MDX (use cached if available)
    const screenId = _receiverScreenId || await getYouTubeScreenId(session);
    logCastDebug("screenId obtained", { screenId });

    // Step 3 – send screenId to backend; backend creates playlist and
    //          starts playback via the YouTube Lounge HTTP API.
    logCastDebug("Calling backend /queue/cast with screenId");
    const result = await fetchAPI("/queue/cast", {
      method: "POST",
      body: JSON.stringify({ screen_id: screenId }),
    });
    logCastDebug("Backend /queue/cast response", result);

    if (result.error) {
      throw new Error(result.error);
    }

    allQueueItems = result.items || allQueueItems;
    queuePlaybackActive = true;
    renderQueue();
    startQueueSyncPolling();

    const deviceName = session.getCastDevice ? session.getCastDevice()?.friendlyName : null;
    updateCastReceiverStatus();
    logCastDebug("Queue playback started via Lounge API", {
      deviceName,
      playlistId: result.playlist_id || null,
      loungeSuccess: result.lounge ? result.lounge.success : null,
      loungeVideoId: result.lounge ? result.lounge.video_id : null,
      loungeSid: result.lounge ? result.lounge.lounge_sid : null,
      loungeScreenId: result.lounge ? result.lounge.screen_id : null,
    });

    showToast(
      deviceName
        ? `Playing ${allQueueItems.length} video${allQueueItems.length === 1 ? "" : "s"} on ${deviceName}`
        : `Playing ${allQueueItems.length} video${allQueueItems.length === 1 ? "" : "s"} via Cast`,
      "success"
    );
  } catch (error) {
    console.error("[Cast] Error starting queue playback", error);
    const message = error && error.message ? error.message : String(error || "Unknown error");
    showToast(`Error starting queue playback: ${message}`, "error");
  } finally {
    hideSpinner();
  }
}

function startQueueSyncPolling() {
  if (queueSyncInterval) {
    return;
  }

  queueSyncInterval = setInterval(refreshQueueProgress, 10000);
  refreshQueueProgress();
}

function stopQueueSyncPolling() {
  if (queueSyncInterval) {
    clearInterval(queueSyncInterval);
    queueSyncInterval = null;
  }
  queuePlaybackActive = false;
}

async function refreshQueueProgress() {
  if (!queuePlaybackActive) {
    return;
  }

  try {
    logCastDebug("Refreshing queue playback progress");
    const result = await fetchAPI("/queue/refresh-progress", { method: "POST" });
    allQueueItems = result.items || [];
    logCastDebug("Queue playback progress refreshed", {
      remainingQueueItems: allQueueItems.length,
    });
    renderQueue();

    if (!allQueueItems.length) {
      stopQueueSyncPolling();
      showToast("Queue playback completed", "info");
    }
  } catch (error) {
    console.error("[Cast] Error refreshing queue progress", error);
    showToast(`Error refreshing queue progress: ${error.message}`, "error");
    stopQueueSyncPolling();
  }
}

async function syncSubscriptions() {
  return startFullSync(false);
}

async function unsubscribeChannel(subId) {
  const subscription = allSubscriptions.find(s => s.id === subId);
  if (!subscription) return;

  if (!await showConfirm(`Are you sure you want to unsubscribe from "${subscription.channel_title}"?\n\nThis will remove the subscription from both YouTube and this app.`, "Unsubscribe")) {
    return;
  }

  try {
    showSpinner();
    const result = await fetchAPI(`/subscriptions/${subId}`, { method: "DELETE" });
    
    // Remove from local array
    allSubscriptions = allSubscriptions.filter(s => s.id !== subId);
    
    // Remove from selection if selected
    selectedSubscriptionIds = selectedSubscriptionIds.filter(id => id !== subId);
    
    // Re-render
    renderSubscriptions(getFilteredSubscriptions());
    renderCategoriesTree();
    
    showToast(result.message || `Unsubscribed from "${subscription.channel_title}"`, "success");
  } catch (error) {
    showToast(`Error unsubscribing: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

// ============================================================================
// Subscription Selection Functions
// ============================================================================

function getFilteredSubscriptions() {
  if (!currentSearchQuery) {
    return allSubscriptions;
  }
  return allSubscriptions.filter(
    (sub) =>
      (sub.channel_title || "").toLowerCase().includes(currentSearchQuery) ||
      (sub.channel_description || "").toLowerCase().includes(currentSearchQuery)
  );
}

function toggleSubscriptionSelection(subscriptionId, event) {
  const index = selectedSubscriptionIds.indexOf(subscriptionId);
  
  if (index > -1) {
    selectedSubscriptionIds.splice(index, 1);
  } else {
    selectedSubscriptionIds.push(subscriptionId);
  }
  
  // Clear suggestions when selection changes
  suggestedCategoryIds = [];
  
  // Preserve current filter when re-rendering
  const filtered = getFilteredSubscriptions();
  renderSubscriptions(filtered);
  renderCategoriesTree();
}

async function handleCategoryAssignment(categoryId, event) {
  event.stopPropagation();
  
  if (selectedSubscriptionIds.length === 0) return;
  
  const checkbox = event.target;
  const isChecked = checkbox.checked;
  
  try {
    showSpinner();
    
    // Perform all assignments/unassignments in parallel
    const promises = selectedSubscriptionIds.map(subId => {
      if (isChecked) {
        return fetchAPI(`/subscriptions/${subId}/categories/${categoryId}`, {
          method: "POST",
        });
      } else {
        return fetchAPI(`/subscriptions/${subId}/categories/${categoryId}`, {
          method: "DELETE",
        });
      }
    });
    
    await Promise.all(promises);
    await loadSubscriptions(selectedCategoryId);
    renderCategoriesTree();
  } catch (error) {
    showToast(`Error updating assignments: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

// ============================================================================
// AI Suggestions
// ============================================================================

async function fetchAISuggestions() {
  if (selectedSubscriptionIds.length !== 1) {
    return;
  }
  
  const subscriptionId = selectedSubscriptionIds[0];
  
  try {
    showSpinner();
    const result = await fetchAPI(`/subscriptions/${subscriptionId}/suggestions`);
    suggestedCategoryIds = result.suggested_category_ids || [];
    renderCategoriesTree();
  } catch (error) {
    showToast(`Error fetching suggestions: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

// ============================================================================
// Search
// ============================================================================

document.addEventListener("DOMContentLoaded", () => {
  const searchInput = document.getElementById("searchInput");
  searchInput.addEventListener("input", (e) => {
    currentSearchQuery = e.target.value.toLowerCase();
    const filtered = getFilteredSubscriptions();
    renderSubscriptions(filtered);
  });
});

// ============================================================================
// Event listeners
// ============================================================================

document.addEventListener("DOMContentLoaded", () => {
  // Category modal buttons
  document.getElementById("newCategoryBtn").addEventListener("click", () => {
    openCategoryModal();
  });

  document.getElementById("categoryForm").addEventListener("submit", saveCategory);

  // Suggestions button
  document.getElementById("getSuggestionsBtn").addEventListener("click", fetchAISuggestions);

  // Import / Export categories
  document.getElementById("exportCategoriesBtn").addEventListener("click", exportCategories);
  document.getElementById("importCategoriesBtn").addEventListener("click", () => {
    document.getElementById("importCategoriesFile").click();
  });
  document.getElementById("importCategoriesFile").addEventListener("change", importCategories);

  // Unified sync button (navbar)
  document.getElementById("syncBtn").addEventListener("click", () => startFullSync(false));

  // Initial load
  initializeCastFramework();
  loadCategories().then(() => loadFeeds());
  loadQueue();
  loadSubscriptions().then(() => {
    updateUI(); // Highlight "All" filter by default
  });
  document.getElementById("newFeedBtn").classList.remove("d-none");

  // Restore sync progress if a sync is already running
  _checkAndRestoreSync();

  // Sidebar resizer
  initSidebarResizer();
});

// ============================================================================
// Sidebar Resizer
// ============================================================================

const SIDEBAR_WIDTH_KEY = "categoriesSidebarWidth";

function initSidebarResizer() {
  const sidebar = document.getElementById("categoriesSidebar");
  const resizer = document.getElementById("sidebarResizer");
  if (!sidebar || !resizer) return;

  // Restore persisted width
  const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (saved) {
    sidebar.style.width = saved + "px";
  }

  let startX = 0;
  let startWidth = 0;

  function onMouseMove(e) {
    const newWidth = Math.max(120, Math.min(startWidth + (e.clientX - startX), window.innerWidth * 0.5));
    sidebar.style.width = newWidth + "px";
  }

  function onMouseUp() {
    resizer.classList.remove("active");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, parseInt(sidebar.style.width, 10));
  }

  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    resizer.classList.add("active");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}

// ============================================================================
// Section Navigation
// ============================================================================

function switchSection(section) {
  document.getElementById("sectionSubscriptions").classList.toggle("d-none", section !== "subscriptions");
  document.getElementById("sectionPlaylists").classList.toggle("d-none", section !== "playlists");
  document.getElementById("sectionFeeds").classList.toggle("d-none", section !== "feeds");

  document.querySelectorAll("#mainNav .nav-link").forEach(link => {
    link.classList.toggle("active", link.dataset.section === section);
  });

  const newFeedBtn = document.getElementById("newFeedBtn");
  const newCategoryBtn = document.getElementById("newCategoryBtn");
  const suggestionsBtn = document.getElementById("getSuggestionsBtn");
  const exportBtn = document.getElementById("exportCategoriesBtn");
  const importBtn = document.getElementById("importCategoriesBtn");
  if (section === "feeds") {
    newFeedBtn.classList.remove("d-none");
    newCategoryBtn.classList.add("d-none");
    if (suggestionsBtn) suggestionsBtn.classList.add("d-none");
    exportBtn.classList.add("d-none");
    importBtn.classList.add("d-none");
    loadFeeds();
  } else if (section === "playlists") {
    newFeedBtn.classList.add("d-none");
    newCategoryBtn.classList.add("d-none");
    if (suggestionsBtn) suggestionsBtn.classList.add("d-none");
    exportBtn.classList.add("d-none");
    importBtn.classList.add("d-none");
    loadPlaylists();
  } else {
    newFeedBtn.classList.add("d-none");
    newCategoryBtn.classList.remove("d-none");
    if (suggestionsBtn) suggestionsBtn.classList.add("d-none");
    exportBtn.classList.remove("d-none");
    importBtn.classList.remove("d-none");
  }
}

// ============================================================================
// Feed Functions
// ============================================================================

let allFeeds = [];
let currentEditingFeedId = null;

async function loadFeeds() {
  try {
    showSpinner();
    allFeeds = await fetchAPI("/feeds");
    renderFeedColumns();
  } catch (error) {
    showToast(`Error loading feeds: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

function renderFeedColumns() {
  const container = document.getElementById("feedColumns");
  if (!container) {
    return;
  }

  const queueColumn = renderQueueColumn();

  if (allFeeds.length === 0) {
    container.innerHTML = `${queueColumn}${renderEmptyFeedsColumn()}`;
    renderQueue();
    return;
  }

  container.innerHTML = `${queueColumn}${allFeeds.map(feed => `
    <div class="column-item flex-col flex-noshrink" data-feed-id="${feed.id}">
      <div class="card">
        <div class="card-header">
          <h6 class="mb-0 fw-semibold">${feed.name}</h6>
          <div class="action-group">
            <button class="btn-action" onclick="openFeedModal(${feed.id})" title="Edit"><span class="material-icons">edit</span></button>
          </div>
        </div>
        ${renderFeedFilterTags(feed)}
        <div class="flex-fill scrollable p-2" id="feedVideos-${feed.id}">
          <div class="text-center p-3 text-muted small">Loading...</div>
        </div>
      </div>
    </div>
  `).join("")}`;

  // Load videos for each feed
  allFeeds.forEach(feed => loadFeedVideos(feed.id));
  renderQueue();
}

function renderQueueColumn() {
  return `
    <div class="column-item flex-col flex-noshrink" data-column-type="queue">
      <div class="card">
        <div class="card-header">
          <h6 class="mb-0 fw-semibold">Queue</h6>
          <div id="queueToolbarActions" class="action-group">
            <span id="castReceiverStatus" class="text-muted small d-none d-md-inline"></span>
            <button class="btn-action" onclick="createPlaylistFromQueue()" title="Create YouTube playlist from queue" aria-label="Create YouTube playlist from queue">
              <span class="material-icons">playlist_add</span>
            </button>
            <button class="btn-action" onclick="castQueue()" title="Select a Google Cast receiver and start playback" aria-label="Select a Google Cast receiver and start playback">
              <span class="material-icons">cast</span>
            </button>
          </div>
        </div>
        <div id="queueList" class="flex-fill scrollable p-2">
          <!-- Queue items rendered here -->
        </div>
      </div>
    </div>
  `;
}

function renderEmptyFeedsColumn() {
  return `
    <div class="column-item flex-col flex-noshrink">
      <div class="card flex-fill">
        <div class="empty-state flex-fill d-flex flex-column justify-content-center align-items-center">
          <p>No feeds yet. Create one to get started!</p>
          <button class="btn btn-primary btn-sm" onclick="openFeedModal()">+ New Feed</button>
        </div>
      </div>
    </div>
  `;
}

function renderFeedFilterTags(feed) {
  const tags = [];
  const groups = feed.filter_category_ids || [];
  if (groups.length > 0) {
    const groupLabels = groups.map(group => {
      const names = group.map(id => {
        const cat = findFeedCategoryById(id);
        return cat ? cat.name : `#${id}`;
      });
      return names.length > 1 ? `(${names.join(" | ")})` : names[0];
    });
    tags.push(`<span class="material-icons md-sm">folder</span> ${groupLabels.join(" & ")}`);
  }
  if (feed.filter_video_type) tags.push(`<span class="material-icons md-sm">movie</span> ${feed.filter_video_type}`);
  if (feed.filter_min_duration != null || feed.filter_max_duration != null) {
    const min = feed.filter_min_duration != null ? `${Math.round(feed.filter_min_duration / 60)}m` : "0m";
    const max = feed.filter_max_duration != null ? `${Math.round(feed.filter_max_duration / 60)}m` : "∞";
    tags.push(`<span class="material-icons md-sm">timer</span> ${min}–${max}`);
  }
  if (feed.filter_max_age_days) tags.push(`<span class="material-icons md-sm">calendar_today</span> Last ${feed.filter_max_age_days}d`);
  if (feed.filter_play_state === "played") tags.push(`<span class="material-icons md-sm">done_all</span> Played only`);
  if (feed.filter_play_state === "unplayed") tags.push(`<span class="material-icons md-sm">visibility_off</span> Unplayed only`);

  if (tags.length === 0) return "";
  return `<div class="tag-list">${tags.map(t => `<span class="tag">${t}</span>`).join("")}</div>`;
}

function findFeedCategoryById(id, categories = allCategories) {
  if (!Array.isArray(categories)) {
    return null;
  }

  for (const cat of categories) {
    if (cat.id === id) return cat;
    if (Array.isArray(cat.children) && cat.children.length > 0) {
      const found = findFeedCategoryById(id, cat.children);
      if (found) return found;
    }
  }
  return null;
}

function renderVideoItem(v, options = {}) {
  const showQueueAction = options.showQueueAction !== false;
  const actionButtons = [];

  if (options.enableQueueReorder && options.queueItemId) {
    actionButtons.push(`
      <button class="btn-action playlist-drag-handle" type="button" title="Drag to reorder" aria-label="Drag to reorder">
        <span class="material-icons">drag_indicator</span>
      </button>
    `);
  }

  if (options.enablePlaylistReorder && v.playlist_item_id) {
    actionButtons.push(`
      <button class="btn-action playlist-drag-handle" type="button" title="Drag to reorder" aria-label="Drag to reorder">
        <span class="material-icons">drag_indicator</span>
      </button>
    `);
  }

  if (options.showPlaylistAction && v.video_id) {
    actionButtons.push(`
      <button class="btn-action btn-action-reveal" type="button" data-action="add-to-playlist" data-video-id="${v.video_id}" data-video-title="${encodeURIComponent(v.title || "video")}" title="Add to playlist">
        <span class="material-icons">playlist_add_check</span>
      </button>
    `);
  }

  if (showQueueAction && v.video_id) {
    actionButtons.push(`
      <button class="btn-action btn-action-reveal" onclick="event.preventDefault(); event.stopPropagation(); addVideoToQueue('${v.video_id}')" title="Add to queue">
        <span class="material-icons">playlist_add</span>
      </button>
    `);
  }

  const removeActionOnclick = options.removeActionOnclick || (
    options.queueItemId !== undefined && options.queueItemId !== null
      ? `event.preventDefault(); event.stopPropagation(); removeQueueItem(${options.queueItemId})`
      : ""
  );

  if (options.showRemoveAction && removeActionOnclick) {
    actionButtons.push(`
      <button class="btn-action btn-action-danger btn-action-reveal" onclick="${removeActionOnclick}" title="Remove">
        <span class="material-icons">close</span>
      </button>
    `);
  }

  if (!v.video_id) {
    return `
      <div class="list-item video-item ${options.extraClass || ""} video-item-stack ${options.enablePlaylistReorder ? "playlist-item" : ""} ${options.enableQueueReorder ? "queue-item" : ""}" ${(options.enablePlaylistReorder && v.playlist_item_id) ? `draggable="true" data-playlist-item-id="${v.playlist_item_id}" data-playlist-id="${options.playlistId || ""}"` : ""} ${(options.enableQueueReorder && options.queueItemId) ? `draggable="true" data-queue-item-id="${options.queueItemId}"` : ""} data-video-id="">
        <div class="video-item-content">
          <div class="thumb-stack">
            <div class="thumb-container">
              <div class="list-item-thumb list-item-thumb-lg bg-light d-flex align-items-center justify-content-center text-muted">
                <span class="material-icons">videocam_off</span>
              </div>
            </div>
            <div class="action-group video-item-actions video-item-actions-below">
              ${actionButtons.join("")}
            </div>
          </div>
          <div class="list-item-info">
            <div class="list-item-title">Unavailable video</div>
            <div class="list-item-subtitle">This item no longer has an available video record.</div>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="list-item video-item ${options.extraClass || ""} video-item-stack ${options.enablePlaylistReorder ? "playlist-item" : ""} ${options.enableQueueReorder ? "queue-item" : ""}" ${(options.enablePlaylistReorder && v.playlist_item_id) ? `draggable="true" data-playlist-item-id="${v.playlist_item_id}" data-playlist-id="${options.playlistId || ""}"` : ""} ${(options.enableQueueReorder && options.queueItemId) ? `draggable="true" data-queue-item-id="${options.queueItemId}"` : ""} data-video-id="${v.video_id}">
      <div class="video-item-content">
        <div class="thumb-stack">
          <a class="video-item-link video-item-media-link text-decoration-none text-reset" href="https://youtube.com/watch?v=${encodeURIComponent(v.video_id)}" target="_blank" rel="noopener">
            <div class="thumb-container">
              <img class="list-item-thumb list-item-thumb-lg" src="${v.thumbnail_url || ''}" alt="" loading="lazy">
              ${v.duration_seconds ? `<span class="duration-badge">${formatDuration(v.duration_seconds)}</span>` : ''}
              ${typeof v.playback_progress === "number" ? `<div class="progress-bar-container"><div class="progress-bar-fill" style="width:${Math.max(0, Math.min(100, v.playback_progress))}%"></div></div>` : ''}
            </div>
          </a>
          <div class="action-group video-item-actions video-item-actions-below">
            ${actionButtons.join("")}
          </div>
        </div>
        <a class="video-item-link flex-fill d-flex flex-column text-decoration-none text-reset" href="https://youtube.com/watch?v=${encodeURIComponent(v.video_id)}" target="_blank" rel="noopener">
          <div class="list-item-info">
            <div class="list-item-title">${escapeHtml(v.title || "Untitled video")}</div>
            <div class="list-item-subtitle">${escapeHtml(v.channel_title || "")}</div>
            <div class="list-item-meta">${v.published_at ? escapeHtml(timeAgo(v.published_at)) : ''}</div>
          </div>
        </a>
      </div>
    </div>
  `;
}

function applyWatchedState(container, videos) {
  for (const v of videos) {
    if (v.playback_progress >= 95) {
      const link = container.querySelector(`a[data-video-id="${CSS.escape(v.video_id)}"]`);
      if (link) {
        link.classList.add('watched');
        const thumbContainer = link.querySelector('.thumb-container');
        if (thumbContainer) {
          let bar = thumbContainer.querySelector('.progress-bar-container');
          if (!bar) {
            bar = document.createElement('div');
            bar.className = 'progress-bar-container';
            bar.innerHTML = `<div class="progress-bar-fill" style="width:100%"></div>`;
            thumbContainer.appendChild(bar);
          } else {
            const fill = bar.querySelector('.progress-bar-fill');
            if (fill) {
              fill.style.width = '100%';
            }
          }
        }
      }
    }
  }
}

function renderVideoListContainer(videos, loadMoreEnabled, options = {}) {
  const listHtml = videos.map((video) => renderVideoItem(video, options)).join("");
  const sentinelHtml = loadMoreEnabled
    ? `<div class="load-more-indicator d-none"><div class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></div><span>Loading more</span></div>`
    : "";
  return listHtml + sentinelHtml;
}

async function ensurePlaylistsLoaded() {
  if (allPlaylists.length) {
    return;
  }

  const data = await fetchAPI("/playlists");
  allPlaylists = data.items || [];
}

function renderPlaylistSelectOptions() {
  if (!allPlaylists.length) {
    return '<option value="">No playlists available</option>';
  }

  return ["<option value=\"\">Select a playlist</option>"]
    .concat(allPlaylists.map((playlist) => `<option value="${playlist.playlist_id}">${playlist.title}</option>`))
    .join("");
}

async function openAddToPlaylistModal(videoId, videoTitle = "video") {
  try {
    showSpinner();
    pendingPlaylistVideo = { videoId, videoTitle };
    await ensurePlaylistsLoaded();

    const modalTitle = document.getElementById("addToPlaylistModalTitle");
    const videoLabel = document.getElementById("addToPlaylistVideoTitle");
    const playlistSelect = document.getElementById("playlistSelect");
    const confirmButton = document.getElementById("addToPlaylistConfirmBtn");

    if (!modalTitle || !videoLabel || !playlistSelect || !confirmButton) {
      throw new Error("Playlist picker modal is missing");
    }

    modalTitle.textContent = "Add to Playlist";
    videoLabel.textContent = videoTitle;
    playlistSelect.innerHTML = renderPlaylistSelectOptions();
    playlistSelect.value = "";
    confirmButton.disabled = !allPlaylists.length;

    showModal("addToPlaylistModal");
  } catch (error) {
    pendingPlaylistVideo = null;
    showToast(`Error opening playlist picker: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

async function addVideoToPlaylist() {
  try {
    if (!pendingPlaylistVideo) {
      throw new Error("No video selected");
    }

    const playlistSelect = document.getElementById("playlistSelect");
    if (!playlistSelect || !playlistSelect.value) {
      throw new Error("Select a playlist first");
    }

    const playlistId = playlistSelect.value;
    const playlistTitle = allPlaylists.find((playlist) => playlist.playlist_id === playlistId)?.title || "playlist";

    showSpinner();
    const result = await fetchAPI(`/playlists/${playlistId}/items`, {
      method: "POST",
      body: JSON.stringify({ video_id: pendingPlaylistVideo.videoId }),
    });

    hideModal("addToPlaylistModal");
    pendingPlaylistVideo = null;
    showToast(result.added_count ? `Added to ${playlistTitle}` : "Video was not added to the playlist", result.added_count ? "success" : "info");
  } catch (error) {
    showToast(`Error adding video to playlist: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action='add-to-playlist']");
  if (!button) {
    const playlistButton = event.target.closest("[data-playlist-action]");
    if (!playlistButton) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const playlistAction = playlistButton.dataset.playlistAction;
    const playlistId = playlistButton.dataset.playlistId;
    const playlistTitle = playlistButton.dataset.playlistTitle ? decodeURIComponent(playlistButton.dataset.playlistTitle) : "playlist";

    if (playlistAction === "cast") {
      castPlaylist(playlistId);
    } else if (playlistAction === "delete") {
      deletePlaylist(playlistId, playlistTitle);
    }
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const videoId = button.dataset.videoId;
  const videoTitle = button.dataset.videoTitle ? decodeURIComponent(button.dataset.videoTitle) : "video";
  openAddToPlaylistModal(videoId, videoTitle);
});

function clearPendingPlaylistVideo() {
  pendingPlaylistVideo = null;
}

async function loadPlaylists() {
  try {
    showSpinner();
    const data = await fetchAPI("/playlists");
    allPlaylists = data.items || [];
    renderPlaylists();
    loadPlaylistItemsSequentially();
  } catch (error) {
    showToast(`Error loading playlists: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

function renderPlaylists() {
  const container = document.getElementById("playlistColumns");
  if (!container) {
    return;
  }

  if (!allPlaylists.length) {
    container.innerHTML = `
      <div class="column-item flex-col flex-noshrink">
        <div class="card flex-fill">
          <div class="empty-state flex-fill d-flex flex-column justify-content-center align-items-center">
            <p>No playlists found.</p>
            <button class="btn btn-primary btn-sm" onclick="loadPlaylists()">Refresh from YouTube</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = allPlaylists.map((playlist) => `
    <div class="column-item flex-col flex-noshrink" data-playlist-id="${playlist.playlist_id}">
      <div class="card">
        <div class="card-header">
          <div class="d-flex flex-column flex-fill me-2">
            <h6 class="mb-0 fw-semibold text-truncate" title="${escapeHtml(playlist.title)}">${escapeHtml(playlist.title)}</h6>
            <div class="text-muted small text-truncate">${playlist.item_count || 0} items${playlist.privacy_status ? ` • ${escapeHtml(playlist.privacy_status)}` : ""}</div>
          </div>
          <div class="action-group">
            <button class="btn-action" type="button" data-playlist-action="cast" data-playlist-id="${playlist.playlist_id}" title="Cast playlist"><span class="material-icons">cast</span></button>
            <button class="btn-action btn-action-danger" type="button" data-playlist-action="delete" data-playlist-id="${playlist.playlist_id}" data-playlist-title="${encodeURIComponent(playlist.title || "Playlist")}" title="Delete playlist"><span class="material-icons">delete</span></button>
          </div>
        </div>
        <div class="flex-fill scrollable p-2" id="playlistItems-${playlist.playlist_id}">
          <div class="text-center p-3 text-muted small">Loading...</div>
        </div>
      </div>
    </div>
  `).join("");

}

async function loadPlaylistItemsSequentially() {
  if (playlistItemsLoading || !allPlaylists.length) {
    return;
  }

  playlistItemsLoading = true;
  try {
    for (const playlist of allPlaylists) {
      await loadPlaylistItems(playlist.playlist_id);
    }
  } finally {
    playlistItemsLoading = false;
  }
}

function renderPlaylistItemsContainer(playlistId, items, loadMoreEnabled) {
  const safeItems = Array.isArray(items) ? items : [];
  const listHtml = safeItems.map((item) => renderVideoItem(item, {
    showQueueAction: false,
    showRemoveAction: true,
    removeActionOnclick: `event.preventDefault(); event.stopPropagation(); removePlaylistItem('${playlistId}', '${item.playlist_item_id}')`,
    extraClass: "playlist-item",
    enablePlaylistReorder: true,
    playlistId,
  })).join("");
  const sentinelHtml = loadMoreEnabled
    ? `<div class="load-more-indicator d-none"><div class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></div><span>Loading more</span></div>`
    : "";
  return listHtml + sentinelHtml;
}

function attachPlaylistDragHandlers(container, playlistId) {
  if (!container || container.dataset.dragBound === "true") {
    return;
  }

  container.dataset.dragBound = "true";

  container.addEventListener("dragstart", (event) => {
    const item = event.target.closest(".playlist-item[data-playlist-item-id]");
    if (!item || item.dataset.playlistId !== playlistId) {
      return;
    }

    draggedPlaylistItemId = item.dataset.playlistItemId;
    draggedPlaylistId = item.dataset.playlistId;
    item.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedPlaylistItemId);
  });

  container.addEventListener("dragover", (event) => {
    const target = event.target.closest(".playlist-item[data-playlist-item-id]");
    if (!target || target.dataset.playlistId !== draggedPlaylistId || !draggedPlaylistItemId) {
      return;
    }

    event.preventDefault();
    target.classList.add("drop-target");
  });

  container.addEventListener("dragleave", (event) => {
    const target = event.target.closest(".playlist-item[data-playlist-item-id]");
    if (target) {
      target.classList.remove("drop-target");
    }
  });

  container.addEventListener("dragend", () => {
    container.querySelectorAll(".playlist-item").forEach((item) => {
      item.classList.remove("dragging", "drop-target");
    });
    draggedPlaylistItemId = null;
    draggedPlaylistId = null;
  });

  container.addEventListener("drop", async (event) => {
    const target = event.target.closest(".playlist-item[data-playlist-item-id]");
    if (!target || !draggedPlaylistItemId || target.dataset.playlistId !== draggedPlaylistId) {
      return;
    }

    event.preventDefault();

    const draggedItem = container.querySelector(`[data-playlist-item-id="${CSS.escape(draggedPlaylistItemId)}"]`);
    if (!draggedItem || draggedItem === target) {
      return;
    }

    container.insertBefore(draggedItem, target);

    const orderedIds = collectOrderedPlaylistItemIds(container);
    try {
      await persistPlaylistOrder(playlistId, orderedIds);
      await loadPlaylistItems(playlistId);
      showToast("Playlist order updated", "success");
    } catch (error) {
      showToast(`Error updating playlist order: ${error.message}`, "error");
      await loadPlaylistItems(playlistId);
    }
  });
}

async function persistPlaylistOrder(playlistId, orderedIds) {
  await fetchAPI(`/playlists/${playlistId}/items/reorder`, {
    method: "POST",
    body: JSON.stringify({ playlist_item_ids: orderedIds }),
  });
}

async function loadPlaylistItems(playlistId) {
  try {
    const pagination = getPlaylistVideoPagination(playlistId);
    pagination.page = 1;
    pagination.hasMore = false;
    pagination.loading = false;
    const data = await fetchAPI(`/playlists/${playlistId}/items?page=1&per_page=20`);
    const container = document.getElementById(`playlistItems-${playlistId}`);
    if (!container) return;

    const items = Array.isArray(data.items) ? data.items : [];

    if (!items.length) {
      container.innerHTML = `<div class="text-center p-3 text-muted small">No videos in this playlist.</div>`;
      return;
    }

    container.innerHTML = renderPlaylistItemsContainer(playlistId, items, data.has_more);
    pagination.hasMore = data.has_more;

    applyWatchedState(container, items);
    attachPlaylistDragHandlers(container, playlistId);

    bindAutoLoadOnScroll(
      container,
      () => loadMorePlaylistItems(playlistId),
      () => getPlaylistVideoPagination(playlistId).hasMore,
      () => getPlaylistVideoPagination(playlistId).loading
    );
  } catch (error) {
    const container = document.getElementById(`playlistItems-${playlistId}`);
    if (container) {
      container.innerHTML = `<div class="text-center p-2 text-danger small">Error loading playlist items</div>`;
    }
  }
}

async function loadMorePlaylistItems(playlistId) {
  try {
    const pagination = getPlaylistVideoPagination(playlistId);
    if (pagination.loading || !pagination.hasMore) {
      return;
    }

    pagination.loading = true;
    const container = document.getElementById(`playlistItems-${playlistId}`);
    setLoadMoreIndicator(container, true);
    const page = (pagination.page || 1) + 1;
    const data = await fetchAPI(`/playlists/${playlistId}/items?page=${page}&per_page=20`);
    if (!container) return;

    const oldIndicator = container.querySelector('.load-more-indicator');
    if (oldIndicator) oldIndicator.remove();

    const fragment = document.createElement("div");
    const items = Array.isArray(data.items) ? data.items : [];
    fragment.innerHTML = items.map((item) => renderVideoItem(item, {
      showQueueAction: false,
      showRemoveAction: true,
      removeActionOnclick: `event.preventDefault(); event.stopPropagation(); removePlaylistItem('${playlistId}', '${item.playlist_item_id}')`,
      extraClass: "playlist-item",
      enablePlaylistReorder: true,
      playlistId,
    })).join("");
    while (fragment.firstChild) {
      container.appendChild(fragment.firstChild);
    }

    if (data.has_more) {
      setLoadMoreIndicator(container, false);
    } else {
      resetScrollSentinel(container);
    }
    pagination.hasMore = data.has_more;
    pagination.page = page;

    applyWatchedState(container, items);
    attachPlaylistDragHandlers(container, playlistId);
  } catch (error) {
    showToast("Error loading more playlist items", "error");
  } finally {
    const container = document.getElementById(`playlistItems-${playlistId}`);
    if (container) {
      if (getPlaylistVideoPagination(playlistId).hasMore) {
        setLoadMoreIndicator(container, false);
      } else {
        resetScrollSentinel(container);
      }
    }
    getPlaylistVideoPagination(playlistId).loading = false;
  }
}

async function removePlaylistItem(playlistId, playlistItemId) {
  try {
    showSpinner();
    await fetchAPI(`/playlists/${playlistId}/items/${playlistItemId}`, { method: "DELETE" });
    await loadPlaylistItems(playlistId);
    showToast("Playlist item removed", "success");
  } catch (error) {
    showToast(`Error removing playlist item: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

async function deletePlaylist(playlistId, playlistTitle = "playlist") {
  if (!await showConfirm(`Delete ${playlistTitle} from YouTube?`, "Delete Playlist")) {
    return;
  }

  try {
    showSpinner();
    await fetchAPI(`/playlists/${playlistId}`, { method: "DELETE" });
    allPlaylists = allPlaylists.filter((playlist) => playlist.playlist_id !== playlistId);
    const playlistColumn = document.querySelector(`[data-playlist-id="${CSS.escape(playlistId)}"]`);
    if (playlistColumn) {
      playlistColumn.remove();
    }
    if (allPlaylists.length === 0) {
      renderPlaylists();
    }
    showToast("Playlist deleted", "success");
  } catch (error) {
    showToast(`Error deleting playlist: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

async function castPlaylist(playlistId) {
  try {
    showSpinner();
    initializeCastFramework();
    const session = await requestCastSession();
    const screenId = _receiverScreenId || await getYouTubeScreenId(session);
    const result = await fetchAPI(`/playlists/${playlistId}/cast`, {
      method: "POST",
      body: JSON.stringify({ screen_id: screenId }),
    });

    if (result.error) {
      throw new Error(result.error);
    }

    const deviceName = session.getCastDevice ? session.getCastDevice()?.friendlyName : null;
    updateCastReceiverStatus();
    showToast(
      result.video_count
        ? (deviceName
          ? `Playing ${result.video_count} videos on ${deviceName}`
          : `Playing ${result.video_count} videos via Cast`)
        : (deviceName
          ? `Playing playlist on ${deviceName}`
          : "Playing playlist via Cast"),
      "success"
    );
  } catch (error) {
    showToast(`Error starting playlist playback: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

async function loadFeedVideos(feedId) {
  try {
    const pagination = getFeedVideoPagination(feedId);
    pagination.page = 1;
    pagination.hasMore = false;
    pagination.loading = false;
    const data = await fetchAPI(`/feeds/${feedId}/videos?page=1&per_page=20`);
    const container = document.getElementById(`feedVideos-${feedId}`);
    if (!container) return;

    if (data.items.length === 0) {
      container.innerHTML = `<div class="text-center p-3 text-muted small">No videos match this feed's filters.<br>Try fetching videos first.</div>`;
      return;
    }

    container.innerHTML = renderVideoListContainer(data.items, data.has_more, { showQueueAction: true, showPlaylistAction: true });
    pagination.hasMore = data.has_more;

    applyWatchedState(container, data.items);

    bindAutoLoadOnScroll(
      container,
      () => loadMoreFeedVideos(feedId),
      () => getFeedVideoPagination(feedId).hasMore,
      () => getFeedVideoPagination(feedId).loading
    );
  } catch (error) {
    const container = document.getElementById(`feedVideos-${feedId}`);
    if (container) container.innerHTML = `<div class="text-center p-2 text-danger small">Error loading videos</div>`;
  }
}

async function loadMoreFeedVideos(feedId) {
  try {
    const pagination = getFeedVideoPagination(feedId);
    if (pagination.loading || !pagination.hasMore) {
      return;
    }

    pagination.loading = true;
    const container = document.getElementById(`feedVideos-${feedId}`);
    setLoadMoreIndicator(container, true);
    const page = (pagination.page || 1) + 1;
    const data = await fetchAPI(`/feeds/${feedId}/videos?page=${page}&per_page=20`);
    if (!container) return;

    const oldIndicator = container.querySelector('.load-more-indicator');
    if (oldIndicator) oldIndicator.remove();

    // Append new videos
    const fragment = document.createElement('div');
    fragment.innerHTML = data.items.map((video) => renderVideoItem(video, { showQueueAction: true, showPlaylistAction: true })).join("");
    while (fragment.firstChild) container.appendChild(fragment.firstChild);

    // Keep the spinner indicator available only while more pages remain
    if (data.has_more) {
      setLoadMoreIndicator(container, false);
    } else {
      resetScrollSentinel(container);
    }
    pagination.hasMore = data.has_more;
    pagination.page = page;

    applyWatchedState(container, data.items);
  } catch (error) {
    showToast('Error loading more videos', 'error');
  } finally {
    const container = document.getElementById(`feedVideos-${feedId}`);
    if (container) {
      if (getFeedVideoPagination(feedId).hasMore) {
        setLoadMoreIndicator(container, false);
      } else {
        resetScrollSentinel(container);
      }
    }
    getFeedVideoPagination(feedId).loading = false;
  }
}

function formatDuration(totalSeconds) {
  if (totalSeconds == null) return '';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function timeAgo(isoDate) {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

let feedCategoryGroupCounter = 0;

function openFeedModal(feedId = null) {
  currentEditingFeedId = feedId;
  feedCategoryGroupCounter = 0;
  document.getElementById("feedModalTitle").textContent = feedId ? "Edit Feed" : "New Feed";

  const groupsContainer = document.getElementById("feedCategoryGroups");
  groupsContainer.innerHTML = "";

  if (feedId) {
    const feed = allFeeds.find(f => f.id === feedId);
    if (feed) {
      document.getElementById("feedName").value = feed.name;
      document.getElementById("feedVideoType").value = feed.filter_video_type || "";
      document.getElementById("feedMinDuration").value = feed.filter_min_duration != null ? Math.round(feed.filter_min_duration / 60) : "";
      document.getElementById("feedMaxDuration").value = feed.filter_max_duration != null ? Math.round(feed.filter_max_duration / 60) : "";
      document.getElementById("feedMaxAge").value = feed.filter_max_age_days || "";
      setFeedPlayState(feed.filter_play_state || "both");

      // Populate category groups
      const groups = feed.filter_category_ids || [];
      if (groups.length > 0) {
        groups.forEach(group => addCategoryGroup(group));
      }
    }
  } else {
    document.getElementById("feedForm").reset();
    setFeedPlayState("both");
  }

  const deleteBtn = document.getElementById("feedDeleteBtn");
  if (feedId) {
    deleteBtn.classList.remove("d-none");
  } else {
    deleteBtn.classList.add("d-none");
  }

  showModal("feedModal");
}

function addCategoryGroup(selectedIds = []) {
  const container = document.getElementById("feedCategoryGroups");
  const groupIdx = feedCategoryGroupCounter++;
  const groupDiv = document.createElement("div");
  groupDiv.className = "filter-group";
  groupDiv.dataset.groupIdx = groupIdx;

  const showOr = container.children.length > 0;

  groupDiv.innerHTML = `
    ${showOr ? '<div class="filter-group-label">AND</div>' : ''}
    <div class="d-flex align-items-start gap-1">
      <div class="border rounded p-2 flex-grow-1 filter-scroll">
        ${renderGroupCategoryCheckboxes(allCategories, groupIdx)}
      </div>
      <button type="button" class="btn btn-sm btn-outline-danger flex-shrink-0 btn-remove-group" onclick="removeCategoryGroup(this)" title="Remove group">
        <span class="material-icons md-sm">close</span>
      </button>
    </div>
  `;

  container.appendChild(groupDiv);

  // Check selected boxes
  selectedIds.forEach(id => {
    const cb = groupDiv.querySelector(`input[value="${id}"]`);
    if (cb) cb.checked = true;
  });
}

function removeCategoryGroup(btn) {
  const group = btn.closest(".filter-group");
  group.remove();
  // Update OR labels
  const groups = document.querySelectorAll("#feedCategoryGroups .filter-group");
  groups.forEach((g, i) => {
    const orLabel = g.querySelector(".filter-group-label");
    if (i === 0 && orLabel) orLabel.remove();
    if (i > 0 && !orLabel) {
      g.insertAdjacentHTML("afterbegin", '<div class="filter-group-label">AND</div>');
    }
  });
}

function renderGroupCategoryCheckboxes(categories, groupIdx, level = 0) {
  return categories.map(cat => {
    const indent = level * 1.25;
    const uid = `feedCat-g${groupIdx}-${cat.id}`;
    return `
      <div class="form-check indent-${level}">
        <input class="form-check-input" type="checkbox" value="${cat.id}" id="${uid}">
        <label class="form-check-label small" for="${uid}">${cat.name}</label>
      </div>
      ${cat.children ? renderGroupCategoryCheckboxes(cat.children, groupIdx, level + 1) : ""}
    `;
  }).join("");
}

async function deleteFeedFromModal() {
  if (!currentEditingFeedId) return;
  const feed = allFeeds.find(f => f.id === currentEditingFeedId);
  if (!await showConfirm(`Delete feed "${feed?.name}"?`, "Delete Feed")) return;

  try {
    showSpinner();
    await fetchAPI(`/feeds/${currentEditingFeedId}`, { method: "DELETE" });
    hideModal("feedModal");
    await loadFeeds();
  } catch (error) {
    showToast(`Error deleting feed: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

function renderFeedCategoryCheckboxes(categories, feedId = null, level = 0) {
  // Legacy — kept for compatibility but no longer used by the modal
  return renderGroupCategoryCheckboxes(categories, 0, level);
}

function getFeedPlayState() {
  const selected = document.querySelector('input[name="feedPlayState"]:checked');
  return selected ? selected.value : "both";
}

function setFeedPlayState(state) {
  const normalizedState = ["played", "unplayed", "both"].includes(state) ? state : "both";
  document.querySelectorAll('input[name="feedPlayState"]').forEach(input => {
    input.checked = input.value === normalizedState;
  });
}

async function saveFeed(e) {
  e.preventDefault();

  // Collect category groups (OR of AND)
  const groupDivs = document.querySelectorAll("#feedCategoryGroups .filter-group");
  const categoryGroups = [];
  groupDivs.forEach(groupDiv => {
    const checked = groupDiv.querySelectorAll("input[type=checkbox]:checked");
    const ids = Array.from(checked).map(cb => Number(cb.value));
    if (ids.length > 0) categoryGroups.push(ids);
  });

  const minDurVal = document.getElementById("feedMinDuration").value;
  const maxDurVal = document.getElementById("feedMaxDuration").value;

  const data = {
    name: document.getElementById("feedName").value,
    filter_category_ids: categoryGroups,
    filter_video_type: document.getElementById("feedVideoType").value || null,
    filter_min_duration: minDurVal ? Number(minDurVal) * 60 : null,
    filter_max_duration: maxDurVal ? Number(maxDurVal) * 60 : null,
    filter_max_age_days: document.getElementById("feedMaxAge").value ? Number(document.getElementById("feedMaxAge").value) : null,
    filter_play_state: getFeedPlayState(),
  };

  try {
    showSpinner();
    if (currentEditingFeedId) {
      await fetchAPI(`/feeds/${currentEditingFeedId}`, { method: "PUT", body: JSON.stringify(data) });
    } else {
      await fetchAPI("/feeds", { method: "POST", body: JSON.stringify(data) });
    }
    hideModal("feedModal");
    await loadFeeds();
  } catch (error) {
    showToast(`Error saving feed: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

async function deleteFeed(feedId) {
  const feed = allFeeds.find(f => f.id === feedId);
  if (!await showConfirm(`Delete feed "${feed?.name}"?`, "Delete Feed")) return;

  try {
    showSpinner();
    await fetchAPI(`/feeds/${feedId}`, { method: "DELETE" });
    await loadFeeds();
  } catch (error) {
    showToast(`Error deleting feed: ${error.message}`, "error");
  } finally {
    hideSpinner();
  }
}

// ============================================================================
// Unified Background Sync
// ============================================================================

let syncPollInterval = null;

async function startFullSync(force = false) {
  const btn = document.getElementById("syncBtn");
  if (btn && btn.disabled) return;

  try {
    await fetchAPI("/sync/all", {
      method: "POST",
      body: JSON.stringify({ force }),
    });
    _startSyncPolling();
  } catch (error) {
    if (error.message && error.message.includes("already in progress")) {
      _startSyncPolling();
    } else {
      showToast(`Error starting sync: ${error.message}`, "error");
    }
  }
}

function _startSyncPolling() {
  if (syncPollInterval) return;
  _setSyncBtnDisabled(true);
  syncPollInterval = setInterval(_pollSyncStatus, 2000);
}

async function _pollSyncStatus() {
  try {
    const status = await fetchAPI("/sync/status");
    _updateSyncStatusUI(status);

    if (!status.running) {
      clearInterval(syncPollInterval);
      syncPollInterval = null;
      _setSyncBtnDisabled(false);

      if (status.finished_at) {
        const parts = [];
        if (status.subs_synced) parts.push(`${status.subs_synced} subscriptions`);
        if (status.fetched_new > 0) parts.push(`${status.fetched_new} new video${status.fetched_new !== 1 ? "s" : ""}`);
        const msg = parts.length ? `Sync complete: ${parts.join(", ")}` : "Sync complete";
        showToast(msg, status.fetched_new > 0 ? "success" : "info");
        if (status.fetched_new > 0) {
          allFeeds.forEach(feed => loadFeedVideos(feed.id));
        }
        if (status.subs_synced > 0) {
          await loadSubscriptions(selectedCategoryId);
        }
      }
    }
  } catch (e) {
    // Silently ignore poll errors
  }
}

function _updateSyncStatusUI(status) {
  const btnIcon = document.getElementById("syncBtnIcon");

  if (status.running) {
    if (btnIcon) btnIcon.classList.add("spin-icon");
  } else {
    if (btnIcon) btnIcon.classList.remove("spin-icon");
  }
}

function _setSyncBtnDisabled(disabled) {
  const btn = document.getElementById("syncBtn");
  if (btn) btn.disabled = disabled;
}

async function _checkAndRestoreSync() {
  try {
    const status = await fetchAPI("/sync/status");
    _updateSyncStatusUI(status);
    if (status.running && !syncPollInterval) {
      _startSyncPolling();
    }
  } catch (e) {
    // Ignore
  }
}

// Backward-compatible aliases
async function startVideoSync(force = false) { return startFullSync(force); }
async function fetchAllVideos() { return startFullSync(false); }
