# The job profile on real vacancies, 2026-10-30

300 job ads JobSpy pulled from Indeed (usa 150, brazil 75, mexico 75): the sample of the saved run of 2026-10-27 (seed 69), with the drafts today's pipeline made of them. Each ad, its description alone (not its title, which today's arm reads), de-identified as the benchmark does, was read by `@cf/deepseek-ai/deepseek-v4.1-flash-1017` (`work-job-profile`, reasoning `none`) into a job profile, over the Workers AI REST API from the Mac. Both arms embed with litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm on the Mac's CPU (the v2 generation, as the phone does). Today: the listing text of today's draft as the listing, the title and the requirements' excerpt as the hirer. The profile: its text (`profileText`) as both.

## The reading

- Profiles read: 300 of 300; 184 on the first try and 116 after a retry, 3 readings at a time. Failed tries by cause: 429 ×213, out_of_shape ×1.
- Read again through the current reader: 300 cached profiles, which dropped 1 more items (not_in_text 1, invalid 0, duplicate 0, over_cap 0).
- Timing: median 3467 ms an ad; $0.2362 in all, $0.00079 an ad (0.3 and 1.2 dollars per million tokens in and out).
- Per profile: 8.7 skills (8.4 required), 0.9 certificates, 0.1 languages; an occupation in 293, years of experience in 125, remote 3.
- Dropped by the reader: 21 items whose source does not say them (not whole words of the ad, or years, a language or a certificate's codes their source does not hold), 0 invalid, 0 duplicates, 15 over the cap.
- The text each arm embeds, in characters: today's listing 373 and hirer 485 (medians), the profile's 330.

## The references

Each ad's occupation, snapped on the v2 replica (ESCO and the US layer, never minting; 417 hosted calls, 168452 tokens; a snap whose hosted call failed was snapped again, and 0 still failed): today's title, as production snaps a worker's title (usa 94, brazil 43, mexico 42 placed in an ISCO-08 unit group), and the profile's English occupation (usa 100, brazil 48, mexico 52). Where both place the ad, they agree on its unit group for 91 of 131.

## The fast lane, judged

Each ad as the hirer ranks the other ads by cosine, over the 298 ads both arms embed, in its own region and across all three markets. A judge needs no reference: `@cf/cloudflare/clef` (`work-decide`, Clef not flash) read each pair in either arm's first five, each ad as its title and the excerpt of its requirements in its own language, and answered "Do the two job ads hire for the same occupation, so that a worker suited to one is suited to the other, whatever the language, the place or the employer?" A result is the same occupation at 0.5 or above. 2598 pairs, 0 left unjudged after five tries (counted as not the same).

| Pool | Arm | Queries | P@1 | P@3 | P@5 | Same occupation from another country in the first five |
|---|---|---|---|---|---|---|
| its region | today | 298 | 0.601 | 0.452 | 0.342 | — |
| its region | the profile | 298 | 0.624 | 0.463 | 0.346 | — |
| all three markets | today | 298 | 0.701 | 0.629 | 0.566 | 89 |
| all three markets | the profile | 298 | 0.732 | 0.682 | 0.647 | 391 |

## The fast lane, by reference

Each ad as the hirer ranks the other ads by cosine, over the 298 ads both arms embed; a query counts when its reference places it and the pool holds another ad of its unit group. Precision at 1, 3 and 5 is the share of the first results in the same unit group, near the share in the same minor group (three digits); cross-market counts the same-unit-group results in the first five from another country.

**Relevance by today’s title:**

| Pool | Arm | Queries | P@1 | P@3 | P@5 | Near@5 | MRR | Cross-market in the first five |
|---|---|---|---|---|---|---|---|---|
| its region | today | 121 | 0.727 | 0.534 | 0.398 | 0.420 | 0.826 | — |
| its region | the profile | 121 | 0.744 | 0.523 | 0.385 | 0.412 | 0.838 | — |
| all three markets | today | 159 | 0.692 | 0.595 | 0.538 | 0.577 | 0.782 | 55 |
| all three markets | the profile | 159 | 0.591 | 0.566 | 0.532 | 0.569 | 0.713 | 134 |

**Relevance by the profile’s occupation:**

| Pool | Arm | Queries | P@1 | P@3 | P@5 | Near@5 | MRR | Cross-market in the first five |
|---|---|---|---|---|---|---|---|---|
| its region | today | 123 | 0.748 | 0.547 | 0.420 | 0.460 | 0.842 | — |
| its region | the profile | 123 | 0.846 | 0.607 | 0.450 | 0.493 | 0.901 | — |
| all three markets | today | 176 | 0.676 | 0.562 | 0.508 | 0.570 | 0.769 | 44 |
| all three markets | the profile | 176 | 0.773 | 0.689 | 0.630 | 0.708 | 0.845 | 191 |

## Brazilian and Mexican ads

| Market | The ad’s title | Today’s title → its snap | The profile’s occupation → its snap | The profile |
|---|---|---|---|---|
| brazil | Jovem Aprendiz | Jovem Aprendiz → — | operations apprentice → — | 8 skills, no certificate |
| brazil | Oficial de Manutenção Predial | Oficial de Manutenção Predial → pos:facilities-manager | building maintenance technician → pos:handyperson | 10 skills, no certificate |
| brazil | Vendedor Interno _vendas materiais elétricos em áreas classificadas e automação industrial (Macaé) | Vendedor Interno _vendas materiais elétricos em áreas classificadas e automação industrial → pos:wholesale-merchant-in-electronic-and-telecommunications | inside sales representative → — | 10 skills, no certificate |
| brazil | Enfermeiro(a) - Barra da Tijuca | Enfermeiro → pos:nurse-responsible-for-general-care | nurse → — | 5 skills, active nursing council registration |
| brazil | MECANICO JUNIOR | MECANICO JUNIOR → pos:vehicle-technician | vehicle mechanic → pos:vehicle-technician | 10 skills, no certificate |
| brazil | Soldador | Soldador → — | welder → — | 5 skills, no certificate |
| brazil | Oficial de Manutenção Predial | Oficial de Manutenção Predial → pos:facilities-manager | building maintenance technician → pos:handyperson | 10 skills, no certificate |
| brazil | Técnico de Manutenção - Friburgo | Técnico de Manutenção → — | maintenance technician → pos:laser-beam-welder | 7 skills, technical qualification in electrical |
| mexico | Ingeniero de Aplicaciones. | Ingeniero de Aplicaciones. → — | devsecops engineer → pos:ict-security-technician | 10 skills, no certificate |
| mexico | JEFE DE MANTENIMIENTO NL | JEFE DE MANTENIMIENTO NL → — | maintenance supervisor → pos:industrial-maintenance-supervisor | 10 skills, no certificate |
| mexico | GERENTE RELACIONES LABORALES | GERENTE RELACIONES LABORALES → pos:labour-relations-officer | labor relations manager → pos:human-resources-manager | 10 skills, no certificate |
| mexico | HERRERO ARMADOR | HERRERO ARMADOR → pos:blacksmith | metal door and gate fabricator → — | 8 skills, no certificate |
| mexico | Personal de mantenimiento | Personal de mantenimiento → — | maintenance worker → pos:building-cleaner | 10 skills, no certificate |
| mexico | OPERADOR DE MANTENIMIENTO | OPERADOR DE MANTENIMIENTO → — | hotel maintenance worker → — | 10 skills, no certificate |
| mexico | Contador Administrativo-Fiscal (Manejo de Impuestos) | Contador Administrativo-Fiscal → — | accountant → pos:accountant | 10 skills, Bachelor's degree in Accounting, Administration or related field |
| mexico | Soldador | Soldador → — | gmaw welder → — | 10 skills, no certificate |

Run in 2.5 minutes.
