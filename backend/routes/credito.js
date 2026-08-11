const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const auth = require('../middleware/auth');

router.use(auth);

/** GET /api/credito/productos — Listar productos de crédito activos */
router.get('/productos', async (req, res) => {
  try {
    const result = await query(`
      SELECT Id, Name AS Nombre
      FROM LOA.CreditProduct
      WHERE Name NOT LIKE '%INACTIVO%' AND Name NOT LIKE '%EXTINTOS%'
      ORDER BY Name ASC
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error productos', detail: err.message });
  }
});

/** GET /api/credito?page=1&limit=20&search=&status=all */
router.get('/', async (req, res) => {
  const { page = 1, limit = 20, search = '', status = 'all' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const result = await query(`
      SELECT
        l.Id AS CreditoId,
        l.FriendlyCode AS Folio,
        ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS Socio,
        p.FriendlyCode AS NumSocio,
        pr.Name AS Producto,
        lb.CurrentBalance AS SaldoCapital,
        l.OriginalPrincipalBalance AS MontoOriginal,
        l.State AS Estado,
        l.OriginationDate AS FechaOtorgamiento,
        l.MaturityDate AS FechaVencimiento,
        l.NextDueDay AS ProximoPago,
        COUNT(*) OVER() AS TotalRegistros
      FROM LOA.Loan l
      LEFT JOIN LOA.CreditLine cl ON l.CreditLine_Id = cl.Id
      LEFT JOIN LOA.CreditProduct pr ON cl.CreditProduct_Id = pr.Id
      JOIN PER.Person p ON l.Person_Id = p.Id
      LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
      LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
      JOIN LOA.LoanBalance lb ON l.Id = lb.Loan_Id AND lb.LoanBalanceType_Id = 1
      WHERE
        (@status = 'all' OR
         (@status = 'active' AND l.State IN (7, 6)) OR
         (@status = 'closed' AND l.State = 2) OR
         (@status = 'mora' AND lb.CurrentBalance > 0 AND l.State = 6))
        AND (@search = '' OR
             ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) LIKE @searchLike OR
             l.FriendlyCode LIKE @searchLike OR
             p.FriendlyCode LIKE @searchLike)
      ORDER BY l.OriginationDate DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `, [
      { name: 'offset', type: sql.Int, value: offset },
      { name: 'limit', type: sql.Int, value: parseInt(limit) },
      { name: 'status', type: sql.NVarChar(20), value: status },
      { name: 'search', type: sql.NVarChar(100), value: search },
      { name: 'searchLike', type: sql.NVarChar(100), value: `%${search}%` },
    ]);

    const total = result.recordset[0]?.TotalRegistros || 0;
    res.json({
      success: true,
      data: result.recordset,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    console.error('Error cartera:', err);
    res.status(500).json({ success: false, message: 'Error al obtener cartera', detail: err.message });
  }
});

/** GET /api/credito/:id — Detalle de crédito */
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [credito, balances, amortizacion] = await Promise.all([
      query(`
        SELECT
          l.Id, l.FriendlyCode, l.State, l.OriginationDate, l.MaturityDate,
          l.OriginalPrincipalBalance AS MontoOriginal,
          l.InterestRateValue AS Tasa, l.Periods, l.Frequency_Id AS Frecuencia,
          l.NextDueDay, l.LastPaymentDate, l.LastPaymentAmount,
          ISNULL(pr.Name, 'CRÉDITO PERSONAL') AS Producto,
          ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS Socio,
          p.FriendlyCode AS NumSocio
        FROM LOA.Loan l
        LEFT JOIN LOA.CreditLine cl ON l.CreditLine_Id = cl.Id
        LEFT JOIN LOA.CreditProduct pr ON cl.CreditProduct_Id = pr.Id
        JOIN PER.Person p ON l.Person_Id = p.Id
        LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
        LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
        WHERE l.Id = @id
      `, [{ name: 'id', type: sql.BigInt, value: id }]),

      query(`
        SELECT lb.CurrentBalance, lb.InitialBalance, lb.Paid, lbt.Name AS Concepto
        FROM LOA.LoanBalance lb
        JOIN LOA.LoanBalanceType lbt ON lb.LoanBalanceType_Id = lbt.Id
        WHERE lb.Loan_Id = @id AND lbt.SumBalance = 1
        ORDER BY lbt.[Order]
      `, [{ name: 'id', type: sql.BigInt, value: id }]),

      query(`
        SELECT TOP 36
          lpp.Number AS NoPago,
          lpp.DueDate AS FechaVencimiento,
          lpp.Principal AS Capital,
          lpp.Interest AS Interes,
          lpp.Total AS PagoTotal,
          lpp.Paid,
          lpp.PaymentDate AS FechaPago
        FROM LOA.LoanPaymentPlan lpp
        WHERE lpp.Loan_Id = @id
        ORDER BY lpp.Number ASC
      `, [{ name: 'id', type: sql.BigInt, value: id }]).catch(() => ({ recordset: [] })),
    ]);

    if (!credito.recordset.length) {
      return res.status(404).json({ success: false, message: 'Crédito no encontrado' });
    }

    res.json({
      success: true,
      data: {
        credito: credito.recordset[0],
        balances: balances.recordset,
        amortizacion: amortizacion.recordset,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error al obtener crédito', detail: err.message });
  }
});

/** POST /api/credito/abono — Registrar abono a crédito */
router.post('/abono', async (req, res) => {
  const { creditoId, monto, concepto = 'ABONO A CAPITAL' } = req.body;
  const numMonto = parseFloat(monto);

  if (!creditoId || isNaN(numMonto) || numMonto <= 0) {
    return res.status(400).json({ success: false, message: 'ID de crédito y monto válido son requeridos' });
  }

  try {
    // 1. Verificar saldo actual
    const check = await query(`
      SELECT CurrentBalance, Paid FROM LOA.LoanBalance
      WHERE Loan_Id = @creditoId AND LoanBalanceType_Id = 1
    `, [{ name: 'creditoId', type: sql.BigInt, value: creditoId }]);

    if (!check.recordset.length) {
      return res.status(404).json({ success: false, message: 'Balance de crédito no encontrado' });
    }

    const saldoActual = parseFloat(check.recordset[0].CurrentBalance);
    const pagadoActual = parseFloat(check.recordset[0].Paid || 0);

    const nuevoSaldo = Math.max(0, saldoActual - numMonto);
    const nuevoPagado = pagadoActual + numMonto;

    // 2. Actualizar saldo capital
    await query(`
      UPDATE LOA.LoanBalance
      SET CurrentBalance = @nuevoSaldo, Paid = @nuevoPagado, LastTransactionDate = GETDATE()
      WHERE Loan_Id = @creditoId AND LoanBalanceType_Id = 1
    `, [
      { name: 'nuevoSaldo', type: sql.Money, value: nuevoSaldo },
      { name: 'nuevoPagado', type: sql.Money, value: nuevoPagado },
      { name: 'creditoId', type: sql.BigInt, value: creditoId },
    ]);

    // 3. Actualizar fecha y monto del último pago en LOA.Loan
    const nuevoEstado = nuevoSaldo === 0 ? 8 : undefined; // 8 = Liquidado
    if (nuevoEstado) {
      await query(`
        UPDATE LOA.Loan
        SET State = 8, LastPaymentDate = GETDATE(), LastPaymentAmount = @monto
        WHERE Id = @creditoId
      `, [
        { name: 'monto', type: sql.Money, value: numMonto },
        { name: 'creditoId', type: sql.BigInt, value: creditoId },
      ]);
    } else {
      await query(`
        UPDATE LOA.Loan
        SET LastPaymentDate = GETDATE(), LastPaymentAmount = @monto
        WHERE Id = @creditoId
      `, [
        { name: 'monto', type: sql.Money, value: numMonto },
        { name: 'creditoId', type: sql.BigInt, value: creditoId },
      ]);
    }

    res.json({
      success: true,
      message: `Abono de $${numMonto.toLocaleString('es-MX', { minimumFractionDigits: 2 })} registrado exitosamente`,
      nuevoSaldo,
      liquidado: nuevoSaldo === 0,
    });

  } catch (err) {
    console.error('Error abono:', err);
    res.status(500).json({ success: false, message: 'Error al procesar el abono', detail: err.message });
  }
});

/** POST /api/credito/solicitud — Crear nueva solicitud de crédito */
router.post('/solicitud', async (req, res) => {
  const { numSocio, productoId = 1, monto, plazoMeses = 12, tasaAnual = 18 } = req.body;
  const numMonto = parseFloat(monto);

  if (!numSocio || isNaN(numMonto) || numMonto <= 0) {
    return res.status(400).json({ success: false, message: 'Socio y monto válido son requeridos' });
  }

  try {
    // 1. Obtener ID de persona
    const socioRes = await query(`
      SELECT Id FROM PER.Person WHERE FriendlyCode = @numSocio
    `, [{ name: 'numSocio', type: sql.NVarChar(50), value: numSocio }]);

    if (!socioRes.recordset.length) {
      return res.status(404).json({ success: false, message: `Socio con número ${numSocio} no encontrado` });
    }
    const personId = socioRes.recordset[0].Id;

    // 2. Generar Folio
    const folio = `SOL-${Date.now().toString().slice(-6)}`;

    // 3. Crear Loan
    const insertLoan = await query(`
      INSERT INTO LOA.Loan (
        FriendlyCode, State, OriginationDate, DisbursementDate, MaturityDate, NextDueDay,
        OriginalPrincipalBalance, InterestRateValue, Periods, Person_Id, CreditLine_Id,
        QuotaType, GracePeriodType, PeriodPrincipalFrequency, Version
      )
      OUTPUT INSERTED.Id
      VALUES (
        @folio, 7, GETDATE(), GETDATE(), DATEADD(MONTH, @plazo, GETDATE()), DATEADD(MONTH, 1, GETDATE()),
        @monto, @tasa, @plazo, @personId, 1,
        1, 0, 1, 0x000000000159AAAA
      )
    `, [
      { name: 'folio', type: sql.NVarChar(50), value: folio },
      { name: 'monto', type: sql.Money, value: numMonto },
      { name: 'tasa', type: sql.Decimal(18,4), value: parseFloat(tasaAnual) },
      { name: 'plazo', type: sql.Int, value: parseInt(plazoMeses) },
      { name: 'personId', type: sql.BigInt, value: personId },
    ]);

    const loanId = insertLoan.recordset[0].Id;

    // 4. Crear LoanBalance para Capital
    await query(`
      INSERT INTO LOA.LoanBalance (Loan_Id, LoanBalanceType_Id, CurrentBalance, InitialBalance, InitialBalanceDate, Paid)
      VALUES (@loanId, 1, @monto, @monto, GETDATE(), 0)
    `, [
      { name: 'loanId', type: sql.BigInt, value: loanId },
      { name: 'monto', type: sql.Money, value: numMonto },
    ]);

    res.json({
      success: true,
      message: `Solicitud de crédito ${folio} registrada y activada exitosamente`,
      creditoId: loanId,
      folio,
    });

  } catch (err) {
    console.error('Error solicitud crédito:', err);
    res.status(500).json({ success: false, message: 'Error al registrar solicitud de crédito', detail: err.message });
  }
});

module.exports = router;
