# The US layer before and after, 2026-10-26

O*NET 31.0 titles held out of the layer (one norm in ten by a fixed hash: 4391), 2000 of them sampled, each snapped against ESCO v1.2.1's occupation labels in English, Portuguese and Spanish (62598) and then against those and the layer's other labels (11205), with @cf/google/embeddinggemma-300m over the Workers AI REST API from the Mac. A snap is an exact English label held by one token, else the 20 nearest labels in every language, best per token, taken at τ_auto only through an English one (the registry's rule since 2026-10-26); it is right when its token is one of the ESCO occupations the ESCO–O*NET crosswalk gives an O*NET occupation that lists the title. τ_auto 0.81, τ_low 0.45; Clef, the pivot and the mint are not run, so "among 5" is the most Clef could get right in the band.

| Titles | Registry | Right | Exact label | τ_auto | Band | Below the band |
|---|---|---|---|---|---|---|
| all (2000) | before | 36.8% | 9.7% (64.9% right) | 3.1% (48.4% right) | 86.8% (33.2% right at 1, 57.3% among 5) | 0.3% |
| all (2000) | after | 42.9% | 9.7% (64.9% right) | 3.3% (51.5% right) | 87.0% (40.1% right at 1, 64.9% among 5) | 0.0% |
| not an English ESCO label (1788) | before | 33.4% | 0.0% (— right) | 3.1% (47.3% right) | 96.5% (33.0% right at 1, 57.2% among 5) | 0.4% |
| not an English ESCO label (1788) | after | 40.3% | 0.0% (— right) | 3.3% (50.8% right) | 96.7% (39.9% right at 1, 64.8% among 5) | 0.0% |

The layer changed 443 of 2000 snaps: 153 from wrong to right, 30 from right to wrong.

Includes information from the O*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA), used under the CC BY 4.0 license; the titles were split and placed by Cofferdam Inc. (`cofferdam-api` `NOTICE`).
