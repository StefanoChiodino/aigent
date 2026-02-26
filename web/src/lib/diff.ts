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
