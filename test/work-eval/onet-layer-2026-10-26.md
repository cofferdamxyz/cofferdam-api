# The US layer before and after, 2026-10-26

O*NET 31.0 titles held out of the layer (one norm in ten by a fixed hash: 4391), 2000 of them sampled, each snapped against ESCO v1.2.1's occupation labels in English, Portuguese and Spanish (62598) and then against those and the layer's other labels (11205), with @cf/baai/bge-m3 over the Workers AI REST API from the Mac. A snap is an exact English label held by one token, else the 20 nearest labels in every language, best per token, taken at τ_auto only through an English one (the registry's rule since 2026-10-26); it is right when its token is one of the ESCO occupations the ESCO–O*NET crosswalk gives an O*NET occupation that lists the title. τ_auto 0.95, τ_low 0.6; Clef, the pivot and the mint are not run, so "among 5" is the most Clef could get right in the band.

| Titles | Registry | Right | Exact label | τ_auto | Band | Below the band |
|---|---|---|---|---|---|---|
| all (2000) | before | 33.6% | 9.7% (64.9% right) | 0.1% (100.0% right) | 89.2% (30.5% right at 1, 53.0% among 5) | 1.0% |
| all (2000) | after | 42.1% | 9.7% (64.9% right) | 2.1% (81.0% right) | 88.1% (38.8% right at 1, 61.7% among 5) | 0.1% |
| not an English ESCO label (1788) | before | 30.0% | 0.0% (— right) | 0.0% (— right) | 98.9% (30.3% right at 1, 52.8% among 5) | 1.1% |
| not an English ESCO label (1788) | after | 39.5% | 0.0% (— right) | 2.2% (80.0% right) | 97.7% (38.6% right at 1, 61.6% among 5) | 0.1% |

The layer changed 1115 of 2000 snaps: 292 from wrong to right, 122 from right to wrong.

Includes information from the O*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA), used under the CC BY 4.0 license; the titles were split and placed by Cofferdam Inc. (`cofferdam-api` `NOTICE`).
