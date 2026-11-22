// Inventory tab: categories down the side, and the items in the chosen one (or all of them) with
// a picture, how many there are and where they're kept. Categories and items are added, changed
// and deleted here; deleting a category deletes its items. A picture is made small here (a JPEG
// no wider or taller than INVENTORY_PICTURE_PX) before it's sent, and kept in the database.

const INVENTORY_PICTURE_PX = 1024;
const INVENTORY_ALL = 'all';

let inventoryCategories = []; // [{ id, name, itemCount, totalQuantity }]
let inventoryItems = []; // [{ id, categoryId, name, quantity, location, notes, hasPicture, pictureAt, updatedAt }]
let inventorySelected = INVENTORY_ALL; // a category id, or INVENTORY_ALL
let inventoryEditing = null; // the id of the item in the form, or null for a new one
// The picture in the form: undefined leaves the item's as it is, null removes it, a data: URL replaces it
let inventoryPicture;

const inventoryIcon = d => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const INVENTORY_ICONS = {
    edit: inventoryIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    delete: inventoryIcon('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
    minus: inventoryIcon('<path d="M5 12h14"/>'),
    plus: inventoryIcon('<path d="M12 5v14M5 12h14"/>'),
    box: inventoryIcon('<path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>'),
};

const inventoryPictureUrl = item => `/api/inventory/items/${item.id}/picture?v=${item.pictureAt}`;

async function inventoryFetch(url, options = {}) {
    const res = await fetch(url, options.body === undefined ? options : {
        ...options, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
}

async function showInventory() {
    setAppView('inventory');
    closeInventoryForm();
    await loadInventory();
}

async function loadInventory() {
    try {
        const data = await inventoryFetch('/api/inventory');
        inventoryCategories = data.categories;
        inventoryItems = data.items;
        if (inventorySelected !== INVENTORY_ALL && !inventoryCategories.some(c => c.id === inventorySelected)) {
            inventorySelected = INVENTORY_ALL;
        }
        renderInventory();
    } catch (err) {
        showToast(`Couldn't load the inventory: ${err.message}`, 'error');
    }
}

function renderInventory() {
    renderInventoryCategories();
    renderInventoryItems();
}

function selectInventoryCategory(id) {
    inventorySelected = id;
    renderInventory();
}

function renderInventoryCategories() {
    const totalItems = inventoryItems.length;
    const totalQuantity = inventoryItems.reduce((n, i) => n + i.quantity, 0);
    const row = (id, name, itemCount, quantity, actions) => `
        <li class="inventory-category${inventorySelected === id ? ' active' : ''}">
            <button type="button" class="inventory-category-btn" onclick="selectInventoryCategory(${id === INVENTORY_ALL ? `'${INVENTORY_ALL}'` : id})">
                <span class="inventory-category-name">${escapeHtml(name)}</span>
                <span class="inventory-category-count" title="${itemCount} item${itemCount === 1 ? '' : 's'}, ${quantity} in all">${itemCount}</span>
            </button>
            ${actions}
        </li>`;
    document.getElementById('inventory-category-list').innerHTML =
        row(INVENTORY_ALL, 'All items', totalItems, totalQuantity, '') +
        inventoryCategories.map(c => row(c.id, c.name, c.itemCount, c.totalQuantity, `
            <span class="inventory-category-actions">
                <button type="button" class="pw-icon-btn" title="Rename" onclick="renameInventoryCategory(${c.id})">${INVENTORY_ICONS.edit}</button>
                <button type="button" class="pw-icon-btn pw-delete" title="Delete" onclick="deleteInventoryCategory(${c.id})">${INVENTORY_ICONS.delete}</button>
            </span>`)).join('') +
        (inventoryCategories.length ? '' : '<li class="inventory-category-hint">Press + to add a category, such as Tools or Spares.</li>');
}

function renderInventoryItems() {
    const category = inventoryCategories.find(c => c.id === inventorySelected);
    const showAll = !category;
    document.getElementById('inventory-title').textContent = category ? category.name : 'Inventory';
    document.getElementById('inventory-category-col').hidden = !showAll;
    const categoryName = new Map(inventoryCategories.map(c => [c.id, c.name]));
    const query = document.getElementById('inventory-search').value.trim().toLowerCase();
    const shown = inventoryItems.filter(i => (showAll || i.categoryId === inventorySelected) &&
        (!query || [i.name, i.location, i.notes, categoryName.get(i.categoryId) || ''].some(v => v.toLowerCase().includes(query))));
    document.getElementById('inventory-body').innerHTML = shown.map(i => `
        <tr class="${i.quantity === 0 ? 'inventory-none-left' : ''}">
            <td class="inventory-thumb-cell">${i.hasPicture
                ? `<button type="button" class="inventory-thumb" title="Show the picture" onclick="showInventoryPicture(${i.id})">
                       <img src="${escapeAttr(inventoryPictureUrl(i))}" alt="" loading="lazy"></button>`
                : `<span class="inventory-thumb inventory-thumb-empty">${INVENTORY_ICONS.box}</span>`}</td>
            <td><div class="pw-name">${escapeHtml(i.name)}</div>${i.notes ? `<div class="inventory-notes">${escapeHtml(i.notes)}</div>` : ''}</td>
            ${showAll ? `<td class="inventory-category-cell">${escapeHtml(categoryName.get(i.categoryId) || '')}</td>` : ''}
            <td class="inventory-qty-cell">
                <button type="button" class="pw-icon-btn" title="One fewer" onclick="changeInventoryQuantity(${i.id}, -1)" ${i.quantity ? '' : 'disabled'}>${INVENTORY_ICONS.minus}</button>
                <span class="inventory-qty">${i.quantity}</span>
                <button type="button" class="pw-icon-btn" title="One more" onclick="changeInventoryQuantity(${i.id}, 1)">${INVENTORY_ICONS.plus}</button>
            </td>
            <td>${escapeHtml(i.location)}</td>
            <td class="pw-actions">
                <button type="button" class="pw-icon-btn" title="Change" onclick="editInventoryItem(${i.id})">${INVENTORY_ICONS.edit}</button>
                <button type="button" class="pw-icon-btn pw-delete" title="Delete" onclick="deleteInventoryItem(${i.id})">${INVENTORY_ICONS.delete}</button>
            </td>
        </tr>`).join('');
    const empty = document.getElementById('inventory-empty');
    empty.hidden = shown.length > 0;
    empty.textContent = !inventoryCategories.length ? 'Add a category first, then items to go in it.'
        : query ? 'Nothing matches.'
        : category ? `Nothing in ${category.name} yet. Press Add item to add one.`
        : 'No items yet. Press Add item to add one.';
    document.getElementById('inventory-locations').innerHTML = [...new Set(inventoryItems.map(i => i.location).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b)).map(l => `<option value="${escapeAttr(l)}">`).join('');
}

function showInventoryPicture(id) {
    const item = inventoryItems.find(i => i.id === id);
    if (!item?.hasPicture) return;
    document.getElementById('inventory-lightbox-img').src = inventoryPictureUrl(item);
    document.getElementById('inventory-lightbox-img').alt = item.name;
    document.getElementById('inventory-lightbox').hidden = false;
}

document.addEventListener('keydown', e => {
    const box = document.getElementById('inventory-lightbox');
    if (e.key === 'Escape' && box && !box.hidden) box.hidden = true;
});

// --- Categories ---

async function addInventoryCategory() {
    const name = prompt('Name of the new category:')?.trim();
    if (!name) return;
    try {
        const category = await inventoryFetch('/api/inventory/categories', { method: 'POST', body: { name } });
        inventorySelected = category.id;
        await loadInventory();
    } catch (err) {
        showToast(`Couldn't add it: ${err.message}`, 'error');
    }
}

async function renameInventoryCategory(id) {
    const category = inventoryCategories.find(c => c.id === id);
    if (!category) return;
    const name = prompt('Rename the category:', category.name)?.trim();
    if (!name || name === category.name) return;
    try {
        await inventoryFetch(`/api/inventory/categories/${id}`, { method: 'PUT', body: { name } });
        await loadInventory();
    } catch (err) {
        showToast(`Couldn't rename it: ${err.message}`, 'error');
    }
}

async function deleteInventoryCategory(id) {
    const category = inventoryCategories.find(c => c.id === id);
    if (!category) return;
    const items = category.itemCount ? ` and the ${category.itemCount} item${category.itemCount === 1 ? '' : 's'} in it` : '';
    if (!confirm(`Delete "${category.name}"${items}? This can't be undone.`)) return;
    try {
        await inventoryFetch(`/api/inventory/categories/${id}`, { method: 'DELETE' });
        if (inventoryEditing !== null && inventoryItems.find(i => i.id === inventoryEditing)?.categoryId === id) closeInventoryForm();
        showToast(`Deleted ${category.name}`, 'success', 2000);
        await loadInventory();
    } catch (err) {
        showToast(`Couldn't delete it: ${err.message}`, 'error');
    }
}

// --- Items ---

const inventoryField = name => document.getElementById(`inventory-${name}`);

function editInventoryItem(id) {
    const item = id === null ? null : inventoryItems.find(i => i.id === id);
    if (id !== null && !item) return;
    if (!inventoryCategories.length) {
        showToast('Add a category first (the + beside Categories)', 'error', 4000);
        return;
    }
    inventoryEditing = id;
    inventoryField('category').innerHTML = inventoryCategories
        .map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    inventoryField('category').value = String(item?.categoryId
        ?? (inventorySelected !== INVENTORY_ALL ? inventorySelected : inventoryCategories[0].id));
    inventoryField('name').value = item?.name || '';
    inventoryField('quantity').value = item?.quantity ?? 1;
    inventoryField('location').value = item?.location || '';
    inventoryField('notes').value = item?.notes || '';
    inventoryPicture = undefined;
    showInventoryPicturePreview(item?.hasPicture ? inventoryPictureUrl(item) : null);
    const form = document.getElementById('inventory-form');
    form.hidden = false;
    form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    inventoryField('name').focus();
}

function closeInventoryForm() {
    document.getElementById('inventory-form').hidden = true;
    document.getElementById('inventory-picture-input').value = '';
    inventoryEditing = null;
    inventoryPicture = undefined;
}

function showInventoryPicturePreview(src) {
    const preview = document.getElementById('inventory-picture-preview');
    preview.innerHTML = src ? `<img src="${escapeAttr(src)}" alt="">` : `${INVENTORY_ICONS.box}<span>Add picture</span>`;
    preview.title = src ? 'Change the picture' : 'Choose a picture';
    document.getElementById('inventory-picture-remove').hidden = !src;
}

// Reads a chosen picture and makes it a JPEG no bigger than INVENTORY_PICTURE_PX on its longest side
async function pickInventoryPicture(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const scale = Math.min(1, INVENTORY_PICTURE_PX / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // a transparent PNG gets a white background, not black
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close?.();
        inventoryPicture = canvas.toDataURL('image/jpeg', 0.85);
        showInventoryPicturePreview(inventoryPicture);
    } catch {
        showToast("Couldn't read that picture. Try a JPEG or PNG.", 'error');
    }
}

function removeInventoryPicture() {
    inventoryPicture = null;
    showInventoryPicturePreview(null);
}

async function saveInventoryForm() {
    const editing = inventoryEditing;
    const body = {
        name: inventoryField('name').value,
        categoryId: Number(inventoryField('category').value),
        quantity: Number(inventoryField('quantity').value),
        location: inventoryField('location').value,
        notes: inventoryField('notes').value,
    };
    if (inventoryPicture !== undefined) body.picture = inventoryPicture;
    try {
        const item = await inventoryFetch(editing === null ? '/api/inventory/items' : `/api/inventory/items/${editing}`,
            { method: editing === null ? 'POST' : 'PUT', body });
        closeInventoryForm();
        showToast(editing === null ? `Added ${item.name}` : `Changed ${item.name}`, 'success', 2000);
        await loadInventory();
    } catch (err) {
        showToast(`Couldn't save it: ${err.message}`, 'error');
    }
}

async function changeInventoryQuantity(id, by) {
    const item = inventoryItems.find(i => i.id === id);
    if (!item) return;
    const quantity = Math.max(0, item.quantity + by);
    if (quantity === item.quantity) return;
    try {
        await inventoryFetch(`/api/inventory/items/${id}`, { method: 'PUT', body: { quantity } });
        await loadInventory();
    } catch (err) {
        showToast(`Couldn't change it: ${err.message}`, 'error');
    }
}

async function deleteInventoryItem(id) {
    const item = inventoryItems.find(i => i.id === id);
    if (!item || !confirm(`Delete "${item.name}"? This can't be undone.`)) return;
    try {
        await inventoryFetch(`/api/inventory/items/${id}`, { method: 'DELETE' });
        if (inventoryEditing === id) closeInventoryForm();
        showToast(`Deleted ${item.name}`, 'success', 2000);
        await loadInventory();
    } catch (err) {
        showToast(`Couldn't delete it: ${err.message}`, 'error');
    }
}
