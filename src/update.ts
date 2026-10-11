/** True when version `a` (like 1.2.10) is newer than `b`. */
export function isNewer(a: string, b: string): boolean {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
