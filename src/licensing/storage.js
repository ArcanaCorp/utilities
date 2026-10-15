import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { getRandomBytesAsync } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
const KEY = 'mype.installation.license.v1';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const web = () => Platform.OS === 'web';
export async function writeInstallation(state) {
    const value = JSON.stringify(state);
    if (web()) localStorage.setItem(KEY, value);
    else await SecureStore.setItemAsync(KEY, value, options);
}
export async function readInstallation() {
    const stored = web() ? localStorage.getItem(KEY) : await SecureStore.getItemAsync(KEY, options);
    let state;
    if (stored) {
        try { state = JSON.parse(stored); } catch { throw new Error('No se pudo leer la activación guardada. Contacta con soporte.'); }
        if (!state || !/^[A-F0-9]{32}$/.test(state.id) || (state.token !== null && typeof state.token !== 'string')) throw new Error('Los datos de activación están dañados. Contacta con soporte.');
    }
    // SecureStore puede sobrevivir a la desinstalación en iOS; el marcador no.
    const marker = web() ? null : new File(Paths.document, '.mype-installation');
    if (state && (!marker || (marker.exists && await marker.text() === state.id))) return state;
    const random = await getRandomBytesAsync(16);
    const id = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    state = { id, token: null };
    if (marker) marker.write(id);
    await writeInstallation(state);
    return state;
}
