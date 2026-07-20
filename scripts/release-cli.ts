#!/usr/bin/env tsx
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface ChangeGroup {
  component: string;
  files: string[];
  summary: string;
}

function run(cmd: string, allowFail = false): string {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch (error: any) {
    if (allowFail) return error.stdout?.toString()?.trim() || '';
    throw error;
  }
}

function inferComponent(file: string): string {
  const normalized = file.replace('\\', '/').toLowerCase();
  if (normalized.includes('/generator/')) return 'generator';
  if (normalized.includes('/an5client/')) return 'client';
  if (normalized.includes('/an5schema/')) return 'schema';
  if (normalized.includes('/.github/')) return 'ci';
  if (normalized.includes('package.json') || normalized.includes('tsconfig')) return 'build';
  if (normalized.includes('.md')) return 'docs';
  return 'misc';
}

function collectChanges(): ChangeGroup[] {
  const status = run('git status --porcelain');
  const files = status
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.slice(3).trim())
    .filter(Boolean);
  const groups = new Map<string, ChangeGroup>();

  for (const file of files) {
    const component = inferComponent(file);
    if (!groups.has(component)) {
      groups.set(component, { component, files: [], summary: '' });
    }
    groups.get(component)!.files.push(file);
  }

  return Array.from(groups.values()).map(group => ({
    ...group,
    summary: `${group.component} updates`
  }));
}

function generateChangelog(groups: ChangeGroup[]): string {
  const lines = ['# Changelog', ''];
  for (const group of groups) {
    lines.push(`## ${group.component}`);
    lines.push(`- ${group.summary}`);
    for (const file of group.files) {
      lines.push(`  - ${file}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function maybeUseLLM(summary: string): string {
  const key = process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) return summary;

  try {
    const prompt = `Summarize these changes into one concise release note in English:\n${summary}`;
    const payload = JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'You are a helpful release note writer.' }, { role: 'user', content: prompt }] });
    const response = run(`curl -s https://api.openai.com/v1/chat/completions -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '${payload}'`, true);
    const parsed = JSON.parse(response);
    return parsed.choices?.[0]?.message?.content?.trim() || summary;
  } catch {
    return summary;
  }
}

function main() {
  const groups = collectChanges();
  if (groups.length === 0) {
    console.log('No modified files detected.');
    process.exit(0);
  }

  const changelog = generateChangelog(groups);
  const outputPath = path.resolve(process.cwd(), 'CHANGELOG.md');
  fs.writeFileSync(outputPath, changelog + '\n');

  const summary = groups.map(g => `${g.component}: ${g.files.join(', ')}`).join('\n');
  const llmSummary = maybeUseLLM(summary);
  console.log('\nGenerated changelog:\n');
  console.log(changelog);
  console.log('\nLLM summary:\n');
  console.log(llmSummary);

  const message = groups.map(g => g.component).join(', ');
  const commitMessage = `chore: update ${message}`;
  run(`git add -A`);
  run(`git commit -m "${commitMessage}"`, true);
  console.log(`\nCommitted with: ${commitMessage}`);
}

main();
