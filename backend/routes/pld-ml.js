const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const auth = require('../middleware/auth');

router.use(auth);

// ─────────────────────────────────────────────────────────────────────────────
// MOTOR PLD-ML: Detección de Anomalías por Z-Score + Behavioral Baseline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calcula la desviación estándar de un arreglo de números
 */
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / arr.length;
  return Math.sqrt(variance);
}

/**
 * Z-Score: mide cuántas desviaciones estándar está un valor del promedio.
 * Z > 2.0 = anómalo (97.7%  confianza)
 * Z > 3.0 = muy anómalo (99.7% confianza)
 */
function zScore(valor, media, desv) {
  if (desv === 0) return 0;
  return Math.abs((valor - media) / desv);
}

/**
 * Calcula el RiskScore (0–100) combinando múltiples señales PLD
 */
function calcularRiskScore({ zMonto, zFrecuencia, esHorarioInusual, esMontoCritico, tieneFracturas, numTransDia }) {
  let score = 0;
  // Factor 1: Anomalía de monto (Z-Score)
  if (zMonto >= 3.0) score += 35;
  else if (zMonto >= 2.0) score += 20;
  else if (zMonto >= 1.5) score += 10;

  // Factor 2: Anomalía de frecuencia
  if (zFrecuencia >= 3.0) score += 20;
  else if (zFrecuencia >= 2.0) score += 10;

  // Factor 3: Monto sobre umbral UIF ($7,500 USD ≈ $150,000 MXN)
  if (esMontoCritico) score += 25;

  // Factor 4: Posible estructuración (smurfing) - múltiples txs en un día
  if (tieneFracturas) score += 15;

  // Factor 5: Horario inusual (antes 7am o después 10pm)
  if (esHorarioInusual) score += 5;

  return Math.min(score, 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pld-ml/analizar — Análisis ML completo de anomalías
// ─────────────────────────────────────────────────────────────────────────────
router.get('/analizar', async (req, res) => {
  const diasAtras = parseInt(req.query.dias) || 365;
  const umbralRiesgo = parseInt(req.query.umbral) || 40; // Score mínimo para alertar

  try {
    const inicio = Date.now();

    // ── 1. Obtener transacciones del período ──────────────────────────────
    const txPeriodo = await query(`
      SELECT
        t.Id,
        t.Amount,
        t.[Date],
        DATEPART(HOUR, t.[Date]) AS Hora,
        CAST(t.[Date] AS DATE) AS FechaDia,
        t.TransactionType_Id,
        t.Account_Id,
        a.Id AS CuentaId,
        h.PersonId,
        ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS NombreSocio,
        p.FriendlyCode AS NumSocio,
        p.Type AS TipoPersona,
        b.Name AS Sucursal
      FROM FUR.AccountTransaction t
      JOIN FUR.Account a ON t.Account_Id = a.Id
      JOIN FUR.Holder h ON a.Id = h.AccountId AND h.HolderType_Id = 1
      JOIN PER.Person p ON h.PersonId = p.Id
      LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
      LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
      LEFT JOIN GEN.Branch b ON t.Branch_Id = b.Id
      WHERE t.[Date] >= DATEADD(DAY, -@dias, GETDATE())
        AND t.TransactionType_Id IN (116, 122, 66, 63, 53, 54)
        AND t.Amount > 0
    `, [{ name: 'dias', type: sql.Int, value: diasAtras }]);

    const transacciones = txPeriodo.recordset;

    // ── 2. Obtener baseline histórico por Persona (últimos 12 meses) ──────
    const baseline = await query(`
      SELECT
        h.PersonId,
        COUNT(*) AS TotalTx,
        AVG(t.Amount) AS MontoPromedio,
        STDEV(t.Amount) AS MontoDesviacion,
        SUM(t.Amount) AS MontoTotal,
        COUNT(DISTINCT CAST(t.[Date] AS DATE)) AS DiaActivos,
        MAX(t.Amount) AS MontoMaximo,
        MIN(t.Amount) AS MontoMinimo
      FROM FUR.AccountTransaction t
      JOIN FUR.Account a ON t.Account_Id = a.Id
      JOIN FUR.Holder h ON a.Id = h.AccountId AND h.HolderType_Id = 1
      WHERE t.[Date] >= DATEADD(MONTH, -12, GETDATE())
        AND t.TransactionType_Id IN (116, 122, 66, 63, 53, 54)
        AND t.Amount > 0
      GROUP BY h.PersonId
    `);

    // Indexar baseline por PersonId
    const baselineMap = {};
    baseline.recordset.forEach(b => {
      baselineMap[b.PersonId] = b;
    });

    // ── 3. Aplicar Algoritmo ML (Z-Score + Reglas) por Persona ───────────
    const alertasPLD = [];
    const sociosProcesados = {};

    // Agrupar transacciones del período por Persona
    const txPorPersona = {};
    transacciones.forEach(tx => {
      const pid = tx.PersonId;
      if (!txPorPersona[pid]) txPorPersona[pid] = [];
      txPorPersona[pid].push(tx);
    });

    for (const [personId, txs] of Object.entries(txPorPersona)) {
      const bl = baselineMap[personId];
      if (!bl || bl.TotalTx < 1) continue; // Necesita al menos 1 transacción histórica

      const montosPeriodo = txs.map(t => parseFloat(t.Amount));
      const avgPeriodo = montosPeriodo.reduce((a, b) => a + b, 0) / montosPeriodo.length;

      // Frecuencia de transacciones por día
      const txPorDia = {};
      txs.forEach(tx => {
        const d = tx.FechaDia;
        if (!txPorDia[d]) txPorDia[d] = [];
        txPorDia[d].push(tx);
      });
      const frecuenciasDias = Object.values(txPorDia).map(ts => ts.length);
      const maxTxEnUnDia = Math.max(...frecuenciasDias, 0);
      const frecuenciaPromHistorica = bl.TotalTx / Math.max(bl.DiaActivos, 1);
      const freqDesv = stdDev(frecuenciasDias);

      // ── Calcular señales de alerta por cada transacción anómala ──────
      txs.forEach(tx => {
        const monto = parseFloat(tx.Amount);
        const hora = tx.Hora;

        const z = zScore(monto, parseFloat(bl.MontoPromedio), parseFloat(bl.MontoDesviacion) || 1);
        const zFreq = zScore(maxTxEnUnDia, frecuenciaPromHistorica, freqDesv || 1);
        const esHorarioInusual = hora < 7 || hora >= 22;
        const esMontoCritico = monto >= 7500 * 18; // ~ USD $7,500 en MXN
        const tieneFracturas = maxTxEnUnDia >= 3 && montosPeriodo.every(m => m < 7500 * 18);

        const riskScore = calcularRiskScore({
          zMonto: z,
          zFrecuencia: zFreq,
          esHorarioInusual,
          esMontoCritico,
          tieneFracturas,
          numTransDia: maxTxEnUnDia
        });

        if (riskScore >= umbralRiesgo) {
          // Evitar duplicar el mismo socio con la misma alerta
          const key = `${personId}_${monto}_${tx.FechaDia}`;
          if (!sociosProcesados[key]) {
            sociosProcesados[key] = true;
            alertasPLD.push({
              transaccionId: tx.Id,
              personId,
              numSocio: tx.NumSocio,
              nombre: tx.NombreSocio,
              tipoPersona: tx.TipoPersona === 1 ? 'Física' : 'Moral',
              monto: Math.round(monto * 100) / 100,
              fecha: tx.Date,
              fechaDia: tx.FechaDia,
              hora: hora,
              sucursal: tx.Sucursal || 'N/A',
              riskScore,
              nivelRiesgo: riskScore >= 80 ? 'ALTO' : riskScore >= 60 ? 'MEDIO-ALTO' : 'MEDIO',
              zScoreMonto: Math.round(z * 100) / 100,
              montoPromedioHistorico: Math.round(parseFloat(bl.MontoPromedio) * 100) / 100,
              txEnUnDia: maxTxEnUnDia,
              seniales: {
                montoAnomalo: z >= 2.0,
                frecuenciaAnomala: zFreq >= 2.0,
                montoCriticoUIF: esMontoCritico,
                estructuracion: tieneFracturas,
                horarioInusual: esHorarioInusual,
              }
            });
          }
        }
      });
    }

    // Ordenar por riesgo descendente
    alertasPLD.sort((a, b) => b.riskScore - a.riskScore);

    // ── 4. Estadísticas del análisis ──────────────────────────────────────
    const stats = {
      totalTransaccionesAnalizadas: transacciones.length,
      totalPersonasAnalizadas: Object.keys(txPorPersona).length,
      totalAlertasGeneradas: alertasPLD.length,
      alertasAlto: alertasPLD.filter(a => a.nivelRiesgo === 'ALTO').length,
      alertasMedioAlto: alertasPLD.filter(a => a.nivelRiesgo === 'MEDIO-ALTO').length,
      alertasMedio: alertasPLD.filter(a => a.nivelRiesgo === 'MEDIO').length,
      montoPotencialRiesgo: alertasPLD.reduce((s, a) => s + a.monto, 0),
      tiempoAnalisisMs: Date.now() - inicio,
      periodoAnalizadoDias: diasAtras,
      umbralRiesgoUsado: umbralRiesgo,
    };

    res.json({ success: true, alertas: alertasPLD.slice(0, 200), stats });

  } catch (err) {
    console.error('Error PLD-ML:', err);
    res.status(500).json({ success: false, message: 'Error en análisis PLD-ML', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pld-ml/uif-xml — Genera XML en formato oficial UIF/GAFI
// ─────────────────────────────────────────────────────────────────────────────
router.get('/uif-xml', async (req, res) => {
  const dias = parseInt(req.query.dias) || 30;

  try {
    // Obtener transacciones de alto riesgo (>= $150,000 MXN umbral UIF)
    const txAltoRiesgo = await query(`
      SELECT TOP 200
        t.Id AS FolioTx,
        CONVERT(VARCHAR(10), t.[Date], 126) AS FechaOperacion,
        t.Amount AS MontoOperacion,
        'MXN' AS Moneda,
        ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS NombreCliente,
        ISNULL(ip.CURP, '') AS CURP,
        p.FriendlyCode AS NumCliente,
        p.Type AS TipoPersona,
        b.Name AS Sucursal,
        tt.Name AS TipoOperacion
      FROM FUR.AccountTransaction t
      JOIN FUR.Account a ON t.Account_Id = a.Id
      JOIN FUR.Holder h ON a.Id = h.AccountId AND h.HolderType_Id = 1
      JOIN PER.Person p ON h.PersonId = p.Id
      LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
      LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
      LEFT JOIN GEN.Branch b ON t.Branch_Id = b.Id
      LEFT JOIN FUR.TransactionType tt ON t.TransactionType_Id = tt.Id
      WHERE t.[Date] >= DATEADD(DAY, -@dias, GETDATE())
        AND t.Amount >= 150000
        AND t.TransactionType_Id IN (116, 122, 66, 63)
      ORDER BY t.Amount DESC
    `, [{ name: 'dias', type: sql.Int, value: dias }]);

    const ops = txAltoRiesgo.recordset;
    const fechaReporte = new Date().toISOString().split('T')[0];
    const folioReporte = `ROS-${Date.now().toString().slice(-8)}`;

    // ── Generar XML en estructura oficial CNBV/UIF ─────────────────────
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<!-- Reporte de Operaciones Sospechosas (ROS) — CNBV/UIF México -->\n`;
    xml += `<!-- Formato conforme a disposiciones LFPIORPI Art. 17 -->\n`;
    xml += `<ReporteOperacionesSospechosas\n`;
    xml += `  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n`;
    xml += `  FolioReporte="${folioReporte}"\n`;
    xml += `  FechaGeneracion="${fechaReporte}"\n`;
    xml += `  EntidadReportante="CAJA POPULAR SIF"\n`;
    xml += `  RFC="CPSXXXXXX999"\n`;
    xml += `  TipoEntidad="COOPERATIVA_AHORRO_PRESTAMO"\n`;
    xml += `  Version="2.0">\n\n`;

    xml += `  <Encabezado>\n`;
    xml += `    <PeriodoAnalizado>\n`;
    xml += `      <FechaInicio>${new Date(Date.now() - dias * 86400000).toISOString().split('T')[0]}</FechaInicio>\n`;
    xml += `      <FechaFin>${fechaReporte}</FechaFin>\n`;
    xml += `    </PeriodoAnalizado>\n`;
    xml += `    <TotalOperaciones>${ops.length}</TotalOperaciones>\n`;
    xml += `    <MontoTotalReportado>${ops.reduce((s,o) => s + parseFloat(o.MontoOperacion||0), 0).toFixed(2)}</MontoTotalReportado>\n`;
    xml += `  </Encabezado>\n\n`;

    xml += `  <Operaciones>\n`;
    ops.forEach((op, idx) => {
      const tipoP = op.TipoPersona === 1 ? 'FISICA' : 'MORAL';
      xml += `    <Operacion Secuencia="${idx + 1}">\n`;
      xml += `      <FolioOperacion>${op.FolioTx}</FolioOperacion>\n`;
      xml += `      <FechaOperacion>${op.FechaOperacion}</FechaOperacion>\n`;
      xml += `      <TipoOperacion>${(op.TipoOperacion || 'DEPOSITO').replace(/&/g, '&amp;')}</TipoOperacion>\n`;
      xml += `      <MontoOperacion Moneda="${op.Moneda}">${parseFloat(op.MontoOperacion || 0).toFixed(2)}</MontoOperacion>\n`;
      xml += `      <Cliente TipoPersona="${tipoP}">\n`;
      xml += `        <NumCliente>${op.NumCliente}</NumCliente>\n`;
      xml += `        <Nombre>${(op.NombreCliente || 'N/A').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Nombre>\n`;
      if (op.CURP) xml += `        <CURP>${op.CURP}</CURP>\n`;
      xml += `      </Cliente>\n`;
      xml += `      <Sucursal>${(op.Sucursal || 'N/A').replace(/&/g, '&amp;')}</Sucursal>\n`;
      xml += `    </Operacion>\n`;
    });
    xml += `  </Operaciones>\n`;
    xml += `</ReporteOperacionesSospechosas>\n`;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ROS_UIF_${fechaReporte}.xml"`);
    res.send(xml);

  } catch (err) {
    console.error('Error UIF XML:', err);
    res.status(500).json({ success: false, message: 'Error al generar XML UIF', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pld-ml/uif-csv — Genera CSV/Excel compatible con UIF
// ─────────────────────────────────────────────────────────────────────────────
router.get('/uif-csv', async (req, res) => {
  const dias = parseInt(req.query.dias) || 30;

  try {
    const txAltoRiesgo = await query(`
      SELECT TOP 500
        t.Id AS FolioOperacion,
        CONVERT(VARCHAR(10), t.[Date], 126) AS FechaOperacion,
        DATEPART(HOUR, t.[Date]) AS HoraOperacion,
        t.Amount AS MontoMXN,
        ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS NombreCliente,
        p.FriendlyCode AS NumCliente,
        CASE p.Type WHEN 1 THEN 'FISICA' ELSE 'MORAL' END AS TipoPersona,
        ISNULL(ip.CURP, 'N/A') AS CURP,
        b.Name AS Sucursal,
        tt.Name AS TipoOperacion
      FROM FUR.AccountTransaction t
      JOIN FUR.Account a ON t.Account_Id = a.Id
      JOIN FUR.Holder h ON a.Id = h.AccountId AND h.HolderType_Id = 1
      JOIN PER.Person p ON h.PersonId = p.Id
      LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
      LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
      LEFT JOIN GEN.Branch b ON t.Branch_Id = b.Id
      LEFT JOIN FUR.TransactionType tt ON t.TransactionType_Id = tt.Id
      WHERE t.[Date] >= DATEADD(DAY, -@dias, GETDATE())
        AND t.Amount >= 7500
        AND t.TransactionType_Id IN (116, 122, 66, 63)
      ORDER BY t.Amount DESC
    `, [{ name: 'dias', type: sql.Int, value: dias }]);

    const cols = ['FolioOperacion','FechaOperacion','HoraOperacion','MontoMXN','NombreCliente','NumCliente','TipoPersona','CURP','Sucursal','TipoOperacion'];
    let csv = '\uFEFF'; // BOM para Excel en español
    csv += cols.join(',') + '\r\n';

    txAltoRiesgo.recordset.forEach(r => {
      csv += cols.map(c => {
        const v = r[c] ?? '';
        return `"${String(v).replace(/"/g, '""')}"`;
      }).join(',') + '\r\n';
    });

    const fecha = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Reporte_UIF_${fecha}.csv"`);
    res.send(csv);

  } catch (err) {
    console.error('Error CSV UIF:', err);
    res.status(500).json({ success: false, message: 'Error al generar CSV UIF', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pld-ml/dashboard — KPIs rápidos del módulo PLD
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const [txAltas, txRecientes, distribTipo] = await Promise.all([
      query(`
        SELECT COUNT(*) AS Total, SUM(t.Amount) AS MontoTotal
        FROM FUR.AccountTransaction t
        WHERE t.[Date] >= DATEADD(DAY, -730, GETDATE()) AND t.Amount >= 150000
          AND t.TransactionType_Id IN (116, 122, 66)
      `),
      query(`
        SELECT TOP 10
          t.Amount, CONVERT(VARCHAR(10), t.[Date], 126) AS Fecha,
          ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS Nombre,
          p.FriendlyCode AS NumSocio,
          b.Name AS Sucursal
        FROM FUR.AccountTransaction t
        JOIN FUR.Account a ON t.Account_Id = a.Id
        JOIN FUR.Holder h ON a.Id = h.AccountId AND h.HolderType_Id = 1
        JOIN PER.Person p ON h.PersonId = p.Id
        LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
        LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
        LEFT JOIN GEN.Branch b ON t.Branch_Id = b.Id
        WHERE t.[Date] >= DATEADD(DAY, -730, GETDATE()) AND t.Amount >= 150000
        ORDER BY t.Amount DESC
      `),
      query(`
        SELECT tt.Name AS Tipo, COUNT(*) AS Total, SUM(t.Amount) AS MontoTotal
        FROM FUR.AccountTransaction t
        JOIN FUR.TransactionType tt ON t.TransactionType_Id = tt.Id
        WHERE t.[Date] >= DATEADD(DAY, -730, GETDATE()) AND t.Amount >= 7500
          AND t.TransactionType_Id IN (116, 122, 66, 63)
        GROUP BY tt.Name
        ORDER BY Total DESC
      `)
    ]);

    res.json({
      success: true,
      kpis: {
        txUmbralUIF: txAltas.recordset[0]?.Total || 0,
        montoUmbralUIF: txAltas.recordset[0]?.MontoTotal || 0,
      },
      txDestacadas: txRecientes.recordset,
      distribPorTipo: distribTipo.recordset,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error dashboard PLD', detail: err.message });
  }
});

module.exports = router;
