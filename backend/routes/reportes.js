const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const auth = require('../middleware/auth');

router.use(auth);

/**
 * GET /api/reportes/cnbv/r01 — Reporte R01 Captación CNBV
 */
router.get('/cnbv/r01', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        p.Name AS TipoProducto,
        COUNT(a.Id) AS TotalCuentas,
        ISNULL(SUM(ab.Balance), 0) AS SaldoTotal
      FROM FUR.Account a
      JOIN FUR.Product p ON a.Product_Id = p.Id
      JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
      WHERE a.Status IN (1, 2, 3)
      GROUP BY p.Name
      ORDER BY SaldoTotal DESC
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error reporte R01 CNBV' });
  }
});

/**
 * GET /api/reportes/cnbv/r02 — Reporte R02 Crédito CNBV
 */
router.get('/cnbv/r02', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        cp.Name AS TipoProductoCredito,
        COUNT(l.Id) AS TotalCreditos,
        ISNULL(SUM(lb.CurrentBalance), 0) AS SaldoCartera
      FROM LOA.CreditProduct cp
      JOIN LOA.CreditLine cl ON cp.Id = cl.CreditProduct_Id
      JOIN LOA.Loan l ON cl.Id = l.CreditLine_Id
      JOIN LOA.LoanBalance lb ON l.Id = lb.Loan_Id AND lb.LoanBalanceType_Id = 1
      WHERE l.State IN (7, 6)
      GROUP BY cp.Name
      ORDER BY SaldoCartera DESC
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error reporte R02 CNBV' });
  }
});

/**
 * GET /api/reportes/pld — Alertas y operaciones inusuales PLD
 */
router.get('/pld', async (req, res) => {
  try {
    const result = await query(`
      SELECT TOP 100
        pa.Id,
        pa.CreatedAt AS Fecha,
        pa.Description AS Descripcion,
        pa.Severity AS Gravedad
      FROM SEC.PldAlert pa
      ORDER BY pa.CreatedAt DESC
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error alertas PLD' });
  }
});

module.exports = router;
