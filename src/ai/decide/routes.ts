/**
 * Where a decision is bought: TypeSafe's own API, or the gateway.
 *
 * **A route is not a model, and keeping those two apart is the whole of this
 * file.** Both addresses below serve the *same* model — the one
 * `DECISION_MODEL` names and every threshold in `questions.ts` is calibrated
 * against. What differs is the address, the key, and the string that address
 * expects in the `model` field. So this is not the model picker the rest of
 * the subsystem refuses to have: nothing here can point the hub at a different
 * model, and calibration is never silently invalidated by choosing one.
 *
 * Which of the two a home uses is `ai_route_typesafe`, the same per-vendor
 * setting Claude and OpenAI have (`src/ai/gateway.ts`), and the key comes from
 * that route's own slot — TypeSafe's for `direct`, the gateway's for `vercel`.
 * It used to be a route stored beside the TypeSafe key, which made the
 * TypeSafe slot hold a Vercel key on a home buying through the gateway; that
 * is the confusion one gateway key for every vendor exists to end.
 * `docs/jev.md` is canonical.
 */
import type { AiRoute } from '../gateway.js';
import { DECISION_MODEL } from './decider.js';

export interface DecisionRoute {
  readonly id: AiRoute;
  /** The API root. The client appends `/v1/systemone`. */
  readonly baseUrl: string;
  /** What *this* address calls the model. The model is the same either way. */
  readonly modelId: string;
}

export const DECISION_ROUTES: Readonly<Record<AiRoute, DecisionRoute>> = {
  direct: {
    id: 'direct',
    baseUrl: 'https://api.typesafe.ai',
    modelId: DECISION_MODEL,
  },
  /**
   * Vercel's AI Gateway, which publishes a **TypeSafe-compatible** endpoint.
   *
   * Deliberately the `/typesafe` base rather than the gateway's own
   * `/v1/evaluate`: that one is the AI SDK's normalised shape, which renames
   * `noul` to `probability` and moves `confidence` into provider metadata — so
   * it would answer in a vocabulary this subsystem would have to learn twice.
   * The compatible path answers exactly what the direct API does, plus a
   * `provider_metadata` block the client ignores.
   */
  vercel: {
    id: 'vercel',
    baseUrl: 'https://ai-gateway.vercel.sh/typesafe',
    modelId: 'typesafe-ai/jev',
  },
};
