import { useState, type KeyboardEvent } from 'react';
import type { LinkState, Message, Tone } from '../../server/types';
import { ApiError, api, type Preview } from '../api';

const CHIPS: { tone: Exclude<Tone, 'base'>; label: string }[] = [
  { tone: 'warmer', label: 'Warmer' },
  { tone: 'firmer', label: 'Firmer' },
  { tone: 'playful', label: 'Playful' },
  { tone: 'shorter', label: 'Shorter' },
];

type Phase = 'idle' | 'working' | 'preview' | 'sending';

function message(e: unknown): string {
  return e instanceof ApiError ? e.message : 'That did not work. Your draft is kept.';
}

export function Composer({
  previewBeforeSend,
  linkState,
  onSent,
}: {
  previewBeforeSend: boolean;
  linkState: LinkState;
  onSent: (m: Message) => void;
}) {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [tone, setTone] = useState<Tone>('base');
  const [error, setError] = useState<string | null>(null);
  /** Shown after a translation fails, so the message can still go out untranslated by choice. */
  const [offerAsWritten, setOfferAsWritten] = useState(false);

  const draft = text.trim();
  const busy = phase === 'working' || phase === 'sending';

  function reset() {
    setText('');
    setPreview(null);
    setTone('base');
    setError(null);
    setOfferAsWritten(false);
    setPhase('idle');
  }

  async function translate(nextTone: Tone) {
    if (draft === '') return;
    setError(null);
    setOfferAsWritten(false);
    setPhase('working');
    try {
      const result = await api.draft(draft, nextTone);
      setTone(nextTone);
      setPreview(result);
      setPhase('preview');
      return result;
    } catch (e) {
      setError(message(e));
      setOfferAsWritten(preview === null);
      setPhase(preview === null ? 'idle' : 'preview');
      return null;
    }
  }

  async function deliver(spanish: string, back?: string, english = draft) {
    setError(null);
    setPhase('sending');
    try {
      onSent(await api.send({ english, spanish, back }));
      reset();
    } catch (e) {
      setError(message(e));
      setPhase(preview === null ? 'idle' : 'preview');
    }
  }

  /** With preview switched off: translate and send in one step. */
  async function translateAndSend() {
    const result = await translate('base');
    if (result) {
      setPreview(null);
      await deliver(result.spanish, result.back);
    }
  }

  function primary() {
    if (busy || draft === '') return;
    if (previewBeforeSend) void translate('base');
    else void translateAndSend();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      primary();
    }
  }

  const showPreview = previewBeforeSend && preview !== null && (phase === 'preview' || phase === 'sending' || phase === 'working');

  return (
    <footer className="composer">
      {linkState !== 'linked' && (
        <div className="hint">
          {linkState === 'down' ? 'The WhatsApp link is down.' : 'WhatsApp is not linked.'} You can draft, but nothing will send until it is back.
        </div>
      )}

      {showPreview && preview ? (
        <>
          <div className="wrote">You wrote: {draft}</div>
          <div className="preview">
            <div className="part">
              <div className="label">Juan will get</div>
              <div className="spanish" lang="es">
                {preview.spanish}
              </div>
            </div>
            <div className="part">
              <div className="label">Reads back as</div>
              <div className="back">{preview.back}</div>
            </div>
            {preview.ambiguity && (
              <div className="part">
                <div className="label">Could be read two ways</div>
                <div className="back">{preview.ambiguity}</div>
              </div>
            )}
          </div>
          <div className="chips">
            {CHIPS.map((c) => (
              <button
                key={c.tone}
                type="button"
                className="chip"
                aria-pressed={tone === c.tone}
                disabled={busy}
                onClick={() => void translate(tone === c.tone ? 'base' : c.tone)}
              >
                {c.label}
              </button>
            ))}
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="line">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                setTone('base');
                setError(null);
                setPhase('idle');
              }}
            >
              Edit
            </button>
            <button type="button" className="btn primary grow" disabled={busy} onClick={() => void deliver(preview.spanish, preview.back)}>
              {phase === 'sending' ? 'Sending' : phase === 'working' ? 'Updating' : 'Send to Juan'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="line">
            <div className="field grow">
              <label htmlFor="draft">Message in English</label>
              <textarea
                id="draft"
                rows={Math.min(4, Math.max(1, text.split('\n').length))}
                value={text}
                disabled={busy}
                onChange={(e) => {
                  setText(e.target.value);
                  setError(null);
                  setOfferAsWritten(false);
                }}
                onKeyDown={onKeyDown}
              />
            </div>
            <button type="button" className="btn primary" disabled={busy || draft === ''} onClick={primary}>
              {busy ? 'Working' : previewBeforeSend ? 'Translate' : 'Send'}
            </button>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {offerAsWritten && draft !== '' && (
            <button type="button" className="btn small" disabled={busy} onClick={() => void deliver(draft, undefined, '')}>
              Send as written, untranslated
            </button>
          )}
        </>
      )}
    </footer>
  );
}
