import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import QRCode from 'qrcode';

const root = resolve(import.meta.dirname);
const dataDir = resolve(process.env.RAYKENT_DATA_DIR || join(root, 'data'));
const uploadsDir = join(dataDir, 'uploads');
mkdirSync(uploadsDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'raykent.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','editor')),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS draft_products (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_try INTEGER,
    available INTEGER NOT NULL DEFAULT 1,
    image_url TEXT NOT NULL DEFAULT '',
    review_note TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS published_products (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_try INTEGER,
    available INTEGER NOT NULL DEFAULT 1,
    image_url TEXT NOT NULL DEFAULT '',
    review_note TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS used_recovery_keys (
    key_hash TEXT PRIMARY KEY,
    used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const defaults = {
  name: 'Raykent Özlem Pide',
  tagline: "1993'ten beri",
  phone: '0222 310 25 18',
  address: 'Ertuğrulgazi, Selcan Sk. No:15, 26150 Tepebaşı/Eskişehir',
  mapsUrl: 'https://maps.app.goo.gl/PPYUTXS3xVezweHs9',
  hours: 'Her gün 11:30–21:00',
  instagramUrl: '',
  publicBaseUrl: ''
};
for (const [key, value] of Object.entries(defaults)) {
  db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)').run(key, value);
}

const generatedImageMap = JSON.parse(readFileSync(join(root, 'menu-image-map.json'), 'utf8'));

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { cells.push(current); current = ''; }
    else current += char;
  }
  cells.push(current);
  return cells;
}

if (db.prepare('SELECT COUNT(*) AS count FROM draft_products').get().count === 0) {
  const csv = readFileSync(join(root, 'menu-seed.csv'), 'utf8').replace(/^\uFEFF/, '').trim();
  const rows = csv.split(/\r?\n/).slice(1).map(parseCsvLine);
  const insert = db.prepare(`INSERT INTO draft_products
    (category,name,price_try,review_note,sort_order) VALUES (?,?,?,?,?)`);
  const insertPublished = db.prepare(`INSERT INTO published_products
    (category,name,price_try,review_note,sort_order) VALUES (?,?,?,?,?)`);
  db.exec('BEGIN');
  try {
    rows.forEach(([category, name, price, reviewNote], index) => {
      const args = [category, name, price === '' ? null : Number(price), reviewNote || '', index];
      insert.run(...args);
      insertPublished.run(...args);
    });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
for (const table of ['draft_products', 'published_products']) {
  for (const [english, turkish] of [
    ['Price handwriting to verify', 'El yazısı fiyatı kontrol edilecek'],
    ['Price not legible in photo', 'Fotoğrafta fiyat okunmuyor'],
    ['Item name and price to verify', 'Ürün adı ve fiyat kontrol edilecek']
  ]) db.prepare(`UPDATE ${table} SET review_note=? WHERE review_note=?`).run(turkish, english);
}
if (!db.prepare("SELECT 1 FROM settings WHERE key='generated_images_v1'").get()) {
  db.exec('BEGIN');
  try {
    for (const table of ['draft_products', 'published_products']) {
      const update = db.prepare(`UPDATE ${table} SET image_url=? WHERE name=? AND image_url=''`);
      for (const [name, filename] of Object.entries(generatedImageMap)) update.run(`/menu-images/${filename}`, name);
    }
    db.prepare("INSERT INTO settings(key,value) VALUES('generated_images_v1','1')").run();
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};
const fail = (res, status, message) => json(res, status, { error: message });
const loginAttempts = new Map();
const settings = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(row => [row.key, row.value]));
const products = table => db.prepare(`SELECT * FROM ${table} ORDER BY sort_order,id`).all().map(row => ({
  ...row, available: Boolean(row.available)
}));
const hashToken = token => createHash('sha256').update(token).digest('hex');
const hashPassword = password => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
};
const verifyPassword = (password, stored) => {
  const [salt, hex] = String(stored).split(':');
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
const cookieToken = req => {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)raykent_session=([^;]+)/);
  return match?.[1] || '';
};
function currentUser(req) {
  const token = cookieToken(req);
  if (!token) return null;
  return db.prepare(`SELECT u.id,u.username,u.display_name,u.role,u.active
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(hashToken(token), Date.now()) || null;
}
function setSession(res, userId, secure) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)')
    .run(hashToken(token), userId, Date.now() + 14 * 24 * 60 * 60 * 1000);
  res.setHeader('Set-Cookie', `raykent_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1209600${secure ? '; Secure' : ''}`);
}
async function bodyJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('JSON gerekli.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5_000_000) throw new Error('İstek çok büyük.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function validUsername(value) { return typeof value === 'string' && /^[a-zA-Z0-9_.-]{3,32}$/.test(value); }
function validPassword(value) { return typeof value === 'string' && value.length >= 12 && value.length <= 128; }
function audit(userId, action, details = '') {
  db.prepare('INSERT INTO audit(user_id,action,details) VALUES (?,?,?)').run(userId, action, details);
}
function validateProduct(input) {
  if (!input || typeof input !== 'object') throw new Error('Ürün bilgisi gerekli.');
  const category = String(input.category || '').trim();
  const name = String(input.name || '').trim();
  const description = String(input.description || '').trim();
  const imageUrl = String(input.image_url || '').trim();
  const price = input.price_try === '' || input.price_try == null ? null : Number(input.price_try);
  if (!category || category.length > 80 || !name || name.length > 120) throw new Error('Kategori ve ürün adı gerekli.');
  if (description.length > 600) throw new Error('Açıklama çok uzun.');
  if (price !== null && (!Number.isInteger(price) || price < 0 || price > 100000)) throw new Error('Geçerli bir fiyat girin.');
  if (imageUrl && !/^\/uploads\/[a-f0-9]{32}\.(?:png|jpg|webp)$/.test(imageUrl)
    && !/^\/menu-images\/[a-z0-9-]+\.webp$/.test(imageUrl)) throw new Error('Geçersiz görsel.');
  return { category, name, description, price, imageUrl, available: input.available ? 1 : 0, reviewNote: String(input.review_note || '').slice(0, 200) };
}

const staticFiles = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/menu', ['public/menu.html', 'text/html; charset=utf-8']],
  ['/admin', ['public/admin.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/restaurant-front.png', ['public/restaurant-front.png', 'image/png']],
  ['/menu.js', ['public/menu.js', 'text/javascript; charset=utf-8']],
  ['/admin.js', ['public/admin.js', 'text/javascript; charset=utf-8']]
]);

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method || 'GET';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      const host = req.headers.host;
      if (origin && new URL(origin).host !== host) return fail(res, 403, 'İstek engellendi.');
    }
    if (method === 'GET' && path === '/api/public') return json(res, 200, {
      settings: settings(),
      products: products('published_products').map(({ review_note, ...item }) => item)
    });
    if (method === 'GET' && path === '/api/setup-status') return json(res, 200, { setupNeeded: db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0 });
    if (method === 'GET' && path === '/q') {
      res.writeHead(302, { Location: '/menu', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (method === 'POST' && path === '/api/setup') {
      if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count) return fail(res, 409, 'Kurulum tamamlanmış.');
      const input = await bodyJson(req);
      if (!validUsername(input.username) || !validPassword(input.password) || !String(input.displayName || '').trim()) return fail(res, 400, 'Kullanıcı adı, ad ve en az 12 karakterli şifre girin.');
      const result = db.prepare('INSERT INTO users(username,display_name,role,password_hash) VALUES (?,?,?,?)')
        .run(input.username, String(input.displayName).trim().slice(0, 80), 'owner', hashPassword(input.password));
      setSession(res, Number(result.lastInsertRowid), req.socket.encrypted);
      audit(Number(result.lastInsertRowid), 'owner_setup');
      return json(res, 201, { ok: true });
    }
    if (method === 'POST' && path === '/api/login') {
      const address = req.socket.remoteAddress || 'unknown';
      const attempt = loginAttempts.get(address) || { count: 0, until: 0 };
      if (attempt.count >= 8 && attempt.until > Date.now()) return fail(res, 429, 'Çok fazla deneme. Daha sonra tekrar deneyin.');
      const input = await bodyJson(req);
      const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(String(input.username || ''));
      if (!user || !verifyPassword(String(input.password || ''), user.password_hash)) {
        loginAttempts.set(address, { count: attempt.count + 1, until: Date.now() + 15 * 60 * 1000 });
        return fail(res, 401, 'Kullanıcı adı veya şifre hatalı.');
      }
      loginAttempts.delete(address);
      setSession(res, user.id, req.socket.encrypted);
      audit(user.id, 'login');
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/api/recover-owner') {
      const input = await bodyJson(req);
      if (!validUsername(input.username) || !validPassword(input.password)) return fail(res, 400, 'Kullanıcı adı ve en az 12 karakterli yeni şifre girin.');
      const recoveryKey = process.env.ADMIN_SETUP_KEY;
      if (!recoveryKey) return fail(res, 503, 'Şifre kurtarma sunucuda yapılandırılmamış.');
      const address = req.socket.remoteAddress || 'unknown';
      const attemptKey = `owner-recovery:${address}`;
      const attempt = loginAttempts.get(attemptKey) || { count: 0, until: 0 };
      if (attempt.count >= 8 && attempt.until > Date.now()) return fail(res, 429, 'Çok fazla deneme. 15 dakika sonra tekrar deneyin.');
      const providedKey = typeof input.recoveryKey === 'string' ? input.recoveryKey : '';
      const providedHash = Buffer.from(hashToken(providedKey), 'hex');
      const expectedHash = Buffer.from(hashToken(recoveryKey), 'hex');
      const owner = db.prepare("SELECT id FROM users WHERE username=? AND role='owner' AND active=1").get(input.username);
      if (!owner || !timingSafeEqual(providedHash, expectedHash)) {
        loginAttempts.set(attemptKey, { count: attempt.until < Date.now() ? 1 : attempt.count + 1, until: Date.now() + 15 * 60000 });
        return fail(res, 403, 'Kullanıcı adı veya kurtarma anahtarı yanlış.');
      }
      db.exec('BEGIN');
      try {
        const consumed = db.prepare('INSERT OR IGNORE INTO used_recovery_keys(key_hash) VALUES(?)').run(hashToken(recoveryKey));
        if (!consumed.changes) { db.exec('ROLLBACK'); return fail(res, 409, 'Bu kurtarma anahtarı kullanıldı. Yeni bir kurulum anahtarı oluşturun.'); }
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(input.password), owner.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(owner.id);
        audit(owner.id, 'owner_password_recovery');
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      loginAttempts.delete(attemptKey);
      res.setHeader('Set-Cookie', 'raykent_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/api/logout') {
      const token = cookieToken(req);
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
      res.setHeader('Set-Cookie', 'raykent_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (path.startsWith('/api/admin/')) {
      const user = currentUser(req);
      if (!user) return fail(res, 401, 'Giriş gerekli.');
      if (method === 'GET' && path === '/api/admin/me') return json(res, 200, { user });
      if (method === 'GET' && path === '/api/admin/qr') {
        const base = settings().publicBaseUrl;
        if (!base) return fail(res, 400, 'QR kodu için önce yayın adresini restoran bilgilerinden girin.');
        const target = new URL('/q', base).href;
        const svg = await QRCode.toString(target, { type: 'svg', errorCorrectionLevel: 'H', margin: 4, width: 800 });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Disposition': 'attachment; filename="raykent-menu-qr.svg"', 'Cache-Control': 'no-store' });
        res.end(svg);
        return;
      }
      if (method === 'GET' && path === '/api/admin/products') return json(res, 200, { products: products('draft_products'), settings: settings() });
      if (method === 'GET' && path === '/api/admin/summary') {
        const draft = db.prepare('SELECT COUNT(*) AS count FROM draft_products').get().count;
        const published = db.prepare('SELECT COUNT(*) AS count FROM published_products').get().count;
        const flagged = db.prepare("SELECT COUNT(*) AS count FROM draft_products WHERE review_note<>'' OR price_try IS NULL").get().count;
        const staff = db.prepare('SELECT COUNT(*) AS count FROM users WHERE active=1').get().count;
        const lastPublish = db.prepare("SELECT created_at FROM audit WHERE action='publish' ORDER BY id DESC LIMIT 1").get()?.created_at || null;
        return json(res, 200, { draft, published, flagged, staff, lastPublish });
      }
      if (method === 'POST' && path === '/api/admin/products') {
        const item = validateProduct(await bodyJson(req));
        const nextOrder = db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM draft_products').get().n;
        const result = db.prepare(`INSERT INTO draft_products(category,name,description,price_try,available,image_url,review_note,sort_order)
          VALUES (?,?,?,?,?,?,?,?)`).run(item.category, item.name, item.description, item.price, item.available, item.imageUrl, item.reviewNote, nextOrder);
        audit(user.id, 'create_product', String(result.lastInsertRowid));
        return json(res, 201, { id: Number(result.lastInsertRowid) });
      }
      const productMatch = path.match(/^\/api\/admin\/products\/(\d+)$/);
      if (method === 'PATCH' && productMatch) {
        const id = Number(productMatch[1]);
        if (!db.prepare('SELECT id FROM draft_products WHERE id=?').get(id)) return fail(res, 404, 'Ürün bulunamadı.');
        const item = validateProduct(await bodyJson(req));
        db.prepare(`UPDATE draft_products SET category=?,name=?,description=?,price_try=?,available=?,image_url=?,review_note=? WHERE id=?`)
          .run(item.category, item.name, item.description, item.price, item.available, item.imageUrl, item.reviewNote, id);
        audit(user.id, 'update_product', String(id));
        return json(res, 200, { ok: true });
      }
      if (method === 'DELETE' && productMatch) {
        db.prepare('DELETE FROM draft_products WHERE id=?').run(Number(productMatch[1]));
        audit(user.id, 'delete_product', productMatch[1]);
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && path === '/api/admin/publish') {
        if (user.role !== 'owner') return fail(res, 403, 'Yayınlama yetkisi gerekli.');
        db.exec('BEGIN');
        try {
          db.exec('DELETE FROM published_products');
          db.exec(`INSERT INTO published_products SELECT * FROM draft_products`);
          audit(user.id, 'publish', String(db.prepare('SELECT COUNT(*) AS count FROM draft_products').get().count));
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return json(res, 200, { ok: true });
      }
      if (method === 'PATCH' && path === '/api/admin/settings') {
        if (user.role !== 'owner') return fail(res, 403, 'Yönetici yetkisi gerekli.');
        const input = await bodyJson(req);
        const updates = [];
        for (const key of Object.keys(defaults)) {
          if (Object.hasOwn(input, key)) {
            const value = String(input[key] ?? '').trim();
            if (value.length > 300) return fail(res, 400, 'Alan çok uzun.');
            if (key.endsWith('Url') && value && !/^https:\/\//.test(value)) return fail(res, 400, 'Geçerli bir HTTPS bağlantısı girin.');
            if (key === 'publicBaseUrl' && value) {
              let parsed;
              try { parsed = new URL(value); } catch { return fail(res, 400, 'Geçerli bir yayın adresi girin.'); }
              if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return fail(res, 400, 'Yayın adresi yalnızca ana alan adı olmalı.');
            }
            updates.push([key, value]);
          }
        }
        db.exec('BEGIN');
        try {
          for (const [key, value] of updates) db.prepare('UPDATE settings SET value=? WHERE key=?').run(value, key);
          audit(user.id, 'update_settings');
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && path === '/api/admin/upload') {
        const input = await bodyJson(req);
        const match = String(input.data || '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
        if (!match) return fail(res, 400, 'PNG, JPG veya WebP görsel yükleyin.');
        const bytes = Buffer.from(match[2], 'base64');
        if (!bytes.length || bytes.length > 3_000_000) return fail(res, 400, 'Görsel en fazla 3 MB olabilir.');
        const signature = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          : match[1] === 'jpeg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
          : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
        if (!signature) return fail(res, 400, 'Görsel dosyası geçersiz.');
        const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
        const filename = `${randomBytes(16).toString('hex')}.${extension}`;
        writeFileSync(join(uploadsDir, filename), bytes, { flag: 'wx' });
        audit(user.id, 'upload_image', filename);
        return json(res, 201, { url: `/uploads/${filename}` });
      }
      if (user.role !== 'owner') return fail(res, 403, 'Yönetici yetkisi gerekli.');
      if (method === 'GET' && path === '/api/admin/users') {
        return json(res, 200, { users: db.prepare('SELECT id,username,display_name,role,active,created_at FROM users ORDER BY id').all() });
      }
      if (method === 'POST' && path === '/api/admin/users') {
        const input = await bodyJson(req);
        if (!validUsername(input.username) || !validPassword(input.password) || !String(input.displayName || '').trim()) return fail(res, 400, 'Kullanıcı adı, ad ve en az 12 karakterli şifre girin.');
        try {
          const result = db.prepare('INSERT INTO users(username,display_name,role,password_hash) VALUES (?,?,?,?)')
            .run(input.username, String(input.displayName).trim().slice(0, 80), 'editor', hashPassword(input.password));
          audit(user.id, 'create_editor', String(result.lastInsertRowid));
          return json(res, 201, { id: Number(result.lastInsertRowid) });
        } catch (error) { if (String(error).includes('UNIQUE')) return fail(res, 409, 'Kullanıcı adı kullanılıyor.'); throw error; }
      }
      const userMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);
      if (method === 'PATCH' && userMatch) {
        const target = Number(userMatch[1]);
        const input = await bodyJson(req);
        if (target === user.id) return fail(res, 400, 'Kendi hesabınızı buradan kapatamazsınız.');
        if (!db.prepare("SELECT id FROM users WHERE id=? AND role='editor'").get(target)) return fail(res, 404, 'Hesap bulunamadı.');
        db.prepare('UPDATE users SET active=? WHERE id=?').run(input.active ? 1 : 0, target);
        if (!input.active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(target);
        audit(user.id, input.active ? 'enable_editor' : 'disable_editor', String(target));
        return json(res, 200, { ok: true });
      }
      return fail(res, 404, 'İşlem bulunamadı.');
    }
    if (method === 'GET' && /^\/uploads\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(path)) {
      const file = join(uploadsDir, path.split('/').at(-1));
      if (!existsSync(file)) return fail(res, 404, 'Görsel bulunamadı.');
      res.writeHead(200, { 'Content-Type': `image/${extname(file) === '.jpg' ? 'jpeg' : extname(file).slice(1)}`, 'Cache-Control': 'public, max-age=86400' });
      res.end(readFileSync(file));
      return;
    }
    if (method === 'GET' && /^\/menu-images\/[a-z0-9-]+\.webp$/.test(path)) {
      const file = join(root, 'public', 'menu-images', path.split('/').at(-1));
      if (!existsSync(file)) return fail(res, 404, 'Görsel bulunamadı.');
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' });
      res.end(readFileSync(file));
      return;
    }
    if (method === 'GET' && staticFiles.has(path)) {
      const [file, contentType] = staticFiles.get(path);
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      res.end(readFileSync(join(root, file)));
      return;
    }
    return fail(res, 404, 'Sayfa bulunamadı.');
  } catch (error) {
    if (error instanceof SyntaxError) return fail(res, 400, 'Geçersiz JSON.');
    if (error.message?.includes('JSON gerekli') || error.message?.includes('İstek çok büyük') || error.message?.includes('Ürün bilgisi') || error.message?.includes('gerekli') || error.message?.includes('Geçerli') || error.message?.includes('çok uzun') || error.message?.includes('Geçersiz görsel')) return fail(res, 400, error.message);
    console.error(error);
    return fail(res, 500, 'Beklenmeyen bir hata oluştu.');
  }
});

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT || 3100);
  server.listen(port, '127.0.0.1', () => console.log(`Raykent app: http://127.0.0.1:${port}`));
}
