import { getSession } from '@/lib/session';
import { createSandboxedStorage, type WorkspaceConfig } from '@/lib/storage';
import { listGalleryItems } from '@/lib/gallery';
import { WorkspaceCard } from '@/components/WorkspaceCard';
import { ThemeToggle } from '@/components/ThemeToggle';
import { CapabilitiesPanel } from '@/components/CapabilitiesPanel';
import skills from '@/lib/skills/index.json';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const EXAMPLE_PROMPTS = [
  { label: 'What can you do?', prompt: 'What can you do? What APIs and tools do you have access to?' },
  { label: 'Search papers', prompt: 'Search OpenAlex for recent machine learning papers and show me a table of results' },
  { label: 'Analyze trends', prompt: 'Find publication trends in AI research over the past 5 years and create a chart' },
  { label: 'Find books', prompt: 'Search WorldCat for books about digital humanities' },
  { label: 'Build a tool', prompt: 'Create an interactive PDF accessibility checker' },
];

export default async function Home() {
  // Only read the session - proxy.ts handles session creation.
  // On first visit, the cookie isn't available yet (set on response), so gracefully show no workspaces.
  let workspaces: WorkspaceConfig[] = [];
  try {
    const sessionId = await getSession();
    const storage = createSandboxedStorage(sessionId);
    workspaces = await storage.listWorkspaces();
  } catch {
    // No valid session yet - proxy will set the cookie, available on next request
  }
  const galleryItems = await listGalleryItems();

  return (
    <div className="min-h-screen canvas-bg">
      {/* Subtle top accent */}
      <div className="fixed top-0 left-0 w-full h-0.5 bg-gradient-to-r from-transparent via-accent/50 to-transparent" />

      {/* Theme toggle */}
      <ThemeToggle className="fixed top-4 right-4 z-50" />

      <div className="max-w-3xl mx-auto px-6 py-16">
        {/* Header */}
        <header className="mb-12 animate-fade-in text-center">
          <div className="inline-flex items-center gap-2 mb-6">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <svg className="w-4 h-4 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
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
          <CapabilitiesPanel skills={skills} />
        </header>

        {/* Main Input */}
        <section className="mb-8 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
          <form action={`${basePath}/api/create`} method="POST">
            <div className="relative">
              <input
                type="text"
                name="prompt"
                placeholder="Ask anything or describe what you want to build..."
                className="w-full px-5 py-4 pr-14 text-base rounded-2xl border border-border bg-card transition-all focus:outline-none focus:border-primary/50 focus:shadow-lg focus:shadow-primary/5 placeholder:text-muted-foreground/50"
                autoFocus
                required
              />
              <button
                type="submit"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2.5 bg-primary text-primary-foreground rounded-xl transition-all hover:opacity-90"
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
                <form key={item.id} action={`${basePath}/api/gallery/${item.id}`} method="POST">
                  <button
                    type="submit"
                    className="w-full text-left p-4 rounded-xl border border-border/50 bg-card/50 transition-all hover:border-primary/30 hover:bg-card group"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <h3 className="font-medium text-sm group-hover:text-primary transition-colors line-clamp-1">
                        {item.title}
                      </h3>
                      <span className="flex-shrink-0 text-xs text-muted-foreground/70 bg-muted px-1.5 py-0.5 rounded">
                        {item.artifactCount}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {item.description}
                    </p>
                  </button>
                </form>
              ))}
            </div>
          </section>
        )}

        {/* Example Prompts (shown when gallery is empty) */}
        {galleryItems.length === 0 && (
          <section className="mb-12 animate-fade-in-up" style={{ animationDelay: '150ms' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-muted-foreground">Try these</h2>
            </div>
            <div className="flex flex-wrap gap-2 justify-center">
              {EXAMPLE_PROMPTS.map((example) => (
                <form key={example.label} action={`${basePath}/api/create`} method="POST" className="inline">
                  <input type="hidden" name="prompt" value={example.prompt} />
                  <button
                    type="submit"
                    className="px-4 py-2 text-sm rounded-full border border-border bg-card/50 text-muted-foreground transition-all hover:border-primary/30 hover:text-foreground hover:bg-card"
                  >
                    {example.label}
                  </button>
                </form>
              ))}
            </div>
          </section>
        )}

        {/* Start Blank Option */}
        <section className="mb-12 animate-fade-in-up text-center" style={{ animationDelay: '200ms' }}>
          <form action={`${basePath}/api/create`} method="POST" className="inline">
            <input type="hidden" name="blank" value="true" />
            <button
              type="submit"
              className="px-4 py-2 text-sm rounded-full border border-dashed border-border/50 text-muted-foreground/70 transition-all hover:border-border hover:text-muted-foreground"
            >
              Start blank
            </button>
          </form>
        </section>

        {/* Your Workspaces */}
        {workspaces.length > 0 && (
          <section className="animate-fade-in-up" style={{ animationDelay: '250ms' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-muted-foreground">Your Workspaces</h2>
            </div>
            <div className="grid gap-2">
              {workspaces.slice(0, 5).map((workspace) => (
                <WorkspaceCard key={workspace.id} workspace={workspace} />
              ))}
            </div>
            {workspaces.length > 5 && (
              <p className="text-xs text-muted-foreground/70 text-center mt-3">
                +{workspaces.length - 5} more
              </p>
            )}
          </section>
        )}

        {/* Footer */}
        <footer className="mt-16 pt-8 border-t border-border/30 text-center">
          <p className="text-xs text-muted-foreground/70">
            Built for the CUNY community
          </p>
        </footer>
      </div>
    </div>
  );
}
