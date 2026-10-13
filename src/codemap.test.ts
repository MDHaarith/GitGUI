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
  const { files, links } = fileMap({ nodes, edges }, '/r', 600);
  assert.deepEqual(files.map(f => [f.path, f.symbols.length]), [['a.rs', 2], ['b.rs', 1], ['c.rs', 0]]);
  assert.deepEqual(links, [{ from: 0, to: 1, weight: 2 }]);
  for (const f of files) assert.ok(f.x >= 40 && f.x <= 560 && f.y >= 40 && f.y <= 560, `${f.path} at ${f.x},${f.y}`);
  assert.deepEqual(searchSymbols(files, 'RE').map(h => h.symbol.name), ['read']);
  assert.deepEqual(searchSymbols(files, '  '), []);
});
