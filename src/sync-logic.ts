export function pullDiverged(error: unknown) { return /not possible to fast-forward|cannot fast-forward|divergent branches/i.test(String(error)); }
export function changesBlock(error: unknown) { return /would be overwritten|local changes|working changes block|commit or otherwise resolve working changes|not uptodate|untracked working tree files/i.test(String(error)); }
export function pushRejected(error: unknown) { return /non-fast-forward|fetch first/i.test(String(error)); }
export function staleBranch(timestamp: number, now = Date.now()) { return Number.isFinite(timestamp) && timestamp > 0 && now - timestamp * 1000 >= 90 * 86400_000; }
