import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const workerOrigin = env.VITE_WORKER_ORIGIN || 'http://127.0.0.1:8787';

  const manualChunks = (id: string) => {
    if (!id.includes('node_modules')) return undefined;

    if (
      id.includes('/node_modules/recharts/') ||
      id.includes('/node_modules/victory-vendor/') ||
      id.includes('/node_modules/react-smooth/') ||
      id.includes('/node_modules/recharts-scale/')
    ) {
      return 'vendor-charts';
    }

    if (
      id.includes('/node_modules/react-markdown/') ||
      id.includes('/node_modules/remark-gfm/') ||
      id.includes('/node_modules/unified/') ||
      id.includes('/node_modules/remark-') ||
      id.includes('/node_modules/rehype-') ||
      id.includes('/node_modules/micromark') ||
      id.includes('/node_modules/mdast-') ||
      id.includes('/node_modules/hast-') ||
      id.includes('/node_modules/unist-')
    ) {
      return 'vendor-markdown';
    }

    if (
      id.includes('/node_modules/@cloudflare/ai-chat/') ||
      id.includes('/node_modules/@ai-sdk/') ||
      id.includes('/node_modules/agents/') ||
      id.includes('/node_modules/ai/')
    ) {
      return 'vendor-agent';
    }

    if (
      id.includes('/node_modules/lucide-react/') ||
      id.includes('/node_modules/html-to-image/')
    ) {
      return 'vendor-ui';
    }

    if (
      id.includes('/node_modules/react/') ||
      id.includes('/node_modules/react-dom/') ||
      id.includes('/node_modules/scheduler/')
    ) {
      return 'vendor-react';
    }

    return undefined;
  };

  return {
    plugins: [tailwindcss(), react()],
    build: {
      modulePreload: {
        resolveDependencies: (_filename, dependencies, context) => {
          if (context.hostType === 'html') {
            return dependencies.filter(
              (dependency) =>
                !dependency.includes('vendor-charts') &&
                !dependency.includes('ChartPanelView') &&
                !dependency.includes('vendor-markdown') &&
                !dependency.includes('MarkdownRenderer')
            );
          }

          return dependencies;
        },
      },
      rollupOptions: {
        output: {
          manualChunks,
        },
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': workerOrigin,
        '/agents': {
          target: workerOrigin,
          ws: true,
        },
        '/health': workerOrigin,
      },
    },
  };
});
