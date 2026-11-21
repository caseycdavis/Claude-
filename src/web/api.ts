import type { LinkStatus, Message, Note, Tone } from '../server/types';

export type AppState = {
  configured: boolean;
  authed: boolean;
  demo: boolean;
  hasKey?: boolean;
  model?: string | null;
  chatSet?: boolean;
  juanNumber?: string | null;
  previewBeforeSend?: boolean;
  appendEnglish?: boolean;
  link?: LinkStatus;
};

export type Preview = { spanish: string; back: string; notes: Note[]; ambiguity: string | null };
export type ModelChoice = { id: string; name: string };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'This app cannot reach its server. Check that the Mac mini is on.');
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'Something went wrong.');
  return data as T;
}

export const api = {
  state: () => call<AppState>('GET', '/api/state'),
  setup: (passphrase: string) => call<void>('POST', '/api/setup', { passphrase }),
  login: (passphrase: string) => call<void>('POST', '/api/login', { passphrase }),
  logout: () => call<void>('POST', '/api/logout'),
  saveSettings: (settings: {
    anthropicApiKey?: string;
    model?: string;
    juanNumber?: string;
    previewBeforeSend?: boolean;
    appendEnglish?: boolean;
  }) => call<void>('PUT', '/api/settings', settings),
  models: () => call<{ models: ModelChoice[]; suggested: string | null }>('GET', '/api/models'),
  messages: (before?: number) =>
    call<{ messages: Message[] }>('GET', `/api/messages?limit=${PAGE}${before === undefined ? '' : `&before=${before}`}`),
  draft: (text: string, tone: Tone) => call<Preview>('POST', '/api/draft', { text, tone }),
  send: (input: { english: string; spanish: string; back?: string }) => call<Message>('POST', '/api/send', input),
  retry: (id: string) => call<Message>('POST', `/api/messages/${encodeURIComponent(id)}/retry`),
  markRead: (ids: string[]) => call<void>('POST', '/api/read', { ids }),
  linkStart: () => call<void>('POST', '/api/link/start'),
  linkPairing: (phone: string) => call<{ code: string }>('POST', '/api/link/pairing', { phone }),
  linkLogout: () => call<void>('POST', '/api/link/logout'),
  demoJuan: (text: string) => call<void>('POST', '/api/demo/juan', { text }),
  demoLink: (state: LinkStatus['state']) => call<void>('POST', '/api/demo/link', { state }),
};

export const PAGE = 50;

/** Live updates from the server. The browser reconnects on its own; `onOpen` fires on every (re)connect. */
export function openEvents(handlers: {
  onMessage?: (m: Message) => void;
  onLink?: (s: LinkStatus) => void;
  onOpen?: () => void;
}): () => void {
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => handlers.onOpen?.());
  source.addEventListener('message', (e) => handlers.onMessage?.(JSON.parse((e as MessageEvent<string>).data) as Message));
  source.addEventListener('link', (e) => handlers.onLink?.(JSON.parse((e as MessageEvent<string>).data) as LinkStatus));
  return () => source.close();
}
