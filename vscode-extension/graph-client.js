/* global acquireVsCodeApi, document, window */
(() => {
  const api = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  const colors = ['blue', 'green', 'orange', 'purple', 'red', 'yellow'];
  const svgNode = (tag, attributes) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    byId('lanes').appendChild(node);
    return node;
  };
  const color = lane => `var(--vscode-charts-${colors[lane % colors.length]})`;
  let selectedButton;
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'error') { byId('status').textContent = data.message; return; }
    if (data.type === 'commits') {
      const { commits, graph } = data;
      byId('lanes').replaceChildren();
      byId('commits').replaceChildren();
      byId('files').replaceChildren();
      byId('title').textContent = 'Select a commit';
      byId('message').textContent = '';
      byId('status').textContent = `${commits.length} commits from all branches${commits.length === 2000 ? ' (limit reached)' : ''}. Merge diffs use the first parent.`;
      byId('lanes').setAttribute('width', graph.width * 18 + 18);
      byId('lanes').setAttribute('height', commits.length * 32 + 16);
      for (const edge of graph.edges) {
        const x = edge.fromLane * 18 + 12, y = edge.from * 32 + 16;
        const tx = edge.toLane * 18 + 12, ty = edge.to * 32 + 16;
        svgNode('path', { d: `M${x} ${y} C${x} ${y + 16} ${tx} ${y + 16} ${tx} ${y + 32} L${tx} ${ty}`,
          fill: 'none', stroke: color(edge.toLane), 'stroke-width': 2, ...(edge.boundary ? { 'stroke-dasharray': '3 3' } : {}) });
      }
      for (const node of graph.nodes) svgNode('circle', {
        cx: node.lane * 18 + 12, cy: node.row * 32 + 16, r: 4, fill: color(node.lane)
      });
      for (const commit of commits) {
        const button = document.createElement('button');
        button.textContent = `${commit.oid.slice(0, 8)} ${commit.subject} — ${commit.author} · ${commit.date.slice(0, 10)}`;
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => {
          if (selectedButton) selectedButton.setAttribute('aria-pressed', 'false');
          button.setAttribute('aria-pressed', 'true');
          selectedButton = button;
          byId('title').textContent = commit.subject;
          byId('message').textContent = 'Loading changed files…';
          byId('files').replaceChildren();
          api.postMessage({ type: 'select', oid: commit.oid });
        });
        byId('commits').appendChild(button);
      }
    }
    if (data.type === 'files') {
      byId('title').textContent = data.commit.subject;
      byId('message').textContent = `${data.commit.author} · ${data.commit.date}\n\n${data.commit.message}`;
      byId('files').replaceChildren();
      for (const file of data.files) {
        const button = document.createElement('button');
        button.textContent = `${file.status} ${file.path}`;
        button.addEventListener('click', () => api.postMessage({ type: 'diff', oid: data.commit.oid, file: file.path }));
        byId('files').appendChild(button);
      }
    }
  });
  api.postMessage({ type: 'ready' });
})();
