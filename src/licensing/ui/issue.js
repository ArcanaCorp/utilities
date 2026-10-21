
const loginSection = document.querySelector('#login-section');
const loginForm = document.querySelector('#login-form');
const tokenInput = document.querySelector('#admin-token');
const loginButton = document.querySelector('#login-button');
const loginStatus = document.querySelector('#login-status');

const adminSection = document.querySelector('#admin-section');
const logoutButton = document.querySelector('#logout-button');

const form = document.querySelector('#issue-form');
const productInput = document.querySelector('#product-id');
const idInput = document.querySelector('#installation-id');
const submitButton = document.querySelector('#submit-button');
const status = document.querySelector('#status');

const result = document.querySelector('#result');
const resultProduct = document.querySelector('#result-product');
const licenseCode = document.querySelector('#license-code');
const qrImage = document.querySelector('#qr-image');
const downloadQr = document.querySelector('#download-qr');
const copyButton = document.querySelector('#copy-license');

const PRODUCTS = Object.freeze({
    'mype-andale': {
        name: 'MYPE Ándale',
        prefix: 'MA1',
    },
    'hotel-andale': {
        name: 'Hotel Ándale',
        prefix: 'HA1',
    },
});

// --------------------------------------------------
// UTILIDADES
// --------------------------------------------------

function setStatus(element, message = '', type = '') {
    element.className = 'status';

    if (type) {
        element.classList.add(type);
    }

    element.textContent = message;
}

function setButtonLoading(button, loading, loadingText, normalText) {
    button.disabled = loading;

    const label = button.querySelector('.button-label');

    if (label) {
        label.textContent = loading ? loadingText : normalText;
    }

    button.classList.toggle('loading', loading);
}

function mostrarLogin() {
    loginSection.hidden = false;
    adminSection.hidden = true;

    tokenInput.value = '';
    limpiarResultado();
}

function mostrarPanel() {
    loginSection.hidden = true;
    adminSection.hidden = false;

    tokenInput.value = '';
    setStatus(loginStatus);
}

function limpiarResultado() {
    result.hidden = true;

    licenseCode.value = '';
    qrImage.removeAttribute('src');
    downloadQr.removeAttribute('href');

    copyButton.textContent = 'Copiar código';

    setStatus(status);
}

async function leerRespuesta(response) {
    let body;

    try {
        body = await response.json();
    } catch {
        throw new Error(
            'El servidor devolvió una respuesta inesperada.',
        );
    }

    return body;
}

// --------------------------------------------------
// VERIFICAR SESIÓN EXISTENTE
// --------------------------------------------------

async function verificarSesion() {
    loginSection.hidden = true;
    adminSection.hidden = true;

    try {
        const response = await fetch('/api/licenses/session', {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
        });

        if (!response.ok) {
            mostrarLogin();
            return;
        }

        const body = await leerRespuesta(response);

        if (body.success && body.data?.authenticated === true) {
            mostrarPanel();
        } else {
            mostrarLogin();
        }

    } catch {
        mostrarLogin();

        setStatus(
            loginStatus,
            'No se pudo verificar la sesión. Revisa tu conexión.',
            'error',
        );
    }
}

// --------------------------------------------------
// INICIAR SESIÓN
// --------------------------------------------------

if (loginForm) {
    loginForm.addEventListener('submit', async event => {
        event.preventDefault();

        setStatus(loginStatus);

        const token = tokenInput.value;

        if (!token || !token.trim()) {
            setStatus(
                loginStatus,
                'Ingresa el token de administración.',
                'error',
            );

            tokenInput.focus();
            return;
        }

        setButtonLoading(
            loginButton,
            true,
            'Verificando…',
            'Iniciar sesión',
        );

        tokenInput.disabled = true;

        try {
            const response = await fetch('/api/licenses/session', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                credentials: 'same-origin',
                cache: 'no-store',
                body: JSON.stringify({
                    token,
                }),
            });

            const body = await leerRespuesta(response);

            if (!response.ok) {
                throw new Error(
                    body.error?.message ||
                    'No se pudo iniciar sesión.',
                );
            }

            if (
                body.success !== true ||
                body.data?.authenticated !== true
            ) {
                throw new Error(
                    'El servidor no confirmó la autenticación.',
                );
            }

            mostrarPanel();

        } catch (error) {
            setStatus(
                loginStatus,
                error instanceof TypeError
                    ? 'No se pudo conectar con el servidor.'
                    : error.message || 'Error de autenticación.',
                'error',
            );

        } finally {
            tokenInput.disabled = false;

            setButtonLoading(
                loginButton,
                false,
                'Verificando…',
                'Iniciar sesión',
            );
        }
    });
}

// --------------------------------------------------
// CERRAR SESIÓN
// --------------------------------------------------

if (logoutButton) {
    logoutButton.addEventListener('click', async () => {
        logoutButton.disabled = true;

        try {
            const response = await fetch('/api/licenses/logout', {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
            });

            if (!response.ok) {
                const body = await leerRespuesta(response);

                throw new Error(
                    body.error?.message ||
                    'No se pudo cerrar la sesión.',
                );
            }

            mostrarLogin();

            setStatus(
                loginStatus,
                'Sesión cerrada correctamente.',
                'success',
            );

        } catch (error) {
            setStatus(
                status,
                error.message || 'No se pudo cerrar la sesión.',
                'error',
            );

        } finally {
            logoutButton.disabled = false;
        }
    });
}

// --------------------------------------------------
// EMITIR LICENCIA
// --------------------------------------------------

if (form) {
    form.addEventListener('submit', async event => {
        event.preventDefault();

        limpiarResultado();

        const productId = productInput.value;

        const product = Object.hasOwn(PRODUCTS, productId)
            ? PRODUCTS[productId]
            : null;

        const installationId = idInput.value.trim();

        if (!product) {
            setStatus(
                status,
                'Selecciona un producto válido.',
                'error',
            );
            return;
        }

        if (!installationId) {
            setStatus(
                status,
                'Ingresa el ID de instalación.',
                'error',
            );

            idInput.focus();
            return;
        }

        const normalizedId = installationId
            .replace(/[\s-]/g, '')
            .toUpperCase();

        if (!/^[0-9A-F]{32}$/.test(normalizedId)) {
            setStatus(
                status,
                'El ID debe contener 32 caracteres hexadecimales.',
                'error',
            );

            idInput.focus();
            return;
        }

        submitButton.disabled = true;
        productInput.disabled = true;
        idInput.disabled = true;

        setButtonLoading(
            submitButton,
            true,
            'Emitiendo…',
            'Emitir licencia',
        );

        setStatus(
            status,
            `Generando licencia de ${product.name}…`,
        );

        try {
            const response = await fetch('/api/licenses/issue/ui', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                credentials: 'same-origin',
                cache: 'no-store',
                body: JSON.stringify({
                    productId,
                    installationId: normalizedId,
                }),
            });

            const body = await leerRespuesta(response);

            if (response.status === 401) {
                mostrarLogin();

                setStatus(
                    loginStatus,
                    'Tu sesión expiró. Inicia sesión nuevamente.',
                    'error',
                );

                return;
            }

            if (!response.ok) {
                throw new Error(
                    body.error?.message ||
                    'No se pudo emitir la licencia.',
                );
            }

            const data = body.data;

            if (
                typeof data?.license !== 'string' ||
                typeof data?.qrDataUrl !== 'string' ||
                !data.qrDataUrl.startsWith('data:image/png;base64,') ||
                data.productId !== productId ||
                !data.license.startsWith(`${product.prefix}.`)
            ) {
                throw new Error(
                    'El servidor devolvió una licencia incompatible con el producto seleccionado.',
                );
            }

            // Producto.
            resultProduct.textContent =
                data.productName || product.name;

            // Código de licencia.
            licenseCode.value = data.license;

            // Código QR.
            qrImage.src = data.qrDataUrl;

            qrImage.alt =
                `Código QR de activación de ${product.name}`;

            // Descarga.
            downloadQr.href = data.qrDataUrl;

            downloadQr.download =
                `licencia-${productId}.png`;

            // Resultado.
            result.hidden = false;

            setStatus(
                status,
                `Licencia de ${product.name} emitida correctamente.`,
                'success',
            );

            result.scrollIntoView({
                behavior: 'smooth',
                block: 'nearest',
            });

        } catch (error) {
            setStatus(
                status,
                error instanceof TypeError
                    ? 'No se pudo conectar con el servicio. Revisa tu conexión.'
                    : error.message || 'Ocurrió un error inesperado.',
                'error',
            );

        } finally {
            submitButton.disabled = false;
            productInput.disabled = false;
            idInput.disabled = false;

            setButtonLoading(
                submitButton,
                false,
                'Emitiendo…',
                'Emitir licencia',
            );
        }
    });
}

// --------------------------------------------------
// COPIAR CÓDIGO
// --------------------------------------------------

if (copyButton) {
    copyButton.addEventListener('click', async () => {
        if (!licenseCode.value) return;

        try {
            await navigator.clipboard.writeText(
                licenseCode.value,
            );

            copyButton.textContent = 'Código copiado';

        } catch {
            licenseCode.focus();
            licenseCode.select();

            copyButton.textContent =
                'Selecciona y copia el código';
        }
    });
}

// --------------------------------------------------
// INICIALIZACIÓN
// --------------------------------------------------

verificarSesion();
