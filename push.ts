import "dotenv/config";
import fs from "fs";
import path from "path";
import { An5Adapter } from "an5-adapters";

const rootDir = path.join(__dirname, "../");
let config: any = {};
try {
  const configPath = path.join(rootDir, "an5Orm.config.js");
  if (fs.existsSync(configPath)) {
    config = require(configPath);
  }
} catch (err) {
  console.warn("⚠️ Could not load config file in push.ts, using defaults.");
}

const schemaDir = path.resolve(rootDir, config.schemaDir || "an5Schema");

let _adapter: An5Adapter | null = null;
async function getDb(): Promise<An5Adapter> {
  if (!_adapter) {
    _adapter = new An5Adapter({ connectionString: process.env.DATABASE_URL! });
    await _adapter.$connect();
  }
  return _adapter;
}

// Supported SQL Server types (base types without params)
const AN5_TYPES = new Set([
  "NVARCHAR", "VARCHAR", "CHAR", "NCHAR", "TEXT", "NTEXT", "XML",
  "INT", "SMALLINT", "TINYINT", "BIGINT", "FLOAT", "REAL", "DECIMAL", "NUMERIC",
  "MONEY", "SMALLMONEY", "BIT",
  "DATETIME", "DATETIME2", "SMALLDATETIME", "DATE", "TIME", "DATETIMEOFFSET",
  "VARBINARY", "BINARY", "IMAGE",
  "UNIQUEIDENTIFIER", "SQL_VARIANT", "ROWVERSION",
  "HIERARCHYID", "GEOGRAPHY", "GEOMETRY", "VECTOR",
]);

// Parse base type from "NVARCHAR(255)" → "NVARCHAR"
function parseSqlType(raw: string): string {
  const match = raw.match(/^(\w+)/);
  return match ? match[1].toUpperCase() : raw.toUpperCase();
}

async function push() {
  let schemaText = "";
  if (fs.existsSync(schemaDir)) {
    const files = fs.readdirSync(schemaDir).filter(f => f.endsWith(".an5"));
    for (const file of files) {
      schemaText += fs.readFileSync(path.join(schemaDir, file), "utf8") + "\n";
    }
  } else {
    const schemaPath = path.join(__dirname, "schema.an5");
    if (fs.existsSync(schemaPath)) {
      schemaText = fs.readFileSync(schemaPath, "utf8");
    } else {
      console.error(`No schema found in ${schemaDir} or schema.an5`);
      process.exit(1);
    }
  }

  const lines = schemaText.split("\n");

  const models: any[] = [];
  let currentModel: any = null;

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("//")) continue;

    const modelHeaderMatch = line.match(/^model\s+(\w+)\s*\{/);
    if (modelHeaderMatch) {
      currentModel = {
        name: modelHeaderMatch[1],
        tableName: modelHeaderMatch[1].toLowerCase() + "s",
        fields: [],
        compoundUniques: [],
        indexes: [],
      };
      models.push(currentModel);
      continue;
    }

    if (line === "}") {
      currentModel = null;
      continue;
    }

    if (currentModel) {
      if (line.startsWith("@@map")) {
        const mapMatch = line.match(/@@map\("(.+)"\)/);
        if (mapMatch) currentModel.tableName = mapMatch[1];
        continue;
      }
      if (line.startsWith("@@unique")) {
        const uniqueMatch = line.match(/@@unique\(\[([\w,\s]+)\]\)/);
        if (uniqueMatch) {
          const fields = uniqueMatch[1].split(",").map(f => f.trim());
          currentModel.compoundUniques.push(fields);
        }
        continue;
      }
      if (line.startsWith("@@index")) {
        const indexMatch = line.match(/@@index\(\[([\w,\s]+)\]\)/);
        if (indexMatch) {
          const fields = indexMatch[1].split(",").map(f => f.trim());
          currentModel.indexes.push(fields);
        }
        continue;
      }
      if (line.startsWith("@@")) continue;

      const parts = line.split(/\s+/);
      const fieldName = parts[0];
      const fieldType = parts[1];

      if (!fieldName || !fieldType) continue;

      // Parse SQL Server type directly
      const cleanType = fieldType.replace("[]", "").replace("?", "");
      const sqlBase = parseSqlType(cleanType);

      // Skip if not a known SQL Server type (might be a relation)
      if (!AN5_TYPES.has(sqlBase)) {
        continue;
      }

      const isOptional = fieldType.endsWith("?");
      const isId = line.includes("@id");
      const isUnique = line.includes("@unique");

      // Use SQL Server type directly - no mapping needed
      const sqlType = cleanType.toUpperCase();

      let defaultValue = "";
      const defaultMatch = line.match(/@default\((.*)\)/);
      if (defaultMatch) {
        const val = defaultMatch[1];
        if (val === "uuid()") defaultValue = "DEFAULT NEWID()";
        else if (val === "cuid()") defaultValue = "DEFAULT NEWID()";
        else if (val === "now()") defaultValue = "DEFAULT CURRENT_TIMESTAMP";
        else if (val === "autoincrement()") defaultValue = "IDENTITY(1,1)";
        else if (val === "true") defaultValue = "DEFAULT 1";
        else if (val === "false") defaultValue = "DEFAULT 0";
        else if (/^".*"$/.test(val)) defaultValue = `DEFAULT '${val.slice(1, -1)}'`;
        else defaultValue = `DEFAULT ${val}`;
      } else if (line.includes("@updatedAt")) {
        defaultValue = "DEFAULT CURRENT_TIMESTAMP";
      }

      currentModel.fields.push({
        name: fieldName,
        sqlType,
        isOptional,
        isId,
        isUnique,
        defaultValue,
      });
    }
  }

  console.log(`🚀 Pushing schema to database...`);

  for (const model of models) {
    console.log(`Processing table [${model.tableName}]...`);

    // Check if table exists
    const tableExists = await (await getDb()).$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sys.tables WHERE name = '${model.tableName}'`
    );

    if (tableExists.length === 0) {
      console.log(`Creating table [${model.tableName}]...`);
      const colDefs = model.fields.map((f: any) => {
        let def = `[${f.name}] ${f.sqlType}`;
        if (f.isId) def += " PRIMARY KEY";
        if (f.defaultValue) def += ` ${f.defaultValue}`;
        if (!f.isOptional && !f.defaultValue && !f.isId) def += " NOT NULL";
        if (f.isUnique && !f.isId) def += " UNIQUE";
        return def;
      });

      // Add compound uniques as table constraints
      if (model.compoundUniques && model.compoundUniques.length > 0) {
        model.compoundUniques.forEach((fields: string[], idx: number) => {
          const constraintName = `UQ_${model.tableName}_compound_${idx}`;
          const fieldsStr = fields.map(f => `[${f}]`).join(", ");
          colDefs.push(`CONSTRAINT [${constraintName}] UNIQUE (${fieldsStr})`);
        });
      }

      const createSql = `CREATE TABLE [${model.tableName}] (\n  ${colDefs.join(",\n  ")}\n)`;
      await (await getDb()).$executeRawUnsafe(createSql);
      console.log(`✅ Table [${model.tableName}] created.`);

      // Create indexes
      if (model.indexes && model.indexes.length > 0) {
        for (let idx = 0; idx < model.indexes.length; idx++) {
          const fields = model.indexes[idx];
          const indexName = `IX_${model.tableName}_${fields.join("_")}`;
          const fieldsStr = fields.map((f: string) => `[${f}]`).join(", ");
          console.log(`Creating index [${indexName}] on table [${model.tableName}]...`);
          await (await getDb()).$executeRawUnsafe(`CREATE INDEX [${indexName}] ON [${model.tableName}] (${fieldsStr})`);
        }
      }
    } else {
      // 1. Check for missing columns
      for (const field of model.fields) {
        const colExists = await (await getDb()).$queryRawUnsafe<{ name: string }[]>(
          `SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('${model.tableName}') AND name = '${field.name}'`
        );

        if (colExists.length === 0) {
          console.log(`Adding column [${field.name}] to table [${model.tableName}]...`);
          let alterSql = `ALTER TABLE [${model.tableName}] ADD [${field.name}] ${field.sqlType}`;
          if (field.defaultValue) alterSql += ` ${field.defaultValue}`;
          if (field.isUnique && !field.isId) alterSql += " UNIQUE";
          if (!field.isOptional && !field.defaultValue) {
             if (!field.defaultValue) alterSql += " NULL";
             else alterSql += " NOT NULL";
          }
          await (await getDb()).$executeRawUnsafe(alterSql);
        }
      }

      // 2. Check for missing compound uniques
      if (model.compoundUniques && model.compoundUniques.length > 0) {
        for (let idx = 0; idx < model.compoundUniques.length; idx++) {
          const fields = model.compoundUniques[idx];
          const constraintName = `UQ_${model.tableName}_compound_${idx}`;

          const constraintExists = await (await getDb()).$queryRawUnsafe<any[]>(
            `SELECT name FROM sys.objects WHERE type = 'UQ' AND parent_object_id = OBJECT_ID('${model.tableName}') AND name = '${constraintName}'`
          );

          if (constraintExists.length === 0) {
            console.log(`Adding compound unique constraint [${constraintName}] to table [${model.tableName}]...`);
            const fieldsStr = fields.map((f: string) => `[${f}]`).join(", ");
            await (await getDb()).$executeRawUnsafe(
              `ALTER TABLE [${model.tableName}] ADD CONSTRAINT [${constraintName}] UNIQUE (${fieldsStr})`
            );
          }
        }
      }

      // 3. Check for missing indexes
      if (model.indexes && model.indexes.length > 0) {
        for (let idx = 0; idx < model.indexes.length; idx++) {
          const fields = model.indexes[idx];
          const indexName = `IX_${model.tableName}_${fields.join("_")}`;

          const indexExists = await (await getDb()).$queryRawUnsafe<any[]>(
            `SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID('${model.tableName}') AND name = '${indexName}'`
          );

          if (indexExists.length === 0) {
            console.log(`Creating index [${indexName}] on table [${model.tableName}]...`);
            const fieldsStr = fields.map((f: string) => `[${f}]`).join(", ");
            await (await getDb()).$executeRawUnsafe(
              `CREATE INDEX [${indexName}] ON [${model.tableName}] (${fieldsStr})`
            );
          }
        }
      }
    }
  }

  console.log("✅ Database push completed.");
  process.exit(0);
}

push().catch((err) => {
  console.error("❌ Push failed:", err);
  process.exit(1);
});
