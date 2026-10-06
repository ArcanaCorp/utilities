import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consultarDocumento, validarDocumento, validarRespuesta } from './index.js';

test('valida tipo y longitud sin perder ceros iniciales', () => {
  assert.equal(validarDocumento('dni', '01234567'), '01234567');
  assert.equal(validarDocumento('ruc', '20131312955'), '20131312955');
  for (const [tipo, numero] of [['otro', '12345678'], ['dni', '123'], ['ruc', '2013131295x'], ['dni', 12345678]]) {
    assert.throws(() => validarDocumento(tipo, numero));
  }
});

test('rechaza respuestas fallidas, documentos distintos y datos incompletos', () => {
  assert.throws(() => validarRespuesta('dni', '01234567', { success: false }));
  assert.throws(() => validarRespuesta('ruc', '20131312955', { ruc: '20100070970', razonSocial: 'Empresa' }));
  assert.throws(() => validarRespuesta('dni', '01234567', { dni: '01234567' }));
});

test('envía GET con Bearer y verifica respuestas JSON y errores HTTP', async t => {
  t.mock.method(globalThis, 'fetch');
  const originalToken = process.env.APIS_PERU_TOKEN;
  process.env.APIS_PERU_TOKEN = 'token-de-prueba';
  t.after(() => {
    if (originalToken === undefined) delete process.env.APIS_PERU_TOKEN;
    else process.env.APIS_PERU_TOKEN = originalToken;
  });
  const datos = { ruc: '20131312955', razonSocial: 'Entidad de prueba' };
  fetch.mock.mockImplementation(async (url, opciones) => {
    assert.equal(url, 'https://dniruc.apisperu.com/api/v1/ruc/20131312955');
    assert.equal(opciones.method, 'GET');
    assert.equal(opciones.headers.Authorization, 'Bearer token-de-prueba');
    return Response.json(datos);
  });
  assert.deepEqual(await consultarDocumento('ruc', datos.ruc), datos);
  fetch.mock.mockImplementation(async () => Response.json({ dni: '01234567', nombres: 'Persona', apellidoPaterno: 'Prueba', apellidoMaterno: '' }));
  assert.equal((await consultarDocumento('dni', '01234567')).dni, '01234567');
  fetch.mock.mockImplementation(async () => new Response('', { status: 401 }));
  await assert.rejects(consultarDocumento('ruc', datos.ruc), /HTTP 401/);
  fetch.mock.mockImplementation(async () => new Response('<html>error</html>'));
  await assert.rejects(consultarDocumento('ruc', datos.ruc), /JSON válido/);
  fetch.mock.mockImplementation(async () => { throw new DOMException('timeout', 'TimeoutError'); });
  await assert.rejects(consultarDocumento('ruc', datos.ruc), /15 segundos/);
  delete process.env.APIS_PERU_TOKEN;
  await assert.rejects(consultarDocumento('ruc', datos.ruc), /APIS_PERU_TOKEN/);
});
