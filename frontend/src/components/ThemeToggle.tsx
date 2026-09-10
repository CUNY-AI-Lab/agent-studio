import { useCallback, useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

function getTheme(): 'light' | 'dark' {
  const documentElement = globalThis.document?.documentElement;
  if (!documentElement) return 'light';
  return documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setThemeState] = useState<'light' | 'dark'>(getTheme);

  useEffect(() => {
    setThemeState(getTheme());
  }, []);

  const toggle = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    localStorage.setItem('agent-studio-theme', next);
    setThemeState(next);
  }, [theme]);

  return (
    <button
      onClick={toggle}
      className={`ui-icon-btn ${className}`}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {theme === 'dark' ? (
        <Sun size={17} strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <Moon size={17} strokeWidth={1.75} aria-hidden="true" />
      )}
    </button>
  );
}
