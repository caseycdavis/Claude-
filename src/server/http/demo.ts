import type { FastifyInstance } from 'fastify';
import type { FakeTransport } from '../transport/fake.js';
import type { LinkState } from '../types.js';

const STATES: readonly LinkState[] = ['unlinked', 'linking', 'linked', 'down'];

/** Only registered in demo mode. Lets a person or a test play Juan and break the link. */
export function registerDemoRoutes(app: FastifyInstance, transport: FakeTransport): void {
  app.post('/api/demo/juan', async (req, reply) => {
    const text = (req.body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || text === '') return reply.code(400).send({ error: 'text is required.' });
    transport.emitFromJuan(text);
    return reply.code(204).send();
  });

  app.post('/api/demo/link', async (req, reply) => {
    const state = (req.body as { state?: unknown } | null)?.state as LinkState;
    if (!STATES.includes(state)) return reply.code(400).send({ error: 'state is not one of the link states.' });
    transport.setState(state);
    return reply.code(204).send();
  });
}
