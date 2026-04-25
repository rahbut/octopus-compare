import React, { useState, useEffect } from 'react';
import { DEFAULT_GAS_CONVERSION_FACTOR } from './api';

const STORAGE_KEY_API = 'octopus_api_key';
const STORAGE_KEY_ACCOUNT = 'octopus_account_num';
const STORAGE_KEY_GAS_CF = 'octopus_gas_conversion_factor';

interface AuthScreenProps {
  onLogin: (apiKey: string, accountNum: string, gasConversionFactor: number) => void;
}

export function AuthScreen({ onLogin }: AuthScreenProps) {
  const [apiKey, setApiKey] = useState('');
  const [accountNum, setAccountNum] = useState('');
  const [gasConversionFactor, setGasConversionFactor] = useState(DEFAULT_GAS_CONVERSION_FACTOR.toFixed(1));
  const [rememberMe, setRememberMe] = useState(false);

  useEffect(() => {
    const savedApiKey = localStorage.getItem(STORAGE_KEY_API);
    const savedAccountNum = localStorage.getItem(STORAGE_KEY_ACCOUNT);
    const savedGasCF = localStorage.getItem(STORAGE_KEY_GAS_CF);
    if (savedApiKey && savedAccountNum) {
      setApiKey(savedApiKey);
      setAccountNum(savedAccountNum);
      setRememberMe(true);
    }
    if (savedGasCF) setGasConversionFactor(savedGasCF);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedKey = apiKey.trim();
    const trimmedAccount = accountNum.trim();
    const gasCF = parseFloat(gasConversionFactor) || DEFAULT_GAS_CONVERSION_FACTOR;
    if (trimmedKey && trimmedAccount) {
      if (rememberMe) {
        localStorage.setItem(STORAGE_KEY_API, trimmedKey);
        localStorage.setItem(STORAGE_KEY_ACCOUNT, trimmedAccount);
        localStorage.setItem(STORAGE_KEY_GAS_CF, String(gasCF));
      } else {
        localStorage.removeItem(STORAGE_KEY_API);
        localStorage.removeItem(STORAGE_KEY_ACCOUNT);
        localStorage.removeItem(STORAGE_KEY_GAS_CF);
      }
      onLogin(trimmedKey, trimmedAccount, gasCF);
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

          <div className="flex-col gap-1">
            <label htmlFor="gasCF" className="text-secondary" style={{ fontSize: '0.85rem' }}>
              Gas Conversion Factor (m³ → kWh)
              <span style={{ opacity: 0.6, marginLeft: '0.3rem', fontSize: '0.78rem' }} title="Found on your gas bill. The default (11.2) is the UK standard using a typical calorific value of 39.5 MJ/m³.">ⓘ</span>
            </label>
            <input
              id="gasCF"
              type="number"
              step="0.1"
              min="9"
              max="13"
              placeholder="11.2"
              value={gasConversionFactor}
              onChange={(e) => setGasConversionFactor(e.target.value)}
            />
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', cursor: 'pointer', userSelect: 'none', alignSelf: 'flex-start', whiteSpace: 'nowrap' }}>
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            Remember me
          </label>

          <button type="submit" className="mt-2" disabled={!apiKey || !accountNum}>
            Connect Securely
          </button>
        </form>

        <p className="text-secondary text-center mt-2" style={{ fontSize: '0.8rem', opacity: 0.7 }}>
          {rememberMe
            ? 'Your credentials will be saved in your browser\'s local storage. Sign out to remove them.'
            : 'Your API key is only stored in your browser\'s memory and is never sent to any server other than Octopus Energy directly.'}{' '}
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
