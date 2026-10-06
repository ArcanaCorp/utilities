import { crearApp } from './app.js';
import { cargarConfiguracion } from './config.js';

try {
  const config = cargarConfiguracion();
  const server = crearApp(config).listen(config.port, config.host, () => {
    console.log(`API disponible en http://${config.host}:${config.port}`);
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.on('error', error => {
    console.error(`No se pudo iniciar el servidor (${error.code ?? 'ERROR'}).`);
    process.exitCode = 1;
  });
  let cerrando = false;
  function cerrar() {
    if (cerrando) return;
    cerrando = true;
    const timeout = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 20000);
    timeout.unref();
    server.close(() => { clearTimeout(timeout); process.exitCode = 0; });
  }
  process.on('SIGINT', cerrar);
  process.on('SIGTERM', cerrar);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
