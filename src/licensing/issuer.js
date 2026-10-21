import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import publicKeys from './public-keys.json' with { type: 'json' };
import { ApiError } from '../errors.js';
import { LICENSE_PRODUCTS, DEFAULT_LICENSE_PRODUCT } from './products.js';

export const normalizeInstallationId = value => {
  
    const id = typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '';

    if (!/^[0-9A-F]{32}$/.test(id)) {
        throw new ApiError(400, 'INVALID_INSTALLATION_ID', 'El ID de instalación debe contener 32 dígitos hexadecimales.');
    }

    return id;
};

export function crearEmisorLicencias(config, keys = publicKeys) {
    return async (installationId, productId = DEFAULT_LICENSE_PRODUCT) => {
        const id = normalizeInstallationId(installationId);

        // Validar el producto solicitado.
        const product = Object.hasOwn(LICENSE_PRODUCTS, productId) ? LICENSE_PRODUCTS[productId] : null;

        if (!product) {
            throw new ApiError(400, 'INVALID_LICENSE_PRODUCT', 'El producto seleccionado no es válido.');
        }

        // Obtener la clave privada.
        let privateKey;

        try {
            const pem = config.licensingPrivateKey ?? await readFile(config.licensingPrivateKeyPath, 'utf8');
            privateKey = createPrivateKey(pem);
        } catch {
            throw new ApiError(503, 'LICENSING_NOT_CONFIGURED', 'El servicio de emisión de licencias no está configurado.');
        }

        // Comprobar el algoritmo criptográfico.
        if (privateKey.asymmetricKeyType !== 'ed25519') {
            throw new ApiError(503, 'LICENSING_KEY_INVALID', 'La clave configurada no es una clave Ed25519 válida.');
        }

        // Identificar la clave pública correspondiente.
        const derivedPublicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x;

        const keyId = Object.entries(keys).find(([, publicKey]) => Buffer.from(publicKey, 'hex').toString('base64url') === derivedPublicKey)?.[0];

        if (!keyId) {
            throw new ApiError(503, 'LICENSING_KEY_MISMATCH', 'La clave de emisión no corresponde a esta aplicación.');
        }

        // Construir el mensaje exclusivo del producto.
        const message = `${product.domain}:${keyId}:${id}`;

        // Firmar digitalmente.
        const signature = sign(null, Buffer.from(message, 'ascii'), privateKey).toString('hex');

        // Construir el código final.
        return `${product.prefix}.${keyId}.${id}.${signature}`;
    };
}