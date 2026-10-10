import type { Commit, RefInfo } from './git.ts';

export const laneColors = ['#7aa2f7', '#8bc58a', '#5ec4c0', '#d98fb0', '#a98be0', '#d6b57d'];
export interface Rail { lane: number; color: string; parent: string }
export interface LayoutRow {
  commit: Commit; lane: number; color: string; incoming: boolean;
  through: Rail[]; outgoing: Rail[];
}
export interface Layout { rows: LayoutRow[]; lanes: number; pending: Rail[] }

export function findCommits(commits: Commit[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  return needle ? commits.filter(commit => [commit.subject, commit.author, commit.oid].some(value => value.toLowerCase().includes(needle))).map(commit => commit.oid) : [];
}

export function layoutHistory(commits: Commit[], refs: RefInfo[] = []): Layout {
  const tips = new Map<string, string>();
  for (const ref of refs.filter(ref => ref.kind !== 'tag').sort((a, b) => a.fullName.localeCompare(b.fullName))) {
    if (!tips.has(ref.target)) tips.set(ref.target, laneColors[tips.size % laneColors.length]);
  }
  const active: (string | null)[] = [];
  const colors: string[] = [];
  const rows: LayoutRow[] = [];
  let lanes = 0;
  const seen = new Set<string>();
  const available = (exclude = -1) => { const vacancy = active.findIndex((parent, index) => parent === null && index !== exclude); return vacancy < 0 ? active.length : vacancy; };
  let nextColor = tips.size;
  const newColor = () => laneColors[nextColor++ % laneColors.length];
  const color = (lane: number) => colors[lane];
  for (const commit of commits) {
    if (seen.has(commit.oid)) throw new Error('History contains a duplicate commit');
    if (commit.parents.some(parent => seen.has(parent))) throw new Error('History is not in descendant-before-parent order');
    seen.add(commit.oid);
    const expected = active.indexOf(commit.oid);
    const lane = expected < 0 ? available() : expected;
    if (expected < 0) colors[lane] = tips.get(commit.oid) ?? newColor();
    const nodeColor = color(lane);
    const through = active.flatMap((parent, index) => parent && index !== lane ? [{ lane: index, color: color(index), parent }] : []);
    active[lane] = null;
    const outgoing: Rail[] = [];
    for (const [index, parent] of [...new Set(commit.parents)].entries()) {
      let destination = active.indexOf(parent);
      if (destination < 0) {
        // A named parent starts its own path even when the newer branch is only ahead.
        const branchTip = tips.has(parent);
        destination = index === 0 && !branchTip && active[lane] === null ? lane : available(branchTip ? lane : -1);
        active[destination] = parent;
        colors[destination] = tips.get(parent) ?? (index === 0 ? nodeColor : newColor());
      }
      outgoing.push({ lane: destination, color: index === 0 ? nodeColor : color(destination), parent });
    }
    lanes = Math.max(lanes, lane + 1, active.length);
    rows.push({ commit, lane, color: nodeColor, incoming: expected >= 0, through, outgoing });
  }
  const pending = active.flatMap((parent, lane) => parent ? [{ parent, lane, color: color(lane) }] : []);
  return { rows, lanes, pending };
}

const NS = 'http://www.w3.org/2000/svg';
function element(tag: string, attributes: Record<string, string | number>) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

export function paintGraph(svg: SVGSVGElement, layout: Layout, height: number, rowHeight: number, selected: string | null, head: string | null) {
  const width = Math.max(132, layout.lanes * 18 + 28);
  svg.replaceChildren();
  svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const description = element('desc', {});
  description.textContent = 'Each dot is a commit. Named branch tips start separate colored paths. Lines connect commits to their parents. Rings show merges; dashed nodes indicate shallow boundaries.';
  svg.append(description);
  const x = (lane: number) => 26 + lane * 18;
  for (const [index, row] of layout.rows.entries()) {
    const top = index * rowHeight; const center = top + rowHeight / 2; const bottom = top + rowHeight;
    for (const rail of row.through) svg.append(element('path', { d: `M${x(rail.lane)} ${top}V${bottom}`, stroke: rail.color, 'stroke-width': 1.75, fill: 'none' }));
    if (row.incoming) svg.append(element('path', { d: `M${x(row.lane)} ${top}V${center}`, stroke: row.color, 'stroke-width': 1.75, fill: 'none' }));
    for (const rail of row.outgoing) {
      const path = rail.lane === row.lane ? `M${x(row.lane)} ${center}V${bottom}` : `M${x(row.lane)} ${center}C${x(row.lane)} ${center + 7} ${x(rail.lane)} ${bottom - 7} ${x(rail.lane)} ${bottom}`;
      svg.append(element('path', { d: path, stroke: rail.color, 'stroke-width': 1.75, fill: 'none', 'data-child': row.commit.oid, 'data-parent': rail.parent }));
    }
    if (row.commit.oid === head) svg.append(element('circle', { cx: x(row.lane), cy: center, r: 8, fill: 'none', stroke: row.color, opacity: .35 }));
    const node = element('circle', { cx: x(row.lane), cy: center, r: row.commit.parents.length > 1 ? 5.5 : 4, fill: row.commit.parents.length === 1 ? row.color : '#141518', stroke: row.color, 'stroke-width': row.commit.oid === selected ? 2 : 1.75, 'data-node': row.commit.oid });
    if (row.commit.shallow) node.setAttribute('stroke-dasharray', '2 2');
    svg.append(node);
  }
  for (const rail of layout.pending) svg.append(element('path', { d: `M${x(rail.lane)} ${layout.rows.length * rowHeight}v8`, stroke: rail.color, 'stroke-width': 1.75, 'stroke-dasharray': '2 2', fill: 'none' }));
}
