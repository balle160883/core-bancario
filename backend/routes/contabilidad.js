const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const auth = require('../middleware/auth');

router.use(auth);

/**
 * GET /api/contabilidad/catalogo — Catálogo de cuentas contables
 */
router.get('/catalogo', async (req, res) => {
  try {
    const result = await query(`
      SELECT TOP 200
        la.Id,
        la.Code AS Cuenta,
        la.Name AS Nombre,
        la.Level AS Nivel,
        la.Type AS Tipo,
        la.Status AS Estado
      FROM ACC.LedgerAccount la
      WHERE la.Status = 1
      ORDER BY la.Code ASC
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Error catálogo:', err);
    res.status(500).json({ success: false, message: 'Error al obtener catálogo de cuentas', detail: err.message });
  }
});

/**
 * GET /api/contabilidad/polizas — Polizas contables / Pólizas
 */
router.get('/polizas', async (req, res) => {
  try {
    const result = await query(`
      SELECT TOP 100
        j.Id,
        j.[Date] AS Fecha,
        j.Description AS Concepto,
        j.Policy AS NumPoliza,
        j.Type AS TipoPoliza,
        b.Name AS Sucursal,
        u.UserName AS Usuario
      FROM ACC.Journal j
      LEFT JOIN GEN.Branch b ON j.Branch_Id = b.Id
      LEFT JOIN SEC.[User] u ON j.User_Id = u.Id
      ORDER BY j.[Date] DESC
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Error pólizas:', err);
    res.status(500).json({ success: false, message: 'Error al obtener pólizas contables', detail: err.message });
  }
});

module.exports = router;
