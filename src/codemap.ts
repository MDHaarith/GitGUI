export interface CodeNode { kind: string; name: string; qualified_name: string; file_path: string; line_start: number | null; language: string | null }
export interface CodeEdge { kind: string; source: string; target: string }
export interface CodeGraph { nodes: CodeNode[]; edges: CodeEdge[] }
export interface MapFile { path: string; language: string; symbols: CodeNode[]; x: number; y: number }
export interface MapLink { from: number; to: number; weight: number }

const DEPENDENCIES = new Set(['CALLS', 'IMPORTS_FROM', 'INHERITS', 'REFERENCES']);

/** Collapses the code-review-graph export to files and the dependencies between them, laid out in a size×size box. */
export function fileMap(graph: CodeGraph, root: string, size = 600) {
  const prefix = root.endsWith('/') ? root : root + '/';
  const files: MapFile[] = [], byPath = new Map<string, number>(), owner = new Map<string, number>();
  for (const node of graph.nodes) {
    let at = byPath.get(node.file_path);
    if (at === undefined) {
      at = files.push({ path: node.file_path.startsWith(prefix) ? node.file_path.slice(prefix.length) : node.file_path, language: node.language ?? '', symbols: [], x: 0, y: 0 }) - 1;
      byPath.set(node.file_path, at);
    }
    owner.set(node.qualified_name, at);
    if (node.kind !== 'File') files[at].symbols.push(node);
  }
  const weights = new Map<string, number>();
  for (const edge of graph.edges) {
    const a = owner.get(edge.source), b = owner.get(edge.target);
    // Unresolved calls target bare names that match no node; they cannot be placed.
    if (!DEPENDENCIES.has(edge.kind) || a === undefined || b === undefined || a === b) continue;
    const key = Math.min(a, b) + ' ' + Math.max(a, b);
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  const links: MapLink[] = [...weights].map(([key, weight]) => { const [from, to] = key.split(' ').map(Number); return { from, to, weight }; });
  layout(files, links, size);
  return { files, links };
}

// shortcut: O(n²) Fruchterman–Reingold per step; fine for a few hundred files, use a quadtree for monorepos.
function layout(files: MapFile[], links: MapLink[], size: number) {
  const n = files.length, k = size / Math.sqrt(Math.max(n, 1)), gravity = n / 16;
  files.forEach((file, i) => { const angle = 2 * Math.PI * i / Math.max(n, 1); file.x = Math.cos(angle) * size / 3; file.y = Math.sin(angle) * size / 3; });
  for (let step = 0, heat = size / 8; step < 300; step++, heat *= 0.98) {
    const dx = new Float64Array(n), dy = new Float64Array(n);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const x = files[i].x - files[j].x, y = files[i].y - files[j].y, d2 = Math.max(x * x + y * y, 0.01), push = k * k / d2;
      dx[i] += x * push; dy[i] += y * push; dx[j] -= x * push; dy[j] -= y * push;
    }
    for (const { from, to } of links) {
      const x = files[from].x - files[to].x, y = files[from].y - files[to].y, pull = Math.hypot(x, y) / k;
      dx[from] -= x * pull; dy[from] -= y * pull; dx[to] += x * pull; dy[to] += y * pull;
    }
    files.forEach((file, i) => {
      // Gravity toward the centre keeps files without dependencies on screen.
      const mx = dx[i] - file.x * gravity, my = dy[i] - file.y * gravity, d = Math.hypot(mx, my) || 1, move = Math.min(d, heat);
      file.x += mx / d * move; file.y += my / d * move;
    });
  }
  const margin = 40, xs = files.map(f => f.x), ys = files.map(f => f.y);
  const minX = Math.min(...xs), minY = Math.min(...ys), width = Math.max(...xs) - minX, height = Math.max(...ys) - minY;
  const scale = (size - 2 * margin) / Math.max(width, height, 1), left = (size - width * scale) / 2, top = (size - height * scale) / 2;
  for (const file of files) { file.x = left + (file.x - minX) * scale; file.y = top + (file.y - minY) * scale; }
}

/** Symbols whose name contains the query (case-insensitive), with the index of their file. */
export function searchSymbols(files: MapFile[], query: string, limit = 200) {
  const needle = query.trim().toLowerCase(), hits: { file: number; symbol: CodeNode }[] = [];
  if (!needle) return hits;
  files.forEach((file, at) => { for (const symbol of file.symbols) if (hits.length < limit && symbol.name.toLowerCase().includes(needle)) hits.push({ file: at, symbol }); });
  return hits;
}
