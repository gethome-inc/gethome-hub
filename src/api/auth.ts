import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Member } from '../core/pairing.js';
import type { PairingService } from '../core/pairing.js';
import type { AccessService, PermissionKey } from '../core/access.js';

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

/**
 * preHandler add-on: requires the resolved member to hold a permission.
 *
 * This replaced `requireOwner`, which was one string comparison guarding
 * fifteen routes — the only knob anybody had was which side of the owner line
 * a whole route sat on. There is deliberately no second mechanism left beside
 * it: a route is either open to every member (the floor — reading the home,
 * renaming yourself, leaving) or it names the permission it needs.
 *
 * **The refusal names the permission**, because "the hub said no" leaves a
 * person with no idea what to ask for. Apps turn `{error, permission}` into a
 * sentence; the owner is answered `true` without any of this being consulted,
 * so a home can never lock itself out.
 */
export function requirePermission(access: AccessService, permission: PermissionKey) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const member = request.member;
    if (!member || !access.can(member.id, permission)) {
      await reply.code(403).send({ error: 'forbidden', permission });
      return reply;
    }
    return undefined;
  };
}
