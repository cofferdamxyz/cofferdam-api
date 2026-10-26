# τ for @cf/google/embeddinggemma-300m, set against @cf/baai/bge-m3, 2026-10-26

ESCO v1.2.1's alternative and hidden labels, 1000 strings each of occupations and of skills in English, Portuguese and Spanish, the same for both models, each snapped as a query against every other label of its kind (62598 occupation and 154673 skill labels; the string's own words on its token left out), over the Workers AI REST API from the Mac. Retrieval as the registry's: the 20 nearest labels, best per token, τ_auto through a label in the string's language or English. Right means the token whose label the string is. Texts a model would not embed (bge-m3 0, @cf/google/embeddinggemma-300m 0) are left out of its labels and its strings.

@cf/google/embeddinggemma-300m's τ_auto is the lowest that takes no more strings without Clef than bge-m3's 0.95 does (40.4%), so the band carries what it carries today and the gain is in precision: an auto-take is final, and under OD-27 its alias counts at once, so precision is not traded for fewer Clef calls. Its τ_low is the highest, below that, that leaves out no more strings whose token was among the best 5 than bge-m3's at 0.6 (0.1%). Wrong takes are a share of all strings: what τ_auto snaps wrongly without a model.

| Model | Strings | Right at 1 | τ_auto | Taken | Taken and right | Wrong takes | τ_low | In the band or above | Right among 5 below τ_low |
|---|---|---|---|---|---|---|---|---|---|
| @cf/baai/bge-m3 | 2000 | 79.4% | 0.95 | 40.4% | 83.5% | 6.7% | 0.6 | 100.0% | 0.1% |
| @cf/google/embeddinggemma-300m | 2000 | 81.5% | 0.81 | 37.5% | 92.1% | 2.9% | 0.45 | 99.7% | 0.1% |

By kind, at the same values:

| Model | Kind | Strings | Right at 1 | Taken | Taken and right | Wrong takes | Right among 5 below τ_low |
|---|---|---|---|---|---|---|---|
| @cf/baai/bge-m3 | pos | 1000 | 72.1% | 27.9% | 62.4% | 10.5% | 0.0% |
| @cf/google/embeddinggemma-300m | pos | 1000 | 76.4% | 23.4% | 86.3% | 3.2% | 0.0% |
| @cf/baai/bge-m3 | skill | 1000 | 86.7% | 52.9% | 94.7% | 2.8% | 0.1% |
| @cf/google/embeddinggemma-300m | skill | 1000 | 86.7% | 51.6% | 94.8% | 2.7% | 0.1% |

@cf/google/embeddinggemma-300m across thresholds:

| Threshold | Taken | Taken and right | Wrong takes | Right among 5 below |
|---|---|---|---|---|
| 0.3 | 99.9% | 81.6% | 18.4% | 0.0% |
| 0.35 | 99.9% | 81.6% | 18.4% | 0.0% |
| 0.4 | 99.7% | 81.7% | 18.3% | 0.0% |
| 0.45 | 99.5% | 81.8% | 18.1% | 0.1% |
| 0.5 | 99.3% | 82.0% | 17.8% | 0.3% |
| 0.55 | 98.4% | 82.4% | 17.3% | 0.7% |
| 0.6 | 96.6% | 83.0% | 16.4% | 2.0% |
| 0.65 | 92.3% | 84.1% | 14.7% | 5.8% |
| 0.7 | 82.0% | 85.5% | 11.8% | 15.0% |
| 0.71 | 77.8% | 86.0% | 10.9% | 18.9% |
| 0.72 | 74.4% | 86.3% | 10.2% | 22.4% |
| 0.73 | 70.9% | 86.5% | 9.6% | 25.8% |
| 0.74 | 67.0% | 87.0% | 8.7% | 29.8% |
| 0.75 | 63.0% | 87.9% | 7.6% | 33.7% |
| 0.76 | 58.6% | 88.6% | 6.7% | 37.9% |
| 0.77 | 54.4% | 89.6% | 5.7% | 41.9% |
| 0.78 | 49.9% | 90.5% | 4.8% | 46.3% |
| 0.79 | 45.3% | 91.3% | 4.0% | 50.8% |
| 0.8 | 41.3% | 91.5% | 3.5% | 54.8% |
| 0.81 | 37.5% | 92.1% | 2.9% | 58.6% |
| 0.82 | 33.8% | 92.9% | 2.4% | 62.2% |
| 0.83 | 30.8% | 93.8% | 1.9% | 65.2% |
| 0.84 | 26.4% | 95.4% | 1.2% | 69.5% |
| 0.85 | 21.3% | 94.8% | 1.1% | 74.4% |
| 0.86 | 17.0% | 95.0% | 0.9% | 78.7% |
| 0.87 | 12.7% | 93.7% | 0.8% | 83.0% |
| 0.88 | 8.8% | 96.0% | 0.4% | 86.9% |
| 0.89 | 5.4% | 94.4% | 0.3% | 90.3% |
| 0.9 | 2.6% | 94.3% | 0.1% | 93.0% |
| 0.95 | 0.0% | 100.0% | 0.0% | 95.7% |
