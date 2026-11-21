import { useEffect, useState } from 'react';
import type { LinkStatus } from '../../server/types';
import { ApiError, api, openEvents, type AppState, type ModelChoice } from '../api';

function problem(e: unknown): string {
  return e instanceof ApiError ? e.message : 'That did not work.';
}

function KeyCard({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.saveSettings({ anthropicApiKey: key.trim() });
      setKey('');
      await refresh();
    } catch (e) {
      setError(problem(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>1. Translation key</h2>
      {state.hasKey ? <div className="done">A key is saved. Paste a new one to replace it.</div> : <p>Paste the Anthropic API key you created in the Claude Console. It is stored on this machine only.</p>}
      <div className="field">
        <label htmlFor="key">Anthropic API key</label>
        <input id="key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <button type="button" className="btn primary" disabled={busy || key.trim() === ''} onClick={() => void save()}>
        {busy ? 'Checking the key' : 'Save key'}
      </button>
    </section>
  );
}

function ModelCard({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.hasKey) return;
    let live = true;
    api
      .models()
      .then((r) => live && setModels(r.models))
      .catch((e) => live && setError(problem(e)));
    return () => {
      live = false;
    };
  }, [state.hasKey]);

  async function choose(id: string) {
    setError(null);
    try {
      await api.saveSettings({ model: id });
      await refresh();
    } catch (e) {
      setError(problem(e));
    }
  }

  return (
    <section className={`card ${state.hasKey ? '' : 'locked'}`}>
      <h2>2. Translator</h2>
      {!state.hasKey ? (
        <p>Save a key first.</p>
      ) : (
        <>
          <p>The best one your key can use is chosen for you. A smaller one is faster and cheaper; switch and compare the Spanish.</p>
          <div className="field">
            <label htmlFor="model">Translator model</label>
            <select id="model" value={state.model ?? ''} onChange={(e) => void choose(e.target.value)}>
              {state.model && !models.some((m) => m.id === state.model) && <option value={state.model}>{state.model}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

function NumberCard({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [number, setNumber] = useState(state.juanNumber ? `+${state.juanNumber}` : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.saveSettings({ juanNumber: number });
      await refresh();
      setSaved(true);
    } catch (e) {
      setError(problem(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>3. Juan's number</h2>
      <p>This is the only chat the app reads or writes. Include the country code, for example +57 300 123 4567.</p>
      <div className="field">
        <label htmlFor="number">Juan's WhatsApp number</label>
        <input id="number" type="tel" inputMode="tel" autoComplete="off" value={number} onChange={(e) => setNumber(e.target.value)} />
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {saved && <div className="done">Saved.</div>}
      <button type="button" className="btn primary" disabled={busy || number.trim() === ''} onClick={() => void save()}>
        {busy ? 'Saving' : 'Save number'}
      </button>
    </section>
  );
}

function LinkCard({ link, ready }: { link: LinkStatus; ready: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wantNumberCode, setWantNumberCode] = useState(false);
  const [myNumber, setMyNumber] = useState('');
  const [code, setCode] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(problem(e));
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (!ready) {
    body = <p>Save Juan's number first.</p>;
  } else if (link.state === 'linked') {
    body = (
      <>
        <div className="done">Linked. Only your chat with Juan is read.</div>
        <button
          type="button"
          className="btn small"
          disabled={busy}
          onClick={() => {
            if (window.confirm('Unlink this app from WhatsApp? Messages will stop arriving here until you link again.')) void run(api.linkLogout);
          }}
        >
          Unlink
        </button>
      </>
    );
  } else if (link.state === 'down') {
    body = <p>The link dropped and the app is reconnecting on its own. If this stays for more than a few minutes, check the Mac mini's internet connection.</p>;
  } else if (link.state === 'unlinked') {
    body = (
      <>
        <p>Have your iPhone ready, then show the code.</p>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void run(api.linkStart)}>
          Show linking code
        </button>
      </>
    );
  } else {
    body = (
      <>
        <ol className="steps">
          <li>Open WhatsApp on your phone.</li>
          <li>Go to Settings, then Linked Devices, then Link a Device.</li>
          <li>Point the phone at this code.</li>
        </ol>
        <div className="qr">{link.qr ? <img src={link.qr} alt="Linking code for WhatsApp" /> : 'Getting a code'}</div>
        {code ?? link.pairingCode ? (
          <>
            <p>On the phone choose "Link with phone number instead" and type this code:</p>
            <div className="code">{code ?? link.pairingCode}</div>
          </>
        ) : wantNumberCode ? (
          <>
            <div className="field">
              <label htmlFor="mine">Your own WhatsApp number, with country code</label>
              <input id="mine" type="tel" inputMode="tel" value={myNumber} onChange={(e) => setMyNumber(e.target.value)} />
            </div>
            <button
              type="button"
              className="btn"
              disabled={busy || myNumber.trim() === ''}
              onClick={() => void run(async () => setCode((await api.linkPairing(myNumber)).code))}
            >
              Get a number code
            </button>
          </>
        ) : (
          <button type="button" className="btn small" onClick={() => setWantNumberCode(true)}>
            Use a number code instead
          </button>
        )}
      </>
    );
  }

  return (
    <section className={`card ${ready ? '' : 'locked'}`}>
      <h2>4. Link WhatsApp</h2>
      {body}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** First-time setup and, later, the settings page. Same cards either way. */
export function Setup({
  state,
  firstTime,
  refresh,
  onOpenChat,
  onSignedOut,
}: {
  state: AppState;
  firstTime: boolean;
  refresh: () => Promise<void>;
  onOpenChat: () => void;
  onSignedOut: () => void;
}) {
  const [link, setLink] = useState<LinkStatus>(state.link ?? { state: 'unlinked', qr: null, pairingCode: null, since: Date.now() });
  useEffect(() => openEvents({ onLink: setLink }), []);

  const ready = Boolean(state.hasKey && state.model && state.chatSet);

  return (
    <div className="shell">
      <header className="bar">
        <h1>{firstTime ? 'Set up Parce' : 'Settings'}</h1>
      </header>
      <main className="page">
        <KeyCard state={state} refresh={refresh} />
        <ModelCard state={state} refresh={refresh} />
        <NumberCard state={state} refresh={refresh} />
        <LinkCard link={link} ready={Boolean(state.chatSet)} />

        <section className="card">
          <h2>Sending</h2>
          <Toggle
            label="Show me the Spanish before it sends"
            checked={state.previewBeforeSend ?? true}
            onChange={(v) => void api.saveSettings({ previewBeforeSend: v }).then(refresh)}
          />
          <Toggle
            label="Add my English under what Juan gets"
            checked={state.appendEnglish ?? false}
            onChange={(v) => void api.saveSettings({ appendEnglish: v }).then(refresh)}
          />
        </section>

        <button type="button" className="btn primary" disabled={!ready} onClick={onOpenChat}>
          {firstTime ? 'Open the chat' : 'Back to the chat'}
        </button>
        {!ready && <p className="hint">Save a key and Juan's number to continue. Linking WhatsApp can also be done from the chat.</p>}
        <button type="button" className="btn small" onClick={() => void api.logout().then(onSignedOut)}>
          Sign out
        </button>
      </main>
    </div>
  );
}
