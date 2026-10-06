import './index.js';

function entero(nombre, valor, defecto, maximo) {
  const numero = valor === undefined ? defecto : Number(valor);
  if (!Number.isSafeInteger(numero) || numero < 1 || numero > maximo) {
    throw new Error(`${nombre} debe ser un entero entre 1 y ${maximo}.`);
  }
  return numero;
}

export function cargarConfiguracion(env = process.env) {
  if (!env.APIS_PERU_TOKEN?.trim()) throw new Error('Falta APIS_PERU_TOKEN en .env.');
  const origenes = (env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3000')
    .split(',').map(valor => valor.trim()).filter(Boolean);
  for (const origen of origenes) {
    const url = new URL(origen);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origen) {
      throw new Error('CORS_ORIGINS debe contener orígenes HTTP/HTTPS sin rutas.');
    }
  }
  return {
    port: entero('PORT', env.PORT, 3000, 65535),
    host: env.HOST ?? '127.0.0.1',
    corsOrigins: origenes,
    rateLimitWindowMs: entero('RATE_LIMIT_WINDOW_MS', env.RATE_LIMIT_WINDOW_MS, 60000, 2147483647),
    rateLimitMax: entero('RATE_LIMIT_MAX', env.RATE_LIMIT_MAX, 30, 1000000),
    trustProxy: env.TRUST_PROXY?.trim() || false,
  };
}
