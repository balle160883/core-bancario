-- =====================================================================
-- SCRIPT DE OPTIMIZACIÓN Y PERFORMANCE DBA PARA CORE BANCARIO (SIF)
-- Motor: Microsoft SQL Server 2022
-- Base de Datos: SIF
-- =====================================================================

USE [SIF];
GO

PRINT '--- 1. CREANDO ÍNDICES DE ALTO IMPACTO IDENTIFICADOS POR LAS DMVs ---';

-- 1. Índice para Login ultrarrápido en SEC.[User]
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_SEC_User_UserName' AND object_id = OBJECT_ID('SEC.[User]'))
BEGIN
    CREATE NONCLUSTERED INDEX [IX_SEC_User_UserName]
    ON [SEC].[User] ([UserName])
    INCLUDE ([Status], [PasswordHash], [UserType_Id], [Branch_Id], [Person_Id]);
    PRINT '✅ Índice IX_SEC_User_UserName creado.';
END
GO

-- 2. Índice para Saldos de Captación en FUR.AccountBalance (DISPONIBLE)
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_FUR_AccountBalance_Type_Account' AND object_id = OBJECT_ID('FUR.AccountBalance'))
BEGIN
    CREATE NONCLUSTERED INDEX [IX_FUR_AccountBalance_Type_Account]
    ON [FUR].[AccountBalance] ([AccountBalanceType_Id], [Account_Id])
    INCLUDE ([Balance]);
    PRINT '✅ Índice IX_FUR_AccountBalance_Type_Account creado.';
END
GO

-- 3. Índice para Búsqueda de Saldos por Cuenta en FUR.AccountBalance
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_FUR_AccountBalance_Account_Id' AND object_id = OBJECT_ID('FUR.AccountBalance'))
BEGIN
    CREATE NONCLUSTERED INDEX [IX_FUR_AccountBalance_Account_Id]
    ON [FUR].[AccountBalance] ([Account_Id])
    INCLUDE ([AccountBalanceType_Id], [Balance]);
    PRINT '✅ Índice IX_FUR_AccountBalance_Account_Id creado.';
END
GO

-- 4. Índice para Pólizas y Asientos Contables en ACC.JournalEntry
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_ACC_JournalEntry_Journal_Id' AND object_id = OBJECT_ID('ACC.JournalEntry'))
BEGIN
    CREATE NONCLUSTERED INDEX [IX_ACC_JournalEntry_Journal_Id]
    ON [ACC].[JournalEntry] ([Journal_Id])
    INCLUDE ([Debit], [Credit], [Description], [Reference], [LedgerAccount_Id]);
    PRINT '✅ Índice IX_ACC_JournalEntry_Journal_Id creado.';
END
GO

-- 5. Índice para Relaciones de Socios / Avales en PER.RelationShip
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_PER_RelationShip_Confirmed_Active' AND object_id = OBJECT_ID('PER.RelationShip'))
BEGIN
    CREATE NONCLUSTERED INDEX [IX_PER_RelationShip_Confirmed_Active]
    ON [PER].[RelationShip] ([Confirmed], [Active])
    INCLUDE ([PersonDeclareId], [PersonIncludedId], [RelationTypeId]);
    PRINT '✅ Índice IX_PER_RelationShip_Confirmed_Active creado.';
END
GO

-- 6. Índice para Búsqueda Rápida de Socios en PER.Person
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_PER_Person_Active_FriendlyCode' AND object_id = OBJECT_ID('PER.Person'))
BEGIN
    CREATE NONCLUSTERED INDEX [IX_PER_Person_Active_FriendlyCode]
    ON [PER].[Person] ([Active], [FriendlyCode])
    INCLUDE ([Type], [CreationDate], [MemberSince], [RiskLevel], [Blocked]);
    PRINT '✅ Índice IX_PER_Person_Active_FriendlyCode creado.';
END
GO

-- =====================================================================
-- 2. HABILITAR FEATURES AVANZADAS DE SQL SERVER 2022
-- =====================================================================

PRINT '--- 2. CONFIGURANDO QUERY STORE PARA REGRESIÓN AUTOMÁTICA DE PLANES ---';
ALTER DATABASE [SIF] SET QUERY_STORE = ON (
    OPERATION_MODE = READ_WRITE,
    CLEANUP_POLICY = (STALE_QUERY_THRESHOLD_DAYS = 30),
    DATA_FLUSH_INTERVAL_SECONDS = 900,
    MAX_STORAGE_SIZE_MB = 1000,
    QUERY_CAPTURE_MODE = AUTO
);
GO

PRINT '--- 3. HABILITAR ACCELERATED DATABASE RECOVERY (ADR) ---';
-- ADR permite rollbacks instantáneos y recuperación rápida tras cortes de energía
ALTER DATABASE [SIF] SET ACCELERATED_DATABASE_RECOVERY = ON;
GO

PRINT '--- 4. ACTUALIZANDO ESTADÍSTICAS EN TABLAS PRINCIPALES ---';
UPDATE STATISTICS [PER].[Person] WITH FULLSCAN;
UPDATE STATISTICS [FUR].[Account] WITH FULLSCAN;
UPDATE STATISTICS [FUR].[AccountBalance] WITH FULLSCAN;
UPDATE STATISTICS [LOA].[Loan] WITH FULLSCAN;
UPDATE STATISTICS [LOA].[LoanBalance] WITH FULLSCAN;
PRINT '✅ Estadísticas actualizadas con FULLSCAN.';
GO
