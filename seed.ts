import "dotenv/config";
import fs from "fs";
import path from "path";
import { config } from "@mssql/lib/config";
import { MssqlORM } from "../mssqlOrm";

let bcrypt: any;
try {
  bcrypt = require("bcryptjs");
} catch {
  bcrypt = { hash: async (s: string) => s };
}

const connectionString = process.env.DATABASE_URL;

// Create ORM client instance. If it fails, fall back to raw mssql seeding.
let db: MssqlORM | null = null;
let dbLoadError: any = null;
try {
  if (connectionString) {
    db = new MssqlORM();
  }
} catch (e: any) {
  dbLoadError = e;
  console.log('Database client failed to initialize:', e?.message ?? e);
  console.log('Falling back to raw mssql seeding.');
}

async function main() {
  console.log("🌱 Seeding LLM providers from llm-config.json...");

  try {
    // Only check table existence if db client initialized successfully
    if (db) {
      await db.lLMProvider.findMany({ take: 1 });

      // Ensure mcp_servers table exists
      await db.$executeRawUnsafe(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'mcp_servers')
        BEGIN
            CREATE TABLE [mcp_servers] (
              [id] NVARCHAR(255) NOT NULL PRIMARY KEY,
              [name] NVARCHAR(255) NOT NULL,
              [command] NVARCHAR(255) NOT NULL,
              [args] NVARCHAR(MAX) NOT NULL,
              [env] NVARCHAR(MAX) NULL,
              [isActive] BIT NOT NULL DEFAULT 1,
              [createdAt] DATETIME2 NOT NULL DEFAULT CURRENT_TIMESTAMP,
              [updatedAt] DATETIME2 NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        END
      `);
      console.log("✅ Verified mcp_servers table exists or created.");

      // Ensure pipeline_packages table exists
      await db.$executeRawUnsafe(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'pipeline_packages')
        BEGIN
            CREATE TABLE [pipeline_packages] (
              [id] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
              [name] NVARCHAR(255) NOT NULL UNIQUE,
              [description] NVARCHAR(MAX) NULL,
              [definition] NVARCHAR(MAX) NOT NULL,
              [generatedSql] NVARCHAR(MAX) NULL,
              [lastRunAt] DATETIME2 NULL,
              [lastStatus] NVARCHAR(50) NOT NULL DEFAULT 'idle',
              [createdAt] DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
              [updatedAt] DATETIME2 NOT NULL DEFAULT SYSDATETIME()
            );
        END
      `);
      console.log("✅ Verified pipeline_packages table exists or created.");

      // Ensure pipeline_execution_logs table exists
      await db.$executeRawUnsafe(`
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'pipeline_execution_logs')
        BEGIN
            CREATE TABLE [pipeline_execution_logs] (
              [id] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
              [packageId] UNIQUEIDENTIFIER NOT NULL,
              [packageName] NVARCHAR(255) NOT NULL,
              [status] NVARCHAR(50) NOT NULL DEFAULT 'running',
              [rowsAffected] INT NULL,
              [durationMs] INT NULL,
              [errorMessage] NVARCHAR(MAX) NULL,
              [executedSql] NVARCHAR(MAX) NULL,
              [connectionId] NVARCHAR(255) NULL,
              [startedAt] DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
              [finishedAt] DATETIME2 NULL
            );
            CREATE INDEX [idx_ssis_exec_logs_packageId] ON [pipeline_execution_logs] ([packageId]);
            CREATE INDEX [idx_ssis_exec_logs_startedAt] ON [pipeline_execution_logs] ([startedAt] DESC);
        END
      `);
      console.log("✅ Verified pipeline_execution_logs table exists or created.");
    } else {
      console.log('⚠️  Database client not available yet; will attempt fallback after reading config.');
    }
  } catch (error) {
    console.error("❌ Error checking LLM Provider table:", error);
    console.log("⚠️  LLM Provider table not found. Run migrations first:");
    console.log("   npx mssql migrate dev");
    return;
  }

  // Use centralized config
  const cfg = config.llm;

  if (!cfg.providers || !Array.isArray(cfg.providers)) {
    console.error("❌ Invalid config: providers array not found");
    return;
  }

  // If db client failed to initialize, run fallback seeder and exit early.
  if (!db && dbLoadError) {
    await runFallbackMssqlSeed(cfg);
    return;
  }

  // Seed each provider
  for (const provider of cfg.providers) {
    try {
      const providerData = {
        provider: provider.provider,
        model: provider.model,
        modelType: provider.modelType,
        apiKey: provider.apiKey || "",
        apiEndpoint: provider.apiEndpoint,
        ...(provider.modelType === "chat" && {
          temperature: provider.temperature,
          maxTokens: provider.maxTokens,
          topP: provider.topP,
          topK: provider.topK,
          minP: provider.minP,
          presencePenalty: provider.presencePenalty,
          repetitionPenalty: provider.repetitionPenalty,
          chatTemplateKwargs: provider.chatTemplateKwargs,
        }),
        ...(provider.modelType === "embedding" && {
          dimensions: provider.dimensions,
        }),
        supportsVision: provider.supportsVision || false,
        isActive: provider.isActive,
        isDefault: provider.isDefault,
        description: provider.description,
      };

      await db.lLMProvider.upsert({
        where: { name: provider.name },
        update: providerData,
        create: {
          name: provider.name,
          ...providerData,
        },
      });
      console.log(`✅ Created/Updated: ${provider.name}`);
    } catch (error) {
      console.log(`⚠️  Skipped: ${provider.name} (conflict or error)`);
    }
  }

  console.log("🎉 LLM seeding completed!");

  // Setup user relations
  console.log("🔧 Setting up user relations...");

  try {
    // Create or update admin user
    const hashedPassword = await bcrypt.hash("admin2025", 10);
    const adminUser = await db.user.upsert({
      where: { email: "admin@local.com" },
      update: {
        password: hashedPassword,
        type: "admin",
        name: "Admin",
        isActive: true,
      },
      create: {
        email: "admin@local.com",
        password: hashedPassword,
        type: "admin",
        name: "Admin",
        isActive: true,
      },
    });
    console.log("✅ Admin user ready:", adminUser.email);

    // Update existing files and jobs to admin user
    const filesUpdated = await db.file.updateMany({
      where: { userId: "00000000-0000-0000-0000-000000000000" },
      data: { userId: adminUser.id },
    });
    console.log(`✅ Updated ${filesUpdated.count} files`);

    console.log("🎉 User relations setup completed!");
  } catch (error) {
    console.error("❌ Error setting up user relations:", error);
  }

  // Seed database connections
  console.log("🔧 Seeding database connections...");

  try {
    const dbConnections = loadDbConnectionsFromEnv();

    for (const conn of dbConnections) {
      try {
        const connData = {
          host: conn.host,
          database: conn.database,
          username: conn.username,
          password: conn.password,
          type: conn.type,
          isActive: true,
        };

        await db.databaseConnection.upsert({
          where: { name: conn.name },
          update: connData,
          create: {
            name: conn.name,
            port: 1433,
            ...connData,
          },
        });
        console.log(`✅ Created/Updated database connection: ${conn.name}`);
      } catch (error) {
        console.log(
          `⚠️  Skipped database connection: ${conn.name} (conflict or error)`,
        );
      }
    }

    console.log("🎉 Database connections seeding completed!");
  } catch (error) {
    console.error("❌ Error seeding database connections:", error);
  }


  console.log("🎉 All seeding completed!");
}

main()
  .catch((e) => {
    console.error("❌ Error seeding database:", e);
    process.exit(1);
  })
  .finally(async () => {
    if (db) {
      await db.$disconnect();
    }
  });


function loadDbConnectionsFromEnv(): { name: string; host: string; database: string; username: string; password: string; type: string }[] {
  const raw = process.env.DB_CONNECTIONS;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      console.warn("⚠️  DB_CONNECTIONS env var is not valid JSON. Using empty list.");
      return [];
    }
  }
  return [];
}

async function runFallbackMssqlSeed(config: any) {
  // Minimal fallback seeder using `mssql` for SQL Server when mssqlOrm cannot
  // initialize (e.g. missing adapter). This performs basic upserts for
  // providers, admin user and database connections.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sql = require('mssql');

  const pool = new sql.ConnectionPool(connectionString);
  try {
    await pool.connect();

    // Ensure mcp_servers table exists in fallback seeder
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'mcp_servers')
      BEGIN
          CREATE TABLE [mcp_servers] (
            [id] NVARCHAR(255) NOT NULL PRIMARY KEY,
            [name] NVARCHAR(255) NOT NULL,
            [command] NVARCHAR(255) NOT NULL,
            [args] NVARCHAR(MAX) NOT NULL,
            [env] NVARCHAR(MAX) NULL,
            [isActive] BIT NOT NULL DEFAULT 1,
            [createdAt] DATETIME2 NOT NULL DEFAULT CURRENT_TIMESTAMP,
            [updatedAt] DATETIME2 NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
      END
    `);
    console.log("✅ Fallback: Verified mcp_servers table exists or created.");

    // Ensure pipeline_packages table exists in fallback seeder
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'pipeline_packages')
      BEGIN
          CREATE TABLE [pipeline_packages] (
            [id] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
            [name] NVARCHAR(255) NOT NULL UNIQUE,
            [description] NVARCHAR(MAX) NULL,
            [definition] NVARCHAR(MAX) NOT NULL,
            [generatedSql] NVARCHAR(MAX) NULL,
            [lastRunAt] DATETIME2 NULL,
            [lastStatus] NVARCHAR(50) NOT NULL DEFAULT 'idle',
            [createdAt] DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
            [updatedAt] DATETIME2 NOT NULL DEFAULT SYSDATETIME()
          );
      END
    `);
    console.log("✅ Fallback: Verified pipeline_packages table exists or created.");

    // Ensure pipeline_execution_logs table exists in fallback seeder
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'pipeline_execution_logs')
      BEGIN
          CREATE TABLE [pipeline_execution_logs] (
            [id] UNIQUEIDENTIFIER NOT NULL PRIMARY KEY DEFAULT NEWID(),
            [packageId] UNIQUEIDENTIFIER NOT NULL,
            [packageName] NVARCHAR(255) NOT NULL,
            [status] NVARCHAR(50) NOT NULL DEFAULT 'running',
            [rowsAffected] INT NULL,
            [durationMs] INT NULL,
            [errorMessage] NVARCHAR(MAX) NULL,
            [executedSql] NVARCHAR(MAX) NULL,
            [connectionId] NVARCHAR(255) NULL,
            [startedAt] DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
            [finishedAt] DATETIME2 NULL
          );
          CREATE INDEX [idx_ssis_exec_logs_packageId] ON [pipeline_execution_logs] ([packageId]);
          CREATE INDEX [idx_ssis_exec_logs_startedAt] ON [pipeline_execution_logs] ([startedAt] DESC);
      END
    `);
    console.log("✅ Fallback: Verified pipeline_execution_logs table exists or created.");

    // Seed providers
    for (const provider of config.providers) {
      const req = pool.request();
      req.input('name', sql.NVarChar(sql.MAX), provider.name);
      req.input('provider', sql.NVarChar(sql.MAX), provider.provider ?? null);
      req.input('model', sql.NVarChar(sql.MAX), provider.model ?? null);
      req.input('modelType', sql.NVarChar(sql.MAX), provider.modelType ?? null);
      req.input('apiKey', sql.NVarChar(sql.MAX), provider.apiKey ?? null);
      req.input('apiEndpoint', sql.NVarChar(sql.MAX), provider.apiEndpoint ?? null);
      req.input('supportsVision', sql.Bit, provider.supportsVision ? 1 : 0);
      req.input('isActive', sql.Bit, provider.isActive ? 1 : 0);
      req.input('isDefault', sql.Bit, provider.isDefault ? 1 : 0);
      req.input('description', sql.NVarChar(sql.MAX), provider.description ?? null);
      req.input('dimensions', sql.Int, provider.dimensions ?? null);

      const upsertSql = `
IF EXISTS (SELECT 1 FROM llm_providers WHERE name = @name)
BEGIN
  UPDATE llm_providers SET provider=@provider, model=@model, modelType=@modelType, apiKey=@apiKey, apiEndpoint=@apiEndpoint, supportsVision=@supportsVision, isActive=@isActive, isDefault=@isDefault, description=@description, dimensions=@dimensions WHERE name=@name;
END
ELSE
BEGIN
  INSERT INTO llm_providers (name, provider, model, modelType, apiKey, apiEndpoint, supportsVision, isActive, isDefault, description, dimensions)
  VALUES (@name,@provider,@model,@modelType,@apiKey,@apiEndpoint,@supportsVision,@isActive,@isDefault,@description,@dimensions);
END`;

      await req.query(upsertSql);
      console.log(`✅ Fallback Created/Updated provider: ${provider.name}`);
    }

    // Admin user upsert
    const adminEmail = 'admin@local.com';
    const hashedPassword = await bcrypt.hash('admin2025', 10);
    const reqUser = pool.request();
    reqUser.input('email', sql.NVarChar(sql.MAX), adminEmail);
    reqUser.input('password', sql.NVarChar(sql.MAX), hashedPassword);
    const userSql = `
IF EXISTS (SELECT 1 FROM users WHERE email = @email)
BEGIN
  UPDATE users SET password=@password, type='admin', name='Admin', isActive=1, updatedAt=SYSDATETIME() WHERE email=@email;
END
ELSE
BEGIN
  INSERT INTO users (id, email, password, type, name, isActive, createdAt, updatedAt)
  VALUES (NEWID(), @email, @password, 'admin', 'Admin', 1, SYSDATETIME(), SYSDATETIME());
END`;
    await reqUser.query(userSql);

    // Get admin id
    const res = await pool.request().input('email', sql.NVarChar(sql.MAX), adminEmail).query('SELECT id FROM users WHERE email = @email');
    const adminId = res.recordset?.[0]?.id;
    if (adminId) {
      await pool.request().input('adminId', sql.NVarChar(sql.MAX), adminId).query("UPDATE files SET userId = @adminId WHERE userId = '00000000-0000-0000-0000-000000000000'");
      console.log('✅ Fallback admin user ready and files updated');
    }

    // Seed database connections
    const dbConnections = [
      // same list as in-memory above — reuse the original list by reconstructing
    ];

    const connections = loadDbConnectionsFromEnv();

    for (const conn of connections) {
      const r = pool.request();
      r.input('name', sql.NVarChar(sql.MAX), conn.name);
      r.input('host', sql.NVarChar(sql.MAX), conn.host);
      r.input('database', sql.NVarChar(sql.MAX), conn.database);
      r.input('username', sql.NVarChar(sql.MAX), conn.username);
      r.input('password', sql.NVarChar(sql.MAX), conn.password);
      r.input('type', sql.NVarChar(sql.MAX), conn.type);

      const upsertConn = `
IF EXISTS (SELECT 1 FROM database_connections WHERE name = @name)
BEGIN
  UPDATE database_connections SET host=@host, database=@database, username=@username, password=@password, type=@type, isActive=1 WHERE name=@name;
END
ELSE
BEGIN
  INSERT INTO database_connections (id, name, host, port, database, username, password, type, isActive, createdAt, updatedAt)
  VALUES (NEWID(), @name, @host, 1433, @database, @username, @password, @type, 1, SYSDATETIME(), SYSDATETIME());
END`;

      await r.query(upsertConn);
      console.log(`✅ Fallback Created/Updated connection: ${conn.name}`);
    }

    console.log('🎉 Fallback seeding completed');
  } catch (err) {
    console.error('❌ Fallback seeding failed:', err);
  } finally {
    try {
      await pool.close();
    } catch (_) { }
  }
}
