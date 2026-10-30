# The job profile on real vacancies, 2026-10-30

300 job ads JobSpy pulled from Indeed (usa 150, brazil 75, mexico 75): the sample of the saved run of 2026-10-27 (seed 69), with the drafts today's pipeline made of them. Each ad, its description alone (not its title, which today's arm reads), de-identified as the benchmark does, was read by `@cf/deepseek-ai/deepseek-v4.1-flash-1017` (`work-job-profile`, reasoning `low`) into a job profile, over the Workers AI REST API from the Mac. Both arms embed with litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm on the Mac's CPU (the v2 generation, as the phone does). Today: the listing text of today's draft as the listing, the title and the requirements' excerpt as the hirer. The profile: its text (`profileText`) as both.

## The reading

- Profiles read: 300 of 300; 255 on the first try and 45 after a retry, 3 readings at a time. Failed tries by cause: none recorded (readings cached before causes were kept are not counted).
- Read again through the current reader: 300 cached profiles, which dropped 9 more items (not_in_text 9, invalid 0, duplicate 0, over_cap 0).
- Timing: median 17587 ms an ad; $0.9751 in all, $0.00325 an ad (0.3 and 1.2 dollars per million tokens in and out).
- Per profile: 8.9 skills (8.7 required), 0.8 certificates, 0.1 languages; an occupation in 295, years of experience in 117, remote 3.
- Dropped by the reader: 13 items whose source does not say them (not whole words of the ad, or years, a language or a certificate's codes their source does not hold), 1 invalid, 0 duplicates, 15 over the cap.
- The text each arm embeds, in characters: today's listing 373 and hirer 485 (medians), the profile's 347.

## The references

Each ad's occupation, snapped on the v2 replica (ESCO and the US layer, never minting; 434 hosted calls, 175171 tokens; a snap whose hosted call failed was snapped again, and 0 still failed): today's title, as production snaps a worker's title (usa 94, brazil 43, mexico 42 placed in an ISCO-08 unit group), and the profile's English occupation (usa 96, brazil 49, mexico 53). Where both place the ad, they agree on its unit group for 92 of 127.

## The fast lane, judged

Each ad as the hirer ranks the other ads by cosine, over the 298 ads both arms embed, in its own region and across all three markets. A judge needs no reference: `@cf/cloudflare/clef` (`work-decide`, Clef not flash) read each pair in either arm's first five, each ad as its title and the excerpt of its requirements in its own language, and answered "Do the two job ads hire for the same occupation, so that a worker suited to one is suited to the other, whatever the language, the place or the employer?" A result is the same occupation at 0.5 or above. 2586 pairs, 0 left unjudged after five tries (counted as not the same).

| Pool | Arm | Queries | P@1 | P@3 | P@5 | Same occupation from another country in the first five |
|---|---|---|---|---|---|---|
| its region | today | 298 | 0.601 | 0.452 | 0.342 | — |
| its region | the profile | 298 | 0.644 | 0.457 | 0.342 | — |
| all three markets | today | 298 | 0.701 | 0.629 | 0.566 | 89 |
| all three markets | the profile | 298 | 0.728 | 0.681 | 0.647 | 381 |

## The fast lane, by reference

Each ad as the hirer ranks the other ads by cosine, over the 298 ads both arms embed; a query counts when its reference places it and the pool holds another ad of its unit group. Precision at 1, 3 and 5 is the share of the first results in the same unit group, near the share in the same minor group (three digits); cross-market counts the same-unit-group results in the first five from another country.

**Relevance by today’s title:**

| Pool | Arm | Queries | P@1 | P@3 | P@5 | Near@5 | MRR | Cross-market in the first five |
|---|---|---|---|---|---|---|---|---|
| its region | today | 121 | 0.727 | 0.534 | 0.398 | 0.420 | 0.826 | — |
| its region | the profile | 121 | 0.769 | 0.504 | 0.388 | 0.415 | 0.852 | — |
| all three markets | today | 159 | 0.692 | 0.595 | 0.538 | 0.577 | 0.782 | 55 |
| all three markets | the profile | 159 | 0.597 | 0.566 | 0.546 | 0.581 | 0.711 | 137 |

**Relevance by the profile’s occupation:**

| Pool | Arm | Queries | P@1 | P@3 | P@5 | Near@5 | MRR | Cross-market in the first five |
|---|---|---|---|---|---|---|---|---|
| its region | today | 119 | 0.756 | 0.591 | 0.449 | 0.477 | 0.844 | — |
| its region | the profile | 119 | 0.866 | 0.667 | 0.466 | 0.491 | 0.919 | — |
| all three markets | today | 179 | 0.620 | 0.505 | 0.476 | 0.553 | 0.715 | 45 |
| all three markets | the profile | 179 | 0.737 | 0.657 | 0.623 | 0.722 | 0.825 | 232 |

## Brazilian and Mexican ads

| Market | The ad’s title | Today’s title → its snap | The profile’s occupation → its snap | The profile |
|---|---|---|---|---|
| brazil | Jovem Aprendiz | Jovem Aprendiz → — | industrial operations apprentice → — | 10 skills, no certificate |
| brazil | Oficial de Manutenção Predial | Oficial de Manutenção Predial → pos:facilities-manager | building maintenance technician → pos:handyperson | 10 skills, Driver's license category B |
| brazil | Vendedor Interno _vendas materiais elétricos em áreas classificadas e automação industrial (Macaé) | Vendedor Interno _vendas materiais elétricos em áreas classificadas e automação industrial → pos:wholesale-merchant-in-electronic-and-telecommunications | inside sales representative → — | 10 skills, no certificate |
| brazil | Enfermeiro(a) - Barra da Tijuca | Enfermeiro → pos:nurse-responsible-for-general-care | registered nurse → pos:nurse-responsible-for-general-care | 5 skills, active nursing council registration |
| brazil | MECANICO JUNIOR | MECANICO JUNIOR → pos:vehicle-technician | automotive mechanic → pos:vehicle-technician | 10 skills, no certificate |
| brazil | Soldador | Soldador → — | welder → — | 5 skills, no certificate |
| brazil | Oficial de Manutenção Predial | Oficial de Manutenção Predial → pos:facilities-manager | building maintenance technician → pos:handyperson | 10 skills, no certificate |
| brazil | Técnico de Manutenção - Friburgo | Técnico de Manutenção → — | refrigeration and electrotechnical maintenance technician → — | 8 skills, technical diploma in Electrical, Refrigeration or Electrotechnical |
| mexico | Ingeniero de Aplicaciones. | Ingeniero de Aplicaciones. → — | devsecops engineer → pos:ict-security-technician | 10 skills, no certificate |
| mexico | JEFE DE MANTENIMIENTO NL | JEFE DE MANTENIMIENTO NL → — | maintenance supervisor → pos:industrial-maintenance-supervisor | 10 skills, high school diploma |
| mexico | GERENTE RELACIONES LABORALES | GERENTE RELACIONES LABORALES → pos:labour-relations-officer | labor relations manager → pos:human-resources-manager | 10 skills, no certificate |
| mexico | HERRERO ARMADOR | HERRERO ARMADOR → pos:blacksmith | metal door and gate fabricator → — | 10 skills, no certificate |
| mexico | Personal de mantenimiento | Personal de mantenimiento → — | building maintenance worker → — | 10 skills, no certificate |
| mexico | OPERADOR DE MANTENIMIENTO | OPERADOR DE MANTENIMIENTO → — | hotel maintenance technician → pos:handyperson | 10 skills, no certificate |
| mexico | Contador Administrativo-Fiscal (Manejo de Impuestos) | Contador Administrativo-Fiscal → — | administrative tax accountant → pos:accountant | 9 skills, no certificate |
| mexico | Soldador | Soldador → — | gmaw welder → — | 10 skills, no certificate |

Run in 2.5 minutes.
