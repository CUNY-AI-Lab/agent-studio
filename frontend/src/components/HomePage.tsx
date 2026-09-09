import { useState, type FormEvent } from 'react';
import { ThemeToggle } from './ThemeToggle';
import type { GalleryItem, WorkspaceRecord } from '../types';

const EXAMPLE_PROMPTS = [
  { label: 'Analyze a CSV', prompt: 'Upload and analyze a CSV data file with summary statistics and visualizations' },
  { label: 'Build a dashboard', prompt: 'Create an interactive dashboard with charts and key metrics' },
  { label: 'Search a public data source', prompt: 'Search a public data source and display the results in a structured table' },
  { label: 'Compare datasets', prompt: 'Compare two datasets and highlight differences and trends' },
];

interface HomePageProps {
  workspaces: WorkspaceRecord[];
  galleryItems: GalleryItem[];
  onCreateWorkspace: (name: string) => Promise<boolean>;
  onSelectWorkspace: (id: string) => void;
  onOpenGalleryItem: (id: string) => void;
  onCloneGalleryItem: (id: string) => Promise<void>;
  onStartBlank: () => Promise<boolean>;
  onImportWorkspace: (file: File | null) => Promise<void>;
  busy: boolean;
  importing: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export function HomePage({
  workspaces,
  galleryItems,
  onCreateWorkspace,
  onSelectWorkspace,
  onOpenGalleryItem,
  onCloneGalleryItem,
  onStartBlank,
  onImportWorkspace,
  busy,
  importing,
  error = null,
  onRetry,
}: HomePageProps) {
  const [prompt, setPrompt] = useState('');
  const [cloningGalleryId, setCloningGalleryId] = useState<string | null>(null);
  const actionBusy = busy || cloningGalleryId !== null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || actionBusy) return;
    const created = await onCreateWorkspace(prompt.trim());
    if (created) setPrompt('');
  };

  const handleExamplePrompt = async (p: string) => {
    if (actionBusy) return;
    await onCreateWorkspace(p);
  };

  const handleCloneGalleryItem = async (galleryId: string) => {
    if (actionBusy) return;
    setCloningGalleryId(galleryId);
    try {
      await onCloneGalleryItem(galleryId);
    } finally {
      setCloningGalleryId(null);
    }
  };

  return (
    <div className="grain min-h-screen canvas-bg">
      <div className="accent-rule fixed top-0 left-0 z-40 w-full" aria-hidden="true" />

      <ThemeToggle className="fixed top-4 right-4 z-50" />

      {error ? (
        <div role="alert" className="mx-auto mt-8 max-w-3xl px-6">
          <div className="ui-notice flex items-center justify-between gap-4">
            <span>{error}</span>
            {onRetry ? (
              <button type="button" className="ui-link ui-link-danger shrink-0" onClick={onRetry}>
                Try again
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <main className="mx-auto max-w-3xl px-6 pb-24 pt-20">
        <header className="mb-10 animate-fade-in text-center">
          <div className="home-brand mb-8">
            <div className="home-brand-mark" aria-hidden="true">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <span className="ui-label text-foreground">Agent Studio</span>
          </div>

          <h1 className="home-title">
            What would you like to work on?
          </h1>
        </header>

        <section className="mb-10 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
          <form onSubmit={handleSubmit}>
            <div className="composer-frame home-composer">
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Ask anything or describe what you want to build..."
                aria-label="What would you like to work on?"
                autoFocus
                disabled={actionBusy}
              />
              <button
                type="submit"
                disabled={!prompt.trim() || actionBusy}
                className="ui-btn ui-btn-primary home-composer-send"
                aria-label="Start"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                </svg>
              </button>
            </div>
          </form>
        </section>

        {galleryItems.length > 0 && (
          <section className="mb-12 animate-fade-in-up" style={{ animationDelay: '150ms' }}>
            <div className="ui-section-head mb-4">
              <h2 className="ui-label">Gallery</h2>
              <span className="ws-stat">{galleryItems.length} shared with CAIL members</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
              {galleryItems.map((item) => (
                <article
                  key={item.id}
                  role="group"
                  aria-label={`${item.title} gallery item`}
                  className="gallery-card rule-lead"
                >
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <h3 className="line-clamp-2">{item.title}</h3>
                    <span className="gallery-count shrink-0">{item.artifactCount}</span>
                  </div>
                  <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{item.description}</p>
                  <div className="mt-auto flex flex-wrap gap-2 pt-4">
                    <button
                      type="button"
                      onClick={() => onOpenGalleryItem(item.id)}
                      disabled={actionBusy}
                      className="ui-btn ui-btn-sm"
                    >
                      Open read-only
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCloneGalleryItem(item.id)}
                      disabled={actionBusy}
                      className="ui-btn ui-btn-sm ui-btn-primary"
                    >
                      {cloningGalleryId === item.id ? 'Creating…' : 'Use as workspace'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {galleryItems.length === 0 && (
          <section className="mb-12 animate-fade-in-up" style={{ animationDelay: '150ms' }}>
            <div className="ui-section-head mb-4">
              <h2 className="ui-label">Try these</h2>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLE_PROMPTS.map((example) => (
                <button
                  key={example.label}
                  type="button"
                  onClick={() => handleExamplePrompt(example.prompt)}
                  disabled={actionBusy}
                  className="home-chip"
                >
                  {example.label}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="mb-14 flex flex-wrap justify-center gap-2 animate-fade-in-up" style={{ animationDelay: '200ms' }}>
          <button
            type="button"
            onClick={onStartBlank}
            disabled={actionBusy}
            className="ui-btn"
          >
            Start blank
          </button>
          <label className="ui-btn cursor-pointer has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 focus-within:outline-3 focus-within:outline-ring">
            {importing ? 'Importing…' : 'Import workspace'}
            <input
              className="sr-only"
              type="file"
              accept=".json,.agent-studio.json,application/json"
              disabled={actionBusy}
              aria-label="Import workspace bundle"
              onChange={(event) => {
                void onImportWorkspace(event.target.files?.[0] ?? null);
                event.currentTarget.value = '';
              }}
            />
          </label>
        </section>

        {workspaces.length > 0 && (
          <section className="animate-fade-in-up" style={{ animationDelay: '250ms' }}>
            <div className="ui-section-head mb-3">
              <h2 className="ui-label">Your Workspaces</h2>
              <span className="ws-stat">{workspaces.length}</span>
            </div>
            <div className="ws-list">
              {workspaces.map((ws) => (
                <button
                  key={ws.id}
                  type="button"
                  onClick={() => onSelectWorkspace(ws.id)}
                  disabled={actionBusy}
                  className="ws-row"
                >
                  <div className="min-w-0">
                    <h3 className="truncate">
                      {ws.name || 'Untitled'}
                    </h3>
                    {ws.description && (
                      <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{ws.description}</p>
                    )}
                  </div>
                  <span className="ws-row-date">
                    {new Date(ws.updatedAt || ws.createdAt).toLocaleDateString()}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
