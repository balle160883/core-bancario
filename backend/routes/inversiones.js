const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const auth = require('../middleware/auth');

router.use(auth);

/**
 * Tabla de Tasas de Inversión por Plazo (PRLV / DPF)
 */
const TASAS_INVERSION = [
  { dias: 28,  tasaAnual: 8.50,  minMonto: 1000 },
  { dias: 91,  tasaAnual: 9.75,  minMonto: 1000 },
  { dias: 182, tasaAnual: 11.00, minMonto: 1000 },
  { dias: 360, tasaAnual: 12.50, minMonto: 1000 },
];

/**
 * GET /api/inversiones/tasas — Catálogo de plazos y tasas vigentes
 */
router.get('/tasas', (req, res) => {
  res.json({ success: true, data: TASAS_INVERSION });
});

/**
 * POST /api/inversiones/simular — Calculadora de Pagaré PRLV con GAT Nominal, GAT Real e ISR
 * Entradas: monto, dias, inflacionEstimada (default 4.0%), tasaIsrAnual (default 0.50%)
 */
router.post('/simular', (req, res) => {
  try {
    const { monto, dias = 28, inflacionEstimada = 4.0, tasaIsrAnual = 0.50 } = req.body;
    const P = parseFloat(monto);
    const nDias = parseInt(dias);

    if (!P || P <= 0 || !nDias || nDias <= 0) {
      return res.status(400).json({ success: false, message: 'Monto y plazo deben ser mayores a 0' });
    }

    // Buscar tasa según plazo
    const configTasa = TASAS_INVERSION.find(t => t.dias === nDias) || { tasaAnual: 8.50 };
    const rAnual = configTasa.tasaAnual / 100;
    const isrAnual = parseFloat(tasaIsrAnual) / 100;
    const infAnual = parseFloat(inflacionEstimada) / 100;

    // 1. Interés Bruto = P * rAnual * (dias / 360)
    const interesBruto = P * rAnual * (nDias / 360);

    // 2. Retención ISR = P * isrAnual * (dias / 360)
    const retencionIsr = P * isrAnual * (nDias / 360);

    // 3. Interés Neto = InteresBruto - ISR
    const interesNeto = Math.max(0, interesBruto - retencionIsr);

    // 4. Monto Final al Vencimiento
    const montoTotalVencimiento = P + interesNeto;

    // 5. Cálculo GAT Nominal (CONDUSEF): GAT_Nominal = [ (1 + (tasa / (360/dias)))^(360/dias) - 1 ] * 100
    const periodosAno = 360 / nDias;
    const gatNominal = (Math.pow(1 + (rAnual / periodosAno), periodosAno) - 1) * 100;

    // 6. Cálculo GAT Real (CONDUSEF): GAT_Real = [ (1 + GAT_Nominal/100) / (1 + Inflación/100) - 1 ] * 100
    const gatReal = (((1 + (gatNominal / 100)) / (1 + infAnual)) - 1) * 100;

    // Fecha de Vencimiento
    const fechaVencimiento = new Date();
    fechaVencimiento.setDate(fechaVencimiento.getDate() + nDias);

    res.json({
      success: true,
      calculo: {
        montoInversion: P,
        plazoDias: nDias,
        tasaBrutaAnual: configTasa.tasaAnual,
        interesBruto: Math.round(interesBruto * 100) / 100,
        retencionIsr: Math.round(retencionIsr * 100) / 100,
        interesNeto: Math.round(interesNeto * 100) / 100,
        montoTotalVencimiento: Math.round(montoTotalVencimiento * 100) / 100,
        gatNominal: Math.round(gatNominal * 100) / 100,
        gatReal: Math.round(gatReal * 100) / 100,
        fechaApertura: new Date().toISOString(),
        fechaVencimiento: fechaVencimiento.toISOString(),
      }
    });

  } catch (err) {
    console.error('Error simulación inversión:', err);
    res.status(500).json({ success: false, message: 'Error al simular inversión' });
  }
});

/**
 * POST /api/inversiones/aperturar — Apertura de Certificado de Inversión PRLV
 */
router.post('/aperturar', async (req, res) => {
  const { socioId, monto, dias, concepto = 'APERTURA PAGARÉ INVERSIÓN PRLV' } = req.body;
  const numMonto = parseFloat(monto);
  const numDias = parseInt(dias);
  const userId = req.user.id || 1;
  const branchId = req.user.branchId || 1;

  if (!socioId || !numMonto || !numDias) {
    return res.status(400).json({ success: false, message: 'Socio, monto y plazo son obligatorios' });
  }

  try {
    // 1. Crear cuenta de inversión en FUR.Account (Product_Id = 9 "INVERSIÓN")
    const acRes = await query(`
      INSERT INTO FUR.Account (
        Product_Id, Status, Created, Branch_Id, Currency_Id, FriendlyCode
      )
      OUTPUT INSERTED.Id
      VALUES (
        9, 1, GETDATE(), @branchId, 1, CONCAT('INV-', FORMAT(GETDATE(), 'yyMMdd'), '-', CAST(CAST(RAND()*1000 AS INT) AS NVARCHAR(5)))
      )
    `, [{ name: 'branchId', type: sql.Int, value: branchId }]);

    const cuentaId = acRes.recordset[0]?.Id;

    // 2. Asociar Socio Titular en FUR.Holder
    await query(`
      INSERT INTO FUR.Holder (AccountId, PersonId, HolderType_Id)
      VALUES (@cuentaId, @socioId, 1)
    `, [
      { name: 'cuentaId', type: sql.BigInt, value: cuentaId },
      { name: 'socioId', type: sql.BigInt, value: parseInt(socioId) }
    ]);

    // 3. Crear Balance en FUR.AccountBalance (Type 9 = INVERSIÓN)
    const abRes = await query(`
      INSERT INTO FUR.AccountBalance (
        Account_Id, AccountBalanceType_Id, Balance, InitialBalance, InitialBalanceDate
      )
      OUTPUT INSERTED.Id
      VALUES (
        @cuentaId, 9, @monto, @monto, GETDATE()
      )
    `, [
      { name: 'cuentaId', type: sql.BigInt, value: cuentaId },
      { name: 'monto', type: sql.Money, value: numMonto }
    ]);

    const balanceId = abRes.recordset[0]?.Id;

    // 4. Registrar Transacción
    const refStr = `INV-${Date.now().toString().slice(-6)}`;
    await query(`
      INSERT INTO FUR.AccountTransaction (
        Amount, Description, Reference, Status, [Date],
        TransactionType_Id, Branch_Id, Account_Id, AccountBalance_Id, User_Id
      )
      VALUES (
        @monto, @desc, @ref, 1, GETDATE(),
        122, @branchId, @cuentaId, @balanceId, @userId
      )
    `, [
      { name: 'monto', type: sql.Money, value: numMonto },
      { name: 'desc', type: sql.NVarChar(250), value: concepto },
      { name: 'ref', type: sql.NVarChar(100), value: refStr },
      { name: 'branchId', type: sql.Int, value: branchId },
      { name: 'cuentaId', type: sql.BigInt, value: cuentaId },
      { name: 'balanceId', type: sql.BigInt, value: balanceId },
      { name: 'userId', type: sql.BigInt, value: userId }
    ]);

    res.json({
      success: true,
      message: 'Certificado de Inversión aperturado exitosamente',
      inversion: {
        certificadoId: cuentaId,
        folio: refStr,
        monto: numMonto,
        plazoDias: numDias,
        fechaApertura: new Date().toISOString(),
      }
    });

  } catch (err) {
    console.error('Error apertura inversión:', err);
    res.status(500).json({ success: false, message: 'Error al aperturar inversión', detail: err.message });
  }
});

/**
 * GET /api/inversiones/vigentes — Pagarés e Inversiones vigentes
 */
router.get('/vigentes', async (req, res) => {
  try {
    const result = await query(`
      SELECT TOP 50
        a.Id AS CertificadoId,
        a.FriendlyCode AS Folio,
        p.Name AS Producto,
        ab.Balance AS MontoInvertido,
        a.Created AS FechaApertura,
        ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS Socio,
        per.FriendlyCode AS NumSocio
      FROM FUR.Account a
      JOIN FUR.Product p ON a.Product_Id = p.Id
      JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 9
      LEFT JOIN FUR.Holder h ON a.Id = h.AccountId
      LEFT JOIN PER.Person per ON h.PersonId = per.Id
      LEFT JOIN PER.IndividualPerson ip ON per.Id = ip.PersonId
      LEFT JOIN PER.CorporatePerson cp ON per.Id = cp.PersonId
      WHERE a.Status = 1
      ORDER BY a.Created DESC
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Error inversiones vigentes:', err);
    res.status(500).json({ success: false, message: 'Error al consultar inversiones vigentes' });
  }
});

module.exports = router;
