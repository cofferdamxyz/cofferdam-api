# Chat evaluation, 2026-10-21 (Thinking tier, GLM-5.3, answer prompts)

Run: the Thinking tier (`CHAT_EVAL_TIER=thinking`, `CHAT_THINKING_HIGH_FLOOR=0.7`) with `chat-reasoning` on `@cf/zai-org/glm-5.3`, the 36 answer, work, facts and clarify prompts (`CHAT_EVAL_ONLY`), the same morning and system prompt as the DeepSeek run; the GLM-5.3 side of decision 0047's amendment of 2026-10-21 (its pair is `report-2026-10-21-thinking-deepseek.md`).

Decision 0037's evaluation: 36 prompts from `test/chat-eval/prompts.json` through the real turn (`runChat`, the inference seam, Workers AI over REST). Models: chat-router `@cf/cloudflare/clef-flash`, chat-action `@cf/google/gemma-4-26b-a4b-it`, chat-answer `@cf/google/gemma-4-26b-a4b-it`, chat-long `@cf/google/gemma-4-26b-a4b-it`. Early answer on. Run time 439 s.

## Summary

```
chat eval: 36 prompts, route 30/36 (83%), action 30/36 (83%), one tap away 30/36 (83%)
fields 2/2 (100%), candidates 1/5 (20%), router language 35/36 (97%), reply language 31/31 (100%)
wrong screen opened 1, screen missed 0, refusal missed 0, errors 2
cost per turn mean $0.001843, p50 $0.001762, max $0.005030 (partly estimated)
latency ms p50/p95: router 674/2788, first text 3314/42689, total 5656/42989
```

"One tap away" counts an expected screen offered as the first choice of a clarify. Costs use the catalogue rates in `score.ts`; Clef input tokens are always estimated (characters / 4), and so are other counts when a model reports no usage. A cancelled early answer is charged its estimated input.

## By expected route

| | n | route | action | one tap away |
|---|---|---|---|---|
| answer | 21 | 19/21 (90%) | 19/21 (90%) | 19/21 (90%) |
| answer_long | 8 | 8/8 (100%) | 8/8 (100%) | 8/8 (100%) |
| clarify | 5 | 1/5 (20%) | 1/5 (20%) | 1/5 (20%) |
| action | 2 | 2/2 (100%) | 2/2 (100%) | 2/2 (100%) |

## By expected action

| | n | route | action | one tap away |
|---|---|---|---|---|
| send | 1 | 1/1 (100%) | 1/1 (100%) | 1/1 (100%) |
| import_cv | 1 | 1/1 (100%) | 1/1 (100%) | 1/1 (100%) |

## By language

| | n | route | action | one tap away |
|---|---|---|---|---|
| en | 17 | 15/17 (88%) | 15/17 (88%) | 15/17 (88%) |
| pt | 11 | 9/11 (82%) | 9/11 (82%) | 9/11 (82%) |
| es | 8 | 6/8 (75%) | 6/8 (75%) | 6/8 (75%) |

## Fields

| field | scored | correct |
|---|---|---|
| amount | 1 | 1/1 (100%) |
| recipient | 1 | 1/1 (100%) |

## Language and style

- Router language matches the prompt: 35/36 (97%).
- Answer written in the prompt's language (word-list guess): 31/31 (100%).
- Answers with banned jargon: 0; with Markdown: 1; that declined to answer: 0.

- Wrong claims (an `avoid` pattern matched): 0; facts not brought up (no `mention` pattern matched): 0.

## Cost per turn by route taken

| route | mean |
|---|---|
| answer | $0.001811 |
| clarify | $0.000033 |
| answer_long | $0.003062 |
| action | $0.000040 |

## Threshold sweep

Clef's recorded answers re-decided under other floors (no new calls). The live floors are action 0.55 and candidate 0.15.

| action floor | exact | one tap away | wrong screen | clarify instead of action |
|---|---|---|---|---|
| 0.35 | 29/35 (83%) | 29/35 (83%) | 2 | 0 |
| 0.4 | 29/35 (83%) | 29/35 (83%) | 2 | 0 |
| 0.45 | 29/35 (83%) | 29/35 (83%) | 2 | 0 |
| 0.5 | 30/35 (86%) | 30/35 (86%) | 1 | 0 |
| 0.55 | 30/35 (86%) | 30/35 (86%) | 1 | 0 |
| 0.6 | 31/35 (89%) | 31/35 (89%) | 0 | 0 |
| 0.65 | 31/35 (89%) | 31/35 (89%) | 0 | 0 |
| 0.7 | 31/35 (89%) | 31/35 (89%) | 0 | 0 |

| candidate floor | clarify candidates right (at action floor 0.55) |
|---|---|
| 0.05 | 1/5 (20%) |
| 0.1 | 1/5 (20%) |
| 0.15 | 1/5 (20%) |
| 0.2 | 1/5 (20%) |
| 0.25 | 1/5 (20%) |

## Every prompt

| id | lang | expected | got | conf | fields | router ms | first ms | total ms | cost | reply or error |
|---|---|---|---|---|---|---|---|---|---|---|
| greet-en | en | answer | answer | 0.99 |  | 1330 | 2718 | 4150 | $0.001584 | Hey! I'm here to help with getting paid, finding work nearby, or keeping your do… |
| greet-pt | pt | answer | answer | 1.00 |  | 569 | 42689 | 42989 | $0.001527 | Oi, tudo bem! Como posso te ajudar hoje? |
| greet-es | es | answer | answer | 1.00 |  | 2788 | 4642 | 4855 | $0.001524 | ¡Buenas tardes! ¿En qué te puedo ayudar hoy? |
| smalltalk-en | en | answer | answer | 0.60 |  | 559 | 5311 | 5507 | $0.001897 | I can help you get the most out of Cofferdam:  - Open Send or Add money screens … |
| smalltalk-pt | pt | answer | answer | 0.97 |  | 1206 | 3241 | 3739 | $0.001687 | Que bom ajudar! Se precisar de qualquer coisa, é só chamar. 😊 |
| smalltalk-es | es | answer | answer | 0.99 |  | 500 | 1340 | 2472 | $0.001655 | ¡Hola! Estoy muy bien, gracias por preguntar. ¿En qué te puedo ayudar hoy? Puedo… |
| short-en | en | answer | answer | 0.86 |  | 674 | 29185 | 30296 | $0.001823 | Payments usually arrive within minutes, since they go straight from one account … |
| short-pt | pt | answer | answer | 0.67 |  | 554 | 3161 | 5656 | $0.002128 | Sim, é seguro. O Cofferdam não guarda cópia do seu passaporte: a verificação é f… |
| short-es | es | answer | clarify [add_money, send] ✗ | 0.32 |  | 784 | 6794 | 6794 | $0.000044 | error: chat_action_fields_failed: chat-action gave no answer within 6000 ms |
| long-en-escrow | en | answer_long | answer_long | 0.98 |  | 1185 | 35592 | 37358 | $0.002919 | Jobs paid through the app are on the way, so today the exact flow isn't live yet… |
| long-en-difference | en | answer_long | answer_long | 0.98 |  | 564 | 5263 | 11886 | $0.003690 | Happy to explain both.  Adding money is something you do yourself. You put money… |
| long-pt | pt | answer_long | answer_long | 0.99 |  | 545 | 11036 | 17994 | $0.005030 | Receber pelo app é simples, mas vale entender uma coisa antes: hoje quem paga é … |
| long-es | es | answer_long | answer_long | 0.98 |  | 2250 | 3402 | 8280 | $0.002803 | Claro, te explico en simples pasos.  1. Consigue tu pasaporte. Debe tener el sím… |
| clarify-en-ana-20 | en | clarify [send] | answer ✗ | 0.93 |  | 705 | 27809 | 27927 | $0.001806 | Hi Ana! Could you tell me a bit more about what you'd like? For example, do you … |
| clarify-en-thing | en | clarify [find_document, add_document] | clarify [add_document, find_document] | 0.49 |  | 942 | 942 | 942 | $0.000022 | Did you mean one of these? Tap one to open it, or ask me another way. |
| clarify-pt-documento | pt→es | clarify [find_document, add_document] | action find_document ✗ | 0.56 |  | 729 | 2010 | 2010 | $0.000046 | Buscar un documento está listo. Revisa los detalles y confirma allí. |
| clarify-pt-joao | pt | clarify [message] | answer ✗ | 0.99 |  | 659 | 7287 | 8406 | $0.001747 | Não tenho contexto sobre quem é o João — essa é a primeira mensagem da nossa con… |
| clarify-es-trabajo | es | clarify [looking_for] | answer ✗ | 0.85 |  | 422 | 2784 | 4343 | $0.001982 | ¡Hola! Claro, te ayudo con lo del trabajo.  Con Cofferdam puedes activar la búsq… |
| multi-pt-quanto-tempo | pt | answer | answer | 0.92 |  | 679 | 3314 | 3884 | $0.001824 | Dinheiro enviado dentro do app aparece na sua conta na hora. Se você transferir … |
| multi-pt-valeu | pt | answer | answer | 0.91 |  | 689 | 1800 | 3494 | $0.001672 | Que bom que ficou claro! Se tiver mais alguma dúvida sobre o Cofre ou qualquer o… |
| multi-es-explica | es | answer_long | answer_long | 0.99 |  | 596 | 2562 | 11274 | $0.003707 | Con gusto, te explico cómo funciona.  Cómo cobrar un trabajo por la app:  1. Cua… |
| work-en-rotation | en | answer | answer | 0.79 |  | 557 | 5665 | 6388 | $0.001678 | Typical Gulf of Mexico rotations are 14/14 or 14/7, and you'll also see 21/21 on… |
| work-en-rotation-after-search | en | answer_long | answer_long | 0.50 |  | 582 | 2232 | 4431 | $0.001943 | Typical Gulf of Mexico rotations are 14 days on / 14 days off, or sometimes 14/2… |
| work-en-rigger-pay | en | answer | answer | 0.76 |  | 675 | 19042 | 21519 | $0.002042 | Offshore riggers in Brazil typically earn somewhere around R$5,000 to R$12,000 a… |
| work-pt-marinheiro | pt | answer | answer | 0.76 |  | 696 | 9209 | 16845 | $0.002652 | Depende bastante do cargo, da empresa e do tipo de embarcação, mas dá pra dar um… |
| work-es-horas-after-search | es | answer | answer | 0.80 |  | 692 | 2074 | 5881 | $0.001916 | En una plataforma offshore lo típico es un turno de 12 horas al día, y la rotaci… |
| work-en-drillship | en | answer | answer | 0.80 |  | 549 | 34382 | 36061 | $0.001927 | Yes, 28/28 is a common rotation on drillships and deepwater rigs. You work 28 da… |
| facts-en-employer-vault | en | answer | answer | 0.83 |  | 698 | 2151 | 2787 | $0.001684 | No. Your Vault is encrypted on your phone and no employer, hirer, app, or even C… |
| facts-pt-patrao-documentos | pt | answer | answer | 0.74 |  | 963 | 1749 | 5440 | $0.001750 | Não. Ninguém consegue ver seus documentos — nem seu patrão, nem contratantes, ne… |
| facts-en-fees | en | answer | answer ✗ | 0.90 |  | 5933 | 11594 | 15797 | $0.001692 | error: chat_router_failed: chat-router gave no answer within 3000 ms |
| facts-es-comision | es | answer | answer | 0.87 |  | 1061 | 2116 | 3489 | $0.001762 | No. Cofferdam es gratis para trabajadores: recibes el 100% de tu pago y hoy nadi… |
| facts-en-custody | en | answer | answer | 0.81 |  | 620 | 43801 | 44064 | $0.001697 | No. Your account is yours and Cofferdam never holds your money or moves it. You … |
| facts-en-lost-phone | en | answer_long | answer_long | 0.68 |  | 654 | 4744 | 6712 | $0.002071 | Sorry to hear that. Here is how it works today:  1. Install Cofferdam on your ne… |
| facts-pt-recuperar | pt | answer_long | answer_long | 0.70 |  | 553 | 2395 | 5369 | $0.002329 | Sinto muito pelo aparelho perdido. Você pode voltar com sua identidade em um cel… |
| facts-en-send-for-me | en | action send | action send | 0.89 | amount recipient | 568 | 1645 | 1645 | $0.000054 | Send is ready. Check the details and confirm there. |
| facts-en-cv-upload | en | action import_cv | action import_cv | 0.87 |  | 584 | 584 | 584 | $0.000022 | Import your CV isn't available yet; it's coming. The app shows what it is waitin… |
