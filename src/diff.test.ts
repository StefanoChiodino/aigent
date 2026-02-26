import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDisplayDiff } from './diff.js';

describe('buildDisplayDiff', () => {
  it('returns empty string for identical content', () => {
    const text = 'line 1\nline 2\nline 3';
    assert.equal(buildDisplayDiff(text, text, 'test.txt'), '');
  });

  it('produces valid unified diff headers', () => {
    const diff = buildDisplayDiff('old', 'new', 'src/foo.ts');
    assert.ok(diff.startsWith('--- a/src/foo.ts\n+++ b/src/foo.ts\n'));
  });

  it('includes @@ hunk header', () => {
    const diff = buildDisplayDiff('old', 'new', 'file.ts');
    assert.ok(diff.includes('@@ -'));
    assert.ok(diff.includes(' +'));
    assert.ok(diff.includes(' @@'));
  });

  it('marks removed lines with - prefix', () => {
    const diff = buildDisplayDiff('old line', 'new line', 'f.ts');
    const lines = diff.split('\n');
    assert.ok(lines.some(l => l === '-old line'), 'should have -old line');
  });

  it('marks added lines with + prefix', () => {
    const diff = buildDisplayDiff('old line', 'new line', 'f.ts');
    const lines = diff.split('\n');
    assert.ok(lines.some(l => l === '+new line'), 'should have +new line');
  });

  it('marks unchanged lines with space prefix', () => {
    const original = 'keep\nold\nkeep';
    const updated = 'keep\nnew\nkeep';
    const diff = buildDisplayDiff(original, updated, 'f.ts');
    const lines = diff.split('\n');
    assert.ok(lines.some(l => l === ' keep'), 'should have context line with space prefix');
  });

  it('handles added lines (updated longer than original)', () => {
    const original = 'line 1\nline 2';
    const updated = 'line 1\nline 2\nline 3';
    const diff = buildDisplayDiff(original, updated, 'f.ts');
    assert.ok(diff.includes('+line 3'));
  });

  it('handles removed lines (original longer than updated)', () => {
    const original = 'line 1\nline 2\nline 3';
    const updated = 'line 1\nline 2';
    const diff = buildDisplayDiff(original, updated, 'f.ts');
    assert.ok(diff.includes('-line 3'));
  });

  it('produces correct hunk counts for a simple change', () => {
    const original = 'a';
    const updated = 'b';
    const diff = buildDisplayDiff(original, updated, 'f.ts');
    // 1 old line removed, 1 new line added
    assert.ok(diff.includes('@@ -1,1 +1,1 @@'));
  });

  it('includes up to 3 context lines around changes', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const original = lines.join('\n');
    const modified = [...lines];
    modified[5] = 'CHANGED';  // change line 6 (0-indexed 5)
    const updated = modified.join('\n');
    const diff = buildDisplayDiff(original, updated, 'f.ts');
    const diffLines = diff.split('\n');
    // Should include 3 context lines before (lines 3,4,5) and 3 after (lines 7,8,9)
    assert.ok(diffLines.some(l => l === ' line 4'), 'should have context before');
    assert.ok(diffLines.some(l => l === ' line 5'), 'should have context before');
    assert.ok(diffLines.some(l => l === ' line 7'), 'should have context after');
    assert.ok(diffLines.some(l => l === ' line 8'), 'should have context after');
    assert.ok(diffLines.some(l => l === ' line 9'), 'should have context after');
    // Should NOT include distant lines
    assert.ok(!diffLines.some(l => l === ' line 1'), 'should not have distant context');
    assert.ok(!diffLines.some(l => l === ' line 2'), 'should not have distant context');
  });

  it('merges nearby hunks within 6-line gap', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const original = lines.join('\n');
    const modified = [...lines];
    modified[2] = 'CHANGED A';  // line 3
    modified[7] = 'CHANGED B';  // line 8 — gap of 4 context lines, should merge
    const updated = modified.join('\n');
    const diff = buildDisplayDiff(original, updated, 'f.ts');
    const hunkHeaders = diff.split('\n').filter(l => l.startsWith('@@'));
    assert.equal(hunkHeaders.length, 1, 'nearby changes should merge into one hunk');
  });

  it('keeps distant hunks separate', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const original = lines.join('\n');
    const modified = [...lines];
    modified[1] = 'CHANGED A';  // line 2
    modified[25] = 'CHANGED B'; // line 26 — far apart
    const updated = modified.join('\n');
    const diff = buildDisplayDiff(original, updated, 'f.ts');
    const hunkHeaders = diff.split('\n').filter(l => l.startsWith('@@'));
    assert.equal(hunkHeaders.length, 2, 'distant changes should be separate hunks');
  });

  it('hunk header line numbers are correct for change in the middle', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const original = lines.join('\n');
    const modified = [...lines];
    modified[5] = 'CHANGED';  // change at line 6 (1-indexed)
    const updated = modified.join('\n');
    const diff = buildDisplayDiff(original, updated, 'f.ts');
    const hunkHeader = diff.split('\n').find(l => l.startsWith('@@'))!;
    // Context starts 3 lines before line 6 → line 3
    // old: lines 3-9 = 7 lines (3 context + 1 removed + 3 context)
    // new: lines 3-9 = 7 lines (3 context + 1 added + 3 context)
    assert.ok(hunkHeader.includes('-3,7'), `old should start at 3: ${hunkHeader}`);
    assert.ok(hunkHeader.includes('+3,7'), `new should start at 3: ${hunkHeader}`);
  });

  it('handles empty original (new file)', () => {
    const diff = buildDisplayDiff('', 'new content', 'f.ts');
    assert.ok(diff.includes('+new content'));
    assert.ok(diff.includes('@@ -'));
  });

  it('handles empty updated (file deleted)', () => {
    const diff = buildDisplayDiff('old content', '', 'f.ts');
    assert.ok(diff.includes('-old content'));
  });

  it('output is parseable by diff2html format expectations', () => {
    const original = 'const x = 1;\nexport { x };';
    const updated = 'const x = 1;\nconst y = 2;\nexport { x };';
    const diff = buildDisplayDiff(original, updated, 'src/foo.ts');
    // Verify structure: header lines, hunk header, diff lines
    const lines = diff.split('\n');
    assert.equal(lines[0], '--- a/src/foo.ts');
    assert.equal(lines[1], '+++ b/src/foo.ts');
    assert.ok(lines[2]!.startsWith('@@ '));
    // At least one context, removal, or addition line follows
    assert.ok(lines.length > 3);
  });
});
