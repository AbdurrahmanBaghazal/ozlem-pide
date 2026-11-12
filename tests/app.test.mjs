import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.RAYKENT_DATA_DIR = mkdtempSync(join(tmpdir(), 'raykent-app-test-'));
process.env.ADMIN_SETUP_KEY = 'test-only-owner-recovery-key-32-characters';
const { server } = await import('../local-server.mjs');

test('owner setup, draft publishing, and staff permissions', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body, cookie) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    const initial = await request('/api/public');
    assert.equal(initial.status, 200);
    assert.equal(initial.data.products.length, 64);
    assert.equal(initial.data.products.filter(product => product.image_url).length, 64);
    assert.equal(initial.data.products.some(product => 'review_note' in product), false);
    const image = await fetch(base + initial.data.products[0].image_url);
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type'), /image\/webp/);
    assert.equal((await request('/api/admin/products')).status, 401);

    const setup = await request('/api/setup', 'POST', { username: 'owner', displayName: 'Owner', password: 'StrongPassword123!' });
    assert.equal(setup.status, 201);
    assert.ok(setup.cookie?.startsWith('raykent_session='));
    assert.equal((await request('/api/setup', 'POST', { username: 'other', displayName: 'Other', password: 'StrongPassword123!' })).status, 409);
    const ownerCookie = setup.cookie;

    const draft = await request('/api/admin/products', 'GET', undefined, ownerCookie);
    const first = draft.data.products[0];
    assert.equal(first.price_try, 320);
    const edit = await request(`/api/admin/products/${first.id}`, 'PATCH', { ...first, price_try: 325 }, ownerCookie);
    assert.equal(edit.status, 200);
    assert.equal((await request('/api/public')).data.products[0].price_try, 320);
    assert.equal((await request('/api/admin/publish', 'POST', {}, ownerCookie)).status, 200);
    assert.equal((await request('/api/public')).data.products[0].price_try, 325);

    const staff = await request('/api/admin/users', 'POST', { username: 'editor', displayName: 'Menu Editor', password: 'EditorPassword123!' }, ownerCookie);
    assert.equal(staff.status, 201);
    const login = await request('/api/login', 'POST', { username: 'editor', password: 'EditorPassword123!' });
    assert.equal(login.status, 200);
    assert.equal((await request('/api/admin/publish', 'POST', {}, login.cookie)).status, 403);
    assert.equal((await request('/api/admin/users', 'GET', undefined, login.cookie)).status, 403);
    assert.equal((await request('/api/admin/products', 'GET', undefined, login.cookie)).status, 200);
    assert.equal((await request('/api/admin/users/' + staff.data.id, 'PATCH', { active: false }, ownerCookie)).status, 200);
    assert.equal((await request('/api/admin/products', 'GET', undefined, login.cookie)).status, 401);
    assert.equal((await request('/api/admin/qr', 'GET', undefined, ownerCookie)).status, 400);
    assert.equal((await request('/api/admin/settings', 'PATCH', { publicBaseUrl: 'https://menu.example.test' }, ownerCookie)).status, 200);
    const qr = await fetch(base + '/api/admin/qr', { headers: { Cookie: ownerCookie } });
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await qr.text(), /<svg/);
    const redirect = await fetch(base + '/q', { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/menu');

    const invalidName = await request('/api/recover-owner', 'POST', { username: 'Owner Name', recoveryKey: process.env.ADMIN_SETUP_KEY, password: 'NewStrongPassword123!' });
    assert.equal(invalidName.status, 400);
    assert.match(invalidName.data.error, /kullanıcı adı/);
    const shortPassword = await request('/api/recover-owner', 'POST', { username: 'owner', recoveryKey: process.env.ADMIN_SETUP_KEY, password: 'too-short' });
    assert.equal(shortPassword.status, 400);
    assert.match(shortPassword.data.error, /Yeni şifre/);
    assert.equal((await request('/api/recover-owner', 'POST', { username: 'owner', recoveryKey: 'wrong', password: 'NewStrongPassword123!' })).status, 403);
    for (let i = 0; i < 8; i++) assert.equal((await request('/api/login', 'POST', { username: 'owner', password: 'wrong-password' })).status, 401);
    assert.equal((await request('/api/login', 'POST', { username: 'owner', password: 'StrongPassword123!' })).status, 429);
    const recovered = await request('/api/recover-owner', 'POST', { username: 'owner', recoveryKey: process.env.ADMIN_SETUP_KEY, password: 'NewStrongPassword123!' });
    assert.equal(recovered.status, 200);
    assert.equal((await request('/api/admin/me', 'GET', undefined, ownerCookie)).status, 401);
    assert.equal((await request('/api/recover-owner', 'POST', { username: 'owner', recoveryKey: process.env.ADMIN_SETUP_KEY, password: 'AnotherPassword123!' })).status, 409);
    assert.equal((await request('/api/login', 'POST', { username: 'owner', password: 'StrongPassword123!' })).status, 401);
    assert.equal((await request('/api/login', 'POST', { username: 'owner', password: 'NewStrongPassword123!' })).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

