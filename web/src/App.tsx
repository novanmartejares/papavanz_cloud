import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import AuthForm from './components/AuthForm';
import Dashboard from './components/Dashboard';

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

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

  async function handleLogout() {
    await api.logout().catch(() => undefined);
    setMe(null);
  }

  if (loading) {
    return (
      <main className="container">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="container">
      <header className="topbar">
        <h1>papavanz_cloud</h1>
        {me && (
          <div className="user">
            <span className="muted">{me.email}</span>
            <button className="btn-link" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        )}
      </header>

      {me ? (
        <Dashboard me={me} onMeChange={setMe} />
      ) : (
        <AuthForm onAuthed={setMe} />
      )}

      <footer className="footer muted">
        Private cloud storage · 5 GB per user · IDOR-safe by design
      </footer>
    </main>
  );
}
