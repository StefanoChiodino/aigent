import type { DiffFile } from '../types';

export function parseDiffIntoFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const sections = diff.split(/(?=^--- a\/)/m);
  for (const section of sections) {
    if (!section.trim()) continue;
    const pathMatch = section.match(/^\+\+\+ b\/(.+)$/m);
    if (!pathMatch) continue;
    const path = pathMatch[1]!.trim();
    const name = path.split('/').pop() ?? path;
    files.push({ name, path, content: section });
  }
  return files.length > 0 ? files : [{ name: 'patch', path: '', content: diff }];
}

export type DiffSegment = { text: string; changed: boolean };

export function charDiff(
  oldStr: string,
  newStr: string,
): [DiffSegment[], DiffSegment[]] {
  const m = oldStr.length, n = newStr.length;
  if (m * n > 40000) {
    return [[{ text: oldStr, changed: true }], [{ text: newStr, changed: true }]];
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0) as number[]);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = oldStr[i - 1] === newStr[j - 1]
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  const oldSegs: DiffSegment[] = [];
  const newSegs: DiffSegment[] = [];
  let i = m, j = n, oldBuf = '', newBuf = '', sameBuf = '';
  const flush = (same: string, old: string, nw: string) => {
    if (same) { oldSegs.push({ text: same, changed: false }); newSegs.push({ text: same, changed: false }); }
    if (old) oldSegs.push({ text: old, changed: true });
    if (nw) newSegs.push({ text: nw, changed: true });
  };
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldStr[i - 1] === newStr[j - 1]) {
      if (oldBuf || newBuf) { flush('', oldBuf, newBuf); oldBuf = ''; newBuf = ''; }
      sameBuf = oldStr[i - 1]! + sameBuf;
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      if (sameBuf) { flush(sameBuf, '', ''); sameBuf = ''; }
      newBuf = newStr[j - 1]! + newBuf;
      j--;
    } else {
      if (sameBuf) { flush(sameBuf, '', ''); sameBuf = ''; }
      oldBuf = oldStr[i - 1]! + oldBuf;
      i--;
    }
  }
  flush(sameBuf, oldBuf, newBuf);
  return [oldSegs, newSegs];
}
