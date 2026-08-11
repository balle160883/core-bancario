USE [SIF];
GO

-- 1. Poblar catálogo de permisos en SEC.Permission si no existen
IF NOT EXISTS (SELECT * FROM SEC.Permission WHERE Code = 'USERS_READ')
    INSERT INTO SEC.Permission (Name, Description, Code) VALUES ('Ver Usuarios', 'Visualizar lista de usuarios', 'USERS_READ');

IF NOT EXISTS (SELECT * FROM SEC.Permission WHERE Code = 'USERS_WRITE')
    INSERT INTO SEC.Permission (Name, Description, Code) VALUES ('Gestionar Usuarios', 'Crear y modificar usuarios', 'USERS_WRITE');

IF NOT EXISTS (SELECT * FROM SEC.Permission WHERE Code = 'ROLES_READ')
    INSERT INTO SEC.Permission (Name, Description, Code) VALUES ('Ver Roles', 'Visualizar roles del sistema', 'ROLES_READ');

IF NOT EXISTS (SELECT * FROM SEC.Permission WHERE Code = 'ROLES_WRITE')
    INSERT INTO SEC.Permission (Name, Description, Code) VALUES ('Gestionar Roles', 'Administrar roles y asignar permisos', 'ROLES_WRITE');

IF NOT EXISTS (SELECT * FROM SEC.Permission WHERE Code = 'CASH_OP')
    INSERT INTO SEC.Permission (Name, Description, Code) VALUES ('Operaciones de Caja', 'Realizar depósitos y retiros', 'CASH_OP');

IF NOT EXISTS (SELECT * FROM SEC.Permission WHERE Code = 'MEMBERS_READ')
    INSERT INTO SEC.Permission (Name, Description, Code) VALUES ('Ver Socios', 'Consultar padrón de socios', 'MEMBERS_READ');

IF NOT EXISTS (SELECT * FROM SEC.Permission WHERE Code = 'MEMBERS_WRITE')
    INSERT INTO SEC.Permission (Name, Description, Code) VALUES ('Gestionar Socios', 'Registrar altas y bajas de socios', 'MEMBERS_WRITE');

-- 2. Asignar todos los permisos al rol DESARROLLO_XENIUS (Id: 1) y TECNOLOGIAS DE LA INFORMACION (Id: 2)
INSERT INTO SEC.RolePermissions (Role_Id, Permission_Id)
SELECT 1, Id FROM SEC.Permission WHERE Id NOT IN (SELECT Permission_Id FROM SEC.RolePermissions WHERE Role_Id = 1);

INSERT INTO SEC.RolePermissions (Role_Id, Permission_Id)
SELECT 2, Id FROM SEC.Permission WHERE Id NOT IN (SELECT Permission_Id FROM SEC.RolePermissions WHERE Role_Id = 2);

-- 3. Asignar permisos de caja y consulta al rol TRANSACCIONES A CUENTAS DE CAPTACIÓN (Id: 10)
INSERT INTO SEC.RolePermissions (Role_Id, Permission_Id)
SELECT 10, Id FROM SEC.Permission WHERE Code IN ('CASH_OP', 'MEMBERS_READ')
  AND Id NOT IN (SELECT Permission_Id FROM SEC.RolePermissions WHERE Role_Id = 10);

-- 4. Asignar permisos de crédito y socios al rol PERSONAS CRÉDITO (Id: 5)
INSERT INTO SEC.RolePermissions (Role_Id, Permission_Id)
SELECT 5, Id FROM SEC.Permission WHERE Code IN ('MEMBERS_READ', 'MEMBERS_WRITE')
  AND Id NOT IN (SELECT Permission_Id FROM SEC.RolePermissions WHERE Role_Id = 5);

GO
