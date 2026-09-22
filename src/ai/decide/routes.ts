/**
 * Where the home buys its decisions.
 *
 * **A route is not a model, and keeping those two apart is the whole of this
 * file.** Every route below serves the *same* model — the one
 * `DECISION_MODEL` names and every threshold in `questions.ts` is calibrated
 * against. What differs is the address, the key, and the string that address
 * expects in the `model` field. So this is not the model picker the rest of
 * the subsystem refuses to have: nothing here can point the hub at a
 * different model, and calibration is never silently invalidated by choosing
 * one.
 *
 * It exists because a home may already hold a gateway key. Making somebody
 * open a second account to buy a model they can already reach is a tax on
 * nothing, and gateways serve the identical request and answer shapes.
 *
 * **The hub owns this list and an app renders it** — the `GET /permissions`
 * rule the model lists already follow, so a route added later needs no app
 * release. `docs/jev.md` is canonical.
 */
import { DECISION_MODEL } from './decider.js';

export interface DecisionRoute {
  readonly id: string;
  /** What a person calls it. */
  readonly label: string;
  /** The API root. The client appends `/v1/systemone`. */
  readonly baseUrl: string;
  /** What *this* address calls the model. The model is the same either way. */
  readonly modelId: string;
  /** Where a key for this route comes from, for the sheet that asks for one. */
  readonly keyHint: string;
  /**
   * What a key bought here starts with, for the field that asks for one.
   *
   * A placeholder and nothing else: `apiKeyField` deliberately asserts nothing
   * about how a decision key *begins*, and that stays true with this beside it
   * — a vendor can change a prefix faster than a hub can be updated, and a
   * positive check would then refuse a perfectly good key with no way past it.
   * Here it costs nothing to be wrong and saves somebody pasting the other
   * route's key into the box.
   */
  readonly keyPrefix: string;
}

export const DECISION_ROUTES = [
  {
    id: 'typesafe',
    label: 'TypeSafe',
    baseUrl: 'https://api.typesafe.ai',
    modelId: DECISION_MODEL,
    keyHint: 'typesafe.ai',
    keyPrefix: 'ts-',
  },
  {
    /**
     * Vercel's AI Gateway, which publishes a **TypeSafe-compatible** endpoint.
     *
     * Deliberately the `/typesafe` base rather than the gateway's own
     * `/v1/evaluate`: that one is the AI SDK's normalised shape, which renames
     * `noul` to `probability` and moves `confidence` into provider metadata —
     * so it would answer in a vocabulary this subsystem would have to learn
     * twice. The compatible path answers exactly what the direct API does,
     * plus a `provider_metadata` block the client ignores.
     */
    id: 'vercel',
    label: 'Vercel AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/typesafe',
    modelId: 'typesafe-ai/jev',
    keyHint: 'vercel.com/ai-gateway',
    keyPrefix: 'vck_',
  },
] as const satisfies readonly DecisionRoute[];

export type DecisionRouteId = (typeof DECISION_ROUTES)[number]['id'];

export const DECISION_ROUTE_IDS = DECISION_ROUTES.map((route) => route.id) as [
  DecisionRouteId,
  ...DecisionRouteId[],
];

export const DEFAULT_DECISION_ROUTE: DecisionRouteId = 'typesafe';

/**
 * The route a stored id names, or the default.
 *
 * A stored id that no build offers any more falls back rather than refusing —
 * `effectiveModel`'s rule: a setting is a preference among what is still
 * served, and a home should not stop deciding because a gateway was retired.
 */
export function decisionRouteOf(stored: string | null | undefined): DecisionRoute {
  const found = DECISION_ROUTES.find((route) => route.id === stored);
  return found ?? DECISION_ROUTES[0];
}
