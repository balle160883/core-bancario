const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const auth = require('../middleware/auth');

router.use(auth);

/**
 * GET /api/socios?page=1&limit=20&search=
 */
router.get('/', async (req, res) => {
  const { page = 1, limit = 20, search = '' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const result = await query(`
      SELECT
        p.Id,
        p.Active,
        CASE WHEN p.Type = 1 THEN 'Física' ELSE 'Moral' END AS TipoPersona,
        ISNULL(
          ip.Name + ' ' + ISNULL(ip.SecondName + ' ', '') + ip.Surname + ISNULL(' ' + ip.SecondSurname, ''),
          cp.Name
        ) AS NombreCompleto,
        p.FriendlyCode AS NumSocio,
        p.CreationDate AS FechaAlta,
        p.MemberSince  AS FechaIngreso,
        COUNT(*) OVER() AS TotalRegistros
      FROM PER.Person p
      LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
      LEFT JOIN PER.CorporatePerson  cp ON p.Id = cp.PersonId
      WHERE p.Active = 1
        AND (@search = '' OR
             ip.Name + ' ' + ISNULL(ip.Surname,'') LIKE @searchLike OR
             cp.Name LIKE @searchLike OR
             p.FriendlyCode LIKE @searchLike
        )
      ORDER BY p.Id DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `, [
      { name: 'offset',     type: sql.Int,           value: offset },
      { name: 'limit',      type: sql.Int,           value: parseInt(limit) },
      { name: 'search',     type: sql.NVarChar(100), value: search },
      { name: 'searchLike', type: sql.NVarChar(100), value: `%${search}%` },
    ]);

    const total = result.recordset[0]?.TotalRegistros || 0;
    res.json({
      success: true,
      data: result.recordset,
      pagination: {
        page:  parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error('Error socios lista:', err);
    res.status(500).json({ success: false, message: 'Error al obtener socios', detail: err.message });
  }
});

/**
 * GET /api/socios/stats — Desglose de socios físicos y morales
 */
router.get('/stats', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        SUM(CASE WHEN Type = 1 THEN 1 ELSE 0 END) AS fisicas,
        SUM(CASE WHEN Type = 2 THEN 1 ELSE 0 END) AS morales
      FROM PER.Person
      WHERE Active = 1
    `);
    res.json({ success: true, data: result.recordset[0] || { fisicas: 0, morales: 0 } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error stats socios' });
  }
});

/**
 * GET /api/socios/:id — Expediente completo del socio
 */
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [persona, identificaciones, cuentas, creditos] = await Promise.all([

      // Datos personales principales
      query(`
        SELECT
          p.Id, p.Active, p.Type, p.CreationDate, p.MemberSince, p.FriendlyCode,
          p.RiskLevel, p.PoliticallyExposed, p.Blocked,
          ip.Name AS Nombre, ip.SecondName AS SegundoNombre,
          ip.Surname AS Apellido, ip.SecondSurname AS SegundoApellido,
          ip.Gender,
          cp.Name AS RazonSocial
        FROM PER.Person p
        LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
        LEFT JOIN PER.CorporatePerson  cp ON p.Id = cp.PersonId
        WHERE p.Id = @id
      `, [{ name: 'id', type: sql.BigInt, value: id }]),

      // Identificaciones (PER.IdentificationData + PER.Identification catálogo)
      query(`
        SELECT
          idd.Value,
          ic.Name AS Tipo,
          idd.Expire AS FechaExpiracion,
          idd.Active
        FROM PER.IdentificationData idd
        JOIN PER.Identification ic ON idd.Identification_Id = ic.Id
        WHERE idd.Person_Id = @id AND idd.Active = 1
        ORDER BY idd.Id ASC
      `, [{ name: 'id', type: sql.BigInt, value: id }]).catch(() => ({ recordset: [] })),

      // Cuentas de ahorro
      query(`
        SELECT TOP 10
          a.Id AS CuentaId,
          a.FriendlyCode,
          fp.Name AS Producto,
          a.Status,
          ab.Balance AS Saldo,
          a.Created AS FechaApertura
        FROM FUR.Account a
        JOIN FUR.Product fp         ON a.Product_Id = fp.Id
        JOIN FUR.AccountBalance ab  ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
        JOIN FUR.Holder h           ON a.Id = h.AccountId AND h.PersonId = @id
        ORDER BY a.Created DESC
      `, [{ name: 'id', type: sql.BigInt, value: id }]).catch(() => ({ recordset: [] })),

      // Créditos
      query(`
        SELECT TOP 10
          l.Id AS CreditoId,
          l.FriendlyCode,
          cp.Name AS Producto,
          l.State,
          l.OriginationDate,
          l.MaturityDate,
          lb.CurrentBalance AS SaldoCapital,
          l.OriginalPrincipalBalance AS MontoOriginal
        FROM LOA.CreditLine cl
        JOIN LOA.CreditProduct cp ON cl.CreditProduct_Id = cp.Id
        JOIN LOA.Loan l           ON cl.Id = l.CreditLine_Id
        JOIN LOA.LoanBalance lb   ON l.Id = lb.Loan_Id AND lb.LoanBalanceType_Id = 1
        WHERE cl.Person_Id = @id
        ORDER BY l.OriginationDate DESC
      `, [{ name: 'id', type: sql.BigInt, value: id }]).catch(() => ({ recordset: [] })),
    ]);

    if (!persona.recordset.length) {
      return res.status(404).json({ success: false, message: 'Socio no encontrado' });
    }

    res.json({
      success: true,
      data: {
        persona:          persona.recordset[0],
        identificaciones: identificaciones.recordset,
        cuentas:          cuentas.recordset,
        creditos:         creditos.recordset,
      },
    });
  } catch (err) {
    console.error('Error expediente:', err);
    res.status(500).json({ success: false, message: 'Error al obtener expediente', detail: err.message });
  }
});

module.exports = router;
