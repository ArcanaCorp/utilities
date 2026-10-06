import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ApiError } from './errors.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const BASE_URL = 'https://dniruc.apisperu.com/api/v1/';

export function validarDocumento(tipo, numero) {
    if (tipo !== 'dni' && tipo !== 'ruc') {
        throw new ApiError(400, 'INVALID_DOCUMENT', 'El tipo de documento debe ser dni o ruc.');
    }
    if (typeof numero !== 'string' || !new RegExp(`^\\d{${tipo === 'dni' ? 8 : 11}}$`).test(numero)) {
        throw new ApiError(400, 'INVALID_DOCUMENT', `El ${tipo.toUpperCase()} debe contener exactamente ${tipo === 'dni' ? 8 : 11} dígitos.`);
    }
    return numero;
}

export function validarRespuesta(tipo, numero, datos) {
    if (!datos || typeof datos !== 'object' || Array.isArray(datos)) {
        throw new ApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'La API devolvió una respuesta con formato inválido.');
    }
    if (datos.success === false) {
        throw new ApiError(502, 'UPSTREAM_FAILURE', 'La API indica que no se encontró el documento o que la consulta falló.');
    }
    if (datos[tipo] !== numero) {
        throw new ApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'El documento de la respuesta no coincide con el solicitado.');
    }
    const campos = tipo === 'dni' ? ['nombres', 'apellidoPaterno', 'apellidoMaterno'] : ['razonSocial'];
    if (campos.some(campo => typeof datos[campo] !== 'string') ||
        !datos[tipo === 'dni' ? 'nombres' : 'razonSocial'].trim()) {
        throw new ApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'La API devolvió datos de identidad incompletos o inválidos.');
    }
    return datos;
}

export async function consultarDocumento(tipo, numero) {
    
    validarDocumento(tipo, numero);
    const token = process.env.APIS_PERU_TOKEN?.trim();
    if (!token) throw new ApiError(500, 'CONFIGURATION_ERROR', 'Falta APIS_PERU_TOKEN en el archivo .env.');

    let respuesta;

    try {
        respuesta = await fetch(`${BASE_URL}${tipo}/${numero}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(15000),
            redirect: 'error',
        });
    } catch (error) {
        throw new ApiError(error.name === 'TimeoutError' ? 504 : 502, 'UPSTREAM_UNAVAILABLE', error.name === 'TimeoutError' ? 'La consulta excedió el tiempo de espera de 15 segundos.' : 'No se pudo conectar con APIsPERU.');
    }

    if (!respuesta.ok) {
        const errores = {
            401: 'Token inválido o vencido.',
            403: 'El token no tiene permiso para realizar esta consulta.',
            404: 'Documento o endpoint no encontrado.',
            429: 'Se alcanzó el límite de consultas.',
        };
        throw new ApiError(respuesta.status === 404 ? 404 : respuesta.status === 429 ? 503 : 502, 'UPSTREAM_ERROR', `APIsPERU respondió HTTP ${respuesta.status}: ${errores[respuesta.status] ?? 'La consulta falló.'}`);
    }

    let datos;
    
    try {
        datos = await respuesta.json();
    } catch {
        throw new ApiError(502, 'INVALID_UPSTREAM_RESPONSE', 'La API no devolvió un JSON válido.');
    }
    
    return validarRespuesta(tipo, numero, datos);

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [, , tipo, numero, ...extras] = process.argv;
    try {
        if (!tipo || !numero || extras.length) throw new Error('Uso: npm run consultar -- <dni|ruc> <número>');
        console.log(JSON.stringify(await consultarDocumento(tipo, numero), null, 2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
