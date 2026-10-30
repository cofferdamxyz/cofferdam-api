# The Curated tier-2 floor for litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm at 2 widths, 2026-10-30

What a listing scores against a hirer's sentence when it misses the token gate, by its relation to the sentence, embedded as recall embeds them: the sentence a query (`task: search result | query:`), the listing's text a document (`title: none | text:`; its titles, skills and certificates as the phone sends them, without the registry's English names), litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm through LiteRT-LM's Python API on the Mac's CPU, pooled as the file declares and normalised, and at 512 the first 512 values normalised again. In Curated mode a token miss becomes a tier-2 finalist at `TIER2_FLOOR` (0.5 today, set on bge-m3's scale) or above, with no other gate, so the floor alone decides which of these a hirer is counted.

Two worlds. The synthetic set of `test/fixtures/work/tier2-floor.json`: 38 listings and 24 sentences in English, Portuguese and Spanish, each sentence naming the listings that are right (the occupation it asks for, in any language), near (an adjacent occupation a hirer would still want counted as tier 2) and of the same industry (another occupation: never a finalist); every other listing is far. And the recall eval's world: the nine fixture CVs of `cv-blocks.json` as `test/workRecall.eval.test.ts` drafts them, against the 17 hirer sentences of `hirer-prompts.json` that are not refused, right meaning the trade the sentence asks for in any region, and the recall eval's region-bound expectation beside it.

## Synthetic set at 768, the phone's text

The right listing ranks first for 23 of 24 sentences. Cosine by relation, mean (5th to 95th percentile, min, max); a right listing in another language than the sentence's is counted again as cross-language:

| Relation | Pairs | Cosine |
|---|---|---|
| right | 46 | 0.731 (0.657 to 0.791, min 0.645, max 0.798) |
| near | 24 | 0.660 (0.601 to 0.707, min 0.587, max 0.711) |
| industry | 99 | 0.628 (0.570 to 0.688, min 0.556, max 0.749) |
| far | 743 | 0.586 (0.531 to 0.640, min 0.464, max 0.724) |
| right, cross-language | 22 | 0.701 (0.649 to 0.745, min 0.645, max 0.756) |

The floor sweep: the share of each relation at or above the floor, which is what Curated mode would count as tier 2 of the listings that missed the token gate.

| Floor | Right kept | Right kept, cross-language | Near kept | Industry admitted | Far admitted |
|---|---|---|---|---|---|
| 0.5 | 100.0% | 100.0% | 100.0% | 100.0% | 99.2% |
| 0.55 | 100.0% | 100.0% | 100.0% | 100.0% | 89.1% |
| 0.6 | 100.0% | 100.0% | 95.8% | 76.8% | 30.7% |
| 0.62 | 100.0% | 100.0% | 91.7% | 58.6% | 12.8% |
| 0.64 | 100.0% | 100.0% | 79.2% | 32.3% | 5.0% |
| 0.65 | 95.7% | 90.9% | 62.5% | 22.2% | 3.2% |
| 0.66 | 93.5% | 86.4% | 54.2% | 15.2% | 1.9% |
| 0.67 | 89.1% | 77.3% | 37.5% | 12.1% | 0.7% |
| 0.68 | 87.0% | 72.7% | 20.8% | 8.1% | 0.7% |
| 0.69 | 84.8% | 68.2% | 16.7% | 4.0% | 0.7% |
| 0.7 | 80.4% | 59.1% | 12.5% | 3.0% | 0.5% |
| 0.72 | 65.2% | 27.3% | 0.0% | 1.0% | 0.1% |
| 0.74 | 47.8% | 13.6% | 0.0% | 1.0% | 0.0% |
| 0.76 | 23.9% | 0.0% | 0.0% | 0.0% | 0.0% |
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
| accountant-taxes-en | en-tax-advisor 0.778 (right) | 0.778 / 0.708 | en-bookkeeper 0.711 | en-auditor 0.667 | en-hvac 0.629 |
| lawyer-lease-en | en-lawyer 0.758 (right) | 0.758 / 0.724 | en-paralegal 0.666 | es-traductora 0.637 | en-plumber 0.619 |
| advogado-aluguel-pt | pt-advogado 0.734 (right) | 0.734 / 0.657 | en-paralegal 0.601 | es-traductora 0.601 | pt-encanador 0.612 |
| contador-anual-es | es-contador 0.777 (right) | 0.777 / 0.708 | en-bookkeeper 0.702 | en-auditor 0.653 | es-electricista 0.651 |
| contador-renda-pt | es-contador 0.687 (right) | 0.687 / 0.645 | en-bookkeeper 0.649 | pt-advogado 0.616 | pt-cozinheiro 0.617 |
| bookkeeping-en | en-bookkeeper 0.774 (right) | 0.774 / 0.723 | en-tax-advisor 0.675 | en-paralegal 0.617 | en-plumber 0.629 |
| audit-en | en-auditor 0.765 (right) | 0.765 / 0.765 | en-accountant 0.663 | en-bookkeeper 0.680 | en-data-analyst 0.656 |
| ev-charger-en | en-electrician 0.782 (right) | 0.782 / 0.714 | en-handyman 0.699 | en-hvac 0.703 | en-tax-advisor 0.642 |
| quadro-pt | pt-eletricista 0.759 (right) | 0.759 / 0.698 | en-handyman 0.670 | pt-encanador 0.749 | pt-cozinheiro 0.694 |
| sink-en | en-plumber 0.735 (right) | 0.735 / 0.664 | en-handyman 0.670 | en-hvac 0.636 | en-cleaner 0.668 |
| calentador-es | es-plomero 0.797 (right) | 0.797 / 0.741 | en-handyman 0.676 | es-electricista 0.648 | es-jardinero 0.636 |
| pipe-welding-en | en-welder 0.791 (right) | 0.791 / 0.719 | — | en-plumber 0.688 | en-hvac 0.669 |
| ac-repair-en | en-hvac 0.755 (right) | 0.755 / 0.755 | en-handyman 0.661 | en-plumber 0.683 | es-plomero 0.669 |
| nurse-en | en-nurse 0.755 (right) | 0.755 / 0.755 | en-caregiver 0.707 | — | en-cleaner 0.660 |
| caregiver-en | en-caregiver 0.751 (right) | 0.751 / 0.751 | en-nurse 0.637 | en-cleaner 0.659 | en-handyman 0.629 |
| app-en | en-developer 0.729 (right) | 0.729 / 0.708 | en-data-analyst 0.587 | — | en-accountant 0.619 |
| dashboard-en | en-data-analyst 0.798 (right) | 0.798 / 0.798 | en-developer 0.646 | en-bookkeeper 0.679 | en-tax-advisor 0.641 |
| freight-en | en-truck-driver 0.764 (right) | 0.764 / 0.677 | — | en-crane-operator 0.610 | en-plumber 0.630 |
| jantar-pt | pt-cozinheiro 0.742 (right) | 0.742 / 0.649 | — | en-caregiver 0.600 | pt-encanador 0.659 |
| gardener-en | en-gardener 0.760 (right) | 0.760 / 0.724 | en-handyman 0.646 | en-cleaner 0.657 | en-caregiver 0.650 |
| rigger-en | en-offshore-electrician 0.724 (far) | 0.723 / 0.723 | en-crane-operator 0.687 | en-marine-engineer 0.697 | en-offshore-electrician 0.724 |
| translation-en | es-traductora 0.756 (right) | 0.756 / 0.756 | — | pt-advogado 0.662 | es-contador 0.652 |
| cleaning-en | en-cleaner 0.745 (right) | 0.745 / 0.745 | en-handyman 0.640 | en-painter 0.653 | en-plumber 0.648 |
| brakes-en | en-mechanic 0.746 (right) | 0.746 / 0.746 | — | en-truck-driver 0.623 | en-handyman 0.660 |

## Synthetic set at 768, the plane's text (the registry's English names appended to a Portuguese or Spanish listing)

The right listing ranks first for 23 of 24 sentences. Cosine by relation, mean (5th to 95th percentile, min, max); a right listing in another language than the sentence's is counted again as cross-language:

| Relation | Pairs | Cosine |
|---|---|---|
| right | 46 | 0.730 (0.657 to 0.787, min 0.645, max 0.798) |
| near | 24 | 0.659 (0.601 to 0.707, min 0.587, max 0.711) |
| industry | 99 | 0.626 (0.570 to 0.688, min 0.556, max 0.745) |
| far | 743 | 0.584 (0.529 to 0.638, min 0.464, max 0.724) |
| right, cross-language | 22 | 0.701 (0.649 to 0.749, min 0.645, max 0.756) |

The floor sweep: the share of each relation at or above the floor, which is what Curated mode would count as tier 2 of the listings that missed the token gate.

| Floor | Right kept | Right kept, cross-language | Near kept | Industry admitted | Far admitted |
|---|---|---|---|---|---|
| 0.5 | 100.0% | 100.0% | 100.0% | 100.0% | 99.2% |
| 0.55 | 100.0% | 100.0% | 100.0% | 100.0% | 87.1% |
| 0.6 | 100.0% | 100.0% | 95.8% | 75.8% | 27.1% |
| 0.62 | 100.0% | 100.0% | 87.5% | 56.6% | 12.5% |
| 0.64 | 100.0% | 100.0% | 79.2% | 29.3% | 4.8% |
| 0.65 | 95.7% | 90.9% | 62.5% | 21.2% | 3.0% |
| 0.66 | 93.5% | 86.4% | 54.2% | 15.2% | 1.7% |
| 0.67 | 91.3% | 81.8% | 37.5% | 13.1% | 0.5% |
| 0.68 | 89.1% | 77.3% | 20.8% | 9.1% | 0.5% |
| 0.69 | 84.8% | 68.2% | 16.7% | 4.0% | 0.5% |
| 0.7 | 78.3% | 54.5% | 12.5% | 2.0% | 0.5% |
| 0.72 | 60.9% | 22.7% | 0.0% | 1.0% | 0.1% |
| 0.74 | 45.7% | 13.6% | 0.0% | 1.0% | 0.0% |
| 0.76 | 23.9% | 0.0% | 0.0% | 0.0% | 0.0% |
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

## The recall eval's world at 768

Each hirer sentence against all nine fixture listings, whatever their region: the listing ranked first, the trade asked for (its best and lowest), and the best other listing. The recall eval expects the region-bound listing in the last column; a dash means none is in the sentence's region.

| Sentence | First | Trade best / lowest | Best other | Expected (region-bound) |
|---|---|---|---|---|
| sink-en | en-plumber 0.728 | 0.728 / 0.684 | en-electrician 0.609 | en-plumber |
| ev-charger-en | en-electrician 0.764 | 0.764 / 0.663 | en-plumber 0.673 | en-electrician |
| rigger-en | en-electrician 0.711 (other) | 0.681 / 0.681 | en-electrician 0.711 | es-rigger |
| translation-en | es-translator 0.746 | 0.746 / 0.746 | es-plumber 0.625 | es-translator |
| gardener-en | pt-gardener 0.728 | 0.728 / 0.728 | en-plumber 0.648 | pt-gardener |
| sink-pt | en-plumber 0.660 | 0.660 / 0.649 | pt-gardener 0.635 | — |
| ev-charger-pt | pt-electrician 0.691 | 0.691 / 0.686 | pt-gardener 0.671 | pt-electrician |
| rigger-pt | en-marine-engineer 0.693 (other) | 0.654 / 0.654 | en-marine-engineer 0.693 | es-rigger |
| translation-pt | es-translator 0.707 | 0.707 / 0.707 | pt-gardener 0.602 | es-translator |
| gardener-pt | pt-gardener 0.781 | 0.781 / 0.781 | pt-electrician 0.637 | pt-gardener |
| reais-pt | es-plumber 0.651 | 0.651 / 0.650 | pt-gardener 0.651 | — |
| sink-es | es-plumber 0.689 | 0.689 / 0.672 | es-rigger 0.616 | es-plumber |
| ev-charger-es | en-electrician 0.721 | 0.721 / 0.657 | es-plumber 0.682 | — |
| rigger-es | en-marine-engineer 0.696 (other) | 0.690 / 0.690 | en-marine-engineer 0.696 | es-rigger |
| translation-es | es-translator 0.749 | 0.749 / 0.749 | es-plumber 0.619 | es-translator |
| gardener-es | pt-gardener 0.748 | 0.748 / 0.748 | es-plumber 0.645 | pt-gardener |
| pesos-es | es-plumber 0.755 | 0.755 / 0.703 | es-rigger 0.617 | es-plumber |

## Synthetic set at 512, the phone's text

The right listing ranks first for 23 of 24 sentences. Cosine by relation, mean (5th to 95th percentile, min, max); a right listing in another language than the sentence's is counted again as cross-language:

| Relation | Pairs | Cosine |
|---|---|---|
| right | 46 | 0.738 (0.666 to 0.793, min 0.648, max 0.808) |
| near | 24 | 0.667 (0.615 to 0.718, min 0.592, max 0.726) |
| industry | 99 | 0.635 (0.575 to 0.692, min 0.564, max 0.759) |
| far | 743 | 0.592 (0.535 to 0.650, min 0.471, max 0.734) |
| right, cross-language | 22 | 0.707 (0.653 to 0.754, min 0.648, max 0.768) |

The floor sweep: the share of each relation at or above the floor, which is what Curated mode would count as tier 2 of the listings that missed the token gate.

| Floor | Right kept | Right kept, cross-language | Near kept | Industry admitted | Far admitted |
|---|---|---|---|---|---|
| 0.5 | 100.0% | 100.0% | 100.0% | 100.0% | 99.3% |
| 0.55 | 100.0% | 100.0% | 100.0% | 100.0% | 92.1% |
| 0.6 | 100.0% | 100.0% | 95.8% | 84.8% | 37.3% |
| 0.62 | 100.0% | 100.0% | 91.7% | 69.7% | 16.7% |
| 0.64 | 100.0% | 100.0% | 83.3% | 38.4% | 7.0% |
| 0.65 | 97.8% | 95.5% | 79.2% | 30.3% | 5.0% |
| 0.66 | 95.7% | 90.9% | 50.0% | 19.2% | 3.4% |
| 0.67 | 91.3% | 81.8% | 41.7% | 14.1% | 1.9% |
| 0.68 | 89.1% | 77.3% | 33.3% | 9.1% | 0.8% |
| 0.69 | 87.0% | 72.7% | 20.8% | 7.1% | 0.7% |
| 0.7 | 87.0% | 72.7% | 12.5% | 4.0% | 0.7% |
| 0.72 | 71.7% | 40.9% | 4.2% | 1.0% | 0.1% |
| 0.74 | 52.2% | 13.6% | 0.0% | 1.0% | 0.0% |
| 0.76 | 32.6% | 4.5% | 0.0% | 0.0% | 0.0% |
| 0.78 | 13.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.8 | 4.3% | 0.0% | 0.0% | 0.0% | 0.0% |
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
| accountant-taxes-en | en-tax-advisor 0.781 (right) | 0.781 / 0.714 | en-bookkeeper 0.726 | en-auditor 0.664 | en-hvac 0.624 |
| lawyer-lease-en | en-lawyer 0.761 (right) | 0.761 / 0.722 | en-paralegal 0.667 | es-traductora 0.649 | en-plumber 0.622 |
| advogado-aluguel-pt | pt-advogado 0.742 (right) | 0.742 / 0.667 | en-paralegal 0.615 | es-traductora 0.620 | pt-encanador 0.619 |
| contador-anual-es | es-contador 0.791 (right) | 0.791 / 0.703 | en-bookkeeper 0.711 | en-auditor 0.667 | es-electricista 0.662 |
| contador-renda-pt | es-contador 0.701 (right) | 0.701 / 0.648 | en-bookkeeper 0.654 | pt-advogado 0.623 | pt-cozinheiro 0.623 |
| bookkeeping-en | en-bookkeeper 0.787 (right) | 0.787 / 0.732 | es-contador 0.684 | en-auditor 0.635 | en-handyman 0.632 |
| audit-en | en-auditor 0.764 (right) | 0.764 / 0.764 | en-accountant 0.655 | en-bookkeeper 0.679 | en-data-analyst 0.669 |
| ev-charger-en | en-electrician 0.780 (right) | 0.780 / 0.721 | en-handyman 0.700 | en-hvac 0.704 | en-mechanic 0.648 |
| quadro-pt | pt-eletricista 0.769 (right) | 0.769 / 0.705 | en-handyman 0.681 | pt-encanador 0.759 | pt-cozinheiro 0.707 |
| sink-en | en-plumber 0.750 (right) | 0.750 / 0.673 | en-handyman 0.678 | en-carpenter 0.639 | en-cleaner 0.671 |
| calentador-es | es-plomero 0.808 (right) | 0.808 / 0.749 | en-handyman 0.686 | es-electricista 0.657 | es-jardinero 0.644 |
| pipe-welding-en | en-welder 0.793 (right) | 0.793 / 0.723 | — | en-plumber 0.692 | en-hvac 0.679 |
| ac-repair-en | en-hvac 0.760 (right) | 0.760 / 0.760 | en-handyman 0.666 | en-plumber 0.691 | es-plomero 0.682 |
| nurse-en | en-nurse 0.767 (right) | 0.767 / 0.767 | en-caregiver 0.718 | — | en-plumber 0.675 |
| caregiver-en | en-caregiver 0.749 (right) | 0.749 / 0.749 | en-nurse 0.638 | en-cleaner 0.666 | en-handyman 0.633 |
| app-en | en-developer 0.728 (right) | 0.728 / 0.709 | en-data-analyst 0.592 | — | en-accountant 0.618 |
| dashboard-en | en-data-analyst 0.802 (right) | 0.802 / 0.802 | en-developer 0.657 | en-bookkeeper 0.684 | en-tax-advisor 0.650 |
| freight-en | en-truck-driver 0.768 (right) | 0.768 / 0.682 | — | en-crane-operator 0.621 | en-plumber 0.635 |
| jantar-pt | pt-cozinheiro 0.758 (right) | 0.758 / 0.653 | — | en-caregiver 0.607 | pt-encanador 0.667 |
| gardener-en | en-gardener 0.778 (right) | 0.778 / 0.739 | en-handyman 0.658 | en-cleaner 0.675 | en-bookkeeper 0.660 |
| rigger-en | en-offshore-electrician 0.734 (far) | 0.732 / 0.732 | en-crane-operator 0.697 | en-marine-engineer 0.701 | en-offshore-electrician 0.734 |
| translation-en | es-traductora 0.768 (right) | 0.768 / 0.768 | — | pt-advogado 0.666 | es-contador 0.664 |
| cleaning-en | en-cleaner 0.747 (right) | 0.747 / 0.747 | en-handyman 0.653 | en-painter 0.660 | en-plumber 0.663 |
| brakes-en | en-mechanic 0.755 (right) | 0.755 / 0.755 | — | en-truck-driver 0.637 | en-plumber 0.676 |

## Synthetic set at 512, the plane's text (the registry's English names appended to a Portuguese or Spanish listing)

The right listing ranks first for 23 of 24 sentences. Cosine by relation, mean (5th to 95th percentile, min, max); a right listing in another language than the sentence's is counted again as cross-language:

| Relation | Pairs | Cosine |
|---|---|---|
| right | 46 | 0.736 (0.666 to 0.793, min 0.648, max 0.802) |
| near | 24 | 0.666 (0.615 to 0.718, min 0.592, max 0.726) |
| industry | 99 | 0.633 (0.575 to 0.692, min 0.564, max 0.751) |
| far | 743 | 0.590 (0.534 to 0.648, min 0.471, max 0.734) |
| right, cross-language | 22 | 0.708 (0.653 to 0.759, min 0.648, max 0.768) |

The floor sweep: the share of each relation at or above the floor, which is what Curated mode would count as tier 2 of the listings that missed the token gate.

| Floor | Right kept | Right kept, cross-language | Near kept | Industry admitted | Far admitted |
|---|---|---|---|---|---|
| 0.5 | 100.0% | 100.0% | 100.0% | 100.0% | 99.3% |
| 0.55 | 100.0% | 100.0% | 100.0% | 100.0% | 90.6% |
| 0.6 | 100.0% | 100.0% | 95.8% | 82.8% | 33.6% |
| 0.62 | 100.0% | 100.0% | 91.7% | 66.7% | 16.3% |
| 0.64 | 100.0% | 100.0% | 79.2% | 36.4% | 6.6% |
| 0.65 | 97.8% | 95.5% | 79.2% | 27.3% | 4.7% |
| 0.66 | 95.7% | 90.9% | 50.0% | 18.2% | 3.1% |
| 0.67 | 91.3% | 81.8% | 41.7% | 14.1% | 1.6% |
| 0.68 | 91.3% | 81.8% | 33.3% | 10.1% | 0.5% |
| 0.69 | 89.1% | 77.3% | 20.8% | 7.1% | 0.5% |
| 0.7 | 82.6% | 63.6% | 12.5% | 3.0% | 0.5% |
| 0.72 | 69.6% | 36.4% | 4.2% | 1.0% | 0.1% |
| 0.74 | 47.8% | 13.6% | 0.0% | 1.0% | 0.0% |
| 0.76 | 30.4% | 4.5% | 0.0% | 0.0% | 0.0% |
| 0.78 | 13.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| 0.8 | 2.2% | 0.0% | 0.0% | 0.0% | 0.0% |
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
| sink-en | en-plumber 0.746 | 0.746 / 0.699 | en-electrician 0.618 | en-plumber |
| ev-charger-en | en-electrician 0.769 | 0.769 / 0.670 | en-plumber 0.662 | en-electrician |
| rigger-en | en-electrician 0.713 (other) | 0.698 / 0.698 | en-electrician 0.713 | es-rigger |
| translation-en | es-translator 0.757 | 0.757 / 0.757 | es-plumber 0.629 | es-translator |
| gardener-en | pt-gardener 0.746 | 0.746 / 0.746 | en-plumber 0.663 | pt-gardener |
| sink-pt | en-plumber 0.681 | 0.681 / 0.669 | pt-gardener 0.642 | — |
| ev-charger-pt | pt-electrician 0.704 | 0.704 / 0.700 | pt-gardener 0.675 | pt-electrician |
| rigger-pt | en-marine-engineer 0.699 (other) | 0.672 / 0.672 | en-marine-engineer 0.699 | es-rigger |
| translation-pt | es-translator 0.714 | 0.714 / 0.714 | pt-welder 0.606 | es-translator |
| gardener-pt | pt-gardener 0.792 | 0.792 / 0.792 | pt-electrician 0.655 | pt-gardener |
| reais-pt | es-plumber 0.667 | 0.667 / 0.659 | pt-gardener 0.649 | — |
| sink-es | es-plumber 0.704 | 0.704 / 0.685 | es-rigger 0.633 | es-plumber |
| ev-charger-es | en-electrician 0.722 | 0.722 / 0.661 | es-plumber 0.688 | — |
| rigger-es | es-rigger 0.709 | 0.709 / 0.709 | en-marine-engineer 0.704 | es-rigger |
| translation-es | es-translator 0.754 | 0.754 / 0.754 | es-plumber 0.621 | es-translator |
| gardener-es | pt-gardener 0.762 | 0.762 / 0.762 | es-plumber 0.668 | pt-gardener |
| pesos-es | es-plumber 0.769 | 0.769 / 0.711 | es-rigger 0.631 | es-plumber |
