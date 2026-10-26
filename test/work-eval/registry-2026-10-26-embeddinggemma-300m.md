# Canonicalization evaluation, 2026-10-26

Retrieve-then-choose over the synthetic occupation and skill seed (`test/fixtures/work/registry-seed.json`, no ESCO data) and the curated certificate seed (`src/services/work/certificates.json`: 24 certificates), 50 tokens and 264 labels in en, pt and es, each of 106 strings against a fresh copy, with `@cf/google/embeddinggemma-300m`, `@cf/cloudflare/clef-flash` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` over the Workers AI REST API from the Mac. τ_auto 0.81, τ_low 0.45. An occupation or a skill is a worker's, with their listing's market. A certificate is right only with its level and modules; one where none fits is right only when nothing snaps.

| Kind | Right | Wrong token or level | A token where none fits | No token where one fits |
|---|---|---|---|---|
| pos | 100% (23 of 23) | 0 | 0 | 0 |
| skill | 100% (20 of 20) | 0 | 0 | 0 |
| cert, a worker’s claim | 100% (46 of 46) | 0 | 0 | 0 |
| cert, a hirer’s requirement | 94.1% (16 of 17) | 0 | 0 | 1 |

Decisions: label 46, chosen 27, pivot 2, minted 5, unmatched 26. Cost per snap 0.000008 USD, median 618 ms. 1 snaps ran again after a hosted call threw; none still failed.

Cosine of the expected token's best label: min 0.432, median 0.646. Best cosine of strings with no fitting token: max 0.723.

Clef answered 29 strings in the band. Each answer read again at other floors (the shipped floor is 0.5): a pick counts at or above the floor, none too, and anything else is undecided.

| Floor | Picked the expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 29 | 0 | 0 | 0 |
| 0.4 | 28 | 0 | 0 | 1 |
| 0.5 | 27 | 0 | 0 | 2 |
| 0.6 | 27 | 0 | 0 | 2 |
| 0.7 | 24 | 0 | 0 | 5 |
| 0.8 | 17 | 0 | 0 | 12 |

| Kind | As | Language | String | Expected | Expected level, modules | Decision | Token | Level, modules | Top cos | Expected cos | Clef p | Clef band answer |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pos | worker, us-tx | en | Marine engineer | pos:marine-engineer | — | label | pos:marine-engineer | — | 0.79 | 0.79 | — | — |
| pos | worker, us-tx | en | Third Assistant Engineer | pos:marine-engineer | — | chosen | pos:marine-engineer | — | 0.46 | 0.46 | 0.83 | pos:marine-engineer 0.83, none 0.09 |
| pos | worker, us-tx | en | Engine Cadet | pos:marine-engineer | — | chosen | pos:marine-engineer | — | 0.688 | 0.688 | 0.69 | pos:marine-engineer 0.69, none 0.18 |
| pos | worker, us-tx | en | journeyman electrician | pos:electrician | — | chosen | pos:electrician | — | 0.5 | 0.5 | 0.80 | pos:electrician 0.80, none 0.04 |
| pos | worker, us-tx | en | Electrician Apprentice | pos:electrician | — | chosen | pos:electrician | — | 0.56 | 0.56 | 0.76 | pos:electrician 0.76, none 0.04 |
| pos | worker, us-tx | en | Residential plumber | pos:plumber | — | chosen | pos:plumber | — | 0.578 | 0.578 | 0.85 | pos:plumber 0.85, none 0.04 |
| pos | worker, us-tx | en | Service Plumber | pos:plumber | — | chosen | pos:plumber | — | 0.568 | 0.568 | 0.78 | pos:plumber 0.78, none 0.07 |
| pos | worker, us-tx | en | Plumber's Helper | pos:plumber | — | chosen | pos:plumber | — | 0.563 | 0.563 | 0.63 | pos:plumber 0.63, none 0.11 |
| pos | worker, br-sp | pt | Soldador de Tubulação | pos:welder | — | pivot | pos:welder | — | 0.593 | 0.593 | — | pos:welder 0.46, none 0.08 |
| pos | worker, br-sp | pt | Caldeireiro | pos:boilermaker | — | label | pos:boilermaker | — | 0.788 | 0.788 | — | — |
| pos | worker, br-sp | pt | Eletricista de Manutenção Industrial | pos:industrial-electrician | — | chosen | pos:industrial-electrician | — | 0.677 | 0.677 | 0.67 | pos:industrial-electrician 0.67, none 0.03 |
| pos | worker, br-sp | pt | Ajudante de Eletricista | pos:electrician | — | chosen | pos:electrician | — | 0.515 | 0.501 | 0.73 | pos:electrician 0.73, none 0.06 |
| pos | worker, br-sp | pt | Jardineiro e paisagista | pos:gardener | — | chosen | pos:gardener | — | 0.643 | 0.643 | 0.80 | pos:gardener 0.80, none 0.10 |
| pos | worker, br-sp | pt | Auxiliar de Paisagismo | pos:gardener | — | chosen | pos:gardener | — | 0.495 | 0.495 | 0.84 | pos:gardener 0.84, none 0.14 |
| pos | worker, mx-nle | es | Aparejador (Rigger) | pos:rigger | — | pivot | pos:rigger | — | 0.646 | 0.646 | — | pos:rigger 0.36, none 0.24 |
| pos | worker, mx-nle | es | Operador de Grúa Móvil | pos:crane-operator | — | chosen | pos:crane-operator | — | 0.669 | 0.669 | 0.89 | pos:crane-operator 0.89, none 0.03 |
| pos | worker, mx-nle | es | Traductora inglés-español | pos:translator | — | chosen | pos:translator | — | 0.61 | 0.61 | 0.77 | pos:translator 0.77, none 0.09 |
| pos | worker, mx-nle | es | Traductora Independiente | pos:translator | — | chosen | pos:translator | — | 0.6 | 0.6 | 0.86 | pos:translator 0.86, none 0.05 |
| pos | worker, mx-nle | es | Plomero Oficial | pos:plumber | — | chosen | pos:plumber | — | 0.634 | 0.634 | 0.76 | pos:plumber 0.76, none 0.05 |
| pos | worker, mx-nle | es | Ayudante de Plomería | pos:plumber | — | chosen | pos:plumber | — | 0.544 | 0.544 | 0.83 | pos:plumber 0.83, none 0.05 |
| pos | worker, us-tx | en | Pastry chef | — | — | minted | pos:pastry-chef | — | 0.308 | — | — | — |
| pos | worker, br-sp | pt | Motorista de caminhão | — | — | minted | pos:truck-driver | — | 0.398 | — | — | — |
| pos | worker, mx-nle | es | Cocinero de línea | — | — | minted | pos:cook | — | 0.382 | — | — | — |
| skill | worker, us-tx | en | fixing leaks | skill:leak-repair | — | label | skill:leak-repair | — | 0.73 | 0.73 | — | — |
| skill | worker, us-tx | en | Leak detection | skill:leak-detection | — | label | skill:leak-detection | — | 0.792 | 0.792 | — | — |
| skill | worker, us-tx | en | replacing water heaters | skill:water-heater-installation | — | chosen | skill:water-heater-installation | — | 0.581 | 0.581 | 0.84 | skill:water-heater-installation 0.84, none 0.06 |
| skill | worker, us-tx | en | clearing drains | skill:drain-cleaning | — | chosen | skill:drain-cleaning | — | 0.622 | 0.622 | 0.86 | skill:drain-cleaning 0.86, none 0.04 |
| skill | worker, us-tx | en | EV chargers | skill:ev-charger-installation | — | chosen | skill:ev-charger-installation | — | 0.629 | 0.629 | 0.86 | skill:ev-charger-installation 0.86, none 0.05 |
| skill | worker, us-tx | en | panel upgrades | skill:electrical-panel-upgrade | — | chosen | skill:electrical-panel-upgrade | — | 0.783 | 0.783 | 0.85 | skill:electrical-panel-upgrade 0.85, none 0.05 |
| skill | worker, us-tx | en | Diesel engine maintenance | skill:diesel-engine-maintenance | — | label | skill:diesel-engine-maintenance | — | 0.767 | 0.767 | — | — |
| skill | worker, br-sp | pt | Corte com maçarico | skill:torch-cutting | — | label | skill:torch-cutting | — | 0.78 | 0.78 | — | — |
| skill | worker, br-sp | pt | Leitura de desenho isométrico | skill:isometric-drawing-reading | — | chosen | skill:isometric-drawing-reading | — | 0.777 | 0.777 | 0.95 | skill:isometric-drawing-reading 0.95, none 0.02 |
| skill | worker, br-sp | pt | Corte de grama | skill:lawn-mowing | — | label | skill:lawn-mowing | — | 0.715 | 0.715 | — | — |
| skill | worker, br-sp | pt | poda de cercas vivas | skill:pruning | — | chosen | skill:pruning | — | 0.512 | 0.512 | 0.91 | skill:pruning 0.91, none 0.03 |
| skill | worker, br-sp | pt | Irrigação por gotejamento | skill:irrigation-maintenance | — | chosen | skill:irrigation-maintenance | — | 0.616 | 0.616 | 0.71 | skill:irrigation-maintenance 0.71, none 0.25 |
| skill | worker, mx-nle | es | Reparación de fugas | skill:leak-repair | — | label | skill:leak-repair | — | 0.733 | 0.733 | — | — |
| skill | worker, mx-nle | es | Detección de fugas | skill:leak-detection | — | label | skill:leak-detection | — | 0.75 | 0.75 | — | — |
| skill | worker, mx-nle | es | Instalación de calentadores | skill:water-heater-installation | — | label | skill:water-heater-installation | — | 0.745 | 0.745 | — | — |
| skill | worker, mx-nle | es | maniobras de carga | skill:rigging | — | label | skill:rigging | — | 0.755 | 0.755 | — | — |
| skill | worker, mx-nle | es | Operación de grúas telescópicas | skill:crane-operation | — | chosen | skill:crane-operation | — | 0.674 | 0.674 | 0.91 | skill:crane-operation 0.91, none 0.03 |
| skill | worker, mx-nle | es | Traducción de contratos comerciales | skill:legal-translation | — | chosen | skill:legal-translation | — | 0.628 | 0.628 | 0.95 | skill:legal-translation 0.95, none 0.02 |
| skill | worker, us-tx | en | bilge water management | — | — | minted | skill:bilge-water-management | — | 0.381 | — | — | — |
| skill | worker, br-sp | pt | Esmerilhamento | — | — | minted | skill:grinding | — | 0.344 | — | — | — |
| cert | worker | en | Texas Journeyman Electrician License | cert:electrician-license:us-tx | journeyman | label | cert:electrician-license:us-tx | journeyman | 0.679 | 0.679 | — | — |
| cert | worker | en | Texas Journeyman Plumber License | cert:plumber-license:us-tx | journeyman | label | cert:plumber-license:us-tx | journeyman | 0.711 | 0.711 | — | — |
| cert | worker | en | BOSIET with CA-EBS | cert:bosiet | ca-ebs | label | cert:bosiet | ca-ebs | 0.652 | 0.652 | — | — |
| cert | worker | en | STCW Basic Safety Training | cert:stcw-basic-safety | — | label | cert:stcw-basic-safety | — | 0.786 | 0.786 | — | — |
| cert | worker | en | OSHA 10-Hour Construction | cert:osha-outreach:us | 10-hour, construction | label | cert:osha-outreach:us | 10-hour, construction | 0.546 | 0.546 | — | — |
| cert | worker | en | TWIC card | cert:twic:us | — | label | cert:twic:us | — | 0.837 | 0.837 | — | — |
| cert | worker | en | NFPA 70E Arc Flash Training | — | — | unmatched | — | — | 0.532 | — | — | — |
| cert | worker | en | Backflow Prevention Assembly Tester | — | — | unmatched | — | — | 0.687 | — | — | — |
| cert | worker | en | USCG Merchant Mariner Credential (Third Assistant Engineer Unlimited) | — | — | unmatched | — | — | 0.438 | — | — | — |
| cert | worker | pt | NR-10 Básico | cert:nr-10:br | basic | label | cert:nr-10:br | basic | 0.659 | 0.659 | — | — |
| cert | worker | pt | NR-10 SEP | cert:nr-10:br | sep | label | cert:nr-10:br | sep | 0.647 | 0.647 | — | — |
| cert | worker | pt | NR-35 Trabalho em Altura | cert:nr-35:br | — | label | cert:nr-35:br | — | 0.716 | 0.716 | — | — |
| cert | worker | pt | NR-34 Trabalho a Quente | cert:nr-34:br | hot-work | label | cert:nr-34:br | hot-work | 0.525 | 0.525 | — | — |
| cert | worker | pt | Qualificação de soldador ASME IX | cert:asme-ix-welder | — | label | cert:asme-ix-welder | — | 0.753 | 0.753 | — | — |
| cert | worker | pt | CBSP | cert:cbsp:br | — | label | cert:cbsp:br | — | 0.797 | 0.797 | — | — |
| cert | worker | pt | HUET | cert:huet | — | label | cert:huet | — | 0.807 | 0.807 | — | — |
| cert | worker | pt | Curso de CLP Siemens S7 | — | — | unmatched | — | — | 0.342 | — | — | — |
| cert | worker | es | OSHA 30 horas | cert:osha-outreach:us | 30-hour | label | cert:osha-outreach:us | 30-hour | 0.539 | 0.539 | — | — |
| cert | worker | es | NCCCO Aparejador Nivel II | cert:nccco-rigger | level-2 | label | cert:nccco-rigger | level-2 | 0.646 | 0.646 | — | — |
| cert | worker | es | NCCCO Operador de Grúa Telescópica | cert:nccco-crane-operator | telescopic | label | cert:nccco-crane-operator | telescopic | 0.667 | 0.667 | — | — |
| cert | worker | es | Perito Traductor certificado | — | — | unmatched | — | — | 0.585 | — | — | — |
| cert | worker | es | Diplomado en Traducción Jurídica | — | — | unmatched | — | — | 0.389 | — | — | — |
| cert | worker | en | Basic Offshore Safety Induction & Emergency Training (OPITO), CA-EBS | cert:bosiet | ca-ebs | label | cert:bosiet | ca-ebs | 0.586 | 0.586 | — | — |
| cert | worker | en | Texas Master Electrician | cert:electrician-license:us-tx | master | chosen | cert:electrician-license:us-tx | master | 0.617 | 0.617 | 0.91 | cert:electrician-license:us-tx 0.91, none 0.09 |
| cert | worker | en | EPA 608 Universal | cert:epa-608:us | universal | label | cert:epa-608:us | universal | 0.715 | 0.715 | — | — |
| cert | worker | en | NCCCO Signalperson | cert:nccco-signalperson | — | label | cert:nccco-signalperson | — | 0.886 | 0.886 | — | — |
| cert | worker | pt | Rigger Nível II certificado pela NCCCO | cert:nccco-rigger | level-2 | label | cert:nccco-rigger | level-2 | 0.72 | 0.72 | — | — |
| cert | worker | es | Licencia de Plomero Maestro, Texas | cert:plumber-license:us-tx | master | label | cert:plumber-license:us-tx | master | 0.661 | 0.661 | — | — |
| cert | worker | en | Texas Apprentice Electrician License | — | — | unmatched | — | — | 0.686 | — | — | — |
| cert | worker | en | Journeyman Electrician License | — | — | unmatched | — | — | 0.61 | — | — | — |
| cert | worker | en | Texas Journeyman Industrial Electrician License | — | — | unmatched | — | — | 0.645 | — | — | — |
| cert | worker | en | licensed electrician | — | — | unmatched | — | — | 0.579 | — | — | — |
| cert | worker | en | certified rigger | — | — | unmatched | — | — | 0.723 | — | — | — |
| cert | worker | en | OSHA 500 Trainer Course | — | — | unmatched | — | — | 0.609 | — | — | — |
| cert | worker | en | Texas Electrician License, Class B | — | — | unmatched | — | — | 0.642 | — | — | — |
| cert | worker | pt | NR-10 Básico e SEP | cert:nr-10:br | basic | label | cert:nr-10:br | basic | 0.532 | 0.532 | — | — |
| cert | worker | en | STCW 2010 Basic Safety Training | cert:stcw-basic-safety | — | label | cert:stcw-basic-safety | — | 0.731 | 0.731 | — | — |
| cert | worker | en | OSHA 30-Hour Construction Safety and Health | cert:osha-outreach:us | 30-hour, construction | label | cert:osha-outreach:us | 30-hour, construction | 0.546 | 0.546 | — | — |
| cert | worker | en | ASME IX 6G SMAW | cert:asme-ix-welder | 6g | label | cert:asme-ix-welder | 6g | 0.602 | 0.602 | — | — |
| cert | worker | en | TWIC valid until 2028 | cert:twic:us | — | label | cert:twic:us | — | 0.596 | 0.596 | — | — |
| cert | worker | en | TWIC valid until 2025 | — | — | unmatched | — | — | 0.586 | — | — | — |
| cert | worker | en | TWIC 2019-2024 | — | — | unmatched | — | — | 0.695 | — | — | — |
| cert | worker | es | TWIC no vigente | — | — | unmatched | — | — | 0.622 | — | — | — |
| cert | worker | en | OSHA 40-Hour | — | — | unmatched | — | — | 0.577 | — | — | — |
| cert | worker | en | NCCCO Operator | — | — | unmatched | — | — | 0.683 | — | — | — |
| cert | worker | es | Traductor certificado, CDMX | — | — | unmatched | — | — | 0.623 | — | — | — |
| cert | hirer, us-tx | en | licensed electrician | cert:electrician-license:us-tx | — | label | cert:electrician-license:us-tx | — | 0.579 | 0.579 | — | — |
| cert | hirer, us-tx | en | certified rigger | cert:nccco-rigger | — | label | cert:nccco-rigger | — | 0.723 | 0.723 | — | — |
| cert | hirer, br-sp | pt | eletricista com licença | — | — | unmatched | — | — | 0.553 | — | — | — |
| cert | hirer, us-tx | pt | rigger certificado | cert:nccco-rigger | — | label | cert:nccco-rigger | — | 0.661 | 0.661 | — | — |
| cert | hirer, mx-nle | es | electricista con licencia | — | — | unmatched | — | — | 0.58 | — | — | — |
| cert | hirer, us-tx | es | aparejador certificado | cert:nccco-rigger | — | label | cert:nccco-rigger | — | 0.475 | 0.432 | — | — |
| cert | hirer, us-tx | es | electricista con licencia | cert:electrician-license:us-tx | — | label | cert:electrician-license:us-tx | — | 0.58 | 0.58 | — | — |
| cert | hirer, us-la | en | licensed plumber | cert:plumber-license:us-la | — | label | cert:plumber-license:us-la | — | 0.616 | 0.616 | — | — |
| cert | hirer, us-tx | en | master plumber | cert:plumber-license:us-tx | master | chosen | cert:plumber-license:us-tx | master | 0.494 | 0.491 | 0.95 | cert:plumber-license:us-tx 0.95, none 0.05 |
| cert | hirer, us-tx | en | OSHA 30 | cert:osha-outreach:us | 30-hour | label | cert:osha-outreach:us | 30-hour | 0.576 | 0.576 | — | — |
| cert | hirer, us-tx | en | NCCCO Rigger Level II | cert:nccco-rigger | level-2 | label | cert:nccco-rigger | level-2 | 0.783 | 0.783 | — | — |
| cert | hirer, br-sp | pt | NR-10 Básico e SEP | cert:nr-10:br | sep | label | cert:nr-10:br | sep | 0.532 | 0.532 | — | — |
| cert | hirer, us-tx | en | licensed journeyman wireman | cert:electrician-license:us-tx | journeyman | **unmatched** | — | — | 0.518 | 0.518 | — | — |
| cert | hirer, us-tx | en | EPA 608 Type I and II | — | — | unmatched | — | — | 0.653 | — | — | — |
| cert | hirer, us-tx | en | HAZWOPER 40 | — | — | unmatched | — | — | 0.376 | — | — | — |
| cert | hirer, br-sp | pt | NR-12 | — | — | unmatched | — | — | 0.589 | — | — | — |
| cert | hirer, mx-cmx | es | traductor | — | — | unmatched | — | — | 0.48 | — | — | — |
