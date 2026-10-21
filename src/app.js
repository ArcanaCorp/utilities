
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import {
    randomUUID,
    timingSafeEqual,
    createHmac,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { consultarDocumento, validarDocumento } from './index.js';
import { ApiError } from './errors.js';
import {
    crearEmisorLicencias,
    normalizeInstallationId,
} from './licensing/issuer.js';
import {
    LICENSE_PRODUCTS,
    DEFAULT_LICENSE_PRODUCT,
} from './licensing/products.js';
import QRCode from 'qrcode';

const [licensingPage, licensingScript, licensingStyles] = await Promise.all([
    readFile(new URL('./licensing/ui/issue.html', import.meta.url), 'utf8'),
    readFile(new URL('./licensing/ui/issue.js', import.meta.url), 'utf8'),
    readFile(new URL('./licensing/ui/issue.css', import.meta.url), 'utf8'),
]);

const SESSION_COOKIE = 'arcana_license_session';
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

function compararSecretos(expected, provided) {
    if (typeof expected !== 'string' || typeof provided !== 'string') {
        return false;
    }

    const a = Buffer.from(expected);
    const b = Buffer.from(provided);

    return a.length === b.length && timingSafeEqual(a, b);
}

function crearFirmaSesion(token, expiresAt) {
    return createHmac('sha256', token)
        .update(`ARCANA:LICENSING:SESSION:1:${expiresAt}`)
        .digest('hex');
}

function crearSesion(token) {
    const expiresAt = Date.now() + SESSION_DURATION_MS;
    const signature = crearFirmaSesion(token, expiresAt);

    return `${expiresAt}.${signature}`;
}

function validarSesion(value, token) {
    if (!value || !token) return false;

    const match = value.match(/^(\d{13})\.([a-f0-9]{64})$/);

    if (!match) return false;

    const expiresAt = Number(match[1]);

    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
        return false;
    }

    if (expiresAt > Date.now() + SESSION_DURATION_MS) {
        return false;
    }

    const expected = crearFirmaSesion(token, expiresAt);

    return compararSecretos(expected, match[2]);
}

function obtenerCookie(req, name) {
    const cookies = req.get('cookie') ?? '';

    for (const part of cookies.split(';')) {
        const index = part.indexOf('=');

        if (index < 0) continue;

        const key = part.slice(0, index).trim();

        if (key === name) {
            return part.slice(index + 1).trim();
        }
    }

    return '';
}

function obtenerBearer(req) {
    const authorization = req.get('authorization') ?? '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    return match ? match[1].trim() : '';
}


function origenMismoSitio(req) {
    const origin = req.get('origin');
    const fetchSite = req.get('sec-fetch-site');

    // Si el navegador indica que la solicitud viene
    // de otro origen, bloquearla.
    if (fetchSite && fetchSite !== 'same-origin') {
        return false;
    }

    // Obtener el host público.
    const host = req.get('host');

    if (!host) {
        return false;
    }

    // En producción, Vercel puede utilizar un proxy HTTPS.
    // Usamos el protocolo del origen enviado por el navegador
    // en lugar de depender exclusivamente de req.protocol.
    if (origin) {
        let parsedOrigin;

        try {
            parsedOrigin = new URL(origin);
        } catch {
            return false;
        }

        // Comparar el dominio y puerto completos.
        if (parsedOrigin.host !== host) {
            return false;
        }

        // Solo permitir HTTP en desarrollo local.
        const isLocalhost =
            parsedOrigin.hostname === 'localhost' ||
            parsedOrigin.hostname === '127.0.0.1';

        return parsedOrigin.protocol === 'https:' ||
            (isLocalhost && parsedOrigin.protocol === 'http:');
    }

    // Solicitudes sin Origin:
    // únicamente si el navegador confirma mismo origen.
    return fetchSite === 'same-origin';
}

export function crearApp(
    config,
    consultar = consultarDocumento,
    emitirLicencia = crearEmisorLicencias(config),
) {
    const app = express();

    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);

    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                'img-src': ["'self'", 'data:'],
            },
        },
    }));

    app.use((req, res, next) => {
        req.requestId = randomUUID();

        res.set('X-Request-Id', req.requestId);
        res.set('Cache-Control', 'no-store');

        next();
    });

    const corsMiddleware = cors({
        origin(origen, callback) {
            if (!origen || config.corsOrigins.includes(origen)) {
                return callback(null, true);
            }

            callback(
                new ApiError(
                    403,
                    'ORIGIN_NOT_ALLOWED',
                    'Origen no permitido.',
                ),
            );
        },
        methods: ['GET', 'POST'],
        allowedHeaders: [
            'Accept',
            'Content-Type',
            'Authorization',
        ],
        exposedHeaders: [
            'X-Request-Id',
            'RateLimit',
            'RateLimit-Policy',
            'Retry-After',
        ],
        maxAge: 600,
    });

    app.use((req, res, next) => {
        const origin = req.get('origin');

        if (
            req.get('sec-fetch-site') === 'same-origin' ||
            (
                origin &&
                origin === `${req.protocol}://${req.get('host')}`
            )
        ) {
            return next();
        }

        corsMiddleware(req, res, next);
    });

    const limiter = rateLimit({
        windowMs: config.rateLimitWindowMs,
        limit: config.rateLimitMax,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler(req, res, next) {
            next(
                new ApiError(
                    429,
                    'RATE_LIMIT_EXCEEDED',
                    'Demasiadas consultas. Intenta nuevamente más tarde.',
                ),
            );
        },
    });

    const licenseLimiter = rateLimit({
        windowMs: config.rateLimitWindowMs,
        limit: 5,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler(req, res, next) {
            next(
                new ApiError(
                    429,
                    'RATE_LIMIT_EXCEEDED',
                    'Demasiados intentos. Intenta nuevamente más tarde.',
                ),
            );
        },
    });

    function exigirConfiguracion(req, res, next) {
        if (!config.licensingApiToken) {
            return next(
                new ApiError(
                    503,
                    'LICENSING_NOT_CONFIGURED',
                    'El servicio de emisión de licencias no está configurado.',
                ),
            );
        }

        next();
    }

    function exigirInterfaz(req, res, next) {
        if (!config.licensingUiEnabled) {
            return next(
                new ApiError(
                    404,
                    'NOT_FOUND',
                    'Endpoint no encontrado.',
                ),
            );
        }

        next();
    }

    function exigirSesion(req, res, next) {
        const cookie = obtenerCookie(req, SESSION_COOKIE);

        if (!validarSesion(cookie, config.licensingApiToken)) {
            return next(
                new ApiError(
                    401,
                    'UNAUTHORIZED',
                    'Inicia sesión para emitir licencias.',
                ),
            );
        }

        next();
    }

    function exigirMismoOrigen(req, res, next) {
        if (!origenMismoSitio(req)) {
            return next(
                new ApiError(
                    403,
                    'ORIGIN_NOT_ALLOWED',
                    'La solicitud debe realizarse desde el panel administrativo.',
                ),
            );
        }

        next();
    }

    app.get('/', (req, res) => {
        res.json({
            service: 'ARCANA Utilities',
            endpoints: [
                '/api/dni/:numero',
                '/api/ruc/:numero',
                '/api/health',
                'GET /licenses/issue',
                'POST /api/licenses/session',
                'POST /api/licenses/logout',
                'POST /api/licenses/issue/ui',
                'POST /api/licenses/issue',
            ],
        });
    });

    app.get(['/health', '/api/health'], (req, res) => {
        res.json({ status: 'ok' });
    });

    // Recursos de la interfaz administrativa.
    app.get(
        '/licenses/assets/issue.js',
        exigirInterfaz,
        (req, res) => {
            res.type('js').send(licensingScript);
        },
    );

    app.get(
        '/licenses/assets/issue.css',
        exigirInterfaz,
        (req, res) => {
            res.type('css').send(licensingStyles);
        },
    );

    // El formulario puede abrirse sin sesión para iniciar sesión.
    // Emitir licencias sí requiere autenticación.
    app.get(
        '/licenses/issue',
        exigirInterfaz,
        (req, res) => {
            res.type('html').send(licensingPage);
        },
    );

    // Inicio de sesión administrativo.
    app.post(
        '/api/licenses/session',
        licenseLimiter,
        exigirInterfaz,
        exigirConfiguracion,
        exigirMismoOrigen,
        express.json({ limit: '2kb', strict: true }),
        (req, res, next) => {
            const token = req.body?.token;

            if (!compararSecretos(config.licensingApiToken, token)) {
                return next(
                    new ApiError(
                        401,
                        'UNAUTHORIZED',
                        'Credenciales incorrectas.',
                    ),
                );
            }

            const session = crearSesion(config.licensingApiToken);

            res.cookie(SESSION_COOKIE, session, {
                httpOnly: true,
                secure: true,
                sameSite: 'strict',
                path: '/api/licenses',
                maxAge: SESSION_DURATION_MS,
            });

            res.json({
                success: true,
                data: {
                    authenticated: true,
                    expiresIn: SESSION_DURATION_MS / 1000,
                },
            });
        },
    );

    // Consultar el estado de la sesión.
    app.get(
        '/api/licenses/session',
        exigirInterfaz,
        exigirConfiguracion,
        exigirSesion,
        (req, res) => {
            res.json({
                success: true,
                data: {
                    authenticated: true,
                },
            });
        },
    );

    // Cerrar sesión.
    app.post(
        '/api/licenses/logout',
        exigirInterfaz,
        exigirMismoOrigen,
        (req, res) => {
            res.clearCookie(SESSION_COOKIE, {
                httpOnly: true,
                secure: true,
                sameSite: 'strict',
                path: '/api/licenses',
            });

            res.json({
                success: true,
                data: {
                    authenticated: false,
                },
            });
        },
    );

    // Emisión multiproducto.
    const emitirRespuesta = async (req, res) => {
        const installationId = normalizeInstallationId(
            req.body?.installationId,
        );

        const productId = req.body?.productId === undefined
            ? DEFAULT_LICENSE_PRODUCT
            : req.body.productId;

        const product = (
            typeof productId === 'string' &&
            Object.hasOwn(LICENSE_PRODUCTS, productId)
        )
            ? LICENSE_PRODUCTS[productId]
            : null;

        if (!product) {
            throw new ApiError(
                400,
                'INVALID_LICENSE_PRODUCT',
                'El producto seleccionado no es válido.',
            );
        }

        const license = await emitirLicencia(
            installationId,
            productId,
        );

        const qrDataUrl = await QRCode.toDataURL(license, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 512,
            color: {
                dark: '#10233f',
                light: '#ffffff',
            },
        });

        res.status(201).json({
            success: true,
            data: {
                license,
                qrDataUrl,
                productId,
                productName: product.name,
            },
        });
    };

    // Emisión desde la interfaz administrativa.
    // Requiere una sesión válida.
    app.post(
        '/api/licenses/issue/ui',
        licenseLimiter,
        exigirInterfaz,
        exigirConfiguracion,
        exigirMismoOrigen,
        exigirSesion,
        express.json({ limit: '2kb', strict: true }),
        emitirRespuesta,
    );

    // Emisión mediante API con Bearer token.
    app.post(
        ['/licenses/issue', '/api/licenses/issue'],
        licenseLimiter,
        exigirConfiguracion,
        (req, res, next) => {
            const providedToken = obtenerBearer(req);

            if (!compararSecretos(
                config.licensingApiToken,
                providedToken,
            )) {
                return next(
                    new ApiError(
                        401,
                        'UNAUTHORIZED',
                        'Autenticación requerida.',
                    ),
                );
            }

            next();
        },
        express.json({ limit: '2kb', strict: true }),
        emitirRespuesta,
    );

    // Consultas DNI y RUC.
    for (const tipo of ['dni', 'ruc']) {
        app.use(
            [`/${tipo}`, `/api/${tipo}`],
            limiter,
        );

        app.get(
            [`/${tipo}/:numero`, `/api/${tipo}/:numero`],
            async (req, res) => {
                validarDocumento(tipo, req.params.numero);

                res.json({
                    success: true,
                    data: await consultar(tipo, req.params.numero),
                });
            },
        );
    }

    // Ruta no encontrada.
    app.use((req, res, next) => {
        next(
            new ApiError(
                404,
                'NOT_FOUND',
                'Endpoint no encontrado.',
            ),
        );
    });

    // Manejo centralizado de errores.
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);

        if (error.type === 'entity.parse.failed') {
            error = new ApiError(
                400,
                'INVALID_JSON',
                'El cuerpo de la solicitud debe ser JSON válido.',
            );
        }

        if (error.type === 'entity.too.large') {
            error = new ApiError(
                413,
                'PAYLOAD_TOO_LARGE',
                'El cuerpo de la solicitud excede el tamaño permitido.',
            );
        }

        const conocido = error instanceof ApiError;
        const status = conocido ? error.status : 500;

        if (status >= 500) {
            console.error(JSON.stringify({
                requestId: req.requestId,
                code: conocido ? error.code : 'INTERNAL_ERROR',
                status,
            }));
        }

        res.status(status).json({
            success: false,
            error: {
                code: conocido ? error.code : 'INTERNAL_ERROR',
                message: conocido && status < 500
                    ? error.message
                    : 'No se pudo completar la consulta. Intenta nuevamente más tarde.',
                requestId: req.requestId,
            },
        });
    });

    return app;
}