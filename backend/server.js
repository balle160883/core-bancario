require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware de seguridad ──────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Para servir el frontend desde Express
}));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ── Servir el frontend estático ───────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

// ── API Routes ────────────────────────────────────────────────────────
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/dashboard',   require('./routes/dashboard'));
app.use('/api/socios',      require('./routes/socios'));
app.use('/api/captacion',   require('./routes/captacion'));
app.use('/api/credito',     require('./routes/credito'));
app.use('/api/originacion', require('./routes/originacion'));
app.use('/api/inversiones', require('./routes/inversiones'));
app.use('/api/mobile',      require('./routes/mobile'));
app.use('/api/caja',        require('./routes/caja'));
app.use('/api/contabilidad', require('./routes/contabilidad'));
app.use('/api/seguridad',   require('./routes/seguridad'));
app.use('/api/reportes',    require('./routes/reportes'));
app.use('/api/copilot',     require('./routes/copilot'));
app.use('/api/pld-ml',      require('./routes/pld-ml'));
app.use('/api/cooperativa', require('./routes/cooperativa'));

// ── Health check ──────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'Core Bancario SIF',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// ── SPA fallback: redirigir todo lo no-api al frontend ───────────────
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
  } else {
    next();
  }
});

// ── Manejador de errores global ───────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Error global:', err.stack);
  res.status(500).json({ success: false, message: 'Error interno del servidor', error: err.message });
});

// ── Iniciar servidor ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║        CORE BANCARIO — CAJAS POPULARES          ║');
  console.log('║         Sistema de Información Financiero        ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  🚀 Servidor corriendo en http://localhost:${PORT}   ║`);
  console.log(`║  🗄️  BD: SIF @ 172.28.5.231                      ║`);
  console.log(`║  ⏰  ${new Date().toLocaleString('es-MX')}                ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});

module.exports = app;
