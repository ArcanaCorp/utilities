import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { crearApp } from './app.js';
import { cargarConfiguracion } from './config.js';
import { ApiError } from './errors.js';

async function iniciar(t, consultar, opciones = {}) {
  const config = cargarConfiguracion({ APIS_PERU_TOKEN: 'prueba', ...opciones });
  const server = crearApp(config, consultar).listen(0, '127.0.0.1');
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
  for (const overrides of [{ PORT: '0' }, { RATE_LIMIT_MAX: '-1' }, { RATE_LIMIT_WINDOW_MS: 'abc' }, { CORS_ORIGINS: '*' }]) {
    assert.throws(() => cargarConfiguracion({ APIS_PERU_TOKEN: 'prueba', ...overrides }));
  }
  assert.equal(cargarConfiguracion({ APIS_PERU_TOKEN: 'prueba' }).trustProxy, false);
});
