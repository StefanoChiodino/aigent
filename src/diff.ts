/** Build a proper unified-diff string for display with diff2html. */
export function buildDisplayDiff(original: string, updated: string, label: string): string {
  const origLines = original.split('\n');
  const updLines = updated.split('\n');
  const maxLen = Math.max(origLines.length, updLines.length);

  // Build raw change list: context (' '), remove ('-'), add ('+')
  const changes: Array<{ type: ' ' | '-' | '+'; line: string }> = [];
  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i];
    const u = updLines[i];
    if (o === u) {
      if (o !== undefined) changes.push({ type: ' ', line: o });
    } else {
      if (o !== undefined) changes.push({ type: '-', line: o });
      if (u !== undefined) changes.push({ type: '+', line: u });
    }
  }

  // Group into hunks (each change group with up to 3 lines of context)
  const CONTEXT = 3;
  const hunks: string[] = [];
  let i = 0;
  while (i < changes.length) {
    // Skip pure context lines looking for the next change
    if (changes[i]!.type === ' ') { i++; continue; }

    // Found a change — expand context window around it
    const ctxStart = Math.max(0, i - CONTEXT);
    let end = i;
    // Extend through the change group and merge nearby groups
    while (end < changes.length) {
      // Walk past the current change group
      while (end < changes.length && changes[end]!.type !== ' ') end++;
      // Check if the next change is within merge distance
      let peek = end;
      while (peek < changes.length && peek - end < 2 * CONTEXT && changes[peek]!.type === ' ') peek++;
      if (peek < changes.length && changes[peek]!.type !== ' ') {
        end = peek; // merge with next group
      } else {
        break;
      }
    }
    const ctxEnd = Math.min(changes.length, end + CONTEXT);

    // Count old/new lines for the hunk header
    let oldCount = 0, newCount = 0;
    let oldStart = 1, newStart = 1;
    // Compute starting line numbers by counting lines before ctxStart
    for (let j = 0; j < ctxStart; j++) {
      if (changes[j]!.type !== '+') oldStart++;
      if (changes[j]!.type !== '-') newStart++;
    }
    const hunkLines: string[] = [];
    for (let j = ctxStart; j < ctxEnd; j++) {
      const c = changes[j]!;
      hunkLines.push(`${c.type}${c.line}`);
      if (c.type !== '+') oldCount++;
      if (c.type !== '-') newCount++;
    }
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    hunks.push(...hunkLines);

    i = ctxEnd;
  }

  // If no hunks (files are identical), produce an empty diff
  if (hunks.length === 0) return '';

  return `--- a/${label}\n+++ b/${label}\n${hunks.join('\n')}`;
}
