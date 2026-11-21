import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';

/** First run asks for a new passphrase; later visits ask for the existing one. */
export function Login({ firstRun, onDone }: { firstRun: boolean; onDone: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (firstRun) await api.setup(passphrase);
      else await api.login(passphrase);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work.');
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="bar">
        <h1>Parce</h1>
      </header>
      <main className="page">
        <form className="card" onSubmit={submit}>
          <h2>{firstRun ? 'Welcome' : 'Sign in'}</h2>
          {firstRun && <p>This passphrase protects your messages and your WhatsApp link. Use at least 8 characters and keep it somewhere safe.</p>}
          <div className="field">
            <label htmlFor="passphrase">{firstRun ? 'Choose a passphrase' : 'Passphrase'}</label>
            <input
              id="passphrase"
              type="password"
              autoComplete={firstRun ? 'new-password' : 'current-password'}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoFocus
            />
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="btn primary" disabled={busy || passphrase === ''}>
            {busy ? 'Working' : 'Continue'}
          </button>
        </form>
      </main>
    </div>
  );
}
