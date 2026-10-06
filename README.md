# API de consultas DNI/RUC

Requiere Node.js 22 o superior. Instalar con `npm install` y configurar `.env` usando `.env.example` como referencia, conservando el token existente.

```powershell
npm.cmd start
# Desarrollo con recarga automática:
npm.cmd run dev
```

## Endpoints

- `GET http://localhost:3000/dni/01234567`: DNI de exactamente 8 dígitos.
- `GET http://localhost:3000/ruc/20131312955`: RUC de exactamente 11 dígitos.
- `GET http://localhost:3000/health`: disponibilidad del proceso, sin consultar al proveedor.

La validación local comprueba formato y longitud; la existencia e identidad se verifican con APIsPERU.

Respuesta exitosa: `{ "success": true, "data": { ...datosDelProveedor } }`.
Respuesta de error: `{ "success": false, "error": { "code": "...", "message": "...", "requestId": "..." } }`.

Estados: `400` documento inválido, `403` origen bloqueado, `404` ruta/documento no encontrado, `429` límite local, `502` fallo/respuesta inválida del proveedor, `503` límite del proveedor, `504` timeout y `500` error interno. Los errores internos no exponen mensajes del proveedor ni el token.

## Configuración

- `APIS_PERU_TOKEN`: token usado exclusivamente en el servidor como `Authorization: Bearer`.
- `PORT`: 3000 por defecto.
- `HOST`: `127.0.0.1` por defecto; `0.0.0.0` para escuchar fuera del equipo/contenedor.
- `CORS_ORIGINS`: orígenes separados por comas, sin rutas. Por defecto `http://localhost:5173,http://localhost:3000`.
- `RATE_LIMIT_WINDOW_MS`: ventana de 60000 ms por defecto.
- `RATE_LIMIT_MAX`: 30 solicitudes por IP, compartidas entre DNI y RUC, por ventana.
- `TRUST_PROXY`: vacío por defecto; configurar únicamente IP/subred del proxy confiable (por ejemplo `127.0.0.1`). No habilitar confianza global en cabeceras enviadas por clientes.

El límite usa memoria del proceso: se reinicia al arrancar y cada instancia tiene su contador. Para varias instancias se necesita un almacén compartido, por ejemplo Redis. CORS controla acceso desde navegadores, no autentica clientes; esta API no agrega autenticación de consumidores. Para publicación usar HTTPS y el control de acceso correspondiente a la aplicación.

Se incluyen Helmet, identificadores de solicitud, `Cache-Control: no-store`, tiempo de espera de 15 segundos al proveedor y cierre ordenado. No se registran números de documento, datos personales ni tokens.

```powershell
npm.cmd test
# Mantiene el modo de consulta por consola:
npm.cmd run consultar -- ruc 20131312955
```

Las pruebas usan respuestas simuladas y no consumen la cuota de APIsPERU.
