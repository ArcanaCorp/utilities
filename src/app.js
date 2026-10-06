import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { consultarDocumento, validarDocumento } from './index.js';
import { ApiError } from './errors.js';

export function crearApp(config, consultar = consultarDocumento) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set('X-Request-Id', req.requestId);
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(cors({
    origin(origen, callback) {
      if (!origen || config.corsOrigins.includes(origen)) return callback(null, true);
      callback(new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origen no permitido.'));
    },
    methods: ['GET'],
    allowedHeaders: ['Accept'],
    exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
    maxAge: 600,
  }));
  const limiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler(req, res, next) {
      next(new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Demasiadas consultas. Intenta nuevamente más tarde.'));
    },
  });
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  for (const tipo of ['dni', 'ruc']) {
    app.use(`/${tipo}`, limiter);
    app.get(`/${tipo}/:numero`, async (req, res) => {
      validarDocumento(tipo, req.params.numero);
      res.json({ success: true, data: await consultar(tipo, req.params.numero) });
    });
  }
  app.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint no encontrado.')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const conocido = error instanceof ApiError;
    const status = conocido ? error.status : 500;
    if (status >= 500) console.error(JSON.stringify({ requestId: req.requestId, code: conocido ? error.code : 'INTERNAL_ERROR', status }));
    res.status(status).json({ success: false, error: {
      code: conocido ? error.code : 'INTERNAL_ERROR',
      message: conocido && status < 500 ? error.message : 'No se pudo completar la consulta. Intenta nuevamente más tarde.',
      requestId: req.requestId,
    } });
  });
  return app;
}
