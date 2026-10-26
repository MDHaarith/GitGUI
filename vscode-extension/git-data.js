const path = require('node:path');

const LOG_FORMAT = '%H%x00%P%x00%an%x00%aI%x00%s%x00%B%x00';

function revision(value) {
  if (typeof value !== 'string' || !/^(?:HEAD|[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error('Invalid Git revision.');
  }
  return value;
}

function filePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid repository-relative file path.');
  }
  return value;
}

function relativePath(root, absolute) {
  const relative = path.relative(root, absolute);
  return filePath(relative.split(path.sep).join('/'));
}

function parseLog(output) {
  const fields = output.split('\0');
  const commits = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const oid = fields[i].replace(/^\n+/, '');
    if (!oid) continue;
    revision(oid);
    const parents = fields[i + 1].split(' ').filter(Boolean);
    parents.forEach(revision);
    commits.push({ oid, parents, author: fields[i + 2], date: fields[i + 3],
      subject: fields[i + 4], message: fields[i + 5] });
  }
  return commits;
}

function parseFiles(output) {
  const fields = output.split('\0');
  const files = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++].trim();
    if (!/^[ACDMRTUXB][0-9]*$/.test(status)) throw new Error('Invalid Git file status.');
    const oldPath = filePath(fields[i++]);
    const name = /^[RC]/.test(status) ? filePath(fields[i++]) : oldPath;
    files.push({ status: status[0], path: name, oldPath });
  }
  return files;
}

function parseHistory(output, currentPath) {
  const fields = output.split('\0');
  const history = [];
  let file = filePath(currentPath);
  for (let i = 0; i + 5 < fields.length;) {
    // With -z Git places an extra NUL between log records and name-status output.
    while (fields[i] === '' || fields[i] === '\n') i++;
    if (i + 5 >= fields.length) break;
    const commit = parseLog(fields.slice(i, i + 6).join('\0') + '\0')[0];
    i += 6;
    const changed = [];
    while (i < fields.length) {
      const status = fields[i].replace(/^\n+/, '');
      if (!status) { i++; continue; }
      if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(status)) break;
      if (!/^[ACDMRTUXB][0-9]*$/.test(status)) throw new Error('Invalid file history status.');
      changed.push(status, fields[i + 1]);
      if (/^[RC]/.test(status)) changed.push(fields[i + 2]);
      i += /^[RC]/.test(status) ? 3 : 2;
    }
    const files = parseFiles(changed.join('\0'));
    const entry = files.find(item => item.path === file);
    if (entry) {
      history.push({ ...commit, file });
      if (entry.status === 'R') file = entry.oldPath;
    }
  }
  return history;
}

function unquotePath(value) {
  if (!value.startsWith('"')) return value;
  // Git quotes control characters and UTF-8 bytes using C-style escapes.
  const bytes = [];
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '\\': 92, '"': 34 };
  for (let i = 1; i < value.length - 1; i++) {
    if (value[i] !== '\\') {
      const character = String.fromCodePoint(value.codePointAt(i));
      bytes.push(...Buffer.from(character));
      i += character.length - 1;
      continue;
    }
    const octal = value.slice(i + 1).match(/^[0-7]{1,3}/);
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += octal[0].length; }
    else { bytes.push(escapes[value[++i]] ?? 63); }
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseBlame(output) {
  const lines = output.split('\n');
  const header = lines.shift().match(/^([a-f0-9]{40}|[a-f0-9]{64}) (\d+) (\d+)(?: \d+)?$/);
  if (!header || /^0+$/.test(header[1])) return null;
  const result = { oid: revision(header[1]) };
  for (const line of lines) {
    if (line.startsWith('\t')) break;
    const space = line.indexOf(' ');
    const key = line.slice(0, space), value = line.slice(space + 1);
    if (key === 'author') result.author = value;
    if (key === 'author-time') result.time = Number(value) * 1000;
    if (key === 'summary') result.subject = value;
    if (key === 'filename') result.path = filePath(unquotePath(value));
  }
  return result.author && Number.isFinite(result.time) && result.path ? result : null;
}

function relativeTime(time, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  for (const [size, unit] of [[31536000, 'year'], [2592000, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size);
      return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

module.exports = { LOG_FORMAT, revision, filePath, relativePath, parseLog, parseFiles, parseHistory, parseBlame, relativeTime };
