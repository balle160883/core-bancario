const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const auth = require('../middleware/auth');

router.use(auth);

/**
 * GET /api/captacion — Cuentas de ahorro e inversión
 */
router.get('/', async (req, res) => {
  const { page = 1, limit = 20, search = '' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const result = await query(`
      SELECT
        a.Id AS CuentaId,
        a.FriendlyCode AS NumCuenta,
        fp.Name AS Producto,
        ISNULL(
          ip.Name + ' ' + ISNULL(ip.Surname, ''),
          cp.Name
        ) AS Socio,
        p.FriendlyCode AS NumSocio,
        ab.Balance AS Saldo,
        a.Status AS Estado,
        a.Created AS FechaApertura,
        COUNT(*) OVER() AS TotalRegistros
      FROM FUR.Account a
      JOIN FUR.Product fp         ON a.Product_Id = fp.Id
      JOIN FUR.AccountBalance ab  ON a.Id = ab.Account_Id AND ab.AccountBalanceType_Id = 1
      LEFT JOIN FUR.Holder h      ON a.Id = h.AccountId
      LEFT JOIN PER.Person p      ON h.PersonId = p.Id
      LEFT JOIN PER.IndividualPerson ip ON p.Id = ip.PersonId
      LEFT JOIN PER.CorporatePerson  cp ON p.Id = cp.PersonId
      WHERE a.Status IN (1, 2, 3)
        AND (@search = '' OR
             ISNULL(ip.Name + ' ' + ip.Surname, cp.Name) LIKE @searchLike OR
             a.FriendlyCode LIKE @searchLike OR
             p.FriendlyCode LIKE @searchLike)
      ORDER BY a.Id DESC
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
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error('Error captación:', err);
    res.status(500).json({ success: false, message: 'Error al obtener cuentas de captación', detail: err.message });
  }
});

/**
 * GET /api/captacion/:id/movimientos — Últimos movimientos de una cuenta
 */
router.get('/:id/movimientos', async (req, res) => {
  const accountId = parseInt(req.params.id);
  try {
    const result = await query(`
      SELECT TOP 100
        at2.Id,
        at2.[Date] AS Fecha,
        tt.Name AS TipoMovimiento,
        at2.Amount AS Monto,
        at2.Reference AS Referencia,
        at2.Description AS Descripcion
      FROM FUR.AccountTransaction at2
      LEFT JOIN FUR.TransactionType tt ON at2.TransactionType_Id = tt.Id
      WHERE at2.Account_Id = @id
      ORDER BY at2.[Date] DESC
    `, [{ name: 'id', type: sql.BigInt, value: accountId }]);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Error movimientos:', err);
    res.status(500).json({ success: false, message: 'Error al obtener movimientos', detail: err.message });
  }
});

module.exports = router;
