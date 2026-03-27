// Global state
let allCategories = [];
let allSubscriptions = [];
let selectedCategoryId = null;
let currentEditingCategoryId = null;
let selectedSubscriptionIds = [];
let draggedCategoryId = null;
let draggedParentId = null;
let currentSearchQuery = "";
let suggestedCategoryIds = [];

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

async function persistCategoryOrder(parentId, orderedIds) {
  await fetchAPI("/categories/reorder", {
    method: "POST",
    body: JSON.stringify({ parent_id: parentId, ordered_ids: orderedIds }),
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
          ${hasSelectedSubs ? `<input type="checkbox" class="category-checkbox" data-category-id="${category.id}" ${assignmentState === "all" ? "checked" : ""} ${assignmentState === "partial" ? "data-indeterminate='true'" : ""} onclick="handleCategoryAssignment(${category.id}, event)">` : `<div class="category-toggle">${hasChildren ? '<span class="material-icons">expand_more</span>' : ""}</div>`}
          <div class="category-name" onclick="selectCategory(${category.id})">${category.name}${isSuggested ? ' <span class="suggestion-badge"><span class="material-icons md-sm">auto_awesome</span> Suggested</span>' : ''}</div>
          <div class="action-group">
            <button class="btn-action btn-action-sm" onclick="editCategory(${category.id})" title="Edit"><span class="material-icons">edit</span></button>
            <button class="btn-action btn-action-sm btn-action-danger" onclick="deleteCategory(${category.id})" title="Delete"><span class="material-icons">delete</span></button>
          </div>
        </div>
        ${hasChildren ? `<div class="category-children" data-category-id="${category.id}"></div>` : ""}
      `;

    container.appendChild(itemDiv);

    if (hasChildren) {
      const childrenContainer = itemDiv.querySelector(".category-children");
      renderCategoriesTree(category.children, childrenContainer, level + 1);
    }
  });

  if (isRoot) {
    attachCategoryDragHandlers();
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
    node.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });

  tree.addEventListener("dragover", (e) => {
    const target = e.target.closest(".category-node");
    if (!target) return;
    const targetParentId = target.dataset.parentId ? Number(target.dataset.parentId) : null;
    if (targetParentId !== draggedParentId) return;
    e.preventDefault();
    target.classList.add("drop-target");
  });

  tree.addEventListener("dragleave", (e) => {
    const target = e.target.closest(".category-node");
    if (target) target.classList.remove("drop-target");
  });

  tree.addEventListener("dragend", () => {
    document.querySelectorAll(".category-node").forEach((node) => {
      node.classList.remove("dragging", "drop-target");
    });
    draggedCategoryId = null;
    draggedParentId = null;
  });

  tree.addEventListener("drop", async (e) => {
    const target = e.target.closest(".category-node");
    if (!target || draggedCategoryId === null) return;

    const targetParentId = target.dataset.parentId ? Number(target.dataset.parentId) : null;
    if (targetParentId !== draggedParentId) return;

    e.preventDefault();

    const draggedNode = tree.querySelector(`[data-category-id="${draggedCategoryId}"]`);
    if (!draggedNode) return;

    const draggedItem = draggedNode.closest(".category-item");
    const targetItem = target.closest(".category-item");
    if (!draggedItem || !targetItem || draggedItem === targetItem) return;

    const container = getCategoryContainerForNode(target);
    container.insertBefore(draggedItem, targetItem);

    const orderedIds = collectOrderedIds(container);
    try {
      await persistCategoryOrder(draggedParentId, orderedIds);
      await loadCategories();
    } catch (error) {
      showToast(`Error updating category order: ${error.message}`, "error");
      await loadCategories();
    }
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
// Subscription functions
// ============================================================================

async function loadSubscriptions(categoryId = null) {
  try {
    showSpinner();
    let endpoint;
    if (categoryId === "uncategorized") {
      endpoint = "/subscriptions?uncategorized=true";
    } else if (categoryId) {
      endpoint = `/subscriptions?category_id=${categoryId}`;
    } else {
      endpoint = "/subscriptions";
    }
    allSubscriptions = await fetchAPI(endpoint);
    renderSubscriptions();
  } catch (error) {
    showToast(`Error loading subscriptions: ${error.message}`, "error");
  } finally {
    hideSpinner();
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

  container.innerHTML = subscriptions
    .map(
      (sub) => {
        const isSelected = selectedSubscriptionIds.includes(sub.id);
        return `
        <div class="list-item subscription-item ${isSelected ? "selected" : ""}" data-subscription-id="${sub.id}" onclick="toggleSubscriptionSelection(${sub.id}, event)">
            <input type="checkbox" class="list-item-checkbox" ${isSelected ? "checked" : ""} onclick="event.stopPropagation(); toggleSubscriptionSelection(${sub.id}, event)">
            <img src="${sub.thumbnail_url || 'https://via.placeholder.com/80'}" 
                 alt="${sub.channel_title}" 
                 class="list-item-thumb subscription-thumbnail">
            <div class="list-item-info">
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
      sub.channel_title.toLowerCase().includes(currentSearchQuery) ||
      sub.channel_description.toLowerCase().includes(currentSearchQuery)
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

  // Unified sync button (navbar)
  document.getElementById("syncBtn").addEventListener("click", () => startFullSync(false));

  // Initial load
  loadCategories().then(() => loadFeeds());
  loadSubscriptions().then(() => {
    updateUI(); // Highlight "All" filter by default
  });
  document.getElementById("newFeedBtn").classList.remove("d-none");

  // Restore sync progress if a sync is already running
  _checkAndRestoreSync();
});

// ============================================================================
// Section Navigation
// ============================================================================

function switchSection(section) {
  document.getElementById("sectionSubscriptions").classList.toggle("d-none", section !== "subscriptions");
  document.getElementById("sectionFeeds").classList.toggle("d-none", section !== "feeds");

  document.querySelectorAll("#mainNav .nav-link").forEach(link => {
    link.classList.toggle("active", link.dataset.section === section);
  });

  const newFeedBtn = document.getElementById("newFeedBtn");
  const newCategoryBtn = document.getElementById("newCategoryBtn");
  const suggestionsBtn = document.getElementById("getSuggestionsBtn");
  if (section === "feeds") {
    newFeedBtn.classList.remove("d-none");
    newCategoryBtn.classList.add("d-none");
    if (suggestionsBtn) suggestionsBtn.classList.add("d-none");
    loadFeeds();
  } else {
    newFeedBtn.classList.add("d-none");
    newCategoryBtn.classList.remove("d-none");
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

  if (allFeeds.length === 0) {
    container.innerHTML = `
      <div class="empty-state w-100">
        <p>No feeds yet. Create one to get started!</p>
        <button class="btn btn-primary btn-sm" onclick="openFeedModal()">+ New Feed</button>
      </div>`;
    return;
  }

  container.innerHTML = allFeeds.map(feed => `
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
  `).join("");

  // Load videos for each feed
  allFeeds.forEach(feed => loadFeedVideos(feed.id));
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

async function loadFeedVideos(feedId) {
  try {
    const videos = await fetchAPI(`/feeds/${feedId}/videos`);
    const container = document.getElementById(`feedVideos-${feedId}`);
    if (!container) return;

    if (videos.length === 0) {
      container.innerHTML = `<div class="text-center p-3 text-muted small">No videos match this feed's filters.<br>Try fetching videos first.</div>`;
      return;
    }

    container.innerHTML = videos.map(v => `
      <a class="list-item" href="https://youtube.com/watch?v=${encodeURIComponent(v.video_id)}" target="_blank" rel="noopener"
         data-video-id="${v.video_id}">
        <div class="thumb-container">
          <img class="list-item-thumb list-item-thumb-lg" src="${v.thumbnail_url || ''}" alt="" loading="lazy">
          ${v.duration_seconds ? `<span class="duration-badge">${formatDuration(v.duration_seconds)}</span>` : ''}
        </div>
        <div class="list-item-info">
          <div class="list-item-title">${v.title}</div>
          <div class="list-item-subtitle">${v.channel_title || ''}</div>
          <div class="list-item-meta">${v.published_at ? timeAgo(v.published_at) : ''}</div>
        </div>
      </a>
    `).join("");

    // Fetch watch progress asynchronously and overlay
    const videoIds = videos.map(v => v.video_id);
    loadWatchProgress(feedId, videoIds);
  } catch (error) {
    const container = document.getElementById(`feedVideos-${feedId}`);
    if (container) container.innerHTML = `<div class="text-center p-2 text-danger small">Error loading videos</div>`;
  }
}

async function loadWatchProgress(feedId, videoIds) {
  try {
    const progress = await fetchAPI('/videos/watch-progress', {
      method: 'POST',
      body: JSON.stringify({ video_ids: videoIds }),
    });
    if (!progress || Object.keys(progress).length === 0) return;

    const container = document.getElementById(`feedVideos-${feedId}`);
    if (!container) return;

    for (const [videoId, percent] of Object.entries(progress)) {
      const link = container.querySelector(`a[data-video-id="${CSS.escape(videoId)}"]`);
      if (!link) continue;

      // Add watched class for fully watched videos
      if (percent >= 95) link.classList.add('watched');

      // Add or update progress bar
      const thumbContainer = link.querySelector('.thumb-container');
      if (thumbContainer && percent > 0 && percent < 100) {
        const bar = document.createElement('div');
        bar.className = 'progress-bar-container';
        bar.innerHTML = `<div class="progress-bar-fill" style="width:${percent}%"></div>`;
        thumbContainer.appendChild(bar);
      } else if (thumbContainer && percent >= 100) {
        const bar = document.createElement('div');
        bar.className = 'progress-bar-container';
        bar.innerHTML = `<div class="progress-bar-fill" style="width:100%"></div>`;
        thumbContainer.appendChild(bar);
      }
    }
  } catch (error) {
    // Watch progress is non-critical; fail silently
    console.debug('Watch progress fetch failed:', error);
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

      // Populate category groups
      const groups = feed.filter_category_ids || [];
      if (groups.length > 0) {
        groups.forEach(group => addCategoryGroup(group));
      }
    }
  } else {
    document.getElementById("feedForm").reset();
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
