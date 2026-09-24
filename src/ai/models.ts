/**
 * Every model the hub has ever run, what each is called, what it costs, and
 * which one replaced it — plus the models it offers today.
 *
 * Four things make this load-bearing rather than a hint:
 *
 *  - **Tool availability.** The mapping agent researches devices with hosted
 *    search tools, and those have model floors: Anthropic's
 *    `web_search_20260209` / `web_fetch_20260209` exist only on Opus 4.6+ and
 *    Sonnet 4.6+. Pointing a setting at an older or smaller model does not
 *    degrade the run — the API rejects the request outright. Better to refuse a
 *    model we know cannot work than to arm a backoff gate over a 400.
 *  - **The budget caps are computed here.** Neither API reports what a run cost,
 *    so the hub adds up its own token usage, which means it needs the price of
 *    the model it is running — and the caps themselves stretch for a model
 *    priced above the one they were set against (`budgetScale`).
 *  - **The apps draw the picker from `choices`.** Model ids and their tiers
 *    move; an app that shipped its own list would offer a model this hub
 *    refuses, or miss one it accepts. Same rule as `GET /permissions`: the hub
 *    owns the vocabulary, the apps render it.
 *  - **A retired model is *succeeded*, not forgotten.** A home that chose one
 *    is moved to the model that replaced it — see "Succession" below.
 *
 * **`MODELS` is one row per model, and every row carries three facts: its
 * price, its name and its successor.** Those used to be three different things.
 * The price lived in a broad `PRICING` map, kept broad for two reasons that
 * still hold (a stored setting naming a retired model must not make the
 * settings route start refusing, and `ai_runs` rows recorded months ago still
 * name what they ran on). The *name* lived only in the offered lists, so the
 * moment a model was retired every conversation that had run on it lost its
 * label and an app drew a raw `claude-sonnet-5` over a chat where the one next
 * to it said "Opus 5". That was defended once as "ugly and true", against a
 * second table of names nothing kept honest — and the answer to that objection
 * is not a second table but a column on the first: a label beside a price is
 * kept in step by construction, because there is one row to edit. A new model
 * is one row; retiring one is taking it off an offered list and writing its
 * successor into its row. **Never delete a row**: it is what old records are
 * read against, and what an old setting is succeeded from.
 *
 * **Succession.** A stored choice counts only while the model it names is still
 * *offered*; otherwise the hub runs the first model along its successor chain
 * that is — Opus 5 → Opus 5.5, GPT-5.6 Sol and Terra → GPT-6 Sol — and only
 * where there is no such model, the vendor's default. Three rules.
 *  - **It is resolved when settings are read, never written back.** Updating a
 *    hub is therefore all it takes to move every home on a retired model, with
 *    no migration and nothing for its owner to do — and it is also the only
 *    version that is safe to roll back. `install.sh` puts the previous build
 *    back when a new one fails its health check, and that build has never heard
 *    of `gpt-6-sol`: an agent column rewritten at boot would be an unknown id
 *    there, which falls to "the first vendor with a usable key" and silently
 *    moves a home that had chosen OpenAI onto Anthropic. Left alone, the column
 *    still says what it said and the older build reads it exactly as before.
 *  - **A successor is always the same vendor's.** The vendor was a real choice
 *    somebody made — they pasted that vendor's key — and the retired id was
 *    not; succession changes the model and never whose key pays for it.
 *  - **A row names the model that replaced *it*, not the newest one.** Opus 4.8
 *    points at Opus 5, which points at Opus 5.5; the walk follows the chain. So
 *    retiring a model is an edit to its own row only, and nothing already
 *    written has to be revisited.
 *
 * Prices are list prices in USD per million tokens, from each vendor's model
 * pages (checked 23 September 2026). They move rarely, and the caps they feed
 * are a safety rail rather than an invoice — `status.lastRun.costUsd` is an
 * estimate and says so.
 */

import type { AiProvider } from '../core/settings.js';

export interface ModelPricing {
  /** USD per million input tokens. */
  readonly inputPerMTok: number;
  /** USD per million output tokens (thinking included — it is billed as output). */
  readonly outputPerMTok: number;
  /**
   * What a cached read costs, as a fraction of the input rate, where this model
   * is billed differently from the usual tenth. Opus 5.5 reads at a twentieth,
   * and pricing it at a tenth would overstate every long conversation on it.
   */
  readonly cacheReadMultiplier?: number;
  /** The same for a cache write, where it differs from the usual 1.25×. */
  readonly cacheWriteMultiplier?: number;
}

/** One entry in the picker an app draws. The hub owns the wording. */
export interface ModelChoice {
  readonly id: string;
  /** What a person sees — "Opus 5.5", not `claude-opus-5-5`. */
  readonly label: string;
  /**
   * One line under it, phrased as a definition rather than a promise — and
   * written to be read **beside the other vendor's models**, because the apps
   * draw one list across both vendors: "the most capable" alone would say the
   * same thing about two models in one menu.
   */
  readonly note: string;
  /** Exactly one choice per provider carries this. */
  readonly recommended?: boolean;
}

/** Everything the hub knows about one model, offered or not. */
interface KnownModel {
  readonly label: string;
  readonly price: ModelPricing;
  /**
   * What a stored choice of this model runs on once it is no longer offered —
   * the same vendor's, always. Absent on a model that is still current.
   */
  readonly successor?: string;
}

/**
 * Every model the hub has ever run or accepted, per vendor.
 *
 * Device adaptation is a reasoning-heavy job that runs a handful of times in a
 * hub's life, and a conversation is many small rounds — so what is *offered*
 * is decided below, per surface, while this table only has to know the model.
 */
const MODELS: Readonly<Record<AiProvider, Readonly<Record<string, KnownModel>>>> = {
  anthropic: {
    'claude-opus-5-5': {
      label: 'Opus 5.5',
      // A twentieth of the input rate for a cached read, where every model
      // before it billed a tenth.
      price: { inputPerMTok: 4, outputPerMTok: 20, cacheReadMultiplier: 0.05 },
    },
    'claude-opus-5': {
      label: 'Opus 5',
      price: { inputPerMTok: 5, outputPerMTok: 25 },
      successor: 'claude-opus-5-5',
    },
    'claude-opus-4-8': {
      label: 'Opus 4.8',
      price: { inputPerMTok: 5, outputPerMTok: 25 },
      successor: 'claude-opus-5',
    },
    'claude-opus-4-7': {
      label: 'Opus 4.7',
      price: { inputPerMTok: 5, outputPerMTok: 25 },
      successor: 'claude-opus-4-8',
    },
    'claude-opus-4-6': {
      label: 'Opus 4.6',
      price: { inputPerMTok: 5, outputPerMTok: 25 },
      successor: 'claude-opus-4-7',
    },
    'claude-sonnet-5': { label: 'Sonnet 5', price: { inputPerMTok: 2, outputPerMTok: 10 } },
    'claude-sonnet-4-6': {
      label: 'Sonnet 4.6',
      price: { inputPerMTok: 3, outputPerMTok: 15 },
      successor: 'claude-sonnet-5',
    },
  },
  openai: {
    'gpt-6-astra': { label: 'GPT-6 Astra', price: { inputPerMTok: 10, outputPerMTok: 50 } },
    'gpt-6-sol': { label: 'GPT-6 Sol', price: { inputPerMTok: 2, outputPerMTok: 10 } },
    'gpt-6-luna': { label: 'GPT-6 Luna', price: { inputPerMTok: 0.1, outputPerMTok: 0.5 } },
    // GPT-5.6 was Sol, Terra and Luna; GPT-6 is Astra, Sol and Luna. There is
    // no GPT-6 Terra, and GPT-6 Sol is both cheaper than 5.6 Terra ($2/$12) and
    // stronger than 5.6 Sol — so both of the tiers this hub offered move to it.
    // Sol's $4/$20 was a promotional rate (standard $5/$30); it is kept as the
    // price the rows recorded on it were estimated at.
    'gpt-5.6-sol': {
      label: 'GPT-5.6 Sol',
      price: { inputPerMTok: 4, outputPerMTok: 20 },
      successor: 'gpt-6-sol',
    },
    // The bare alias routed to Sol. Never offered — an alias is OpenAI's to
    // re-point, which would move what a home runs with nothing here changed —
    // but a hub that stored it must not be told its setting is invalid.
    'gpt-5.6': {
      label: 'GPT-5.6',
      price: { inputPerMTok: 4, outputPerMTok: 20 },
      successor: 'gpt-6-sol',
    },
    'gpt-5.6-terra': {
      label: 'GPT-5.6 Terra',
      price: { inputPerMTok: 2, outputPerMTok: 12 },
      successor: 'gpt-6-sol',
    },
  },
};

/**
 * A model on offer, named by the table rather than by the call site, so a label
 * lives in exactly one place. Throws at module load for an id the table has
 * never heard of, which is a typo no test could otherwise miss for long.
 */
function offer(provider: AiProvider, id: string, note: string, recommended = false): ModelChoice {
  const known = knownModel(provider, id);
  if (known === undefined) throw new Error(`models: ${provider} offers ${id}, which MODELS does not know`);
  return { id, label: known.label, note, ...(recommended ? { recommended: true } : {}) };
}

function knownModel(provider: AiProvider, id: string): KnownModel | undefined {
  return Object.hasOwn(MODELS[provider], id) ? MODELS[provider][id] : undefined;
}

/**
 * What recognises a device, per vendor.
 *
 * **Strong models only — the list never offers a tier cheaper than its
 * default.** It was one model per provider, because the cheaper tier had been
 * tried: Sonnet 5 repeatedly submitted descriptors the tool handler had to
 * bounce, and the run that did finish named `custom` as an outlet's primary
 * capability, which is the one value that renders as no control at all — so the
 * home paid for a run whose result was a dead tile. A wrong mapping is worse
 * than an expensive one in a way that is easy to underestimate: the descriptor
 * is cached per device *model*, so it silently shapes every unit of that device
 * this home ever meets, until somebody notices and explicitly remaps. That
 * argument is about *cheaper* models, and it is the invariant the tests keep;
 * a *more* thorough one costs more on a job that runs a handful of times in a
 * hub's life, which is a choice a home can make. So OpenAI offers two — Sol by
 * default, and Astra above it — and Sonnet and Luna are on neither list.
 *
 * Each named by an **explicit** id, never an alias: an alias is the vendor's to
 * re-point tomorrow, which would silently move which model a home runs, what a
 * run costs and what `ai_runs.modelId` recorded.
 */
export const PROVIDER_MODELS: Readonly<
  Record<AiProvider, { readonly default: string; readonly choices: readonly ModelChoice[] }>
> = {
  anthropic: {
    default: 'claude-opus-5-5',
    choices: [
      offer('anthropic', 'claude-opus-5-5', 'Anthropic’s most thorough model.', true),
    ],
  },
  openai: {
    default: 'gpt-6-sol',
    choices: [
      offer('openai', 'gpt-6-astra', 'OpenAI’s most thorough, at five times Sol’s price.'),
      offer('openai', 'gpt-6-sol', 'Thorough, at a fifth of Astra’s price.', true),
    ],
  },
};

/**
 * What an **agent** may run on, which is a different question from the
 * mapper's and gets a different answer.
 *
 * None of the mapper's argument holds for a chat. A conversation is many small
 * rounds, it is read the moment it is written, and a reply somebody does not
 * like is answered with another message — so what a model costs per round is a
 * real trade a home can make, and both halves of it are visible. So the cheaper
 * tiers are offered here: Sonnet 5 at half Opus 5.5's price, and GPT-6 Luna at
 * a twentieth of Sol's.
 *
 * **One table for both agents, and two stored columns.** It was
 * `ASSISTANT_MODELS`, and the automations agent read `ai_model` — the
 * *mapper's* column — which meant the two questions "which model recognises a
 * device" and "which model writes a rule" shared an answer. The ids are the
 * same for both agents because the argument for offering them is the same
 * argument, and the notes are written about the *model* rather than about
 * either job — where they differ per agent, the honest place for that is the
 * app's own copy, not a second table here waiting to drift.
 */
export const AGENT_MODELS: Readonly<
  Record<AiProvider, { readonly default: string; readonly choices: readonly ModelChoice[] }>
> = {
  anthropic: {
    default: 'claude-opus-5-5',
    choices: [
      offer('anthropic', 'claude-opus-5-5', 'The most capable Claude. Best when it has to work things out.', true),
      offer('anthropic', 'claude-sonnet-5', 'Quicker, and half the price of Opus 5.5.'),
    ],
  },
  openai: {
    default: 'gpt-6-sol',
    choices: [
      offer('openai', 'gpt-6-astra', 'OpenAI’s most capable, at five times Sol’s price.'),
      offer('openai', 'gpt-6-sol', 'Nearly as capable as Astra, at a fifth of the price.', true),
      offer('openai', 'gpt-6-luna', 'The quickest and cheapest. Fine for simple requests.'),
    ],
  },
};

/**
 * The first model along `stored`'s succession chain that `choices` offers, or
 * `null` when the chain runs out first — an id this vendor never had, or one
 * whose successors are all off this list (Sonnet 4.6 → Sonnet 5, which only
 * the agents offer).
 *
 * Bounded, so a row edited into a cycle ends the walk rather than the process.
 */
function onOffer(
  provider: AiProvider,
  stored: string | null | undefined,
  choices: readonly ModelChoice[],
): string | null {
  let id = typeof stored === 'string' ? stored : undefined;
  for (let hop = 0; id !== undefined && hop <= MAX_SUCCESSION_HOPS; hop += 1) {
    const current = id;
    if (choices.some((choice) => choice.id === current)) return current;
    id = knownModel(provider, current)?.successor;
  }
  return null;
}

const MAX_SUCCESSION_HOPS = 8;

/**
 * Which provider a model id belongs to, among the ones an agent is offered.
 *
 * **The provider follows the model, and there is no second stored column.**
 * Ids do not collide across vendors (`claude-…` against `gpt-…`) — `priceOf`
 * below has relied on that since the mapper had two providers — so a caller
 * holding a model never has to be told which vendor it came from, and an app's
 * vendor picker is a control that writes that vendor's model id rather than a
 * second setting that can disagree with the first.
 *
 * `null` for an id no agent list offers, which is a real answer: a hand-edited
 * column, or a model retired between builds.
 */
export function agentProviderOf(modelId: string | null | undefined): AiProvider | null {
  if (typeof modelId !== 'string') return null;
  for (const provider of Object.keys(AGENT_MODELS) as AiProvider[]) {
    if (AGENT_MODELS[provider].choices.some((choice) => choice.id === modelId)) return provider;
  }
  return null;
}

/** Which providers an agent could actually authenticate as, right now. */
export interface UsableProviders {
  anthropic: boolean;
  openai: boolean;
}

/**
 * Which model an agent will actually run on, and on whose key.
 *
 * `effectiveModel`'s rule with a second half, and it exists separately for the
 * same reason the list does.
 *
 * **The vendor is the stored model's, while its key is usable.** A retired id
 * keeps its vendor through `MODELS` — the vendor was a real choice somebody
 * made and the retired id was not — and the model it runs is the first along
 * its succession chain that is still offered, or that vendor's default.
 *
 * **The key is the half without which the setting is a trap.** A home that has
 * only ever had an OpenAI key still has `claude-opus-5-5` stored — it is the
 * default, and nobody chose it — so resolving on the offered list alone would
 * point every conversation at a vendor the hub cannot authenticate to, and
 * answer `ai_not_configured` on a home that is configured. So a stored choice
 * counts while its vendor is *usable*, and otherwise the hub falls back to the
 * vendor that is, at that vendor's own default.
 *
 * **And the loop has to read this, not the column.** That is the one bug the
 * mapper paid a release for: every surface that *reported* a model went
 * through `effectiveModel` while the call that picked one to run read the
 * stored value, so a hub ran a model every screen said it was not running.
 * `test/ai-model-choice.test.ts` pins both halves, for both agents.
 *
 * Answers `null` when neither provider can authenticate — the caller refuses
 * with `ai_not_configured`, which is the only honest thing left to say.
 */
export function effectiveAgentModel(
  stored: string | null | undefined,
  usable: UsableProviders,
): { provider: AiProvider; modelId: string } | null {
  const vendor = knownProviderOf(stored);
  if (vendor !== null && usable[vendor]) {
    return {
      provider: vendor,
      modelId: onOffer(vendor, stored, AGENT_MODELS[vendor].choices) ?? AGENT_MODELS[vendor].default,
    };
  }
  for (const provider of ['anthropic', 'openai'] as const) {
    if (usable[provider]) {
      return { provider, modelId: AGENT_MODELS[provider].default };
    }
  }
  return null;
}

/** Which provider has ever billed for this id, offered or retired. */
function knownProviderOf(modelId: string | null | undefined): AiProvider | null {
  if (typeof modelId !== 'string') return null;
  for (const provider of Object.keys(MODELS) as AiProvider[]) {
    if (Object.hasOwn(MODELS[provider], modelId)) return provider;
  }
  return null;
}

/** The Anthropic default, kept flat because the agent has always read it so. */
export const DEFAULT_MODEL = PROVIDER_MODELS.anthropic.default;

export function defaultModelFor(provider: AiProvider): string {
  return PROVIDER_MODELS[provider].default;
}

/**
 * The model a recognition run will actually use.
 *
 * A stored setting counts only while the model it names is still *offered*;
 * otherwise the run is given the first model along its succession chain that
 * is, and where there is none — a model this vendor's recognition list has
 * never offered anything after, like Sonnet — the vendor's default. Retiring a
 * model otherwise leaves the homes that had chosen it as the only homes still
 * running it — precisely the homes the retirement is for. Silently, too:
 * nothing on any screen would have changed.
 *
 * `GET /settings/ai` reports *this*, never the stored string, so an app never
 * draws a model the hub will not run.
 */
export function effectiveModel(provider: AiProvider, stored: string | null | undefined): string {
  return onOffer(provider, stored, PROVIDER_MODELS[provider].choices) ?? PROVIDER_MODELS[provider].default;
}

/**
 * The ids a recognition run may be set to, for the sentence a refused write
 * answers with. The offered list rather than every id `isSupportedModel`
 * accepts: a write naming a retired model is taken and succeeded, so listing
 * it as something recognition "runs on" would be false.
 */
export function offeredModelIds(provider: AiProvider): string[] {
  return PROVIDER_MODELS[provider].choices.map((choice) => choice.id);
}

/**
 * What to *call* a model that has already run.
 *
 * **Read back, never re-derived.** `effectiveModel` above answers "what will
 * run", which is a question about the offered list and moves when that list
 * moves. This answers "what did run", which is a fact and must not: a
 * conversation from last month names the model it was actually billed for,
 * even after that model has been retired and succeeded.
 *
 * So the label is the model's own row in `MODELS` — which every model this hub
 * has ever run keeps for exactly this — and a raw id only for one this build
 * has never heard of. It is asked **per provider**, because the label says who
 * ran what rather than merely whether the hub has ever heard of the id.
 *
 * It is the hub's job rather than an app's for the reason the model *list* is:
 * the apps render what the hub tells them instead of shipping names of their
 * own.
 *
 * `provider` is a plain `string` rather than `AiProvider` on purpose: this is
 * fed by a recorded column, and a provider a later build retires is exactly
 * the case the lookup below has to survive.
 */
export function modelLabel(provider: string, model: string): string {
  const known = provider === 'anthropic' || provider === 'openai' ? knownModel(provider, model) : undefined;
  return known?.label ?? model;
}

/** Server-side web search, billed per request rather than per token. */
export const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000;

/**
 * Cache reads bill at ~0.1x the input rate on both providers, and cache writes
 * at ~1.25x. The hub caches its (large, static) system prompt, so counting
 * reads at the full input rate would overstate a run's cost several times over.
 * A model billed differently says so on its own row (`ModelPricing`).
 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Whether the hub will take this id at all — every model it has ever known,
 * offered or retired. A stored setting must never start 400-ing because a
 * build retired what it names; succession decides what actually runs.
 */
export function isSupportedModel(model: string, provider: AiProvider = 'anthropic'): boolean {
  return Object.hasOwn(MODELS[provider], model);
}

export function supportedModelIds(provider: AiProvider = 'anthropic'): string[] {
  return Object.keys(MODELS[provider]);
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
 * Estimate what a run has cost so far. Used for the budget caps and for
 * `status.lastRun.costUsd`; an unknown model falls back to the most expensive
 * known tier so a cap can only ever trip early.
 */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const price = priceOf(model);
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const searches = usage.webSearchRequests ?? 0;
  const readMultiplier = price.cacheReadMultiplier ?? CACHE_READ_MULTIPLIER;
  const writeMultiplier = price.cacheWriteMultiplier ?? CACHE_WRITE_MULTIPLIER;
  return (
    (input * price.inputPerMTok +
      cacheRead * price.inputPerMTok * readMultiplier +
      cacheWrite * price.inputPerMTok * writeMultiplier +
      output * price.outputPerMTok) /
      1_000_000 +
    searches * WEB_SEARCH_USD_PER_REQUEST
  );
}

/**
 * How far a spend cap stretches for the model a run is on.
 *
 * **The caps bound work, and they were set in dollars against one price.**
 * Every cap here — a recognition run's, an assistant conversation's, an
 * automations conversation's — was sized against Opus 5 at $5/$25, as "a run
 * that has spent this much has gone wrong". A model priced above that buys less
 * work for the same money, so on GPT-6 Astra ($10/$50) a fixed cap would stop a
 * perfectly healthy run at half the work it allows everywhere else, and a paid
 * run would end unfinished — somebody would have chosen the most thorough model
 * and got the least done. So the cap scales with the price, by whichever of the
 * two rates is further above the reference, and never below 1: a cheaper model
 * gets the same dollar ceiling rather than a tighter one, because a cap is a
 * safety rail on spend and not a quota to be used up.
 */
export function budgetScale(model: string): number {
  const price = priceOf(model);
  return Math.max(
    1,
    price.inputPerMTok / CAPS_PRICED_AT.inputPerMTok,
    price.outputPerMTok / CAPS_PRICED_AT.outputPerMTok,
  );
}

/** Opus 5's list price — what every dollar cap in `src/ai/` was sized against. */
const CAPS_PRICED_AT: ModelPricing = { inputPerMTok: 5, outputPerMTok: 25 };

/**
 * Model ids do not collide across providers (`claude-…` against `gpt-…`), so a
 * caller that has a model in hand never has to say which provider it came from.
 */
function priceOf(model: string): ModelPricing {
  for (const provider of Object.keys(MODELS) as AiProvider[]) {
    const known = knownModel(provider, model);
    if (known) return known.price;
  }
  return mostExpensive();
}

function mostExpensive(): ModelPricing {
  return Object.values(MODELS)
    .flatMap((provider) => Object.values(provider))
    .map((known) => known.price)
    .reduce((worst, price) => (price.outputPerMTok > worst.outputPerMTok ? price : worst));
}
