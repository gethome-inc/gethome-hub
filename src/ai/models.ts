/**
 * The models the mapping agent may run on, and what a run costs.
 *
 * This is an allowlist, not a hint. Two things make it load-bearing:
 *
 *  - **Tool availability.** The agent researches devices with the server-side
 *    `web_search_20260209` / `web_fetch_20260209` tools, and those versions
 *    exist only on Opus 4.6+ and Sonnet 4.6+. Pointing `ai_model` at an older
 *    or smaller model (Haiku, Sonnet 4.5, anything 4.5-era) does not degrade
 *    the run — the API rejects the request outright. Better to refuse a model
 *    we know cannot work than to arm a backoff gate over a 400.
 *  - **The budget cap is computed here.** The Agent SDK used to report
 *    `total_cost_usd` for us; on the Messages API the hub adds up its own
 *    token usage, which means it needs the price of the model it is running.
 *
 * Prices are list prices in USD per million tokens, from Anthropic's public
 * pricing. They move rarely, and the cap they feed is a safety rail rather
 * than an invoice — `status.lastRun.costUsd` is an estimate and says so.
 */

export interface ModelPricing {
  /** USD per million input tokens. */
  readonly inputPerMTok: number;
  /** USD per million output tokens (thinking included — it is billed as output). */
  readonly outputPerMTok: number;
}

/**
 * Every model the hub will run the mapping agent on. Deliberately small:
 * device adaptation is a reasoning-heavy job that runs a handful of times in
 * a hub's life, so the list is the models that are good at it and can drive
 * the research tools.
 */
export const SUPPORTED_MODELS: Readonly<Record<string, ModelPricing>> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
};

/**
 * The default. Opus-tier because a wrong mapping is worse than an expensive
 * one: the descriptor is cached per device model and silently shapes what the
 * apps show for that device until somebody explicitly remaps it.
 */
export const DEFAULT_MODEL = 'claude-opus-5';

/** Server-side web search, billed per request rather than per token. */
export const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000;

/**
 * Cache reads bill at ~0.1x the input rate and cache writes at ~1.25x. The
 * hub caches its (large, static) system prompt, so counting reads at the full
 * input rate would overstate a run's cost several times over.
 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function isSupportedModel(model: string): boolean {
  return Object.hasOwn(SUPPORTED_MODELS, model);
}

export function supportedModelIds(): string[] {
  return Object.keys(SUPPORTED_MODELS);
}

/** Token counts as the Messages API reports them, all fields optional. */
export interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  webSearchRequests?: number;
}

/**
 * Estimate what a run has cost so far. Used for the per-run budget cap and
 * for `status.lastRun.costUsd`; an unknown model falls back to the most
 * expensive supported tier so the cap can only ever trip early.
 */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const price = SUPPORTED_MODELS[model] ?? mostExpensive();
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const searches = usage.webSearchRequests ?? 0;
  return (
    (input * price.inputPerMTok +
      cacheRead * price.inputPerMTok * CACHE_READ_MULTIPLIER +
      cacheWrite * price.inputPerMTok * CACHE_WRITE_MULTIPLIER +
      output * price.outputPerMTok) /
      1_000_000 +
    searches * WEB_SEARCH_USD_PER_REQUEST
  );
}

function mostExpensive(): ModelPricing {
  return Object.values(SUPPORTED_MODELS).reduce((worst, price) =>
    price.outputPerMTok > worst.outputPerMTok ? price : worst,
  );
}
