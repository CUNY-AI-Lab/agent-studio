import { useState, type FormEvent } from 'react';
import { ThemeToggle } from './ThemeToggle';
import type { GalleryItem, WorkspaceRecord } from '../types';

const EXAMPLE_PROMPTS = [
  { label: 'Analyze a CSV', prompt: 'Upload and analyze a CSV data file with summary statistics and visualizations' },
  { label: 'Build a dashboard', prompt: 'Create an interactive dashboard with charts and key metrics' },
  { label: 'Search an API', prompt: 'Search a public API and display the results in a structured table' },
  { label: 'Compare datasets', prompt: 'Compare two datasets and highlight differences and trends' },
];

interface HomePageProps {
  workspaces: WorkspaceRecord[];
  galleryItems: GalleryItem[];
  onCreateWorkspace: (name: string) => Promise<void>;
  onSelectWorkspace: (id: string) => void;
  onCloneGalleryItem: (id: string) => Promise<void>;
  onStartBlank: () => Promise<void>;
  creating: boolean;
}

export function HomePage({
  workspaces,
  galleryItems,
  onCreateWorkspace,
  onSelectWorkspace,
  onCloneGalleryItem,
  onStartBlank,
  creating,
}: HomePageProps) {
  const [prompt, setPrompt] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || creating) return;
    await onCreateWorkspace(prompt.trim());
    setPrompt('');
  };

  const handleExamplePrompt = async (p: string) => {
    if (creating) return;
    await onCreateWorkspace(p);
  };

  return (
    <div className="min-h-screen canvas-bg">
      {/* Top accent line */}
      <div className="fixed top-0 left-0 w-full h-0.5 bg-gradient-to-r from-transparent via-accent/50 to-transparent" />

      {/* Theme toggle */}
      <ThemeToggle className="fixed top-4 right-4 z-50" />

      <div className="max-w-3xl mx-auto px-6 py-16">
        {/* Header */}
        <header className="mb-12 animate-fade-in text-center">
          <div className="inline-flex items-center gap-2 mb-6">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <svg className="w-4 h-4 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <span className="text-sm font-medium tracking-wide text-muted-foreground">Agent Studio</span>
          </div>

          <h1 className="text-3xl font-medium tracking-tight mb-3">
            What would you like to work on?
          </h1>

          <p className="text-muted-foreground mb-4">
            Search APIs, analyze data, create visualizations, or build tools.
          </p>
        </header>

        {/* Main input */}
        <section className="mb-8 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
          <form onSubmit={handleSubmit}>
            <div className="relative">
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Ask anything or describe what you want to build..."
                className="w-full px-5 py-4 pr-14 text-base rounded-2xl border border-border bg-card transition-all focus:outline-none focus:border-primary/50 focus:shadow-lg focus:shadow-primary/5"
                autoFocus
                disabled={creating}
              />
              <button
                type="submit"
                disabled={!prompt.trim() || creating}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2.5 bg-primary text-primary-foreground rounded-xl transition-all hover:opacity-90 disabled:opacity-40"
                aria-label="Start"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                </svg>
              </button>
            </div>
          </form>
        </section>

        {/* Gallery */}
        {galleryItems.length > 0 && (
          <section className="mb-12 animate-fade-in-up" style={{ animationDelay: '150ms' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-muted-foreground">Gallery</h2>
              <span className="text-xs text-muted-foreground/70">{galleryItems.length} shared</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {galleryItems.slice(0, 6).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onCloneGalleryItem(item.id)}
                  disabled={creating}
                  className="w-full text-left p-4 rounded-xl border border-border/50 bg-card/50 transition-all hover:border-primary/30 hover:bg-card group disabled:opacity-50"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <h3 className="font-medium text-sm group-hover:text-primary transition-colors line-clamp-1">
                      {item.title}
                    </h3>
                    <span className="flex-shrink-0 text-xs text-muted-foreground/70 bg-muted px-1.5 py-0.5 rounded">
                      {item.artifactCount}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Example prompts (when no gallery) */}
        {galleryItems.length === 0 && (
          <section className="mb-12 animate-fade-in-up" style={{ animationDelay: '150ms' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-muted-foreground">Try these</h2>
            </div>
            <div className="flex flex-wrap gap-2 justify-center">
              {EXAMPLE_PROMPTS.map((example) => (
                <button
                  key={example.label}
                  type="button"
                  onClick={() => handleExamplePrompt(example.prompt)}
                  disabled={creating}
                  className="px-4 py-2 text-sm rounded-full border border-border bg-card/50 text-muted-foreground transition-all hover:border-primary/30 hover:text-foreground hover:bg-card disabled:opacity-50"
                >
                  {example.label}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Start blank */}
        <section className="mb-12 animate-fade-in-up text-center" style={{ animationDelay: '200ms' }}>
          <button
            type="button"
            onClick={onStartBlank}
            disabled={creating}
            className="px-4 py-2 text-sm rounded-full border border-dashed border-border/50 text-muted-foreground/70 transition-all hover:border-border hover:text-muted-foreground disabled:opacity-50"
          >
            Start blank
          </button>
        </section>

        {/* Your Workspaces */}
        {workspaces.length > 0 && (
          <section className="animate-fade-in-up" style={{ animationDelay: '250ms' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-muted-foreground">Your Workspaces</h2>
            </div>
            <div className="grid gap-2">
              {workspaces.slice(0, 8).map((ws) => (
                <button
                  key={ws.id}
                  type="button"
                  onClick={() => onSelectWorkspace(ws.id)}
                  className="w-full text-left p-4 rounded-xl border border-border/50 bg-card/50 transition-all hover:border-primary/30 hover:bg-card group"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-medium text-sm group-hover:text-primary transition-colors truncate">
                        {ws.name || 'Untitled'}
                      </h3>
                      {ws.description && (
                        <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{ws.description}</p>
                      )}
                    </div>
                    <span className="flex-shrink-0 text-xs text-muted-foreground/70">
                      {new Date(ws.updatedAt || ws.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </button>
              ))}
            </div>
            {workspaces.length > 8 && (
              <p className="text-xs text-muted-foreground/70 text-center mt-3">
                +{workspaces.length - 8} more
              </p>
            )}
          </section>
        )}

        {/* Footer */}
        <footer className="mt-16 pt-8 border-t border-border/30 text-center">
          <p className="text-xs text-muted-foreground/70">Built for the CUNY community</p>
        </footer>
      </div>
    </div>
  );
}
