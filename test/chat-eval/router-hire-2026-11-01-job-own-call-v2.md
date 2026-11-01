# The router's hiring check, 2026-11-01

30 prompts (0 of `test/chat-eval/prompts.json`, 30 of `test/chat-eval/hire-prompts.json`), each asked of `@cf/cloudflare/clef-flash` twice over the Workers AI REST API from the Mac: with production's questions, and with the hiring check added. No answer model ran. The check's wording: "Read the latest user message with the turns before it. Does the latest message ask for a worker: does it name work the user wants done (a repair, a task, a shift, a vacancy or a job ad) and ask for someone to do it, or, right after a request for a worker, ask to search again, nearer, or for another worker? A question about how hiring, fees or payments work, paying or messaging someone, thanks or small talk, and the user's own job search are no, even right after a request for a worker." Decisions use the floor 0.5.

## The check at each floor

30 prompts ask for a worker (`post_job` expected), 0 do not.

| Floor | Hiring requests caught | Missed | Other messages sent to post_job |
|---|---|---|---|
| 0.3 | 29 of 30 | 1 | 0 |
| 0.4 | 29 of 30 | 1 | 0 |
| 0.5 | 29 of 30 | 1 | 0 |
| 0.6 | 27 of 30 | 3 | 0 |
| 0.7 | 24 of 30 | 6 | 0 |
| 0.8 | 21 of 30 | 9 | 0 |

## What the added question changes

Decisions that match the prompt's expectation: the chat set 0 of 0 without the check and 0 with it; the hiring set 0 of 30 without it and 29 with it.

3 prompts decided otherwise once the question was asked, before its own floor:

| Prompt | Without | With the question asked |
|---|---|---|
| hire-en-pasted-ad | answer | clarify |
| hire-pt-soldador-vaga | action import_cv | clarify |
| hire-es-velador | answer | clarify |

## The job of each hiring turn

29 of 29 hiring turns name the job expected (the same as an earlier request, or new; production's rule: new without an earlier user turn, else the job question's own call at JOB_FLOOR).

## Every prompt

| Prompt | Text | Expected | Hire | Today | With the check |
|---|---|---|---|---|---|
| hire-en-plumber-sink | Hi, I am looking for a plumber to fix my sink | action post_job | 0.91 | answer | action post_job |
| hire-en-electrician-outlets | I need an electrician tomorrow morning to install two outlets, budget 120 dollars | action post_job | 0.91 | answer | action post_job |
| hire-en-welder-shutdown | Looking to hire a welder for a 3-week shutdown in Houston, must hold a 6G certification | action post_job | 0.89 | clarify | action post_job |
| hire-en-cleaning | Can someone come clean my apartment this Saturday? I'll pay $80 | action post_job | 0.90 | answer | action post_job |
| hire-en-forklift-night | We're hiring a forklift operator for the night shift, 2 years of experience required | action post_job | 0.84 | clarify | action post_job |
| hire-en-babysitter | Need a babysitter for Friday night | action post_job | 0.82 | answer | action post_job |
| hire-en-urgent-gas | urgent: I need someone to fix a gas leak today | action post_job | 0.93 | answer | action post_job |
| hire-en-designer-remote | I want to post a job for a graphic designer to make our logo, remote | action post_job | 0.85 | answer | action post_job |
| hire-en-fence | Who can paint my fence next week? Around 200 bucks | action post_job | 0.85 | answer | action post_job |
| hire-en-pasted-ad | Maintenance Technician, full time. We are looking for a maintenance technician for our … | action post_job | 0.82 | answer | action post_job |
| hire-en-followup | can you find someone to fix it tomorrow? | action post_job | 0.90 | answer | action post_job |
| hire-pt-encanador | Oi, preciso de um encanador para consertar a pia da cozinha | action post_job | 0.93 | answer | action post_job |
| hire-pt-eletricista | Procuro eletricista para instalar um chuveiro amanhã, pago 150 reais | action post_job | 0.90 | clarify | action post_job |
| hire-pt-motoboy | Estou contratando motoboy para entregas no centro de São Paulo | action post_job | 0.88 | answer | action post_job |
| hire-pt-faxineira | Preciso de uma faxineira toda sexta-feira | action post_job | 0.87 | answer | action post_job |
| hire-pt-soldador-vaga | Vaga: soldador TIG com NR-34, 2 anos de experiência, em Macaé | action post_job | 0.62 | action import_cv | action post_job |
| hire-pt-pasted-ad | Auxiliar de Cozinha. Restaurante em Pinheiros contrata auxiliar de cozinha. Atividades:… | action post_job | 0.68 | clarify | action post_job |
| hire-es-plomero | Hola, busco un plomero para arreglar el lavabo | action post_job | 0.93 | answer | action post_job |
| hire-es-velador | Necesito un velador para mi bodega en Monterrey, turno de noche | action post_job | 0.21 | answer | clarify |
| hire-es-mesero | Se solicita mesero con experiencia para restaurante en la CDMX | action post_job | 0.88 | clarify | action post_job |
| hire-es-pintar | ¿Alguien que me pueda pintar la casa este fin de semana? Pago 2000 pesos | action post_job | 0.88 | answer | action post_job |
| hire-es-chofer | Contratamos chofer con licencia federal tipo E | action post_job | 0.63 | clarify | action post_job |
| hire-es-pasted-ad | Técnico Electricista. Empresa de servicios en Guadalajara solicita técnico electricista… | action post_job | 0.71 | clarify | action post_job |
| hire-en-followup-again | Try searching again | action post_job | 0.77 | clarify | action post_job |
| hire-en-followup-closer | any closer? | action post_job | 0.54 | answer | action post_job |
| hire-en-followup-another | and an electrician too | action post_job | 0.77 | answer | action post_job |
| hire-pt-followup-again | procura de novo | action post_job | 0.58 | clarify | action post_job |
| hire-pt-followup-another | e um pintor também | action post_job | 0.86 | answer | action post_job |
| hire-es-followup-again | busca otra vez | action post_job | 0.86 | answer | action post_job |
| hire-es-followup-closer | ¿alguno más cerca? | action post_job | 0.85 | answer | action post_job |
