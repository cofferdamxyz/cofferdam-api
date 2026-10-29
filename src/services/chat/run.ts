// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One chat turn (workspace decision 0037): the `clef-flash` router, then the
 * routed model, streamed back to the app as server-sent events.
 *
 *   data: {"type":"route","route":"answer","action":null,"confidence":0.97}
 *   data: {"type":"text","delta":"…"}                 (zero or more)
 *   data: {"type":"action","request":{"id":"send","amount":20,"recipient":"ana"}}
 *   data: {"type":"choices","requests":[{"id":"send","recipient":"joao"},{"id":"message"}]}
 *   data: {"type":"done"}            or   data: {"type":"error","message":"…"}
 *
 * The everyday answer starts together with the router and is held until the
 * router clears the turn: on a short answer its text streams at once, on any
 * other route it is cancelled unread, so nothing reaches the user before the
 * safety checks. Below the action floor the turn offers the likeliest screens
 * as `choices` to tap, the first one prefilled, instead of guessing.
 *
 * The text the app sends has already passed its on-device privacy gate;
 * placeholders such as [EMAIL_1] stay as written. Every model call goes
 * through the inference seam (`services/inference`), injected so the tests
 * drive the whole turn with fakes. Two tiers (decision 0047): Ordinary runs
 * every call with thinking off, since reasoning tokens bill as output and
 * delay the reply; Thinking, chosen by the user, answers on the reasoning
 * model (DeepSeek V4.1 Flash) at low effort (high above `highFloor` on Clef's
 * reasoning score), with no early answer and one retry when the first attempt
 * sends nothing in time. Actions, refusals and the fields run the same in
 * both tiers.
 */

import { InferenceTimeout, OPS, type Inference } from '../inference/index.js';
import { PRODUCT_FACTS } from './facts.generated.js';
import { actionTool, CHAT_ACTIONS, decideRoute, routerQuestions, type ChatLanguage, type ChatRoute, type RouteDecision } from './router.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** Ordinary: gemma-4, thinking off. Thinking: DeepSeek V4.1 Flash with reasoning (decision 0047). */
export type ChatTier = 'ordinary' | 'thinking';
/** DeepSeek V4.1 Flash takes none, low, high (its default) and max, and reads medium as high (2026-10-21); GLM-5.3, pinnable, takes low, high and max. */
export type ReasoningEffort = 'low' | 'high';

export type ChatEvent =
  | {
      type: 'route';
      route: RouteDecision['route'];
      action: string | null;
      confidence: number;
      /** The tier this turn runs in (the user's choice; fixed replies carry it too). */
      tier: ChatTier;
      /** The reasoning effort a Thinking answer runs at. */
      effort?: ReasoningEffort;
      /** Clef's reasoning score, 0 to 1. */
      reasoning: number;
    }
  | { type: 'text'; delta: string }
  | { type: 'action'; request: Record<string, unknown> }
  | { type: 'choices'; requests: Record<string, unknown>[] }
  /**
   * The plane speaking for itself, not a model; the text that follows is its
   * notice. `strict_blocked`: the strict gateway's DLP held the turn back
   * (decision 0021 (h)).
   */
  | { type: 'notice'; kind: 'strict_blocked' }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** The seam as the turn uses it. */
export type ChatInference = Pick<Inference, 'run' | 'model'>;

// ── Request ──────────────────────────────────────────────────────────────────

export const CHAT_LIMITS = { messages: 12, messageChars: 4_000, totalChars: 12_000 } as const;

export class ChatRequestError extends Error {}

/** Validate the app's body: `{ account, messages: [{ role, text }] }`, ending with the user's turn. */
export function parseChatRequest(body: unknown): { account: string; messages: ChatMessage[]; tier: ChatTier } {
  if (!body || typeof body !== 'object') throw new ChatRequestError('expected a JSON object');
  const b = body as Record<string, unknown>;
  const account = String(b.account ?? '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(account)) throw new ChatRequestError('account must be a 0x address');
  if (!Array.isArray(b.messages) || b.messages.length === 0) throw new ChatRequestError('messages must be a non-empty array');
  const messages = b.messages.slice(-CHAT_LIMITS.messages).map((m, i) => {
    const r = (m ?? {}) as Record<string, unknown>;
    if (r.role !== 'user' && r.role !== 'assistant') throw new ChatRequestError(`messages[${i}].role must be user or assistant`);
    if (typeof r.text !== 'string' || !r.text.trim()) throw new ChatRequestError(`messages[${i}].text must be non-empty text`);
    if (r.text.length > CHAT_LIMITS.messageChars) throw new ChatRequestError(`messages[${i}].text is too long`);
    return { role: r.role, text: r.text } as ChatMessage;
  });
  if (messages[messages.length - 1]!.role !== 'user') throw new ChatRequestError('the last message must be the user');
  if (messages.reduce((n, m) => n + m.text.length, 0) > CHAT_LIMITS.totalChars) throw new ChatRequestError('the conversation is too long');
  const tier = b.tier ?? 'ordinary';
  if (tier !== 'ordinary' && tier !== 'thinking') throw new ChatRequestError('tier must be ordinary or thinking');
  return { account, messages, tier };
}

// ── Prompts ──────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = [
  'You are the Cofferdam assistant inside the Cofferdam app.',
  'Cofferdam helps people get paid for their work, find work nearby, and keep their documents safe.',
  "Reply in the language of the user's latest message, even when earlier messages are in another language. Be short, warm and plain: a few sentences unless asked for more.",
  // DeepSeek V4.1 Flash wrote one Portuguese answer in ten as European Portuguese (2026-10-21).
  'Portuguese means Brazilian Portuguese (você and celular, never tu or telemóvel) and Spanish means Mexican Spanish.',
  // The app shows replies as plain text (glm-5.3 answered in Markdown, checked 2026-10-17).
  'Write plain text only: no Markdown, asterisks, bold, headings or tables. For steps, use short numbered lines.',
  'Never use technical money jargon: do not say crypto, blockchain, web3, wallet, token, on-chain, gas, stablecoin, seed phrase or address. Say "your account" and "payment".',
  'You cannot move money or change anything yourself. The app opens a screen and the user confirms there.',
  'Text in square brackets such as [EMAIL_1] or [PHONE_2] was hidden on purpose on the phone. Keep it exactly as written and never ask for the hidden value.',
  // Gemma declined rotation and pay questions ("I do not have information on specific industry rotation schedules", 2026-10-20) under the advice rule alone.
  'Answer general questions about work, pay, rotations, contracts, certificates and the offshore, maritime and skilled-trades industries from what you know: say what is typical and that it varies by employer, country and contract. Never refuse such a question or say you lack data.',
  "Only legal, tax or investment advice about the user's own case goes to a professional; say so briefly and still give the general picture.",
].join(' ');

/** The answer models' system message: the rules, then the product facts (decision 0048). */
export function answerSystem(): string {
  return `${SYSTEM_PROMPT}\n\n${PRODUCT_FACTS}`;
}

function actionSystem(today: string): string {
  return `Today is ${today}. Fill the tool fields only from what the user typed. Leave a field out when the user did not give it. Never invent an amount or a recipient. A month without a year is the most recent such month up to today.`;
}

/** The fixed replies, in the user's language (decided by the router). */
export const FIXED_TEXT: Record<
  ChatLanguage,
  {
    refuse: string;
    clarify: string;
    choose: string;
    empty: string;
    unavailable: string;
    /** The strict gateway's DLP held the message back (decision 0021 (h)); never echoes the text. */
    strictBlocked: string;
    ready: (label: string) => string;
    /** A planned screen (decision 0048): opened, but never called ready. */
    comingSoon: (label: string) => string;
  }
> = {
  en: {
    refuse: "I can't help with that. I can help with your payments, your documents or finding work.",
    clarify: 'Do you want me to open something for you? I can open Send, Add money, your documents, your payments, Looking for work, or a new message.',
    choose: 'Did you mean one of these? Tap one to open it, or ask me another way.',
    empty: "Sorry, I couldn't put an answer together. Try asking another way.",
    unavailable: 'The assistant is unavailable right now. Try again in a moment.',
    strictBlocked:
      'Cofferdam Cloud did not send that message: it looked like it held a card, account, ID or tax number. Remove the number and send it again.',
    ready: (label) => `${label} is ready. Check the details and confirm there.`,
    comingSoon: (label) => `${label} isn't available yet; it's coming. The app shows what it is waiting for.`,
  },
  pt: {
    refuse: 'Não posso ajudar com isso. Posso ajudar com seus pagamentos, seus documentos ou a encontrar trabalho.',
    clarify: 'Quer que eu abra algo para você? Posso abrir Enviar, Adicionar dinheiro, seus documentos, seus pagamentos, Procurando trabalho ou uma nova mensagem.',
    choose: 'Você quis dizer uma destas? Toque em uma para abrir, ou pergunte de outro jeito.',
    empty: 'Desculpe, não consegui montar uma resposta. Tente perguntar de outro jeito.',
    unavailable: 'O assistente está fora do ar agora. Tente de novo daqui a pouco.',
    strictBlocked:
      'A Cofferdam Cloud não enviou essa mensagem: parecia ter um número de cartão, de conta, de documento ou fiscal. Tire o número e envie de novo.',
    ready: (label) => `${label} está pronto. Confira os detalhes e confirme lá.`,
    comingSoon: (label) => `${label} ainda não está disponível; está chegando. O app mostra o que falta.`,
  },
  es: {
    refuse: 'No puedo ayudar con eso. Puedo ayudarte con tus pagos, tus documentos o a encontrar trabajo.',
    clarify: '¿Quieres que abra algo? Puedo abrir Enviar, Añadir dinero, tus documentos, tus pagos, Buscando trabajo o un mensaje nuevo.',
    choose: '¿Quisiste decir una de estas? Toca una para abrirla, o pregúntame de otra forma.',
    empty: 'Lo siento, no pude armar una respuesta. Intenta preguntarlo de otra forma.',
    unavailable: 'El asistente no está disponible ahora. Intenta de nuevo en un momento.',
    strictBlocked:
      'Cofferdam Cloud no envió ese mensaje: parecía tener un número de tarjeta, de cuenta, de identificación o fiscal. Quita el número y envíalo de nuevo.',
    ready: (label) => `${label} está listo. Revisa los detalles y confirma allí.`,
    comingSoon: (label) => `${label} todavía no está disponible; ya viene. La app muestra qué falta.`,
  },
};

/** The app's screen names (`cofferdam-app/src/lib/actions.ts` labels), per language. */
const ACTION_LABELS: Record<ChatLanguage, Record<string, string>> = {
  en: { send: 'Send', add_money: 'Add money', find_document: 'Find a document', filter_activity: 'Your payments', import_cv: 'Import your CV', add_document: 'Add to Vault', looking_for: 'Looking for work', message: 'A new message', create_group: 'A new group' },
  pt: { send: 'Enviar', add_money: 'Adicionar dinheiro', find_document: 'Buscar documento', filter_activity: 'Seus pagamentos', import_cv: 'Importar seu currículo', add_document: 'Adicionar ao Cofre', looking_for: 'Procurando trabalho', message: 'Uma nova mensagem', create_group: 'Um novo grupo' },
  es: { send: 'Enviar', add_money: 'Añadir dinero', find_document: 'Buscar un documento', filter_activity: 'Tus pagos', import_cv: 'Importar tu CV', add_document: 'Añadir a la Bóveda', looking_for: 'Buscando trabajo', message: 'Un mensaje nuevo', create_group: 'Un grupo nuevo' },
};

export const REFUSE_TEXT = FIXED_TEXT.en.refuse;
export const CLARIFY_TEXT = FIXED_TEXT.en.clarify;
export const CHOOSE_TEXT = FIXED_TEXT.en.choose;
export const EMPTY_TEXT = FIXED_TEXT.en.empty;

const USD = /(\$|\busdc?\b|\bdollars?\b|\bd[óo]lar(es)?\b)/i;
const OTHER_CURRENCY = /(r\$|€|£|¥|₹|\breais\b|\breal\b|\bcontos?\b|\beuros?\b|\blibras?\b|\bpounds?\b|\bpesos?\b|\byen\b|\brupees?\b|\bsoles?\b)/i;

/** Whether an amount in the text is in another currency than US dollars. */
export function mentionsOtherCurrency(text: string): boolean {
  const withoutBrl = text.replace(/r\$/gi, ' BRL ');
  return OTHER_CURRENCY.test(text) && !USD.test(withoutBrl);
}

/**
 * Whether the amount the action model read may be prefilled. The app has one
 * coin, USDC, and amounts read in it (decision 0046), so a bare number is the
 * amount in any language: "manda 20 pra ana" prefills 20 (the founder's
 * ruling on the Pixel, 2026-10-20). Only an amount in another currency is
 * dropped, because the model was told to skip those and still prefilled
 * "15 reais" as 15 (checked 2026-10-17); "conto" is Brazilian slang for reais.
 */
export function keepsAmount(text: string): boolean {
  return !mentionsOtherCurrency(text);
}

/**
 * The first router attempt waits this long before the retry: Clef answers in
 * about 0.3 to 0.8 s on the plane, and a stalled call that answered in 301 ms
 * on retry cost a turn 6.3 s under the op's 6 s window (2026-10-20).
 */
export const ROUTER_FIRST_TRY_MS = 3_000;

/**
 * The first reasoning attempt waits this long for its first bytes before the
 * retry: DeepSeek V4.1 Flash and GLM-5.3 each stalled once in 28 evaluation
 * answers with nothing sent by the op's 45 s window, while every answered
 * call began within 9 s (2026-10-21). The retry waits the full window.
 */
export const REASONING_FIRST_TRY_MS = 15_000;

/** Earlier turns reach the router cut to this many characters; the latest message goes whole. */
export const ROUTER_EARLIER_CHARS = 300;

/** The router's `state`: the recent turns, oldest first, the latest marked. */
export function routerState(messages: ChatMessage[]): string {
  const lines = messages.slice(-6).map((m, i, all) => {
    if (i === all.length - 1) return `Latest user message: ${m.text}`;
    const who = m.role === 'user' ? 'User' : 'Assistant';
    const text = m.text.length > ROUTER_EARLIER_CHARS ? `${m.text.slice(0, ROUTER_EARLIER_CHARS).trimEnd()}…` : m.text;
    return `${who}: ${text}`;
  });
  return lines.join('\n');
}

/** Below this probability on the router's language answer, the request's `Accept-Language` picks the fixed replies. */
export const LANGUAGE_FLOOR = 0.6;

/**
 * The fixed-reply language an `Accept-Language` header asks for: its most
 * preferred of English, Portuguese and Spanish, returned only when that is
 * Portuguese or Spanish (English is already the default).
 */
export function headerLanguage(header: string | null | undefined): Exclude<ChatLanguage, 'en'> | null {
  if (!header) return null;
  let best: { lang: ChatLanguage; q: number; i: number } | null = null;
  header.split(',').forEach((part, i) => {
    const [tag, ...params] = part.trim().split(';');
    const lang = tag!.trim().toLowerCase().split('-')[0];
    if (lang !== 'en' && lang !== 'pt' && lang !== 'es') return;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    if (!Number.isFinite(q) || q <= 0) return;
    if (!best || q > best.q) best = { lang, q, i };
  });
  const found = best as { lang: ChatLanguage } | null;
  return found && found.lang !== 'en' ? found.lang : null;
}

/** The probability behind the router's language choice; 0 when it gave none. */
function languageProbability(answers: unknown): number {
  const lang = (answers as { language?: { choice?: string; probabilities?: Record<string, number> } } | null)?.language;
  const p = Number(lang?.probabilities?.[lang?.choice ?? ''] ?? 0);
  return Number.isFinite(p) ? p : 0;
}

// ── Model output ─────────────────────────────────────────────────────────────

/** The first tool call's arguments from an OpenAI-style or legacy Workers AI response. */
export function toolArguments(res: unknown): Record<string, unknown> | null {
  const r = (res ?? {}) as Record<string, any>;
  const call = r.choices?.[0]?.message?.tool_calls?.[0] ?? r.tool_calls?.[0];
  const raw = call?.function?.arguments ?? call?.arguments;
  if (raw == null) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The text delta in one streamed chunk (OpenAI-style or legacy `response`). */
export function chunkText(chunk: unknown): string {
  const c = (chunk ?? {}) as Record<string, any>;
  const delta = c.choices?.[0]?.delta?.content ?? c.response;
  return typeof delta === 'string' ? delta : '';
}

/** The full text of a non-streamed answer. */
export function messageText(res: unknown): string {
  const r = (res ?? {}) as Record<string, any>;
  const text = r.choices?.[0]?.message?.content ?? r.response;
  return typeof text === 'string' ? text : '';
}

/** Yield the parsed JSON of each `data:` line of a server-sent-event byte stream. */
export async function* sseJson(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch {
        // a partial or non-JSON line: skip it
      }
    }
    if (done) return;
  }
}

// ── The turn ─────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
export function sseEncode(ev: ChatEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(ev)}\n\n`);
}

/** The short model name Clef's request body carries (`clef-flash` for `@cf/cloudflare/clef-flash`). */
function clefName(model: string): string {
  return model.split('/').pop() ?? model;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The AI Gateway error code of a DLP block, the prefix of the binding error's message. */
export const DLP_BLOCK_CODE = 2030;

/**
 * Whether a model call failed because the strict gateway's DLP held its text
 * back (decision 0021 (h)). Seen through the Workers AI binding on
 * 2026-10-29, with the gateway's policy on Block for requests: an
 * `InferenceUpstreamError` named `AiGatewayError` whose message is
 * `2030: Request content blocked due to DLP policy violations`, with no `code`
 * or `status` field. Other gateway failures share the name, so the code
 * decides.
 */
export function isStrictBlock(err: unknown): boolean {
  return err instanceof Error && err.name === 'AiGatewayError' && err.message.startsWith(`${DLP_BLOCK_CODE}:`);
}

/**
 * The same stream once its first chunk has arrived, or an `InferenceTimeout`
 * when nothing came within `ms`: the seam's window ends when a stream starts,
 * and a stalled model can start one and then send nothing.
 */
async function startedWithin(stream: ReadableStream<Uint8Array>, ms: number): Promise<ReadableStream<Uint8Array>> {
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first: Awaited<ReturnType<typeof reader.read>>;
  try {
    first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new InferenceTimeout('chat-reasoning', ms)), ms);
      }),
    ]);
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(first.value);
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** The Thinking tier's input: the same conversation, reasoning on at `effort`, room for the answer after it. */
function reasoningInput(messages: ChatMessage[], effort: ReasoningEffort): Record<string, unknown> {
  return {
    messages: [{ role: 'system', content: answerSystem() }, ...messages.map((m) => ({ role: m.role, content: m.text }))],
    stream: true,
    max_completion_tokens: 1_600,
    reasoning_effort: effort,
  };
}

/**
 * The fields that keep an everyday call from reasoning, by model family: Gemma
 * honours `enable_thinking` and GLM-5.3 needs `reasoning_effort` too (checked
 * 2026-10-17); DeepSeek V4.1 Flash takes `reasoning_effort: 'none'` and reads
 * `low` as reasoning on (2026-10-21), so a DeepSeek pin on an everyday op
 * answers with no reasoning at all.
 */
export function thinkingOff(model: string): Record<string, unknown> {
  return model.startsWith('@cf/deepseek-ai/')
    ? { reasoning_effort: 'none' }
    : { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'low' };
}

/** The answer models' input: the conversation under the system prompt, streamed, thinking off. */
function answerInput(messages: ChatMessage[], long: boolean, model: string): Record<string, unknown> {
  return {
    messages: [{ role: 'system', content: answerSystem() }, ...messages.map((m) => ({ role: m.role, content: m.text }))],
    stream: true,
    max_completion_tokens: long ? 1_200 : 400,
    ...thinkingOff(model),
  };
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Clef's name for its input count (seen over REST 2026-10-24). */
  input_tokens?: number;
  /** Workers AI's bill for the call, cached input priced as cached ($0.011 per 1,000); every chat model reports it. */
  neurons?: number;
}

function usageOf(v: unknown): Usage | null {
  const u = (v as { usage?: Usage } | null)?.usage;
  return u && typeof u === 'object' ? u : null;
}

/** What one turn spent, for the per-account meter (`services/chatUsageStore.ts`). */
export interface ChatTurnUsage {
  route: ChatRoute;
  /** The model that wrote the answer or filled the action fields; null when the turn sent only fixed text. */
  model: string | null;
  /** That model's tokens, when it reported them. */
  tokensIn: number | null;
  tokensOut: number | null;
  /** The neurons Workers AI billed for that model's call, when it reported them: the bill itself, cached input included. */
  neurons: number | null;
  router: {
    model: string;
    /** Whether the router was called (a failed call still counts). */
    called: boolean;
    /** Clef's reported input tokens, or the router state's characters divided by four when it reported none. */
    tokensIn: number;
    /** True when `tokensIn` is the characters-over-four estimate. */
    estimated: boolean;
  };
}

export interface RunChatOptions {
  inference: ChatInference;
  messages: ChatMessage[];
  /** Start the everyday answer with the router (default); `CHAT_EARLY_ANSWER=off` turns it off. */
  early?: boolean;
  /** The user's tier; Ordinary when absent. */
  tier?: ChatTier;
  /** Clef's reasoning score at or above which a Thinking answer runs at high effort; null or absent: never. */
  highFloor?: number | null;
  /** The first reasoning attempt's window before the retry, `REASONING_FIRST_TRY_MS` (tests shorten it). */
  reasoningFirstTryMs?: number;
  /** One line per routed turn for Workers Logs (no message text). */
  log?: (fields: Record<string, unknown>) => void;
  /** Clock for the action model's date (tests pin it). */
  now?: () => number;
  /** Fires once, after `done`, with what the turn spent. */
  onTurn?: (usage: ChatTurnUsage) => void;
  /** The fixed replies' language when the router's language answer is below `LANGUAGE_FLOOR` (from `Accept-Language`). */
  fallbackLanguage?: ChatLanguage | null;
}

/** Run one turn; the returned stream carries `ChatEvent`s as SSE. */
export function runChat(opts: RunChatOptions): ReadableStream<Uint8Array> {
  const { inference, messages } = opts;
  const latest = messages[messages.length - 1]!.text;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const started = Date.now();
  const timings: Record<string, number> = {};
  const turn: Record<string, unknown> = {};
  /** The routed model's spend, for `onTurn`. */
  const spent: { model: string | null; tokensIn: number | null; tokensOut: number | null; neurons: number | null } = {
    model: null,
    tokensIn: null,
    tokensOut: null,
    neurons: null,
  };
  const noteUsage = (model: string, usage: Usage | null) => {
    spent.model = model;
    if (usage?.prompt_tokens != null) spent.tokensIn = usage.prompt_tokens;
    if (usage?.completion_tokens != null) spent.tokensOut = usage.completion_tokens;
    spent.neurons = typeof usage?.neurons === 'number' && usage.neurons >= 0 ? usage.neurons : null;
  };
  const emit = (ev: ChatEvent) => {
    if (ev.type === 'text' && timings.first === undefined) timings.first = Date.now() - started;
    return writer.write(sseEncode(ev));
  };

  /** The fields the action model fills for one screen, only those the screen declares. */
  async function actionFields(id: string, language: ChatLanguage): Promise<Record<string, unknown>> {
    const tool = actionTool(id);
    if (!tool) return {};
    const model = await inference.model('chat-action');
    spent.model = model;
    try {
      const t = Date.now();
      const res = await inference.run('chat-action', {
        messages: [
          { role: 'system', content: actionSystem(new Date(opts.now?.() ?? Date.now()).toISOString().slice(0, 10)) },
          { role: 'user', content: latest },
        ],
        tools: [tool],
        tool_choice: 'required',
        max_completion_tokens: 200,
        ...thinkingOff(model),
      });
      timings.fields = Date.now() - t;
      noteUsage(model, usageOf(res));
      const args = toolArguments(res) ?? {};
      const fields: Record<string, unknown> = {};
      for (const k of Object.keys(CHAT_ACTIONS.find((a) => a.id === id)?.fields ?? {})) {
        if (args[k] != null && args[k] !== '') fields[k] = args[k];
      }
      if (!keepsAmount(latest)) delete fields.amount;
      // Handles travel without the @; the app's validator checks the bare handle.
      if (typeof fields.recipient === 'string') fields.recipient = fields.recipient.replace(/^@/, '');
      return fields;
    } catch (err) {
      // Open the screen without a prefill rather than fail the turn.
      opts.log?.({ event: 'chat_action_fields_failed', action: id, reason: reasonOf(err) });
      return {};
    }
  }

  /**
   * The Thinking answer: a first attempt that has sent nothing within its
   * window is cancelled and retried once with the op's full window. The
   * dropped attempt reports no usage and is not metered (the meter is a floor).
   */
  async function reasoningCall(input: Record<string, unknown>): Promise<unknown> {
    const firstTry = opts.reasoningFirstTryMs ?? REASONING_FIRST_TRY_MS;
    for (let attempt = 1; ; attempt++) {
      const window = attempt === 1 ? firstTry : OPS['chat-reasoning'].timeoutMs;
      const t = Date.now();
      try {
        const res = await inference.run('chat-reasoning', input, attempt === 1 ? { timeoutMs: window } : {});
        return res instanceof ReadableStream ? await startedWithin(res as ReadableStream<Uint8Array>, Math.max(1, window - (Date.now() - t))) : res;
      } catch (err) {
        if (attempt > 1) throw err;
        turn.reasoning_retried = true;
        opts.log?.({ event: 'chat_reasoning_retry', ms: Date.now() - t, reason: reasonOf(err) });
      }
    }
  }

  (async () => {
    let decision: RouteDecision = { route: 'answer', action: null, confidence: 0, language: 'en', candidates: [], reasoning: 0 };

    // The everyday answer starts with the router and waits for its verdict.
    // When long answers run on the same model (the default since gemma-4
    // proved faster than glm-5.3-flash), it starts with the long cap and
    // serves long turns too.
    const [answerModel, longModel, routerModel, reasoningModel] = await Promise.all([
      inference.model('chat-answer'),
      inference.model('chat-long'),
      inference.model('chat-router'),
      inference.model('chat-reasoning'),
    ]);
    const tier: ChatTier = opts.tier ?? 'ordinary';
    const thinking = tier === 'thinking';
    const shared = answerModel === longModel;
    const state = routerState(messages);
    const router = { model: routerModel, called: false, tokensIn: Math.ceil(state.length / 4), estimated: true };
    let languageP = 0;
    const early = new AbortController();
    const startAnswer = () => inference.run('chat-answer', answerInput(messages, shared, answerModel), { signal: early.signal });
    // No early answer in the Thinking tier: a cancelled reasoning call costs real money.
    const earlyAnswer = opts.early === false || thinking ? null : startAnswer();
    earlyAnswer?.catch(() => {});
    const dropEarly = () => {
      if (!earlyAnswer || early.signal.aborted) return;
      early.abort();
      earlyAnswer.then((r) => (r instanceof ReadableStream ? r.cancel() : undefined)).catch(() => {});
      turn.early ??= 'dropped';
    };
    // The fixed replies' language: the request's until the router has decided.
    let language: ChatLanguage = opts.fallbackLanguage ?? 'en';
    let routeSent = false;
    /**
     * The strict gateway's DLP held the turn's text back (decision 0021 (h)):
     * the plane's notice and a fixed reply, never the text, which no log names.
     * A `blocked` route goes first when the router had not decided yet. Not
     * metered: the gateway stopped the call before any model ran.
     */
    const holdBack = async (stage: ChatRoute | 'router') => {
      dropEarly();
      opts.log?.({ event: 'chat_strict_blocked', route: stage });
      if (!routeSent) await emit({ type: 'route', route: 'blocked', action: null, confidence: 0, tier, reasoning: 0 });
      await emit({ type: 'notice', kind: 'strict_blocked' });
      await emit({ type: 'text', delta: FIXED_TEXT[language].strictBlocked });
      await emit({ type: 'done' });
    };

    try {
      // The safety checks live in the router, so a turn never reaches a model
      // without it: a failed call is retried once, and a second failure
      // declines the turn. (The Thinking-tier evaluation of 2026-10-20 caught a
      // refusal-worthy prompt answered after a router timeout under the old
      // "answer without it" fallback.)
      let routed = false;
      let blocked = false;
      for (let attempt = 1; attempt <= 2 && !routed && !blocked; attempt++) {
        try {
          const t0 = Date.now();
          router.called = true;
          const clef = (await inference.run(
            'chat-router',
            { model: clefName(router.model), state, questions: routerQuestions() },
            attempt === 1 ? { timeoutMs: ROUTER_FIRST_TRY_MS } : {},
          )) as { answers?: unknown; usage?: Usage };
          // Clef reports its input count; the estimate stands when it does not.
          const reported = clef?.usage?.input_tokens ?? clef?.usage?.prompt_tokens;
          if (typeof reported === 'number' && reported > 0) Object.assign(router, { tokensIn: reported, estimated: false });
          decision = decideRoute(clef?.answers);
          languageP = languageProbability(clef?.answers);
          timings.router = Date.now() - t0;
          routed = true;
        } catch (err) {
          // The gateway would hold the same text back again: no retry.
          if (isStrictBlock(err)) blocked = true;
          else opts.log?.({ event: 'chat_router_failed', attempt, reason: reasonOf(err) });
        }
      }
      if (blocked) {
        await holdBack('router');
        return;
      }
      if (!routed) {
        dropEarly();
        opts.log?.({ event: 'chat_router_unavailable', tier, ms: Date.now() - started });
        await emit({ type: 'error', message: FIXED_TEXT[opts.fallbackLanguage ?? 'en'].unavailable });
        return;
      }
      // The effort only matters where the reasoning model answers.
      const answers = decision.route === 'answer' || decision.route === 'answer_long';
      const effort: ReasoningEffort | undefined =
        thinking && answers ? (opts.highFloor != null && decision.reasoning >= opts.highFloor ? 'high' : 'low') : undefined;
      Object.assign(turn, { tier, reasoning: decision.reasoning, ...(effort ? { effort } : {}) });
      await emit({
        type: 'route',
        route: decision.route,
        action: decision.action,
        confidence: decision.confidence,
        tier,
        reasoning: decision.reasoning,
        ...(effort ? { effort } : {}),
      });
      routeSent = true;

      // The fixed replies follow the router's language when it is sure, else the
      // language the request asked for; the amount rule keeps the router's.
      const replyLanguage = opts.fallbackLanguage && languageP < LANGUAGE_FLOOR ? opts.fallbackLanguage : decision.language;
      if (replyLanguage !== decision.language) turn.reply_language = replyLanguage;
      language = replyLanguage;
      const fixed = FIXED_TEXT[replyLanguage];
      switch (decision.route) {
        case 'refuse':
          dropEarly();
          await emit({ type: 'text', delta: fixed.refuse });
          break;
        case 'clarify': {
          dropEarly();
          if (decision.candidates.length === 0) {
            await emit({ type: 'text', delta: fixed.clarify });
            break;
          }
          // Only the likeliest screen is prefilled; the others open empty.
          const first = await actionFields(decision.candidates[0]!, decision.language);
          const requests = decision.candidates.map((id, i) => (i === 0 ? { id, ...first } : { id }));
          turn.candidates = decision.candidates.length;
          await emit({ type: 'choices', requests });
          await emit({ type: 'text', delta: fixed.choose });
          break;
        }
        case 'action': {
          dropEarly();
          const id = decision.action!;
          const fields = await actionFields(id, decision.language);
          await emit({ type: 'action', request: { id, ...fields } });
          const label = ACTION_LABELS[replyLanguage][id] ?? id;
          await emit({ type: 'text', delta: CHAT_ACTIONS.find((a) => a.id === id)?.planned ? fixed.comingSoon(label) : fixed.ready(label) });
          break;
        }
        case 'answer':
        case 'answer_long': {
          const long = decision.route === 'answer_long';
          const useEarly = !thinking && earlyAnswer !== null && (!long || shared);
          if (useEarly) turn.early = 'used';
          else dropEarly();
          // The early answer's call began with the turn.
          const t2 = useEarly ? started : Date.now();
          const res = thinking
            ? await reasoningCall(reasoningInput(messages, effort ?? 'low'))
            : useEarly
              ? await earlyAnswer
              : long && !shared
                ? await inference.run('chat-long', answerInput(messages, true, longModel))
                : await startAnswer();
          let sent = 0;
          let usage = usageOf(res);
          if (res instanceof ReadableStream) {
            for await (const chunk of sseJson(res as ReadableStream<Uint8Array>)) {
              usage = usageOf(chunk) ?? usage;
              const delta = chunkText(chunk);
              if (delta) {
                sent += delta.length;
                await emit({ type: 'text', delta });
              }
            }
          } else {
            const text = messageText(res);
            sent = text.length;
            if (text) await emit({ type: 'text', delta: text });
          }
          timings.model = Date.now() - t2;
          if (usage) Object.assign(turn, { tokens_in: usage.prompt_tokens, tokens_out: usage.completion_tokens, ...(typeof usage.neurons === 'number' ? { neurons: usage.neurons } : {}) });
          noteUsage(thinking ? reasoningModel : long && !shared ? longModel : answerModel, usage);
          if (sent === 0) await emit({ type: 'text', delta: fixed.empty });
          break;
        }
      }
      await emit({ type: 'done' });
      try {
        opts.onTurn?.({ route: decision.route, ...spent, router });
      } catch (err) {
        opts.log?.({ event: 'chat_usage_failed', reason: reasonOf(err) });
      }
      opts.log?.({
        event: 'chat_turn',
        route: decision.route,
        action: decision.action,
        confidence: decision.confidence,
        language: decision.language,
        ms: Date.now() - started,
        ...timings,
        ...turn,
      });
    } catch (err) {
      if (isStrictBlock(err)) {
        // An answer or action model the gateway held back after the router passed.
        await holdBack(decision.route).catch(() => {});
      } else {
        dropEarly();
        opts.log?.({ event: 'chat_turn_failed', route: decision.route, reason: reasonOf(err) });
        await emit({ type: 'error', message: FIXED_TEXT[opts.fallbackLanguage ?? 'en'].unavailable }).catch(() => {});
      }
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return readable;
}
