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

// ============================================================================
// Category functions
// ============================================================================

async function loadCategories() {
  try {
    showSpinner();
    allCategories = await fetchAPI("/categories");
    renderCategoriesTree();
    renderCategoryParentSelect();
  } catch (error) {
    alert(`Error loading categories: ${error.message}`);
  } finally {
    hideSpinner();
  }
}

function renderCategoriesTree(categories = allCategories, container = null, level = 0) {
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
      suggestionsBtn.style.display = hasSingleSelection ? "inline-block" : "none";
    }
  }
  
  // Add help message when subscriptions are selected
  if (isRoot && hasSelectedSubs) {
    const helpDiv = document.createElement("div");
    helpDiv.className = "selection-help";
    const suggestionHint = hasSingleSelection && suggestedCategoryIds.length > 0 
      ? '<span class="suggestion-active">✨ Suggested categories highlighted</span>'
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
          <div class="category-drag-handle" title="Drag to reorder">☰</div>
          ${hasSelectedSubs ? `<input type="checkbox" class="category-checkbox" data-category-id="${category.id}" ${assignmentState === "all" ? "checked" : ""} ${assignmentState === "partial" ? "data-indeterminate='true'" : ""} onclick="handleCategoryAssignment(${category.id}, event)">` : `<div class="category-toggle">${hasChildren ? "▼" : ""}</div>`}
          <div class="category-name" onclick="selectCategory(${category.id})">${category.name}${isSuggested ? ' <span class="suggestion-badge">✨ Suggested</span>' : ''}</div>
          <div class="category-actions">
            <button onclick="editCategory(${category.id})" title="Edit">✏️</button>
            <button onclick="deleteCategory(${category.id})" title="Delete">🗑️</button>
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
      alert(`Error updating category order: ${error.message}`);
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
  categories.forEach((cat) => {
    flat.push(cat);
    if (cat.children && cat.children.length > 0) {
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
  for (const cat of categories) {
    if (cat.id === id) return cat;
    if (cat.children && cat.children.length > 0) {
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
    categoryName = "All Subscriptions";
  } else if (selectedCategoryId === "uncategorized") {
    categoryName = "Uncategorized";
  } else {
    const category = findCategoryById(allCategories, selectedCategoryId, []);
    categoryName = category ? category.name : "All Subscriptions";
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
    alert(`Error saving category: ${error.message}`);
  } finally {
    hideSpinner();
  }
}

async function editCategory(categoryId) {
  openCategoryModal(categoryId);
}

async function deleteCategory(categoryId) {
  if (!confirm("Are you sure? This will delete the category and its children.")) {
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
    alert(`Error deleting category: ${error.message}`);
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
    alert(`Error loading subscriptions: ${error.message}`);
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
        <div class="subscription-item ${isSelected ? "selected" : ""}" data-subscription-id="${sub.id}" onclick="toggleSubscriptionSelection(${sub.id}, event)">
            <input type="checkbox" class="subscription-checkbox" ${isSelected ? "checked" : ""} onclick="event.stopPropagation(); toggleSubscriptionSelection(${sub.id}, event)">
            <img src="${sub.thumbnail_url || 'https://via.placeholder.com/80'}" 
                 alt="${sub.channel_title}" 
                 class="subscription-thumbnail">
            <div class="subscription-info">
                <div class="subscription-title">${sub.channel_title}</div>
                <div class="subscription-description">${sub.channel_description || "No description"}</div>
                <div class="subscription-categories">
                    ${sub.categories && sub.categories.length > 0
          ? sub.categories
            .map((cat) => `<span class="category-badge">${cat.name}</span>`)
            .join("")
          : '<span style="color: #999;">Uncategorized</span>'
        }
                </div>
            </div>
            <button class="btn-unsubscribe" onclick="event.stopPropagation(); unsubscribeChannel(${sub.id})" title="Unsubscribe">
                🗑️
            </button>
        </div>
    `;
      }
    )
    .join("");
}

async function syncSubscriptions() {
  if (!confirm("This will fetch all subscriptions from YouTube. Continue?")) {
    return;
  }

  try {
    showSpinner();
    const result = await fetchAPI("/subscriptions/sync", { method: "POST" });
    alert(result.message);
    await loadSubscriptions();
  } catch (error) {
    alert(`Error syncing subscriptions: ${error.message}`);
  } finally {
    hideSpinner();
  }
}

async function unsubscribeChannel(subId) {
  const subscription = allSubscriptions.find(s => s.id === subId);
  if (!subscription) return;

  if (!confirm(`Are you sure you want to unsubscribe from "${subscription.channel_title}"?\n\nThis will remove the subscription from both YouTube and this app.`)) {
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
    
    alert(result.message || `Unsubscribed from "${subscription.channel_title}"`);
  } catch (error) {
    alert(`Error unsubscribing: ${error.message}`);
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
    alert(`Error updating assignments: ${error.message}`);
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
    alert(`Error fetching suggestions: ${error.message}`);
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

  // Sync button
  document.getElementById("syncBtn").addEventListener("click", syncSubscriptions);

  // Initial load
  loadCategories();
  loadSubscriptions().then(() => {
    updateUI(); // Highlight "All" filter by default
  });
});
