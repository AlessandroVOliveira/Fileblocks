import { useEffect, useRef } from 'react';

interface SearchBoxProps {
  query: string;
  onQueryChange(query: string): void;
  current: number;
  total: number;
  onNavigate(delta: 1 | -1): void;
}

export function SearchBox({ query, onQueryChange, current, total, onNavigate }: SearchBoxProps) {
  const input = useRef<HTMLInputElement>(null);

  // Ctrl/Cmd+F focuses the search box.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const hasQuery = query.trim() !== '';

  return (
    <div className={`search${hasQuery && total === 0 ? ' search--empty' : ''}`}>
      <input
        ref={input}
        className="search-input"
        type="text"
        placeholder="Search keys and values (Ctrl+F)"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onNavigate(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            onQueryChange('');
          }
        }}
      />
      {hasQuery && <span className="search-count">{total === 0 ? 'No results' : `${current + 1}/${total}`}</span>}
      <button className="action" title="Previous match (Shift+Enter)" disabled={total === 0} onClick={() => onNavigate(-1)}>
        ↑
      </button>
      <button className="action" title="Next match (Enter)" disabled={total === 0} onClick={() => onNavigate(1)}>
        ↓
      </button>
    </div>
  );
}
