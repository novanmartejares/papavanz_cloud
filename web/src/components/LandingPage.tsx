import { useRef } from 'react';
import { type Me } from '../api';
import AuthForm from './AuthForm';

interface Props {
  onAuthed: (me: Me) => void;
}

export default function LandingPage({ onAuthed }: Props) {
  const authRef = useRef<HTMLDivElement>(null);

  function scrollToAuth() {
    authRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  return (
    <div className="landing-page">
      <header className="landing-header">
        <div className="logo" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <img src="/logo.png" alt="Papavanz Cloud Logo" style={{ height: '32px', width: 'auto', borderRadius: '6px' }} />
          <span>papavanz_cloud</span>
        </div>
        <button className="btn-hero primary" style={{ padding: '8px 24px', fontSize: '14px' }} onClick={scrollToAuth}>Sign In</button>
      </header>

      <main>
        <section className="landing-hero">
          <h1>Your Private Cloud Space.</h1>
          <p>
            Securely store, sync, and share your files. Enterprise-grade security with advanced versioning, 
            powerful admin analytics, and IDOR-safe sharing. Total control over your data.
          </p>
          <div className="landing-hero-actions">
            <button className="btn-hero primary" onClick={scrollToAuth}>Get Started for Free</button>
            <button className="btn-hero secondary" onClick={() => {
              document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' });
            }}>Explore Features</button>
          </div>
        </section>

        <section id="features" className="features-section">
          <div className="features-grid">
            <div className="feature-card">
              <span className="feature-icon">🛡️</span>
              <h3 className="feature-title">Enterprise Security</h3>
              <p className="feature-desc">IDOR-safe architecture with strict access control ensuring your data is always protected.</p>
            </div>
            <div className="feature-card">
              <span className="feature-icon">⏳</span>
              <h3 className="feature-title">File Versioning</h3>
              <p className="feature-desc">Accidentally overwrote a file? Effortlessly restore unlimited previous versions.</p>
            </div>
            <div className="feature-card">
              <span className="feature-icon">🔗</span>
              <h3 className="feature-title">Advanced Sharing</h3>
              <p className="feature-desc">Create secure shareable links with custom passwords, expirations, and download limits.</p>
            </div>
            <div className="feature-card">
              <span className="feature-icon">🗑️</span>
              <h3 className="feature-title">Smart Trash</h3>
              <p className="feature-desc">Automated 30-day trash cleanup keeps your storage footprint healthy and optimized.</p>
            </div>
          </div>
        </section>

        <section ref={authRef} className="auth-section">
          <div className="auth-wrapper">
            <AuthForm onAuthed={onAuthed} />
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <p>© {new Date().getFullYear()} Papavanz Cloud. All rights reserved.</p>
        <p style={{ marginTop: '8px', fontSize: '12px' }}>Designed for privacy & performance.</p>
      </footer>
    </div>
  );
}
