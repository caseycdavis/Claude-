import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type AppState } from './api';
import { Chat } from './screens/Chat';
import { Login } from './screens/Login';
import { Setup } from './screens/Setup';

function isReady(s: AppState): boolean {
  return s.demo || Boolean(s.hasKey && s.model && s.chatSet);
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set once the person has finished setup or asked for settings, so the screen does not jump on its own. */
  const [view, setView] = useState<'auto' | 'chat' | 'settings'>('auto');

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'This app cannot reach its server.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error && !state) {
    return (
      <div className="shell">
        <div className="center" role="alert">
          <div>
            <p>{error}</p>
            <p>
              <button type="button" className="btn small" onClick={() => void refresh()}>
                Try again
              </button>
            </p>
          </div>
        </div>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="shell">
        <div className="center">Loading</div>
      </div>
    );
  }

  if (!state.configured || !state.authed) {
    return <Login firstRun={!state.configured} onDone={() => void refresh()} />;
  }

  const showSettings = view === 'settings' || (view === 'auto' && !isReady(state));
  if (showSettings) {
    return (
      <Setup
        state={state}
        firstTime={view === 'auto'}
        refresh={refresh}
        onOpenChat={() => setView('chat')}
        onSignedOut={() => {
          setView('auto');
          void refresh();
        }}
      />
    );
  }

  return <Chat state={state} onOpenSettings={() => setView('settings')} />;
}
