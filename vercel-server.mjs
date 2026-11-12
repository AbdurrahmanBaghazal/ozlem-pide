import { createServer } from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import pg from 'pg';
import QRCode from 'qrcode';

const root = resolve(import.meta.dirname);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const defaults = {
  name: 'Raykent Özlem Pide', tagline: "1993'ten beri", phone: '0222 310 25 18',
  address: 'Ertuğrulgazi, Selcan Sk. No:15, 26150 Tepebaşı/Eskişehir',
  mapsUrl: 'https://maps.app.goo.gl/PPYUTXS3xVezweHs9', hours: 'Her gün 11:30–21:00',
  instagramUrl: '', publicBaseUrl: ''
};
const imageMap = JSON.parse(readFileSync(join(root, 'menu-image-map.json'), 'utf8'));
let readyPromise;

function parseCsvLine(line) {
  const cells = []; let current = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (line[i] === ',' && !quoted) { cells.push(current); current = ''; }
    else current += line[i];
  }
  cells.push(current); return cells;
}

async function initialize() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for Vercel deployment');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(31001993)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner','editor')), password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS draft_products (
        id BIGSERIAL PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', price_try INTEGER, available INTEGER NOT NULL DEFAULT 1,
        image_url TEXT NOT NULL DEFAULT '', review_note TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS published_products (LIKE draft_products INCLUDING ALL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (
        id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(id), action TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS uploaded_images (
        filename TEXT PRIMARY KEY, mime_type TEXT NOT NULL, image_data BYTEA NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_attempts (
        attempt_key TEXT PRIMARY KEY, attempt_count INTEGER NOT NULL, blocked_until BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS used_recovery_keys (
        key_hash TEXT PRIMARY KEY, used_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    for (const [key, value] of Object.entries(defaults)) {
      await client.query('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO NOTHING', [key, value]);
    }
    if (Number((await client.query('SELECT COUNT(*) AS n FROM draft_products')).rows[0].n) === 0) {
      const csv = readFileSync(join(root, 'menu-seed.csv'), 'utf8').replace(/^\uFEFF/, '').trim();
      const rows = csv.split(/\r?\n/).slice(1).map(parseCsvLine);
      const notes = new Map([
        ['Price handwriting to verify', 'El yazısı fiyatı kontrol edilecek'],
        ['Price not legible in photo', 'Fotoğrafta fiyat okunmuyor'],
        ['Item name and price to verify', 'Ürün adı ve fiyat kontrol edilecek']
      ]);
      await client.query('BEGIN');
      try {
        for (let i = 0; i < rows.length; i++) {
          const [category, name, price, note] = rows[i];
          const args = [category, name, price === '' ? null : Number(price), notes.get(note) || note || '', i, imageMap[name] ? `/menu-images/${imageMap[name]}` : ''];
          const result = await client.query('INSERT INTO draft_products(category,name,price_try,review_note,sort_order,image_url) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', args);
          await client.query('INSERT INTO published_products(id,category,name,price_try,review_note,sort_order,image_url) VALUES($1,$2,$3,$4,$5,$6,$7)', [result.rows[0].id, ...args]);
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(31001993)');
    client.release();
  }
}
function ensureReady() {
  if (!readyPromise) readyPromise = initialize().catch(error => { readyPromise = null; throw error; });
  return readyPromise;
}
const query = async (sql, args = []) => (await pool.query(sql, args)).rows;
const one = async (sql, args = []) => (await query(sql, args))[0] || null;
const json = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
};
const fail = (res, status, message) => json(res, status, { error: message });
const settings = async () => Object.fromEntries((await query('SELECT key,value FROM settings')).map(row => [row.key, row.value]));
const products = async table => (await query(`SELECT * FROM ${table} ORDER BY sort_order,id`)).map(row => ({ ...row, id: Number(row.id), available: Boolean(row.available) }));
const hashToken = token => createHash('sha256').update(token).digest('hex');
const hashPassword = password => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; };
const verifyPassword = (password, stored) => {
  const [salt, hex] = String(stored).split(':'); if (!salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex'); const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
const cookieToken = req => (req.headers.cookie || '').match(/(?:^|;\s*)raykent_session=([^;]+)/)?.[1] || '';
async function currentUser(req) {
  const token = cookieToken(req); if (!token) return null;
  const user = await one(`SELECT u.id,u.username,u.display_name,u.role,u.active FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.active=1`, [hashToken(token), Date.now()]);
  return user ? { ...user, id: Number(user.id) } : null;
}
async function setSession(res, userId) {
  const token = randomBytes(32).toString('hex');
  await query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [hashToken(token), userId, Date.now() + 14 * 86400000]);
  res.setHeader('Set-Cookie', `raykent_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1209600; Secure`);
}
async function bodyJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('JSON gerekli.');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 4_300_000) throw new Error('İstek çok büyük.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const validUsername = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{3,32}$/.test(value);
const validPassword = value => typeof value === 'string' && value.length >= 12 && value.length <= 128;
const audit = (userId, action, details = '') => query('INSERT INTO audit(user_id,action,details) VALUES($1,$2,$3)', [userId, action, details]);
function validateProduct(input) {
  if (!input || typeof input !== 'object') throw new Error('Ürün bilgisi gerekli.');
  const category = String(input.category || '').trim(), name = String(input.name || '').trim();
  const description = String(input.description || '').trim(), imageUrl = String(input.image_url || '').trim();
  const price = input.price_try === '' || input.price_try == null ? null : Number(input.price_try);
  if (!category || category.length > 80 || !name || name.length > 120) throw new Error('Kategori ve ürün adı gerekli.');
  if (description.length > 600) throw new Error('Açıklama çok uzun.');
  if (price !== null && (!Number.isInteger(price) || price < 0 || price > 100000)) throw new Error('Geçerli bir fiyat girin.');
  if (imageUrl && !/^\/uploads\/[a-f0-9]{32}\.(?:png|jpg|webp)$/.test(imageUrl) && !/^\/menu-images\/[a-z0-9-]+\.webp$/.test(imageUrl)) throw new Error('Geçersiz görsel.');
  return { category, name, description, price, imageUrl, available: input.available ? 1 : 0, reviewNote: String(input.review_note || '').slice(0, 200) };
}
const staticFiles = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']], ['/menu', ['public/menu.html', 'text/html; charset=utf-8']],
  ['/admin', ['public/admin.html', 'text/html; charset=utf-8']], ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/restaurant-front.png', ['public/restaurant-front.png', 'image/png']], ['/menu.js', ['public/menu.js', 'text/javascript; charset=utf-8']],
  ['/admin.js', ['public/admin.js', 'text/javascript; charset=utf-8']]
]);

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), path = url.pathname, method = req.method || 'GET';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin, host = req.headers.host;
      if (origin && new URL(origin).host !== host) return fail(res, 403, 'İstek engellendi.');
    }
    if (method === 'GET' && staticFiles.has(path)) {
      const [file, contentType] = staticFiles.get(path);
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      return res.end(readFileSync(join(root, file)));
    }
    if (method === 'GET' && /^\/menu-images\/[a-z0-9-]+\.webp$/.test(path)) {
      const file = join(root, 'public', 'menu-images', path.split('/').at(-1));
      if (!existsSync(file)) return fail(res, 404, 'Görsel bulunamadı.');
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' });
      return res.end(readFileSync(file));
    }
    await ensureReady();
    if (method === 'GET' && /^\/uploads\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(path)) {
      const image = await one('SELECT mime_type,image_data FROM uploaded_images WHERE filename=$1', [path.split('/').at(-1)]);
      if (!image) return fail(res, 404, 'Görsel bulunamadı.');
      res.writeHead(200, { 'Content-Type': image.mime_type, 'Cache-Control': 'public, max-age=86400' });
      return res.end(image.image_data);
    }
    if (method === 'GET' && path === '/api/public') return json(res, 200, { settings: await settings(), products: (await products('published_products')).map(({ review_note, ...item }) => item) });
    if (method === 'GET' && path === '/api/setup-status') return json(res, 200, { setupNeeded: Number((await one('SELECT COUNT(*) AS n FROM users')).n) === 0, requiresSetupKey: true });
    if (method === 'GET' && path === '/q') { res.writeHead(302, { Location: '/menu', 'Cache-Control': 'no-store' }); return res.end(); }
    if (method === 'POST' && path === '/api/setup') {
      const input = await bodyJson(req);
      if (!validUsername(input.username) || !validPassword(input.password) || !String(input.displayName || '').trim()) return fail(res, 400, 'Kullanıcı adı, ad ve en az 12 karakterli şifre girin.');
      const setupKey = process.env.ADMIN_SETUP_KEY;
      if (!setupKey || input.setupKey !== setupKey) return fail(res, 403, 'Kurulum anahtarı gerekli.');
      const client = await pool.connect();
      let ownerId;
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(31001994)');
        if (Number((await client.query('SELECT COUNT(*) AS n FROM users')).rows[0].n)) { await client.query('ROLLBACK'); return fail(res, 409, 'Kurulum tamamlanmış.'); }
        const result = await client.query('INSERT INTO users(username,display_name,role,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [input.username, String(input.displayName).trim().slice(0, 80), 'owner', hashPassword(input.password)]);
        ownerId = Number(result.rows[0].id);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      await setSession(res, ownerId); await audit(ownerId, 'owner_setup');
      return json(res, 201, { ok: true });
    }
    if (method === 'POST' && path === '/api/login') {
      const address = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
      const input = await bodyJson(req);
      const attemptKey = hashToken(`${address}:${String(input.username || '').toLowerCase()}`);
      const attempt = await one('SELECT attempt_count,blocked_until FROM login_attempts WHERE attempt_key=$1', [attemptKey]);
      if (attempt?.attempt_count >= 8 && Number(attempt.blocked_until) > Date.now()) return fail(res, 429, 'Çok fazla deneme. Daha sonra tekrar deneyin.');
      const user = await one('SELECT * FROM users WHERE lower(username)=lower($1) AND active=1', [String(input.username || '')]);
      if (!user || !verifyPassword(String(input.password || ''), user.password_hash)) {
        const now = Date.now();
        await query(`INSERT INTO login_attempts(attempt_key,attempt_count,blocked_until) VALUES($1,1,$2)
          ON CONFLICT(attempt_key) DO UPDATE SET
          attempt_count=CASE WHEN login_attempts.blocked_until<$3 THEN 1 ELSE login_attempts.attempt_count+1 END,
          blocked_until=$2`, [attemptKey, now + 15 * 60000, now]);
        return fail(res, 401, 'Kullanıcı adı veya şifre hatalı.');
      }
      await query('DELETE FROM login_attempts WHERE attempt_key=$1', [attemptKey]);
      await setSession(res, user.id); await audit(user.id, 'login');
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/api/recover-owner') {
      const input = await bodyJson(req);
      if (!validUsername(input.username) || !validPassword(input.password)) return fail(res, 400, 'Kullanıcı adı ve en az 12 karakterli yeni şifre girin.');
      const recoveryKey = process.env.ADMIN_SETUP_KEY;
      if (!recoveryKey) return fail(res, 503, 'Şifre kurtarma sunucuda yapılandırılmamış.');
      const address = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
      const attemptKey = hashToken(`owner-recovery:${address}`);
      const attempt = await one('SELECT attempt_count,blocked_until FROM login_attempts WHERE attempt_key=$1', [attemptKey]);
      if (attempt?.attempt_count >= 8 && Number(attempt.blocked_until) > Date.now()) return fail(res, 429, 'Çok fazla deneme. 15 dakika sonra tekrar deneyin.');
      const providedKey = typeof input.recoveryKey === 'string' ? input.recoveryKey : '';
      const providedHash = Buffer.from(hashToken(providedKey), 'hex');
      const expectedHash = Buffer.from(hashToken(recoveryKey), 'hex');
      const owner = await one('SELECT id FROM users WHERE lower(username)=lower($1) AND role=$2 AND active=1', [input.username, 'owner']);
      if (!owner || !timingSafeEqual(providedHash, expectedHash)) {
        const now = Date.now();
        await query(`INSERT INTO login_attempts(attempt_key,attempt_count,blocked_until) VALUES($1,1,$2)
          ON CONFLICT(attempt_key) DO UPDATE SET
          attempt_count=CASE WHEN login_attempts.blocked_until<$3 THEN 1 ELSE login_attempts.attempt_count+1 END,
          blocked_until=$2`, [attemptKey, now + 15 * 60000, now]);
        return fail(res, 403, 'Kullanıcı adı veya kurtarma anahtarı yanlış.');
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(31001995)');
        const consumed = await client.query('INSERT INTO used_recovery_keys(key_hash) VALUES($1) ON CONFLICT DO NOTHING RETURNING key_hash', [hashToken(recoveryKey)]);
        if (!consumed.rowCount) {
          await client.query('ROLLBACK');
          return fail(res, 409, 'Bu kurtarma anahtarı kullanıldı. Vercel’de yeni bir kurulum anahtarı oluşturun.');
        }
        await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPassword(input.password), owner.id]);
        await client.query('DELETE FROM sessions WHERE user_id=$1', [owner.id]);
        await client.query('INSERT INTO audit(user_id,action) VALUES($1,$2)', [owner.id, 'owner_password_recovery']);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      await query('DELETE FROM login_attempts WHERE attempt_key=$1', [attemptKey]);
      res.setHeader('Set-Cookie', 'raykent_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure');
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/api/logout') {
      const token = cookieToken(req); if (token) await query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(token)]);
      res.setHeader('Set-Cookie', 'raykent_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure');
      return json(res, 200, { ok: true });
    }
    if (path.startsWith('/api/admin/')) {
      const user = await currentUser(req); if (!user) return fail(res, 401, 'Giriş gerekli.');
      if (method === 'GET' && path === '/api/admin/me') return json(res, 200, { user });
      if (method === 'GET' && path === '/api/admin/qr') {
        const base = (await settings()).publicBaseUrl;
        if (!base) return fail(res, 400, 'QR kodu için önce yayın adresini restoran bilgilerinden girin.');
        const svg = await QRCode.toString(new URL('/q', base).href, { type: 'svg', errorCorrectionLevel: 'H', margin: 4, width: 800 });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Disposition': 'attachment; filename="raykent-menu-qr.svg"', 'Cache-Control': 'no-store' });
        return res.end(svg);
      }
      if (method === 'GET' && path === '/api/admin/products') return json(res, 200, { products: await products('draft_products'), settings: await settings() });
      if (method === 'GET' && path === '/api/admin/summary') {
        const [draft, published, flagged, staff, lastPublish] = await Promise.all([
          one('SELECT COUNT(*) AS n FROM draft_products'), one('SELECT COUNT(*) AS n FROM published_products'),
          one("SELECT COUNT(*) AS n FROM draft_products WHERE review_note<>'' OR price_try IS NULL"),
          one('SELECT COUNT(*) AS n FROM users WHERE active=1'),
          one("SELECT created_at FROM audit WHERE action='publish' ORDER BY id DESC LIMIT 1")
        ]);
        return json(res, 200, { draft: Number(draft.n), published: Number(published.n), flagged: Number(flagged.n), staff: Number(staff.n), lastPublish: lastPublish?.created_at || null });
      }
      if (method === 'POST' && path === '/api/admin/products') {
        const item = validateProduct(await bodyJson(req));
        const result = await one(`INSERT INTO draft_products(category,name,description,price_try,available,image_url,review_note,sort_order)
          VALUES($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM draft_products)) RETURNING id`,
          [item.category, item.name, item.description, item.price, item.available, item.imageUrl, item.reviewNote]);
        await audit(user.id, 'create_product', String(result.id)); return json(res, 201, { id: Number(result.id) });
      }
      const productMatch = path.match(/^\/api\/admin\/products\/(\d+)$/);
      if (method === 'PATCH' && productMatch) {
        const id = Number(productMatch[1]); if (!await one('SELECT id FROM draft_products WHERE id=$1', [id])) return fail(res, 404, 'Ürün bulunamadı.');
        const item = validateProduct(await bodyJson(req));
        await query(`UPDATE draft_products SET category=$1,name=$2,description=$3,price_try=$4,available=$5,image_url=$6,review_note=$7 WHERE id=$8`,
          [item.category, item.name, item.description, item.price, item.available, item.imageUrl, item.reviewNote, id]);
        await audit(user.id, 'update_product', String(id)); return json(res, 200, { ok: true });
      }
      if (method === 'DELETE' && productMatch) {
        await query('DELETE FROM draft_products WHERE id=$1', [Number(productMatch[1])]);
        await audit(user.id, 'delete_product', productMatch[1]); return json(res, 200, { ok: true });
      }
      if (method === 'POST' && path === '/api/admin/publish') {
        if (user.role !== 'owner') return fail(res, 403, 'Yayınlama yetkisi gerekli.');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('DELETE FROM published_products');
          await client.query('INSERT INTO published_products(id,category,name,description,price_try,available,image_url,review_note,sort_order) SELECT id,category,name,description,price_try,available,image_url,review_note,sort_order FROM draft_products');
          await client.query('INSERT INTO audit(user_id,action,details) VALUES($1,$2,(SELECT COUNT(*)::text FROM draft_products))', [user.id, 'publish']);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        return json(res, 200, { ok: true });
      }
      if (method === 'PATCH' && path === '/api/admin/settings') {
        if (user.role !== 'owner') return fail(res, 403, 'Yönetici yetkisi gerekli.');
        const input = await bodyJson(req), updates = [];
        for (const key of Object.keys(defaults)) if (Object.hasOwn(input, key)) {
          const value = String(input[key] ?? '').trim();
          if (value.length > 300) return fail(res, 400, 'Alan çok uzun.');
          if (key.endsWith('Url') && value && !/^https:\/\//.test(value)) return fail(res, 400, 'Geçerli bir HTTPS bağlantısı girin.');
          if (key === 'publicBaseUrl' && value) {
            let parsed; try { parsed = new URL(value); } catch { return fail(res, 400, 'Geçerli bir yayın adresi girin.'); }
            if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return fail(res, 400, 'Yayın adresi yalnızca ana alan adı olmalı.');
          }
          updates.push([key, value]);
        }
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const [key, value] of updates) await client.query('UPDATE settings SET value=$1 WHERE key=$2', [value, key]);
          await client.query('INSERT INTO audit(user_id,action) VALUES($1,$2)', [user.id, 'update_settings']);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && path === '/api/admin/upload') {
        const input = await bodyJson(req), match = String(input.data || '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
        if (!match) return fail(res, 400, 'PNG, JPG veya WebP görsel yükleyin.');
        const bytes = Buffer.from(match[2], 'base64');
        if (!bytes.length || bytes.length > 3_000_000) return fail(res, 400, 'Görsel en fazla 3 MB olabilir.');
        const signature = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          : match[1] === 'jpeg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
          : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
        if (!signature) return fail(res, 400, 'Görsel dosyası geçersiz.');
        const extension = match[1] === 'jpeg' ? 'jpg' : match[1], filename = `${randomBytes(16).toString('hex')}.${extension}`;
        await query('INSERT INTO uploaded_images(filename,mime_type,image_data) VALUES($1,$2,$3)', [filename, `image/${match[1]}`, bytes]);
        await audit(user.id, 'upload_image', filename);
        return json(res, 201, { url: `/uploads/${filename}` });
      }
      if (user.role !== 'owner') return fail(res, 403, 'Yönetici yetkisi gerekli.');
      if (method === 'GET' && path === '/api/admin/users') return json(res, 200, { users: (await query('SELECT id,username,display_name,role,active,created_at FROM users ORDER BY id')).map(row => ({ ...row, id: Number(row.id) })) });
      if (method === 'POST' && path === '/api/admin/users') {
        const input = await bodyJson(req);
        if (!validUsername(input.username) || !validPassword(input.password) || !String(input.displayName || '').trim()) return fail(res, 400, 'Kullanıcı adı, ad ve en az 12 karakterli şifre girin.');
        try {
          const result = await one('INSERT INTO users(username,display_name,role,password_hash) VALUES($1,$2,$3,$4) RETURNING id', [input.username, String(input.displayName).trim().slice(0, 80), 'editor', hashPassword(input.password)]);
          await audit(user.id, 'create_editor', String(result.id)); return json(res, 201, { id: Number(result.id) });
        } catch (error) { if (error.code === '23505') return fail(res, 409, 'Kullanıcı adı kullanılıyor.'); throw error; }
      }
      const userMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);
      if (method === 'PATCH' && userMatch) {
        const target = Number(userMatch[1]), input = await bodyJson(req);
        if (target === user.id) return fail(res, 400, 'Kendi hesabınızı buradan kapatamazsınız.');
        if (!await one("SELECT id FROM users WHERE id=$1 AND role='editor'", [target])) return fail(res, 404, 'Hesap bulunamadı.');
        await query('UPDATE users SET active=$1 WHERE id=$2', [input.active ? 1 : 0, target]);
        if (!input.active) await query('DELETE FROM sessions WHERE user_id=$1', [target]);
        await audit(user.id, input.active ? 'enable_editor' : 'disable_editor', String(target));
        return json(res, 200, { ok: true });
      }
      return fail(res, 404, 'İşlem bulunamadı.');
    }
    return fail(res, 404, 'Sayfa bulunamadı.');
  } catch (error) {
    if (error instanceof SyntaxError) return fail(res, 400, 'Geçersiz JSON.');
    if (error.message?.includes('JSON gerekli') || error.message?.includes('İstek çok büyük') || error.message?.includes('Ürün bilgisi') || error.message?.includes('gerekli') || error.message?.includes('Geçerli') || error.message?.includes('çok uzun') || error.message?.includes('Geçersiz görsel')) return fail(res, 400, error.message);
    console.error(error); return fail(res, 500, 'Beklenmeyen bir hata oluştu.');
  }
});
