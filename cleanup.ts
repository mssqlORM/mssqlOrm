import "dotenv/config";
import { MssqlAdapter } from "mssql-adapters";
import fs from "fs";
import path from "path";

const rootDir = path.join(__dirname, "../");
let config: any = {};
try {
  const configPath = path.join(rootDir, "mssqlOrm.config.js");
  if (fs.existsSync(configPath)) {
    config = require(configPath);
  }
} catch (err) {
  console.warn("⚠️ Could not load config file in cleanup.ts, using defaults.");
}

const schemaDir = path.resolve(rootDir, config.schemaDir || "mssqlSchema");

let _adapter: MssqlAdapter | null = null;
async function getDb(): Promise<MssqlAdapter> {
  if (!_adapter) {
    _adapter = new MssqlAdapter({ connectionString: process.env.DATABASE_URL! });
    await _adapter.$connect();
  }
  return _adapter;
}

async function cleanup() {
  console.log("🧹 Starting database cleanup...");

  let schemaText = "";
  if (fs.existsSync(schemaDir)) {
    const files = fs.readdirSync(schemaDir).filter(f => f.endsWith(".mssql"));
    for (const file of files) {
      schemaText += fs.readFileSync(path.join(schemaDir, file), "utf8") + "\n";
    }
  } else {
    const schemaPath = path.join(__dirname, "schema.mssql");
    if (fs.existsSync(schemaPath)) {
      schemaText = fs.readFileSync(schemaPath, "utf8");
    } else {
      console.error("No schema found!");
      process.exit(1);
    }
  }

  const lines = schemaText.split("\n");
  
  const validTables = new Set<string>();

  for (let line of lines) {
    line = line.trim();
    if (line.startsWith("model ")) {
      const modelName = line.split(" ")[1].replace("{", "").trim();
      // Default table name is model name + 's' (lowercase)
      validTables.add(modelName.toLowerCase() + "s");
    }
    if (line.startsWith("@@map")) {
      const mapMatch = line.match(/@@map\("(.+)"\)/);
      if (mapMatch) {
        // The last model's default name should be replaced by the map name
        // Since we add the default name first, we need to be careful.
        // Actually, let's just add the map name.
        validTables.add(mapMatch[1]);
      }
    }
  }

  // Also include the capitalization variations from mssqlMetadata if we can, 
  // but schema.mssql is the source of truth.
  
  console.log("Valid tables from schema:", Array.from(validTables));

  const dbTables = await (await getDb()).$queryRawUnsafe<any[]>(`
    SELECT name FROM sys.tables WHERE is_ms_shipped = 0
  `);

  const tablesToDrop = dbTables
    .map(t => t.name)
    .filter(name => !validTables.has(name) && !validTables.has(name.toLowerCase()));

  if (tablesToDrop.length === 0) {
    console.log("✅ No extra tables found. Database is clean.");
    process.exit(0);
  }

  console.log("Tables to be DROPPED:", tablesToDrop);

  for (const table of tablesToDrop) {
    console.log(`Dropping table [${table}]...`);
    try {
      // We need to handle foreign key constraints. 
      // For a thorough cleanup, we might need to drop constraints first.
      // But for now, we'll try a simple DROP TABLE.
      await (await getDb()).$executeRawUnsafe(`DROP TABLE [${table}]`);
      console.log(`✅ Dropped [${table}]`);
    } catch (err: any) {
      console.error(`❌ Failed to drop [${table}]: ${err.message}`);
      if (err.message.includes("FOREIGN KEY constraint")) {
          console.log(`Attempting to find and drop constraints for [${table}]...`);
          const constraints = await (await getDb()).$queryRawUnsafe<any[]>(`
            SELECT fk.name AS constraint_name, OBJECT_NAME(fk.parent_object_id) AS table_name
            FROM sys.foreign_keys AS fk
            WHERE OBJECT_NAME(fk.referenced_object_id) = @p_0 OR OBJECT_NAME(fk.parent_object_id) = @p_0
          `, table);
          
          for (const c of constraints) {
              console.log(`Dropping constraint [${c.constraint_name}] on [${c.table_name}]...`);
              await (await getDb()).$executeRawUnsafe(`ALTER TABLE [${c.table_name}] DROP CONSTRAINT [${c.constraint_name}]`);
          }
          // Try dropping again
          await (await getDb()).$executeRawUnsafe(`DROP TABLE [${table}]`);
          console.log(`✅ Dropped [${table}] after removing constraints.`);
      }
    }
  }

  console.log("✅ Cleanup completed.");
  process.exit(0);
}

cleanup().catch(err => {
  console.error("❌ Cleanup failed:", err);
  process.exit(1);
});
