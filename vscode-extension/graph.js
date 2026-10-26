// Commits must be in child-before-parent (topological) order.
function layoutGraph(commits) {
  const lanes = [];
  const nodes = [];
  const edges = [];
  const rows = new Map(commits.map((commit, row) => [commit.oid, row]));
  let width = 1;
  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row];
    let lane = lanes.indexOf(commit.oid);
    if (lane < 0) {
      lane = lanes.indexOf(null);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = commit.oid;
    }
    nodes.push({ oid: commit.oid, row, lane });
    lanes[lane] = null;
    for (const [index, parent] of commit.parents.entries()) {
      let target = lanes.indexOf(parent);
      if (target < 0) {
        target = index === 0 ? lane : lanes.indexOf(null);
        if (target < 0 || lanes[target]) target = lanes.length;
        lanes[target] = parent;
      }
      edges.push({ from: row, fromLane: lane, to: rows.get(parent) ?? commits.length,
        toLane: target, parent, boundary: !rows.has(parent) });
    }
    width = Math.max(width, lanes.length);
  }
  return { nodes, edges, width };
}

module.exports = { layoutGraph };
