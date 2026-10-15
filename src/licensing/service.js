import publicKeys from './public-keys.json';
import { verifyLicense } from './protocol';
import { readInstallation, writeInstallation } from './storage';
let queue = Promise.resolve();
/** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
const serialized = task => { const result = queue.then(task); queue = result.then(() => {}, () => {}); return result; };
export const getLicenseState = () => serialized(async () => {
    const state = await readInstallation();
    if (!state.token) return { id: state.id, active: false, reason: '' };
    try { verifyLicense(state.token, state.id, publicKeys); return { id: state.id, active: true, reason: '' }; }
    catch (error) { return { id: state.id, active: false, reason: error.message }; }
});
export const activateLicense = input => serialized(async () => {
    const state = await readInstallation();
    const license = verifyLicense(input, state.id, publicKeys);
    await writeInstallation({ id: state.id, token: license.token });
    return { id: state.id, active: true, reason: '' };
});
