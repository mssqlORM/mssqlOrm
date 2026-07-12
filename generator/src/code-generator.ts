import fs from 'fs';
import path from 'path';
import { Model, Field, Relation } from './types';

export class CodeGenerator {
  constructor(private outputDir: string) {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  public generate(models: Model[]) {
    this.generateBaseTs();
    for (const model of models) {
      this.generateModelFile(model);
    }
    this.generateIndexTs(models);
  }

  private generateBaseTs() {
    const baseTs = `
export namespace Mssql {
  export class MssqlClientKnownRequestError extends Error {
    code!: string;
    meta?: any;
    constructor(message: string, { code, clientVersion }: { code: string; clientVersion: string }) {
      super(message);
      this.code = code;
    }
  }
  export type SortOrder = 'asc' | 'desc';
  export type StringFilter = { equals?: string; in?: string[]; notIn?: string[]; lt?: string; lte?: string; gt?: string; gte?: string; contains?: string; startsWith?: string; endsWith?: string; not?: string | StringFilter; };
  export type StringNullableFilter = { equals?: string | null; in?: (string | null)[]; notIn?: (string | null)[]; lt?: string; lte?: string; gt?: string; gte?: string; contains?: string; startsWith?: string; endsWith?: string; not?: string | StringNullableFilter | null; };
  export type NumberFilter = { equals?: number; in?: number[]; notIn?: number[]; lt?: number; lte?: number; gt?: number; gte?: number; not?: number | NumberFilter; };
  export type IntFieldUpdateOperationsInput = { set?: number; increment?: number; decrement?: number; multiply?: number; divide?: number; };
  export type FloatFieldUpdateOperationsInput = { set?: number; increment?: number; decrement?: number; multiply?: number; divide?: number; };
  export type NumberNullableFilter = { equals?: number | null; in?: (number | null)[]; notIn?: (number | null)[]; lt?: number; lte?: number; gt?: number; gte?: number; not?: number | NumberNullableFilter | null; };
  export type BooleanFilter = { equals?: boolean; not?: boolean | BooleanFilter; };
  export type BooleanNullableFilter = { equals?: boolean | null; not?: boolean | BooleanNullableFilter | null; };
  export type DateTimeFilter = { equals?: Date; in?: Date[]; notIn?: Date[]; lt?: Date; lte?: Date; gt?: Date; gte?: Date; not?: Date | DateTimeFilter; };
  export type DateTimeNullableFilter = { equals?: Date | null; in?: (Date | null)[]; notIn?: (Date | null)[]; lt?: Date; lte?: Date; gt?: Date; gte?: Date; not?: Date | DateTimeNullableFilter | null; };
}

export interface TableClient<T, WhereInput = any, Select = any, Include = any, CreateInput = any, UpdateInput = any, FindManyArgs = any, FindFirstArgs = any, FindUniqueArgs = any, CreateArgs = any, UpdateArgs = any, UpsertArgs = any, DeleteArgs = any> {
  findMany(args?: FindManyArgs): Promise<T[]>;
  vectorSearch(args: { vector: number[]; take?: number; where?: WhereInput; include?: Include; vectorField?: string; distanceMetric?: 'cosine' | 'euclidean' | 'dot'; }): Promise<(T & { distance: number })[]>;
  findFirst(args?: FindFirstArgs): Promise<T | null>;
  findUnique(args?: FindUniqueArgs): Promise<T | null>;
  count(args?: { where?: WhereInput; }): Promise<number>;
  create(args: CreateArgs): Promise<T>;
  createMany(args: { data: CreateInput[]; skipDuplicates?: boolean; }): Promise<{ count: number }>;
  update(args: UpdateArgs): Promise<T>;
  updateMany(args: { where?: WhereInput; data: UpdateInput; }): Promise<{ count: number }>;
  delete(args: DeleteArgs): Promise<T>;
  deleteMany(args?: { where?: WhereInput; }): Promise<{ count: number }>;
  aggregate(args: any): Promise<any>;
  groupBy(args: any): Promise<any[]>;
  upsert(args: UpsertArgs): Promise<T>;
}
`;
    fs.writeFileSync(path.join(this.outputDir, 'base.ts'), baseTs);
  }

  private generateModelFile(model: Model) {
    let content = `import { Mssql, TableClient } from './base';\n`;
    const relModels = [...new Set(model.relations.map(r => r.type))];
    for (const relModel of relModels) {
      if (relModel !== model.name) {
        content += `import { ${relModel}, ${relModel}WhereInput, ${relModel}FindManyArgs, ${relModel}CreateInput, ${relModel}UpdateInput } from './${relModel}';\n`;
      }
    }

    content += `\nexport interface ${model.name} {\n`;
    for (const field of model.fields) {
      content += `  ${field.name}: ${this.normalizeType(field.type)}${field.isOptional ? ' | null' : ''};\n`;
    }
    for (const rel of model.relations) {
      content += `  ${rel.name}?: ${rel.type}${rel.isArray ? '[]' : ''}${rel.isOptional ? ' | null' : ''};\n`;
    }
    if (model.relations.length > 0) {
      content += `  _count?: { ${model.relations.map(r => `${r.name}: number`).join('; ')} };\n`;
    }
    content += `}\n\n`;

    content += `export type ${model.name}WhereInput = {\n`;
    content += `  AND?: ${model.name}WhereInput | ${model.name}WhereInput[];\n`;
    content += `  OR?: ${model.name}WhereInput[];\n`;
    content += `  NOT?: ${model.name}WhereInput | ${model.name}WhereInput[];\n`;
    for (const field of model.fields) {
      const filter = this.getFieldFilterType(field);
      content += `  ${field.name}?: ${field.type} | ${filter}${field.isOptional ? ' | null' : ''};\n`;
    }
    for (const rel of model.relations) {
      if (rel.isArray) {
        content += `  ${rel.name}?: { some?: ${rel.type}WhereInput; none?: ${rel.type}WhereInput; every?: ${rel.type}WhereInput; };\n`;
      } else {
        content += `  ${rel.name}?: ${rel.type}WhereInput${rel.isOptional ? ' | null' : ''};\n`;
      }
    }
    if (model.compoundUniques) {
      for (const compound of model.compoundUniques) {
        const keyName = compound.join('_');
        content += `  ${keyName}?: { ${compound.map(f => `${f}: ${model.fields.find(mf => mf.name === f)?.type || 'any'}`).join('; ')} };\n`;
      }
    }
    content += `};\n\n`;

    const selectFields = model.fields.map(f => `${f.name}?: boolean`);
    const selectRels = model.relations.map(r => `${r.name}?: boolean | ${r.type}FindManyArgs`);
    if (model.relations.length > 0) {
      selectRels.push(`_count?: boolean | { select?: { ${model.relations.map(r => `${r.name}?: boolean`).join('; ')} } }`);
    }
    content += `export type ${model.name}Select = { ${[...selectFields, ...selectRels].join('; ')}${[...selectFields, ...selectRels].length > 0 ? ';' : ''} };\n`;
    
    const includeRels = model.relations.map(r => `${r.name}?: boolean | ${r.type}FindManyArgs`);
    if (model.relations.length > 0) {
      includeRels.push(`_count?: boolean | { select?: { ${model.relations.map(r => `${r.name}?: boolean`).join('; ')} } }`);
    }
    content += `export type ${model.name}Include = { ${includeRels.join('; ')}${includeRels.length > 0 ? ';' : ''} };\n`;

    content += `export type ${model.name}CreateInput = { ${model.fields.map(f => `${f.name}${f.isOptional || f.hasDefault ? '?' : ''}: ${f.type}${f.isOptional ? ' | null' : ''}`).join('; ')}; ${model.relations.map(r => `${r.name}?: { create?: ${r.type}CreateInput | ${r.type}CreateInput[]; connect?: ${r.type}WhereInput | ${r.type}WhereInput[]; }`).join('; ')} };\n`;
    content += `export type ${model.name}UpdateInput = { ${model.fields.filter(f => !f.isId).map(f => `${f.name}?: ${f.type === 'number' ? 'number | Mssql.IntFieldUpdateOperationsInput' : f.type}${f.isOptional ? ' | null' : ''}`).join('; ')}; ${model.relations.map(r => `${r.name}?: { create?: ${r.type}CreateInput | ${r.type}CreateInput[]; connect?: ${r.type}WhereInput | ${r.type}WhereInput[]; set?: ${r.type}WhereInput | ${r.type}WhereInput[]; disconnect?: ${r.type}WhereInput | ${r.type}WhereInput[]; delete?: ${r.type}WhereInput | ${r.type}WhereInput[]; update?: { where: ${r.type}WhereInput; data: ${r.type}UpdateInput; } | { where: ${r.type}WhereInput; data: ${r.type}UpdateInput; }[]; upsert?: { where: ${r.type}WhereInput; create: ${r.type}CreateInput; update: ${r.type}UpdateInput; } | { where: ${r.type}WhereInput; create: ${r.type}CreateInput; update: ${r.type}UpdateInput; }[]; }`).join('; ')} };\n`;

    content += `export type ${model.name}FindManyArgs = { where?: ${model.name}WhereInput; orderBy?: any; take?: number; skip?: number; include?: ${model.name}Include; select?: ${model.name}Select; };\n`;
    content += `export type ${model.name}FindFirstArgs = { where?: ${model.name}WhereInput; orderBy?: any; include?: ${model.name}Include; select?: ${model.name}Select; };\n`;
    content += `export type ${model.name}FindUniqueArgs = { where?: ${model.name}WhereInput; include?: ${model.name}Include; select?: ${model.name}Select; };\n`;
    content += `export type ${model.name}CreateArgs = { data: ${model.name}CreateInput; include?: ${model.name}Include; select?: ${model.name}Select; };\n`;
    content += `export type ${model.name}UpdateArgs = { where: ${model.name}WhereInput; data: ${model.name}UpdateInput; include?: ${model.name}Include; select?: ${model.name}Select; };\n`;
    content += `export type ${model.name}UpsertArgs = { where: ${model.name}WhereInput; create: ${model.name}CreateInput; update: ${model.name}UpdateInput; include?: ${model.name}Include; select?: ${model.name}Select; };\n`;
    content += `export type ${model.name}DeleteArgs = { where: ${model.name}WhereInput; include?: ${model.name}Include; select?: ${model.name}Select; };\n`;

    content += `export type ${model.name}TableClient = TableClient<\n  ${model.name},\n  ${model.name}WhereInput,\n  ${model.name}Select,\n  ${model.name}Include,\n  ${model.name}CreateInput,\n  ${model.name}UpdateInput,\n  ${model.name}FindManyArgs,\n  ${model.name}FindFirstArgs,\n  ${model.name}FindUniqueArgs,\n  ${model.name}CreateArgs,\n  ${model.name}UpdateArgs,\n  ${model.name}UpsertArgs,\n  ${model.name}DeleteArgs\n>;\n`;

    fs.writeFileSync(path.join(this.outputDir, `${model.name}.ts`), content);
  }

  private generateIndexTs(models: Model[]) {
    let content = `export * from './base';\n`;
    for (const model of models) {
      content += `export * from './${model.name}';\n`;
    }
    content += `\nimport { Mssql as BaseMssql } from './base';\n`;
    for (const model of models) {
      content += `import * as ${model.name}Types from './${model.name}';\n`;
    }

    content += `\nexport namespace Mssql {\n`;
    content += `  export type SortOrder = BaseMssql.SortOrder;\n`;
    content += `  export type StringFilter = BaseMssql.StringFilter;\n`;
    content += `  export type StringNullableFilter = BaseMssql.StringNullableFilter;\n`;
    content += `  export type NumberFilter = BaseMssql.NumberFilter;\n`;
    content += `  export type NumberNullableFilter = BaseMssql.NumberNullableFilter;\n`;
    content += `  export type BooleanFilter = BaseMssql.BooleanFilter;\n`;
    content += `  export type BooleanNullableFilter = BaseMssql.BooleanNullableFilter;\n`;
    content += `  export type DateTimeFilter = BaseMssql.DateTimeFilter;\n`;
    content += `  export type DateTimeNullableFilter = BaseMssql.DateTimeNullableFilter;\n`;
    content += `  export type IntFieldUpdateOperationsInput = BaseMssql.IntFieldUpdateOperationsInput;\n`;
    content += `  export type FloatFieldUpdateOperationsInput = BaseMssql.FloatFieldUpdateOperationsInput;\n`;
    content += `  export const MssqlClientKnownRequestError = BaseMssql.MssqlClientKnownRequestError;\n`;

    for (const model of models) {
      content += `  export type ${model.name} = ${model.name}Types.${model.name};\n`;
      content += `  export type ${model.name}WhereInput = ${model.name}Types.${model.name}WhereInput;\n`;
      content += `  export type ${model.name}Select = ${model.name}Types.${model.name}Select;\n`;
      content += `  export type ${model.name}Include = ${model.name}Types.${model.name}Include;\n`;
      content += `  export type ${model.name}CreateInput = ${model.name}Types.${model.name}CreateInput;\n`;
      content += `  export type ${model.name}UpdateInput = ${model.name}Types.${model.name}UpdateInput;\n`;
    }
    content += `}\n`;

    content += `\nexport class MssqlClient {\n  $connect(): Promise<void> { return Promise.resolve(); }\n  $disconnect(): Promise<void> { return Promise.resolve(); }\n  $transaction<R>(fn: (tx: MssqlClient) => Promise<R>, options?: { timeout?: number }): Promise<R>;\n  $transaction<R>(list: Promise<R>[]): Promise<R[]>;\n  $transaction(fn: any, options?: any): Promise<any> { return typeof fn === 'function' ? fn(this) : Promise.all(fn); }\n  $queryRaw<T = any>(queryParts: TemplateStringsArray | string, ...values: any[]): Promise<T> { return Promise.resolve([] as any); }\n  $queryRawUnsafe<R = any>(query: string, ...values: any[]): Promise<R> { return Promise.resolve([] as any); }\n  $executeRaw<T = any>(queryParts: TemplateStringsArray | string, ...values: any[]): Promise<any> { return Promise.resolve(0 as any); }\n  $executeRawUnsafe(query: string, ...values: any[]): Promise<number> { return Promise.resolve(0); }\n`;

    const addedProps = new Set<string>();
    for (const model of models) {
      const props = this.getAllPropertyVariations(model.name);
      for (const prop of props) {
        if (!addedProps.has(prop)) {
          content += `  ${prop}!: ${model.name}Types.${model.name}TableClient;\n`;
          addedProps.add(prop);
        }
      }
    }

    content += `}\n`;
    fs.writeFileSync(path.join(this.outputDir, 'index.ts'), content);
  }

  private getAllPropertyVariations(modelName: string): string[] {
    const variations = new Set<string>();
    variations.add(this.toCamelCase(modelName));
    const acronyms = ['LLM', 'AI', 'MCP', 'IT', 'QC', 'HR', 'MR', 'WH', 'SSIS', 'API', 'URL', 'ID', 'JSON'];
    for (const acronym of acronyms) {
      if (modelName.startsWith(acronym)) {
        variations.add(acronym.toLowerCase() + modelName.slice(acronym.length));
        variations.add(acronym[0].toLowerCase() + acronym.slice(1) + modelName.slice(acronym.length));
      }
    }
    return Array.from(variations);
  }

  private getFieldFilterType(field: Field): string {
    const normalizedType = this.normalizeType(field.type);
    if (normalizedType === 'string') return field.isOptional ? 'Mssql.StringNullableFilter' : 'Mssql.StringFilter';
    if (normalizedType === 'number') return field.isOptional ? 'Mssql.NumberNullableFilter' : 'Mssql.NumberFilter';
    if (normalizedType === 'boolean') return field.isOptional ? 'Mssql.BooleanNullableFilter' : 'Mssql.BooleanFilter';
    if (normalizedType === 'Date') return field.isOptional ? 'Mssql.DateTimeNullableFilter' : 'Mssql.DateTimeFilter';
    return 'any';
  }

  private normalizeType(type: string): string {
    const lowerType = type.toLowerCase();
    if (['string', 'varchar', 'nvarchar', 'char', 'nchar', 'text', 'ntext', 'xml', 'guid', 'uuid', 'uniqueidentifier', 'sysname', 'hierarchyid', 'geography', 'geometry', 'sql_variant', 'sqlvariant', 'rowversion', 'variant'].includes(lowerType)) {
      return 'string';
    }
    if (['int', 'integer', 'smallint', 'tinyint', 'bigint', 'long', 'number', 'decimal', 'numeric', 'money', 'smallmoney', 'float', 'real', 'double'].includes(lowerType)) {
      return 'number';
    }
    if (['bool', 'boolean', 'bit'].includes(lowerType)) {
      return 'boolean';
    }
    if (['datetime', 'datetime2', 'datetimeoffset', 'smalldatetime', 'date', 'time', 'timestamp'].includes(lowerType)) {
      return 'Date';
    }
    if (['bytes', 'binary', 'varbinary', 'image'].includes(lowerType)) {
      return 'string';
    }
    return 'any';
  }

  private toCamelCase(str: string): string {
    if (!str) return '';
    return str[0].toLowerCase() + str.slice(1);
  }
}
