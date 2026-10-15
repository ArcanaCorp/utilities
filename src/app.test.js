import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { crearApp } from './app.js';
import { cargarConfiguracion } from './config.js';
import { ApiError } from './errors.js';
import { generateKeyPairSync, verify } from 'node:crypto';
import { crearEmisorLicencias } from './licensing/issuer.js';

async function iniciar(t, consultar, opciones = {}, emitirLicencia) {
  const config = cargarConfiguracion({ APIS_PERU_TOKEN: 'prueba', ...opciones });
  const server = crearApp(config, consultar, emitirLicencia).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP: DNI/RUC, validación, errores y cabeceras de seguridad', async t => {
  const llamadas = [];
  const base = await iniciar(t, async (tipo, numero) => {
    llamadas.push([tipo, numero]);
    if (numero === '99999999') throw new ApiError(504, 'UPSTREAM_UNAVAILABLE', 'mensaje privado');
    if (numero === '88888888') throw new Error('token secreto');
    return { [tipo]: numero };
  });
  for (const [tipo, numero] of [['dni', '01234567'], ['ruc', '20131312955']]) {
    const res = await fetch(`${base}/${tipo}/${numero}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, data: { [tipo]: numero } });
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(res.headers.get('x-request-id'));
  }
  for (const ruta of ['/dni/123', '/ruc/1234567890x']) {
    const res = await fetch(base + ruta);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'INVALID_DOCUMENT');
  }
  assert.equal(llamadas.length, 2);
  assert.equal((await fetch(base + '/desconocido')).status, 404);
  for (const [numero, estado] of [['99999999', 504], ['88888888', 500]]) {
    const res = await fetch(`${base}/dni/${numero}`);
    assert.equal(res.status, estado);
    const body = await res.text();
    assert.doesNotMatch(body, /mensaje privado|token secreto|stack/);
  }
});

test('CORS permite el origen configurado y bloquea otros antes de consultar', async t => {
  let consultas = 0;
  const base = await iniciar(t, async () => { consultas++; return {}; });
  const allowed = await fetch(base + '/health', { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const denied = await fetch(base + '/dni/01234567', { headers: { Origin: 'https://otro.example' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(base + '/dni/01234567', {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET');
  assert.equal(consultas, 0);
});

test('rate limit se comparte entre DNI y RUC y no consulta al excederse', async t => {
  let consultas = 0;
  const base = await iniciar(t, async () => { consultas++; return {}; }, { RATE_LIMIT_MAX: '1' });
  assert.equal((await fetch(base + '/dni/01234567')).status, 200);
  const res = await fetch(base + '/ruc/20131312955');
  assert.equal(res.status, 429);
  assert.ok(res.headers.get('retry-after'));
  assert.ok(res.headers.get('ratelimit'));
  assert.equal((await res.json()).error.code, 'RATE_LIMIT_EXCEEDED');
  assert.equal(consultas, 1);
  assert.equal((await fetch(base + '/health')).status, 200);
});

test('configuración rechaza token faltante, límites inválidos y CORS abierto', () => {
  assert.throws(() => cargarConfiguracion({}), /APIS_PERU_TOKEN/);
  for (const overrides of [
    { PORT: '0' },
    { RATE_LIMIT_MAX: '-1' },
    { RATE_LIMIT_WINDOW_MS: 'abc' },
    { CORS_ORIGINS: '*' },
    { LICENSING_API_TOKEN: 'corto' },
    { LICENSING_UI_ENABLED: 'yes' },
  ]) {
    assert.throws(() => cargarConfiguracion({ APIS_PERU_TOKEN: 'prueba', ...overrides }));
  }
  assert.equal(cargarConfiguracion({ APIS_PERU_TOKEN: 'prueba' }).trustProxy, false);
});

test('rutas /api funcionan y comparten la cuota con las rutas originales', async t => {
  const base = await iniciar(t, async (tipo, numero) => ({ [tipo]: numero }), { RATE_LIMIT_MAX: '2' });
  const root = await fetch(base + '/');
  assert.equal(root.status, 200);
  assert.ok((await root.json()).endpoints.includes('/api/ruc/:numero'));
  const dni = await fetch(base + '/api/dni/01234567');
  assert.equal(dni.status, 200);
  assert.equal((await dni.json()).data.dni, '01234567');
  const ruc = await fetch(base + '/api/ruc/20131312955');
  assert.equal(ruc.status, 200);
  assert.equal((await ruc.json()).data.ruc, '20131312955');
  assert.equal((await fetch(base + '/dni/01234567')).status, 429);
  assert.equal((await fetch(base + '/api/health')).status, 200);
});

test('emite licencias solo con token válido y para IDs de instalación válidos', async t => {
  const base = await iniciar(t, async () => ({}), {
    LICENSING_API_TOKEN: 'a'.repeat(32),
    LICENSING_UI_ENABLED: 'true',
    RATE_LIMIT_MAX: '20',
  }, async id => `licencia-${id}`);
  const unauthorized = await fetch(base + '/api/licenses/issue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId: 'A'.repeat(32) }),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, 'UNAUTHORIZED');

  const invalidId = await fetch(base + '/api/licenses/issue', {
    method: 'POST',
    headers: { Authorization: `Bearer ${'a'.repeat(32)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId: 'invalido' }),
  });
  assert.equal(invalidId.status, 400);
  assert.equal((await invalidId.json()).error.code, 'INVALID_INSTALLATION_ID');

  const issued = await fetch(base + '/api/licenses/issue', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${'a'.repeat(32)}`,
      'Content-Type': 'application/json',
      Origin: 'https://app.example.com',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify({ installationId: '00112233445566778899AABBCCDDEEFF' }),
  });
  assert.equal(issued.status, 201);
  const issuedBody = await issued.json();
  assert.equal(issuedBody.success, true);
  assert.equal(issuedBody.data.license, 'licencia-00112233445566778899AABBCCDDEEFF');
  assert.match(issuedBody.data.qrDataUrl, /^data:image\/png;base64,/);
  assert.ok(Buffer.from(issuedBody.data.qrDataUrl.split(',')[1], 'base64').subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));

  const uiIssued = await fetch(base + '/api/licenses/issue/ui', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId: '00112233445566778899AABBCCDDEEFF' }),
  });
  assert.equal(uiIssued.status, 201);
  assert.equal((await uiIssued.json()).data.license, 'licencia-00112233445566778899AABBCCDDEEFF');

  const invalidJson = await fetch(base + '/api/licenses/issue', {
    method: 'POST',
    headers: { Authorization: `Bearer ${'a'.repeat(32)}`, 'Content-Type': 'application/json' },
    body: '{"installationId":',
  });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).error.code, 'INVALID_JSON');
});

test('sirve la interfaz HTML y sus recursos del mismo origen', async t => {
  const base = await iniciar(t, async () => ({}), { LICENSING_UI_ENABLED: 'true' });
  const page = await fetch(base + '/licenses/issue');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /img-src[^;]*data:/);
  const html = await page.text();
  assert.match(html, /id="issue-form"/);
  assert.doesNotMatch(html, /api-token|Token de emisión/);

  const script = await fetch(base + '/licenses/assets/issue.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  const scriptText = await script.text();
  assert.match(scriptText, /fetch\('\/api\/licenses\/issue\/ui'/);
  assert.doesNotMatch(scriptText, /Authorization|apiToken/);
  assert.equal((await fetch(base + '/licenses/assets/issue.css')).status, 200);
});

test('la interfaz y su ruta UI permanecen cerradas si no se habilitan', async t => {
  const base = await iniciar(t, async () => ({}));
  assert.equal((await fetch(base + '/licenses/issue')).status, 404);
  const response = await fetch(base + '/api/licenses/issue/ui', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId: '00112233445566778899AABBCCDDEEFF' }),
  });
  assert.equal(response.status, 404);
});

test('la emisión queda deshabilitada si no se configuró su secreto', async t => {
  const base = await iniciar(t, async () => ({}));
  const response = await fetch(base + '/api/licenses/issue', { method: 'POST' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'LICENSING_NOT_CONFIGURED');
});

test('el emisor firma un token compatible con el protocolo offline', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const emitir = crearEmisorLicencias({
    licensingPrivateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  }, { testkey: rawPublicKey });
  const installationId = '00112233445566778899AABBCCDDEEFF';
  const license = await emitir(installationId);
  const [, keyId, signedId, signature] = license.split('.');
  assert.equal(keyId, 'testkey');
  assert.equal(signedId, installationId);
  assert.equal(verify(
    null,
    Buffer.from(`MYPE-ANDALE:LICENSE:1:${keyId}:${signedId}`, 'ascii'),
    publicKey,
    Buffer.from(signature, 'hex'),
  ), true);
  await assert.rejects(emitir('not-an-id'), error => error.code === 'INVALID_INSTALLATION_ID');
});

test('entrada Vercel exporta handler y sirve health aunque falte el token', async t => {
  const originalToken = process.env.APIS_PERU_TOKEN;
  process.env.APIS_PERU_TOKEN = '';
  t.after(() => {
    if (originalToken === undefined) delete process.env.APIS_PERU_TOKEN;
    else process.env.APIS_PERU_TOKEN = originalToken;
  });
  const { default: app } = await import('../app.js');
  assert.equal(typeof app, 'function');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await fetch(base + '/ruc/10752093828')).status, 500);
  assert.equal((await fetch(base + '/dni/123')).status, 400);
});
