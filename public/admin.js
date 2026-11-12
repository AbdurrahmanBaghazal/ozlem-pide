const $ = selector => document.querySelector(selector);
const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text != null) item.textContent = text; return item; };
const money = value => value == null ? 'Fiyat belirsiz' : new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 0 }).format(value);
let user = null;
let products = [];
let settings = {};
let setupNeeded = false;

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'İşlem başarısız.');
  return data;
}
const send = (path, method, body) => api(path, { method, body: JSON.stringify(body) });
function message(selector, text, isError = false) { const target = $(selector); target.textContent = text; target.classList.toggle('error', isError); }

async function boot() {
  try {
    const result = await api('/api/admin/me');
    user = result.user;
    showDashboard();
    await Promise.all([loadSummary(), loadProducts()]);
  } catch {
    const status = await api('/api/setup-status');
    setupNeeded = status.setupNeeded;
    $('#auth-screen').hidden = false;
    $('#auth-title').textContent = setupNeeded ? 'İlk yönetici kurulumu' : 'Yönetim girişi';
    $('#auth-subtitle').textContent = setupNeeded ? 'Restoranın ilk yönetici hesabını oluşturun.' : 'Menünüzü yönetmek için giriş yapın.';
    $('#display-name-field').hidden = !setupNeeded;
    $('#setup-key-field').hidden = !setupNeeded || !status.requiresSetupKey;
    $('#show-recovery').hidden = setupNeeded;
    $('#auth-submit').textContent = setupNeeded ? 'Hesabı Oluştur' : 'Giriş Yap';
    $('#password').autocomplete = setupNeeded ? 'new-password' : 'current-password';
  }
}
function showDashboard() {
  $('#auth-screen').hidden = true;
  $('#dashboard').hidden = false;
  $('#user-name').textContent = user.display_name;
  $('#user-role').textContent = user.role === 'owner' ? 'Yönetici' : 'Editör';
  document.querySelectorAll('.owner-only').forEach(item => item.hidden = user.role !== 'owner');
}
function switchSection(section) {
  const titles = { overview: 'Genel Bakış', products: 'Menü Yönetimi', settings: 'Restoran Bilgileri', users: 'Kullanıcılar' };
  document.querySelectorAll('.admin-section').forEach(item => { item.hidden = item.id !== `${section}-section`; });
  document.querySelectorAll('.side-link').forEach(item => item.classList.toggle('active', item.dataset.section === section));
  $('#section-title').textContent = titles[section];
  if (section === 'users' && user.role === 'owner') loadUsers();
  if (section === 'settings' && user.role === 'owner') fillSettings();
}
async function loadSummary() {
  const summary = await api('/api/admin/summary');
  $('#stat-draft').textContent = summary.draft;
  $('#stat-published').textContent = summary.published;
  $('#stat-flagged').textContent = summary.flagged;
  $('#stat-users').textContent = summary.staff;
  $('#last-publish').textContent = summary.lastPublish ? `Son yayın: ${summary.lastPublish}` : 'İlk taslak menü hazır';
}
async function loadProducts() {
  const data = await api('/api/admin/products');
  products = data.products;
  settings = data.settings;
  const categories = [...new Set(products.map(item => item.category))];
  const select = $('#admin-category');
  const previous = select.value;
  select.replaceChildren(new Option('Tüm kategoriler', ''));
  const datalist = $('#category-list');
  datalist.replaceChildren();
  for (const category of categories) { select.add(new Option(category, category)); const option = document.createElement('option'); option.value = category; datalist.append(option); }
  select.value = categories.includes(previous) ? previous : '';
  renderProducts();
}
function renderProducts() {
  const search = $('#admin-search').value.trim().toLocaleLowerCase('tr');
  const category = $('#admin-category').value;
  const reviewOnly = $('#review-only').checked;
  const filtered = products.filter(item => (!category || item.category === category)
    && (!search || `${item.name} ${item.category}`.toLocaleLowerCase('tr').includes(search))
    && (!reviewOnly || item.review_note || item.price_try == null));
  const list = $('#product-list');
  list.replaceChildren();
  if (!filtered.length) { list.append(node('p', 'empty-state', 'Bu filtreye uygun ürün bulunamadı.')); return; }
  for (const item of filtered) {
    const row = node('div', 'admin-product-row');
    const title = node('div', 'admin-product-title');
    title.append(node('strong', '', item.name), node('span', '', item.category));
    if (item.review_note || item.price_try == null) title.append(node('small', 'review-note', item.review_note || 'Fiyat kontrol edilecek'));
    const price = node('strong', 'admin-price', money(item.price_try));
    const status = node('span', item.available ? 'availability yes' : 'availability no', item.available ? 'Satışta' : 'Tükendi');
    const edit = node('button', 'row-edit', 'Düzenle ↗'); edit.type = 'button'; edit.addEventListener('click', () => openProduct(item));
    row.append(title, price, status, edit); list.append(row);
  }
}
function openProduct(item = null) {
  $('#product-form').reset();
  $('#product-id').value = item?.id || '';
  $('#delete-product').hidden = !item;
  $('#product-form-title').textContent = item ? 'Ürünü Düzenle' : 'Yeni Ürün';
  $('#product-category').value = item?.category || '';
  $('#product-name').value = item?.name || '';
  $('#product-price').value = item?.price_try ?? '';
  $('#product-description').value = item?.description || '';
  $('#product-available').checked = item?.available ?? true;
  $('#product-note').value = item?.review_note || '';
  $('#product-image-url').value = item?.image_url || '';
  message('#product-message', '');
  $('#product-modal').showModal();
}
async function uploadImage(file) {
  if (file.size > 3_000_000) throw new Error('Görsel en fazla 3 MB olabilir.');
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  return (await send('/api/admin/upload', 'POST', { data })).url;
}
function fillSettings() {
  for (const key of ['name', 'tagline', 'phone', 'hours', 'address', 'mapsUrl', 'instagramUrl', 'publicBaseUrl']) $(`#setting-${key}`).value = settings[key] || '';
}
async function loadUsers() {
  try {
    const data = await api('/api/admin/users');
    const list = $('#users-list'); list.replaceChildren();
    for (const account of data.users) {
      const row = node('div', 'user-row');
      const info = node('div'); info.append(node('strong', '', account.display_name), node('span', '', `@${account.username} · ${account.role === 'owner' ? 'Yönetici' : 'Editör'}`));
      const state = node('span', account.active ? 'availability yes' : 'availability no', account.active ? 'Aktif' : 'Kapalı');
      row.append(info, state);
      if (account.role !== 'owner') {
        const toggle = node('button', 'row-edit', account.active ? 'Hesabı Kapat' : 'Hesabı Aç');
        toggle.type = 'button';
        toggle.addEventListener('click', async () => {
          try { await send(`/api/admin/users/${account.id}`, 'PATCH', { active: !account.active }); await loadUsers(); await loadSummary(); }
          catch (error) { message('#users-message', error.message, true); }
        });
        row.append(toggle);
      }
      list.append(row);
    }
  } catch (error) { message('#users-message', error.message, true); }
}

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const payload = { username: $('#username').value, password: $('#password').value, displayName: $('#display-name').value, setupKey: $('#setup-key').value };
    await send(setupNeeded ? '/api/setup' : '/api/login', 'POST', payload);
    const result = await api('/api/admin/me'); user = result.user; showDashboard();
    await Promise.all([loadSummary(), loadProducts()]);
  } catch (error) { message('#auth-message', error.message, true); }
});
function showRecovery(open) {
  $('#auth-form').hidden = open;
  $('#show-recovery').hidden = open || setupNeeded;
  $('#recovery-form').hidden = !open;
  $('#auth-title').textContent = open ? 'Yönetici şifresini sıfırla' : 'Yönetim girişi';
  $('#auth-subtitle').textContent = open ? 'Kurulum anahtarınızla yeni bir şifre belirleyin.' : 'Menünüzü yönetmek için giriş yapın.';
  message('#auth-message', '');
  message('#recovery-message', '');
  if (open) $('#recovery-username').value = $('#username').value;
}
$('#show-recovery').addEventListener('click', () => showRecovery(true));
$('#back-to-login').addEventListener('click', () => showRecovery(false));
$('#recovery-form').addEventListener('submit', async event => {
  event.preventDefault();
  const username = $('#recovery-username').value.trim();
  const password = $('#recovery-password').value;
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return message('#recovery-message', 'Yönetici kullanıcı adını girin; ad soyad veya e-posta adresi kullanmayın.', true);
  if (password.length < 12 || password.length > 128) return message('#recovery-message', 'Yeni şifre 12–128 karakter olmalı.', true);
  if (password !== $('#recovery-confirm').value) return message('#recovery-message', 'Yeni şifreler eşleşmiyor.', true);
  try {
    await send('/api/recover-owner', 'POST', { username, recoveryKey: $('#recovery-key').value, password });
    $('#recovery-form').reset();
    showRecovery(false);
    $('#username').value = username;
    $('#password').value = '';
    message('#auth-message', 'Şifreniz yenilendi. Yeni şifrenizle giriş yapın. Kurulum anahtarını Vercel’de yenileyin.');
  } catch (error) { message('#recovery-message', error.message, true); }
});
$('#logout-button').addEventListener('click', async () => { await send('/api/logout', 'POST', {}); location.reload(); });
document.querySelectorAll('.side-link').forEach(button => button.addEventListener('click', () => switchSection(button.dataset.section)));
$('#admin-search').addEventListener('input', renderProducts);
$('#admin-category').addEventListener('change', renderProducts);
$('#review-only').addEventListener('change', renderProducts);
$('#add-product').addEventListener('click', () => openProduct());
$('#close-product').addEventListener('click', () => $('#product-modal').close());
$('#cancel-product').addEventListener('click', () => $('#product-modal').close());
$('#delete-product').addEventListener('click', async () => {
  const id = $('#product-id').value;
  if (!id || !confirm('Bu ürün taslaktan silinsin mi? Yayındaki menü bir sonraki yayına kadar değişmez.')) return;
  try { await api(`/api/admin/products/${id}`, { method: 'DELETE' }); $('#product-modal').close(); await loadProducts(); await loadSummary(); }
  catch (error) { message('#product-message', error.message, true); }
});
$('#product-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const file = $('#product-image').files[0];
    let imageUrl = $('#product-image-url').value;
    if (file) imageUrl = await uploadImage(file);
    const payload = {
      category: $('#product-category').value, name: $('#product-name').value,
      price_try: $('#product-price').value, description: $('#product-description').value,
      available: $('#product-available').checked, image_url: imageUrl, review_note: $('#product-note').value
    };
    const id = $('#product-id').value;
    await send(id ? `/api/admin/products/${id}` : '/api/admin/products', id ? 'PATCH' : 'POST', payload);
    $('#product-modal').close(); await loadProducts(); await loadSummary();
  } catch (error) { message('#product-message', error.message, true); }
});
$('#publish-button').addEventListener('click', async () => {
  if (!confirm('Taslak menüdeki değişiklikler ziyaretçilere gösterilsin mi?')) return;
  try { await send('/api/admin/publish', 'POST', {}); message('#publish-message', 'Menü yayınlandı.'); await loadSummary(); }
  catch (error) { message('#publish-message', error.message, true); }
});
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const payload = Object.fromEntries(['name', 'tagline', 'phone', 'hours', 'address', 'mapsUrl', 'instagramUrl', 'publicBaseUrl'].map(key => [key, $(`#setting-${key}`).value]));
    await send('/api/admin/settings', 'PATCH', payload); settings = payload; message('#settings-message', 'Bilgiler kaydedildi.');
  } catch (error) { message('#settings-message', error.message, true); }
});
$('#user-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await send('/api/admin/users', 'POST', { displayName: $('#new-display-name').value, username: $('#new-username').value, password: $('#new-password').value });
    $('#user-form').reset(); message('#users-message', 'Editör hesabı oluşturuldu. Şifreyi güvenli şekilde paylaşın.');
    await loadUsers(); await loadSummary();
  } catch (error) { message('#users-message', error.message, true); }
});
boot().catch(error => { $('#auth-screen').hidden = false; message('#auth-message', error.message, true); });
