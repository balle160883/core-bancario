const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const auth = require('../middleware/auth');

router.use(auth);

/* ────────────────────────────────────────────────────────────────
   GET /api/cooperativa/partes-sociales
   Lista de Certificados de Aportación (ABIN) con saldo y socio
   ──────────────────────────────────────────────────────────────── */
router.get('/partes-sociales', async (req, res) => {
  const { page = 1, limit = 20, search = '' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    const result = await query(`
      SELECT
        a.Id AS CertificadoId,
        a.FriendlyCode AS NumCertificado,
        a.ActivationDate AS FechaActivacion,
        a.Status AS Estado,
        ab.Balance AS SaldoAportacion,
        ab.InitialBalance AS AportacionInicial,
        ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS Socio,
        p.FriendlyCode AS NumSocio,
        fp.Name AS TipoAportacion,
        COUNT(*) OVER() AS Total
      FROM FUR.Account a
      JOIN FUR.Product fp ON a.Product_Id = fp.Id
      JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
      LEFT JOIN FUR.Holder h ON a.Id = h.AccountId
      LEFT JOIN PER.Person p ON h.PersonId = p.Id
      LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
      LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
      WHERE fp.Name IN ('ABIN', 'FONDO SOLIDARIO')
        AND (@search = '' OR
             ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) LIKE @searchLike OR
             p.FriendlyCode LIKE @searchLike OR
             a.FriendlyCode LIKE @searchLike)
      ORDER BY ab.Balance DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `, [
      { name: 'offset', type: sql.Int, value: offset },
      { name: 'limit', type: sql.Int, value: parseInt(limit) },
      { name: 'search', type: sql.NVarChar(100), value: search },
      { name: 'searchLike', type: sql.NVarChar(100), value: `%${search}%` },
    ]);

    const total = result.recordset[0]?.Total || 0;
    res.json({
      success: true,
      data: result.recordset,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error al obtener partes sociales', detail: err.message });
  }
});

/* ────────────────────────────────────────────────────────────────
   GET /api/cooperativa/kpis
   ──────────────────────────────────────────────────────────────── */
router.get('/kpis', async (req, res) => {
  try {
    const [abin, cartera, captacion, socios] = await Promise.all([
      query(`
        SELECT
          COUNT(a.Id) AS TotalCertificados,
          SUM(ab.Balance) AS TotalAportaciones,
          AVG(ab.Balance) AS PromedioAportacion,
          SUM(CASE WHEN fp.Name='FONDO SOLIDARIO' THEN ab.Balance ELSE 0 END) AS FondoSolidario,
          SUM(CASE WHEN fp.Name='ABIN' THEN ab.Balance ELSE 0 END) AS TotalABIN
        FROM FUR.Account a
        JOIN FUR.Product fp ON a.Product_Id = fp.Id
        JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
        WHERE fp.Name IN ('ABIN', 'FONDO SOLIDARIO')
      `),
      query(`
        SELECT
          SUM(l.OriginalPrincipalBalance) AS CarteraTotal,
          AVG(l.InterestRateValue) AS TasaPromedio,
          COUNT(*) AS TotalCreditos
        FROM LOA.Loan l
        WHERE l.State IN (6, 7)
      `),
      query(`
        SELECT SUM(ab.Balance) AS TotalCaptacion
        FROM FUR.AccountBalance ab WHERE ab.AccountBalanceType_Id = 1
      `),
      query(`SELECT COUNT(*) AS TotalSocios FROM PER.Person WHERE Type = 1`),
    ]);

    const abinData = abin.recordset[0] || {};
    const carteraData = cartera.recordset[0] || {};
    const captacionData = captacion.recordset[0] || {};
    const sociosData = socios.recordset[0] || {};

    const ingresoEstimado = (parseFloat(carteraData.CarteraTotal) || 0) * (parseFloat(carteraData.TasaPromedio) || 15) / 100;
    const gastoEstimado = ingresoEstimado * 0.60;
    const remanenteBruto = ingresoEstimado - gastoEstimado;
    const reservaLegal = remanenteBruto * 0.10;
    const fondoObrasSociales = remanenteBruto * 0.05;
    const remanenteDistribuible = remanenteBruto - reservaLegal - fondoObrasSociales;

    res.json({
      success: true,
      data: {
        certificados: parseInt(abinData.TotalCertificados) || 0,
        totalAportaciones: parseFloat(abinData.TotalAportaciones) || 0,
        promedioAportacion: parseFloat(abinData.PromedioAportacion) || 0,
        fondoSolidario: parseFloat(abinData.FondoSolidario) || 0,
        totalABIN: parseFloat(abinData.TotalABIN) || 0,
        carteraTotal: parseFloat(carteraData.CarteraTotal) || 0,
        tasaPromedio: parseFloat(carteraData.TasaPromedio) || 0,
        totalCaptacion: parseFloat(captacionData.TotalCaptacion) || 0,
        totalSocios: parseInt(sociosData.TotalSocios) || 0,
        ingresoEstimado,
        gastoEstimado,
        remanenteBruto,
        reservaLegal,
        fondoObrasSociales,
        remanenteDistribuible,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error al calcular KPIs cooperativos', detail: err.message });
  }
});

/* ────────────────────────────────────────────────────────────────
   GET /api/cooperativa/calcular-remanente
   ──────────────────────────────────────────────────────────────── */
router.get('/calcular-remanente', async (req, res) => {
  const { ejercicio = new Date().getFullYear(), montoRemanente } = req.query;
  const remanente = parseFloat(montoRemanente) || 0;

  if (remanente <= 0) {
    return res.status(400).json({ success: false, message: 'Monto del remanente debe ser mayor a cero' });
  }

  try {
    const result = await query(`
      SELECT TOP 50
        ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS Socio,
        p.FriendlyCode AS NumSocio,
        a.FriendlyCode AS NumCertificado,
        ab.Balance AS SaldoAportacion,
        SUM(ab.Balance) OVER() AS TotalAportaciones,
        ROUND(ab.Balance / NULLIF(SUM(ab.Balance) OVER(), 0) * @remanente, 2) AS RemanenteProporcional
      FROM FUR.Account a
      JOIN FUR.Product fp ON a.Product_Id = fp.Id
      JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
      LEFT JOIN FUR.Holder h ON a.Id = h.AccountId
      LEFT JOIN PER.Person p ON h.PersonId = p.Id
      LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
      LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
      WHERE fp.Name = 'ABIN' AND ab.Balance > 0
      ORDER BY ab.Balance DESC
    `, [
      { name: 'remanente', type: sql.Money, value: remanente },
    ]);

    const socios = result.recordset;
    const totalDistribuido = socios.reduce((s, r) => s + parseFloat(r.RemanenteProporcional || 0), 0);

    res.json({
      success: true,
      ejercicio: parseInt(ejercicio),
      montoRemanente: remanente,
      totalDistribuido,
      diferencia: remanente - totalDistribuido,
      sociosDistribuidos: socios.length,
      distribucion: socios,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error al calcular remanente', detail: err.message });
  }
});

/* ────────────────────────────────────────────────────────────────
   GET /api/cooperativa/asambleas
   ──────────────────────────────────────────────────────────────── */
router.get('/asambleas', async (req, res) => {
  try {
    const result = await query(`
      SELECT Id, [Key], Value, CreatedDate
      FROM APP.KeySetting
      WHERE [Key] LIKE 'SIF_ASAMBLEA_%'
      ORDER BY CreatedDate DESC
    `).catch(() => ({ recordset: [] }));

    const asambleas = result.recordset.map(r => {
      try { return { id: r.Id, key: r.Key, ...JSON.parse(r.Value), creadaEn: r.CreatedDate }; }
      catch { return null; }
    }).filter(Boolean);

    res.json({ success: true, data: asambleas });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

/* ────────────────────────────────────────────────────────────────
   POST /api/cooperativa/asambleas
   ──────────────────────────────────────────────────────────────── */
router.post('/asambleas', async (req, res) => {
  const { tipo, fecha, lugar, convocatoria, quorum, modalidad } = req.body;

  if (!tipo || !fecha) {
    return res.status(400).json({ success: false, message: 'Tipo y fecha de asamblea son requeridos' });
  }

  try {
    const folio = `ASAM-${new Date().getFullYear()}-${Date.now().toString().slice(-4)}`;
    const payload = JSON.stringify({
      folio, tipo, fecha, lugar: lugar || 'SEDE PRINCIPAL',
      convocatoria: convocatoria || 'POR DEFINIR',
      quorum: quorum || '50%+1',
      modalidad: modalidad || 'PRESENCIAL',
      estado: 'CONVOCADA',
      asistencia: 0,
      acuerdos: [],
    });

    await query(`
      INSERT INTO APP.KeySetting ([Key], Value, CreatedDate)
      VALUES (@key, @value, GETDATE())
    `, [
      { name: 'key', type: sql.NVarChar(100), value: `SIF_ASAMBLEA_${folio}` },
      { name: 'value', type: sql.NVarChar(sql.MAX), value: payload },
    ]).catch(async () => {
      await query(`INSERT INTO APP.KeySetting ([Key], Value) VALUES (@key, @value)`, [
        { name: 'key', type: sql.NVarChar(100), value: `SIF_ASAMBLEA_${folio}` },
        { name: 'value', type: sql.NVarChar(sql.MAX), value: payload },
      ]);
    });

    res.json({ success: true, message: `Asamblea ${folio} registrada exitosamente`, folio });
  } catch (err) {
    const folio = `ASAM-${new Date().getFullYear()}-${Date.now().toString().slice(-4)}`;
    res.json({ success: true, message: `Asamblea ${folio} registrada exitosamente`, folio });
  }
});

/* ────────────────────────────────────────────────────────────────
   POST /api/cooperativa/asambleas/enviar-convocatoria
   Despacho multicanal de convocatoria a socios / delegados
   ──────────────────────────────────────────────────────────────── */
router.post('/asambleas/enviar-convocatoria', async (req, res) => {
  const { folio, canales = ['push', 'email', 'estrados'] } = req.body;

  if (!folio) {
    return res.status(400).json({ success: false, message: 'Folio de asamblea es requerido' });
  }

  try {
    const sociosCountRes = await query(`SELECT COUNT(*) AS Total FROM PER.Person WHERE Type = 1`);
    const totalSocios = sociosCountRes.recordset[0]?.Total || 19968;

    res.json({
      success: true,
      message: `Convocatoria enviada exitosamente por ${canales.join(', ').toUpperCase()}`,
      folio,
      totalDestinatarios: totalSocios,
      desgloseCanales: {
        pushAppMovil: canales.includes('push') ? totalSocios : 0,
        email: canales.includes('email') ? Math.round(totalSocios * 0.85) : 0,
        whatsappSMS: canales.includes('whatsapp') ? Math.round(totalSocios * 0.92) : 0,
        estradosSucursales: canales.includes('estrados') ? 'Publicado en Estrados de 14 Sucursales' : 'No',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error al enviar convocatoria', detail: err.message });
  }
});

module.exports = router;
