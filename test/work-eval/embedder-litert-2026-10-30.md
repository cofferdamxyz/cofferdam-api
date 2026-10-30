# EmbeddingGemma 2 through LiteRT-LM against the GGUF behind v3, 2026-10-30

The check workspace decision 0068 asked for before the phone's embedder moves to LiteRT-LM (the founder's rulings of 2026-10-29, night): the vectors of LiteRT-LM's EmbeddingGemma 2 against those of `embeddinggemma-2-Q8_0.gguf`, which `token-registry-v3` and `jobs-listings-v3` hold, on the same strings, prefixes and pooling. The bar is the one rule (2) set when Q8_0 met bf16 on 2026-10-26: a cosine of 0.9998 at worst.

## Setup

- **GGUF:** `ggml-org/embeddinggemma-2-GGUF` at `58faf90`, `embeddinggemma-2-Q8_0.gguf` (SHA-256 `2188ac1d…`), through Homebrew's llama.cpp 0.7.0 (build 11669) `llama-embedding`, exactly as `scripts/work/embed-registry.mjs` runs it: `--pooling mean --embd-normalize 2`, one text a line.
- **LiteRT-LM:** `litert-community/embeddinggemma-2-text-270m-litert-lm` at `9be6e8b`, `embeddinggemma-2-text-270m.litertlm` (164,626,432 bytes, SHA-256 `2d079ee2…`): Google's text-only build, int4 per-channel weights trained for that quantisation (QAT), 270M parameters. LiteRT-LM's Python API, `litert-lm-api-nightly` 0.19.0.dev20261028 (the build the iPhone's Swift nightly comes from), the CPU, the engine's defaults: special tokens inserted, L2-normalised, 768 values.
- **Both:** the same prefixes (`title: none | text: ` for a document, `task: search result | query: ` for a query), `<bos>` and `<eos>` around the text on both (llama.cpp's tokenizer; LiteRT-LM's default), mean pooling as each file declares, normalised again by the script.
- **Strings:** 3,139, embedded by both. 2,400 labels of the v3 index files (`~/Development/esco/import/registry-embeddinggemma-2`, the certificate seed left out), 400 per kind and language (occupations and skills, in English, Spanish and Portuguese), as documents, set also against the vector v3 stores for them; 600 more labels, 100 per kind and language, as queries (a CV's claim string); the 24 hirer sentences of `test/fixtures/work/tier2-floor.json` and the 17 of `hirer-prompts.json` that are not refused, as queries; the 38 synthetic listings of `tier2-floor.json` and 60 listing-shaped documents of three titles and thirty skills, as documents.
- **Scripts:** `scripts/work/embed-litert-compare.py` (the cosines, the snap, the tier-2 world) and `scripts/work/embed-litert-heldout.py` (each runtime in its own space), seeds 68 and 69, on the Mac's CPU.

## Per string

The GGUF today gives v3's stored vectors back: cosine 0.9999991 at worst over the 2,400 labels (the files round to six decimals). So any gap below is the artefact's.

| Strings | n | Worst | 0.1st percentile | 1st | 5th | Median | Mean |
|---|---|---|---|---|---|---|---|
| All | 3,139 | 0.9242 | 0.9445 | 0.9675 | 0.9808 | 0.9900 | 0.9888 |
| v3 labels, documents | 2,400 | 0.9242 | 0.9405 | 0.9659 | 0.9808 | 0.9901 | 0.9889 |
| Labels, queries | 600 | 0.9537 | 0.9537 | 0.9730 | 0.9825 | 0.9904 | 0.9894 |
| Hirer sentences (`tier2-floor.json`) | 24 | 0.9780 | | | 0.9814 | 0.9866 | 0.9863 |
| Hirer sentences (`hirer-prompts.json`) | 17 | 0.9791 | | | | 0.9877 | 0.9869 |
| Synthetic listings | 38 | 0.9801 | | | 0.9804 | 0.9865 | 0.9858 |
| Listings of 3 titles and 30 skills | 60 | 0.9751 | | | 0.9775 | 0.9848 | 0.9839 |

By kind and language (documents), the worst and the median: English occupations 0.9469 and 0.9904, Spanish 0.9574 and 0.9903, Portuguese 0.9445 and 0.9887; English skills 0.9242 and 0.9905, Spanish 0.9386 and 0.9906, Portuguese 0.9509 and 0.9900. The lowest are short labels of one to four words (ESCO's "transcreation" 0.924, "dar instrucciones a gruístas" 0.939, "cumplir plazos" 0.941, "Ourives gravadora" 0.945); long texts lose less, the listings of thirty skills holding 0.975 at worst.

**It does not match.** The median string sits at 0.990 and the worst at 0.924, against 0.9998. The int4 weights are not Q8_0's: LiteRT-LM's EmbeddingGemma 2 is another artefact of the same model, so its vectors are a new index generation (decision 0067), not v3's.

## Mixed into v3

The 600 labels as claim strings, LiteRT-LM's query vector against v3's stored document vectors of the same kind (all 229,654, the string's own label left out), beside the GGUF's own query vector:

- The best label is the same for 527 of 600 (88%); the five best overlap 91.5% on average.
- On the GGUF's best label, LiteRT-LM scores 0.0067 lower at the median (0.016 lower at the 5th percentile, 0.055 at most; 0.037 higher at most).
- τ_auto (0.96): 89 of the 600 best labels at or above it with the GGUF fall below it with LiteRT-LM, and 1 goes the other way. τ_low (0.81) and the tier-2 floor (0.65): none crosses.

## Each in its own space

One held-out label a token as the query, every other label of the 600 sampled tokens as the documents (the query's own text left out in every language); right means the best label is the query's token.

| Kind | Documents | GGUF on GGUF (v3), right at 1 / in 5 | LiteRT-LM on LiteRT-LM | LiteRT-LM queries on v3 | Unrelated pairs, median (GGUF / LiteRT-LM) |
|---|---|---|---|---|---|
| Occupations | 14,346 | 530 / 584 | 525 / 584 | 526 / 584 | 0.684 / 0.695 |
| Skills | 5,892 | 582 / 598 | 584 / 597 | 584 / 596 | 0.663 / 0.671 |

On the tier-2 world of `tier2-floor.json`, the right listing ranks first for 24 of 24 sentences on the GGUF, 23 of 24 with LiteRT-LM's sentences on the GGUF's listings, and 23 of 24 with LiteRT-LM on both.

**It retrieves as well as the GGUF in its own space** (5 fewer of 600 occupations right at the first pick, 2 more skills), on a scale about 0.01 higher for unrelated pairs. So a generation built from it would read as v3 does once τ and the tier-2 floor are measured on its own scale; mixed into v3 it would send about one claim string in seven that v3 takes by τ_auto to Clef's band instead.

## Time

On the Mac's CPU, LiteRT-LM embedded a string in 31.7 ms at the median, one call a string (3,139 in 105 s); llama.cpp took 21 s for the 3,139 in batches of 1,000 on Metal. Google's model card gives 41.8 ms a text on an iPhone 18 Pro's CPU and 27.1 ms on a Galaxy S26 Ultra's.
