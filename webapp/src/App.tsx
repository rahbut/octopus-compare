import { useState, useEffect } from 'react';
import { AuthScreen } from './AuthScreen';
import { Dashboard } from './Dashboard';
import { OctopusApi } from './api';

function App() {
  const savedApiKey = localStorage.getItem('octopus_api_key');
  const savedAccountNum = localStorage.getItem('octopus_account_num');
  const initialCredentials = savedApiKey && savedAccountNum
    ? { apiKey: savedApiKey, accountNum: savedAccountNum }
    : null;

  const [credentials, setCredentials] = useState<{ apiKey: string; accountNum: string } | null>(initialCredentials);
  const [api, setApi] = useState<OctopusApi | null>(
    initialCredentials ? new OctopusApi(initialCredentials.apiKey, initialCredentials.accountNum) : null
  );
  const [theme, setTheme] = useState<'light' | 'dark'>(
    window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const handleLogin = (apiKey: string, accountNum: string) => {
    setCredentials({ apiKey, accountNum });
    setApi(new OctopusApi(apiKey, accountNum));
  };

  const handleLogout = () => {
    setCredentials(null);
    setApi(null);
    localStorage.removeItem('octopus_api_key');
    localStorage.removeItem('octopus_account_num');
  };

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  return (
    <div className="app-container">
      <header className="flex-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          🐙 <span style={{ color: 'var(--accent-color)' }}>Octopus</span> Compare
        </h1>
        <div className="flex-row gap-1">
          <button onClick={toggleTheme} className="icon-btn" aria-label="Toggle Theme" title="Toggle Theme">
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
          {credentials && (
            <button onClick={handleLogout} style={{ background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
              Sign Out
            </button>
          )}
        </div>
      </header>

      <main>
        {!api ? (
          <AuthScreen onLogin={handleLogin} />
        ) : (
          <Dashboard api={api} />
        )}
      </main>

      <footer className="app-footer">
        <span className="app-footer-badge">🔒 Privacy-first</span>
        <span className="app-footer-sep">·</span>
        <a
          className="app-footer-badge"
          href="https://github.com/rahbut/octopus-compare"
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Source
        </a>
        <span className="app-footer-sep">·</span>
        <a
          className="app-footer-badge"
          href="https://github.com/rahbut/octopus-compare"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub ↗
        </a>
      </footer>
    </div>
  );
}

export default App;
