'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface Skill {
  name: string;
  description: string;
}

interface CapabilitiesPanelProps {
  skills: Skill[];
}

const SKILL_DISPLAY_NAMES: Record<string, string> = {
  'openalex': 'Scholarly Articles',
  'crossref': 'DOI Lookup',
  'semantic-scholar': 'AI-Powered Search',
  'arxiv': 'arXiv Preprints',
  'pubmed': 'Medical Research',
  'worldcat': 'WorldCat Books',
  'primo': 'CUNY OneSearch',
  'libguides': 'Research Guides',
  'unpaywall': 'Open Access',
  'wikipedia': 'Wikipedia',
  'nyc-opendata': 'NYC Open Data',
  'census': 'US Census',
  'pdf': 'PDF Files',
  'xlsx': 'Excel Spreadsheets',
  'docx': 'Word Documents',
  'pptx': 'PowerPoint',
  'leaflet': 'Interactive Maps',
  'threejs': '3D Visualizations',
  'network-graph': 'Network Graphs',
  'citation': 'Citation Formatter',
  'frontend-design': 'UI Components',
};

const CATEGORIES: { name: string; description: string; skills: string[] }[] = [
  {
    name: 'Research',
    description: 'Search academic databases and discover papers',
    skills: ['openalex', 'crossref', 'semantic-scholar', 'arxiv', 'pubmed', 'unpaywall', 'wikipedia'],
  },
  {
    name: 'Libraries',
    description: 'Find books and resources at libraries',
    skills: ['worldcat', 'primo', 'libguides'],
  },
  {
    name: 'Data',
    description: 'Access public datasets and statistics',
    skills: ['nyc-opendata', 'census'],
  },
  {
    name: 'Documents',
    description: 'Create and process files',
    skills: ['pdf', 'xlsx', 'docx', 'pptx'],
  },
  {
    name: 'Visualization',
    description: 'Build charts, maps, and graphics',
    skills: ['leaflet', 'threejs', 'network-graph', 'citation'],
  },
];

function Modal({ isOpen, onClose, children }: { isOpen: boolean; onClose: () => void; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Defer to avoid synchronous setState warning
    const t = setTimeout(() => setMounted(true), 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!mounted || !isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      {/* Content */}
      <div className="relative z-10">
        {children}
      </div>
    </div>,
    document.body
  );
}

export function CapabilitiesPanel({ skills }: CapabilitiesPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const skillMap = new Map(skills.map(s => [s.name, s]));

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4 decoration-border/50 hover:decoration-muted-foreground"
      >
        See what&rsquo;s possible
      </button>

      <Modal isOpen={isOpen} onClose={() => setIsOpen(false)}>
        <div className="w-[90vw] max-w-xl max-h-[80vh] bg-card border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-start justify-between p-6 pb-4 border-b border-border shrink-0">
            <div>
              <h2 className="text-xl font-medium tracking-tight">Capabilities</h2>
              <p className="text-sm text-muted-foreground mt-1">What the agent can help you with</p>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="p-2 -mt-1 -mr-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto p-6 pt-5">
            <div className="space-y-8">
              {CATEGORIES.map((category) => {
                const categorySkills = category.skills
                  .map(name => skillMap.get(name))
                  .filter((s): s is Skill => s !== undefined);

                if (categorySkills.length === 0) return null;

                return (
                  <div key={category.name}>
                    <h3 className="text-base font-medium mb-1">{category.name}</h3>
                    <p className="text-sm text-muted-foreground mb-4">{category.description}</p>
                    <div className="flex flex-wrap gap-2">
                      {categorySkills.map((skill) => (
                        <span
                          key={skill.name}
                          className="px-3 py-1.5 text-sm bg-muted rounded-lg text-foreground/80"
                          title={skill.description}
                        >
                          {SKILL_DISPLAY_NAMES[skill.name] || skill.name}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Footer */}
          <div className="p-5 border-t border-border bg-muted/30 shrink-0">
            <p className="text-sm text-muted-foreground text-center">
              Just describe what you need — the agent figures out which tools to use.
            </p>
          </div>
        </div>
      </Modal>
    </>
  );
}
