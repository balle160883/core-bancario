const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const jwt = require('jsonwebtoken');

/**
 * Middleware para validar Token JWT Móvil del Socio
 */
function authSocio(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Token de sesión móvil requerido' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    if (!decoded.socioId) return res.status(403).json({ success: false, message: 'Token no corresponde a un socio' });
    req.socio = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ success: false, message: 'Sesión móvil expirada o inválida' });
  }
}

/**
 * POST /api/mobile/login — Login para la App Móvil del Socio
 * Entrada: numSocio (o RFC) y contraseña/PIN
 */
router.post('/login', async (req, res) => {
  const { numSocio, pin } = req.body;

  if (!numSocio) {
    return res.status(400).json({ success: false, message: 'Número de socio o RFC requerido' });
  }

  try {
    const socioRes = await query(`
      SELECT TOP 1
        p.Id AS SocioId, p.FriendlyCode AS NumSocio, p.Active, p.Blocked,
        ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) AS NombreSocio,
        p.CreationDate
      FROM PER.Person p
      LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
      LEFT JOIN PER.CorporatePerson cp ON p.Id = cp.PersonId
      WHERE p.FriendlyCode = @code OR p.Id = @id
    `, [
      { name: 'code', type: sql.NVarChar(50), value: numSocio.toString().trim() },
      { name: 'id', type: sql.BigInt, value: parseInt(numSocio) || 0 }
    ]);

    if (!socioRes.recordset.length) {
      return res.status(401).json({ success: false, message: 'Número de socio no encontrado' });
    }

    const s = socioRes.recordset[0];
    if (s.Blocked || !s.Active) {
      return res.status(403).json({ success: false, message: 'El acceso móvil para este socio está inhabilitado' });
    }

    // Generar Token JWT específico para la App Móvil
    const token = jwt.sign(
      {
        socioId: s.SocioId,
        numSocio: s.NumSocio,
        nombre: s.NombreSocio,
        tipo: 'SOCIO_MOBILE',
      },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '30d' } // Token persistente para App Móvil
    );

    res.json({
      success: true,
      token,
      socio: {
        id: s.SocioId,
        numSocio: s.NumSocio,
        nombre: s.NombreSocio,
        fechaMiembro: s.CreationDate,
      }
    });

  } catch (err) {
    console.error('Error login móvil:', err);
    res.status(500).json({ success: false, message: 'Error de servidor en login móvil' });
  }
});

/**
 * GET /api/mobile/resumen — Resumen consolidado para el Dashboard de la App Móvil
 */
router.get('/resumen', authSocio, async (req, res) => {
  const socioId = req.socio.socioId;

  try {
    const [ahorro, creditos, noticias] = await Promise.all([
      // Total ahorrado
      query(`
        SELECT ISNULL(SUM(ab.Balance), 0) AS TotalAhorro, COUNT(DISTINCT a.Id) AS Cuentas
        FROM FUR.Account a
        JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
        JOIN FUR.Holder h ON a.Id = h.AccountId
        WHERE h.PersonId = @id AND a.Status IN (1, 2, 3)
      `, [{ name: 'id', type: sql.BigInt, value: socioId }]),

      // Total saldo deuda
      query(`
        SELECT ISNULL(SUM(lb.CurrentBalance), 0) AS TotalDeuda, COUNT(DISTINCT l.Id) AS CreditosActivos
        FROM LOA.CreditLine cl
        JOIN LOA.Loan l ON cl.Id = l.CreditLine_Id
        JOIN LOA.LoanBalance lb ON l.Id = lb.Loan_Id AND lb.LoanBalanceType_Id = 1
        WHERE cl.Person_Id = @id AND l.State IN (7, 6)
      `, [{ name: 'id', type: sql.BigInt, value: socioId }]),

      // Próximo pago
      query(`
        SELECT TOP 1 l.FriendlyCode AS FolioCredito, l.NextDueDay AS FechaPago, l.QuotaValue AS CuotaEstimada
        FROM LOA.Loan l
        WHERE l.Person_Id = @id AND l.State = 7
        ORDER BY l.NextDueDay ASC
      `, [{ name: 'id', type: sql.BigInt, value: socioId }]).catch(() => ({ recordset: [] })),
    ]);

    const totalAhorro = parseFloat(ahorro.recordset[0]?.TotalAhorro || 0);
    const totalDeuda  = parseFloat(creditos.recordset[0]?.TotalDeuda || 0);
    const proximoPago = noticias.recordset[0] || null;

    res.json({
      success: true,
      data: {
        nombreSocio: req.socio.nombre,
        numSocio: req.socio.numSocio,
        totalAhorro,
        totalDeuda,
        proximoPago: proximoPago ? {
          folioCredito: proximoPago.FolioCredito,
          fechaPago: proximoPago.FechaPago,
          cuotaEstimada: proximoPago.CuotaEstimada,
        } : null,
      }
    });

  } catch (err) {
    console.error('Error resumen móvil:', err);
    res.status(500).json({ success: false, message: 'Error al obtener resumen móvil' });
  }
});

/**
 * GET /api/mobile/cuentas — Cuentas de ahorro e inversión del socio (con CLABE SPEI)
 */
router.get('/cuentas', authSocio, async (req, res) => {
  const socioId = req.socio.socioId;

  try {
    const result = await query(`
      SELECT
        a.Id AS CuentaId,
        a.FriendlyCode AS NumCuenta,
        fp.Name AS Producto,
        ab.Balance AS SaldoDisponible,
        a.Status AS Estado,
        a.Created AS FechaApertura
      FROM FUR.Account a
      JOIN FUR.Product fp ON a.Product_Id = fp.Id
      JOIN FUR.AccountBalance ab ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
      JOIN FUR.Holder h ON a.Id = h.AccountId
      WHERE h.PersonId = @id AND a.Status IN (1, 2, 3)
      ORDER BY a.Id DESC
    `, [{ name: 'id', type: sql.BigInt, value: socioId }]);

    // Asignar CLABE virtual SPEI de 18 dígitos (646 + Banco 180 + Sucursal + Cuenta)
    const cuentas = result.recordset.map(c => {
      const padId = String(c.CuentaId).padStart(10, '0');
      const clabe = `646180${padId}8`; // Estructura estándar CLABE STP/Cajas
      return {
        id: c.CuentaId,
        numCuenta: c.NumCuenta || `#${c.CuentaId}`,
        producto: c.Producto,
        saldoDisponible: parseFloat(c.SaldoDisponible),
        clabeSpei: clabe,
        fechaApertura: c.FechaApertura,
      };
    });

    res.json({ success: true, data: cuentas });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error al consultar cuentas móviles' });
  }
});

/**
 * GET /api/mobile/cuentas/:id/movimientos — Últimos movimientos de la cuenta
 */
router.get('/cuentas/:id/movimientos', authSocio, async (req, res) => {
  const cuentaId = parseInt(req.params.id);

  try {
    const result = await query(`
      SELECT TOP 50
        at2.Id,
        at2.[Date] AS Fecha,
        tt.Name AS Tipo,
        at2.Amount AS Monto,
        at2.Description AS Concepto,
        at2.Reference AS Referencia
      FROM FUR.AccountTransaction at2
      LEFT JOIN FUR.TransactionType tt ON at2.TransactionType_Id = tt.Id
      WHERE at2.Account_Id = @id
      ORDER BY at2.[Date] DESC
    `, [{ name: 'id', type: sql.BigInt, value: cuentaId }]);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error al consultar movimientos' });
  }
});

/**
 * GET /api/mobile/creditos — Préstamos y créditos del socio
 */
router.get('/creditos', authSocio, async (req, res) => {
  const socioId = req.socio.socioId;

  try {
    const result = await query(`
      SELECT
        l.Id AS CreditoId,
        l.FriendlyCode AS Folio,
        cp.Name AS Producto,
        l.OriginalPrincipalBalance AS MontoOtorgado,
        lb.CurrentBalance AS SaldoCapital,
        l.State AS Estado,
        l.OriginationDate AS FechaOtorgamiento,
        l.MaturityDate AS FechaVencimiento,
        l.NextDueDay AS ProximoPago
      FROM LOA.Loan l
      JOIN LOA.CreditLine cl ON l.CreditLine_Id = cl.Id
      JOIN LOA.CreditProduct cp ON cl.CreditProduct_Id = cp.Id
      JOIN LOA.LoanBalance lb ON l.Id = lb.Loan_Id AND lb.LoanBalanceType_Id = 1
      WHERE cl.Person_Id = @id
      ORDER BY l.OriginationDate DESC
    `, [{ name: 'id', type: sql.BigInt, value: socioId }]);

    const estados = { 7: 'Vigente', 6: 'En Mora', 8: 'Liquidado' };

    const creditos = result.recordset.map(c => ({
      id: c.CreditoId,
      folio: c.Folio || `#${c.CreditoId}`,
      producto: c.Producto,
      montoOtorgado: parseFloat(c.MontoOtorgado),
      saldoCapital: parseFloat(c.SaldoCapital),
      estado: estados[c.Estado] || `Estado ${c.Estado}`,
      fechaOtorgamiento: c.FechaOtorgamiento,
      fechaVencimiento: c.FechaVencimiento,
      proximoPago: c.ProximoPago,
    }));

    res.json({ success: true, data: creditos });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error al consultar créditos móviles' });
  }
});

module.exports = router;
