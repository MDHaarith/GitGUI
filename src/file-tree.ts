import type { FileInfo } from './git.ts';

export function folders(files: Pick<FileInfo, 'path'>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const parts = file.path.split('/'); parts.pop();
    for (let n = 1; n <= parts.length; n++) {
      const path = parts.slice(0, n).join('/'); counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return counts;
}

const collapsed = new Set<string>();

/** Returns each file's parent while leaving existing file rows and actions intact. */
export function folderParents(list: HTMLElement, files: FileInfo[], group: string): Map<string, HTMLElement> {
  const parents = new Map<string, HTMLElement>([['', list]]);
  for (const [path, count] of folders(files)) {
    const slash = path.lastIndexOf('/'); const parent = path.slice(0, slash < 0 ? 0 : slash);
    const folder = document.createElement('details'); folder.className = 'file-folder';
    const key = group + ':' + path; folder.open = !collapsed.has(key);
    const summary = document.createElement('summary'); summary.textContent = path.slice(slash + 1) + ' · ' + count;
    folder.append(summary); parents.get(parent)!.append(folder); parents.set(path, folder);
    folder.ontoggle = () => { if (folder.open) collapsed.delete(key); else collapsed.add(key); };
  }
  return new Map(files.map(file => [file.id, parents.get(file.path.slice(0, Math.max(0, file.path.lastIndexOf('/'))))!]));
}
