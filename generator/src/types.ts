export interface Field {
  name: string;
  type: string;       // TypeScript type (string, number, boolean, Date, etc.)
  sqlType: string;    // SQL Server type (NVARCHAR(255), INT, DATETIME2, etc.)
  isOptional: boolean;
  hasDefault: boolean;
  isId: boolean;
  description?: string;
}

export interface Relation {
  name: string;
  type: string;
  isArray: boolean;
  isOptional: boolean;
  foreignKey: string;
  localKey: string;
  relationName: string;
}

export interface Model {
  name: string;
  tableName: string;
  schemaName: string;
  fields: Field[];
  relations: Relation[];
  compoundUniques?: string[][];
  description?: string;
}
