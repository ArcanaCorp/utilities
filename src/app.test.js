import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync, verify } from 'node:crypto';

import { crearApp } from './app.js';
import { cargarConfiguracion } from './config.js';
import { ApiError } from './errors.js';
import { crearEmisorLicencias } from './licensing/issuer.js';
import { LICENSE_PRODUCTS } from './licensing/products.js';

const INSTALLATION_ID = '00112233445566778899AABBCCDDEEFF';
const API_TOKEN = 'a'.repeat(32);

async function iniciar(t, consultar, opciones = {}, emitirLicencia) {
    const config = cargarConfiguracion({
        APIS_PERU_TOKEN: 'prueba',
        ...opciones,
    });

    const server = crearApp(
        config,
        consultar,
        emitirLicencia,
    ).listen(0, '127.0.0.1');

    await once(server, 'listening');

    t.after(() => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));

    return `http://127.0.0.1:${server.address().port}`;
}

function postJson(base, path, body, authorized = true) {
    return fetch(base + path, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(authorized
                ? { Authorization: `Bearer ${API_TOKEN}` }
                : {}),
        },
        body: JSON.stringify(body),
    });
}

function crearEmisorDePrueba() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');

    const rawPublicKey = Buffer.from(
        publicKey.export({ format: 'jwk' }).x,
        'base64url',
    ).toString('hex');

    const emitir = crearEmisorLicencias({
        licensingPrivateKey: privateKey.export({
            format: 'pem',
            type: 'pkcs8',
        }),
    }, {
        testkey: rawPublicKey,
    });

    return { emitir, publicKey };
}

function verificarFirma(license, domain, publicKey) {
    const [prefix, keyId, installationId, signature] =
        license.split('.');

    return {
        prefix,
        keyId,
        installationId,
        signature,
        valid: verify(
            null,
            Buffer.from(
                `${domain}:${keyId}:${installationId}`,
                'ascii',
            ),
            publicKey,
            Buffer.from(signature, 'hex'),
        ),
    };
}

// --------------------------------------------------
// DNI / RUC
// --------------------------------------------------

test('HTTP: DNI/RUC, validación, errores y cabeceras de seguridad', async t => {
    const llamadas = [];

    const base = await iniciar(t, async (tipo, numero) => {
        llamadas.push([tipo, numero]);

        if (numero === '99999999') {
            throw new ApiError(
                504,
                'UPSTREAM_UNAVAILABLE',
                'mensaje privado',
            );
        }

        if (numero === '88888888') {
            throw new Error('token secreto');
        }

        return { [tipo]: numero };
    });

    for (const [tipo, numero] of [
        ['dni', '01234567'],
        ['ruc', '20131312955'],
    ]) {
        const res = await fetch(`${base}/${tipo}/${numero}`);

        assert.equal(res.status, 200);

        assert.deepEqual(await res.json(), {
            success: true,
            data: { [tipo]: numero },
        });

        assert.equal(res.headers.get('x-powered-by'), null);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.equal(
            res.headers.get('x-content-type-options'),
            'nosniff',
        );
        assert.ok(res.headers.get('x-request-id'));
    }

    for (const ruta of [
        '/dni/123',
        '/ruc/1234567890x',
    ]) {
        const res = await fetch(base + ruta);

        assert.equal(res.status, 400);
        assert.equal(
            (await res.json()).error.code,
            'INVALID_DOCUMENT',
        );
    }

    assert.equal(llamadas.length, 2);
    assert.equal(
        (await fetch(base + '/desconocido')).status,
        404,
    );

    for (const [numero, estado] of [
        ['99999999', 504],
        ['88888888', 500],
    ]) {
        const res = await fetch(`${base}/dni/${numero}`);

        assert.equal(res.status, estado);
        assert.doesNotMatch(
            await res.text(),
            /mensaje privado|token secreto|stack/,
        );
    }
});

// --------------------------------------------------
// CORS
// --------------------------------------------------

test('CORS permite el origen configurado y bloquea otros antes de consultar', async t => {
    let consultas = 0;

    const base = await iniciar(t, async () => {
        consultas++;
        return {};
    });

    const allowed = await fetch(base + '/health', {
        headers: {
            Origin: 'http://localhost:5173',
        },
    });

    assert.equal(
        allowed.headers.get('access-control-allow-origin'),
        'http://localhost:5173',
    );

    const denied = await fetch(base + '/dni/01234567', {
        headers: {
            Origin: 'https://otro.example',
        },
    });

    assert.equal(denied.status, 403);
    assert.equal(
        denied.headers.get('access-control-allow-origin'),
        null,
    );

    const preflight = await fetch(base + '/dni/01234567', {
        method: 'OPTIONS',
        headers: {
            Origin: 'http://localhost:5173',
            'Access-Control-Request-Method': 'GET',
        },
    });

    assert.equal(preflight.status, 204);
    assert.equal(
        preflight.headers.get('access-control-allow-methods'),
        'GET,POST',
    );

    assert.equal(consultas, 0);
});

// --------------------------------------------------
// RATE LIMIT
// --------------------------------------------------

test('rate limit se comparte entre DNI y RUC y no consulta al excederse', async t => {
    let consultas = 0;

    const base = await iniciar(
        t,
        async () => {
            consultas++;
            return {};
        },
        { RATE_LIMIT_MAX: '1' },
    );

    assert.equal(
        (await fetch(base + '/dni/01234567')).status,
        200,
    );

    const res = await fetch(base + '/ruc/20131312955');

    assert.equal(res.status, 429);
    assert.ok(res.headers.get('retry-after'));
    assert.ok(res.headers.get('ratelimit'));

    assert.equal(
        (await res.json()).error.code,
        'RATE_LIMIT_EXCEEDED',
    );

    assert.equal(consultas, 1);
    assert.equal(
        (await fetch(base + '/health')).status,
        200,
    );
});

// --------------------------------------------------
// CONFIGURACIÓN
// --------------------------------------------------

test('configuración rechaza token faltante, límites inválidos y CORS abierto', () => {
    assert.throws(
        () => cargarConfiguracion({}),
        /APIS_PERU_TOKEN/,
    );

    for (const overrides of [
        { PORT: '0' },
        { RATE_LIMIT_MAX: '-1' },
        { RATE_LIMIT_WINDOW_MS: 'abc' },
        { CORS_ORIGINS: '*' },
        { LICENSING_API_TOKEN: 'corto' },
        { LICENSING_UI_ENABLED: 'yes' },
    ]) {
        assert.throws(() => cargarConfiguracion({
            APIS_PERU_TOKEN: 'prueba',
            ...overrides,
        }));
    }

    assert.equal(
        cargarConfiguracion({
            APIS_PERU_TOKEN: 'prueba',
        }).trustProxy,
        false,
    );
});

// --------------------------------------------------
// RUTAS /API
// --------------------------------------------------

test('rutas /api funcionan y comparten la cuota con las rutas originales', async t => {
    const base = await iniciar(
        t,
        async (tipo, numero) => ({
            [tipo]: numero,
        }),
        { RATE_LIMIT_MAX: '2' },
    );

    const root = await fetch(base + '/');

    assert.equal(root.status, 200);
    assert.ok(
        (await root.json()).endpoints.includes(
            '/api/ruc/:numero',
        ),
    );

    const dni = await fetch(base + '/api/dni/01234567');

    assert.equal(dni.status, 200);
    assert.equal(
        (await dni.json()).data.dni,
        '01234567',
    );

    const ruc = await fetch(base + '/api/ruc/20131312955');

    assert.equal(ruc.status, 200);
    assert.equal(
        (await ruc.json()).data.ruc,
        '20131312955',
    );

    assert.equal(
        (await fetch(base + '/dni/01234567')).status,
        429,
    );

    assert.equal(
        (await fetch(base + '/api/health')).status,
        200,
    );
});

// --------------------------------------------------
// EMISIÓN DE LICENCIAS
// --------------------------------------------------

test('emite licencias solo con token válido y para IDs de instalación válidos', async t => {
    const llamadas = [];

    const base = await iniciar(
        t,
        async () => ({}),
        {
            LICENSING_API_TOKEN: API_TOKEN,
            LICENSING_UI_ENABLED: 'true',
            RATE_LIMIT_MAX: '20',
        },
        async (id, productId) => {
            llamadas.push({ id, productId });
            return `licencia-${id}`;
        },
    );

    const unauthorized = await postJson(
        base,
        '/api/licenses/issue',
        { installationId: 'A'.repeat(32) },
        false,
    );

    assert.equal(unauthorized.status, 401);
    assert.equal(
        (await unauthorized.json()).error.code,
        'UNAUTHORIZED',
    );

    const invalidId = await postJson(
        base,
        '/api/licenses/issue',
        { installationId: 'invalido' },
    );

    assert.equal(invalidId.status, 400);
    assert.equal(
        (await invalidId.json()).error.code,
        'INVALID_INSTALLATION_ID',
    );

    const issued = await postJson(
        base,
        '/api/licenses/issue',
        { installationId: INSTALLATION_ID },
    );

    assert.equal(issued.status, 201);

    const issuedBody = await issued.json();

    assert.equal(issuedBody.success, true);
    assert.equal(
        issuedBody.data.license,
        `licencia-${INSTALLATION_ID}`,
    );
    assert.equal(
        issuedBody.data.productId,
        'mype-andale',
    );
    assert.equal(
        issuedBody.data.productName,
        'MYPE Ándale',
    );

    assert.match(
        issuedBody.data.qrDataUrl,
        /^data:image\/png;base64,/,
    );

    assert.ok(
        Buffer.from(
            issuedBody.data.qrDataUrl.split(',')[1],
            'base64',
        ).subarray(0, 8).equals(
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        ),
    );

    // La interfaz no puede emitir sin sesión.
    const uiIssued = await fetch(
        base + '/api/licenses/issue/ui',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: base,
            },
            body: JSON.stringify({
                installationId: INSTALLATION_ID,
            }),
        },
    );

    assert.equal(uiIssued.status, 401);
    assert.equal(
        (await uiIssued.json()).error.code,
        'UNAUTHORIZED',
    );

    const invalidJson = await fetch(
        base + '/api/licenses/issue',
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${API_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: '{"installationId":',
        },
    );

    assert.equal(invalidJson.status, 400);
    assert.equal(
        (await invalidJson.json()).error.code,
        'INVALID_JSON',
    );

    assert.deepEqual(llamadas, [
        {
            id: INSTALLATION_ID,
            productId: 'mype-andale',
        },
    ]);
});

// --------------------------------------------------
// HOTEL ÁNDALE
// --------------------------------------------------

test('la API permite emitir Hotel Ándale y devuelve el producto correcto', async t => {
    const { emitir, publicKey } = crearEmisorDePrueba();

    const base = await iniciar(
        t,
        async () => ({}),
        { LICENSING_API_TOKEN: API_TOKEN },
        emitir,
    );

    const response = await postJson(
        base,
        '/api/licenses/issue',
        {
            installationId: INSTALLATION_ID,
            productId: 'hotel-andale',
        },
    );

    assert.equal(response.status, 201);

    const body = await response.json();

    assert.equal(
        body.data.productId,
        'hotel-andale',
    );
    assert.equal(
        body.data.productName,
        'Hotel Ándale',
    );

    assert.match(
        body.data.qrDataUrl,
        /^data:image\/png;base64,/,
    );

    const signed = verificarFirma(
        body.data.license,
        'HOTEL-ANDALE:LICENSE:1',
        publicKey,
    );

    assert.equal(signed.prefix, 'HA1');
    assert.equal(
        signed.installationId,
        INSTALLATION_ID,
    );
    assert.equal(signed.valid, true);
});

// --------------------------------------------------
// PRODUCTOS INVÁLIDOS
// --------------------------------------------------

test('la API rechaza productos inválidos sin emitir licencias', async t => {
    let llamadas = 0;

    const base = await iniciar(
        t,
        async () => ({}),
        { LICENSING_API_TOKEN: API_TOKEN },
        async () => {
            llamadas++;
            return 'no-debe-emitirse';
        },
    );

    for (const productId of [
        'otro-producto',
        null,
        123,
    ]) {
        const response = await postJson(
            base,
            '/api/licenses/issue',
            {
                installationId: INSTALLATION_ID,
                productId,
            },
        );

        assert.equal(response.status, 400);
        assert.equal(
            (await response.json()).error.code,
            'INVALID_LICENSE_PRODUCT',
        );
    }

    assert.equal(llamadas, 0);
});

// --------------------------------------------------
// INTERFAZ ADMINISTRATIVA
// --------------------------------------------------

test('sirve la interfaz HTML y sus recursos del mismo origen', async t => {
    const base = await iniciar(
        t,
        async () => ({}),
        { LICENSING_UI_ENABLED: 'true' },
    );

    const page = await fetch(base + '/licenses/issue');

    assert.equal(page.status, 200);

    assert.match(
        page.headers.get('content-type'),
        /text\/html/,
    );

    assert.match(
        page.headers.get('content-security-policy'),
        /img-src[^;]*data:/,
    );

    const html = await page.text();

    assert.match(html, /id="issue-form"/);
    assert.match(html, /id="login-form"/);
    assert.match(html, /id="admin-section"/);
    assert.match(html, /id="product-id"/);
    assert.match(html, /value="hotel-andale"/);

    const script = await fetch(
        base + '/licenses/assets/issue.js',
    );

    assert.equal(script.status, 200);
    assert.match(
        script.headers.get('content-type'),
        /javascript/,
    );

    const scriptText = await script.text();

    assert.match(
        scriptText,
        /api\/licenses\/issue\/ui/,
    );

    assert.match(scriptText, /productId/);
    assert.doesNotMatch(
        scriptText,
        /Authorization|apiToken/,
    );

    assert.equal(
        (await fetch(
            base + '/licenses/assets/issue.css',
        )).status,
        200,
    );
});

// --------------------------------------------------
// INTERFAZ DESHABILITADA
// --------------------------------------------------

test('la interfaz y su ruta UI permanecen cerradas si no se habilitan', async t => {
    const base = await iniciar(t, async () => ({}));

    assert.equal(
        (await fetch(base + '/licenses/issue')).status,
        404,
    );

    const response = await postJson(
        base,
        '/api/licenses/issue/ui',
        { installationId: INSTALLATION_ID },
        false,
    );

    assert.equal(response.status, 404);
});

// --------------------------------------------------
// LICENCIAS SIN CONFIGURACIÓN
// --------------------------------------------------

test('la emisión queda deshabilitada si no se configuró su secreto', async t => {
    const base = await iniciar(t, async () => ({}));

    const response = await fetch(
        base + '/api/licenses/issue',
        { method: 'POST' },
    );

    assert.equal(response.status, 503);
    assert.equal(
        (await response.json()).error.code,
        'LICENSING_NOT_CONFIGURED',
    );
});

// --------------------------------------------------
// FIRMAS ED25519
// --------------------------------------------------

test('el emisor firma tokens MA1 y HA1 compatibles con sus protocolos offline', async () => {
    const { emitir, publicKey } = crearEmisorDePrueba();

    for (const [productId, product] of Object.entries(
        LICENSE_PRODUCTS,
    )) {
        const license = await emitir(
            INSTALLATION_ID,
            productId,
        );

        const signed = verificarFirma(
            license,
            product.domain,
            publicKey,
        );

        assert.equal(signed.prefix, product.prefix);
        assert.equal(signed.keyId, 'testkey');
        assert.equal(
            signed.installationId,
            INSTALLATION_ID,
        );
        assert.match(
            signed.signature,
            /^[a-f0-9]{128}$/,
        );
        assert.equal(signed.valid, true);
    }

    await assert.rejects(
        emitir('not-an-id'),
        error => error.code === 'INVALID_INSTALLATION_ID',
    );
});

test('MYPE y Hotel no aceptan firmas emitidas para el otro producto', async () => {
    const { emitir, publicKey } = crearEmisorDePrueba();

    const mype = await emitir(
        INSTALLATION_ID,
        'mype-andale',
    );

    const hotel = await emitir(
        INSTALLATION_ID,
        'hotel-andale',
    );

    assert.equal(
        verificarFirma(
            mype,
            'HOTEL-ANDALE:LICENSE:1',
            publicKey,
        ).valid,
        false,
    );

    assert.equal(
        verificarFirma(
            hotel,
            'MYPE-ANDALE:LICENSE:1',
            publicKey,
        ).valid,
        false,
    );
});

test('el emisor conserva MYPE como producto predeterminado', async () => {
    const { emitir } = crearEmisorDePrueba();

    assert.equal(
        await emitir(INSTALLATION_ID),
        await emitir(INSTALLATION_ID, 'mype-andale'),
    );

    assert.match(
        await emitir(INSTALLATION_ID),
        /^MA1\./,
    );
});

test('el emisor rechaza productos desconocidos', async () => {
    const { emitir } = crearEmisorDePrueba();

    await assert.rejects(
        emitir(INSTALLATION_ID, 'otro-producto'),
        error => error.code === 'INVALID_LICENSE_PRODUCT',
    );
});

// --------------------------------------------------
// VERCEL
// --------------------------------------------------

test('entrada Vercel exporta handler y sirve health aunque falte el token', async t => {
    const originalToken = process.env.APIS_PERU_TOKEN;

    process.env.APIS_PERU_TOKEN = '';

    t.after(() => {
        if (originalToken === undefined) {
            delete process.env.APIS_PERU_TOKEN;
        } else {
            process.env.APIS_PERU_TOKEN = originalToken;
        }
    });

    const { default: app } = await import('../app.js');

    assert.equal(typeof app, 'function');

    const server = app.listen(0, '127.0.0.1');

    await once(server, 'listening');

    t.after(() => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));

    const base =
        `http://127.0.0.1:${server.address().port}`;

    assert.equal(
        (await fetch(base + '/api/health')).status,
        200,
    );

    assert.equal(
        (await fetch(base + '/ruc/10752093828')).status,
        500,
    );

    assert.equal(
        (await fetch(base + '/dni/123')).status,
        400,
    );
});

// --------------------------------------------------
// UTILIDADES DE SESIÓN ADMINISTRATIVA
// --------------------------------------------------

function cookieDeRespuesta(response) {
    const setCookie = response.headers.get('set-cookie');

    assert.ok(
        setCookie,
        'El servidor debe establecer una cookie de sesión',
    );

    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);

    return setCookie.split(';')[0];
}

function postPanel(
    base,
    path,
    body,
    cookie,
    origin = base,
) {
    return fetch(base + path, {
        method: 'POST',
        headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(body),
    });
}

// --------------------------------------------------
// AUTENTICACIÓN ADMINISTRATIVA
// --------------------------------------------------

test('panel: rechaza token incorrecto y no crea sesión', async t => {
    const base = await iniciar(
        t,
        async () => ({}),
        {
            LICENSING_API_TOKEN: API_TOKEN,
            LICENSING_UI_ENABLED: 'true',
        },
        async () => 'no-debe-emitirse',
    );

    const response = await postPanel(
        base,
        '/api/licenses/session',
        { token: 'token-incorrecto' },
    );

    assert.equal(response.status, 401);
    assert.equal(
        (await response.json()).error.code,
        'UNAUTHORIZED',
    );

    assert.equal(
        response.headers.get('set-cookie'),
        null,
    );
});

test('panel: inicia sesión y permite emitir MYPE y Hotel con cookie válida', async t => {
    const { emitir, publicKey } = crearEmisorDePrueba();

    const base = await iniciar(
        t,
        async () => ({}),
        {
            LICENSING_API_TOKEN: API_TOKEN,
            LICENSING_UI_ENABLED: 'true',
        },
        emitir,
    );

    const login = await postPanel(
        base,
        '/api/licenses/session',
        { token: API_TOKEN },
    );

    assert.equal(login.status, 200);
    assert.equal(
        (await login.json()).data.authenticated,
        true,
    );

    const cookie = cookieDeRespuesta(login);

    const session = await fetch(
        base + '/api/licenses/session',
        {
            headers: { Cookie: cookie },
        },
    );

    assert.equal(session.status, 200);
    assert.equal(
        (await session.json()).data.authenticated,
        true,
    );

    for (const [productId, product] of Object.entries(
        LICENSE_PRODUCTS,
    )) {
        const response = await postPanel(
            base,
            '/api/licenses/issue/ui',
            {
                installationId: INSTALLATION_ID,
                productId,
            },
            cookie,
        );

        assert.equal(response.status, 201);

        const body = await response.json();

        assert.equal(body.data.productId, productId);
        assert.equal(
            body.data.productName,
            product.name,
        );

        assert.match(
            body.data.qrDataUrl,
            /^data:image\/png;base64,/,
        );

        assert.equal(
            verificarFirma(
                body.data.license,
                product.domain,
                publicKey,
            ).valid,
            true,
        );
    }
});

test('panel: rechaza solicitudes de otro origen incluso con sesión válida', async t => {
    let emisiones = 0;

    const base = await iniciar(
        t,
        async () => ({}),
        {
            LICENSING_API_TOKEN: API_TOKEN,
            LICENSING_UI_ENABLED: 'true',
        },
        async () => {
            emisiones++;
            return 'licencia';
        },
    );

    const login = await postPanel(
        base,
        '/api/licenses/session',
        { token: API_TOKEN },
    );

    assert.equal(login.status, 200);

    const cookie = cookieDeRespuesta(login);

    const response = await postPanel(
        base,
        '/api/licenses/issue/ui',
        {
            installationId: INSTALLATION_ID,
        },
        cookie,
        'https://otro.example',
    );

    assert.equal(response.status, 403);
    assert.equal(emisiones, 0);
});

test('panel: cerrar sesión elimina cookie y bloquea solicitudes posteriores sin ella', async t => {
    const base = await iniciar(
        t,
        async () => ({}),
        {
            LICENSING_API_TOKEN: API_TOKEN,
            LICENSING_UI_ENABLED: 'true',
        },
        async () => 'licencia',
    );

    const login = await postPanel(
        base,
        '/api/licenses/session',
        { token: API_TOKEN },
    );

    assert.equal(login.status, 200);

    const cookie = cookieDeRespuesta(login);

    const logout = await fetch(
        base + '/api/licenses/logout',
        {
            method: 'POST',
            headers: {
                Origin: base,
                Cookie: cookie,
            },
        },
    );

    assert.equal(logout.status, 200);
    assert.equal(
        (await logout.json()).data.authenticated,
        false,
    );

    assert.match(
        logout.headers.get('set-cookie') ?? '',
        /Max-Age=0|Expires=/i,
    );

    const response = await postPanel(
        base,
        '/api/licenses/issue/ui',
        {
            installationId: INSTALLATION_ID,
        },
    );

    assert.equal(response.status, 401);
});