const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const auth = require('../middleware/auth');

router.use(auth);

/**
 * GET /api/seguridad/usuarios — Lista de usuarios del sistema con sus roles
 */
router.get('/usuarios', async (req, res) => {
  try {
    const result = await query(`
      SELECT TOP 100
        u.Id,
        u.UserName,
        u.Status AS Estado,
        u.LastLoginDateUtc AS UltimoAcceso,
        ut.Name AS TipoUsuario,
        b.Name AS SucursalPrincipal,
        (
          SELECT STRING_AGG(r.Name, ', ')
          FROM SEC.UsersRoles ur
          JOIN SEC.Role r ON ur.Role_Id = r.Id
          WHERE ur.User_Id = u.Id
        ) AS RolesAsignados
      FROM SEC.[User] u
      LEFT JOIN SEC.UserType ut ON u.UserType_Id = ut.Id
      LEFT JOIN GEN.Branch b ON u.Branch_Id = b.Id
      ORDER BY u.Id ASC
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Error usuarios:', err);
    res.status(500).json({ success: false, message: 'Error al obtener usuarios', detail: err.message });
  }
});

/**
 * GET /api/seguridad/roles — Catálogo de roles del sistema SEC.Role con permisos
 */
router.get('/roles', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        r.Id,
        r.Name AS NombreRol,
        COUNT(DISTINCT ur.User_Id) AS TotalUsuariosAsignados,
        COUNT(DISTINCT rp.Permission_Id) AS TotalPermisosAsignados
      FROM SEC.Role r
      LEFT JOIN SEC.UsersRoles ur ON r.Id = ur.Role_Id
      LEFT JOIN SEC.RolePermissions rp ON r.Id = rp.Role_Id
      GROUP BY r.Id, r.Name
      ORDER BY r.Name ASC
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Error roles:', err);
    res.status(500).json({ success: false, message: 'Error al obtener catálogo de roles', detail: err.message });
  }
});

/**
 * GET /api/seguridad/permisos — Catálogo general de permisos SEC.Permission
 */
router.get('/permisos', async (req, res) => {
  try {
    const result = await query(`
      SELECT Id, Name AS Nombre, Description AS Descripcion, Code AS Codigo
      FROM SEC.Permission
      ORDER BY Id ASC
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error al obtener catálogo de permisos' });
  }
});

/**
 * GET /api/seguridad/roles/:id/permisos — Permisos de un rol en SEC.RolePermissions
 */
router.get('/roles/:id/permisos', async (req, res) => {
  const roleId = parseInt(req.params.id);
  try {
    const result = await query(`
      SELECT p.Id, p.Name AS Nombre, p.Code AS Codigo, p.Description AS Descripcion
      FROM SEC.RolePermissions rp
      JOIN SEC.Permission p ON rp.Permission_Id = p.Id
      WHERE rp.Role_Id = @roleId
    `, [{ name: 'roleId', type: sql.BigInt, value: roleId }]);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error al obtener permisos del rol' });
  }
});

/**
 * POST /api/seguridad/roles/:id/permisos — Asignar/Guardar permisos a un rol
 */
router.post('/roles/:id/permisos', async (req, res) => {
  const roleId = parseInt(req.params.id);
  const { permissionIds = [] } = req.body;

  try {
    // 1. Eliminar permisos previos del rol
    await query(`DELETE FROM SEC.RolePermissions WHERE Role_Id = @roleId`, [
      { name: 'roleId', type: sql.BigInt, value: roleId }
    ]);

    // 2. Insertar nuevos permisos
    for (const pId of permissionIds) {
      await query(`
        INSERT INTO SEC.RolePermissions (Role_Id, Permission_Id)
        VALUES (@roleId, @pId)
      `, [
        { name: 'roleId', type: sql.BigInt, value: roleId },
        { name: 'pId', type: sql.Int, value: parseInt(pId) }
      ]);
    }

    res.json({ success: true, message: 'Permisos del rol actualizados exitosamente' });
  } catch (err) {
    console.error('Error guardar permisos:', err);
    res.status(500).json({ success: false, message: 'Error al actualizar permisos del rol' });
  }
});

/**
 * POST /api/seguridad/usuarios/:id/asignar-rol — Asignar rol a usuario
 */
router.post('/usuarios/:id/asignar-rol', async (req, res) => {
  const userId = parseInt(req.params.id);
  const { roleId } = req.body;

  if (!userId || !roleId) {
    return res.status(400).json({ success: false, message: 'Usuario y rol son requeridos' });
  }

  try {
    const existe = await query(`
      SELECT 1 FROM SEC.UsersRoles WHERE User_Id = @userId AND Role_Id = @roleId
    `, [
      { name: 'userId', type: sql.BigInt, value: userId },
      { name: 'roleId', type: sql.BigInt, value: parseInt(roleId) }
    ]);

    if (existe.recordset.length) {
      return res.json({ success: true, message: 'El usuario ya cuenta con este rol asignado' });
    }

    await query(`
      INSERT INTO SEC.UsersRoles (User_Id, Role_Id)
      VALUES (@userId, @roleId)
    `, [
      { name: 'userId', type: sql.BigInt, value: userId },
      { name: 'roleId', type: sql.BigInt, value: parseInt(roleId) }
    ]);

    res.json({ success: true, message: 'Rol asignado correctamente al usuario' });

  } catch (err) {
    console.error('Error asignar rol:', err);
    res.status(500).json({ success: false, message: 'Error al asignar rol', detail: err.message });
  }
});

/**
 * GET /api/seguridad/auditoria — Bitácora de auditoría de seguridad SEC.Audit
 */
router.get('/auditoria', async (req, res) => {
  try {
    const result = await query(`
      SELECT TOP 100
        a.Id,
        a.CreatedAt AS Fecha,
        a.Username AS Usuario,
        a.Action AS Accion,
        a.EntityName AS Entidad,
        a.Ip,
        a.NewValue AS Detalle
      FROM SEC.Audit a
      ORDER BY a.CreatedAt DESC
    `);

    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Error auditoria:', err);
    res.status(500).json({ success: false, message: 'Error al obtener bitácora de auditoría', detail: err.message });
  }
});

module.exports = router;
