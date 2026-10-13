export interface CodeNode { kind: string; name: string; qualified_name: string; file_path: string; line_start: number | null; language: string | null; is_test?: boolean }
export interface CodeEdge { kind: string; source: string; target: string }
export interface CodeGraph { nodes: CodeNode[]; edges: CodeEdge[] }
export interface MapFile { path: string; dir: string; language: string; test: boolean; symbols: CodeNode[]; x: number; y: number; r: number }
export interface MapLink { from: number; to: number; weight: number }

const DEPENDENCIES = new Set(['CALLS', 'IMPORTS_FROM', 'INHERITS', 'REFERENCES']);
const TEST_PATH = /(^|\/)(tests?|__tests__)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$/;

/** Collapses the code-review-graph export to files and the dependencies between them, laid out in a width×height box. */
export function fileMap(graph: CodeGraph, root: string, { width = 600, height = 600, tests = true } = {}) {
  const prefix = root.endsWith('/') ? root : root + '/';
  const files: MapFile[] = [], byPath = new Map<string, number>(), owner = new Map<string, number>();
  for (const node of graph.nodes) {
    const path = node.file_path.startsWith(prefix) ? node.file_path.slice(prefix.length) : node.file_path;
    const test = TEST_PATH.test(path) || (node.kind === 'File' && !!node.is_test);
    if (test && !tests) continue;
    let at = byPath.get(node.file_path);
    if (at === undefined) {
      at = files.push({ path, dir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.', language: node.language ?? '', test, symbols: [], x: 0, y: 0, r: 0 }) - 1;
      byPath.set(node.file_path, at);
    }
    files[at].test ||= test;
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
  const neighbors = files.map(() => new Set<number>());
  for (const { from, to } of links) { neighbors[from].add(to); neighbors[to].add(from); }
  for (const file of files) file.r = 3 + Math.sqrt(file.symbols.length) * 1.1;
  layout(files, links, neighbors, width, height);
  return { files, links, neighbors };
}

// shortcut: O(n²) Fruchterman–Reingold per step; fine for a few hundred files, use a quadtree for monorepos.
function layout(files: MapFile[], links: MapLink[], neighbors: Set<number>[], width: number, height: number) {
  const n = files.length, size = Math.sqrt(width * height), k = size / Math.sqrt(Math.max(n, 1)), gravity = n / 16;
  // Start each folder in its own sector so folders stay together as the layout settles.
  const dirs = [...new Set(files.map(file => file.dir))].sort(), seen = new Map<string, number>();
  files.forEach(file => {
    const d = dirs.indexOf(file.dir), nth = seen.get(file.dir) ?? 0; seen.set(file.dir, nth + 1);
    const angle = 2 * Math.PI * d / dirs.length + nth * 0.35, radius = size / 3 + (nth % 5) * k / 3;
    file.x = Math.cos(angle) * radius * width / size; file.y = Math.sin(angle) * radius * height / size;
  });
  for (let step = 0, heat = size / 8; step < 400; step++, heat *= 0.985) {
    const dx = new Float64Array(n), dy = new Float64Array(n), centre = new Map<string, [number, number, number]>();
    for (const file of files) { const c = centre.get(file.dir) ?? [0, 0, 0]; c[0] += file.x; c[1] += file.y; c[2]++; centre.set(file.dir, c); }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const x = files[i].x - files[j].x, y = files[i].y - files[j].y, d2 = Math.max(x * x + y * y, 0.01), push = k * k / d2;
      dx[i] += x * push; dy[i] += y * push; dx[j] -= x * push; dy[j] -= y * push;
    }
    for (const { from, to, weight } of links) {
      // Weaken links of hub files so one heavily used file does not swallow the map.
      const x = files[from].x - files[to].x, y = files[from].y - files[to].y;
      const pull = Math.hypot(x, y) / k * (1 + Math.log2(weight)) / Math.sqrt(Math.min(neighbors[from].size, neighbors[to].size) + 1);
      dx[from] -= x * pull; dy[from] -= y * pull; dx[to] += x * pull; dy[to] += y * pull;
    }
    files.forEach((file, i) => {
      const [cx, cy, count] = centre.get(file.dir)!, tx = cx / count - file.x, ty = cy / count - file.y, cohesion = Math.hypot(tx, ty) / k * 0.6;
      // Gravity toward the centre keeps files without dependencies on screen.
      const mx = dx[i] - file.x * gravity + tx * cohesion, my = dy[i] - file.y * gravity + ty * cohesion, d = Math.hypot(mx, my) || 1, move = Math.min(d, heat);
      file.x += mx / d * move; file.y += my / d * move;
    });
  }
  // Fit the linked files to the box; unlinked ones would otherwise stretch it and shrink everything else.
  const margin = 30, fit = files.filter((_, i) => neighbors[i].size).length > 1 ? files.filter((_, i) => neighbors[i].size) : files;
  const xs = fit.map(f => f.x), ys = fit.map(f => f.y), minX = Math.min(...xs), minY = Math.min(...ys), spanX = Math.max(...xs) - minX, spanY = Math.max(...ys) - minY;
  // Stretch up to 1.6× along the longer side so a round layout fills a wide panel.
  const sx = (width - 2 * margin) / Math.max(spanX, 1), sy = (height - 2 * margin) / Math.max(spanY, 1);
  const scaleX = Math.min(sx, sy * 1.6), scaleY = Math.min(sy, sx * 1.6), left = (width - spanX * scaleX) / 2, top = (height - spanY * scaleY) / 2;
  for (const file of files) { file.x = left + (file.x - minX) * scaleX; file.y = top + (file.y - minY) * scaleY; }
  // Push overlapping circles apart, then keep them inside the box.
  for (let pass = 0; pass < 60; pass++) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = files[i], b = files[j], x = b.x - a.x, y = b.y - a.y, d = Math.hypot(x, y) || 0.01, gap = a.r + b.r + 12 - d;
    if (gap > 0) { const ux = x / d * gap / 2, uy = y / d * gap / 2; a.x -= ux; a.y -= uy; b.x += ux; b.y += uy; }
  }
  for (let pass = 0; pass < 3; pass++) for (const file of files) { file.x = Math.min(Math.max(file.x, file.r + 4), width - file.r - 4); file.y = Math.min(Math.max(file.y, file.r + 4), height - file.r - 4); }
}

/** Symbols whose name contains the query (case-insensitive), with the index of their file. */
export function searchSymbols(files: MapFile[], query: string, limit = 200) {
  const needle = query.trim().toLowerCase(), hits: { file: number; symbol: CodeNode }[] = [];
  if (!needle) return hits;
  files.forEach((file, at) => { for (const symbol of file.symbols) if (hits.length < limit && symbol.name.toLowerCase().includes(needle)) hits.push({ file: at, symbol }); });
  return hits;
}
