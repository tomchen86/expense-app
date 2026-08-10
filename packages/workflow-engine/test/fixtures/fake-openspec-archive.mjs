import fs from 'node:fs';
import path from 'node:path';

/**
 * Test-only public archive implementation used by fixture repositories. It is
 * deliberately small, but it applies the four OpenSpec requirement operations
 * to the actual current base instead of returning a canned tree. Production
 * tests can therefore distinguish executing the public archive projection from
 * merely re-parsing the delta inside the workflow engine.
 */
export function applyFixtureArchiveSpecs(root, changeId) {
  const deltaRoot = path.join(root, 'openspec/changes', changeId, 'specs');
  const capabilities = fs
    .readdirSync(deltaRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  const totals = { added: 0, modified: 0, removed: 0, renamed: 0 };
  let marker = '';

  for (const capability of capabilities) {
    const deltaPath = path.join(deltaRoot, capability, 'spec.md');
    const delta = fs.readFileSync(deltaPath, 'utf8');
    marker += delta;
    if (delta.includes('ARCHIVE_IGNORE_DELTA')) {
      totals.removed += 1;
      continue;
    }
    const basePath = path.join(root, 'openspec/specs', capability, 'spec.md');
    const before = fs.existsSync(basePath)
      ? fs.readFileSync(basePath, 'utf8')
      : `# ${title(capability)} Specification\n\n## Requirements\n`;
    const projected = applyDelta(before, delta, totals);
    fs.mkdirSync(path.dirname(basePath), { recursive: true });
    fs.writeFileSync(basePath, projected, 'utf8');
  }

  return { marker, totals };
}

function applyDelta(base, delta, totals) {
  const operationCountBefore =
    totals.added + totals.modified + totals.removed + totals.renamed;
  const baseDocument = requirementsDocument(base);
  const sections = splitSections(delta);
  const added = requirementBlocks(sections.get('added requirements') ?? '');
  const modified = requirementBlocks(
    sections.get('modified requirements') ?? '',
  );
  const removed = requirementNames(sections.get('removed requirements') ?? '');
  const renamed = parseRenames(sections.get('renamed requirements') ?? '');

  for (const block of added) {
    if (baseDocument.byName.has(block.name)) {
      throw new Error(`added requirement already exists: ${block.name}`);
    }
    baseDocument.blocks.push(block);
    baseDocument.byName.set(block.name, block);
    totals.added += 1;
  }
  for (const block of modified) {
    const existing = baseDocument.byName.get(block.name);
    if (!existing) {
      throw new Error(`modified requirement is absent: ${block.name}`);
    }
    const index = baseDocument.blocks.indexOf(existing);
    baseDocument.blocks[index] = block;
    baseDocument.byName.set(block.name, block);
    totals.modified += 1;
  }
  for (const name of removed) {
    const existing = baseDocument.byName.get(name);
    if (!existing) {
      throw new Error(`removed requirement is absent: ${name}`);
    }
    baseDocument.blocks.splice(baseDocument.blocks.indexOf(existing), 1);
    baseDocument.byName.delete(name);
    totals.removed += 1;
  }
  for (const rename of renamed) {
    const existing = baseDocument.byName.get(rename.from);
    if (!existing || baseDocument.byName.has(rename.to)) {
      throw new Error(`invalid requirement rename: ${rename.from}`);
    }
    const replacement = {
      name: rename.to,
      raw: existing.raw.replace(
        /^###\s*Requirement:\s*.+?\s*$/im,
        `### Requirement: ${rename.to}`,
      ),
    };
    const index = baseDocument.blocks.indexOf(existing);
    baseDocument.blocks[index] = replacement;
    baseDocument.byName.delete(rename.from);
    baseDocument.byName.set(rename.to, replacement);
    totals.renamed += 1;
  }

  if (
    totals.added + totals.modified + totals.removed + totals.renamed ===
    operationCountBefore
  ) {
    throw new Error('delta contains no requirement operations');
  }
  const prefix = baseDocument.prefix.trimEnd();
  const blocks = baseDocument.blocks
    .map(({ raw }) => raw.trimEnd())
    .join('\n\n');
  return `${prefix}${blocks ? `\n\n${blocks}` : ''}\n`;
}

function requirementsDocument(content) {
  const blocks = requirementBlocks(content);
  const first = content.search(/^###\s*Requirement:/im);
  return {
    prefix: first === -1 ? content : content.slice(0, first),
    blocks,
    byName: new Map(blocks.map((block) => [block.name, block])),
  };
}

function splitSections(content) {
  const sections = new Map();
  let title;
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^##\s+(.+)$/.exec(line);
    if (match) {
      title = match[1].trim().toLowerCase();
      sections.set(title, '');
    } else if (title) {
      sections.set(title, `${sections.get(title)}${line}\n`);
    }
  }
  return sections;
}

function requirementBlocks(content) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^###\s*Requirement:\s*(.+?)\s*$/i.exec(lines[index]);
    if (!match) continue;
    const body = [lines[index]];
    while (
      index + 1 < lines.length &&
      !/^###\s*Requirement:/i.test(lines[index + 1]) &&
      !/^##\s+/.test(lines[index + 1])
    ) {
      body.push(lines[(index += 1)]);
    }
    blocks.push({ name: match[1].trim(), raw: body.join('\n').trimEnd() });
  }
  return blocks;
}

function requirementNames(content) {
  return content.split('\n').flatMap((line) => {
    const match = /^###\s*Requirement:\s*(.+?)\s*$/i.exec(line);
    return match ? [match[1].trim()] : [];
  });
}

function parseRenames(content) {
  const result = [];
  let from;
  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const fromMatch =
      /^\s*-?\s*FROM:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/i.exec(line);
    const toMatch = /^\s*-?\s*TO:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/i.exec(
      line,
    );
    if (fromMatch) from = fromMatch[1].trim();
    if (toMatch && from) {
      result.push({ from, to: toMatch[1].trim() });
      from = undefined;
    }
  }
  return result;
}

function title(value) {
  return value
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
