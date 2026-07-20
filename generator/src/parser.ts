import fs from 'fs';
import path from 'path';
import { Model, Field, Relation } from './types';

// SQL Server type → TypeScript type mapping
const AN5_TO_TS: Record<string, string> = {
  // String types
  'NVARCHAR': 'string',
  'VARCHAR': 'string',
  'CHAR': 'string',
  'NCHAR': 'string',
  'TEXT': 'string',
  'NTEXT': 'string',
  'XML': 'string',
  // Numeric types
  'INT': 'number',
  'SMALLINT': 'number',
  'TINYINT': 'number',
  'BIGINT': 'number | bigint',
  'FLOAT': 'number',
  'REAL': 'number',
  'DECIMAL': 'number',
  'NUMERIC': 'number',
  'MONEY': 'number',
  'SMALLMONEY': 'number',
  // Boolean
  'BIT': 'boolean',
  // Date types
  'DATETIME': 'Date',
  'DATETIME2': 'Date',
  'SMALLDATETIME': 'Date',
  'DATE': 'Date',
  'TIME': 'Date',
  'DATETIMEOFFSET': 'Date',
  // Binary types
  'VARBINARY': 'Buffer',
  'BINARY': 'Buffer',
  'IMAGE': 'Buffer',
  // Other
  'UNIQUEIDENTIFIER': 'string',
  'SQL_VARIANT': 'any',
  'ROWVERSION': 'Buffer',
  'HIERARCHYID': 'string',
  'GEOGRAPHY': 'string',
  'GEOMETRY': 'string',
  'VECTOR': 'number[] | string',
};

// Parse base type from "NVARCHAR(255)" → "NVARCHAR"
function parseSqlType(raw: string): { base: string; params: string } {
  const match = raw.match(/^(\w+)(?:\((.+)\))?$/);
  if (!match) return { base: raw, params: '' };
  return { base: match[1].toUpperCase(), params: match[2] || '' };
}

// Map SQL Server type to TypeScript type
export function sqlTypeToTs(sqlType: string): string {
  const { base } = parseSqlType(sqlType);
  return AN5_TO_TS[base] || 'any';
}

export class SchemaParser {
  private schemaText: string = '';

  constructor(private schemaDir: string) {}

  public async parse(): Promise<Model[]> {
    this.loadSchema();
    const lines = this.schemaText.split('\n');
    const models: Model[] = [];
    let currentModel: Model | null = null;

    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('//')) continue;

      const modelHeaderMatch = line.match(/^model\s+(\w+)\s*\{/);
      if (modelHeaderMatch) {
        const modelName = modelHeaderMatch[1];
        currentModel = {
          name: modelName,
          tableName: modelName.toLowerCase() + 's',
          schemaName: 'dbo',
          fields: [],
          relations: []
        };
        models.push(currentModel);
        continue;
      }

      if (line === '}') {
        currentModel = null;
        continue;
      }

      if (currentModel) {
        this.parseModelLine(line, currentModel);
      }
    }

    this.postProcessRelations(models);
    return models;
  }

  private loadSchema() {
    if (fs.existsSync(this.schemaDir)) {
      const files = fs.readdirSync(this.schemaDir).filter(f => f.endsWith('.an5'));
      for (const file of files) {
        this.schemaText += fs.readFileSync(path.join(this.schemaDir, file), 'utf8') + '\n';
      }
    } else {
      throw new Error(`No schema directory found at ${this.schemaDir}`);
    }
  }

  private parseModelLine(line: string, model: Model) {
    if (line.startsWith('@@map')) {
      const mapMatch = line.match(/@@map\("(.+)"\)/);
      if (mapMatch) model.tableName = mapMatch[1];
      return;
    }
    if (line.startsWith('@@schema')) {
      const schemaMatch = line.match(/@@schema\("(.+)"\)/);
      if (schemaMatch) model.schemaName = schemaMatch[1];
      return;
    }
    if (line.startsWith('@@unique')) {
      const uniqueMatch = line.match(/@@unique\(\[([\w,\s]+)\]\)/);
      if (uniqueMatch) {
        const fields = uniqueMatch[1].split(',').map(f => f.trim());
        model.compoundUniques = model.compoundUniques || [];
        model.compoundUniques.push(fields);
      }
      return;
    }
    if (line.startsWith('@@description')) {
      const descMatch = line.match(/@@description\("(.+)"\)/);
      if (descMatch) model.description = descMatch[1];
      return;
    }
    if (line.startsWith('@@')) return;

    const parts = line.split(/\s+/);
    const fieldName = parts[0];
    let fieldType = parts[1];
    if (!fieldName || !fieldType) return;

    const isArray = fieldType.endsWith('[]');
    const isOptional = fieldType.endsWith('?');
    const cleanType = fieldType.replace('[]', '').replace('?', '');

    // Parse SQL Server type (e.g., "NVARCHAR(255)" → base="NVARCHAR")
    const { base: sqlBase } = parseSqlType(cleanType);

    let tsType = 'any';
    let isRelation = false;

    // Check if it's a known SQL Server type
    if (AN5_TO_TS[sqlBase]) {
      tsType = sqlTypeToTs(cleanType);
    } else if (cleanType[0] === cleanType[0].toUpperCase() && !cleanType.includes('(')) {
      // Uppercase without parens = likely a relation to another model
      tsType = cleanType;
      isRelation = true;
    }

    if (isRelation) {
      let foreignKey = '', localKey = '', relationName = '';
      const nameMatch = line.match(/@relation\("(\w+)"/);
      if (nameMatch) relationName = nameMatch[1];
      const relationMatch = line.match(/@relation\((?:.*fields:\s*\[(\w+)\],)?\s*(?:.*references:\s*\[(\w+)\],?)?.*\)/);
      if (relationMatch) {
        foreignKey = relationMatch[1] || '';
        localKey = relationMatch[2] || '';
      }
      model.relations.push({ name: fieldName, type: tsType, isArray, isOptional, foreignKey, localKey, relationName });
    } else {
      const hasDefault = line.includes('@default') || line.includes('@updatedAt') || line.includes('@id');
      const isId = line.includes('@id');
      let description: string | undefined;
      const descMatch = line.match(/@description\("(.+)"\)/);
      if (descMatch) description = descMatch[1];
      model.fields.push({ name: fieldName, type: tsType, sqlType: cleanType, isOptional, hasDefault, isId, description });
    }
  }

  private postProcessRelations(models: Model[]) {
    for (const model of models) {
      for (const rel of model.relations) {
        if (!rel.foreignKey || !rel.localKey) {
          const targetModel = models.find(m => m.name === rel.type);
          if (targetModel) {
            let opposite = rel.relationName ?
              targetModel.relations.find(r => r.type === model.name && r.relationName === rel.relationName && r.foreignKey && r.localKey) :
              targetModel.relations.find(r => r.type === model.name && r.foreignKey && r.localKey);
            if (opposite) { rel.foreignKey = opposite.foreignKey; rel.localKey = opposite.localKey; }
          }
        }
      }
    }
  }
}
