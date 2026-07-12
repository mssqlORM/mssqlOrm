import path from 'path';
import { SchemaParser } from './parser';
import { CodeGenerator } from './code-generator';
import { MetadataGenerator } from './metadata-generator';
import { PythonGenerator } from './python-generator';
import { DotnetGenerator } from './dotnet-generator';

import fs from 'fs';

function clearGeneratedFiles(outputDir: string, extension: string) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    return;
  }

  for (const entry of fs.readdirSync(outputDir)) {
    const fullPath = path.join(outputDir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) continue;
    if (entry.endsWith(extension)) {
      fs.unlinkSync(fullPath);
    }
  }
}

async function main() {
  const rootDir = path.join(__dirname, '../../../');
  let config: any = {};
  
  try {
    const configPath = path.join(rootDir, 'mssqlOrm.config.js');
    if (fs.existsSync(configPath)) {
      config = require(configPath);
    }
  } catch (err) {
    console.warn('⚠️ Could not load mssqlOrm.config.js, using defaults.', err);
  }

  const schemaDir = path.resolve(rootDir, config.schemaDir || 'mssqlSchema');
  const outputTypesDir = path.resolve(rootDir, config.outputs?.typescript?.outputDir || 'mssqlClient/typescript');
  const outputMetadataPath = path.resolve(rootDir, config.outputs?.typescript?.metadataFile || 'mssqlClient/typescript/mssqlMetadata.ts');
  const outputPythonMetadataPath = path.resolve(rootDir, config.outputs?.python?.metadataFile || 'mssqlClient/python/mssql_metadata.py');
  const outputDotnetDir = path.resolve(rootDir, config.outputs?.dotnet?.outputDir || 'mssqlClient/dotnet');

  console.log('🚀 Starting ORM generation...');

  try {
    clearGeneratedFiles(outputTypesDir, '.ts');
    clearGeneratedFiles(outputDotnetDir, '.cs');
    if (fs.existsSync(outputMetadataPath)) {
      fs.unlinkSync(outputMetadataPath);
    }
    if (fs.existsSync(outputPythonMetadataPath)) {
      fs.unlinkSync(outputPythonMetadataPath);
    }

    const parser = new SchemaParser(schemaDir);
    const models = await parser.parse();
    console.log(`📦 Parsed ${models.length} models from schema.`);

    const codeGen = new CodeGenerator(outputTypesDir);
    codeGen.generate(models);
    console.log(`✨ Generated modular types in ${outputTypesDir}`);

    const metadataDir = path.dirname(outputMetadataPath);
    if (!fs.existsSync(metadataDir)) {
      fs.mkdirSync(metadataDir, { recursive: true });
    }
    const metadataGen = new MetadataGenerator(outputMetadataPath);
    metadataGen.generate(models);
    console.log(`✨ Generated metadata in ${outputMetadataPath}`);

    const pythonDir = path.dirname(outputPythonMetadataPath);
    if (!fs.existsSync(pythonDir)) {
      fs.mkdirSync(pythonDir, { recursive: true });
    }
    const pythonGen = new PythonGenerator(outputPythonMetadataPath);
    pythonGen.generate(models);
    console.log(`✨ Generated Python metadata in ${outputPythonMetadataPath}`);

    const dotnetGen = new DotnetGenerator(outputDotnetDir);
    dotnetGen.generate(models);
    console.log(`✨ Generated .NET models in ${outputDotnetDir}`);

    console.log('✅ ORM generation completed successfully.');
  } catch (error) {
    console.error('❌ ORM generation failed:', error);
    process.exit(1);
  }
}

main();
