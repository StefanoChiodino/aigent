import React, { useMemo } from 'react';
import { html } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';

interface Props {
  diffText: string;
}

export default function DiffViewer({ diffText }: Props) {
  const diffHtml = useMemo(() => {
    if (!diffText) return '';
    return html(diffText, {
      outputFormat: 'line-by-line',
      drawFileList: false,
      matching: 'lines',
      colorScheme: 'dark',
    });
  }, [diffText]);

  return (
    <div
      className="diff2html-wrapper"
      dangerouslySetInnerHTML={{ __html: diffHtml }}
    />
  );
}
