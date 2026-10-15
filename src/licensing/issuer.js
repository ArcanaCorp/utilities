import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import publicKeys from './public-keys.json' with { type: 'json' };
import { ApiError } from '../errors.js';

export const normalizeInstallationId = value => {
  const id = typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '';
  if (!/^[0-9A-F]{32}$/.test(id)) {
    throw new ApiError(400, 'INVALID_INSTALLATION_ID', 'El ID de instalación debe contener 32 dígitos hexadecimales.');
  }
  return id;
};

export function crearEmisorLicencias(config, keys = publicKeys) {
  return async installationId => {
    const id = normalizeInstallationId(installationId);
    let privateKey;
    try {
      const pem = config.licensingPrivateKey ?? await readFile(config.licensingPrivateKeyPath, 'utf8');
      privateKey = createPrivateKey(pem);
    } catch {
      throw new ApiError(503, 'LICENSING_NOT_CONFIGURED', 'El servicio de emisión de licencias no está configurado.');
    }

    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new ApiError(503, 'LICENSING_KEY_INVALID', 'La clave configurada no es una clave Ed25519 válida.');
    }
    const derivedPublicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x;
    const keyId = Object.entries(keys).find(([, publicKey]) =>
      Buffer.from(publicKey, 'hex').toString('base64url') === derivedPublicKey,
    )?.[0];
    if (!keyId) {
      throw new ApiError(503, 'LICENSING_KEY_MISMATCH', 'La clave de emisión no corresponde a esta aplicación.');
    }

    const message = `MYPE-ANDALE:LICENSE:1:${keyId}:${id}`;
    const signature = sign(null, Buffer.from(message, 'ascii'), privateKey).toString('hex');
    return `MA1.${keyId}.${id}.${signature}`;
  };
}
