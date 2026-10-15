import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { consultarDocumento, validarDocumento } from './index.js';
import { ApiError } from './errors.js';
import { crearEmisorLicencias, normalizeInstallationId } from './licensing/issuer.js';

export function crearApp(config, consultar = consultarDocumento, emitirLicencia = crearEmisorLicencias(config)) {
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
  const licenseLimiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler(req, res, next) {
      next(new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Demasiados intentos de emisión. Intenta nuevamente más tarde.'));
    },
  });
  app.get('/', (req, res) => res.json({
    service: 'API DNI/RUC',
    endpoints: ['/api/dni/:numero', '/api/ruc/:numero', '/api/health', '/api/licenses/issue'],
  }));
  app.get(['/health', '/api/health'], (req, res) => res.json({ status: 'ok' }));
  app.post(['/licenses/issue', '/api/licenses/issue'], licenseLimiter, (req, res, next) => {
    const expectedToken = config.licensingApiToken;
    if (!expectedToken) return next(new ApiError(503, 'LICENSING_NOT_CONFIGURED', 'El servicio de emisión de licencias no está configurado.'));
    const providedToken = req.get('authorization')?.match(/^Bearer (.+)$/)?.[1] ?? '';
    const expected = Buffer.from(expectedToken);
    const provided = Buffer.from(providedToken);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      return next(new ApiError(401, 'UNAUTHORIZED', 'Autenticación requerida.'));
    }
    next();
  }, express.json({ limit: '2kb', strict: true }), async (req, res) => {
    const installationId = normalizeInstallationId(req.body?.installationId);
    const license = await emitirLicencia(installationId);
    res.status(201).json({ success: true, data: { license } });
  });
  for (const tipo of ['dni', 'ruc']) {
    app.use([`/${tipo}`, `/api/${tipo}`], limiter);
    app.get([`/${tipo}/:numero`, `/api/${tipo}/:numero`], async (req, res) => {
      validarDocumento(tipo, req.params.numero);
      res.json({ success: true, data: await consultar(tipo, req.params.numero) });
    });
  }
  app.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint no encontrado.')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') error = new ApiError(400, 'INVALID_JSON', 'El cuerpo de la solicitud debe ser JSON válido.');
    if (error.type === 'entity.too.large') error = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'El cuerpo de la solicitud excede el tamaño permitido.');
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
