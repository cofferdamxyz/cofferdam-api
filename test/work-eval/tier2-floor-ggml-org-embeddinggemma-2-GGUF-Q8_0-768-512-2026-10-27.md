# The Curated tier-2 floor for gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 at 2 widths, 2026-10-27

What a listing scores against a hirer's sentence when it misses the token gate, by its relation to the sentence, embedded as recall embeds them: the sentence a query (`task: search result | query:`), the listing's text a document (`title: none | text:`; its titles, skills and certificates as the phone sends them, without the registry's English names), gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 through llama.cpp's llama-embedding on the Mac, mean-pooled and normalised, and at 512 the first 512 values normalised again. In Curated mode a token miss becomes a tier-2 finalist at `TIER2_FLOOR` (0.5 today, set on bge-m3's scale) or above, with no other gate, so the floor alone decides which of these a hirer is counted.

Two worlds. The synthetic set of `test/fixtures/work/tier2-floor.json`: 38 listings and 24 sentences in English, Portuguese and Spanish, each sentence naming the listings that are right (the occupation it asks for, in any language), near (an adjacent occupation a hirer would still want counted as tier 2) and of the same industry (another occupation: never a finalist); every other listing is far. And the recall eval's world: the nine fixture CVs of `cv-blocks.json` as `test/workRecall.eval.test.ts` drafts them, against the 17 hirer sentences of `hirer-prompts.json` that are not refused, right meaning the trade the sentence asks for in any region, and the recall eval's region-bound expectation beside it.

## Synthetic set at 768, the phone's text

The right listing ranks first for 24 of 24 sentences. Cosine by relation, mean (5th to 95th percentile, min, max); a right listing in another language than the sentence's is counted again as cross-language:

| Relation | Pairs | Cosine |
|---|---|---|
| right | 46 | 0.724 (0.652 to 0.779, min 0.649, max 0.790) |
| near | 24 | 0.653 (0.595 to 0.693, min 0.583, max 0.694) |
| industry | 99 | 0.614 (0.568 to 0.671, min 0.529, max 0.734) |
| far | 743 | 0.572 (0.517 to 0.629, min 0.453, max 0.706) |
| right, cross-language | 22 | 0.696 (0.649 to 0.737, min 0.649, max 0.756) |

The floor sweep: the share of each relation at or above the floor, which is what Curated mode would count as tier 2 of the listings that missed the token gate.

| Floor | Right kept | Right kept, cross-language | Near kept | Industry admitted | Far admitted |
|---|---|---|---|---|---|
| 0.5 | 100.0% | 100.0% | 100.0% | 100.0% | 98.3% |
| 0.55 | 100.0% | 100.0% | 100.0% | 98.0% | 76.9% |
| 0.6 | 100.0% | 100.0% | 91.7% | 63.6% | 16.8% |
| 0.62 | 100.0% | 100.0% | 83.3% | 44.4% | 7.5% |
| 0.64 | 100.0% | 100.0% | 70.8% | 21.2% | 2.8% |
| 0.65 | 95.7% | 90.9% | 58.3% | 16.2% | 1.2% |
| 0.66 | 89.1% | 77.3% | 54.2% | 8.1% | 0.8% |
| 0.67 | 84.8% | 68.2% | 25.0% | 5.1% | 0.5% |
| 0.68 | 84.8% | 68.2% | 20.8% | 3.0% | 0.3% |
| 0.69 | 82.6% | 63.6% | 16.7% | 2.0% | 0.1% |
| 0.7 | 76.1% | 50.0% | 0.0% | 1.0% | 0.1% |
| 0.72 | 56.5% | 22.7% | 0.0% | 1.0% | 0.0% |
| 0.74 | 39.1% | 4.5% | 0.0% | 0.0% | 0.0% |
| 0.76 | 17.4% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.78 | 4.3% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.8 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.81 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.82 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.83 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.84 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.85 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.86 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.87 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.88 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.9 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

Per sentence: the listing ranked first, the best and the lowest right listing, and the best near, same-industry and far listing.

| Sentence | First | Right best / lowest | Near best | Industry best | Far best |
|---|---|---|---|---|---|
| accountant-taxes-en | en-tax-advisor 0.777 (right) | 0.777 / 0.690 | en-bookkeeper 0.692 | en-auditor 0.643 | en-data-analyst 0.603 |
| lawyer-lease-en | en-lawyer 0.758 (right) | 0.758 / 0.737 | en-paralegal 0.670 | en-tax-advisor 0.642 | en-plumber 0.601 |
| advogado-aluguel-pt | pt-advogado 0.750 (right) | 0.750 / 0.652 | en-paralegal 0.612 | es-contador 0.599 | pt-motorista 0.600 |
| contador-anual-es | es-contador 0.774 (right) | 0.774 / 0.718 | en-bookkeeper 0.694 | en-auditor 0.656 | es-electricista 0.644 |
| contador-renda-pt | es-contador 0.695 (right) | 0.695 / 0.659 | en-bookkeeper 0.652 | pt-advogado 0.627 | pt-cozinheiro 0.614 |
| bookkeeping-en | en-bookkeeper 0.768 (right) | 0.768 / 0.736 | en-tax-advisor 0.693 | en-paralegal 0.619 | en-handyman 0.632 |
| audit-en | en-auditor 0.744 (right) | 0.744 / 0.744 | en-accountant 0.664 | en-bookkeeper 0.658 | en-data-analyst 0.639 |
| ev-charger-en | en-electrician 0.779 (right) | 0.779 / 0.707 | en-handyman 0.691 | en-hvac 0.693 | en-tax-advisor 0.648 |
| quadro-pt | pt-eletricista 0.744 (right) | 0.744 / 0.686 | en-handyman 0.665 | pt-encanador 0.734 | pt-cozinheiro 0.677 |
| sink-en | en-plumber 0.706 (right) | 0.706 / 0.649 | en-handyman 0.661 | en-carpenter 0.621 | en-cleaner 0.641 |
| calentador-es | es-plomero 0.785 (right) | 0.785 / 0.725 | en-handyman 0.662 | es-electricista 0.629 | es-jardinero 0.606 |
| pipe-welding-en | en-welder 0.775 (right) | 0.775 / 0.708 | — | en-plumber 0.660 | en-hvac 0.661 |
| ac-repair-en | en-hvac 0.742 (right) | 0.742 / 0.742 | en-handyman 0.661 | en-plumber 0.669 | es-plomero 0.660 |
| nurse-en | en-nurse 0.754 (right) | 0.754 / 0.754 | en-caregiver 0.683 | — | en-handyman 0.644 |
| caregiver-en | en-caregiver 0.740 (right) | 0.740 / 0.740 | en-nurse 0.634 | en-cleaner 0.658 | en-handyman 0.630 |
| app-en | en-developer 0.733 (right) | 0.733 / 0.707 | en-data-analyst 0.583 | — | en-accountant 0.609 |
| dashboard-en | en-data-analyst 0.790 (right) | 0.790 / 0.790 | en-developer 0.621 | en-bookkeeper 0.653 | en-tax-advisor 0.632 |
| freight-en | en-truck-driver 0.731 (right) | 0.731 / 0.655 | — | en-crane-operator 0.589 | en-plumber 0.618 |
| jantar-pt | pt-cozinheiro 0.741 (right) | 0.741 / 0.649 | — | en-caregiver 0.593 | pt-encanador 0.646 |
| gardener-en | en-gardener 0.757 (right) | 0.757 / 0.707 | en-handyman 0.649 | en-cleaner 0.647 | en-bookkeeper 0.645 |
| rigger-en | en-rigger 0.710 (right) | 0.710 / 0.710 | en-crane-operator 0.664 | en-marine-engineer 0.679 | en-offshore-electrician 0.706 |
| translation-en | es-traductora 0.756 (right) | 0.756 / 0.756 | — | pt-advogado 0.671 | es-contador 0.652 |
| cleaning-en | en-cleaner 0.729 (right) | 0.729 / 0.729 | en-handyman 0.641 | en-painter 0.645 | en-plumber 0.631 |
| brakes-en | en-mechanic 0.718 (right) | 0.718 / 0.718 | — | en-truck-driver 0.600 | en-handyman 0.644 |

## Synthetic set at 768, the plane's text (the registry's English names appended to a Portuguese or Spanish listing)

The right listing ranks first for 24 of 24 sentences. Cosine by relation, mean (5th to 95th percentile, min, max); a right listing in another language than the sentence's is counted again as cross-language:

| Relation | Pairs | Cosine |
|---|---|---|
| right | 46 | 0.722 (0.652 to 0.777, min 0.649, max 0.790) |
| near | 24 | 0.652 (0.594 to 0.693, min 0.583, max 0.694) |
| industry | 99 | 0.613 (0.560 to 0.669, min 0.529, max 0.726) |
| far | 743 | 0.570 (0.516 to 0.626, min 0.453, max 0.706) |
| right, cross-language | 22 | 0.696 (0.651 to 0.742, min 0.649, max 0.758) |

The floor sweep: the share of each relation at or above the floor, which is what Curated mode would count as tier 2 of the listings that missed the token gate.

| Floor | Right kept | Right kept, cross-language | Near kept | Industry admitted | Far admitted |
|---|---|---|---|---|---|
| 0.5 | 100.0% | 100.0% | 100.0% | 100.0% | 98.3% |
| 0.55 | 100.0% | 100.0% | 100.0% | 98.0% | 75.4% |
| 0.6 | 100.0% | 100.0% | 91.7% | 61.6% | 16.6% |
| 0.62 | 100.0% | 100.0% | 83.3% | 42.4% | 7.0% |
| 0.64 | 100.0% | 100.0% | 70.8% | 20.2% | 2.6% |
| 0.65 | 97.8% | 95.5% | 58.3% | 16.2% | 1.1% |
| 0.66 | 91.3% | 81.8% | 54.2% | 8.1% | 0.5% |
| 0.67 | 89.1% | 77.3% | 20.8% | 4.0% | 0.4% |
| 0.68 | 82.6% | 63.6% | 20.8% | 3.0% | 0.3% |
| 0.69 | 78.3% | 54.5% | 16.7% | 2.0% | 0.1% |
| 0.7 | 71.7% | 40.9% | 0.0% | 1.0% | 0.1% |
| 0.72 | 54.3% | 22.7% | 0.0% | 1.0% | 0.0% |
| 0.74 | 34.8% | 9.1% | 0.0% | 0.0% | 0.0% |
| 0.76 | 17.4% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.78 | 2.2% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.8 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.81 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.82 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.83 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.84 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.85 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.86 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.87 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.88 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.9 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

## The recall eval's world at 768

Each hirer sentence against all nine fixture listings, whatever their region: the listing ranked first, the trade asked for (its best and lowest), and the best other listing. The recall eval expects the region-bound listing in the last column; a dash means none is in the sentence's region.

| Sentence | First | Trade best / lowest | Best other | Expected (region-bound) |
|---|---|---|---|---|
| sink-en | en-plumber 0.698 | 0.698 / 0.656 | pt-gardener 0.587 | en-plumber |
| ev-charger-en | en-electrician 0.757 | 0.757 / 0.654 | en-plumber 0.664 | en-electrician |
| rigger-en | en-electrician 0.682 (other) | 0.677 / 0.677 | en-electrician 0.682 | es-rigger |
| translation-en | es-translator 0.743 | 0.743 / 0.743 | es-plumber 0.609 | es-translator |
| gardener-en | pt-gardener 0.712 | 0.712 / 0.712 | en-plumber 0.638 | pt-gardener |
| sink-pt | en-plumber 0.655 | 0.655 / 0.635 | pt-gardener 0.616 | — |
| ev-charger-pt | en-electrician 0.694 | 0.694 / 0.687 | pt-gardener 0.651 | pt-electrician |
| rigger-pt | en-marine-engineer 0.681 (other) | 0.649 / 0.649 | en-marine-engineer 0.681 | es-rigger |
| translation-pt | es-translator 0.700 | 0.700 / 0.700 | pt-gardener 0.595 | es-translator |
| gardener-pt | pt-gardener 0.768 | 0.768 / 0.768 | pt-electrician 0.629 | pt-gardener |
| reais-pt | es-plumber 0.664 | 0.664 / 0.643 | pt-gardener 0.637 | — |
| sink-es | es-plumber 0.675 | 0.675 / 0.658 | es-rigger 0.611 | es-plumber |
| ev-charger-es | en-electrician 0.723 | 0.723 / 0.646 | es-plumber 0.675 | — |
| rigger-es | es-rigger 0.702 | 0.702 / 0.702 | en-marine-engineer 0.688 | es-rigger |
| translation-es | es-translator 0.740 | 0.740 / 0.740 | es-plumber 0.605 | es-translator |
| gardener-es | pt-gardener 0.728 | 0.728 / 0.728 | es-plumber 0.643 | pt-gardener |
| pesos-es | es-plumber 0.746 | 0.746 / 0.691 | es-rigger 0.610 | es-plumber |

## Synthetic set at 512, the phone's text

The right listing ranks first for 23 of 24 sentences. Cosine by relation, mean (5th to 95th percentile, min, max); a right listing in another language than the sentence's is counted again as cross-language:

| Relation | Pairs | Cosine |
|---|---|---|
| right | 46 | 0.729 (0.656 to 0.790, min 0.652, max 0.794) |
| near | 24 | 0.658 (0.612 to 0.707, min 0.585, max 0.708) |
| industry | 99 | 0.619 (0.567 to 0.676, min 0.531, max 0.746) |
| far | 743 | 0.576 (0.523 to 0.636, min 0.447, max 0.716) |
| right, cross-language | 22 | 0.700 (0.655 to 0.740, min 0.652, max 0.766) |

The floor sweep: the share of each relation at or above the floor, which is what Curated mode would count as tier 2 of the listings that missed the token gate.

| Floor | Right kept | Right kept, cross-language | Near kept | Industry admitted | Far admitted |
|---|---|---|---|---|---|
| 0.5 | 100.0% | 100.0% | 100.0% | 100.0% | 98.9% |
| 0.55 | 100.0% | 100.0% | 100.0% | 98.0% | 78.5% |
| 0.6 | 100.0% | 100.0% | 95.8% | 69.7% | 20.2% |
| 0.62 | 100.0% | 100.0% | 87.5% | 48.5% | 8.5% |
| 0.64 | 100.0% | 100.0% | 75.0% | 26.3% | 4.7% |
| 0.65 | 100.0% | 100.0% | 66.7% | 18.2% | 2.4% |
| 0.66 | 91.3% | 81.8% | 50.0% | 12.1% | 1.3% |
| 0.67 | 87.0% | 72.7% | 37.5% | 6.1% | 0.7% |
| 0.68 | 84.8% | 68.2% | 25.0% | 4.0% | 0.4% |
| 0.69 | 82.6% | 63.6% | 20.8% | 1.0% | 0.3% |
| 0.7 | 80.4% | 59.1% | 8.3% | 1.0% | 0.1% |
| 0.72 | 60.9% | 22.7% | 0.0% | 1.0% | 0.0% |
| 0.74 | 39.1% | 9.1% | 0.0% | 1.0% | 0.0% |
| 0.76 | 26.1% | 4.5% | 0.0% | 0.0% | 0.0% |
| 0.78 | 8.7% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.8 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.81 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.82 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.83 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.84 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.85 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.86 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.87 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.88 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.9 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

Per sentence: the listing ranked first, the best and the lowest right listing, and the best near, same-industry and far listing.

| Sentence | First | Right best / lowest | Near best | Industry best | Far best |
|---|---|---|---|---|---|
| accountant-taxes-en | en-tax-advisor 0.777 (right) | 0.777 / 0.696 | en-bookkeeper 0.707 | en-auditor 0.632 | en-data-analyst 0.600 |
| lawyer-lease-en | en-lawyer 0.762 (right) | 0.762 / 0.735 | en-paralegal 0.671 | en-accountant 0.650 | en-handyman 0.608 |
| advogado-aluguel-pt | pt-advogado 0.756 (right) | 0.756 / 0.657 | en-paralegal 0.621 | es-traductora 0.610 | pt-encanador 0.606 |
| contador-anual-es | es-contador 0.790 (right) | 0.790 / 0.714 | en-bookkeeper 0.708 | en-auditor 0.665 | es-electricista 0.651 |
| contador-renda-pt | es-contador 0.704 (right) | 0.704 / 0.662 | en-bookkeeper 0.656 | pt-advogado 0.631 | pt-cozinheiro 0.619 |
| bookkeeping-en | en-bookkeeper 0.785 (right) | 0.785 / 0.748 | en-tax-advisor 0.691 | en-auditor 0.636 | en-handyman 0.639 |
| audit-en | en-auditor 0.733 (right) | 0.733 / 0.733 | en-accountant 0.656 | en-bookkeeper 0.653 | en-data-analyst 0.645 |
| ev-charger-en | en-electrician 0.777 (right) | 0.777 / 0.716 | en-handyman 0.692 | en-hvac 0.689 | en-tax-advisor 0.646 |
| quadro-pt | pt-eletricista 0.750 (right) | 0.750 / 0.689 | en-handyman 0.674 | pt-encanador 0.746 | pt-cozinheiro 0.688 |
| sink-en | en-plumber 0.721 (right) | 0.721 / 0.655 | en-handyman 0.664 | en-carpenter 0.627 | en-cleaner 0.642 |
| calentador-es | es-plomero 0.791 (right) | 0.791 / 0.731 | en-handyman 0.668 | es-electricista 0.633 | es-jardinero 0.612 |
| pipe-welding-en | en-welder 0.775 (right) | 0.775 / 0.710 | — | en-plumber 0.664 | es-plomero 0.662 |
| ac-repair-en | en-hvac 0.743 (right) | 0.743 / 0.743 | en-handyman 0.665 | en-plumber 0.675 | es-plomero 0.672 |
| nurse-en | en-nurse 0.765 (right) | 0.765 / 0.765 | en-caregiver 0.693 | — | en-handyman 0.658 |
| caregiver-en | en-caregiver 0.739 (right) | 0.739 / 0.739 | en-nurse 0.630 | en-cleaner 0.662 | en-handyman 0.631 |
| app-en | en-developer 0.728 (right) | 0.728 / 0.705 | en-data-analyst 0.585 | — | en-accountant 0.612 |
| dashboard-en | en-data-analyst 0.794 (right) | 0.794 / 0.794 | en-developer 0.631 | en-bookkeeper 0.658 | en-tax-advisor 0.642 |
| freight-en | en-truck-driver 0.732 (right) | 0.732 / 0.656 | — | en-crane-operator 0.594 | en-plumber 0.622 |
| jantar-pt | pt-cozinheiro 0.757 (right) | 0.757 / 0.652 | — | en-caregiver 0.596 | pt-advogado 0.658 |
| gardener-en | en-gardener 0.773 (right) | 0.773 / 0.718 | en-handyman 0.657 | en-cleaner 0.659 | en-bookkeeper 0.661 |
| rigger-en | en-offshore-electrician 0.716 (far) | 0.715 / 0.715 | en-crane-operator 0.673 | en-marine-engineer 0.685 | en-offshore-electrician 0.716 |
| translation-en | es-traductora 0.766 (right) | 0.766 / 0.766 | — | pt-advogado 0.676 | es-contador 0.662 |
| cleaning-en | en-cleaner 0.727 (right) | 0.727 / 0.727 | en-handyman 0.647 | en-painter 0.645 | en-plumber 0.642 |
| brakes-en | en-mechanic 0.723 (right) | 0.723 / 0.723 | — | en-truck-driver 0.610 | en-handyman 0.653 |

## Synthetic set at 512, the plane's text (the registry's English names appended to a Portuguese or Spanish listing)

The right listing ranks first for 23 of 24 sentences. Cosine by relation, mean (5th to 95th percentile, min, max); a right listing in another language than the sentence's is counted again as cross-language:

| Relation | Pairs | Cosine |
|---|---|---|
| right | 46 | 0.727 (0.657 to 0.778, min 0.652, max 0.794) |
| near | 24 | 0.658 (0.609 to 0.707, min 0.585, max 0.708) |
| industry | 99 | 0.617 (0.565 to 0.675, min 0.531, max 0.735) |
| far | 743 | 0.574 (0.520 to 0.635, min 0.447, max 0.716) |
| right, cross-language | 22 | 0.700 (0.655 to 0.742, min 0.652, max 0.766) |

The floor sweep: the share of each relation at or above the floor, which is what Curated mode would count as tier 2 of the listings that missed the token gate.

| Floor | Right kept | Right kept, cross-language | Near kept | Industry admitted | Far admitted |
|---|---|---|---|---|---|
| 0.5 | 100.0% | 100.0% | 100.0% | 100.0% | 98.8% |
| 0.55 | 100.0% | 100.0% | 100.0% | 97.0% | 77.7% |
| 0.6 | 100.0% | 100.0% | 95.8% | 66.7% | 19.4% |
| 0.62 | 100.0% | 100.0% | 87.5% | 47.5% | 8.5% |
| 0.64 | 100.0% | 100.0% | 75.0% | 24.2% | 4.3% |
| 0.65 | 100.0% | 100.0% | 66.7% | 18.2% | 1.7% |
| 0.66 | 93.5% | 86.4% | 50.0% | 12.1% | 1.1% |
| 0.67 | 89.1% | 77.3% | 37.5% | 6.1% | 0.4% |
| 0.68 | 87.0% | 72.7% | 25.0% | 4.0% | 0.3% |
| 0.69 | 80.4% | 59.1% | 20.8% | 2.0% | 0.3% |
| 0.7 | 76.1% | 50.0% | 8.3% | 1.0% | 0.1% |
| 0.72 | 63.0% | 27.3% | 0.0% | 1.0% | 0.0% |
| 0.74 | 34.8% | 13.6% | 0.0% | 0.0% | 0.0% |
| 0.76 | 26.1% | 4.5% | 0.0% | 0.0% | 0.0% |
| 0.78 | 4.3% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.8 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.81 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.82 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.83 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.84 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.85 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.86 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.87 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.88 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.9 | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

## The recall eval's world at 512

Each hirer sentence against all nine fixture listings, whatever their region: the listing ranked first, the trade asked for (its best and lowest), and the best other listing. The recall eval expects the region-bound listing in the last column; a dash means none is in the sentence's region.

| Sentence | First | Trade best / lowest | Best other | Expected (region-bound) |
|---|---|---|---|---|
| sink-en | en-plumber 0.712 | 0.712 / 0.670 | en-electrician 0.592 | en-plumber |
| ev-charger-en | en-electrician 0.764 | 0.764 / 0.662 | en-plumber 0.656 | en-electrician |
| rigger-en | es-rigger 0.691 | 0.691 / 0.691 | en-marine-engineer 0.686 | es-rigger |
| translation-en | es-translator 0.752 | 0.752 / 0.752 | es-plumber 0.609 | es-translator |
| gardener-en | pt-gardener 0.725 | 0.725 / 0.725 | en-plumber 0.646 | pt-gardener |
| sink-pt | en-plumber 0.672 | 0.672 / 0.651 | pt-gardener 0.619 | — |
| ev-charger-pt | en-electrician 0.705 | 0.705 / 0.697 | pt-gardener 0.649 | pt-electrician |
| rigger-pt | en-marine-engineer 0.686 (other) | 0.665 / 0.665 | en-marine-engineer 0.686 | es-rigger |
| translation-pt | es-translator 0.699 | 0.699 / 0.699 | pt-gardener 0.590 | es-translator |
| gardener-pt | pt-gardener 0.777 | 0.777 / 0.777 | pt-electrician 0.642 | pt-gardener |
| reais-pt | es-plumber 0.674 | 0.674 / 0.648 | pt-gardener 0.632 | — |
| sink-es | es-plumber 0.686 | 0.686 / 0.668 | es-rigger 0.626 | es-plumber |
| ev-charger-es | en-electrician 0.724 | 0.724 / 0.650 | es-plumber 0.679 | — |
| rigger-es | es-rigger 0.715 | 0.715 / 0.715 | en-marine-engineer 0.691 | es-rigger |
| translation-es | es-translator 0.741 | 0.741 / 0.741 | es-rigger 0.603 | es-translator |
| gardener-es | pt-gardener 0.740 | 0.740 / 0.740 | es-plumber 0.662 | pt-gardener |
| pesos-es | es-plumber 0.760 | 0.760 / 0.700 | es-rigger 0.623 | es-plumber |
