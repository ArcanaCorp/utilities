# Licencias de MYPE Ándale

## Qué es

Es una activación offline vinculada a una instalación. El cliente compra la app por **S/ 49.90**, envía su ID a ARCANA y recibe una licencia en texto y QR. La licencia no tiene vencimiento.

## Cómo funciona

1. Al abrir la app por primera vez, se genera un ID aleatorio de 128 bits.
2. Antes del onboarding, la app muestra ese ID y permite compartirlo.
3. ARCANA confirma el pago y firma una licencia para ese ID con su clave privada Ed25519.
4. El cliente pega el código o escanea el QR.
5. La app verifica la firma con la clave pública incluida y comprueba que el ID coincida con su instalación.
6. Solo entonces guarda la licencia y habilita el onboarding. Vuelve a verificarla al iniciar y al regresar a primer plano, sin internet.

La app no contiene la clave privada ni consulta un servidor para activar. Una licencia alterada o correspondiente a otra instalación se rechaza.

## Emitir con la API privada

Abre `GET /licenses/issue` para mostrar el formulario de ARCANA. Solo ingresa el ID: el servidor utiliza `LICENSING_API_TOKEN` internamente; el secreto nunca se envía al navegador. La página muestra el código firmado y un QR PNG descargable.

El formulario y su endpoint `POST /api/licenses/issue/ui` están desactivados por defecto. Para habilitarlos, establece `LICENSING_UI_ENABLED=true` **solo después** de restringir el deployment con Vercel Deployment Protection o limitarlo a localhost/red administrativa. Sin esa protección, cualquier persona podría emitir licencias. El endpoint original `POST /api/licenses/issue` sigue requiriendo el encabezado `Authorization` con el token interno.

También se puede solicitar directamente por API después de confirmar manualmente el pago y verificar el ID:

```http
POST /api/licenses/issue
Authorization: Bearer <LICENSING_API_TOKEN>
Content-Type: application/json

{"installationId":"ID-COMPLETO-DEL-CLIENTE"}
```

El ID debe contener 32 dígitos hexadecimales; se aceptan guiones y espacios. La respuesta `201` incluye `data.license` y `data.qrDataUrl`; el formulario visual muestra ambas opciones para entregarlas al cliente. También funciona `POST /licenses/issue`.

La ruta no verifica compras: no la invoques hasta confirmar el pago por el proceso de ARCANA. Requiere un `LICENSING_API_TOKEN` de al menos 32 caracteres y queda deshabilitada si falta el secreto. No incorpores el token en una app cliente, en una URL ni en una página de acceso público.

## Generar una licencia sin asistencia

Desde una terminal en la carpeta del proyecto:

```powershell
cd D:\ARCANA\PRODUCTOS\mype-andale
npm run license:issue -- "ID-COMPLETO-DEL-CLIENTE"
```

Sustituye el ejemplo por el ID real mostrado en el teléfono. Acepta el ID con guiones; debe contener 32 dígitos hexadecimales.

El comando genera:

```text
private/licensing/issued/<ID>/licencia.txt
private/licensing/issued/<ID>/licencia.png
```

Envía el texto para que el cliente lo copie y pegue, o el PNG para que lo escanee desde otra pantalla o impreso. La emisión también funciona sin internet si las dependencias ya están instaladas.

**Antes de emitir:** confirma el pago y verifica el ID. El comando no cobra ni comprueba compras.

## Preparar otra computadora de ARCANA

1. Instala Node.js compatible con el proyecto y copia el código.
2. Ejecuta `npm ci` para instalar las dependencias; este paso necesita conexión si no están disponibles localmente.
3. Transfiere de forma privada la clave original a `private/licensing/arcna1.pem`.
4. Conserva `src/licensing/public-keys.json` de la misma app distribuida.
5. Ejecuta el comando de emisión con el ID del cliente.

La herramienta comprueba que la clave privada corresponda a la clave pública de la app.

## Claves: instrucciones importantes

- **Privada:** `private/licensing/arcna1.pem`. Solo ARCANA debe tenerla. Mantén una copia segura fuera de esta computadora.
- **Pública:** `src/licensing/public-keys.json`. Se incluye en la app y puede conservarse en el repositorio.
- `private/` está excluida de Git y EAS. No envíes esa carpeta al cliente.
- Las claves del proyecto **ya fueron creadas**. No las regeneres para vender nuevas licencias.
- `npm run license:init` se usa únicamente al iniciar una autoridad nueva, antes de distribuir su app. Se niega a sobrescribir claves existentes. Borrar las claves para inicializar de nuevo rompe la compatibilidad con las versiones ya entregadas.

## Operación manual actual

ARCANA puede recibir el ID, verificar la compra y emitir la licencia desde el formulario privado o con el generador CLI de la app. La ruta firma el código localmente con la clave configurada y devuelve el texto y QR de la licencia; no automatiza la venta ni guarda pedidos.

Mantén un registro privado de pedido, pago confirmado, ID de instalación, fecha de emisión y entrega. La integración automática con un proveedor de pagos todavía no está implementada.

## Si quieres emisión completamente automática

La automatización integral de pagos y entrega todavía no está implementada:

1. Recibir un pedido con el ID de instalación.
2. Confirmar el pago mediante una notificación autenticada del proveedor de pagos, verificando pedido, importe y moneda.
3. Registrar el pedido como pagado y evitar procesarlo dos veces.
4. Ejecutar el firmador en un equipo o servicio controlado por ARCANA. La clave privada nunca debe estar en la app ni en una página pública.
5. Generar el código y QR, vincularlos al pedido y entregarlos al comprador.
6. Registrar el resultado y reintentar entregas fallidas sin crear pedidos duplicados.

Automatizar la venta y entrega puede necesitar conexión en ese sistema de ARCANA. La validación de la licencia en el teléfono seguiría siendo local y offline.

## Reinstalación, respaldos y soporte

- Las actualizaciones normales conservan el ID.
- Desinstalar, borrar almacenamiento o cambiar de teléfono puede generar otro ID. Verifica la compra original y emite una licencia para el nuevo ID.
- Restaurar un respaldo del negocio no transfiere la licencia. Se guarda separada de la base de datos.
- El botón de vaciar datos de desarrollo conserva la activación.
- Una licencia antigua no puede revocarse remotamente mientras esa instalación permanece offline.
- En web se usa almacenamiento del navegador, con menor protección que en la app móvil.

## Comprobar una entrega

- Activar con el ID correcto y acceder al onboarding.
- Cerrar y abrir la app en modo avión: debe continuar activada.
- Probar un código alterado y una licencia de otro ID: deben rechazarse.
- Verificar que actualizar la app conserve la activación.

Para revisar el proyecto:

```powershell
npm test
npm run lint
npm run typecheck
```

## Archivos principales

| Archivo | Función |
|---|---|
| `scripts/license.mjs` | Crea las claves inicialmente y emite código y QR. |
| `src/licensing/protocol.js` | Comprueba formato, firma e ID. |
| `src/licensing/storage.js` | Conserva ID y licencia en el dispositivo. |
| `src/licensing/service.js` | Coordina la activación y las comprobaciones. |
| `src/providers/LicenseProvider.jsx` | Verifica al abrir y volver a primer plano. |
| `src/app/activation.jsx` | Pantalla previa al onboarding. |

La firma evita emitir licencias válidas sin la clave privada; no garantiza protección absoluta frente a una app modificada o un dispositivo comprometido.
