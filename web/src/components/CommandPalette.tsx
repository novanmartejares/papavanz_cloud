import { useEffect, useState, useRef } from 'react';
import { api, type FileMeta, type FolderMeta } from '../api';

interface Props {
  onClose: () => void;
  onNavigate: (view: any, folderId?: string | null) => void;
}

export default function CommandPalette({ onClose, onNavigate }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ files: FileMeta[]; folders: FolderMeta[] }>({ files: [], folders: [] });
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!query.trim()) {
      setResults({ files: [], folders: [] });
      return;
    }
    
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const files = await api.listFiles(null, { q: query });
        const allFolders = await api.listFolders();
        const folders = allFolders.filter(f => f.name.toLowerCase().includes(query.toLowerCase()));
        setResults({ files, folders });
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="modal-backdrop" style={{ alignItems: 'flex-start', paddingTop: '10vh' }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="command-palette">
        <div className="cp-search">
          <span className="cp-icon">🔍</span>
          <input 
            ref={inputRef}
            type="text" 
            placeholder="Search files, folders, or jump to..." 
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="cp-shortcut">ESC</div>
        </div>
        
        <div className="cp-results">
          {!query.trim() ? (
            <div className="cp-hints">
              <p className="cp-hints-title">Quick Actions</p>
              <div className="cp-quick-actions">
                <button onClick={() => { onNavigate('files'); onClose(); }}>📁 My Files</button>
                <button onClick={() => { onNavigate('recent'); onClose(); }}>⏱️ Recent</button>
                <button onClick={() => { onNavigate('starred'); onClose(); }}>⭐ Starred</button>
                <button onClick={() => { onNavigate('shares'); onClose(); }}>🔗 Shared Links</button>
                <button onClick={() => { onNavigate('trash'); onClose(); }}>🗑️ Trash</button>
                <button onClick={() => { onNavigate('activity'); onClose(); }}>📋 Activity</button>
              </div>
            </div>
          ) : loading ? (
            <div className="cp-loading">Searching...</div>
          ) : results.files.length === 0 && results.folders.length === 0 ? (
            <div className="cp-empty">No results found for "{query}"</div>
          ) : (
            <div className="cp-list">
              {results.folders.length > 0 && (
                <div className="cp-section">
                  <div className="cp-section-title">Folders</div>
                  {results.folders.map(f => (
                    <button key={f.id} className="cp-item" onClick={() => { onNavigate('files', f.id); onClose(); }}>
                      <span className="cp-item-icon">📁</span>
                      <span className="cp-item-name">{f.name}</span>
                    </button>
                  ))}
                </div>
              )}
              {results.files.length > 0 && (
                <div className="cp-section">
                  <div className="cp-section-title">Files</div>
                  {results.files.map(f => (
                    <button key={f.id} className="cp-item" onClick={() => { onNavigate('files', f.folderId ?? null); onClose(); }}>
                      <span className="cp-item-icon">📄</span>
                      <span className="cp-item-name">{f.originalName}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
