import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LinkStatus, Message } from '../../server/types';
import { PAGE, api, openEvents, type AppState } from '../api';
import { Bubble } from '../components/Bubble';
import { Composer } from '../components/Composer';
import { StatusBanner, linkLabel } from '../components/StatusBanner';

function upsert(list: Message[], m: Message): Message[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i === -1) return [...list, m].sort((a, b) => a.ts - b.ts);
  const next = [...list];
  next[i] = m;
  return next;
}

function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function SettingsIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h8M20 7h-2M4 17h2M12 17h8" />
      <circle cx="15" cy="7" r="2.5" />
      <circle cx="9" cy="17" r="2.5" />
    </svg>
  );
}

/** Demo mode only: lets a person play Juan and break the link. */
function DemoStrip({ linkState }: { linkState: LinkStatus['state'] }) {
  const [text, setText] = useState('');
  const send = () => {
    if (text.trim() === '') return;
    void api.demoJuan(text.trim());
    setText('');
  };
  return (
    <div className="demo">
      <div className="field">
        <label htmlFor="demo-juan">Play Juan</label>
        <input id="demo-juan" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
      </div>
      <button type="button" className="btn small" onClick={send}>
        Send as Juan
      </button>
      <button type="button" className="btn small" onClick={() => void api.demoLink(linkState === 'linked' ? 'down' : 'linked')}>
        {linkState === 'linked' ? 'Break the link' : 'Restore the link'}
      </button>
    </div>
  );
}

export function Chat({ state, onOpenSettings }: { state: AppState; onOpenSettings: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [link, setLink] = useState<LinkStatus>(state.link ?? { state: 'unlinked', qr: null, pairingCode: null, since: Date.now() });
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reported = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const { messages: latest } = await api.messages();
      setMessages((current) => latest.reduce(upsert, current));
      setHasEarlier(latest.length === PAGE);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load messages.');
    }
  }, []);

  useEffect(() => {
    // Loads on first connect and again after every reconnect, so nothing sent while offline is missed.
    return openEvents({
      onOpen: () => void load(),
      onMessage: (m) => setMessages((current) => upsert(current, m)),
      onLink: setLink,
    });
  }, [load]);

  // Opening the chat tells WhatsApp the messages were read, as reading them on the phone would.
  useEffect(() => {
    const report = () => {
      if (document.visibilityState !== 'visible') return;
      const ids = messages.filter((m) => m.direction === 'in' && !m.read && !reported.current.has(m.id)).map((m) => m.id);
      if (ids.length === 0) return;
      ids.forEach((id) => reported.current.add(id));
      void api.markRead(ids).catch(() => ids.forEach((id) => reported.current.delete(id)));
    };
    report();
    document.addEventListener('visibilitychange', report);
    return () => document.removeEventListener('visibilitychange', report);
  }, [messages]);

  async function loadEarlier() {
    const oldest = messages[0];
    if (!oldest) return;
    const { messages: earlier } = await api.messages(oldest.id);
    setMessages((current) => earlier.reduce(upsert, current));
    setHasEarlier(earlier.length === PAGE);
  }

  const items = useMemo(() => {
    const out: ({ kind: 'day'; label: string } | { kind: 'message'; message: Message })[] = [];
    let last = '';
    for (const m of messages) {
      const label = dayLabel(m.ts);
      if (label !== last) out.push({ kind: 'day', label });
      last = label;
      out.push({ kind: 'message', message: m });
    }
    return out;
  }, [messages]);

  return (
    <div className="shell">
      <header className="bar">
        <div className="avatar" aria-hidden="true">
          J
        </div>
        <div className="who">
          <h1>Juan</h1>
          <div className={`status ${link.state === 'linked' ? '' : 'warn'}`}>
            <span className="dot" aria-hidden="true" />
            <span>{linkLabel(link.state)}</span>
          </div>
        </div>
        <button type="button" className="icon-button" aria-label="Settings" onClick={onOpenSettings}>
          <SettingsIcon />
        </button>
      </header>

      {state.demo && <DemoStrip linkState={link.state} />}
      <StatusBanner link={link} onFix={onOpenSettings} />

      <main className="thread">
        <ul>
          {hasEarlier && (
            <li className="day">
              <button type="button" className="btn small" onClick={() => void loadEarlier()}>
                Show earlier messages
              </button>
            </li>
          )}
          {loadError && (
            <li className="day error" role="alert">
              {loadError}
            </li>
          )}
          {messages.length === 0 && !loadError && <li className="day">No messages yet. New ones from Juan will appear here.</li>}
          {items.map((item) =>
            item.kind === 'day' ? (
              <li className="day" key={`day-${item.label}`} aria-hidden="true">
                {item.label}
              </li>
            ) : (
              <Bubble key={item.message.id} message={item.message} onChange={(m) => setMessages((current) => upsert(current, m))} />
            ),
          )}
        </ul>
      </main>

      <Composer
        previewBeforeSend={state.previewBeforeSend ?? true}
        linkState={link.state}
        onSent={(m) => setMessages((current) => upsert(current, m))}
      />
    </div>
  );
}
