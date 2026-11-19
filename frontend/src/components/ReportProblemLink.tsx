import { LifeBuoy } from 'lucide-react';

const REPORT_PROBLEM_URL = 'https://tools.ailab.gc.cuny.edu/help/projects/support/issues/new?topic=agent-studio';

export function ReportProblemLink() {
  return (
    <a
      className="ui-icon-btn"
      href={REPORT_PROBLEM_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="Report a problem"
      aria-label="Report a problem"
    >
      <LifeBuoy size={16} aria-hidden="true" />
    </a>
  );
}
