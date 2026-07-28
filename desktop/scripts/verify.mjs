import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scanRoots = ['dist-electron', 'electron', 'dist', 'package.json'];
const sourceExtensions = new Set(['.js', '.cjs', '.mjs', '.json', '.html']);
const retiredVendor = ['shop', 'bang'].join('');
const forbidden = [
    new RegExp(['plus', retiredVendor, 'cn'].join('\\.'), 'i'),
    new RegExp(['test-plus', retiredVendor, 'cn'].join('\\.'), 'i'),
    new RegExp(`${[retiredVendor, 'cn'].join('\\.')}\\/erp`, 'i'),
    new RegExp(['collection', 'token'].join('-'), 'i'),
    new RegExp(['login', 'Auto', 'Bang'].join(''), 'i'),
    new RegExp(['logout', 'Auto'].join(''), 'i'),
    new RegExp(['batch', 'Create', 'Goods'].join(''), 'i'),
    new RegExp(['isUse', 'Auto', 'Up', 'Goods'].join(''), 'i'),
    new RegExp(['up', 'goods'].join('-'), 'i'),
    new RegExp(['go', 'erp'].join('-'), 'i'),
    new RegExp(['是否确认', '上架表格中的商品'].join('')),
    new RegExp(['上架', '成功'].join('')),
    new RegExp(['将表格中的商品', '上架'].join('')),
    new RegExp(['upData', 'ConfigId'].join(''), 'i'),
    new RegExp(['legacyDirect', 'PublishDisabled'].join(''), 'i'),
    /\/api\/auto\//i,
    /\/api\/goods\//i,
    /\/api\/user\//i,
];

async function filesUnder(path) {
    const stat = await import('node:fs/promises').then(({ stat }) => stat(path));
    if (stat.isFile())
        return [path];
    const output = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory())
            output.push(...await filesUnder(child));
        else if (sourceExtensions.has(extname(entry.name)))
            output.push(child);
    }
    return output;
}

const files = [];
for (const root of scanRoots)
    files.push(...await filesUnder(join(desktopRoot, root)));

const violations = [];
for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const pattern of forbidden) {
        if (pattern.test(content))
            violations.push(`${relative(desktopRoot, file)} matches ${pattern}`);
    }
}
if (violations.length) {
    console.error(violations.join('\n'));
    process.exit(1);
}

const jsFiles = files.filter((file) => ['.js', '.cjs', '.mjs'].includes(extname(file)));
for (const file of jsFiles) {
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (checked.status !== 0) {
        console.error(checked.stderr || checked.stdout);
        process.exit(checked.status || 1);
    }
}

const testFiles = (await filesUnder(join(desktopRoot, 'tests')))
    .filter((file) => file.endsWith('.test.mjs'));
const tests = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: desktopRoot,
    encoding: 'utf8',
});
process.stdout.write(tests.stdout || '');
process.stderr.write(tests.stderr || '');
if (tests.status !== 0)
    process.exit(tests.status || 1);

console.log(`desktop verify passed (${files.length} files scanned, ${jsFiles.length} scripts checked)`);
