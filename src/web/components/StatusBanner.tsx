import type { LinkStatus } from '../../server/types';

export function linkLabel(state: LinkStatus['state']): string {
  if (state === 'linked') return 'WhatsApp linked';
  if (state === 'down') return 'WhatsApp link down';
  return 'WhatsApp not linked';
}

/** Says plainly when messages are not flowing, and since when. */
export function StatusBanner({ link, onFix }: { link: LinkStatus; onFix: () => void }) {
  if (link.state === 'linked') return null;
  const since = new Date(link.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (
    <section className="banner" aria-label="Link status">
      {link.state === 'down' ? (
        <>
          <strong>Down since {since}</strong>
          <span>Messages are not arriving here or sending. It keeps trying on its own. WhatsApp on your phone still works.</span>
        </>
      ) : (
        <>
          <strong>WhatsApp is not linked</strong>
          <span>Nothing arrives or sends until this app is linked to your WhatsApp.</span>
          <button type="button" className="btn warn small" onClick={onFix}>
            Link WhatsApp
          </button>
        </>
      )}
    </section>
  );
}
