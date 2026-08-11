const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const auth = require('../middleware/auth');

router.use(auth);

/**
 * GET /api/dashboard/kpis
 */
router.get('/kpis', async (req, res) => {
  try {
    const [socios, captacion, credito, caja] = await Promise.all([

      // Socios activos (PER.Person)
      query(`
        SELECT
          COUNT(*) AS TotalSocios,
          SUM(CASE WHEN CAST(p.CreationDate AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS NuevosHoy
        FROM PER.Person p
        WHERE p.Active = 1
      `).catch(() => ({ recordset: [{ TotalSocios: 0, NuevosHoy: 0 }] })),

      // Captación — saldo DISPONIBLE (AccountBalanceType_Id = 1)
      query(`
        SELECT
          ISNULL(SUM(ab.Balance), 0) AS TotalCaptacion,
          COUNT(DISTINCT a.Id)        AS CuentasActivas
        FROM FUR.Account a
        JOIN FUR.AccountBalance ab
          ON a.Id = ab.Account_Id
          AND ab.AccountBalanceType_Id = 1
        WHERE a.Status IN (1, 2, 3)
      `).catch(() => ({ recordset: [{ TotalCaptacion: 0, CuentasActivas: 0 }] })),

      // Cartera — State 7=Vigente, 6=Mora, 8=Liquidado
      query(`
        SELECT
          ISNULL(SUM(CASE WHEN lb.LoanBalanceType_Id IN (1,2) THEN lb.CurrentBalance ELSE 0 END), 0) AS CarteraTotal,
          COUNT(DISTINCT l.Id) AS CreditosActivos,
          ISNULL(SUM(CASE WHEN l.State = 6 AND lb.LoanBalanceType_Id = 2 THEN lb.CurrentBalance ELSE 0 END), 0) AS CarteraMorosa
        FROM LOA.Loan l
        JOIN LOA.LoanBalance lb ON l.Id = lb.Loan_Id
        WHERE l.State IN (7, 6)
          AND lb.LoanBalanceType_Id IN (1, 2)
      `).catch(() => ({ recordset: [{ CarteraTotal: 0, CreditosActivos: 0, CarteraMorosa: 0 }] })),

      // Caja hoy (TEL.CashierTransaction)
      query(`
        SELECT
          ISNULL(SUM(CASE WHEN ct.Amount > 0 THEN ct.Amount ELSE 0 END), 0) AS TotalIngresos,
          ISNULL(SUM(CASE WHEN ct.Amount < 0 THEN ABS(ct.Amount) ELSE 0 END), 0) AS TotalEgresos,
          COUNT(*) AS TotalOperaciones
        FROM TEL.CashierTransaction ct
        WHERE CAST(ct.[Date] AS DATE) = CAST(GETDATE() AS DATE)
          AND ct.Status = 1
      `).catch(() => ({ recordset: [{ TotalIngresos: 0, TotalEgresos: 0, TotalOperaciones: 0 }] })),
    ]);

    const s  = socios.recordset[0];
    const c  = captacion.recordset[0];
    const cr = credito.recordset[0];
    const ca = caja.recordset[0];

    const indiceMorosidad = cr.CarteraTotal > 0
      ? ((cr.CarteraMorosa / cr.CarteraTotal) * 100).toFixed(2)
      : '0.00';

    res.json({
      success: true,
      data: {
        socios:   { total: s.TotalSocios,        nuevosHoy: s.NuevosHoy },
        captacion:{ total: c.TotalCaptacion,      cuentasActivas: c.CuentasActivas },
        credito:  {
          carteraTotal:     cr.CarteraTotal,
          creditosActivos:  cr.CreditosActivos,
          carteraMorosa:    cr.CarteraMorosa,
          indiceMorosidad:  parseFloat(indiceMorosidad),
        },
        caja: {
          ingresos:   ca.TotalIngresos,
          egresos:    ca.TotalEgresos,
          operaciones: ca.TotalOperaciones,
        },
      },
    });
  } catch (err) {
    console.error('Error KPIs:', err);
    res.status(500).json({ success: false, message: 'Error al obtener KPIs', detail: err.message });
  }
});

/**
 * GET /api/dashboard/captacion-mensual
 * Movimientos de captación últimos 12 meses
 */
router.get('/captacion-mensual', async (req, res) => {
  try {
    const result = await query(`
      SELECT TOP 12
        FORMAT(at2.[Date], 'yyyy-MM')            AS Mes,
        FORMAT(at2.[Date], 'MMM yyyy', 'es-MX')  AS MesLabel,
        ISNULL(SUM(CASE WHEN at2.Amount > 0 THEN at2.Amount ELSE 0 END), 0) AS Depositos,
        ISNULL(SUM(CASE WHEN at2.Amount < 0 THEN ABS(at2.Amount) ELSE 0 END), 0) AS Retiros
      FROM FUR.AccountTransaction at2
      WHERE at2.[Date] >= DATEADD(MONTH, -12, GETDATE())
      GROUP BY
        FORMAT(at2.[Date], 'yyyy-MM'),
        FORMAT(at2.[Date], 'MMM yyyy', 'es-MX')
      ORDER BY Mes ASC
    `).catch(() => ({ recordset: [] }));

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error captación mensual' });
  }
});

/**
 * GET /api/dashboard/cartera-productos
 * Distribución de cartera por producto de crédito
 */
router.get('/cartera-productos', async (req, res) => {
  try {
    const result = await query(`
      SELECT TOP 8
        cp.Name                                     AS Producto,
        COUNT(DISTINCT cl.Id)                       AS Creditos,
        ISNULL(SUM(lb.CurrentBalance), 0)           AS Saldo
      FROM LOA.CreditLine cl
      JOIN LOA.CreditProduct cp   ON cl.CreditProduct_Id = cp.Id
      JOIN LOA.Loan l             ON cl.Id = l.CreditLine_Id
      JOIN LOA.LoanBalance lb     ON l.Id  = lb.Loan_Id
      JOIN LOA.LoanBalanceType lbt ON lb.LoanBalanceType_Id = lbt.Id
      WHERE l.State = 1
        AND lbt.SumBalance = 1
      GROUP BY cp.Name, cp.Id
      ORDER BY Saldo DESC
    `).catch(() => ({ recordset: [] }));

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error cartera por producto' });
  }
});

/**
 * GET /api/dashboard/alertas
 */
router.get('/alertas', async (req, res) => {
  try {
    const [vencimientos, morosidad, pld] = await Promise.all([

      // Próximos vencimientos (7 días)
      query(`
        SELECT TOP 5
          p.Id AS PersonaId,
          ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS Nombre,
          l.Id AS CreditoId,
          lpp.DueDate AS FechaVencimiento,
          lb.CurrentBalance AS Saldo
        FROM LOA.LoanPaymentPlan lpp
        JOIN LOA.Loan l             ON lpp.Loan_Id = l.Id
        JOIN PER.Person p           ON l.Person_Id = p.Id
        LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
        LEFT JOIN PER.CorporatePerson cp  ON p.Id = cp.PersonId
        JOIN LOA.LoanBalance lb     ON l.Id = lb.Loan_Id
        JOIN LOA.LoanBalanceType lbt ON lb.LoanBalanceType_Id = lbt.Id
        WHERE lpp.DueDate BETWEEN GETDATE() AND DATEADD(DAY, 7, GETDATE())
          AND lpp.Paid = 0
          AND l.State = 1
          AND lbt.SumBalance = 1
        ORDER BY lpp.DueDate ASC
      `).catch(() => ({ recordset: [] })),

      // Créditos en mora
      query(`
        SELECT TOP 5
          ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS Nombre,
          l.Id AS CreditoId,
          ld.DaysOverdue AS DiasVencidos,
          lb.CurrentBalance AS Saldo
        FROM LOA.LoanDelinquency ld
        JOIN LOA.Loan l              ON ld.LoanId = l.Id
        JOIN PER.Person p            ON l.Person_Id = p.Id
        LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
        LEFT JOIN PER.CorporatePerson cp  ON p.Id = cp.PersonId
        JOIN LOA.LoanBalance lb      ON l.Id = lb.Loan_Id
        JOIN LOA.LoanBalanceType lbt ON lb.LoanBalanceType_Id = lbt.Id
        WHERE ld.DaysOverdue > 0 AND l.State = 1 AND lbt.SumBalance = 1
        ORDER BY ld.DaysOverdue DESC
      `).catch(() => ({ recordset: [] })),

      // Alertas PLD
      query(`
        SELECT TOP 3 pa.Id, pa.Description, pa.CreatedAt, pa.Severity
        FROM SEC.PldAlert pa
        WHERE pa.CreatedAt >= DATEADD(DAY, -7, GETDATE())
        ORDER BY pa.CreatedAt DESC
      `).catch(() => ({ recordset: [] })),
    ]);

    res.json({
      success: true,
      data: {
        vencimientos: vencimientos.recordset,
        morosidad:    morosidad.recordset,
        pld:          pld.recordset,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error alertas' });
  }
});

/**
 * GET /api/dashboard/sucursales
 */
router.get('/sucursales', async (req, res) => {
  try {
    const result = await query(`
      SELECT TOP 10
        b.Name AS Sucursal,
        b.Id   AS SucursalId,
        COUNT(DISTINCT l.Id)              AS Creditos,
        ISNULL(SUM(lb.CurrentBalance), 0) AS Cartera
      FROM GEN.Branch b
      LEFT JOIN LOA.CreditLine cl ON b.Id = cl.Branch_Id AND cl.State = 1
      LEFT JOIN LOA.Loan l        ON cl.Id = l.CreditLine_Id AND l.State = 1
      LEFT JOIN LOA.LoanBalance lb ON l.Id = lb.Loan_Id
      LEFT JOIN LOA.LoanBalanceType lbt ON lb.LoanBalanceType_Id = lbt.Id AND lbt.SumBalance = 1
      WHERE b.Status = 1
      GROUP BY b.Name, b.Id
      ORDER BY Cartera DESC
    `).catch(() => ({ recordset: [] }));

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error sucursales' });
  }
});

module.exports = router;
