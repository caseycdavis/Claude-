import { useState } from 'react';
import type { Message } from '../../server/types';
import { ApiError, api } from '../api';

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.5" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17v.5" />
    </svg>
  );
}

export function Bubble({ message, onChange }: { message: Message; onChange: (m: Message) => void }) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const incoming = message.direction === 'in';

  async function retry() {
    setRetrying(true);
    setError(null);
    try {
      onChange(await api.retry(message.id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setRetrying(false);
    }
  }

  let body;
  if (message.kind === 'other') {
    body = <div className="theirs">{message.original}. Open WhatsApp to see it.</div>;
  } else if (incoming) {
    // Juan's Spanish above, the English Casey reads below it.
    body = (
      <>
        <div className={message.status === 'skipped' ? 'mine' : 'theirs'} lang="es">
          {message.original}
        </div>
        {message.status === 'done' && <div className="mine">{message.translation}</div>}
        {message.status === 'translating' && <div className="pending">Translating</div>}
        {message.status === 'failed' && (
          <div className="failed">
            <span>Translation failed</span>
            <button type="button" className="btn small" onClick={retry} disabled={retrying}>
              {retrying ? 'Trying' : 'Try again'}
            </button>
          </div>
        )}
      </>
    );
  } else if (message.source === 'app') {
    // What Casey wrote above, the Spanish that was sent below it.
    body = (
      <>
        {message.original !== '' && message.original !== message.translation && <div className="mine">{message.original}</div>}
        <div className={message.original === '' || message.original === message.translation ? 'mine' : 'theirs'} lang="es">
          {message.translation}
        </div>
      </>
    );
  } else {
    body = <div className="mine">{message.original}</div>;
  }

  const tail = incoming ? '' : message.source === 'phone' ? ' · Sent from WhatsApp' : ' · Sent';

  return (
    <li className={`row ${incoming ? 'in' : 'out'}`}>
      <div className="bubble">{body}</div>
      {message.notes.map((n) => (
        <div className="flag" key={n.term}>
          <InfoIcon />
          <span>
            <strong>{n.term}</strong> = {n.meaning}
          </span>
        </div>
      ))}
      {message.ambiguity && (
        <div className="flag">
          <AlertIcon />
          <span>
            <strong>Two readings.</strong> {message.ambiguity}
          </span>
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="meta">
        {time(message.ts)}
        {tail}
      </div>
    </li>
  );
}
