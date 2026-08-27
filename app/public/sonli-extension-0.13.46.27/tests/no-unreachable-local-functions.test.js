const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parse } = require('acorn');

const extensionRoot = path.resolve(__dirname, '..');
const auditedFiles = [
  'content/1688-ai-wizard.js',
  'content/jzc-calc.js',
  'content/ozon-data-panel.js',
  'content/ozon-product.js',
  'lib/cn-source-scraper.js',
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

function unreachableFunctionDeclarations(relativePath) {
  const source = fs.readFileSync(path.join(extensionRoot, relativePath), 'utf8');
  const tree = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    locations: true,
    allowHashBang: true,
  });
  const declarations = [];
  const safeVariables = [];
  const references = new Map();
  walk(tree, (node, parent) => {
    if (node.type === 'FunctionDeclaration' && node.id?.name) declarations.push(node);
    if (
      node.type === 'VariableDeclarator'
      && node.id?.type === 'Identifier'
      && (
        ['Literal', 'ArrayExpression', 'ObjectExpression'].includes(node.init?.type)
        || (node.init?.type === 'NewExpression'
          && ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(node.init.callee?.name)
          && node.init.arguments.length === 0)
      )
    ) safeVariables.push(node);
    if (node.type !== 'Identifier') return;
    if (parent?.type === 'FunctionDeclaration' && parent.id === node) return;
    if (parent?.type === 'VariableDeclarator' && parent.id === node) return;
    references.set(node.name, (references.get(node.name) || 0) + 1);
  });
  const unusedFunctions = declarations
    .filter((declaration) => (references.get(declaration.id.name) || 0) === 0)
    .map((declaration) => `${relativePath}:${declaration.loc.start.line}:${declaration.id.name}`);
  const unusedSafeVariables = safeVariables
    .filter((declaration) => (references.get(declaration.id.name) || 0) === 0)
    .map((declaration) => `${relativePath}:${declaration.loc.start.line}:${declaration.id.name}`);
  return [...unusedFunctions, ...unusedSafeVariables];
}

test('shipped extension scripts contain no unreachable local function declarations', () => {
  const unreachable = auditedFiles.flatMap(unreachableFunctionDeclarations);
  assert.deepEqual(unreachable, []);
});
