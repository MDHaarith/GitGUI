import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileMap, searchSymbols, type CodeNode } from './codemap.ts';

const node = (kind: string, file: string, name: string): CodeNode => ({ kind, name, qualified_name: kind === 'File' ? file : `${file}::${name}`, file_path: file, line_start: 1, language: 'rust' });

test('fileMap groups symbols by file, keeps only resolved cross-file dependencies, and fits the box', () => {
  const nodes = [node('File', '/r/a.rs', '/r/a.rs'), node('Function', '/r/a.rs', 'open'), node('Function', '/r/a.rs', 'close'), node('File', '/r/b.rs', '/r/b.rs'), node('Function', '/r/b.rs', 'read'), node('File', '/r/c.rs', '/r/c.rs')];
  const edges = [
    { kind: 'CALLS', source: '/r/a.rs::open', target: '/r/b.rs::read' },
    { kind: 'CALLS', source: '/r/b.rs::read', target: '/r/a.rs::close' },
    { kind: 'CALLS', source: '/r/a.rs::open', target: '/r/a.rs::close' },
    { kind: 'CALLS', source: '/r/a.rs::open', target: 'unresolved' },
    { kind: 'CONTAINS', source: '/r/a.rs', target: '/r/a.rs::open' },
  ];
  const { files, links } = fileMap({ nodes, edges }, '/r');
  assert.deepEqual(files.map(f => [f.path, f.symbols.length]), [['a.rs', 2], ['b.rs', 1], ['c.rs', 0]]);
  assert.deepEqual(links, [{ from: 0, to: 1, weight: 2 }]);
  for (const f of files) assert.ok(f.x >= f.r && f.x <= 600 - f.r && f.y >= f.r && f.y <= 600 - f.r, `${f.path} at ${f.x},${f.y}`);
  assert.deepEqual(searchSymbols(files, 'RE').map(h => h.symbol.name), ['read']);
  assert.deepEqual(searchSymbols(files, '  '), []);
});

test('fileMap can leave out test files and their links', () => {
  const nodes = [node('File', '/r/src/a.ts', '/r/src/a.ts'), node('Function', '/r/src/a.ts', 'run'), node('File', '/r/src/a.test.ts', '/r/src/a.test.ts'), node('Function', '/r/src/a.test.ts', 'check'), node('File', '/r/tests/ui.mjs', '/r/tests/ui.mjs')];
  const edges = [{ kind: 'CALLS', source: '/r/src/a.test.ts::check', target: '/r/src/a.ts::run' }];
  assert.deepEqual(fileMap({ nodes, edges }, '/r').files.map(f => [f.path, f.test]), [['src/a.ts', false], ['src/a.test.ts', true], ['tests/ui.mjs', true]]);
  const trimmed = fileMap({ nodes, edges }, '/r', { tests: false });
  assert.deepEqual(trimmed.files.map(f => f.path), ['src/a.ts']);
  assert.deepEqual(trimmed.links, []);
});
