'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface SafeMarkdownProps {
  children: string;
  className?: string;
}

export function SafeMarkdown({ children, className }: SafeMarkdownProps) {
  // ReactMarkdown safely parses markdown without executing scripts
  // No need for DOMPurify on raw markdown - it mangles code blocks
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Add security attributes to links
          a: ({ href, children, ...props }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            >
              {children}
            </a>
          ),
          // Style code blocks
          code: ({ className, children, ...props }) => {
            const isInline = !className;
            return isInline ? (
              <code className="bg-black/10 dark:bg-white/10 text-[#c7254e] dark:text-[#e06c75] px-1.5 py-0.5 rounded text-[0.9em] font-mono" {...props}>
                {children}
              </code>
            ) : (
              // Code inside pre - inherit text color from pre
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children, ...props }) => (
            <pre className="bg-[#282c34] text-[#abb2bf] p-3 rounded-lg overflow-x-auto text-sm font-mono" {...props}>
              {children}
            </pre>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export default SafeMarkdown;
