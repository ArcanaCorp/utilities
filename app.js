import express from 'express';
import { crearApp } from './src/app.js';
import { cargarConfiguracion } from './src/config.js';

// Vercel administra el servidor HTTP; este archivo solo exporta el handler.
const app = express();
app.disable('x-powered-by');
app.use(crearApp(cargarConfiguracion(process.env, { requireToken: false })));

export default app;
