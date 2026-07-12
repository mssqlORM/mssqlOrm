import fs from 'fs';
import path from 'path';
import { Model } from './types';

export class MetadataGenerator {
  constructor(private outputPath: string) {}

  public generate(models: Model[]) {
    let metaContent = '// This file is auto-generated. Do not edit directly.\n\n';

    metaContent += 'export const modelToTable: Record<string, string> = {\n';
    for (const model of models) {
      const props = this.getAllPropertyVariations(model.name);
      const fullTableName = `[${model.schemaName}].[${model.tableName}]`;
      for (const prop of props) {
        metaContent += `  ${prop}: "${fullTableName}",\n`;
      }
    }
    metaContent += '};\n\n';

    metaContent += 'export const modelFields: Record<string, Record<string, { ts: string; sql: string }>> = {\n';
    for (const model of models) {
      const props = this.getAllPropertyVariations(model.name);
      const fieldsStr = `{ ${model.fields.map(f => `${f.name}: { ts: "${f.type}${f.isOptional ? '?' : ''}", sql: "${f.sqlType}" }`).join(', ')} }`;
      for (const prop of props) {
        metaContent += `  ${prop}: ${fieldsStr},\n`;
      }
    }
    metaContent += '};\n\n';

    metaContent += 'export interface RelationDef {\n  modelName: string;\n  relationType: "many" | "one";\n  foreignKey: string;\n  localKey: string;\n}\n\n';

    metaContent += 'export const relationMap: Record<string, Record<string, RelationDef>> = {\n';
    for (const model of models) {
      const props = this.getAllPropertyVariations(model.name);
      let relationsContent = `  {\n`;
      for (const rel of model.relations) {
        relationsContent += `    ${rel.name}: { modelName: "${this.toCamelCase(rel.type)}", relationType: "${rel.isArray ? 'many' : 'one'}", foreignKey: "${rel.foreignKey || 'id'}", localKey: "${rel.localKey || 'id'}" },\n`;
      }
      relationsContent += `  }`;

      for (const prop of props) {
        metaContent += `  ${prop}: ${relationsContent},\n`;
      }
    }
    metaContent += '};\n';

    fs.writeFileSync(this.outputPath, metaContent);
  }

  private getAllPropertyVariations(modelName: string): string[] {
    const variations = new Set<string>();
    
    // 1. Standard camelCase (e.g. User -> user, McpServer -> mcpServer)
    variations.add(this.toCamelCase(modelName));

    // 2. Handle known acronyms at start (e.g. LLMProvider -> lLMProvider)
    // This is already handled by toCamelCase if it only lowercases the first letter.
    // But we might want 'llmProvider' as well.
    const acronyms = ['LLM', 'AI', 'MCP', 'IT', 'QC', 'HR', 'MR', 'WH', 'SSIS', 'API', 'URL', 'ID', 'JSON'];
    
    for (const acronym of acronyms) {
      if (modelName.startsWith(acronym)) {
        // e.g. LLMProvider -> llmProvider
        variations.add(acronym.toLowerCase() + modelName.slice(acronym.length));
        
        // e.g. LLMProvider -> lLMProvider (Prisma style)
        variations.add(acronym[0].toLowerCase() + acronym.slice(1) + modelName.slice(acronym.length));
      }
    }

    return Array.from(variations);
  }

  private toCamelCase(str: string): string {
    if (!str) return '';
    return str[0].toLowerCase() + str.slice(1);
  }
}
