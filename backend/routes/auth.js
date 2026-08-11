const express = require('express');
const router = express.Router();
const { query, sql } = require('../config/database');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pbkdf2 = require('pbkdf2');

/**
 * Verifica el hash de ASP.NET Identity v2
 * Formato: 1 byte (0x00) + 16 bytes salt + 32 bytes SHA1 PBKDF2 (1000 iteraciones)
 */
function verifyAspNetIdentityV2(password, base64Hash) {
  try {
    const hashBytes = Buffer.from(base64Hash, 'base64');
    if (hashBytes.length !== 49 || hashBytes[0] !== 0x00) return false;

    const salt       = hashBytes.slice(1, 17);   // 16 bytes de sal
    const storedHash = hashBytes.slice(17, 49);  // 32 bytes del hash

    // PBKDF2 con HMACSHA1, 1000 iteraciones, 32 bytes de salida
    const derived = pbkdf2.pbkdf2Sync(
      Buffer.from(password, 'utf8'),
      salt,
      1000,
      32,
      'sha1'
    );

    return crypto.timingSafeEqual(storedHash, derived);
  } catch (e) {
    return false;
  }
}

/**
 * POST /api/auth/login
 * Autentica el usuario contra SEC.User con hash ASP.NET Identity v2
 */
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Usuario y contraseña requeridos' });
  }

  try {
    const result = await query(
      `SELECT TOP 1
         u.Id, u.UserName, u.PasswordHash, u.Status,
         u.LastLoginDateUtc, u.Branch_Id, u.Person_Id,
         ut.Name AS UserTypeName,
         ut.Id   AS UserTypeId
       FROM SEC.[User] u
       LEFT JOIN SEC.UserType ut ON u.UserType_Id = ut.Id
       WHERE u.UserName = @username`,
      [{ name: 'username', type: sql.NVarChar(100), value: username.toUpperCase() }]
    );

    if (!result.recordset.length) {
      return res.status(401).json({ success: false, message: 'Usuario no encontrado' });
    }

    const user = result.recordset[0];

    if (user.Status !== 1) {
      return res.status(401).json({ success: false, message: 'Usuario inactivo o bloqueado' });
    }

    // Verificar password con ASP.NET Identity v2
    const passwordOk = verifyAspNetIdentityV2(password, user.PasswordHash);
    if (!passwordOk) {
      return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
    }

    // Obtener roles del usuario
    const rolesResult = await query(
      `SELECT r.Name FROM SEC.UsersRoles ur
       JOIN SEC.Role r ON ur.Role_Id = r.Id
       WHERE ur.User_Id = @userId`,
      [{ name: 'userId', type: sql.BigInt, value: user.Id }]
    ).catch(() => ({ recordset: [] }));

    // Obtener sucursales asignadas
    const branchResult = await query(
      `SELECT b.Id, b.Name FROM SEC.UsersBranchesAssign uba
       JOIN GEN.Branch b ON uba.Branch_Id = b.Id
       WHERE uba.User_Id = @userId`,
      [{ name: 'userId', type: sql.BigInt, value: user.Id }]
    ).catch(() => ({ recordset: [] }));

    const roles    = rolesResult.recordset.map(r => r.Name);
    const branches = branchResult.recordset;

    // Generar token JWT
    const token = jwt.sign(
      {
        id:         user.Id,
        username:   user.UserName,
        userType:   user.UserTypeName,
        userTypeId: user.UserTypeId,
        personId:   user.Person_Id,
        branchId:   user.Branch_Id,
        roles,
        branches,
      },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    res.json({
      success: true,
      token,
      user: {
        id:          user.Id,
        username:    user.UserName,
        userType:    user.UserTypeName,
        userTypeId:  user.UserTypeId,
        personId:    user.Person_Id,
        branchId:    user.Branch_Id,
        roles,
        branches,
        lastLogin:   user.LastLoginDateUtc,
      },
    });
  } catch (err) {
    console.error('Error en login:', err);
    res.status(500).json({ success: false, message: 'Error interno del servidor', detail: err.message });
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
  res.json({ success: true, message: 'Sesión cerrada correctamente' });
});

/**
 * GET /api/auth/me
 */
router.get('/me', require('../middleware/auth'), (req, res) => {
  res.json({ success: true, user: req.user });
});

module.exports = router;
