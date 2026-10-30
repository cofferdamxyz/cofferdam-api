# τ for litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm, set against @cf/baai/bge-m3, 2026-10-30

ESCO v1.2.1's alternative and hidden labels, 1000 strings each of occupations and of skills in English, Portuguese and Spanish, the same for both models, each snapped as a query against every other label of its kind (62598 occupation and 154673 skill labels; the string's own words on its token left out), @cf/baai/bge-m3 over the Workers AI REST API and litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm with LiteRT-LM's Python API on the CPU (scripts/work/litert-embed.py), both on the Mac. Retrieval as the registry's: the 20 nearest labels, best per token, τ_auto through a label in the string's language or English. Right means the token whose label the string is. Texts a model would not embed (bge-m3 0, litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm 0) are left out of its labels and its strings.

litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm's τ_auto is the lowest that takes no more strings without Clef than bge-m3's 0.95 does (40.4%), so the band carries what it carries today and the gain is in precision: an auto-take is final, and under OD-27 its alias counts at once, so precision is not traded for fewer Clef calls. Its τ_low is the highest, below that, that leaves out no more strings whose token was among the best 5 than bge-m3's at 0.6 (0.1%). Wrong takes are a share of all strings: what τ_auto snaps wrongly without a model.

| Model | Strings | Right at 1 | τ_auto | Taken | Taken and right | Wrong takes | τ_low | In the band or above | Right among 5 below τ_low |
|---|---|---|---|---|---|---|---|---|---|
| @cf/baai/bge-m3 | 2000 | 79.4% | 0.95 | 40.4% | 83.5% | 6.7% | 0.6 | 100.0% | 0.1% |
| litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm | 2000 | 82.0% | 0.96 | 36.4% | 84.5% | 5.7% | 0.81 | 99.6% | 0.1% |

Recall of the held-out strings (the right token first, and among the best five), and the cosine of unrelated pairs: two labels of different tokens, and a string against a label of another token, mean and 95th percentile, the same draws at every width:

| Model | Recall@1 | Recall@5 | Unrelated labels | String against another token |
|---|---|---|---|---|
| @cf/baai/bge-m3 | 79.4% | 95.5% | 0.424 (0.551) | 0.428 (0.553) |
| litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm | 82.0% | 96.3% | 0.685 (0.759) | 0.640 (0.715) |

By kind, at the same values:

| Model | Kind | Strings | Right at 1 | Right among 5 | Taken | Taken and right | Wrong takes | Right among 5 below τ_low |
|---|---|---|---|---|---|---|---|---|
| @cf/baai/bge-m3 | pos | 1000 | 72.1% | 93.9% | 27.9% | 62.4% | 10.5% | 0.0% |
| litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm | pos | 1000 | 76.6% | 95.7% | 32.3% | 73.7% | 8.5% | 0.0% |
| @cf/baai/bge-m3 | skill | 1000 | 86.7% | 97.2% | 52.9% | 94.7% | 2.8% | 0.1% |
| litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm | skill | 1000 | 87.4% | 96.8% | 40.6% | 93.1% | 2.8% | 0.1% |

litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm across thresholds:

| Threshold | Taken | Taken and right | Wrong takes | Right among 5 below |
|---|---|---|---|---|
| 0.3 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.35 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.4 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.45 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.5 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.55 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.6 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.65 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.7 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.71 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.72 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.73 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.74 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.75 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.76 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.77 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.78 | 99.6% | 82.2% | 17.7% | 0.0% |
| 0.79 | 99.5% | 82.3% | 17.6% | 0.0% |
| 0.8 | 99.4% | 82.4% | 17.5% | 0.0% |
| 0.81 | 99.1% | 82.5% | 17.3% | 0.1% |
| 0.82 | 98.9% | 82.7% | 17.1% | 0.1% |
| 0.83 | 98.6% | 82.9% | 16.9% | 0.2% |
| 0.84 | 98.2% | 82.9% | 16.8% | 0.4% |
| 0.85 | 97.7% | 83.0% | 16.6% | 0.7% |
| 0.86 | 96.6% | 83.5% | 16.0% | 1.6% |
| 0.87 | 95.9% | 83.6% | 15.7% | 2.5% |
| 0.88 | 94.8% | 83.9% | 15.3% | 3.5% |
| 0.89 | 93.0% | 84.6% | 14.3% | 5.0% |
| 0.9 | 90.0% | 85.0% | 13.5% | 7.6% |
| 0.95 | 50.2% | 85.6% | 7.2% | 46.8% |
