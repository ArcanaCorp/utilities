import nacl from 'tweetnacl';
export function normalizeInstallationId(value) {
    const id = String(value || '').replace(/[\s-]/g, '').toUpperCase();
    if (!/^[0-9A-F]{32}$/.test(id)) throw new Error('El ID de instalación no es válido.');
    return id;
}
export function displayInstallationId(id) { return normalizeInstallationId(id).match(/.{4}/g).join('-'); }
export const licenseMessage = (keyId, id) => 'MYPE-ANDALE:LICENSE:1:' + keyId + ':' + id;
const bytes = text => Uint8Array.from(text, char => char.charCodeAt(0));
const unhex = hex => Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16));
export function verifyLicense(input, installationId, publicKeys) {
    if (typeof input !== 'string' || input.length > 1024) throw new Error('El código de licencia no es válido.');
    const token = input.replace(/\s/g, '');
    const match = /^MA1[.]([a-z0-9]{1,24})[.]([A-F0-9]{32})[.]([a-f0-9]{128})$/.exec(token);
    if (!match) throw new Error('Ingresa el código completo o escanea el QR de la licencia.');
    const [, keyId, id, signature] = match;
    const publicKey = Object.hasOwn(publicKeys, keyId) ? publicKeys[keyId] : null;
    if (typeof publicKey !== 'string' || !/^[a-f0-9]{64}$/.test(publicKey)) throw new Error('Esta licencia no es compatible con esta versión de MYPE Ándale.');
    if (!nacl.sign.detached.verify(bytes(licenseMessage(keyId, id)), unhex(signature), unhex(publicKey))) throw new Error('La firma de la licencia no es válida.');
    if (id !== normalizeInstallationId(installationId)) throw new Error('Esta licencia pertenece a otra instalación. Envía tu ID a ARCANA.');
    return { token, installationId: id, keyId };
}
