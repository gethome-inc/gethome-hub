/**
 * Where a vendor's requests go, and whose key pays for them.
 *
 * **A route is not a model, and it is not a provider either.** A home picks
 * *what answers* — Claude or OpenAI for a conversation, Jev for a decision —
 * and, separately, *which key buys it*: the vendor's own, or a gateway key that
 * can buy the same model. Vercel's AI Gateway sells all three vendors' models
 * behind one key, at their own APIs' shapes (the Messages API, the Responses
 * API, the Image API and a TypeSafe-compatible endpoint), so moving a vendor
 * onto it changes an address, a credential and the string that names the model
 * on the wire — and nothing about what answers.
 *
 * So the two stay two questions and neither can change the other. Nothing in
 * this file can point a home at a different model; the canonical id is what
 * every price, every `ai_runs` row and every screen reads, and only the request
 * itself carries the gateway's spelling of it (`wireModelId`).
 *
 * **One gateway, and a route per vendor rather than one switch for the lot.**
 * A home that already pays OpenAI directly and buys Jev through Vercel is the
 * ordinary case, not an edge: whether a vendor goes through the gateway is the
 * owner's decision per vendor, stored per vendor (`ai_route_<vendor>`), absent
 * meaning **direct**. Adding a gateway key moves nothing by itself — a home that
 * worked yesterday is not quietly re-routed by a key saved for something else.
 *
 * **Imports nothing but types**, the `agent-core.ts` rule: the settings module
 * and every vendor loop read this, and none of them may drag an SDK in to do so.
 */
import type { AiVendor } from '../core/settings.js';

/** `direct` is the vendor's own API on the vendor's own key. */
export type AiRoute = 'direct' | 'vercel';

export const AI_ROUTES = ['direct', 'vercel'] as const satisfies readonly AiRoute[];

/**
 * The credential a vendor is asked with, and which way the request goes.
 *
 * `SettingsService.aiConnection` is the only thing that builds one: the route
 * decides the slot, so a caller never picks a key and an address separately
 * and gets the two out of step.
 */
export interface AiConnection {
  secret: string;
  route: AiRoute;
}

/** A stored route, or `direct` for anything this build does not serve. */
export function aiRouteOf(stored: unknown): AiRoute {
  return stored === 'vercel' ? 'vercel' : 'direct';
}

/**
 * The gateway this build can route through, as an app renders it.
 *
 * `keyHint` is where to buy a key and `keyPrefix` what one starts with — the
 * placeholder for the field that asks for it, **never a check**: a vendor can
 * change a prefix faster than a hub can be updated, and a positive guard would
 * then refuse a perfectly good key with no way past it.
 *
 * `serves` is what the switches on an app's page are drawn from. Talking out
 * loud is deliberately not a vendor here: GPT-Live's WebRTC offer and the
 * sideband attached beside it are OpenAI's own and the gateway carries neither,
 * so the voice always uses the home's OpenAI key — see `server.ts`'s voice
 * route.
 */
export const GATEWAY = {
  id: 'vercel',
  label: 'Vercel AI Gateway',
  keyHint: 'vercel.com/ai-gateway',
  keyPrefix: 'vck_',
  serves: ['anthropic', 'openai', 'typesafe'],
} as const satisfies {
  id: Exclude<AiRoute, 'direct'>;
  label: string;
  keyHint: string;
  keyPrefix: string;
  serves: readonly AiVendor[];
};

/** Every request to the gateway starts here. */
const GATEWAY_ORIGIN = 'https://ai-gateway.vercel.sh';

/**
 * The Messages API's root for the Anthropic SDK's `baseURL`.
 *
 * `undefined` on the direct route, so the SDK keeps its own default rather than
 * this file restating it — the address the SDK knows is the one that is right.
 * The gateway's Anthropic-compatible API answers at `/v1/messages` under its
 * origin, which is what the SDK appends.
 */
export function anthropicBaseUrl(route: AiRoute): string | undefined {
  return route === 'vercel' ? GATEWAY_ORIGIN : undefined;
}

/**
 * One OpenAI API path on the chosen route — `/responses`, `/images/edits`.
 *
 * The gateway serves OpenAI's shapes under its own `/v1`, so the path is the
 * same either way and only the host moves.
 */
export function openAiUrl(route: AiRoute, path: `/${string}`): string {
  return `${route === 'vercel' ? `${GATEWAY_ORIGIN}/v1` : 'https://api.openai.com/v1'}${path}`;
}

/**
 * What a model is called on the wire.
 *
 * The gateway namespaces a model by its maker (`openai/gpt-5.6-sol`); the
 * vendor's own API does not. **Only a request carries this** — prices, run
 * records and every screen read the canonical id, which is what makes a route
 * change invisible to everything except the bill it goes on.
 */
export function wireModelId(vendor: 'anthropic' | 'openai', route: AiRoute, modelId: string): string {
  return route === 'vercel' ? `${vendor}/${modelId}` : modelId;
}

/** Who a person should read as having answered or refused, for a sentence. */
export function routeName(route: AiRoute, vendorName: string): string {
  return route === 'vercel' ? GATEWAY.label : vendorName;
}
