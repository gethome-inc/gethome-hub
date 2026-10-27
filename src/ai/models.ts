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
 * that is — Opus 5 → Opus 5.5, Sonnet 5 → Sonnet 5.5, GPT-5.6 Sol → GPT-6 Sol
 * → GPT-6.1 Sol, GPT-5.6 Terra → GPT-6.1 Terra — and only where there is no
 * such model, the vendor's default. Four rules.
 *  - **It is resolved when settings are read, never written back.** Updating a
 *    hub is therefore all it takes to move every home on a retired model, with
 *    no migration and nothing for its owner to do — and it is also the only
 *    version that is safe to roll back. `install.sh` puts the previous build
 *    back when a new one fails its health check, and that build has never heard
 *    of `gpt-6.1-sol`: an agent column rewritten at boot would be an unknown id
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
 *  - **A tier keeps its tier.** The model that replaced a Sonnet is the next
 *    Sonnet, and a Terra's the next Terra, because somebody who chose the
 *    quicker, cheaper rung chose the rung. Only while a vendor has nothing on
 *    that rung does its row point at the nearest one — GPT-5.6 Terra went to
 *    GPT-6 Sol while GPT-6 had no Terra — and the row moves back the day the
 *    rung does.
 *
 * Prices are list prices in USD per million tokens, from each vendor's model
 * pages (checked 9 October 2026). They move rarely, and the caps they feed are
 * a safety rail rather than an invoice — `status.lastRun.costUsd` is an
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
   * is billed differently from the usual tenth. Opus 5.5, Sonnet 5.5, GPT-6.1
   * Sol and GPT-6.1 Terra read at a twentieth and Fable 5.1 at a fortieth, and
   * pricing them at a tenth would overstate every long conversation on them.
   */
  readonly cacheReadMultiplier?: number;
  /** The same for a cache write, where it differs from the usual 1.25×. */
  readonly cacheWriteMultiplier?: number;
  /**
   * Dearer rates for a request whose prompt runs past `aboveTokens` — input,
   * cache reads and cache writes all counted, since that is what the vendors
   * count. They apply to the **whole request**, not to the tokens past the
   * line: GPT-6 bills such a request at 2× its input and cache rates and 1.5×
   * its output, and Haiku 5.5 at 5× all of them.
   *
   * That is why `estimateCostUsd` is given one request at a time, never a
   * conversation's running total: ten rounds of a 20K-token prompt are not a
   * 200K-token prompt, and pricing them as one would bill a Haiku conversation
   * at five times what it cost from its fifth round on.
   */
  readonly longPrompt?: {
    readonly aboveTokens: number;
    /** Applied to the input rate, and so to both cache rates with it. */
    readonly inputMultiplier: number;
    readonly outputMultiplier: number;
  };
}

/** GPT-6's long-context rates, which every model in that family shares. */
const GPT_6_LONG_PROMPT = { aboveTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 } as const;

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
  /**
   * The model reads a photo sent with a chat message.
   *
   * **Additive, and a fact about the model rather than a promise about the
   * route**: an app asks it before offering to attach a picture to a chat on
   * this model, rather than shipping its own list of which models can see. True
   * for every model offered to the agents today; a later one that cannot will
   * simply not carry it, and an app treats absent as "no".
   */
  readonly images?: boolean;
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
  /** It reads images. Written on the row, beside the price, because it is the
   *  same kind of fact — what the vendor's model is, not what a surface offers. */
  readonly images?: boolean;
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
    // GPT-6 Astra's price, with a cached read at a fortieth ($0.25). It refuses
    // a forced `tool_choice` — which no loop here sends — and, like Opus 5.5,
    // `temperature` and a prefilled reply, and it binds each thinking block to
    // everything ahead of it, so a conversation may only ever be appended to,
    // which every loop here already does. It can also decline with
    // `stop_reason: 'refusal'`, which both loops already report.
    // Anthropic keeps its requests for 30 days with no zero-retention option,
    // which are the ordinary terms for an API key. Mythos 5.1, the same model
    // for verified organisations only, is never offered: a home's key would be
    // refused.
    'claude-fable-5-1': {
      label: 'Fable 5.1',
      price: { inputPerMTok: 10, outputPerMTok: 50, cacheReadMultiplier: 0.025 },
      images: true,
    },
    'claude-opus-5-5': {
      label: 'Opus 5.5',
      // A twentieth of the input rate for a cached read, where every model
      // before it billed a tenth.
      price: { inputPerMTok: 4, outputPerMTok: 20, cacheReadMultiplier: 0.05 },
      images: true,
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
    // Sonnet 5's price, with Opus 5.5's twentieth for a cached read: $0.10,
    // where Sonnet 5 reads at the usual tenth ($0.20).
    'claude-sonnet-5-5': {
      label: 'Sonnet 5.5',
      price: { inputPerMTok: 2, outputPerMTok: 10, cacheReadMultiplier: 0.05 },
      images: true,
    },
    'claude-sonnet-5': {
      label: 'Sonnet 5',
      price: { inputPerMTok: 2, outputPerMTok: 10 },
      successor: 'claude-sonnet-5-5',
    },
    'claude-sonnet-4-6': {
      label: 'Sonnet 4.6',
      price: { inputPerMTok: 3, outputPerMTok: 15 },
      successor: 'claude-sonnet-5',
    },
    // The one Claude priced by prompt length: $0.10/$0.50 up to 100K tokens of
    // prompt, and five times that — cache rates included — past it. Offered to
    // the agents only, and safe to give their tools: it takes adaptive thinking
    // with `display: 'summarized'` and every effort they send.
    'claude-haiku-5-5': {
      label: 'Haiku 5.5',
      price: {
        inputPerMTok: 0.1,
        outputPerMTok: 0.5,
        longPrompt: { aboveTokens: 100_000, inputMultiplier: 5, outputMultiplier: 5 },
      },
      images: true,
    },
  },
  openai: {
    'gpt-6-astra': {
      label: 'GPT-6 Astra',
      price: { inputPerMTok: 10, outputPerMTok: 50, longPrompt: GPT_6_LONG_PROMPT },
      images: true,
    },
    // GPT-6 Sol's price, with a cached read at a twentieth ($0.10) where GPT-6
    // Sol reads at the usual tenth. It takes the same requests: the Responses
    // API with hosted web search and function tools, and `reasoning.effort`
    // low, medium and high — it refuses only `none` and `minimal`, which
    // nothing here sends.
    'gpt-6.1-sol': {
      label: 'GPT-6.1 Sol',
      price: { inputPerMTok: 2, outputPerMTok: 10, cacheReadMultiplier: 0.05, longPrompt: GPT_6_LONG_PROMPT },
      images: true,
    },
    // Half GPT-6.1 Sol's price, with the same twentieth for a cached read
    // ($0.05), and OpenAI's quicker tier — about three times Sol's speed, by
    // OpenAI's own figures. It takes what Sol takes: the Responses API with
    // function tools, images, and `reasoning.effort` low, medium and high (it
    // accepts `none` as well, which nothing here sends). Offered to the agents
    // only, as Sonnet 5.5 is: recognition never offers a tier cheaper than its
    // default.
    'gpt-6.1-terra': {
      label: 'GPT-6.1 Terra',
      price: { inputPerMTok: 1, outputPerMTok: 5, cacheReadMultiplier: 0.05, longPrompt: GPT_6_LONG_PROMPT },
      images: true,
    },
    // Still served, and replaced in the picker the way Opus 5 was: GPT-6.1 Sol
    // is the same price and stronger, so nothing a home chose is lost by moving.
    'gpt-6-sol': {
      label: 'GPT-6 Sol',
      price: { inputPerMTok: 2, outputPerMTok: 10, longPrompt: GPT_6_LONG_PROMPT },
      successor: 'gpt-6.1-sol',
    },
    'gpt-6-luna': {
      label: 'GPT-6 Luna',
      price: { inputPerMTok: 0.1, outputPerMTok: 0.5, longPrompt: GPT_6_LONG_PROMPT },
      images: true,
    },
    // GPT-5.6 was Sol, Terra and Luna; GPT-6 was Astra, Sol and Luna, with no
    // Terra, and GPT-6 Sol was both cheaper than 5.6 Terra ($2/$12) and
    // stronger than 5.6 Sol — so both of the tiers this hub offered moved to
    // it. Sol's $4/$20 was a promotional rate (standard $5/$30); it is kept as
    // the price the rows recorded on it were estimated at.
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
    // Back on its own tier now that the tier is back: GPT-6.1 Terra is the
    // Terra after it, the way Sonnet 4.6 walks to Sonnet 5.5 and never to Opus.
    // It went to GPT-6 Sol while GPT-6 had no Terra. Recognition offers no
    // Terra, so a recognition setting naming it walks off the end of the chain
    // and runs that list's default, GPT-6.1 Sol — where it already ran.
    'gpt-5.6-terra': {
      label: 'GPT-5.6 Terra',
      price: { inputPerMTok: 2, outputPerMTok: 12 },
      successor: 'gpt-6.1-terra',
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
  return {
    id,
    label: known.label,
    note,
    ...(recommended ? { recommended: true } : {}),
    ...(known.images === true ? { images: true } : {}),
  };
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
 * hub's life, which is a choice a home can make. So each vendor offers two —
 * Opus 5.5 by default with Fable 5.1 above it, GPT-6.1 Sol by default with
 * Astra above it — and Sonnet, Haiku and Luna are on neither list.
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
      offer('anthropic', 'claude-fable-5-1', 'Anthropic’s most thorough, at two and a half times Opus’s price.'),
      offer('anthropic', 'claude-opus-5-5', 'Thorough, at two fifths of Fable’s price.', true),
    ],
  },
  openai: {
    default: 'gpt-6.1-sol',
    choices: [
      offer('openai', 'gpt-6-astra', 'OpenAI’s most thorough, at five times Sol’s price.'),
      offer('openai', 'gpt-6.1-sol', 'Thorough, at a fifth of Astra’s price.', true),
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
 * tiers are offered here: Sonnet 5.5 at half Opus 5.5's price and Haiku 5.5 at
 * a fortieth of it, GPT-6.1 Terra at half Sol's and GPT-6 Luna at a twentieth
 * of it — four rungs a vendor, the same ladder on both — with the dearest of
 * each vendor's above the default, Fable 5.1 and GPT-6 Astra, as recognition
 * offers them.
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
      offer('anthropic', 'claude-fable-5-1', 'Anthropic’s most capable, at two and a half times Opus’s price.'),
      offer('anthropic', 'claude-opus-5-5', 'Best when it has to work things out, at two fifths of Fable’s price.', true),
      offer('anthropic', 'claude-sonnet-5-5', 'Quicker, and half the price of Opus 5.5.'),
      offer('anthropic', 'claude-haiku-5-5', 'The quickest and cheapest Claude. Fine for simple requests.'),
    ],
  },
  openai: {
    default: 'gpt-6.1-sol',
    choices: [
      offer('openai', 'gpt-6-astra', 'OpenAI’s most capable, at five times Sol’s price.'),
      offer('openai', 'gpt-6.1-sol', 'Nearly as capable as Astra, at a fifth of the price.', true),
      offer('openai', 'gpt-6.1-terra', 'Quicker, and half the price of Sol.'),
      offer('openai', 'gpt-6-luna', 'The quickest and cheapest. Fine for simple requests.'),
    ],
  },
};

/**
 * What names a conversation, per vendor: the cheapest model each offers.
 *
 * **Not a setting, and not the conversation's own model.** A name is a few
 * words worked out once per conversation, beside its first round
 * (`chat/chat-title.ts`), and every model on either list writes "Porch light at
 * sunset" equally well — so what is chosen is the one that costs least and
 * answers fastest, at the lowest effort either vendor takes. A home that runs
 * its chats on Fable 5.1 pays Haiku's price for the name, about four
 * thousandths of a cent. The vendor is still the conversation's, first: the
 * person's words go where they were already going, and only a failure there
 * takes them to the other vendor — on a key this home holds for exactly that.
 *
 * Named from the table rather than written out, so an id `MODELS` has never
 * heard of fails at module load, and `test/chat-title.test.ts` pins the
 * invariant that matters: nothing either agent is offered is cheaper.
 */
export const TITLE_MODELS: Readonly<Record<AiProvider, string>> = {
  anthropic: known('anthropic', 'claude-haiku-5-5'),
  openai: known('openai', 'gpt-6-luna'),
};

function known(provider: AiProvider, id: string): string {
  if (knownModel(provider, id) === undefined) throw new Error(`models: ${provider} has no ${id}`);
  return id;
}

/**
 * The first model along `stored`'s succession chain that `choices` offers, or
 * `null` when the chain runs out first — an id this vendor never had, or one
 * whose successors are all off this list (Sonnet 4.6 → Sonnet 5 → Sonnet 5.5,
 * which only the agents offer).
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

/**
 * The model one chat asked for by name, when it can run on it right now —
 * otherwise `null`.
 *
 * **Narrower than `effectiveAgentModel`, on purpose.** That one answers "what
 * will this home's setting run on", and its answer to an id it cannot use is a
 * fallback, because a stored column nobody chose must never become a refusal.
 * A chat's own pick is a different thing: somebody chose it a moment ago from
 * the list this hub offered, so quietly running something else would be the
 * picker lying about what answered. So an id no agent is offered, or one whose
 * vendor has no usable key, is `null` here — the route says so
 * (`409 model_unavailable`), and a revived conversation falls back to the
 * home's setting rather than to a vendor guessed by the resolver.
 *
 * What it does answer still goes **through** `effectiveAgentModel`, so the
 * vendor and key rules stay written once.
 */
export function requestedAgentModel(
  modelId: string | null | undefined,
  usable: UsableProviders,
): { provider: AiProvider; modelId: string } | null {
  const provider = agentProviderOf(modelId);
  if (provider === null || !usable[provider]) return null;
  return effectiveAgentModel(modelId, usable);
}

/**
 * How hard the model works on one round.
 *
 * **It belongs to the turn, not to the conversation.** A transport is built
 * once and holds the message history, so an effort chosen there is chosen for
 * the life of the chat — and the same conversation is typed in the morning and
 * talked to in the evening (`spokenSessions`' own reasoning). A spoken round is
 * answered out loud while somebody stands there waiting, and a typed one is
 * read when it lands.
 *
 * **Three words, because it is one value sent to two vendors.** It goes
 * straight onto the wire — Anthropic's `output_config.effort` and OpenAI's
 * `reasoning.effort` — and the vocabularies are only the same where they
 * overlap, so a wider type here is a value one transport would send and the
 * other would be refused for, discovered as a 400 in somebody's kitchen rather
 * than by the checker. It carried `xhigh` and `max` for a while with nothing
 * setting them, which is the same trap one step from firing. Widening one is
 * deliberate work: check both vendors take the word, or give the transport
 * that cannot a mapping of its own.
 *
 * **And the words are the hub's.** A typed message may ask for its own round's
 * effort, and the home keeps one of its own for each agent — both from
 * `CHAT_EFFORTS`, as the routes validate it and `GET /hub` and
 * `GET /settings/ai` advertise it — so an app draws a picker for whatever this
 * hub says and never ships a vocabulary of its own.
 *
 * It lives here rather than beside the chat runtime that spends it because the
 * settings service stores the home's word, and this is the one module it may
 * import from the AI side.
 */
export type ChatEffort = 'low' | 'medium' | 'high';

/**
 * The hub's whole effort vocabulary, in the order an app draws it.
 *
 * Exactly `ChatEffort`, and the `satisfies` is what keeps it so: this is the
 * list a request is validated against and the list the hub advertises, so a
 * word added to one and not the other would be a picker offering something the
 * route refuses.
 */
export const CHAT_EFFORTS = ['low', 'medium', 'high'] as const satisfies readonly ChatEffort[];

/**
 * What a conversation works at when nothing chose otherwise — the default of
 * the home's own word for each agent, and so what every typed round ran at
 * before the home had one.
 *
 * `medium` against the mapper's `high`: a descriptor is cached against a
 * device model for ever, while a chat is many small rounds read the moment
 * they arrive. Named once here because the agents, the settings and the run
 * log all state it — several places for one number is the drift this avoids.
 */
export const AGENT_EFFORT: ChatEffort = 'medium';

/**
 * A stored word this build can send, or null.
 *
 * **Read, never trusted.** The column is written by the route, which validates
 * against `CHAT_EFFORTS` — but a newer build may have widened the list and
 * then been rolled back, and a word this build would put on the wire for a
 * vendor to refuse is worse than the default it falls back to.
 */
export function knownEffort(value: unknown): ChatEffort | null {
  return typeof value === 'string' && (CHAT_EFFORTS as readonly string[]).includes(value)
    ? (value as ChatEffort)
    : null;
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
 * Estimate what **one request** cost. A run or a conversation adds these up
 * request by request (`ModelPricing.longPrompt` is why it cannot add up tokens
 * instead). Used for the budget caps and for `status.lastRun.costUsd`; an
 * unknown model falls back to the most expensive known rates so a cap can only
 * ever trip early.
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
  const tier = price.longPrompt;
  const long = tier !== undefined && input + cacheRead + cacheWrite > tier.aboveTokens;
  const inputRate = long ? price.inputPerMTok * tier.inputMultiplier : price.inputPerMTok;
  const outputRate = long ? price.outputPerMTok * tier.outputMultiplier : price.outputPerMTok;
  return (
    (input * inputRate +
      cacheRead * inputRate * readMultiplier +
      cacheWrite * inputRate * writeMultiplier +
      output * outputRate) /
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
 * work for the same money, so on GPT-6 Astra or Fable 5.1 ($10/$50) a fixed cap
 * would stop a perfectly healthy run at half the work it allows everywhere
 * else, and a paid run would end unfinished — somebody would have chosen the
 * most thorough model and got the least done. So the cap scales with the price, by whichever of the
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

/**
 * The dearest of every rate the table holds, each taken on its own. Not the
 * dearest *row*: Fable 5.1 and GPT-6 Astra tie on $10/$50 and differ fourfold
 * on a cached read, so which one the fallback landed on would have been
 * decided by the order the table happens to be written in.
 */
function mostExpensive(): ModelPricing {
  const prices = Object.values(MODELS)
    .flatMap((provider) => Object.values(provider))
    .map((known) => known.price);
  return {
    inputPerMTok: Math.max(...prices.map((price) => price.inputPerMTok)),
    outputPerMTok: Math.max(...prices.map((price) => price.outputPerMTok)),
    cacheReadMultiplier: Math.max(...prices.map((price) => price.cacheReadMultiplier ?? CACHE_READ_MULTIPLIER)),
    cacheWriteMultiplier: Math.max(...prices.map((price) => price.cacheWriteMultiplier ?? CACHE_WRITE_MULTIPLIER)),
  };
}
