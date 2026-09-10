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
 * **`choices` is one model per provider, and that is deliberate.** It was two
 * — the thorough tier and the cheaper one — on the reasoning that the cheaper
 * one is "good at this". It is not good enough at *this*. Sonnet 5 repeatedly
 * submitted descriptors the tool handler had to bounce, and the run that did
 * finish named `custom` as an outlet's primary capability, which is the one
 * value that renders as no control at all — so the home paid for a run whose
 * result was a dead tile. A wrong mapping is worse than an expensive one in a
 * way that is easy to underestimate: the descriptor is cached per device
 * *model*, so it silently shapes every unit of that device this home ever
 * meets, until somebody notices and explicitly remaps. The cheaper tier saved
 * a few cents on a job that runs a handful of times in a hub's life and cost a
 * plug that looked broken. OpenAI's cheaper tier is retired on the same
 * reasoning rather than on its own evidence; re-add it as one line if it earns
 * a place.
 *
 * So the model stops being a decision and becomes a fact the apps *state*.
 * `PRICING` stays broad, for two reasons that outlive the choice: a stored
 * setting naming a retired model must not make a hub's settings route start
 * refusing, and `ai_runs.modelId` rows recorded months ago still have to price
 * correctly when a run log is read back.
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
    // Sol's $4/$20 is a **promotional** rate OpenAI put in place on 22 August
    // 2026 and has committed to only until 21 November; the standard price is
    // $5/$30. Re-check it after that date — a promo that quietly reverts leaves
    // every estimate a quarter low and the run cap tripping late, which is the
    // one direction `mostExpensive()` is written to avoid.
    'gpt-5.6-sol': { inputPerMTok: 4, outputPerMTok: 20 },
    // The bare alias, kept priced rather than dropped: it routes to Sol, and a
    // hub that already stored it must not be told its setting is invalid.
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
      {
        id: 'claude-opus-5',
        label: 'Opus 5',
        note: 'The most thorough. Every recognition run uses it.',
        recommended: true,
      },
    ],
  },
  // Mirrors Anthropic's: the thorough tier, alone, and as an **explicit tier
  // id, never the bare `gpt-5.6` alias**. The alias routes to Sol today and is
  // OpenAI's to re-point tomorrow, which would silently move which model a home
  // runs, what a run costs and what `ai_runs.modelId` recorded, with nothing
  // here changed to explain it. `claude-opus-5` is pinned for the same reason.
  openai: {
    default: 'gpt-5.6-sol',
    choices: [
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        note: 'The most thorough. Every recognition run uses it.',
        recommended: true,
      },
    ],
  },
};

/**
 * What an **agent** may run on, which is a different question from the
 * mapper's and gets a different answer.
 *
 * The mapper offers one model per provider on purpose: a descriptor is cached
 * against a device *model* and silently shapes every unit of it the home ever
 * meets, so a cheaper tier that is wrong once is wrong for ever, and the run
 * happens a handful of times in a hub's life. None of that is true of a chat.
 * A conversation is many small rounds, it is read the moment it is written,
 * and a reply somebody does not like is answered with another message — so
 * what a model costs per round is a real trade a home can make, and both
 * halves of it are visible.
 *
 * So an agent offers two and the picker means something. Opus 5 is the
 * default and the recommendation; Sonnet 5 is the same conversation at rather
 * less than half the price. Both are already in `PRICING`, so nothing about
 * cost estimation moves.
 *
 * Anthropic only, for the reason the automations agent is: only the Anthropic
 * loop is written.
 *
 * **One table for both agents, and two stored columns.** It was
 * `ASSISTANT_MODELS`, and the automations agent read `ai_model` — the
 * *mapper's* column — which meant the two questions "which model recognises a
 * device" and "which model writes a rule" shared an answer. It never showed,
 * because the mapper offers one model and Sonnet is not in its list, so
 * `effectiveModel` handed back Opus whatever was stored; the coupling was one
 * added choice away from surfacing. The ids are the same for both agents
 * because the argument for offering two is the same argument, and the notes
 * are written about the *model* rather than about either job — where they
 * differ per agent, the honest place for that is the app's own copy, not a
 * second table here waiting to drift.
 */
export const AGENT_MODELS: {
  readonly default: string;
  readonly choices: readonly ModelChoice[];
} = {
  default: 'claude-opus-5',
  choices: [
    {
      id: 'claude-opus-5',
      label: 'Opus 5',
      note: 'The most capable. Best at anything it has to work out.',
      recommended: true,
    },
    {
      id: 'claude-sonnet-5',
      label: 'Sonnet 5',
      note: 'Quicker, and less than half the price. Good for the straightforward.',
    },
  ],
};

/**
 * Which model an agent will actually run on.
 *
 * `effectiveModel`'s rule, and it exists separately for the same reason the
 * list does: a stored model counts only while it is still offered, or retiring
 * one leaves the homes that had chosen it as the only homes still running it,
 * silently, with nothing on a screen changed.
 *
 * **And the loop has to read this, not the column.** That is the one bug the
 * mapper paid a release for: every surface that *reported* a model went
 * through `effectiveModel` while the call that picked one to run read the
 * stored value, so a hub ran a model every screen said it was not running.
 * `test/ai-model-choice.test.ts` pins both halves, for both agents.
 */
export function effectiveAgentModel(stored: string | null | undefined): string {
  const offered = AGENT_MODELS.choices.some((choice) => choice.id === stored);
  return offered && stored ? stored : AGENT_MODELS.default;
}

/** The Anthropic default, kept flat because the agent has always read it so. */
export const DEFAULT_MODEL = PROVIDER_MODELS.anthropic.default;

export function defaultModelFor(provider: AiProvider): string {
  return PROVIDER_MODELS[provider].default;
}

/**
 * The model a run will actually use.
 *
 * A stored setting counts only while the model it names is still *offered*.
 * Retiring one otherwise leaves the homes that had chosen it as the only homes
 * still running it — precisely the homes the retirement is for. Silently, too:
 * nothing on any screen would have changed. So the stored value is read as a
 * preference among what is on offer rather than as an instruction, and a hub
 * that had picked Sonnet moves to Opus the next time it is asked, with no
 * migration and nothing for its owner to do.
 *
 * `GET /settings/ai` reports *this*, never the stored string, so an app never
 * draws a model the hub will not run.
 */
export function effectiveModel(provider: AiProvider, stored: string | null | undefined): string {
  const offered = PROVIDER_MODELS[provider].choices.some((choice) => choice.id === stored);
  return offered && stored ? stored : PROVIDER_MODELS[provider].default;
}

/**
 * What to *call* a model that has already run.
 *
 * **Read back, never re-derived.** `effectiveModel` above answers "what will
 * run", which is a question about the offered list and moves when that list
 * moves. This answers "what did run", which is a fact and must not: a
 * conversation from last month names the model it was actually billed for,
 * even after that model has been retired from `choices`.
 *
 * So the label comes from the offered list when the model is still on it, and
 * otherwise the id itself. A raw `claude-sonnet-5` on an old row is ugly and
 * true, which are the two properties that matter here — the alternative is a
 * second table of names for retired models, which is a list to keep in step
 * with nothing to keep it honest.
 *
 * **"The offered list" is every list this hub offers, not the mapper's**, and
 * reading it as the mapper's alone is a bug that shipped. There are two
 * vocabularies here — `PROVIDER_MODELS` for recognising a device and
 * `AGENT_MODELS` for a conversation — and Sonnet 5 is only on the second,
 * so every assistant chat that ran on it reported `claude-sonnet-5` where a
 * chat on Opus reported "Opus 5". The apps drew exactly that: a raw id at the
 * top of one conversation and a name at the top of the next, which reads as
 * the app failing to translate rather than as the hub naming two different
 * things. Both surfaces record into one `ai_runs` table and both ask this
 * question of it, so the answer has to cover the union.
 *
 * It is the hub's job rather than an app's for the reason the model *list* is:
 * the apps render what the hub tells them instead of shipping ids of their own.
 *
 * `provider` is a plain `string` rather than `AiProvider` on purpose: this is
 * fed by a recorded column, and a provider a later build retires is exactly
 * the case the lookup below has to survive.
 */
export function modelLabel(provider: string, model: string): string {
  return namedModels(provider).find((choice) => choice.id === model)?.label ?? model;
}

/**
 * Every model this hub has a name for, under the provider that would have run
 * it.
 *
 * The assistant's list is Anthropic-only — only that loop is written — so it
 * is named under that provider and nowhere else, which keeps the lookup a
 * statement about who ran what rather than a flat search of every id the hub
 * has ever heard of. A model on both lists is named once; the first match wins
 * and the two agree on the label, which is the only field read here.
 */
function namedModels(provider: string): readonly ModelChoice[] {
  const mapper = (
    PROVIDER_MODELS[provider as AiProvider] as (typeof PROVIDER_MODELS)[AiProvider] | undefined
  )?.choices;
  if (provider === 'anthropic') return [...(mapper ?? []), ...AGENT_MODELS.choices];
  return mapper ?? [];
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
