import React, { useMemo, useState } from 'react';
import { charDiff } from '../../lib/diff';

interface Props {
  diffText: string;
}

type LineType = 'hunk' | 'header' | 'remove' | 'add' | 'context';

interface ParsedLine {
  type: LineType;
  raw: string;
  content: string;
  oldLn: number | null;
  newLn: number | null;
}

interface CharSegment {
  text: string;
  changed: boolean;
}

interface RenderedLine extends ParsedLine {
  segments?: CharSegment[];
}

interface CollapsedGroup {
  type: 'collapsed';
  lines: RenderedLine[];
}

type RenderItem = RenderedLine | CollapsedGroup;

const COLLAPSE_THRESHOLD = 6;
const KEEP_EDGES = 3;

function parseLines(diffText: string): ParsedLine[] {
  const lines = diffText.split('\n');
  if (lines.at(-1) === '' && diffText.endsWith('\n')) lines.pop();

  const result: ParsedLine[] = [];
  let oldLn = 0;
  let newLn = 0;

  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldLn = parseInt(m[1]!, 10) - 1; newLn = parseInt(m[2]!, 10) - 1; }
      result.push({ type: 'hunk', raw, content: raw, oldLn: null, newLn: null });
    } else if (raw.startsWith('---') || raw.startsWith('+++')) {
      result.push({ type: 'header', raw, content: raw, oldLn: null, newLn: null });
    } else if (raw.startsWith('-')) {
      oldLn++;
      result.push({ type: 'remove', raw, content: raw.slice(1), oldLn, newLn: null });
    } else if (raw.startsWith('+')) {
      newLn++;
      result.push({ type: 'add', raw, content: raw.slice(1), oldLn: null, newLn });
    } else {
      oldLn++; newLn++;
      result.push({ type: 'context', raw, content: raw.length > 0 ? raw.slice(1) : '', oldLn, newLn });
    }
  }
  return result;
}

function withCharDiffs(parsed: ParsedLine[]): RenderedLine[] {
  const result: RenderedLine[] = [];
  let i = 0;
  while (i < parsed.length) {
    const cur = parsed[i]!;
    const next = parsed[i + 1];
    if (cur.type === 'remove' && next?.type === 'add') {
      const [oldSegs, newSegs] = charDiff(cur.content, next.content);
      result.push({ ...cur, segments: oldSegs });
      result.push({ ...next, segments: newSegs });
      i += 2;
    } else {
      result.push({ ...cur });
      i++;
    }
  }
  return result;
}

function groupContextRuns(lines: RenderedLine[]): RenderItem[] {
  const result: RenderItem[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.type === 'context') {
      let j = i;
      while (j < lines.length && lines[j]!.type === 'context') j++;
      const run = lines.slice(i, j);
      if (run.length >= COLLAPSE_THRESHOLD) {
        for (const l of run.slice(0, KEEP_EDGES)) result.push(l);
        const middle = run.slice(KEEP_EDGES, run.length - KEEP_EDGES);
        if (middle.length > 0) result.push({ type: 'collapsed', lines: middle });
        for (const l of run.slice(run.length - KEEP_EDGES)) result.push(l);
      } else {
        for (const l of run) result.push(l);
      }
      i = j;
    } else {
      result.push(lines[i]!);
      i++;
    }
  }
  return result;
}

function renderSegments(segments: CharSegment[] | undefined, content: string): React.ReactNode {
  if (!segments) return content;
  return segments.map((seg, idx) =>
    seg.changed
      ? <span key={idx} className="diff-inline-change">{seg.text}</span>
      : seg.text
  );
}

function CollapsedRow({ lines }: { lines: RenderedLine[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr className="diff-collapsed">
        <td colSpan={4}>
          <span className="diff-collapsed-toggle" onClick={() => setExpanded(e => !e)}>
            {expanded ? '▼' : '▶'} {lines.length} unchanged line{lines.length !== 1 ? 's' : ''}
          </span>
        </td>
      </tr>
      {expanded && lines.map((line, idx) => (
        <tr key={idx} className="diff-context diff-context-hidden">
          <td className="diff-ln diff-ln-old">{line.oldLn ?? ''}</td>
          <td className="diff-ln diff-ln-new">{line.newLn ?? ''}</td>
          <td className="diff-mark"> </td>
          <td className="diff-code">{line.content}</td>
        </tr>
      ))}
    </>
  );
}

export default function DiffViewer({ diffText }: Props) {
  const items = useMemo<RenderItem[]>(() => {
    if (!diffText) return [];
    return groupContextRuns(withCharDiffs(parseLines(diffText)));
  }, [diffText]);

  return (
    <table className="diff-table">
      <tbody>
        {items.map((item, idx) => {
          if ((item as CollapsedGroup).type === 'collapsed') {
            return <CollapsedRow key={idx} lines={(item as CollapsedGroup).lines} />;
          }
          const line = item as RenderedLine;
          switch (line.type) {
            case 'hunk':
              return <tr key={idx} className="diff-hunk"><td colSpan={4}>{line.raw}</td></tr>;
            case 'header':
              return <tr key={idx} className="diff-header"><td colSpan={4}>{line.raw}</td></tr>;
            case 'remove':
              return (
                <tr key={idx} className="diff-remove">
                  <td className="diff-ln diff-ln-old">{line.oldLn ?? ''}</td>
                  <td className="diff-ln diff-ln-new"></td>
                  <td className="diff-mark">-</td>
                  <td className="diff-code">{renderSegments(line.segments, line.content)}</td>
                </tr>
              );
            case 'add':
              return (
                <tr key={idx} className="diff-add">
                  <td className="diff-ln diff-ln-old"></td>
                  <td className="diff-ln diff-ln-new">{line.newLn ?? ''}</td>
                  <td className="diff-mark">+</td>
                  <td className="diff-code">{renderSegments(line.segments, line.content)}</td>
                </tr>
              );
            default:
              return (
                <tr key={idx} className="diff-context">
                  <td className="diff-ln diff-ln-old">{line.oldLn ?? ''}</td>
                  <td className="diff-ln diff-ln-new">{line.newLn ?? ''}</td>
                  <td className="diff-mark"> </td>
                  <td className="diff-code">{line.content}</td>
                </tr>
              );
          }
        })}
      </tbody>
    </table>
  );
}
