import { Suspense, lazy, useEffect, useState } from 'react';
import { parseCsvPreview } from '../../lib/csv';

const LazyMarkdownRenderer = lazy(() => import('../renderers/MarkdownRenderer'));

export function TextFilePreview({ url, filePath }: { url: string; filePath: string }) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const extension = filePath.split('.').pop()?.toLowerCase() || '';

  useEffect(() => {
    let cancelled = false;
    setTextContent(null);
    setLoadError(null);

    fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load file (${response.status})`);
        }
        const text = await response.text();
        if (!cancelled) {
          setTextContent(text);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load file');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  if (loadError) {
    return <div className="panel-empty">{loadError}</div>;
  }

  if (textContent === null) {
    return <div className="panel-empty">Loading file…</div>;
  }

  if (extension === 'md') {
    return (
      <Suspense fallback={<div className="panel-richtext whitespace-pre-wrap">{textContent}</div>}>
        <LazyMarkdownRenderer
          className="panel-richtext"
          content={textContent}
        />
      </Suspense>
    );
  }

  if (extension === 'csv') {
    const preview = parseCsvPreview(textContent);
    if (preview.headers.length === 0) {
      return <div className="panel-empty">Empty CSV file.</div>;
    }
    return (
      <div className="panel-table-wrap">
        <table className="panel-table">
          <thead>
            <tr>
              {preview.headers.map((header, index) => (
                <th key={`${header}-${index}`}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {preview.headers.map((_, cellIndex) => (
                  <td key={cellIndex}>{row[cellIndex] || <span className="panel-muted">—</span>}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {preview.truncated ? (
          <div className="panel-footnote">Showing the first 50 rows.</div>
        ) : null}
      </div>
    );
  }

  if (extension === 'json') {
    try {
      return (
        <pre className="panel-code-block">
          {JSON.stringify(JSON.parse(textContent), null, 2)}
        </pre>
      );
    } catch {
      return <pre className="panel-code-block">{textContent}</pre>;
    }
  }

  if (extension === 'yml' || extension === 'yaml' || extension === 'xml' || extension === 'txt' || extension === 'js' || extension === 'ts' || extension === 'tsx' || extension === 'jsx' || extension === 'css') {
    return <pre className="panel-code-block">{textContent}</pre>;
  }

  return <pre className="panel-code-block">{textContent}</pre>;
}
