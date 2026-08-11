USE [SIF];
GO

IF OBJECT_ID('sp_SIF_EjecutarCierreDia', 'P') IS NOT NULL
    DROP PROCEDURE sp_SIF_EjecutarCierreDia;
GO

CREATE PROCEDURE sp_SIF_EjecutarCierreDia
    @UserId BIGINT = 1,
    @BranchId INT = 1
AS
BEGIN
    SET NOCOUNT ON;

    BEGIN TRY
        BEGIN TRANSACTION;

        DECLARE @FechaActual DATE = CAST(GETDATE() AS DATE);
        DECLARE @CreditosDevengados INT = 0;
        DECLARE @CreditosEnMora INT = 0;
        DECLARE @TotalInteresDevengado MONEY = 0;

        -- 1. CLASIFICACIÓN AUTOMÁTICA DE CARTERA VENCIDA
        UPDATE l
        SET l.State = 6
        FROM LOA.Loan l
        WHERE l.State = 7
          AND l.NextDueDay < @FechaActual;

        SET @CreditosEnMora = @@ROWCOUNT;

        -- 2. CÁLCULO DE DEVENGAMIENTO DIARIO DE INTERÉS EN CRÉDITOS VIGENTES
        SELECT 
            @TotalInteresDevengado = ISNULL(SUM((lb.CurrentBalance * (ISNULL(l.InterestRateValue, 24.0) / 100.0)) / 360.0), 0),
            @CreditosDevengados = COUNT(DISTINCT l.Id)
        FROM LOA.Loan l
        JOIN LOA.LoanBalance lb ON l.Id = lb.Loan_Id AND lb.LoanBalanceType_Id = 1
        WHERE l.State IN (7, 6) AND lb.CurrentBalance > 0;

        -- 3. REGISTRO DE LA PÓLIZA CONTABLE DIARIA DE DEVENGAMIENTO
        DECLARE @JournalId BIGINT;
        
        INSERT INTO ACC.Journal (
            [Date], RealDate, Description, Policy, Status, Type, Branch_Id, User_Id, RequestedExternally
        )
        VALUES (
            GETDATE(), GETDATE(), 
            CONCAT('DEVENGAMIENTO DIARIO DE INTERESES DE CARTERA - ', FORMAT(GETDATE(), 'yyyy-MM-dd')),
            CAST(FORMAT(GETDATE(), 'yyyyMMdd') AS INT),
            1, 1, @BranchId, @UserId, 0
        );

        SET @JournalId = SCOPE_IDENTITY();

        -- 4. REGISTRO EN BITÁCORA DE AUDITORÍA (Action <= 50 chars)
        INSERT INTO SEC.Audit (
            CreatedAt, Username, Action, EntityName, Ip, NewValue
        )
        VALUES (
            GETDATE(), 'SISTEMA_CIERRE', 
            'CIERRE_DIA_EXITOSO',
            'LOA.Loan', '127.0.0.1',
            CONCAT('Devengados: ', @CreditosDevengados, ' | Mora: ', @CreditosEnMora, ' | Monto: $', CAST(@TotalInteresDevengado AS NVARCHAR(50)))
        );

        COMMIT TRANSACTION;

        SELECT 
            1 AS Success,
            'Cierre de día y devengamiento ejecutado exitosamente' AS Message,
            @FechaActual AS FechaCierre,
            @CreditosDevengados AS CreditosDevengados,
            @CreditosEnMora AS CreditosIdentificadosEnMora,
            @TotalInteresDevengado AS TotalInteresDevengado,
            @JournalId AS PolizaContableId;

    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        DECLARE @ErrMsg NVARCHAR(4000) = ERROR_MESSAGE();
        RAISERROR(@ErrMsg, 16, 1);
    END CATCH
END;
GO
