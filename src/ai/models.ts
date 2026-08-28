/**
 * The models the mapping agent may run on, what each is called, and what a run
 * costs.
 *
 * This is an allowlist, not a hint. Three things make it load-bearing:
 *
 *  - **Tool availability.** The agent researches devices with hosted search
 *    tools, and those have model floors: Anthropic's `web_search_20260209` /
 *    `web_fetch_20260209` exist only on Opus 4.6+ and Sonnet 4.6+. Pointing a
 *    model setting at an older or smaller model does not degrade the run — the
 *    API rejects the request outright. Better to refuse a model we know cannot
 *    work than to arm a backoff gate over a 400.
 *  - **The budget cap is computed here.** Neither API reports what a run cost,
 *    so the hub adds up its own token usage, which means it needs the price of
 *    the model it is running.
 *  - **The apps draw the picker from `choices`.** Model ids and their tiers
 *    move; an app that shipped its own list would offer a model this hub
 *    refuses, or miss one it accepts. Same rule as `GET /permissions`: the hub
 *    owns the vocabulary, the apps render it.
 *
 * `choices` is deliberately shorter than the allowlist. Two options — the
 * thorough one and the cheaper one — is the whole decision worth asking
 * somebody to make; the rest of the allowlist exists so a hub already set to an
 * older model keeps working rather than being told its setting is invalid.
 *
 * Prices are list prices in USD per million tokens, from each vendor's public
 * pricing. They move rarely, and the cap they feed is a safety rail rather than
 * an invoice — `status.lastRun.costUsd` is an estimate and says so.
 */

import type { AiProvider } from '../core/settings.js';

export interface ModelPricing {
  /** USD per million input tokens. */
  readonly inputPerMTok: number;
  /** USD per million output tokens (thinking included — it is billed as output). */
  readonly outputPerMTok: number;
}

/** One entry in the picker an app draws. The hub owns the wording. */
export interface ModelChoice {
  readonly id: string;
  /** What a person sees — "Opus 5", not `claude-opus-5`. */
  readonly label: string;
  /** One line under it, phrased as a definition rather than a promise. */
  readonly note: string;
  /** Exactly one choice per provider carries this. */
  readonly recommended?: boolean;
}

/**
 * Every model the hub will run the mapping agent on, with its price. Device
 * adaptation is a reasoning-heavy job that runs a handful of times in a hub's
 * life, so the list is the models that are good at it and can drive the
 * research tools.
 */
const PRICING: Readonly<Record<AiProvider, Readonly<Record<string, ModelPricing>>>> = {
  anthropic: {
    'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
    'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  },
  openai: {
    'gpt-5.6': { inputPerMTok: 4, outputPerMTok: 20 },
    'gpt-5.6-terra': { inputPerMTok: 2, outputPerMTok: 12 },
  },
};

/**
 * What each provider offers and what it falls back to.
 *
 * The defaults are the thorough tier on both, because a wrong mapping is worse
 * than an expensive one: the descriptor is cached per device model and silently
 * shapes what the apps show for that device until somebody explicitly remaps it.
 */
export const PROVIDER_MODELS: Readonly<
  Record<AiProvider, { readonly default: string; readonly choices: readonly ModelChoice[] }>
> = {
  anthropic: {
    default: 'claude-opus-5',
    choices: [
      { id: 'claude-opus-5', label: 'Opus 5', note: 'The most thorough. Recommended.', recommended: true },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'Cheaper per run, and good at this.' },
    ],
  },
  openai: {
    default: 'gpt-5.6',
    choices: [
      { id: 'gpt-5.6', label: 'GPT-5.6', note: 'The most thorough. Recommended.', recommended: true },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'Cheaper per run, and good at this.' },
    ],
  },
};

/** The Anthropic default, kept flat because the agent has always read it so. */
export const DEFAULT_MODEL = PROVIDER_MODELS.anthropic.default;

export function defaultModelFor(provider: AiProvider): string {
  return PROVIDER_MODELS[provider].default;
}

/** Server-side web search, billed per request rather than per token. */
export const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000;

/**
 * Cache reads bill at ~0.1x the input rate on both providers, and Anthropic's
 * cache writes at ~1.25x. The hub caches its (large, static) system prompt, so
 * counting reads at the full input rate would overstate a run's cost several
 * times over.
 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function isSupportedModel(model: string, provider: AiProvider = 'anthropic'): boolean {
  return Object.hasOwn(PRICING[provider], model);
}

export function supportedModelIds(provider: AiProvider = 'anthropic'): string[] {
  return Object.keys(PRICING[provider]);
}

/** Token counts as the two APIs report them, all fields optional. */
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
  const price = priceOf(model);
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

/**
 * Model ids do not collide across providers (`claude-…` against `gpt-…`), so a
 * caller that has a model in hand never has to say which provider it came from.
 */
function priceOf(model: string): ModelPricing {
  for (const provider of Object.values(PRICING)) {
    const price = provider[model];
    if (price) return price;
  }
  return mostExpensive();
}

function mostExpensive(): ModelPricing {
  return Object.values(PRICING)
    .flatMap((provider) => Object.values(provider))
    .reduce((worst, price) => (price.outputPerMTok > worst.outputPerMTok ? price : worst));
}
