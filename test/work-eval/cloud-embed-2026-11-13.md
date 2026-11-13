# Workers AI's EmbeddingGemma 2 in place of the phone's LiteRT-LM vectors, on the v2 index, 2026-11-13

`@cf/google/embeddinggemma-2` over the Workers AI REST API from the Mac (768 dimensions, the role's prompt before each text, NFC and one line as the phone sends it), standing in for `litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm` (LiteRT-LM's Python API on the Mac's CPU, as the v2 labels were made), against the v2 index's own label vectors (229654 vectors, the replica's cache of `token-registry-v2`; none re-embedded). τ_auto 0.96, τ_low 0.81, the tier-2 floor 0.65. "Local" is the phone's vector, "Cloud" the Workers AI one; a change is counted between the two on the same string or pair. Only public ESCO labels and the synthetic fixtures went to Workers AI (200 calls, 53306 input tokens this run; the rest from the cache, `test/workCloudEmbed.eval.test.ts`).

## The same text, both models

Cosine between the cloud's and the phone's vector of the same string, over the τ set's 2000 strings: as documents min 0.9369, 1st percentile 0.9726, 5th 0.9828, median 0.9907; as queries min 0.9249, 1st percentile 0.9750, 5th 0.9844, median 0.9908.

## 1. The τ set (`test/registry.tau.test.ts`'s sample), as queries

2000 of ESCO's alternative and hidden labels (1,000 occupations, 1,000 skills, English, Portuguese and Spanish, seed 67), each snapped against every other label of its kind in the v2 index, its own words on its token left out; right means its own token.

| Vectors | Right at 1 | Right among 5 | Taken at τ_auto | Taken and right | Right among 5 below τ_low |
|---|---|---|---|---|---|
| Local (the phone) | 1644 (82.2%) | 1927 (96.3%) | 729 (36.5%) | 616 (84.5%) | 1 |
| Cloud (Workers AI) | 1646 (82.3%) | 1929 (96.5%) | 460 (23.0%) | 377 (82.0%) | 2 |

| Change against Local | Strings | Nearest token changes (right before → after) | τ_auto: falls below / rises above (right among them) | τ_low: falls below / rises above |
|---|---|---|---|---|
| Cloud query, all | 2000 | 52 (2.6%; 15 → 17) | 270 / 1 (240 / 1) | 0 / 0 |
| Cloud query, occupations | 1000 | 32 (3.2%; 8 → 13) | 139 / 0 (117 / 0) | 0 / 0 |
| Cloud query, skills | 1000 | 20 (2.0%; 7 → 4) | 131 / 1 (123 / 1) | 0 / 0 |

## 1b. The τ set, as documents (a mint)

Each string's own label put back into the index with a document vector, then the string asked again: the phone's query against the phone's document (today), the phone's query against the cloud's document (a Cloud user's mint found by a Local user), and the cloud's query against the cloud's document (a Cloud user's mint found by a Cloud user). Right means the string's own token.

| Vectors | Right at 1 | Taken at τ_auto | Taken and right |
|---|---|---|---|
| Local query, Local document | 1937 (96.8%) | 1859 (93.0%) | 1805 (97.1%) |
| Local query, Cloud document | 1889 (94.5%) | 1659 (83.0%) | 1561 (94.1%) |
| Cloud query, Cloud document | 1998 (99.9%) | 1881 (94.0%) | 1879 (99.9%) |

| Change against Local | Strings | Nearest token changes (right before → after) | τ_auto: falls below / rises above (right among them) | τ_low: falls below / rises above |
|---|---|---|---|---|
| Local query, Cloud document | 2000 | 52 (2.6%; 50 → 2) | 206 / 6 (206 / 6) | 0 / 0 |
| Cloud query, Cloud document | 2000 | 63 (3.1%; 1 → 62) | 30 / 52 (28 / 52) | 0 / 0 |

## 2. The tier-2 set (`test/fixtures/work/tier2-floor.json`)

24 sentences (queries) against 38 listings (documents, their text as the phone sends it), 912 pairs. Kept: a right or near pair at the floor (0.65) or above; admitted: a same-industry or far pair at or above it.

| Vectors | Right listing first | Right kept | Near kept | Industry admitted | Far admitted | Pairs whose side of the floor changes (right, near, industry, far) |
|---|---|---|---|---|---|---|
| Local sentence, Local listing (today) | 23 of 24 | 44 of 46 | 15 of 24 | 22 of 99 | 24 of 743 | — |
| Cloud sentence, Local listing | 24 of 24 | 46 of 46 | 15 of 24 | 19 of 99 | 16 of 743 | 17 (2, 2, 3, 10) |
| Local sentence, Cloud listing | 23 of 24 | 43 of 46 | 14 of 24 | 17 of 99 | 15 of 743 | 20 (1, 1, 5, 13) |
| Cloud sentence, Cloud listing | 24 of 24 | 44 of 46 | 14 of 24 | 16 of 99 | 9 of 743 | 26 (2, 3, 6, 15) |

The score of a pair, Cloud against Local, over the 912 pairs: CL differs by 0.008 on average, 0.033 at most; LC differs by 0.010 on average, 0.029 at most; CC differs by 0.014 on average, 0.045 at most.

The pairs that cross the floor in any mix:

| Sentence | Listing | Relation | LL | CL | LC | CC |
|---|---|---|---|---|---|---|
| accountant-taxes-en | en-auditor | industry | 0.667 | 0.648 | 0.659 | 0.644 |
| advogado-aluguel-pt | en-lawyer | right | 0.657 | 0.669 | 0.634 | 0.651 |
| contador-anual-es | es-electricista | far | 0.651 | 0.653 | 0.640 | 0.644 |
| contador-renda-pt | en-accountant | right | 0.645 | 0.650 | 0.649 | 0.660 |
| contador-renda-pt | en-bookkeeper | near | 0.649 | 0.652 | 0.646 | 0.652 |
| audit-en | en-data-analyst | far | 0.656 | 0.646 | 0.646 | 0.637 |
| ev-charger-en | en-tax-advisor | far | 0.642 | 0.634 | 0.656 | 0.649 |
| ev-charger-en | en-offshore-electrician | near | 0.658 | 0.650 | 0.651 | 0.648 |
| ev-charger-en | en-welder | industry | 0.653 | 0.636 | 0.647 | 0.632 |
| ev-charger-en | es-plomero | industry | 0.657 | 0.653 | 0.642 | 0.641 |
| quadro-pt | en-offshore-electrician | near | 0.652 | 0.647 | 0.642 | 0.639 |
| sink-en | pt-encanador | right | 0.664 | 0.653 | 0.655 | 0.649 |
| sink-en | en-cleaner | far | 0.668 | 0.648 | 0.659 | 0.640 |
| pipe-welding-en | pt-encanador | far | 0.664 | 0.656 | 0.651 | 0.646 |
| pipe-welding-en | en-handyman | far | 0.651 | 0.648 | 0.646 | 0.644 |
| nurse-en | en-plumber | far | 0.655 | 0.641 | 0.636 | 0.625 |
| nurse-en | en-handyman | far | 0.644 | 0.630 | 0.655 | 0.644 |
| nurse-en | en-cleaner | far | 0.660 | 0.645 | 0.655 | 0.642 |
| dashboard-en | en-accountant | industry | 0.650 | 0.637 | 0.647 | 0.638 |
| jantar-pt | pt-encanador | far | 0.659 | 0.655 | 0.647 | 0.645 |
| jantar-pt | en-chef | right | 0.649 | 0.650 | 0.648 | 0.650 |
| gardener-en | en-caregiver | far | 0.650 | 0.653 | 0.634 | 0.639 |
| gardener-en | en-cleaner | industry | 0.657 | 0.653 | 0.645 | 0.646 |
| rigger-en | pt-encanador | far | 0.666 | 0.651 | 0.656 | 0.645 |
| rigger-en | es-plomero | far | 0.662 | 0.642 | 0.646 | 0.628 |
| rigger-en | en-hvac | far | 0.664 | 0.646 | 0.651 | 0.636 |
| rigger-en | pt-motorista | far | 0.653 | 0.639 | 0.637 | 0.628 |
| translation-en | es-contador | far | 0.652 | 0.660 | 0.644 | 0.653 |
| translation-en | es-plomero | far | 0.651 | 0.649 | 0.635 | 0.635 |
| cleaning-en | en-painter | industry | 0.653 | 0.654 | 0.645 | 0.646 |
| brakes-en | en-plumber | far | 0.656 | 0.650 | 0.637 | 0.635 |
| brakes-en | en-handyman | far | 0.660 | 0.655 | 0.646 | 0.644 |

## 3. The locale strings (`test/fixtures/work/locale-cases.json`), retrieval only

39 strings, each a query against its kind on the whole v2 index (no label left out; Clef and the pivot are not asked here: `test/workRegistry.eval.test.ts`'s locale arms run them with WORK_REPLICA_EMBED). Right at 1 means the nearest token is one the case expects.

| Vectors | Nearest token right | Taken at τ_auto | In the band or above |
|---|---|---|---|
| Local (the phone) | 13 of 39 | 1 | 36 |
| Cloud (Workers AI) | 11 of 39 | 1 | 37 |

Changes against Local: the nearest token for 10 (right 3 → 1), the side of τ_auto for 0, the side of τ_low for 3.

| String | Local: token, score (through its languages) | Cloud: token, score (through its languages) |
|---|---|---|
| Encanador (pt) | pos:bulk-filler 0.858 (0.858) | pos:derrickhand 0.860 (—) |
| Bombeiro hidráulico (pt) | pos:water-engineer 0.844 (0.844) | pos:firefighter 0.840 (0.840) |
| Garçom (pt) | pos:gauger 0.734 (0.734) | pos:bartender 0.859 (—) |
| Frentista (pt) | pos:pawnbroker 0.823 (—) | pos:sewing-machine-operator 0.809 (0.809) |
| Mesero (es) | pos:foundry-moulder 0.849 (0.849) | pos:bartender 0.846 (0.846) |
| Motoboy (pt) | pos:professional-athlete 0.797 (0.797) | pos:motorcycle-delivery-person 0.795 (0.795) |
| Hojalatero (es) | pos:jeweller 0.836 (0.820) | pos:chocolatier 0.815 (0.815) |
| Valet (en) | pos:parking-valet 0.903 (0.903) | pos:room-attendant 0.898 (—) |
| Torneiro mecânico (pt) | pos:fitter-and-turner 0.885 (0.885) | pos:laundry-ironer 0.870 (0.870) |
| Valet (es) | pos:parking-valet 0.903 (0.903) | pos:room-attendant 0.898 (0.898) |
| Babá (pt) | pos:nanny 0.802 (0.802) | pos:nanny 0.812 (0.812) |

As documents: a mint of the string scores against the phone's later query of the same string min 0.9269, 1st percentile 0.9269, 5th 0.9277, median 0.9636 with the phone's document, min 0.8364, 1st percentile 0.8364, 5th 0.8374, median 0.9522 with the cloud's; at or above τ_auto 25 and 13 of 39.

## Against the GGUF-to-LiteRT difference

`test/work-eval/embedder-litert-2026-10-30.md` measured LiteRT-LM's query vectors against the GGUF's v3 documents, 600 labels as claim strings: the best label the same for 527 of 600 (88%), 89 of 600 (14.8%) falling below τ_auto and 1 rising above, none crossing τ_low or the tier-2 floor. Here, Cloud queries against the v2 (Local) documents: the nearest token changes for 52 of 2000 (2.6%), 270 (13.5%) fall below τ_auto and 1 (0.1%) rise above, 0 cross τ_low; 17 tier-2 pairs of 912 cross the floor (Cloud sentence), 20 (Cloud listing).

## 3b. The locale arms with Clef and the pivot (`registry-locale-v2-2026-11-13.md` and `-cloud.md`)

The same 39 strings snapped end to end on the v2 replica by `test/workRegistry.eval.test.ts -t "locale arms"`, twice the same night: each string embedded as the phone embeds it (LiteRT-LM on the Mac), then with `WORK_REPLICA_EMBED=cloud`, as the plane now embeds a Cofferdam Cloud user's (its own `embedTexts` under the v2 pin, which ran `@cf/google/embeddinggemma-2` through `work-embed-cloud`). Clef and the llama pivot are hosted calls in both, so a string near Clef's floor can change with no change of vector.

| Arm | Local vectors | Cloud vectors |
|---|---|---|
| before | 18 of 39 (1 Clef timeout) | 17 of 39 (3 Clef timeouts) |
| language | 25 of 39 | 24 of 39 |
| market (production) | 20 of 39 | 22 of 39 |

In production's arm two strings went from wrong to right with the cloud's vectors ("Bombeiro hidráulico", br-rj: Clef's firefighter at 0.53 became none and the pivot's plumber; "Tercer Ingeniero", mx-ver: Clef's mechanical engineer at 0.55 fell under the floor and the pivot took marine engineer) and none the other way; in the language arm one went from right to wrong ("Borracheiro": the pivot's English name changed from tyre fitter). The 2026-10-31 runs of the same arms on the phone's vectors read 21 and 25 of 39.

## Verdict

As a query, the cloud's vector sits where the GGUF's sat against LiteRT-LM's (the difference the docs record): the nearest token changes for 2.6% of 2,000 held-out labels with the same number right (1,644 and 1,646), 13.5% fall below τ_auto against 14.8% then, and none crosses τ_low; the hirer's sentence on the cloud's vector keeps every right listing over the tier-2 floor and admits fewer far ones. As a document the shift is larger where vectors of the two models meet: a Cloud user's mint found by a Local user's query loses τ_auto for 206 of 2,000 own labels (93.0% to 83.0% taken) and ranks another token first for 52, which then go to Clef's band with the mint among the candidates; nothing crosses τ_low, and a Cloud query finds a Cloud mint better than any mix (99.9% first). The locale arms with Clef read the same within their run-to-run spread. So the v2 index is kept (option 1); the cost is more strings in Clef's band for Cloud users (about one claim in seven that the phone's vector takes by τ_auto), not wrong takes. The plane names every vector it makes by its model (`@cf/google/embeddinggemma-2` in a listing's `model` and `embed_model`, a minted label's `model`), so a later re-index on the cloud's vectors (option 2) can find them.
