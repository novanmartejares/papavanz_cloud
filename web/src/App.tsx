import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Me } from './api';
import LandingPage from './components/LandingPage';
import Dashboard from './components/Dashboard';
import AdminPanel from './components/AdminPanel';
import TrashView from './components/TrashView';
import StarredView from './components/StarredView';
import RecentView from './components/RecentView';
import SharesView from './components/SharesView';
import ActivityView from './components/ActivityView';
import PublicSharePage from './components/PublicSharePage';
import CommandPalette from './components/CommandPalette';

type AppView = 'files' | 'recent' | 'admin' | 'trash' | 'starred' | 'shares' | 'activity' | 'profile';

const SESSION_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 hours

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<AppView>('files');
  const [jumpFolderId, setJumpFolderId] = useState<string | null | undefined>(undefined);
  const [showPalette, setShowPalette] = useState(false);
  const lastActivityRef = useRef(Date.now());

  useEffect(() => {
    api
      .me()
      .then((u) => setMe(u))
      .catch((err) => {
        if (!(err instanceof ApiError) || err.status !== 401) console.error(err);
        setMe(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Browsers often hijack Ctrl+K, so let's support multiple hotkeys
      if (
        (e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === '/' || e.key === ' ')
      ) {
        e.preventDefault();
        setShowPalette(p => !p);
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

  // Session timeout — auto logout after 8 hours of inactivity.
  useEffect(() => {
    if (!me) return;
    function resetTimer() { lastActivityRef.current = Date.now(); }
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, resetTimer));
    const interval = setInterval(() => {
      if (Date.now() - lastActivityRef.current > SESSION_TIMEOUT_MS) {
        api.logout().catch(() => {});
        setMe(null);
        setView('files');
        alert('Session expired due to inactivity. Please log in again.');
      }
    }, 60_000); // check every minute
    return () => {
      events.forEach((e) => window.removeEventListener(e, resetTimer));
      clearInterval(interval);
    };
  }, [me]);

  async function handleLogout() {
    await api.logout().catch(() => undefined);
    setMe(null);
    setView('files');
  }

  function handleJumpToFolder(folderId: string | null) {
    setJumpFolderId(folderId);
    setView('files');
  }

  // Handle public share links directly
  if (window.location.pathname.startsWith('/s/')) {
    const token = window.location.pathname.split('/s/')[1];
    return <PublicSharePage token={token} />;
  }

  if (loading) {
    return (
      <main className="container">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (!me) {
    return <LandingPage onAuthed={setMe} />;
  }

  return (
    <main className="container">
      <header className="topbar">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <img src="/logo.png" alt="Papavanz Cloud Logo" style={{ height: '28px', width: 'auto', borderRadius: '4px' }} />
          <span>papavanz_cloud</span>
        </h1>
        <div className="user">
          <span className="muted">{me.email}</span>
          {me.role === 'admin' && <span className="role-badge admin">admin</span>}
          <button className="btn-link" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>

      <div className="search-hint" style={{ padding: '0 1rem', marginBottom: '1rem', color: 'var(--muted)', fontSize: '0.9rem' }}>
        Press <kbd style={{ background: 'var(--bg-hover)', padding: '0.2rem 0.4rem', borderRadius: '4px', border: '1px solid var(--border)' }}>Ctrl + /</kbd> to search anywhere
      </div>

      <nav className="sidebar-nav">
        <button
              className={`nav-item ${view === 'files' ? 'active' : ''}`}
              onClick={() => setView('files')}
            >
              📁 Files
            </button>
            <button
              className={`nav-item ${view === 'recent' ? 'active' : ''}`}
              onClick={() => setView('recent')}
            >
              ⏱️ Recent
            </button>
            <button
              className={`nav-item ${view === 'starred' ? 'active' : ''}`}
              onClick={() => setView('starred')}
            >
              ⭐ Starred
            </button>
            <button
              className={`nav-item ${view === 'shares' ? 'active' : ''}`}
              onClick={() => setView('shares')}
            >
              🔗 Shares
            </button>
            <button
              className={`nav-item ${view === 'trash' ? 'active' : ''}`}
              onClick={() => setView('trash')}
            >
              🗑️ Trash
            </button>
            <button
              className={`nav-item ${view === 'activity' ? 'active' : ''}`}
              onClick={() => setView('activity')}
            >
              📋 Activity
            </button>
            <button
              className={`nav-item ${view === 'profile' ? 'active' : ''}`}
              onClick={() => setView('profile')}
            >
              👤 Profile
            </button>
            {me.role === 'admin' && (
              <button
                className={`nav-item ${view === 'admin' ? 'active' : ''}`}
                onClick={() => setView('admin')}
              >
                ⚙️ Admin
              </button>
            )}
          </nav>

          {view === 'files' && (
            <Dashboard me={me} onMeChange={setMe} jumpFolderId={jumpFolderId} clearJump={() => setJumpFolderId(undefined)} />
          )}
          {view === 'admin' && <AdminPanel onBack={() => setView('files')} />}
          {view === 'trash' && <TrashView onBack={() => setView('files')} onRefresh={() => api.me().then(setMe)} />}
          {view === 'starred' && <StarredView onBack={() => setView('files')} onJumpToFolder={handleJumpToFolder} />}
          {view === 'recent' && <RecentView onBack={() => setView('files')} onJumpToFolder={handleJumpToFolder} />}
          {view === 'shares' && <SharesView onBack={() => setView('files')} />}
          {view === 'activity' && <ActivityView onBack={() => setView('files')} />}
          {view === 'profile' && <ProfileView me={me} onBack={() => setView('files')} />}

      <footer className="footer muted">
        Private cloud storage · {me.role === 'admin' ? '200 GB admin' : '5 GB per user'} · IDOR-safe by design
      </footer>

      {showPalette && (
        <CommandPalette 
          onClose={() => setShowPalette(false)} 
          onNavigate={(v, folderId) => {
            setView(v);
            if (folderId !== undefined) setJumpFolderId(folderId);
          }} 
        />
      )}
    </main>
  );
}

// ─── Profile View ─────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

function ProfileView({ me, onBack }: { me: Me; onBack: () => void }) {
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setMsg(''); setError('');
    if (newPw.length < 8) { setError('New password must be at least 8 characters'); return; }
    if (newPw !== confirmPw) { setError('Passwords do not match'); return; }
    setBusy(true);
    try {
      await api.changePassword(currentPw, newPw);
      setMsg('✅ Password changed successfully!');
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    } finally { setBusy(false); }
  }

  const pct = Math.min(100, (me.storageUsed / me.storageQuota) * 100);

  return (
    <section className="admin-panel">
      <div className="admin-header">
        <button className="btn-link" onClick={onBack}>← Back to files</button>
        <h2>👤 Profile</h2>
      </div>

      <div className="settings-grid">
        <div className="card">
          <h3 style={{ margin: '0 0 16px', fontSize: '14px', fontWeight: 600 }}>ℹ️ Account Info</h3>
          <div className="settings-info">
            <div className="settings-info-row"><span className="muted">Email</span><span>{me.email}</span></div>
            <div className="settings-info-row"><span className="muted">Role</span><span className={`role-badge ${me.role}`}>{me.role}</span></div>
            <div className="settings-info-row"><span className="muted">Storage</span><span>{fmtBytes(me.storageUsed)} / {fmtBytes(me.storageQuota)} ({pct.toFixed(1)}%)</span></div>
            <div className="settings-info-row"><span className="muted">Joined</span><span>{new Date(me.createdAt).toLocaleDateString()}</span></div>
          </div>
          <div style={{ marginTop: '12px' }}>
            <div className="quota-bar" style={{ height: '6px' }}>
              <div className={`quota-fill ${pct > 90 ? 'warn' : ''}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>

        <div className="card">
          <h3 style={{ margin: '0 0 16px', fontSize: '14px', fontWeight: 600 }}>🔒 Change Password</h3>
          <form onSubmit={handleChangePassword} className="form">
            <label>
              Current Password
              <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} required />
            </label>
            <label>
              New Password
              <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} required minLength={8} />
            </label>
            <label>
              Confirm New Password
              <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} required />
            </label>
            {error && <p className="error">{error}</p>}
            {msg && <p style={{ color: 'var(--ok)', fontSize: '13px' }}>{msg}</p>}
            <button type="submit" disabled={busy}>{busy ? 'Changing…' : '🔐 Change Password'}</button>
          </form>
        </div>
      </div>
    </section>
  );
}

