const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const auth = require('../middleware/auth');

router.use(auth);

// ─────────────────────────────────────────────────────────────────────────────
// MOTOR NLP: Detector de intenciones financieras
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detecta la intención del usuario a partir del texto en lenguaje natural.
 * Retorna: { intent, params }
 */
function detectarIntencion(texto) {
  const t = texto.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos
    .trim();

  // ── Morosidad / Riesgo de mora ──────────────────────────────────────────
  if (/mora|morosos|riesgo.*credito|credito.*riesgo|vencido|atrasado/.test(t)) {
    const limitMatch = t.match(/(\d+)\s*(socios|clientes|prestamos)/);
    const limit = limitMatch ? parseInt(limitMatch[1]) : 10;
    return { intent: 'socios_mayor_mora', params: { limit } };
  }

  // ── Captación / Ahorro por sucursal ─────────────────────────────────────
  if (/captacion|ahorro|deposito/.test(t) && /sucursal|branche|oficina/.test(t)) {
    const sucMatch = t.match(/sucursal\s+([\w\s]+?)(\s+en|\s+durante|\.|\?|$)/) ||
                     t.match(/de\s+([\w\s]{3,30?})\s+sucursal/);
    const sucursal = sucMatch ? sucMatch[1].trim().toUpperCase() : null;
    if (/crecimiento|evolucion|historial|mensual/.test(t)) {
      return { intent: 'captacion_mensual_sucursal', params: { sucursal } };
    }
    return { intent: 'captacion_por_sucursal', params: { sucursal } };
  }

  // ── Captación general mensual ────────────────────────────────────────────
  if (/captacion|ahorro/.test(t) && /crecimiento|mensual|mes|evolucion|historial/.test(t)) {
    return { intent: 'captacion_mensual_global', params: {} };
  }

  // ── Préstamos / Cartera ──────────────────────────────────────────────────
  if (/prestamo|credito|cartera|loan/.test(t) && /superan|mayor.*que|arriba|encima/.test(t)) {
    const montoMatch = t.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*(mxn|pesos|mx)?/);
    const monto = montoMatch ? parseFloat(montoMatch[1].replace(',', '')) : 100000;
    return { intent: 'prestamos_mayor_monto', params: { monto } };
  }

  // ── Socios con mayor saldo ───────────────────────────────────────────────
  if (/socios|clientes/.test(t) && /mayor.*saldo|saldo.*alto|mas.*dinero|top/.test(t)) {
    const limitMatch = t.match(/(\d+)\s*(socios|clientes)/);
    const limit = limitMatch ? parseInt(limitMatch[1]) : 10;
    return { intent: 'socios_mayor_saldo', params: { limit } };
  }

  // ── KPIs generales del sistema ──────────────────────────────────────────
  if (/kpi|resumen|estadistica|panorama|resumen general|estado general|cuantos socios|total socios/.test(t)) {
    return { intent: 'kpis_generales', params: {} };
  }

  // ── Sucursales / Ranking de sucursales ─────────────────────────────────
  if (/sucursal(es)?/.test(t) && /rank|mejores?|top|mayor|captacion|deposito/.test(t)) {
    const limitMatch = t.match(/(\d+)\s*sucursales?/);
    const limit = limitMatch ? parseInt(limitMatch[1]) : 10;
    return { intent: 'ranking_sucursales', params: { limit } };
  }

  // ── Nuevos socios / Crecimiento de socios ─────────────────────────────
  if (/nuevo.*socios?|alta.*socios?|socios?.*nuevo|registro.*socios?|ingresaron|se unieron/.test(t)) {
    return { intent: 'nuevos_socios_mensual', params: {} };
  }

  // ── Productos de captación ──────────────────────────────────────────────
  if (/producto(s)?/.test(t) && /captacion|inversion|ahorro/.test(t)) {
    return { intent: 'productos_captacion', params: {} };
  }

  // ── Alertas / Anomalías ─────────────────────────────────────────────────
  if (/alerta(s)?|anomalia(s)?|sospechoso|inusual|pld/.test(t)) {
    return { intent: 'alertas_pld', params: {} };
  }

  // ── Total de cartera vigente ────────────────────────────────────────────
  if (/(total|cuanto|monto).*cartera|cartera.*(total|vigente|activa)/.test(t)) {
    return { intent: 'cartera_total', params: {} };
  }

  // ── Cierre de día / Devengamiento ──────────────────────────────────────
  if (/cierre|devengo|devengamiento|interes.*dia|dia.*interes/.test(t)) {
    return { intent: 'resumen_cierre', params: {} };
  }

  return { intent: 'no_entendido', params: {} };
}

// ─────────────────────────────────────────────────────────────────────────────
// EJECUTORES DE CONSULTAS SQL por intención
// ─────────────────────────────────────────────────────────────────────────────

async function ejecutarIntencion(intent, params) {
  switch (intent) {

    // ── Socios con Mayor Mora ─────────────────────────────────────────────
    case 'socios_mayor_mora': {
      const limit = Math.min(params.limit || 10, 50);
      const res = await query(`
        SELECT TOP ${limit}
          p.FriendlyCode AS NumSocio,
          ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS Nombre,
          l.FriendlyCode AS NumCredito,
          lb.CurrentBalance AS SaldoVencido,
          l.NextDueDay AS FechaVencimiento,
          DATEDIFF(DAY, l.NextDueDay, GETDATE()) AS DiasAtraso
        FROM LOA.Loan l
        JOIN LOA.LoanBalance lb ON l.Id = lb.Loan_Id AND lb.LoanBalanceType_Id = 2
        JOIN PER.Person p ON l.Person_Id = p.Id
        LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
        LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
        WHERE l.State = 6
          AND lb.CurrentBalance > 0
          AND l.NextDueDay < GETDATE()
        ORDER BY lb.CurrentBalance DESC
      `);
      return {
        tipo: 'tabla',
        titulo: `🔴 Top ${limit} Socios con Mayor Saldo Vencido`,
        columnas: ['Núm. Socio', 'Nombre', 'Núm. Crédito', 'Saldo Vencido ($)', 'Fecha Venc.', 'Días Atraso'],
        filas: res.recordset,
        formato: ['texto', 'texto', 'texto', 'moneda', 'fecha', 'numero_atraso'],
        resumen: `Se encontraron **${res.recordset.length}** socios en mora con saldos vencidos pendientes.`
      };
    }

    // ── Captación Mensual Global ─────────────────────────────────────────
    case 'captacion_mensual_global': {
      const res = await query(`
        SELECT TOP 12
          FORMAT(t.[Date], 'MMM yyyy', 'es-MX') AS Mes,
          YEAR(t.[Date]) AS Anio,
          MONTH(t.[Date]) AS NumMes,
          SUM(t.Amount) AS TotalCaptado
        FROM FUR.AccountTransaction t
        WHERE t.TransactionType_Id IN (1, 101)
          AND t.[Date] >= DATEADD(MONTH, -12, GETDATE())
        GROUP BY FORMAT(t.[Date], 'MMM yyyy', 'es-MX'), YEAR(t.[Date]), MONTH(t.[Date])
        ORDER BY Anio ASC, NumMes ASC
      `);
      return {
        tipo: 'grafica_linea',
        titulo: '📈 Evolución de Captación — Últimos 12 Meses',
        etiqueta: 'Monto Captado ($MXN)',
        labels: res.recordset.map(r => r.Mes),
        datos: res.recordset.map(r => Math.round(r.TotalCaptado)),
        resumen: `La captación acumulada en los últimos 12 meses suma **${formatMXN(res.recordset.reduce((s,r)=>s+r.TotalCaptado,0))}**.`
      };
    }

    // ── Captación por Sucursal ────────────────────────────────────────────
    case 'captacion_por_sucursal':
    case 'ranking_sucursales': {
      const limit = Math.min(params.limit || 10, 50);
      const res = await query(`
        SELECT TOP ${limit}
          b.Name AS Sucursal,
          COUNT(DISTINCT a.Id) AS NumCuentas,
          SUM(ab.Balance) AS TotalCaptado
        FROM FUR.Account a
        JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
        JOIN GEN.Branch b ON a.Branch_Id = b.Id
        WHERE a.Status = 1
        GROUP BY b.Name
        ORDER BY TotalCaptado DESC
      `);
      return {
        tipo: 'grafica_barras',
        titulo: `🏦 Ranking de Captación por Sucursal (Top ${limit})`,
        etiqueta: 'Captación ($MXN)',
        labels: res.recordset.map(r => r.Sucursal),
        datos: res.recordset.map(r => Math.round(r.TotalCaptado)),
        tabla: res.recordset,
        columnas: ['Sucursal', 'Núm. Cuentas', 'Total Captado ($)'],
        formato: ['texto', 'numero', 'moneda'],
        resumen: `La sucursal líder es **${res.recordset[0]?.Sucursal || '—'}** con **${formatMXN(res.recordset[0]?.TotalCaptado || 0)}**.`
      };
    }

    // ── Préstamos mayor a cierto monto ────────────────────────────────────
    case 'prestamos_mayor_monto': {
      const monto = params.monto || 100000;
      const res = await query(`
        SELECT TOP 50
          l.FriendlyCode AS NumCredito,
          ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS Socio,
          lb.CurrentBalance AS SaldoCapital,
          l.InterestRateValue AS TasaAnual,
          l.Periods AS PlazoMeses,
          l.DisbursementDate AS FechaApertura,
          CASE l.State WHEN 7 THEN 'Vigente' WHEN 6 THEN 'Mora' ELSE 'Otro' END AS Estado
        FROM LOA.Loan l
        JOIN LOA.LoanBalance lb ON l.Id = lb.Loan_Id AND lb.LoanBalanceType_Id = 1
        JOIN PER.Person p ON l.Person_Id = p.Id
        LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
        LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
        WHERE l.State IN (7, 6)
          AND lb.CurrentBalance > @monto
        ORDER BY lb.CurrentBalance DESC
      `, [{ name: 'monto', type: sql.Money, value: monto }]);
      return {
        tipo: 'tabla',
        titulo: `💰 Préstamos con Saldo Mayor a ${formatMXN(monto)}`,
        columnas: ['Núm. Crédito', 'Socio', 'Saldo Capital ($)', 'Tasa Anual (%)', 'Plazo (Meses)', 'Fecha Apertura', 'Estado'],
        filas: res.recordset,
        formato: ['texto', 'texto', 'moneda', 'porcentaje', 'numero', 'fecha', 'estado_credito'],
        resumen: `Se encontraron **${res.recordset.length}** créditos con saldo capital mayor a **${formatMXN(monto)}**.`
      };
    }

    // ── Socios con Mayor Saldo ─────────────────────────────────────────────
    case 'socios_mayor_saldo': {
      const limit = Math.min(params.limit || 10, 50);
      const res = await query(`
        SELECT TOP ${limit}
          p.FriendlyCode AS NumSocio,
          ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS Nombre,
          SUM(ab.Balance) AS SaldoTotal,
          COUNT(DISTINCT a.Id) AS NumCuentas,
          b.Name AS SucursalPrincipal
        FROM FUR.Account a
        JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
        JOIN FUR.Holder h ON a.Id = h.AccountId
        JOIN PER.Person p ON h.PersonId = p.Id
        LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
        LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
        LEFT JOIN GEN.Branch b ON p.Branch_Id = b.Id
        WHERE a.Status = 1
        GROUP BY p.FriendlyCode, ip.Name, ip.Surname, cp.Name, b.Name
        ORDER BY SaldoTotal DESC
      `);
      return {
        tipo: 'tabla',
        titulo: `🏆 Top ${limit} Socios con Mayor Saldo en Captación`,
        columnas: ['Núm. Socio', 'Nombre', 'Saldo Total ($)', 'Núm. Cuentas', 'Sucursal Principal'],
        filas: res.recordset,
        formato: ['texto', 'texto', 'moneda', 'numero', 'texto'],
        resumen: `El socio con mayor saldo es **${res.recordset[0]?.Nombre || '—'}** con **${formatMXN(res.recordset[0]?.SaldoTotal || 0)}**.`
      };
    }

    // ── KPIs Generales ────────────────────────────────────────────────────
    case 'kpis_generales': {
      const [socios, captacion, cartera, mora] = await Promise.all([
        query(`SELECT COUNT(*) AS Total FROM PER.Person WHERE Active = 1`),
        query(`SELECT SUM(ab.Balance) AS Total FROM FUR.AccountBalance ab WHERE ab.AccountBalanceType_Id = 1`),
        query(`SELECT SUM(lb.CurrentBalance) AS Total FROM LOA.LoanBalance lb JOIN LOA.Loan l ON lb.Loan_Id = l.Id WHERE lb.LoanBalanceType_Id = 1 AND l.State IN (7,6)`),
        query(`SELECT SUM(lb.CurrentBalance) AS Total FROM LOA.LoanBalance lb JOIN LOA.Loan l ON lb.Loan_Id = l.Id WHERE lb.LoanBalanceType_Id = 2 AND l.State = 6`),
      ]);
      const totalCaptacion = captacion.recordset[0]?.Total || 0;
      const totalCartera = cartera.recordset[0]?.Total || 0;
      const totalMora = mora.recordset[0]?.Total || 0;
      const morosidad = totalCartera > 0 ? ((totalMora / totalCartera) * 100).toFixed(2) : 0;
      return {
        tipo: 'kpis',
        titulo: '📊 Resumen General del Sistema — KPIs en Tiempo Real',
        kpis: [
          { label: 'Total de Socios Activos', valor: socios.recordset[0]?.Total?.toLocaleString('es-MX') || '0', icono: '👥', color: 'azul' },
          { label: 'Captación Total (Saldos)', valor: formatMXN(totalCaptacion), icono: '💳', color: 'verde' },
          { label: 'Cartera de Crédito Vigente', valor: formatMXN(totalCartera), icono: '💰', color: 'morado' },
          { label: 'Cartera Vencida (Mora)', valor: formatMXN(totalMora), icono: '🔴', color: 'rojo' },
          { label: 'Índice de Morosidad', valor: `${morosidad}%`, icono: '📉', color: morosidad > 10 ? 'rojo' : 'amarillo' },
        ],
        resumen: `La caja tiene **${socios.recordset[0]?.Total?.toLocaleString('es-MX')}** socios activos, captación de **${formatMXN(totalCaptacion)}** y un índice de morosidad de **${morosidad}%**.`
      };
    }

    // ── Nuevos Socios Mensual ─────────────────────────────────────────────
    case 'nuevos_socios_mensual': {
      const res = await query(`
        SELECT TOP 12
          FORMAT(p.Created, 'MMM yyyy', 'es-MX') AS Mes,
          YEAR(p.Created) AS Anio,
          MONTH(p.Created) AS NumMes,
          COUNT(*) AS NuevosSocios
        FROM PER.Person p
        WHERE p.Created >= DATEADD(MONTH, -12, GETDATE())
        GROUP BY FORMAT(p.Created, 'MMM yyyy', 'es-MX'), YEAR(p.Created), MONTH(p.Created)
        ORDER BY Anio ASC, NumMes ASC
      `);
      return {
        tipo: 'grafica_barras',
        titulo: '👥 Nuevos Socios Registrados — Últimos 12 Meses',
        etiqueta: 'Socios Nuevos',
        labels: res.recordset.map(r => r.Mes),
        datos: res.recordset.map(r => r.NuevosSocios),
        resumen: `En los últimos 12 meses se registraron **${res.recordset.reduce((s,r)=>s+r.NuevosSocios,0).toLocaleString('es-MX')}** socios nuevos.`
      };
    }

    // ── Cartera Total ─────────────────────────────────────────────────────
    case 'cartera_total': {
      const res = await query(`
        SELECT
          COUNT(DISTINCT l.Id) AS NumCreditos,
          SUM(CASE WHEN lb.LoanBalanceType_Id = 1 THEN lb.CurrentBalance ELSE 0 END) AS CapitalVigente,
          SUM(CASE WHEN lb.LoanBalanceType_Id = 2 THEN lb.CurrentBalance ELSE 0 END) AS CapitalVencido,
          AVG(l.InterestRateValue) AS TasaPromedio,
          AVG(CAST(l.Periods AS FLOAT)) AS PlazoPromedio
        FROM LOA.Loan l
        JOIN LOA.LoanBalance lb ON l.Id = lb.Loan_Id
        WHERE l.State IN (7, 6)
      `);
      const d = res.recordset[0] || {};
      return {
        tipo: 'kpis',
        titulo: '💼 Resumen de Cartera de Crédito',
        kpis: [
          { label: 'Total de Créditos Activos', valor: (d.NumCreditos || 0).toLocaleString('es-MX'), icono: '📄', color: 'azul' },
          { label: 'Capital Vigente', valor: formatMXN(d.CapitalVigente), icono: '💰', color: 'verde' },
          { label: 'Capital Vencido (Mora)', valor: formatMXN(d.CapitalVencido), icono: '⚠️', color: 'rojo' },
          { label: 'Tasa Promedio Anual', valor: `${(d.TasaPromedio||0).toFixed(2)}%`, icono: '📈', color: 'morado' },
          { label: 'Plazo Promedio (Meses)', valor: `${Math.round(d.PlazoPromedio||0)} meses`, icono: '📅', color: 'amarillo' },
        ],
        resumen: `La cartera activa está compuesta por **${(d.NumCreditos||0).toLocaleString('es-MX')}** créditos con capital vigente de **${formatMXN(d.CapitalVigente)}**.`
      };
    }

    // ── Alertas PLD ────────────────────────────────────────────────────────
    case 'alertas_pld': {
      const res = await query(`
        SELECT TOP 15
          p.FriendlyCode AS NumSocio,
          ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS Nombre,
          t.Amount AS Monto,
          t.[Date] AS Fecha,
          tt.Name AS TipoTransaccion,
          b.Name AS Sucursal
        FROM FUR.AccountTransaction t
        JOIN FUR.Account a ON t.Account_Id = a.Id
        JOIN FUR.Holder h ON a.Id = h.AccountId AND h.HolderType_Id = 1
        JOIN PER.Person p ON h.PersonId = p.Id
        LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
        LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
        LEFT JOIN FUR.TransactionType tt ON t.TransactionType_Id = tt.Id
        LEFT JOIN GEN.Branch b ON t.Branch_Id = b.Id
        WHERE t.Amount >= 30000
          AND t.[Date] >= DATEADD(DAY, -30, GETDATE())
        ORDER BY t.Amount DESC
      `);
      return {
        tipo: 'tabla',
        titulo: '🛡️ Alertas PLD — Transacciones ≥ $30,000 MXN (Últimos 30 días)',
        columnas: ['Núm. Socio', 'Nombre', 'Monto ($)', 'Fecha', 'Tipo Transacción', 'Sucursal'],
        filas: res.recordset,
        formato: ['texto', 'texto', 'moneda', 'fecha', 'texto', 'texto'],
        resumen: `Se detectaron **${res.recordset.length}** transacciones de alto valor (≥ $30,000 MXN) en los últimos 30 días.`
      };
    }

    // ── Resumen Cierre de Día ─────────────────────────────────────────────
    case 'resumen_cierre': {
      const res = await query(`
        SELECT TOP 7
          CAST(j.Date AS DATE) AS Fecha,
          COUNT(*) AS PolizasGeneradas,
          SUM(jl.Debit) AS TotalDevengado
        FROM ACC.Journal j
        JOIN ACC.JournalLine jl ON j.Id = jl.Journal_Id
        WHERE j.Description LIKE '%CIERRE%' OR j.Description LIKE '%DEVENGO%'
        GROUP BY CAST(j.Date AS DATE)
        ORDER BY Fecha DESC
      `);
      return {
        tipo: 'tabla',
        titulo: '🌙 Resumen de Cierres de Día — Últimos 7 Días',
        columnas: ['Fecha', 'Pólizas Generadas', 'Total Devengado ($)'],
        filas: res.recordset,
        formato: ['fecha', 'numero', 'moneda'],
        resumen: `En los últimos 7 días se han generado **${res.recordset.reduce((s,r)=>s+(r.PolizasGeneradas||0),0)}** pólizas de cierre.`
      };
    }

    // ── Productos de Captación ────────────────────────────────────────────
    case 'productos_captacion': {
      const res = await query(`
        SELECT
          pr.Name AS Producto,
          COUNT(DISTINCT a.Id) AS NumCuentas,
          SUM(ab.Balance) AS SaldoTotal
        FROM FUR.Account a
        JOIN FUR.Product pr ON a.Product_Id = pr.Id
        JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
        WHERE a.Status = 1
        GROUP BY pr.Name
        ORDER BY SaldoTotal DESC
      `);
      return {
        tipo: 'grafica_dona',
        titulo: '🥧 Distribución de Captación por Producto',
        etiqueta: 'Saldo ($MXN)',
        labels: res.recordset.map(r => r.Producto),
        datos: res.recordset.map(r => Math.round(r.SaldoTotal || 0)),
        tabla: res.recordset,
        columnas: ['Producto', 'Núm. Cuentas', 'Saldo Total ($)'],
        formato: ['texto', 'numero', 'moneda'],
        resumen: `El producto con mayor captación es **${res.recordset[0]?.Producto || '—'}** con **${formatMXN(res.recordset[0]?.SaldoTotal || 0)}**.`
      };
    }

    default:
      return null;
  }
}

// Helper formateador
function formatMXN(n) {
  return '$' + (parseFloat(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/copilot/preguntar — Entrada principal del Copilot
// ─────────────────────────────────────────────────────────────────────────────
router.post('/preguntar', async (req, res) => {
  const { pregunta } = req.body;
  if (!pregunta || typeof pregunta !== 'string') {
    return res.status(400).json({ success: false, message: 'La pregunta es requerida' });
  }

  const inicio = Date.now();

  try {
    const { intent, params } = detectarIntencion(pregunta);

    if (intent === 'no_entendido') {
      return res.json({
        success: true,
        intent: 'no_entendido',
        respuesta: {
          tipo: 'mensaje',
          titulo: '🤖 No entendí tu pregunta',
          mensaje: `No pude interpretar tu consulta. Puedes preguntarme cosas como:\n- "¿Cuáles son los 10 socios con mayor mora?"\n- "Muéstrame el crecimiento de captación mensual"\n- "¿Cuántos préstamos superan los $200,000?"\n- "Dame el ranking de sucursales por captación"\n- "¿Cuál es el resumen general del sistema?"`,
          sugerencias: [
            '¿Cuáles son los 5 socios con mayor riesgo de mora?',
            'Muéstrame el crecimiento de captación mensual',
            '¿Cuántos préstamos superan los $100,000 MXN?',
            'Ranking de sucursales por captación',
            'Resumen general del sistema',
          ]
        },
        tiempoMs: Date.now() - inicio
      });
    }

    const resultado = await ejecutarIntencion(intent, params);

    if (!resultado) {
      return res.json({ success: true, intent, respuesta: { tipo: 'mensaje', titulo: 'Sin resultados', mensaje: 'No se encontraron datos para esta consulta.' }, tiempoMs: Date.now() - inicio });
    }

    res.json({ success: true, intent, respuesta: resultado, tiempoMs: Date.now() - inicio });

  } catch (err) {
    console.error('Error Copilot:', err);
    res.status(500).json({ success: false, message: 'Error al procesar la consulta', detail: err.message });
  }
});

// GET /api/copilot/sugerencias — Lista de preguntas sugeridas
router.get('/sugerencias', (req, res) => {
  res.json({
    success: true,
    sugerencias: [
      { texto: '¿Cuáles son los 5 socios con mayor riesgo de mora?', icono: '🔴', categoria: 'Riesgo' },
      { texto: '¿Cuántos préstamos superan los $100,000 MXN en la cartera vigente?', icono: '💰', categoria: 'Crédito' },
      { texto: 'Muéstrame el crecimiento de captación de los últimos 12 meses', icono: '📈', categoria: 'Captación' },
      { texto: 'Dame el ranking de las 10 sucursales con más captación', icono: '🏦', categoria: 'Sucursales' },
      { texto: '¿Cuáles son los 10 socios con mayor saldo en captación?', icono: '🏆', categoria: 'Socios' },
      { texto: 'Dame el resumen general del sistema', icono: '📊', categoria: 'KPIs' },
      { texto: '¿Cuál es el total de la cartera vigente?', icono: '💼', categoria: 'Crédito' },
      { texto: 'Muéstrame los nuevos socios registrados en los últimos 12 meses', icono: '👥', categoria: 'Socios' },
      { texto: '¿Existen alertas PLD en las últimas semanas?', icono: '🛡️', categoria: 'PLD' },
      { texto: 'Distribución de captación por producto', icono: '🥧', categoria: 'Productos' },
    ]
  });
});

module.exports = router;
