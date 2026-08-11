const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const auth = require('../middleware/auth');

router.use(auth);

/**
 * GET /api/originacion/productos — Productos de crédito configurados
 */
router.get('/productos', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        cp.Id,
        cp.Name AS Nombre,
        cp.FriendlyCode AS Codigo,
        24.0 AS TasaAnual,
        36.0 AS TasaMoratoria
      FROM LOA.CreditProduct cp
      ORDER BY cp.Name ASC
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Error productos originación:', err);
    res.status(500).json({ success: false, message: 'Error al obtener productos de crédito' });
  }
});

/**
 * POST /api/originacion/simular — Simulador de tabla de amortización
 * Entradas: monto, plazoMeses, frecuencia ('Semanal', 'Quincenal', 'Mensual'), tasaAnual, tasaIva (0.16)
 */
router.post('/simular', (req, res) => {
  try {
    const { monto, plazoMeses, frecuencia = 'Mensual', tasaAnual = 24.0, tasaIva = 16.0 } = req.body;

    const P = parseFloat(monto);
    const nMeses = parseInt(plazoMeses);
    const rAnual = parseFloat(tasaAnual) / 100;
    const rIva = parseFloat(tasaIva) / 100;

    if (!P || P <= 0 || !nMeses || nMeses <= 0) {
      return res.status(400).json({ success: false, message: 'Monto y plazo deben ser mayores a 0' });
    }

    let pagosPorAno = 12;
    let totalPagos = nMeses;

    if (frecuencia === 'Semanal') {
      pagosPorAno = 52;
      totalPagos = Math.round(nMeses * 4.3333);
    } else if (frecuencia === 'Quincenal') {
      pagosPorAno = 24;
      totalPagos = nMeses * 2;
    }

    const iPeriodo = rAnual / pagosPorAno;

    // Cuota fija mensual sin IVA usando fórmula de anualidad: C = P * [i / (1 - (1+i)^-n)]
    const cuotaBase = (P * iPeriodo) / (1 - Math.pow(1 + iPeriodo, -totalPagos));

    let saldo = P;
    const amortizacion = [];
    let fechaPago = new Date();
    let totalCapital = 0;
    let totalInteres = 0;
    let totalIva = 0;
    let totalGeneral = 0;

    for (let period = 1; period <= totalPagos; period++) {
      // Avanzar fecha de vencimiento
      if (frecuencia === 'Semanal') {
        fechaPago.setDate(fechaPago.getDate() + 7);
      } else if (frecuencia === 'Quincenal') {
        fechaPago.setDate(fechaPago.getDate() + 15);
      } else {
        fechaPago.setMonth(fechaPago.getMonth() + 1);
      }

      const interesPeriodo = saldo * iPeriodo;
      const ivaPeriodo = interesPeriodo * rIva;
      let capitalPeriodo = cuotaBase - interesPeriodo;

      // Ajustar último pago para saldar exactamente el capital
      if (period === totalPagos || capitalPeriodo > saldo) {
        capitalPeriodo = saldo;
      }

      const pagoTotal = capitalPeriodo + interesPeriodo + ivaPeriodo;
      saldo -= capitalPeriodo;
      if (saldo < 0) saldo = 0;

      totalCapital += capitalPeriodo;
      totalInteres += interesPeriodo;
      totalIva += ivaPeriodo;
      totalGeneral += pagoTotal;

      amortizacion.push({
        numPago: period,
        fechaVencimiento: new Date(fechaPago).toISOString().split('T')[0],
        capital: Math.round(capitalPeriodo * 100) / 100,
        interes: Math.round(interesPeriodo * 100) / 100,
        iva: Math.round(ivaPeriodo * 100) / 100,
        pagoTotal: Math.round(pagoTotal * 100) / 100,
        saldoPendiente: Math.round(saldo * 100) / 100,
      });
    }

    res.json({
      success: true,
      resumen: {
        montoSolicitado: P,
        plazoMeses: nMeses,
        frecuencia,
        totalPagos,
        cuotaEstimada: Math.round((totalGeneral / totalPagos) * 100) / 100,
        totalCapital: Math.round(totalCapital * 100) / 100,
        totalInteres: Math.round(totalInteres * 100) / 100,
        totalIva: Math.round(totalIva * 100) / 100,
        costoTotalCredito: Math.round(totalGeneral * 100) / 100,
        catEstimado: Math.round((((totalGeneral / P) - 1) / (nMeses / 12) * 100) * 10) / 10,
      },
      amortizacion,
    });
  } catch (err) {
    console.error('Error simulación:', err);
    res.status(500).json({ success: false, message: 'Error en la simulación de crédito' });
  }
});

/**
 * POST /api/originacion/evaluar-scoring — Motor de scoring paramétrico
 * Entradas: socioId, montoSolicitado, cuotaEstimada
 */
router.get('/evaluar-scoring/:socioId', async (req, res) => {
  const socioId = parseInt(req.params.socioId);
  const montoSolicitado = parseFloat(req.query.monto || 0);
  const cuotaEstimada = parseFloat(req.query.cuota || 0);

  try {
    const [persona, ahorro, creditosActuales, moraHistorica] = await Promise.all([
      // Datos socio
      query(`
        SELECT p.Id, p.FriendlyCode, p.RiskLevel, p.PoliticallyExposed, p.Blocked, p.CreationDate,
               ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS Nombre
        FROM PER.Person p
        LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
        LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
        WHERE p.Id = @id
      `, [{ name: 'id', type: sql.BigInt, value: socioId }]),

      // Saldo acumulado en captación
      query(`
        SELECT ISNULL(SUM(ab.Balance), 0) AS TotalAhorro
        FROM FUR.Account a
        JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
        JOIN FUR.Holder h ON a.Id = h.AccountId
        WHERE h.PersonId = @id AND a.Status IN (1,2,3)
      `, [{ name: 'id', type: sql.BigInt, value: socioId }]),

      // Créditos vigentes
      query(`
        SELECT ISNULL(SUM(lb.CurrentBalance), 0) AS DeudaActual, COUNT(DISTINCT l.Id) AS CreditosActivos
        FROM LOA.CreditLine cl
        JOIN LOA.Loan l ON cl.Id = l.CreditLine_Id
        JOIN LOA.LoanBalance lb ON l.Id = lb.Loan_Id AND lb.LoanBalanceType_Id = 1
        WHERE cl.Person_Id = @id AND l.State IN (7, 6)
      `, [{ name: 'id', type: sql.BigInt, value: socioId }]),

      // Mora actual
      query(`
        SELECT COUNT(*) AS CreditosEnMora, ISNULL(SUM(lb.CurrentBalance), 0) AS SaldoMora
        FROM LOA.CreditLine cl
        JOIN LOA.Loan l ON cl.Id = l.CreditLine_Id
        JOIN LOA.LoanBalance lb ON l.Id = lb.Loan_Id AND lb.LoanBalanceType_Id = 2
        WHERE cl.Person_Id = @id AND l.State = 6
      `, [{ name: 'id', type: sql.BigInt, value: socioId }]),
    ]);

    if (!persona.recordset.length) {
      return res.status(404).json({ success: false, message: 'Socio no encontrado' });
    }

    const p = persona.recordset[0];
    const saldoAhorro = parseFloat(ahorro.recordset[0]?.TotalAhorro || 0);
    const deudaActual = parseFloat(creditosActuales.recordset[0]?.DeudaActual || 0);
    const numCreditos = creditosActuales.recordset[0]?.CreditosActivos || 0;
    const saldoMora = parseFloat(moraHistorica.recordset[0]?.SaldoMora || 0);

    // Algoritmo de scoring (0 a 100 puntos)
    let score = 70;
    const factores = [];

    // 1. Antigüedad
    const fechaAlta = new Date(p.CreationDate);
    const mesesAntiguedad = Math.floor((new Date() - fechaAlta) / (1000 * 60 * 60 * 24 * 30.44));
    if (mesesAntiguedad >= 24) {
      score += 15;
      factores.push({ factor: 'Antigüedad excelente (> 2 años)', efecto: '+15 pts' });
    } else if (mesesAntiguedad >= 6) {
      score += 5;
      factores.push({ factor: 'Antigüedad regular (6-24 meses)', efecto: '+5 pts' });
    } else {
      score -= 10;
      factores.push({ factor: 'Socio nuevo (< 6 meses)', efecto: '-10 pts' });
    }

    // 2. Cobertura con ahorro (Garantía Líquida)
    const CoberturaAhorro = montoSolicitado > 0 ? (saldoAhorro / montoSolicitado) * 100 : 0;
    if (CoberturaAhorro >= 100) {
      score += 20;
      factores.push({ factor: 'Cobertura total con ahorro (100%+)', efecto: '+20 pts' });
    } else if (CoberturaAhorro >= 20) {
      score += 10;
      factores.push({ factor: 'Ahorro colateral disponible (20%+)', efecto: '+10 pts' });
    } else {
      score -= 5;
      factores.push({ factor: 'Bajo saldo de ahorro', efecto: '-5 pts' });
    }

    // 3. Deuda acumulada
    if (deudaActual > 0) {
      score -= Math.min(15, Math.round(deudaActual / 50000) * 5);
      factores.push({ factor: `Deuda activa previa: $${deudaActual.toLocaleString('es-MX')}`, efecto: 'Ajuste proporcional' });
    }

    // 4. Bloqueo o Mora (Filtro Rojo)
    let dictamenRecomendado = 'REVISIÓN_COMITE';
    let colorDictamen = 'warning';

    if (p.Blocked || saldoMora > 0) {
      score = 0;
      dictamenRecomendado = 'RECHAZADO_AUTOMATICO';
      colorDictamen = 'danger';
      factores.push({ factor: '⚠️ Socio bloqueado o en cartera vencida actual', efecto: 'DICTAMEN ROJO' });
    } else if (score >= 75) {
      dictamenRecomendado = 'APROBACION_AUTOMATICA';
      colorDictamen = 'success';
    }

    res.json({
      success: true,
      score: Math.max(0, Math.min(100, score)),
      dictamenRecomendado,
      colorDictamen,
      socio: {
        id: p.Id,
        nombre: p.Nombre,
        numSocio: p.FriendlyCode,
        antiguedadMeses: mesesAntiguedad,
        saldoAhorro,
        deudaActual,
        saldoMora,
        esPEP: p.PoliticallyExposed,
        estaBloqueado: p.Blocked,
      },
      factores,
    });
  } catch (err) {
    console.error('Error scoring:', err);
    res.status(500).json({ success: false, message: 'Error en el cálculo de scoring' });
  }
});

/**
 * POST /api/originacion/crear-solicitud — Registra una nueva solicitud de crédito en BD
 */
router.post('/crear-solicitud', async (req, res) => {
  const { socioId, productoId, montoSolicitado, plazoMeses, destino, observacion } = req.body;

  if (!socioId || !productoId || !montoSolicitado) {
    return res.status(400).json({ success: false, message: 'Faltan datos obligatorios para la solicitud' });
  }

  try {
    const result = await query(`
      INSERT INTO LOA.CreditLine (
        Person_Id, CreditProduct_Id, RequestedAmount, ApprovedAmount,
        State, Created, Observation, Periods, Frequency_Id
      )
      OUTPUT INSERTED.Id, INSERTED.RequestedAmount
      VALUES (
        @socioId, @productoId, @monto, @monto,
        0, GETDATE(), @obs, @periods, 'Mensual'
      )
    `, [
      { name: 'socioId', type: sql.BigInt, value: parseInt(socioId) },
      { name: 'productoId', type: sql.Int, value: parseInt(productoId) },
      { name: 'monto', type: sql.Money, value: parseFloat(montoSolicitado) },
      { name: 'obs', type: sql.NVarChar(500), value: `Destino: ${destino || 'Libre'} | ${observacion || ''}` },
      { name: 'periods', type: sql.SmallInt, value: parseInt(plazoMeses || 12) },
    ]);

    const solicitudId = result.recordset[0]?.Id;

    res.json({
      success: true,
      message: 'Solicitud de crédito registrada con éxito y enviada a Comité',
      solicitudId,
    });
  } catch (err) {
    console.error('Error solicitud:', err);
    res.status(500).json({ success: false, message: 'Error al registrar la solicitud', detail: err.message });
  }
});

/**
 * GET /api/originacion/solicitudes — Solicitudes enviadas a comité
 */
router.get('/solicitudes', async (req, res) => {
  try {
    const result = await query(`
      SELECT TOP 50
        cl.Id AS SolicitudId,
        cl.Created AS FechaSolicitud,
        cl.RequestedAmount AS MontoSolicitado,
        cl.Periods AS PlazoMeses,
        cl.State AS Estado,
        cp.Name AS Producto,
        ISNULL(ip.Name + ' ' + ip.Surname, corp.Name) AS Socio,
        p.FriendlyCode AS NumSocio,
        cl.Observation AS Destino
      FROM LOA.CreditLine cl
      JOIN LOA.CreditProduct cp ON cl.CreditProduct_Id = cp.Id
      JOIN PER.Person p ON cl.Person_Id = p.Id
      LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
      LEFT JOIN PER.CorporatePerson corp ON p.Id = corp.PersonId
      ORDER BY cl.Created DESC
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Error solicitudes:', err);
    res.status(500).json({ success: false, message: 'Error al obtener lista de solicitudes' });
  }
});

module.exports = router;
