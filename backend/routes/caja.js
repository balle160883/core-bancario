const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const auth = require('../middleware/auth');

router.use(auth);

/**
 * GET /api/caja — Estado de cajeros y operaciones de ventanilla
 */
router.get('/', async (req, res) => {
  try {
    const [cajeros, ultimosMovs] = await Promise.all([
      query(`
        SELECT TOP 20
          c.Id,
          c.OpeningDate AS FechaApertura,
          c.InitialBalance AS SaldoInicial,
          c.FinalBalance AS SaldoFinal,
          c.Status AS Estado,
          b.Name AS Sucursal,
          u.UserName AS Cajero
        FROM TEL.Cashier c
        LEFT JOIN GEN.Branch b ON c.Branch_Id = b.Id
        LEFT JOIN SEC.[User] u ON c.User_Id = u.Id
        ORDER BY c.OpeningDate DESC
      `),
      query(`
        SELECT TOP 50
          ct.Id,
          ct.[Date] AS Fecha,
          ct.Amount AS Monto,
          ct.Status,
          b.Name AS Sucursal,
          u.UserName AS Usuario
        FROM TEL.CashierTransaction ct
        LEFT JOIN GEN.Branch b ON ct.Branch_Id = b.Id
        LEFT JOIN SEC.[User] u ON ct.User_Id = u.Id
        ORDER BY ct.[Date] DESC
      `),
    ]);

    res.json({
      success: true,
      data: {
        cajeros: cajeros.recordset,
        movimientos: ultimosMovs.recordset,
      },
    });
  } catch (err) {
    console.error('Error caja:', err);
    res.status(500).json({ success: false, message: 'Error al obtener datos de caja', detail: err.message });
  }
});

/**
 * POST /api/caja/deposito — Procesar depósito a cuenta de captación
 */
router.post('/deposito', async (req, res) => {
  const { cuentaId, monto, concepto = 'DEPÓSITO EN VENTANILLA' } = req.body;
  const numMonto = parseFloat(monto);
  const userId = req.user.id;
  const branchId = req.user.branchId || 1;

  if (!cuentaId || !numMonto || numMonto <= 0) {
    return res.status(400).json({ success: false, message: 'Cuenta y monto válido son requeridos' });
  }

  try {
    const cuentaRes = await query(`
      SELECT TOP 1
        a.Id AS CuentaId, a.FriendlyCode AS NumCuenta,
        fp.Name AS Producto,
        ab.Id AS AccountBalanceId, ab.Balance AS SaldoActual,
        p.Id AS SocioId,
        ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS NombreSocio,
        p.FriendlyCode AS NumSocio
      FROM FUR.Account a
      JOIN FUR.Product fp ON a.Product_Id = fp.Id
      JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
      LEFT JOIN FUR.Holder h ON a.Id = h.AccountId
      LEFT JOIN PER.Person p ON h.PersonId = p.Id
      LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
      LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
      WHERE a.Id = @cuentaId OR a.FriendlyCode = @cuentaCode
    `, [
      { name: 'cuentaId', type: sql.BigInt, value: parseInt(cuentaId) || 0 },
      { name: 'cuentaCode', type: sql.NVarChar(50), value: cuentaId.toString() }
    ]);

    if (!cuentaRes.recordset.length) {
      return res.status(404).json({ success: false, message: 'Cuenta de ahorro no encontrada' });
    }

    const c = cuentaRes.recordset[0];
    const nuevoSaldo = parseFloat(c.SaldoActual) + numMonto;

    await query(`
      UPDATE FUR.AccountBalance
      SET Balance = Balance + @monto
      WHERE Id = @balanceId
    `, [
      { name: 'monto', type: sql.Money, value: numMonto },
      { name: 'balanceId', type: sql.BigInt, value: c.AccountBalanceId }
    ]);

    const refStr = `DEP-${Date.now().toString().slice(-6)}`;
    const atRes = await query(`
      INSERT INTO FUR.AccountTransaction (
        Amount, Description, Reference, Status, [Date],
        TransactionType_Id, Branch_Id, Account_Id, AccountBalance_Id, User_Id
      )
      OUTPUT INSERTED.Id
      VALUES (
        @monto, @desc, @ref, 1, GETDATE(),
        122, @branchId, @cuentaId, @balanceId, @userId
      )
    `, [
      { name: 'monto', type: sql.Money, value: numMonto },
      { name: 'desc', type: sql.NVarChar(250), value: concepto },
      { name: 'ref', type: sql.NVarChar(100), value: refStr },
      { name: 'branchId', type: sql.Int, value: branchId },
      { name: 'cuentaId', type: sql.BigInt, value: c.CuentaId },
      { name: 'balanceId', type: sql.BigInt, value: c.AccountBalanceId },
      { name: 'userId', type: sql.BigInt, value: userId }
    ]);

    const txId = atRes.recordset[0]?.Id;

    await query(`
      INSERT INTO TEL.CashierTransaction (
        [Date], Status, Amount, Branch_Id, Currency_Id, User_Id
      )
      VALUES (GETDATE(), 1, @monto, @branchId, 1, @userId)
    `, [
      { name: 'monto', type: sql.Money, value: numMonto },
      { name: 'branchId', type: sql.Int, value: branchId },
      { name: 'userId', type: sql.BigInt, value: userId }
    ]).catch(() => {});

    res.json({
      success: true,
      message: 'Depósito procesado exitosamente',
      recibo: {
        folioTransaccion: txId || refStr,
        tipoOperacion: 'DEPÓSITO A CUENTA DE AHORRO',
        numCuenta: c.NumCuenta || c.CuentaId,
        producto: c.Producto,
        socio: c.NombreSocio,
        numSocio: c.NumSocio,
        monto: numMonto,
        saldoAnterior: parseFloat(c.SaldoActual),
        nuevoSaldo: nuevoSaldo,
        fecha: new Date().toISOString(),
        cajero: req.user.username,
        referencia: refStr,
      }
    });

  } catch (err) {
    console.error('Error depósito:', err);
    res.status(500).json({ success: false, message: 'Error al procesar depósito', detail: err.message });
  }
});

/**
 * POST /api/caja/retiro — Procesar retiro de cuenta de captación
 */
router.post('/retiro', async (req, res) => {
  const { cuentaId, monto, concepto = 'RETIRO EN VENTANILLA' } = req.body;
  const numMonto = parseFloat(monto);
  const userId = req.user.id;
  const branchId = req.user.branchId || 1;

  if (!cuentaId || !numMonto || numMonto <= 0) {
    return res.status(400).json({ success: false, message: 'Cuenta y monto válido son requeridos' });
  }

  try {
    const cuentaRes = await query(`
      SELECT TOP 1
        a.Id AS CuentaId, a.FriendlyCode AS NumCuenta,
        fp.Name AS Producto,
        ab.Id AS AccountBalanceId, ab.Balance AS SaldoActual,
        p.Id AS SocioId,
        ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS NombreSocio,
        p.FriendlyCode AS NumSocio
      FROM FUR.Account a
      JOIN FUR.Product fp ON a.Product_Id = fp.Id
      JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
      LEFT JOIN FUR.Holder h ON a.Id = h.AccountId
      LEFT JOIN PER.Person p ON h.PersonId = p.Id
      LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
      LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
      WHERE a.Id = @cuentaId OR a.FriendlyCode = @cuentaCode
    `, [
      { name: 'cuentaId', type: sql.BigInt, value: parseInt(cuentaId) || 0 },
      { name: 'cuentaCode', type: sql.NVarChar(50), value: cuentaId.toString() }
    ]);

    if (!cuentaRes.recordset.length) {
      return res.status(404).json({ success: false, message: 'Cuenta no encontrada' });
    }

    const c = cuentaRes.recordset[0];
    const saldoActual = parseFloat(c.SaldoActual);

    if (saldoActual < numMonto) {
      return res.status(400).json({
        success: false,
        message: `Saldo insuficiente. Saldo disponible: $${saldoActual.toLocaleString('es-MX', {minimumFractionDigits:2})}`
      });
    }

    const nuevoSaldo = saldoActual - numMonto;

    await query(`
      UPDATE FUR.AccountBalance
      SET Balance = Balance - @monto
      WHERE Id = @balanceId
    `, [
      { name: 'monto', type: sql.Money, value: numMonto },
      { name: 'balanceId', type: sql.BigInt, value: c.AccountBalanceId }
    ]);

    const refStr = `RET-${Date.now().toString().slice(-6)}`;
    const atRes = await query(`
      INSERT INTO FUR.AccountTransaction (
        Amount, Description, Reference, Status, [Date],
        TransactionType_Id, Branch_Id, Account_Id, AccountBalance_Id, User_Id
      )
      OUTPUT INSERTED.Id
      VALUES (
        @monto, @desc, @ref, 1, GETDATE(),
        123, @branchId, @cuentaId, @balanceId, @userId
      )
    `, [
      { name: 'monto', type: sql.Money, value: -numMonto },
      { name: 'desc', type: sql.NVarChar(250), value: concepto },
      { name: 'ref', type: sql.NVarChar(100), value: refStr },
      { name: 'branchId', type: sql.Int, value: branchId },
      { name: 'cuentaId', type: sql.BigInt, value: c.CuentaId },
      { name: 'balanceId', type: sql.BigInt, value: c.AccountBalanceId },
      { name: 'userId', type: sql.BigInt, value: userId }
    ]);

    const txId = atRes.recordset[0]?.Id;

    await query(`
      INSERT INTO TEL.CashierTransaction (
        [Date], Status, Amount, Branch_Id, Currency_Id, User_Id
      )
      VALUES (GETDATE(), 1, @monto, @branchId, 1, @userId)
    `, [
      { name: 'monto', type: sql.Money, value: -numMonto },
      { name: 'branchId', type: sql.Int, value: branchId },
      { name: 'userId', type: sql.BigInt, value: userId }
    ]).catch(() => {});

    res.json({
      success: true,
      message: 'Retiro procesado exitosamente',
      recibo: {
        folioTransaccion: txId || refStr,
        tipoOperacion: 'RETIRO DE CUENTA DE AHORRO',
        numCuenta: c.NumCuenta || c.CuentaId,
        producto: c.Producto,
        socio: c.NombreSocio,
        numSocio: c.NumSocio,
        monto: numMonto,
        saldoAnterior: saldoActual,
        nuevoSaldo: nuevoSaldo,
        fecha: new Date().toISOString(),
        cajero: req.user.username,
        referencia: refStr,
      }
    });

  } catch (err) {
    console.error('Error retiro:', err);
    res.status(500).json({ success: false, message: 'Error al procesar retiro', detail: err.message });
  }
});

/**
 * POST /api/caja/pago-credito — Procesar abono a crédito
 */
router.post('/pago-credito', async (req, res) => {
  const { creditoId, monto } = req.body;
  const numMonto = parseFloat(monto);
  const userId = req.user.id;
  const branchId = req.user.branchId || 1;

  if (!creditoId || !numMonto || numMonto <= 0) {
    return res.status(400).json({ success: false, message: 'Crédito y monto son requeridos' });
  }

  try {
    const credRes = await query(`
      SELECT TOP 1
        l.Id AS CreditoId, l.FriendlyCode AS Folio,
        cp.Name AS Producto,
        lb.CurrentBalance AS SaldoActual, lb.Id AS LoanBalanceId,
        p.Id AS SocioId,
        ISNULL(ip.Name + ' ' + ip.Surname, corp.Name) AS NombreSocio,
        p.FriendlyCode AS NumSocio
      FROM LOA.Loan l
      LEFT JOIN LOA.CreditLine cl ON l.CreditLine_Id = cl.Id
      LEFT JOIN LOA.CreditProduct cp ON cl.CreditProduct_Id = cp.Id
      JOIN LOA.LoanBalance lb ON l.Id = lb.Loan_Id AND lb.LoanBalanceType_Id = 1
      JOIN PER.Person p ON l.Person_Id = p.Id
      LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
      LEFT JOIN PER.CorporatePerson corp ON p.Id = corp.PersonId
      WHERE l.Id = @creditoId OR l.FriendlyCode = @creditoCode
    `, [
      { name: 'creditoId', type: sql.BigInt, value: parseInt(creditoId) || 0 },
      { name: 'creditoCode', type: sql.NVarChar(50), value: creditoId.toString() }
    ]);

    if (!credRes.recordset.length) {
      return res.status(404).json({ success: false, message: 'Crédito no encontrado' });
    }

    const c = credRes.recordset[0];
    const saldoActual = parseFloat(c.SaldoActual);
    const nuevoSaldo = Math.max(0, saldoActual - numMonto);

    await query(`
      UPDATE LOA.LoanBalance
      SET CurrentBalance = CASE WHEN CurrentBalance - @monto < 0 THEN 0 ELSE CurrentBalance - @monto END,
          Paid = Paid + @monto
      WHERE Id = @balanceId
    `, [
      { name: 'monto', type: sql.Money, value: numMonto },
      { name: 'balanceId', type: sql.BigInt, value: c.LoanBalanceId }
    ]);

    if (nuevoSaldo === 0) {
      await query(`UPDATE LOA.Loan SET State = 8 WHERE Id = @creditoId`, [
        { name: 'creditoId', type: sql.BigInt, value: c.CreditoId }
      ]);
    }

    const refStr = `PAG-${Date.now().toString().slice(-6)}`;

    await query(`
      INSERT INTO TEL.CashierTransaction (
        [Date], Status, Amount, Branch_Id, Currency_Id, User_Id
      )
      VALUES (GETDATE(), 1, @monto, @branchId, 1, @userId)
    `, [
      { name: 'monto', type: sql.Money, value: numMonto },
      { name: 'branchId', type: sql.Int, value: branchId },
      { name: 'userId', type: sql.BigInt, value: userId }
    ]).catch(() => {});

    res.json({
      success: true,
      message: 'Pago de crédito procesado exitosamente',
      recibo: {
        folioTransaccion: refStr,
        tipoOperacion: 'ABONO A PRÉSTAMO / CRÉDITO',
        numCuenta: c.Folio || c.CreditoId,
        producto: c.Producto,
        socio: c.NombreSocio,
        numSocio: c.NumSocio,
        monto: numMonto,
        saldoAnterior: saldoActual,
        nuevoSaldo: nuevoSaldo,
        fecha: new Date().toISOString(),
        cajero: req.user.username,
        referencia: refStr,
      }
    });

  } catch (err) {
    console.error('Error pago crédito:', err);
    res.status(500).json({ success: false, message: 'Error al procesar pago de crédito', detail: err.message });
  }
});

/**
 * POST /api/caja/sincronizar-offline — Sincronizar lote de transacciones offline
 * Permite resiliencia en zonas rurales cuando regresa el internet sin duplicar folios ni interrumpir ventanilla.
 */
router.post('/sincronizar-offline', async (req, res) => {
  const { operaciones } = req.body;

  if (!operaciones || !Array.isArray(operaciones) || !operaciones.length) {
    return res.status(400).json({ success: false, message: 'No hay operaciones para sincronizar' });
  }

  const userId = req.user.id;
  const branchId = req.user.branchId || 1;
  const resultados = [];
  let exitosas = 0;
  let fallidas = 0;

  for (const op of operaciones) {
    const { uuid, tipo, cuentaId, creditoId, monto, concepto, offlineTimestamp, offlineFolio } = op;
    const numMonto = parseFloat(monto);

    if (!numMonto || numMonto <= 0) {
      resultados.push({ uuid, success: false, message: 'Monto inválido' });
      fallidas++;
      continue;
    }

    try {
      if (tipo === 'deposito') {
        const cuentaRes = await query(`
          SELECT TOP 1 a.Id AS CuentaId, a.FriendlyCode AS NumCuenta, fp.Name AS Producto, ab.Id AS AccountBalanceId, ab.Balance AS SaldoActual, ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS NombreSocio, p.FriendlyCode AS NumSocio
          FROM FUR.Account a
          JOIN FUR.Product fp ON a.Product_Id = fp.Id
          JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
          LEFT JOIN FUR.Holder h ON a.Id = h.AccountId
          LEFT JOIN PER.Person p ON h.PersonId = p.Id
          LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
          LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
          WHERE a.Id = @cuentaId OR a.FriendlyCode = @cuentaCode
        `, [
          { name: 'cuentaId', type: sql.BigInt, value: parseInt(cuentaId) || 0 },
          { name: 'cuentaCode', type: sql.NVarChar(50), value: (cuentaId || '').toString() }
        ]);

        if (!cuentaRes.recordset.length) {
          resultados.push({ uuid, success: false, message: 'Cuenta no encontrada' });
          fallidas++;
          continue;
        }

        const c = cuentaRes.recordset[0];
        const nuevoSaldo = parseFloat(c.SaldoActual) + numMonto;

        await query(`UPDATE FUR.AccountBalance SET Balance = Balance + @monto WHERE Id = @balanceId`, [
          { name: 'monto', type: sql.Money, value: numMonto },
          { name: 'balanceId', type: sql.BigInt, value: c.AccountBalanceId }
        ]);

        const refStr = `OFFLINE-DEP-${offlineFolio || Date.now().toString().slice(-6)}`;
        const atRes = await query(`
          INSERT INTO FUR.AccountTransaction (
            Amount, Description, Reference, Status, [Date],
            TransactionType_Id, Branch_Id, Account_Id, AccountBalance_Id, User_Id
          ) OUTPUT INSERTED.Id
          VALUES (@monto, @desc, @ref, 1, @date, 122, @branchId, @cuentaId, @balanceId, @userId)
        `, [
          { name: 'monto', type: sql.Money, value: numMonto },
          { name: 'desc', type: sql.NVarChar(250), value: (concepto || 'DEPÓSITO OFFLINE VENTANILLA') + ' [SINCRONIZADO]' },
          { name: 'ref', type: sql.NVarChar(100), value: refStr },
          { name: 'date', type: sql.DateTime, value: offlineTimestamp ? new Date(offlineTimestamp) : new Date() },
          { name: 'branchId', type: sql.Int, value: branchId },
          { name: 'cuentaId', type: sql.BigInt, value: c.CuentaId },
          { name: 'balanceId', type: sql.BigInt, value: c.AccountBalanceId },
          { name: 'userId', type: sql.BigInt, value: userId }
        ]);

        resultados.push({
          uuid,
          success: true,
          folioOficial: atRes.recordset[0]?.Id || refStr,
          nuevoSaldo,
        });
        exitosas++;

      } else if (tipo === 'retiro') {
        const cuentaRes = await query(`
          SELECT TOP 1 a.Id AS CuentaId, a.FriendlyCode AS NumCuenta, fp.Name AS Producto, ab.Id AS AccountBalanceId, ab.Balance AS SaldoActual, ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS NombreSocio, p.FriendlyCode AS NumSocio
          FROM FUR.Account a
          JOIN FUR.Product fp ON a.Product_Id = fp.Id
          JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
          LEFT JOIN FUR.Holder h ON a.Id = h.AccountId
          LEFT JOIN PER.Person p ON h.PersonId = p.Id
          LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
          LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
          WHERE a.Id = @cuentaId OR a.FriendlyCode = @cuentaCode
        `, [
          { name: 'cuentaId', type: sql.BigInt, value: parseInt(cuentaId) || 0 },
          { name: 'cuentaCode', type: sql.NVarChar(50), value: (cuentaId || '').toString() }
        ]);

        if (!cuentaRes.recordset.length) {
          resultados.push({ uuid, success: false, message: 'Cuenta no encontrada' });
          fallidas++;
          continue;
        }

        const c = cuentaRes.recordset[0];
        const saldoActual = parseFloat(c.SaldoActual);
        const nuevoSaldo = Math.max(0, saldoActual - numMonto);

        await query(`UPDATE FUR.AccountBalance SET Balance = Balance - @monto WHERE Id = @balanceId`, [
          { name: 'monto', type: sql.Money, value: numMonto },
          { name: 'balanceId', type: sql.BigInt, value: c.AccountBalanceId }
        ]);

        const refStr = `OFFLINE-RET-${offlineFolio || Date.now().toString().slice(-6)}`;
        const atRes = await query(`
          INSERT INTO FUR.AccountTransaction (
            Amount, Description, Reference, Status, [Date],
            TransactionType_Id, Branch_Id, Account_Id, AccountBalance_Id, User_Id
          ) OUTPUT INSERTED.Id
          VALUES (@monto, @desc, @ref, 1, @date, 123, @branchId, @cuentaId, @balanceId, @userId)
        `, [
          { name: 'monto', type: sql.Money, value: -numMonto },
          { name: 'desc', type: sql.NVarChar(250), value: (concepto || 'RETIRO OFFLINE VENTANILLA') + ' [SINCRONIZADO]' },
          { name: 'ref', type: sql.NVarChar(100), value: refStr },
          { name: 'date', type: sql.DateTime, value: offlineTimestamp ? new Date(offlineTimestamp) : new Date() },
          { name: 'branchId', type: sql.Int, value: branchId },
          { name: 'cuentaId', type: sql.BigInt, value: c.CuentaId },
          { name: 'balanceId', type: sql.BigInt, value: c.AccountBalanceId },
          { name: 'userId', type: sql.BigInt, value: userId }
        ]);

        resultados.push({
          uuid,
          success: true,
          folioOficial: atRes.recordset[0]?.Id || refStr,
          nuevoSaldo,
        });
        exitosas++;

      } else {
        resultados.push({ uuid, success: false, message: 'Tipo no soportado offline' });
        fallidas++;
      }
    } catch (err) {
      resultados.push({ uuid, success: false, message: err.message });
      fallidas++;
    }
  }

  res.json({
    success: true,
    message: `Sincronización completada: ${exitosas} exitosas, ${fallidas} fallidas`,
    exitosas,
    fallidas,
    resultados,
  });
});

/**
 * POST /api/caja/cierre-dia — Ejecutar Cierre de Día y Devengamiento Nocturno
 */
router.post('/cierre-dia', async (req, res) => {
  const userId = req.user.id || 1;
  const branchId = req.user.branchId || 1;

  try {
    const result = await query(`
      EXEC sp_SIF_EjecutarCierreDia @UserId = @userId, @BranchId = @branchId
    `, [
      { name: 'userId', type: sql.BigInt, value: userId },
      { name: 'branchId', type: sql.Int, value: branchId }
    ]);

    const data = result.recordset[0];
    res.json({
      success: true,
      message: data.Message,
      fechaCierre: data.FechaCierre,
      creditosDevengados: data.CreditosDevengados,
      moraIdentificada: data.CreditosIdentificadosEnMora,
      totalInteresDevengado: parseFloat(data.TotalInteresDevengado),
      polizaContableId: data.PolizaContableId,
    });
  } catch (err) {
    console.error('Error cierre de día:', err);
    res.status(500).json({ success: false, message: 'Error al ejecutar Cierre de Día', detail: err.message });
  }
});

module.exports = router;
