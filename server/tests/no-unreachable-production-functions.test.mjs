import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'acorn';
import * as collectionPipeline from '../collection-pipeline.mjs';
import * as collectorDesktopService from '../collector-desktop-service.mjs';
import * as listingPipeline from '../listing-pipeline.mjs';

const auditedFiles = [
  '../collector-ozon-enrichment-routes.mjs',
  '../index.mjs',
  '../ozon-import-normalizer.mjs',
];

function walk(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, node));
    else if (value && typeof value.type === 'string') walk(value, visit, node);
  }
}

async function unreachableLocalFunctions(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const declarations = [];
  const references = new Map();
  walk(tree, (node, parent) => {
    if (
      node.type === 'FunctionDeclaration'
      && node.id?.name
      && parent?.type !== 'ExportNamedDeclaration'
      && parent?.type !== 'ExportDefaultDeclaration'
    ) declarations.push(node);
    if (node.type !== 'Identifier') return;
    if (parent?.type === 'FunctionDeclaration' && parent.id === node) return;
    references.set(node.name, (references.get(node.name) || 0) + 1);
  });
  return declarations
    .filter((declaration) => (references.get(declaration.id.name) || 0) === 0)
    .map((declaration) => `${relativePath}:${declaration.loc.start.line}:${declaration.id.name}`);
}

test('server modules expose no retired public collection helpers', () => {
  assert.equal('preflightCompleteCollectRequestsV4' in collectionPipeline, false);
  assert.equal('validateCollectorScope' in collectorDesktopService, false);
  assert.equal('softDeleteCollectItemsV3' in listingPipeline, false);
});

test('server production modules contain no unreachable local functions', async () => {
  const unreachable = (await Promise.all(auditedFiles.map(unreachableLocalFunctions))).flat();
  assert.deepEqual(unreachable, []);
});
