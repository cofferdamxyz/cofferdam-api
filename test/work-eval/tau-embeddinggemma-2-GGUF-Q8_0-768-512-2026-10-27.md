# τ for gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 at 2 widths, set against @cf/baai/bge-m3, 2026-10-27

ESCO v1.2.1's alternative and hidden labels, 1000 strings each of occupations and of skills in English, Portuguese and Spanish, the same for both models, each snapped as a query against every other label of its kind (62598 occupation and 154673 skill labels; the string's own words on its token left out), @cf/baai/bge-m3 over the Workers AI REST API and gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 with llama.cpp's llama-embedding, both on the Mac. Retrieval as the registry's: the 20 nearest labels, best per token, τ_auto through a label in the string's language or English. Right means the token whose label the string is. Texts a model would not embed (bge-m3 0, gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 0) are left out of its labels and its strings.

At each width (the vectors cut to their first dimensions and normalised again, from the same embedding), gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0's τ_auto is the lowest that takes no more strings without Clef than bge-m3's 0.95 does (40.4%), so the band carries what it carries today and the gain is in precision: an auto-take is final, and under OD-27 its alias counts at once, so precision is not traded for fewer Clef calls. Its τ_low is the highest, below that, that leaves out no more strings whose token was among the best 5 than bge-m3's at 0.6 (0.1%). Wrong takes are a share of all strings: what τ_auto snaps wrongly without a model.

| Model | Strings | Right at 1 | τ_auto | Taken | Taken and right | Wrong takes | τ_low | In the band or above | Right among 5 below τ_low |
|---|---|---|---|---|---|---|---|---|---|
| @cf/baai/bge-m3 | 2000 | 79.4% | 0.95 | 40.4% | 83.5% | 6.7% | 0.6 | 100.0% | 0.1% |
| gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 | 2000 | 82.3% | 0.96 | 35.5% | 84.0% | 5.7% | 0.81 | 99.5% | 0.1% |
| gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 at 512 | 2000 | 82.8% | 0.96 | 38.1% | 84.0% | 6.1% | 0.81 | 99.6% | 0.1% |

Recall of the held-out strings (the right token first, and among the best five), and the cosine of unrelated pairs: two labels of different tokens, and a string against a label of another token, mean and 95th percentile, the same draws at every width:

| Model | Recall@1 | Recall@5 | Unrelated labels | String against another token |
|---|---|---|---|---|
| @cf/baai/bge-m3 | 79.4% | 95.5% | 0.424 (0.551) | 0.428 (0.553) |
| gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 | 82.3% | 96.5% | 0.676 (0.749) | 0.632 (0.708) |
| gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 at 512 | 82.8% | 96.5% | 0.678 (0.752) | 0.635 (0.712) |

By kind, at the same values:

| Model | Kind | Strings | Right at 1 | Right among 5 | Taken | Taken and right | Wrong takes | Right among 5 below τ_low |
|---|---|---|---|---|---|---|---|---|
| @cf/baai/bge-m3 | pos | 1000 | 72.1% | 93.9% | 27.9% | 62.4% | 10.5% | 0.0% |
| gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 | pos | 1000 | 77.3% | 96.0% | 33.0% | 73.3% | 8.8% | 0.0% |
| gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 at 512 | pos | 1000 | 77.8% | 95.9% | 36.0% | 73.9% | 9.4% | 0.0% |
| @cf/baai/bge-m3 | skill | 1000 | 86.7% | 97.2% | 52.9% | 94.7% | 2.8% | 0.1% |
| gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 | skill | 1000 | 87.4% | 97.1% | 38.1% | 93.2% | 2.6% | 0.1% |
| gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 at 512 | skill | 1000 | 87.7% | 97.2% | 40.2% | 93.0% | 2.8% | 0.1% |

gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 across thresholds:

| Threshold | Taken | Taken and right | Wrong takes | Right among 5 below |
|---|---|---|---|---|
| 0.3 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.35 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.4 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.45 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.5 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.55 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.6 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.65 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.7 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.71 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.72 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.73 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.74 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.75 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.76 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.77 | 99.7% | 82.5% | 17.4% | 0.0% |
| 0.78 | 99.6% | 82.5% | 17.4% | 0.0% |
| 0.79 | 99.5% | 82.7% | 17.3% | 0.0% |
| 0.8 | 99.3% | 82.7% | 17.2% | 0.1% |
| 0.81 | 99.1% | 82.8% | 17.0% | 0.1% |
| 0.82 | 98.9% | 82.9% | 16.9% | 0.1% |
| 0.83 | 98.5% | 83.2% | 16.5% | 0.3% |
| 0.84 | 98.0% | 83.3% | 16.4% | 0.4% |
| 0.85 | 97.5% | 83.3% | 16.3% | 0.8% |
| 0.86 | 96.5% | 83.5% | 15.9% | 1.8% |
| 0.87 | 95.8% | 83.6% | 15.7% | 2.4% |
| 0.88 | 94.3% | 84.0% | 15.0% | 4.0% |
| 0.89 | 92.3% | 84.5% | 14.3% | 5.7% |
| 0.9 | 89.3% | 85.1% | 13.4% | 8.3% |
| 0.95 | 50.9% | 86.1% | 7.1% | 46.5% |

gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0 at 512 across thresholds:

| Threshold | Taken | Taken and right | Wrong takes | Right among 5 below |
|---|---|---|---|---|
| 0.3 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.35 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.4 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.45 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.5 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.55 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.6 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.65 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.7 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.71 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.72 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.73 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.74 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.75 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.76 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.77 | 99.7% | 82.9% | 17.1% | 0.0% |
| 0.78 | 99.6% | 82.9% | 17.0% | 0.0% |
| 0.79 | 99.5% | 83.0% | 16.9% | 0.0% |
| 0.8 | 99.3% | 83.1% | 16.8% | 0.0% |
| 0.81 | 99.2% | 83.2% | 16.7% | 0.1% |
| 0.82 | 98.9% | 83.4% | 16.4% | 0.1% |
| 0.83 | 98.6% | 83.6% | 16.2% | 0.3% |
| 0.84 | 98.3% | 83.8% | 16.0% | 0.4% |
| 0.85 | 97.6% | 83.8% | 15.8% | 0.8% |
| 0.86 | 96.8% | 83.9% | 15.6% | 1.5% |
| 0.87 | 96.0% | 84.1% | 15.3% | 2.1% |
| 0.88 | 94.7% | 84.5% | 14.7% | 3.5% |
| 0.89 | 93.1% | 84.9% | 14.1% | 4.9% |
| 0.9 | 90.3% | 85.4% | 13.2% | 7.4% |
| 0.95 | 53.2% | 86.4% | 7.2% | 44.1% |
