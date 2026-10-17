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
 * drive the whole turn with fakes. Thinking is off on every routed call:
 * reasoning tokens bill as output and delay the reply.
 */

import type { Inference } from '../inference/index.js';
import { actionTool, CHAT_ACTIONS, decideRoute, routerQuestions, type ChatLanguage, type RouteDecision } from './router.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export type ChatEvent =
  | { type: 'route'; route: RouteDecision['route']; action: string | null; confidence: number }
  | { type: 'text'; delta: string }
  | { type: 'action'; request: Record<string, unknown> }
  | { type: 'choices'; requests: Record<string, unknown>[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** The seam as the turn uses it. */
export type ChatInference = Pick<Inference, 'run' | 'model'>;

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
  // The app shows replies as plain text (glm-5.3 answered in Markdown, checked 2026-10-17).
  'Write plain text only: no Markdown, asterisks, bold, headings or tables. For steps, use short numbered lines.',
  'Never use technical money jargon: do not say crypto, blockchain, web3, wallet, token, on-chain, gas, stablecoin, seed phrase or address. Say "your account" and "payment".',
  'You cannot move money or change anything yourself. The app opens a screen and the user confirms there.',
  'Text in square brackets such as [EMAIL_1] or [PHONE_2] was hidden on purpose on the phone. Keep it exactly as written and never ask for the hidden value.',
  'Do not give legal, tax or investment advice; suggest a professional instead.',
].join(' ');

function actionSystem(today: string): string {
  return `Today is ${today}. Fill the tool fields only from what the user typed. Leave a field out when the user did not give it. Never invent an amount or a recipient. A month without a year is the most recent such month up to today.`;
}

/** The fixed replies, in the user's language (decided by the router). */
export const FIXED_TEXT: Record<
  ChatLanguage,
  { refuse: string; clarify: string; choose: string; empty: string; ready: (label: string) => string }
> = {
  en: {
    refuse: "I can't help with that. I can help with your payments, your documents or finding work.",
    clarify: 'Do you want me to open something for you? I can open Send, Add money, your documents, your payments, Looking for work, or a new message.',
    choose: 'Did you mean one of these? Tap one to open it, or ask me another way.',
    empty: "Sorry, I couldn't put an answer together. Try asking another way.",
    ready: (label) => `${label} is ready. Check the details and confirm there.`,
  },
  pt: {
    refuse: 'Não posso ajudar com isso. Posso ajudar com seus pagamentos, seus documentos ou a encontrar trabalho.',
    clarify: 'Quer que eu abra algo para você? Posso abrir Enviar, Adicionar dinheiro, seus documentos, seus pagamentos, Procurando trabalho ou uma nova mensagem.',
    choose: 'Você quis dizer uma destas? Toque em uma para abrir, ou pergunte de outro jeito.',
    empty: 'Desculpe, não consegui montar uma resposta. Tente perguntar de outro jeito.',
    ready: (label) => `${label} está pronto. Confira os detalhes e confirme lá.`,
  },
  es: {
    refuse: 'No puedo ayudar con eso. Puedo ayudarte con tus pagos, tus documentos o a encontrar trabajo.',
    clarify: '¿Quieres que abra algo? Puedo abrir Enviar, Añadir dinero, tus documentos, tus pagos, Buscando trabajo o un mensaje nuevo.',
    choose: '¿Quisiste decir una de estas? Toca una para abrirla, o pregúntame de otra forma.',
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
export const CHOOSE_TEXT = FIXED_TEXT.en.choose;
export const EMPTY_TEXT = FIXED_TEXT.en.empty;

const USD = /(\$|\busd\b|\bdollars?\b|\bd[óo]lar(es)?\b)/i;
const OTHER_CURRENCY = /(r\$|€|£|¥|₹|\breais\b|\breal\b|\beuros?\b|\blibras?\b|\bpounds?\b|\bpesos?\b|\byen\b|\brupees?\b|\bsoles?\b)/i;

/** Whether an amount in the text is in another currency than US dollars. */
export function mentionsOtherCurrency(text: string): boolean {
  const withoutBrl = text.replace(/r\$/gi, ' BRL ');
  return OTHER_CURRENCY.test(text) && !USD.test(withoutBrl);
}

/**
 * Whether the amount the action model read may be prefilled; the app's
 * amounts are US dollars. The model was told to skip other currencies but
 * still prefilled "15 reais" as 15, and "manda 20 pro joao" (no currency, most
 * likely reais) as 20 (checked 2026-10-17), so the plane decides: never with
 * another currency named, and outside English only with a dollar marker.
 */
export function keepsAmount(text: string, language: ChatLanguage): boolean {
  if (mentionsOtherCurrency(text)) return false;
  return language === 'en' || USD.test(text.replace(/r\$/gi, ' BRL '));
}

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

/** The answer models' input: the conversation under the system prompt, streamed, thinking off. */
function answerInput(messages: ChatMessage[], long: boolean): Record<string, unknown> {
  return {
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages.map((m) => ({ role: m.role, content: m.text }))],
    stream: true,
    max_completion_tokens: long ? 1_200 : 400,
    // Gemma honours enable_thinking; GLM-5.3 needs reasoning_effort too (checked 2026-10-17).
    chat_template_kwargs: { enable_thinking: false },
    reasoning_effort: 'low',
  };
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

function usageOf(v: unknown): Usage | null {
  const u = (v as { usage?: Usage } | null)?.usage;
  return u && typeof u === 'object' ? u : null;
}

export interface RunChatOptions {
  inference: ChatInference;
  messages: ChatMessage[];
  /** Start the everyday answer with the router (default); `CHAT_EARLY_ANSWER=off` turns it off. */
  early?: boolean;
  /** One line per routed turn for Workers Logs (no message text). */
  log?: (fields: Record<string, unknown>) => void;
  /** Clock for the action model's date (tests pin it). */
  now?: () => number;
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
  const emit = (ev: ChatEvent) => {
    if (ev.type === 'text' && timings.first === undefined) timings.first = Date.now() - started;
    return writer.write(sseEncode(ev));
  };

  /** The fields the action model fills for one screen, only those the screen declares. */
  async function actionFields(id: string, language: ChatLanguage): Promise<Record<string, unknown>> {
    const tool = actionTool(id);
    if (!tool) return {};
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
        chat_template_kwargs: { enable_thinking: false },
      });
      timings.fields = Date.now() - t;
      const args = toolArguments(res) ?? {};
      const fields: Record<string, unknown> = {};
      for (const k of Object.keys(CHAT_ACTIONS.find((a) => a.id === id)?.fields ?? {})) {
        if (args[k] != null && args[k] !== '') fields[k] = args[k];
      }
      if (!keepsAmount(latest, language)) delete fields.amount;
      // Handles travel without the @; the app's validator checks the bare handle.
      if (typeof fields.recipient === 'string') fields.recipient = fields.recipient.replace(/^@/, '');
      return fields;
    } catch (err) {
      // Open the screen without a prefill rather than fail the turn.
      opts.log?.({ event: 'chat_action_fields_failed', action: id, reason: reasonOf(err) });
      return {};
    }
  }

  (async () => {
    let decision: RouteDecision = { route: 'answer', action: null, confidence: 0, language: 'en', candidates: [] };

    // The everyday answer starts with the router and waits for its verdict.
    const early = new AbortController();
    const startAnswer = () => inference.run('chat-answer', answerInput(messages, false), { signal: early.signal });
    const earlyAnswer = opts.early === false ? null : startAnswer();
    earlyAnswer?.catch(() => {});
    const dropEarly = () => {
      if (!earlyAnswer || early.signal.aborted) return;
      early.abort();
      earlyAnswer.then((r) => (r instanceof ReadableStream ? r.cancel() : undefined)).catch(() => {});
      turn.early ??= 'dropped';
    };

    try {
      try {
        const t0 = Date.now();
        const clef = (await inference.run('chat-router', {
          model: clefName(await inference.model('chat-router')),
          state: routerState(messages),
          questions: routerQuestions(),
        })) as { answers?: unknown };
        decision = decideRoute(clef?.answers);
        timings.router = Date.now() - t0;
      } catch (err) {
        // The router is an optimisation: without it, the everyday model answers.
        opts.log?.({ event: 'chat_router_failed', reason: reasonOf(err) });
      }
      await emit({ type: 'route', route: decision.route, action: decision.action, confidence: decision.confidence });

      const fixed = FIXED_TEXT[decision.language];
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
          await emit({ type: 'text', delta: fixed.ready(ACTION_LABELS[decision.language][id] ?? id) });
          break;
        }
        case 'answer':
        case 'answer_long': {
          const long = decision.route === 'answer_long';
          if (long) dropEarly();
          else if (earlyAnswer) turn.early = 'used';
          // The early answer's call began with the turn.
          const t2 = !long && earlyAnswer ? started : Date.now();
          const res = long
            ? await inference.run('chat-long', answerInput(messages, true))
            : await (earlyAnswer ?? startAnswer());
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
          if (usage) Object.assign(turn, { tokens_in: usage.prompt_tokens, tokens_out: usage.completion_tokens });
          if (sent === 0) await emit({ type: 'text', delta: fixed.empty });
          break;
        }
      }
      await emit({ type: 'done' });
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
      dropEarly();
      opts.log?.({ event: 'chat_turn_failed', route: decision.route, reason: reasonOf(err) });
      await emit({ type: 'error', message: 'The assistant is unavailable right now. Try again in a moment.' }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return readable;
}
