# Clef classification patterns, 2026-10-29

Laya 0.4.17 (in process) through llama.cpp's `/v1/systemone` on the Mac, in `@cf/cloudflare/clef-flash`'s place (the embeddings over the Workers AI REST API), on the synthetic fixtures of `test/fixtures/work/`. Each floor row reads every recorded answer again at that floor; the shipped floors are 0.5.

## Document type

16 documents: the nine CVs by their first two blocks and seven others as `body` blocks.

| Floor | Right | Asked (below the floor) | Wrong |
|---|---|---|---|
| 0.3 | 14 | 0 | 2 |
| 0.4 | 12 | 2 | 2 |
| 0.5 | 10 | 4 | 2 |
| 0.6 | 10 | 4 | 2 |
| 0.7 | 9 | 6 | 1 |
| 0.8 | 9 | 7 | 0 |

| Document | Gold | Clef | p |
|---|---|---|---|
| en-marine-engineer | cv | cv | 0.33 |
| en-electrician | cv | **licence** | 0.69 |
| en-plumber | cv | cv | 0.32 |
| pt-welder | cv | cv | 1.00 |
| pt-electrician | cv | cv | 0.41 |
| pt-gardener | cv | cv | 1.00 |
| es-rigger | cv | cv | 0.92 |
| es-translator | cv | **other** | 0.78 |
| es-plumber | cv | cv | 0.89 |
| certificate-osha | certificate | certificate | 0.98 |
| certificate-nr35 | certificate | certificate | 0.45 |
| licence-electrician | licence | licence | 1.00 |
| licence-tecnico | licence | licence | 1.00 |
| contract | other | other | 0.99 |
| invoice | other | other | 0.69 |
| passport | passport | passport | 0.97 |

## Request checks and scope

23 hirer sentences, 6 of them to refuse. Scope right: 60.9% (14 of 23).

| Floor | Refusals caught | Requests refused wrongly |
|---|---|---|
| 0.3 | 3 of 6 | 4 of 17 |
| 0.4 | 2 of 6 | 2 of 17 |
| 0.5 | 1 of 6 | 2 of 17 |
| 0.6 | 1 of 6 | 2 of 17 |
| 0.7 | 1 of 6 | 2 of 17 |

| Sentence | Should refuse | harmful | injection | Scope (p) | Gold scope |
|---|---|---|---|---|---|
| sink-en | — | 0.14 | 0.00 | onsite (0.72) | onsite |
| ev-charger-en | — | 0.01 | 0.00 | onsite (0.72) | onsite |
| rigger-en | — | 0.00 | 0.00 | onsite (0.57) | onsite |
| translation-en | — | 0.02 | 0.00 | remote (0.65) | remote |
| gardener-en | — | 0.07 | 0.04 | onsite (0.78) | onsite |
| harmful-en | harmful | 0.11 | 0.02 | **remote** (0.51) | onsite |
| injection-en | injection | 0.71 | 0.77 | onsite (0.57) | onsite |
| sink-pt | — | 0.01 | 0.38 | onsite (0.73) | onsite |
| ev-charger-pt | — | 0.00 | 0.05 | **remote** (0.71) | onsite |
| rigger-pt | — | 0.01 | 0.12 | **remote** (0.54) | onsite |
| translation-pt | — | 0.00 | 0.17 | **onsite** (0.65) | remote |
| gardener-pt | — | 0.10 | 0.05 | onsite (0.66) | onsite |
| reais-pt | — | 0.01 | 0.84 | onsite (0.58) | onsite |
| harmful-pt | harmful | 0.02 | 0.24 | onsite (0.52) | onsite |
| injection-pt | injection | 0.01 | 0.37 | **remote** (0.71) | onsite |
| sink-es | — | 0.00 | 0.30 | onsite (0.66) | onsite |
| ev-charger-es | — | 0.00 | 0.00 | **remote** (0.65) | onsite |
| rigger-es | — | 0.00 | 0.00 | onsite (0.65) | onsite |
| translation-es | — | 0.00 | 0.80 | **onsite** (0.54) | remote |
| gardener-es | — | 0.14 | 0.10 | onsite (0.69) | onsite |
| pesos-es | — | 0.01 | 0.20 | onsite (0.63) | onsite |
| harmful-es | harmful | 0.02 | 0.24 | **remote** (0.74) | onsite |
| injection-es | injection | 0.03 | 0.41 | **remote** (0.77) | onsite |

## Needs

17 sentences: the occupation each must need, against the registry's four nearest occupations and eight nearest skills to its task.

| Floor | Occupation needed | Other occupations needed |
|---|---|---|
| 0.3 | 13 of 17 | 11 |
| 0.4 | 12 of 17 | 10 |
| 0.5 | 12 of 17 | 10 |
| 0.6 | 10 of 17 | 8 |
| 0.7 | 10 of 17 | 5 |
| 0.8 | 10 of 17 | 4 |

| Sentence | Expected | Clef p for each candidate |
|---|---|---|
| sink-en | pos:plumber | **pos:plumber** 0.51; pos:boilermaker 0.11; pos:welder 0.10; pos:gardener 0.00; skill:leak-detection 0.15; skill:leak-repair 0.80; skill:drain-cleaning 0.12; skill:water-heater-installation 0.00; skill:irrigation-maintenance 0.00; skill:rigging 0.07; skill:lawn-mowing 0.00; skill:diesel-engine-maintenance 0.00 |
| ev-charger-en | pos:electrician | **pos:electrician** 0.88; pos:rigger 0.51; pos:industrial-electrician 0.69; pos:boilermaker 0.05; skill:ev-charger-installation 0.69; skill:electrical-panel-upgrade 0.61; skill:water-heater-installation 0.11; skill:rigging 0.66; skill:leak-repair 0.12; skill:diesel-engine-maintenance 0.10; skill:lawn-mowing 0.03; skill:irrigation-maintenance 0.00 |
| rigger-en | pos:rigger | pos:marine-engineer 0.10; **pos:rigger** 0.95; pos:translator 0.03; pos:electrician 0.23; skill:rigging 0.89; skill:pruning 0.18; skill:water-heater-installation 0.15; skill:lawn-mowing 0.03; skill:crane-operation 0.67; skill:leak-repair 0.15; skill:irrigation-maintenance 0.24; skill:ev-charger-installation 0.08 |
| translation-en | pos:translator | **pos:translator** 0.84; pos:marine-engineer 0.04; pos:plumber 0.00; pos:electrician 0.04; skill:legal-translation 0.78; skill:isometric-drawing-reading 0.14; skill:leak-repair 0.13; skill:electrical-panel-upgrade 0.26; skill:rigging 0.19; skill:leak-detection 0.00; skill:drain-cleaning 0.17; skill:torch-cutting 0.08 |
| gardener-en | pos:gardener | **pos:gardener** 0.40; pos:plumber 0.00; pos:translator 0.05; pos:welder 0.00; skill:lawn-mowing 0.14; skill:pruning 0.13; skill:irrigation-maintenance 0.07; skill:drain-cleaning 0.02; skill:rigging 0.06; skill:torch-cutting 0.09; skill:water-heater-installation 0.00; skill:crane-operation 0.03 |
| sink-pt | pos:plumber | **pos:plumber** 0.60; pos:boilermaker 0.64; pos:welder 0.63; pos:electrician 0.27; skill:leak-repair 0.56; skill:leak-detection 0.44; skill:drain-cleaning 0.26; skill:water-heater-installation 0.14; skill:irrigation-maintenance 0.05; skill:electrical-panel-upgrade 0.39; skill:tig-welding 0.35 |
| ev-charger-pt | pos:electrician | pos:rigger 0.26; **pos:electrician** 0.97; pos:industrial-electrician 0.25; pos:boilermaker 0.79; skill:ev-charger-installation 0.93; skill:electrical-panel-upgrade 0.14; skill:water-heater-installation 0.08; skill:rigging 0.27; skill:diesel-engine-maintenance 0.44; skill:lawn-mowing 0.00; skill:irrigation-maintenance 0.02; skill:leak-repair 0.15 |
| rigger-pt | pos:rigger | **pos:rigger** 0.89; pos:marine-engineer 0.16; pos:crane-operator 0.33; pos:translator 0.16; skill:ev-charger-installation 0.32; skill:rigging 0.96; skill:water-heater-installation 0.00; skill:irrigation-maintenance 0.00; skill:electrical-panel-upgrade 0.01; skill:pruning 0.00; skill:crane-operation 0.14; skill:leak-repair 0.01 |
| translation-pt | pos:translator | **pos:translator** 0.92; pos:marine-engineer 0.05; pos:plumber 0.01; pos:electrician 0.01; skill:legal-translation 0.67; skill:isometric-drawing-reading 0.13; skill:leak-repair 0.08; skill:electrical-panel-upgrade 0.05; skill:rigging 0.01; skill:drain-cleaning 0.06; skill:leak-detection 0.03 |
| gardener-pt | pos:gardener | **pos:gardener** 0.10; pos:boilermaker 0.03; pos:plumber 0.03; pos:rigger 0.04; skill:lawn-mowing 0.15; skill:pruning 0.12; skill:irrigation-maintenance 0.14; skill:torch-cutting 0.09; skill:leak-repair 0.08; skill:rigging 0.09; skill:tig-welding 0.12; skill:electrical-panel-upgrade 0.09 |
| reais-pt | pos:plumber | pos:translator 0.59; **pos:plumber** 0.14; pos:boilermaker 0.03; pos:industrial-electrician 0.02; skill:electrical-panel-upgrade 0.03; skill:leak-repair 0.15; skill:irrigation-maintenance 0.06; skill:drain-cleaning 0.01; skill:water-heater-installation 0.05; skill:rigging 0.43; skill:pruning 0.00; skill:lawn-mowing 0.00 |
| sink-es | pos:plumber | pos:gardener 0.06; **pos:plumber** 0.97; pos:boilermaker 0.95; pos:electrician 0.93; skill:leak-repair 0.56; skill:drain-cleaning 0.60; skill:leak-detection 0.27; skill:rigging 0.00; skill:irrigation-maintenance 0.02; skill:lawn-mowing 0.00; skill:water-heater-installation 0.44; skill:pruning 0.35 |
| ev-charger-es | pos:electrician | pos:rigger 0.01; **pos:electrician** 0.95; pos:industrial-electrician 0.03; pos:translator 0.00; skill:ev-charger-installation 0.57; skill:electrical-panel-upgrade 0.82; skill:water-heater-installation 0.11; skill:rigging 0.11; skill:diesel-engine-maintenance 0.42; skill:lawn-mowing 0.00; skill:leak-repair 0.02; skill:irrigation-maintenance 0.00 |
| rigger-es | pos:rigger | **pos:rigger** 0.26; pos:marine-engineer 0.81; pos:boilermaker 0.05; pos:crane-operator 0.82; skill:rigging 0.64; skill:ev-charger-installation 0.29; skill:electrical-panel-upgrade 0.01; skill:lawn-mowing 0.00; skill:irrigation-maintenance 0.00; skill:pruning 0.00; skill:water-heater-installation 0.03; skill:torch-cutting 0.00 |
| translation-es | pos:translator | **pos:translator** 0.98; pos:marine-engineer 0.12; pos:plumber 0.06; pos:electrician 0.02; skill:legal-translation 0.29; skill:isometric-drawing-reading 0.16; skill:leak-repair 0.02; skill:electrical-panel-upgrade 0.07; skill:rigging 0.03; skill:drain-cleaning 0.02; skill:pruning 0.01; skill:leak-detection 0.02 |
| gardener-es | pos:gardener | **pos:gardener** 0.28; pos:boilermaker 0.00; pos:plumber 0.00; pos:rigger 0.04; skill:lawn-mowing 0.14; skill:irrigation-maintenance 0.23; skill:pruning 0.10; skill:torch-cutting 0.06; skill:drain-cleaning 0.07; skill:leak-repair 0.02; skill:rigging 0.01; skill:electrical-panel-upgrade 0.04 |
| pesos-es | pos:plumber | **pos:plumber** 0.98; pos:translator 0.00; pos:electrician 0.24; pos:industrial-electrician 0.08; skill:electrical-panel-upgrade 0.72; skill:leak-repair 0.42; skill:drain-cleaning 0.46; skill:water-heater-installation 0.25; skill:leak-detection 0.09; skill:irrigation-maintenance 0.03; skill:lawn-mowing 0.01; skill:ev-charger-installation 0.10 |
