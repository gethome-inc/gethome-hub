import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Member } from '../core/pairing.js';
import type { PairingService } from '../core/pairing.js';

declare module 'fastify' {
  interface FastifyRequest {
    member: Member | null;
  }
}

export function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  const query = request.query as Record<string, unknown> | undefined;
  if (typeof query?.token === 'string' && query.token.length > 0) return query.token;
  return null;
}

/** preHandler: resolves the bearer token to a member or replies 401. */
export function requireMember(pairing: PairingService) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = extractToken(request);
    const member = token ? await pairing.verifyToken(token) : null;
    if (!member) {
      await reply.code(401).send({ error: 'unauthorized' });
      return reply;
    }
    request.member = member;
    return undefined;
  };
}

/** preHandler add-on: requires the resolved member to be the owner. */
export async function requireOwner(request: FastifyRequest, reply: FastifyReply) {
  if (request.member?.role !== 'owner') {
    await reply.code(403).send({ error: 'owner_only' });
    return reply;
  }
  return undefined;
}
