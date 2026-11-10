const $ = selector => document.querySelector(selector);
const currency = value => value == null ? 'Fiyat sorunuz' : new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 0 }).format(value);
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
let allProducts = [];
let currentCategory = 'Tümü';

async function loadSite() {
  const preview = location.search.includes('preview=1');
  const response = await fetch(preview ? '/api/admin/products' : '/api/public');
  if (!response.ok) throw new Error(preview && response.status === 401 ? 'Önizleme için yönetici girişi gerekiyor.' : 'Menü yüklenemedi.');
  const data = await response.json();
  allProducts = data.products;
  document.title = `${$('#menu-content') ? 'Menü | ' : ''}${data.settings.name}`;
  if (preview && $('#preview-banner')) $('#preview-banner').hidden = false;
  if ($('#menu-content')) {
    const hashCategory = decodeURIComponent(location.hash.slice(1));
    if (allProducts.some(item => item.category === hashCategory)) currentCategory = hashCategory;
    renderMenu();
  }
  if ($('#address')) $('#address').textContent = data.settings.address;
  if ($('#hours')) $('#hours').textContent = data.settings.hours;
  if ($('#phone')) $('#phone').textContent = data.settings.phone;
  for (const selector of ['#map-link', '#hero-directions']) { const link = $(selector); if (link) link.href = data.settings.mapsUrl; }
  for (const selector of ['#call-link', '#header-call']) { const link = $(selector); if (link) link.href = `tel:${data.settings.phone.replace(/[^+\d]/g, '')}`; }
}

function renderMenu() {
  const nav = $('#category-nav');
  const content = $('#menu-content');
  const search = ($('#menu-search')?.value || '').trim().toLocaleLowerCase('tr');
  const categories = [...new Set(allProducts.map(item => item.category))];
  if (!categories.includes(currentCategory)) currentCategory = 'Tümü';
  nav.replaceChildren();
  for (const category of ['Tümü', ...categories]) {
    const button = el('button', category === currentCategory ? 'category-chip active' : 'category-chip', category);
    button.type = 'button';
    button.addEventListener('click', () => { currentCategory = category; renderMenu(); window.scrollTo({ top: 220, behavior: 'smooth' }); });
    nav.append(button);
  }
  const visible = allProducts.filter(item => (currentCategory === 'Tümü' || item.category === currentCategory)
    && (!search || `${item.name} ${item.description} ${item.category}`.toLocaleLowerCase('tr').includes(search)));
  $('#menu-count').textContent = `${visible.length} ürün`;
  content.replaceChildren();
  if (!visible.length) { content.append(el('p', 'empty-state', 'Aradığınız ürün bulunamadı. Farklı bir kelime deneyin.')); return; }
  const groups = currentCategory === 'Tümü' ? [...new Set(visible.map(item => item.category))] : [currentCategory];
  for (const category of groups) {
    const section = el('section', 'menu-section');
    section.id = category;
    const heading = el('div', 'menu-section-heading');
    heading.append(el('h2', '', category), el('span', '', `${visible.filter(item => item.category === category).length} çeşit`));
    section.append(heading);
    const grid = el('div', 'product-grid');
    for (const item of visible.filter(product => product.category === category)) {
      const card = el('button', 'product-card');
      card.type = 'button';
      card.setAttribute('aria-label', `${item.name}, ${currency(item.price_try)}${item.available ? '' : ', tükendi'}`);
      if (item.image_url) { const image = el('img', 'product-image'); image.src = item.image_url; image.alt = `${item.name} için temsili görsel`; image.loading = 'lazy'; card.append(image); }
      else { const icon = el('div', 'product-placeholder', category.includes('İçecek') ? '◌' : category.includes('Tatlı') ? '✦' : '◒'); icon.setAttribute('aria-hidden', 'true'); card.append(icon); }
      const text = el('div', 'product-info');
      const top = el('div', 'product-top'); top.append(el('h3', '', item.name), el('strong', '', currency(item.price_try)));
      text.append(top);
      if (item.description) text.append(el('p', '', item.description));
      if (!item.available) text.append(el('span', 'sold-out', 'Tükendi'));
      card.append(text);
      card.addEventListener('click', () => showProduct(item));
      grid.append(card);
    }
    section.append(grid); content.append(section);
  }
}

function showProduct(item) {
  const dialog = $('#product-dialog');
  const body = $('#dialog-body');
  body.replaceChildren();
  if (item.image_url) { const image = el('img', 'dialog-image'); image.src = item.image_url; image.alt = `${item.name} için temsili görsel`; body.append(image, el('small', 'dialog-image-note', 'Temsili görsel')); }
  body.append(el('span', 'eyebrow dark', item.category), el('h2', '', item.name));
  if (item.description) body.append(el('p', 'dialog-description', item.description));
  body.append(el('strong', 'dialog-price', currency(item.price_try)));
  if (!item.available) body.append(el('p', 'sold-out', 'Şu anda tükendi'));
  dialog.showModal();
}

$('#menu-search')?.addEventListener('input', renderMenu);
$('#close-dialog')?.addEventListener('click', () => $('#product-dialog').close());
$('#product-dialog')?.addEventListener('click', event => { if (event.target === $('#product-dialog')) $('#product-dialog').close(); });
loadSite().catch(error => { if ($('#menu-content')) $('#menu-content').textContent = error.message; });
