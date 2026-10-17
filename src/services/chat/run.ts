// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One chat turn (workspace decision 0037): the `clef-flash` router, then the
 * routed model, streamed back to the app as server-sent events.
 *
 *   data: {"type":"route","route":"answer","action":null,"confidence":0.97}
 *   data: {"type":"text","delta":"…"}                 (zero or more)
 *   data: {"type":"action","request":{"id":"send","amount":20,"recipient":"ana"}}
 *   data: {"type":"done"}            or   data: {"type":"error","message":"…"}
 *
 * The text the app sends has already passed its on-device privacy gate;
 * placeholders such as [EMAIL_1] stay as written. Workers AI is injected
 * (`AiRun`), so the tests drive the whole turn with fakes. Thinking is off on
 * every routed call: reasoning tokens bill as output and delay the reply.
 */

import { actionTool, CHAT_ACTIONS, decideRoute, routerQuestions, type ChatLanguage, type RouteDecision } from './router.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export type ChatEvent =
  | { type: 'route'; route: RouteDecision['route']; action: string | null; confidence: number }
  | { type: 'text'; delta: string }
  | { type: 'action'; request: Record<string, unknown> }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** Model pins; each is one setting (decision 0037). */
export interface ChatModels {
  router: string;
  action: string;
  answer: string;
  answerLong: string;
}

export const DEFAULT_CHAT_MODELS: ChatModels = {
  router: '@cf/cloudflare/clef-flash',
  // gemma-4 fills the action fields as well as glm-4.7-flash and stays near 1 s;
  // glm-4.7-flash spiked to 7-11 s on the same call (checked 2026-10-17).
  action: '@cf/google/gemma-4-26b-a4b-it',
  answer: '@cf/google/gemma-4-26b-a4b-it',
  answerLong: '@cf/zai-org/glm-5.3-flash',
};

/** Workers AI's `run`, as the turn uses it. */
export type AiRun = (model: string, input: Record<string, unknown>) => Promise<unknown>;

// ── Request ──────────────────────────────────────────────────────────────────

export const CHAT_LIMITS = { messages: 12, messageChars: 4_000, totalChars: 12_000 } as const;

export class ChatRequestError extends Error {}

/** Validate the app's body: `{ account, messages: [{ role, text }] }`, ending with the user's turn. */
export function parseChatRequest(body: unknown): { account: string; messages: ChatMessage[] } {
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
  return { account, messages };
}

// ── Prompts ──────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = [
  'You are the Cofferdam assistant inside the Cofferdam app.',
  'Cofferdam helps people get paid for their work, find work nearby, and keep their documents safe.',
  'Answer in the language the user writes in. Be short, warm and plain: a few sentences unless asked for more.',
  'Never use technical money jargon: do not say crypto, blockchain, web3, wallet, token, on-chain, gas, stablecoin, seed phrase or address. Say "your account" and "payment".',
  'You cannot move money or change anything yourself. The app opens a screen and the user confirms there.',
  'Text in square brackets such as [EMAIL_1] or [PHONE_2] was hidden on purpose on the phone. Keep it exactly as written and never ask for the hidden value.',
  'Do not give legal, tax or investment advice; suggest a professional instead.',
].join(' ');

function actionSystem(today: string): string {
  return `Today is ${today}. Fill the tool fields only from what the user typed. Leave a field out when the user did not give it. Never invent an amount or a recipient. A month without a year is the most recent such month up to today.`;
}

/** The fixed replies, in the user's language (decided by the router). */
export const FIXED_TEXT: Record<ChatLanguage, { refuse: string; clarify: string; empty: string; ready: (label: string) => string }> = {
  en: {
    refuse: "I can't help with that. I can help with your payments, your documents or finding work.",
    clarify: 'Do you want me to open something for you? I can open Send, Add money, your documents, your payments, Looking for work, or a new message.',
    empty: "Sorry, I couldn't put an answer together. Try asking another way.",
    ready: (label) => `${label} is ready. Check the details and confirm there.`,
  },
  pt: {
    refuse: 'Não posso ajudar com isso. Posso ajudar com seus pagamentos, seus documentos ou a encontrar trabalho.',
    clarify: 'Quer que eu abra algo para você? Posso abrir Enviar, Adicionar dinheiro, seus documentos, seus pagamentos, Procurando trabalho ou uma nova mensagem.',
    empty: 'Desculpe, não consegui montar uma resposta. Tente perguntar de outro jeito.',
    ready: (label) => `${label} está pronto. Confira os detalhes e confirme lá.`,
  },
  es: {
    refuse: 'No puedo ayudar con eso. Puedo ayudarte con tus pagos, tus documentos o a encontrar trabajo.',
    clarify: '¿Quieres que abra algo? Puedo abrir Enviar, Añadir dinero, tus documentos, tus pagos, Buscando trabajo o un mensaje nuevo.',
    empty: 'Lo siento, no pude armar una respuesta. Intenta preguntarlo de otra forma.',
    ready: (label) => `${label} está listo. Revisa los detalles y confirma allí.`,
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
export const EMPTY_TEXT = FIXED_TEXT.en.empty;

const USD = /(\$|\busd\b|\bdollars?\b|\bd[óo]lar(es)?\b)/i;
const OTHER_CURRENCY = /(r\$|€|£|¥|₹|\breais\b|\breal\b|\beuros?\b|\blibras?\b|\bpounds?\b|\bpesos?\b|\byen\b|\brupees?\b|\bsoles?\b)/i;

/**
 * Whether an amount in the text is in another currency than US dollars. The
 * action model was told to skip such amounts but still prefilled "15 reais" as
 * 15 (checked 2026-10-17), so the plane drops the amount itself.
 */
export function mentionsOtherCurrency(text: string): boolean {
  const withoutBrl = text.replace(/r\$/gi, ' BRL ');
  return OTHER_CURRENCY.test(text) && !USD.test(withoutBrl);
}

/** The router's `state`: the recent turns, oldest first, the latest marked. */
export function routerState(messages: ChatMessage[]): string {
  const lines = messages.slice(-6).map((m, i, all) => {
    const who = m.role === 'user' ? 'User' : 'Assistant';
    return i === all.length - 1 ? `Latest user message: ${m.text}` : `${who}: ${m.text}`;
  });
  return lines.join('\n');
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

export interface RunChatOptions {
  ai: AiRun;
  messages: ChatMessage[];
  models?: ChatModels;
  /** One line per routed turn for Workers Logs (no message text). */
  log?: (fields: Record<string, unknown>) => void;
  /** Clock for the action model's date (tests pin it). */
  now?: () => number;
}

/** Run one turn; the returned stream carries `ChatEvent`s as SSE. */
export function runChat(opts: RunChatOptions): ReadableStream<Uint8Array> {
  const models = opts.models ?? DEFAULT_CHAT_MODELS;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const emit = (ev: ChatEvent) => writer.write(sseEncode(ev));

  (async () => {
    const started = Date.now();
    const timings: Record<string, number> = {};
    let decision: RouteDecision = { route: 'answer', action: null, confidence: 0, language: 'en' };
    try {
      try {
        const t0 = Date.now();
        const clef = (await opts.ai(models.router, {
          model: clefName(models.router),
          state: routerState(opts.messages),
          questions: routerQuestions(),
        })) as { answers?: unknown };
        decision = decideRoute(clef?.answers);
        timings.router = Date.now() - t0;
      } catch (err) {
        // The router is an optimisation: without it, answer on the everyday model.
        opts.log?.({ event: 'chat_router_failed', reason: err instanceof Error ? err.message : String(err) });
      }
      await emit({ type: 'route', route: decision.route, action: decision.action, confidence: decision.confidence });

      const fixed = FIXED_TEXT[decision.language];
      switch (decision.route) {
        case 'refuse':
          await emit({ type: 'text', delta: fixed.refuse });
          break;
        case 'clarify':
          await emit({ type: 'text', delta: fixed.clarify });
          break;
        case 'action': {
          const id = decision.action!;
          const tool = actionTool(id);
          let fields: Record<string, unknown> = {};
          if (tool) {
            try {
              const t1 = Date.now();
              const res = await opts.ai(models.action, {
                messages: [
                  { role: 'system', content: actionSystem(new Date(opts.now?.() ?? Date.now()).toISOString().slice(0, 10)) },
                  { role: 'user', content: opts.messages[opts.messages.length - 1]!.text },
                ],
                tools: [tool],
                tool_choice: 'required',
                max_completion_tokens: 200,
                chat_template_kwargs: { enable_thinking: false },
              });
              timings.model = Date.now() - t1;
              const args = toolArguments(res) ?? {};
              const allowed = Object.keys(CHAT_ACTIONS.find((a) => a.id === id)?.fields ?? {});
              for (const k of allowed) if (args[k] != null && args[k] !== '') fields[k] = args[k];
              if (mentionsOtherCurrency(opts.messages[opts.messages.length - 1]!.text)) delete fields.amount;
              // Handles travel without the @; the app's validator checks the bare handle.
              if (typeof fields.recipient === 'string') fields.recipient = fields.recipient.replace(/^@/, '');
            } catch (err) {
              // Open the action without a prefill rather than fail the turn.
              opts.log?.({ event: 'chat_action_fields_failed', action: id, reason: err instanceof Error ? err.message : String(err) });
              fields = {};
            }
          }
          await emit({ type: 'action', request: { id, ...fields } });
          await emit({ type: 'text', delta: fixed.ready(ACTION_LABELS[decision.language][id] ?? id) });
          break;
        }
        case 'answer':
        case 'answer_long': {
          const long = decision.route === 'answer_long';
          const t2 = Date.now();
          const res = await opts.ai(long ? models.answerLong : models.answer, {
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...opts.messages.map((m) => ({ role: m.role, content: m.text }))],
            stream: true,
            max_completion_tokens: long ? 1_200 : 400,
            // Gemma honours enable_thinking; GLM-5.3 needs reasoning_effort too (checked 2026-10-17).
            chat_template_kwargs: { enable_thinking: false },
            reasoning_effort: 'low',
          });
          let sent = 0;
          if (res instanceof ReadableStream) {
            for await (const chunk of sseJson(res as ReadableStream<Uint8Array>)) {
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
          if (sent === 0) await emit({ type: 'text', delta: fixed.empty });
          break;
        }
      }
      await emit({ type: 'done' });
      opts.log?.({ event: 'chat_turn', route: decision.route, action: decision.action, confidence: decision.confidence, language: decision.language, ms: Date.now() - started, ...timings });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.log?.({ event: 'chat_turn_failed', route: decision.route, reason: message });
      await emit({ type: 'error', message: 'The assistant is unavailable right now. Try again in a moment.' }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return readable;
}
