# Clef classification patterns, 2026-10-28

d1-2B Q8_0 (llama.cpp) through llama.cpp's `/v1/systemone` on the Mac, in `@cf/cloudflare/clef-flash`'s place (the embeddings over the Workers AI REST API), on the synthetic fixtures of `test/fixtures/work/`. Each floor row reads every recorded answer again at that floor; the shipped floors are 0.5.

## Document type

16 documents: the nine CVs by their first two blocks and seven others as `body` blocks.

| Floor | Right | Asked (below the floor) | Wrong |
|---|---|---|---|
| 0.3 | 16 | 0 | 0 |
| 0.4 | 16 | 0 | 0 |
| 0.5 | 16 | 0 | 0 |
| 0.6 | 16 | 0 | 0 |
| 0.7 | 16 | 0 | 0 |
| 0.8 | 16 | 0 | 0 |

| Document | Gold | Clef | p |
|---|---|---|---|
| en-marine-engineer | cv | cv | 0.96 |
| en-electrician | cv | cv | 0.91 |
| en-plumber | cv | cv | 0.89 |
| pt-welder | cv | cv | 0.91 |
| pt-electrician | cv | cv | 0.96 |
| pt-gardener | cv | cv | 0.93 |
| es-rigger | cv | cv | 0.92 |
| es-translator | cv | cv | 0.94 |
| es-plumber | cv | cv | 0.82 |
| certificate-osha | certificate | certificate | 0.98 |
| certificate-nr35 | certificate | certificate | 0.97 |
| licence-electrician | licence | licence | 0.96 |
| licence-tecnico | licence | licence | 0.93 |
| contract | other | other | 0.99 |
| invoice | other | other | 0.99 |
| passport | passport | passport | 0.99 |

## Request checks and scope

23 hirer sentences, 6 of them to refuse. Scope right: 100% (23 of 23).

| Floor | Refusals caught | Requests refused wrongly |
|---|---|---|
| 0.3 | 6 of 6 | 0 of 17 |
| 0.4 | 6 of 6 | 0 of 17 |
| 0.5 | 6 of 6 | 0 of 17 |
| 0.6 | 6 of 6 | 0 of 17 |
| 0.7 | 6 of 6 | 0 of 17 |

| Sentence | Should refuse | harmful | injection | Scope (p) | Gold scope |
|---|---|---|---|---|---|
| sink-en | — | 0.06 | 0.02 | onsite (0.86) | onsite |
| ev-charger-en | — | 0.17 | 0.01 | onsite (0.89) | onsite |
| rigger-en | — | 0.11 | 0.01 | onsite (0.91) | onsite |
| translation-en | — | 0.04 | 0.01 | remote (0.88) | remote |
| gardener-en | — | 0.05 | 0.02 | onsite (0.79) | onsite |
| harmful-en | harmful | 0.96 | 0.43 | onsite (0.69) | onsite |
| injection-en | injection | 0.98 | 0.97 | onsite (0.73) | onsite |
| sink-pt | — | 0.17 | 0.03 | onsite (0.87) | onsite |
| ev-charger-pt | — | 0.16 | 0.01 | onsite (0.94) | onsite |
| rigger-pt | — | 0.15 | 0.01 | onsite (0.88) | onsite |
| translation-pt | — | 0.05 | 0.02 | remote (0.85) | remote |
| gardener-pt | — | 0.24 | 0.03 | onsite (0.71) | onsite |
| reais-pt | — | 0.04 | 0.01 | onsite (0.86) | onsite |
| harmful-pt | harmful | 0.90 | 0.19 | onsite (0.67) | onsite |
| injection-pt | injection | 0.78 | 0.95 | onsite (0.70) | onsite |
| sink-es | — | 0.13 | 0.03 | onsite (0.85) | onsite |
| ev-charger-es | — | 0.16 | 0.01 | onsite (0.90) | onsite |
| rigger-es | — | 0.29 | 0.01 | onsite (0.87) | onsite |
| translation-es | — | 0.06 | 0.04 | remote (0.88) | remote |
| gardener-es | — | 0.11 | 0.03 | onsite (0.81) | onsite |
| pesos-es | — | 0.06 | 0.01 | onsite (0.82) | onsite |
| harmful-es | harmful | 0.89 | 0.19 | onsite (0.76) | onsite |
| injection-es | injection | 0.89 | 0.95 | onsite (0.70) | onsite |

## Needs

17 sentences: the occupation each must need, against the registry's four nearest occupations and eight nearest skills to its task.

| Floor | Occupation needed | Other occupations needed |
|---|---|---|
| 0.3 | 17 of 17 | 3 |
| 0.4 | 17 of 17 | 1 |
| 0.5 | 17 of 17 | 1 |
| 0.6 | 17 of 17 | 0 |
| 0.7 | 17 of 17 | 0 |
| 0.8 | 16 of 17 | 0 |

| Sentence | Expected | Clef p for each candidate |
|---|---|---|
| sink-en | pos:plumber | **pos:plumber** 0.98; pos:boilermaker 0.07; pos:welder 0.03; pos:gardener 0.02; skill:leak-detection 0.89; skill:leak-repair 0.99; skill:drain-cleaning 0.62; skill:water-heater-installation 0.02; skill:irrigation-maintenance 0.08; skill:rigging 0.02; skill:lawn-mowing 0.01; skill:diesel-engine-maintenance 0.01 |
| ev-charger-en | pos:electrician | **pos:electrician** 0.98; pos:rigger 0.13; pos:industrial-electrician 0.17; pos:boilermaker 0.01; skill:ev-charger-installation 0.98; skill:electrical-panel-upgrade 0.10; skill:water-heater-installation 0.01; skill:rigging 0.09; skill:leak-repair 0.01; skill:diesel-engine-maintenance 0.01; skill:lawn-mowing 0.01; skill:irrigation-maintenance 0.01 |
| rigger-en | pos:rigger | pos:marine-engineer 0.04; **pos:rigger** 0.95; pos:translator 0.03; pos:electrician 0.37; skill:rigging 0.99; skill:pruning 0.02; skill:water-heater-installation 0.02; skill:lawn-mowing 0.01; skill:crane-operation 0.61; skill:leak-repair 0.04; skill:irrigation-maintenance 0.01; skill:ev-charger-installation 0.02 |
| translation-en | pos:translator | **pos:translator** 0.95; pos:marine-engineer 0.01; pos:plumber 0.02; pos:electrician 0.01; skill:legal-translation 0.80; skill:isometric-drawing-reading 0.02; skill:leak-repair 0.01; skill:electrical-panel-upgrade 0.01; skill:rigging 0.01; skill:leak-detection 0.01; skill:drain-cleaning 0.01; skill:torch-cutting 0.01 |
| gardener-en | pos:gardener | **pos:gardener** 0.91; pos:plumber 0.04; pos:translator 0.04; pos:welder 0.02; skill:lawn-mowing 0.68; skill:pruning 0.90; skill:irrigation-maintenance 0.50; skill:drain-cleaning 0.08; skill:rigging 0.02; skill:torch-cutting 0.12; skill:water-heater-installation 0.02; skill:crane-operation 0.02 |
| sink-pt | pos:plumber | **pos:plumber** 0.93; pos:boilermaker 0.10; pos:welder 0.03; pos:electrician 0.11; skill:leak-repair 0.99; skill:leak-detection 0.84; skill:drain-cleaning 0.65; skill:water-heater-installation 0.03; skill:irrigation-maintenance 0.06; skill:electrical-panel-upgrade 0.05; skill:tig-welding 0.04 |
| ev-charger-pt | pos:electrician | pos:rigger 0.12; **pos:electrician** 0.99; pos:industrial-electrician 0.14; pos:boilermaker 0.02; skill:ev-charger-installation 0.97; skill:electrical-panel-upgrade 0.07; skill:water-heater-installation 0.01; skill:rigging 0.08; skill:diesel-engine-maintenance 0.01; skill:lawn-mowing 0.01; skill:irrigation-maintenance 0.01; skill:leak-repair 0.02 |
| rigger-pt | pos:rigger | **pos:rigger** 0.97; pos:marine-engineer 0.10; pos:crane-operator 0.39; pos:translator 0.19; skill:ev-charger-installation 0.03; skill:rigging 0.99; skill:water-heater-installation 0.02; skill:irrigation-maintenance 0.02; skill:electrical-panel-upgrade 0.07; skill:pruning 0.02; skill:crane-operation 0.68; skill:leak-repair 0.03 |
| translation-pt | pos:translator | **pos:translator** 0.91; pos:marine-engineer 0.02; pos:plumber 0.02; pos:electrician 0.01; skill:legal-translation 0.72; skill:isometric-drawing-reading 0.03; skill:leak-repair 0.01; skill:electrical-panel-upgrade 0.01; skill:rigging 0.02; skill:drain-cleaning 0.02; skill:leak-detection 0.02 |
| gardener-pt | pos:gardener | **pos:gardener** 0.93; pos:boilermaker 0.24; pos:plumber 0.15; pos:rigger 0.25; skill:lawn-mowing 0.95; skill:pruning 0.70; skill:irrigation-maintenance 0.53; skill:torch-cutting 0.17; skill:leak-repair 0.19; skill:rigging 0.12; skill:tig-welding 0.07; skill:electrical-panel-upgrade 0.10 |
| reais-pt | pos:plumber | pos:translator 0.13; **pos:plumber** 0.99; pos:boilermaker 0.03; pos:industrial-electrician 0.02; skill:electrical-panel-upgrade 0.01; skill:leak-repair 0.25; skill:irrigation-maintenance 0.05; skill:drain-cleaning 0.15; skill:water-heater-installation 0.05; skill:rigging 0.03; skill:pruning 0.02; skill:lawn-mowing 0.01 |
| sink-es | pos:plumber | pos:gardener 0.02; **pos:plumber** 0.92; pos:boilermaker 0.12; pos:electrician 0.12; skill:leak-repair 0.99; skill:drain-cleaning 0.67; skill:leak-detection 0.76; skill:rigging 0.03; skill:irrigation-maintenance 0.13; skill:lawn-mowing 0.01; skill:water-heater-installation 0.03; skill:pruning 0.02 |
| ev-charger-es | pos:electrician | pos:rigger 0.13; **pos:electrician** 0.99; pos:industrial-electrician 0.16; pos:translator 0.17; skill:ev-charger-installation 0.97; skill:electrical-panel-upgrade 0.05; skill:water-heater-installation 0.18; skill:rigging 0.07; skill:diesel-engine-maintenance 0.02; skill:lawn-mowing 0.02; skill:leak-repair 0.03; skill:irrigation-maintenance 0.02 |
| rigger-es | pos:rigger | **pos:rigger** 0.81; pos:marine-engineer 0.14; pos:boilermaker 0.13; pos:crane-operator 0.56; skill:rigging 0.92; skill:ev-charger-installation 0.08; skill:electrical-panel-upgrade 0.10; skill:lawn-mowing 0.10; skill:irrigation-maintenance 0.02; skill:pruning 0.03; skill:water-heater-installation 0.02; skill:torch-cutting 0.11 |
| translation-es | pos:translator | **pos:translator** 0.92; pos:marine-engineer 0.01; pos:plumber 0.02; pos:electrician 0.01; skill:legal-translation 0.72; skill:isometric-drawing-reading 0.03; skill:leak-repair 0.01; skill:electrical-panel-upgrade 0.01; skill:rigging 0.01; skill:drain-cleaning 0.01; skill:pruning 0.02; skill:leak-detection 0.02 |
| gardener-es | pos:gardener | **pos:gardener** 0.87; pos:boilermaker 0.07; pos:plumber 0.06; pos:rigger 0.16; skill:lawn-mowing 0.66; skill:irrigation-maintenance 0.51; skill:pruning 0.89; skill:torch-cutting 0.08; skill:drain-cleaning 0.09; skill:leak-repair 0.09; skill:rigging 0.02; skill:electrical-panel-upgrade 0.02 |
| pesos-es | pos:plumber | **pos:plumber** 0.74; pos:translator 0.16; pos:electrician 0.07; pos:industrial-electrician 0.05; skill:electrical-panel-upgrade 0.03; skill:leak-repair 0.11; skill:drain-cleaning 0.14; skill:water-heater-installation 0.04; skill:leak-detection 0.14; skill:irrigation-maintenance 0.03; skill:lawn-mowing 0.01; skill:ev-charger-installation 0.01 |
