import React, { useState } from 'react';

interface AuthScreenProps {
  onLogin: (apiKey: string, accountNum: string) => void;
}

export function AuthScreen({ onLogin }: AuthScreenProps) {
  const [apiKey, setApiKey] = useState('');
  const [accountNum, setAccountNum] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (apiKey && accountNum) {
      onLogin(apiKey.trim(), accountNum.trim());
    }
  };

  return (
    <div className="flex-col gap-4" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
      <div className="panel flex-col gap-2" style={{ maxWidth: '400px', width: '100%' }}>
        <h2 className="text-center">Octopus Compare</h2>
        <p className="text-secondary text-center" style={{ fontSize: '0.9rem' }}>
          Compare real tariff costs based on your actual consumption data.
        </p>

        <form onSubmit={handleSubmit} className="flex-col gap-2 mt-2">
          <div className="flex-col gap-1">
            <label htmlFor="apiKey" className="text-secondary" style={{ fontSize: '0.85rem' }}>API Key</label>
            <input
              id="apiKey"
              type="password"
              placeholder="sk_live_..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
            />
          </div>

          <div className="flex-col gap-1">
            <label htmlFor="accountNum" className="text-secondary" style={{ fontSize: '0.85rem' }}>Account Number</label>
            <input
              id="accountNum"
              type="text"
              placeholder="A-XXXXXXX"
              value={accountNum}
              onChange={(e) => setAccountNum(e.target.value)}
              required
            />
          </div>

          <button type="submit" className="mt-2" disabled={!apiKey || !accountNum}>
            Connect Securely
          </button>
        </form>

        <p className="text-secondary text-center mt-2" style={{ fontSize: '0.8rem', opacity: 0.7 }}>
          Your API key is only stored in your browser's memory and is never sent to any server other than Octopus Energy directly.{' '}
          <a
            href="https://octopus.energy/dashboard/new/accounts/personal-details/api-access"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent-color)' }}
          >
            Find your API key
          </a>
        </p>
      </div>
    </div>
  );
}
