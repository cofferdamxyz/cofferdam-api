# Canonicalization evaluation, 2026-10-25

Retrieve-then-choose over the synthetic occupation and skill seed (`test/fixtures/work/registry-seed.json`, no ESCO data) and the curated certificate seed (`src/services/work/certificates.json`: 24 certificates), 50 tokens and 264 labels in en, pt and es, each of 106 strings against a fresh copy, with `@cf/google/embeddinggemma-300m`, `@cf/cloudflare/clef-flash` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` over the Workers AI REST API from the Mac. τ_auto 1, τ_low 0.01. A certificate is right only with its level and modules; one where none fits is right only when nothing snaps.

| Kind | Right | Wrong token or level | A token where none fits | No token where one fits |
|---|---|---|---|---|
| pos | 87% (20 of 23) | 0 | 0 | 3 |
| skill | 100% (20 of 20) | 0 | 0 | 0 |
| cert, a worker’s claim | 100% (46 of 46) | 0 | 0 | 0 |
| cert, a hirer’s requirement | 94.1% (16 of 17) | 0 | 0 | 1 |

Decisions: label 46, chosen 25, unmatched 30, pivot 1, minted 4. Cost per snap 0.000008 USD, median 597 ms.

Cosine of the expected token's best label: min -1.000, median 0.834. Best cosine of strings with no fitting token: max 0.944.

| Kind | As | Language | String | Expected | Expected level, modules | Decision | Token | Level, modules | Top cos | Expected cos | Clef p |
|---|---|---|---|---|---|---|---|---|---|---|---|
| pos | — | en | Marine engineer | pos:marine-engineer | — | label | pos:marine-engineer | — | 0.99 | 0.99 | — |
| pos | — | en | Third Assistant Engineer | pos:marine-engineer | — | chosen | pos:marine-engineer | — | 0.634 | 0.634 | 0.85 |
| pos | — | en | Engine Cadet | pos:marine-engineer | — | chosen | pos:marine-engineer | — | 0.8 | 0.8 | 0.64 |
| pos | — | en | journeyman electrician | pos:electrician | — | chosen | pos:electrician | — | 0.873 | 0.873 | 0.87 |
| pos | — | en | Electrician Apprentice | pos:electrician | — | chosen | pos:electrician | — | 0.89 | 0.89 | 0.81 |
| pos | — | en | Residential plumber | pos:plumber | — | chosen | pos:plumber | — | 0.897 | 0.897 | 0.91 |
| pos | — | en | Service Plumber | pos:plumber | — | chosen | pos:plumber | — | -1 | -1 | 0.86 |
| pos | — | en | Plumber's Helper | pos:plumber | — | **unmatched** | — | — | -1 | -1 | — |
| pos | — | pt | Soldador de Tubulação | pos:welder | — | **unmatched** | — | — | 0.743 | 0.743 | 0.47 |
| pos | — | pt | Caldeireiro | pos:boilermaker | — | label | pos:boilermaker | — | 0.975 | 0.975 | — |
| pos | — | pt | Eletricista de Manutenção Industrial | pos:industrial-electrician | — | chosen | pos:industrial-electrician | — | 0.876 | 0.876 | 0.79 |
| pos | — | pt | Ajudante de Eletricista | pos:electrician | — | chosen | pos:electrician | — | 0.773 | 0.773 | 0.80 |
| pos | — | pt | Jardineiro e paisagista | pos:gardener | — | chosen | pos:gardener | — | 0.851 | 0.851 | 0.89 |
| pos | — | pt | Auxiliar de Paisagismo | pos:gardener | — | chosen | pos:gardener | — | 0.712 | 0.712 | 0.90 |
| pos | — | es | Aparejador (Rigger) | pos:rigger | — | pivot | pos:rigger | — | 0.759 | 0.759 | — |
| pos | — | es | Operador de Grúa Móvil | pos:crane-operator | — | **unmatched** | — | — | 0.839 | 0.839 | — |
| pos | — | es | Traductora inglés-español | pos:translator | — | chosen | pos:translator | — | 0.847 | 0.847 | 0.89 |
| pos | — | es | Traductora Independiente | pos:translator | — | chosen | pos:translator | — | 0.845 | 0.845 | 0.89 |
| pos | — | es | Plomero Oficial | pos:plumber | — | chosen | pos:plumber | — | 0.818 | 0.818 | 0.83 |
| pos | — | es | Ayudante de Plomería | pos:plumber | — | chosen | pos:plumber | — | 0.753 | 0.753 | 0.83 |
| pos | — | en | Pastry chef | — | — | minted | pos:pastry-chef | — | 0.632 | — | — |
| pos | — | pt | Motorista de caminhão | — | — | minted | pos:truck-driver | — | 0.594 | — | — |
| pos | — | es | Cocinero de línea | — | — | minted | pos:cook | — | 0.61 | — | — |
| skill | — | en | fixing leaks | skill:leak-repair | — | label | skill:leak-repair | — | 1 | 1 | — |
| skill | — | en | Leak detection | skill:leak-detection | — | label | skill:leak-detection | — | 0.951 | 0.951 | — |
| skill | — | en | replacing water heaters | skill:water-heater-installation | — | chosen | skill:water-heater-installation | — | 0.801 | 0.801 | 0.86 |
| skill | — | en | clearing drains | skill:drain-cleaning | — | chosen | skill:drain-cleaning | — | 0.857 | 0.857 | 0.92 |
| skill | — | en | EV chargers | skill:ev-charger-installation | — | chosen | skill:ev-charger-installation | — | 0.783 | 0.783 | 0.87 |
| skill | — | en | panel upgrades | skill:electrical-panel-upgrade | — | chosen | skill:electrical-panel-upgrade | — | 0.917 | 0.917 | 0.67 |
| skill | — | en | Diesel engine maintenance | skill:diesel-engine-maintenance | — | label | skill:diesel-engine-maintenance | — | 0.997 | 0.997 | — |
| skill | — | pt | Corte com maçarico | skill:torch-cutting | — | label | skill:torch-cutting | — | 0.981 | 0.981 | — |
| skill | — | pt | Leitura de desenho isométrico | skill:isometric-drawing-reading | — | chosen | skill:isometric-drawing-reading | — | 0.847 | 0.847 | 0.95 |
| skill | — | pt | Corte de grama | skill:lawn-mowing | — | label | skill:lawn-mowing | — | 0.987 | 0.987 | — |
| skill | — | pt | poda de cercas vivas | skill:pruning | — | chosen | skill:pruning | — | 0.536 | 0.536 | 0.82 |
| skill | — | pt | Irrigação por gotejamento | skill:irrigation-maintenance | — | chosen | skill:irrigation-maintenance | — | 0.767 | 0.767 | 0.86 |
| skill | — | es | Reparación de fugas | skill:leak-repair | — | label | skill:leak-repair | — | 0.978 | 0.978 | — |
| skill | — | es | Detección de fugas | skill:leak-detection | — | label | skill:leak-detection | — | 0.952 | 0.952 | — |
| skill | — | es | Instalación de calentadores | skill:water-heater-installation | — | label | skill:water-heater-installation | — | 0.97 | 0.97 | — |
| skill | — | es | maniobras de carga | skill:rigging | — | label | skill:rigging | — | 1 | 1 | — |
| skill | — | es | Operación de grúas telescópicas | skill:crane-operation | — | chosen | skill:crane-operation | — | 0.887 | 0.887 | 0.90 |
| skill | — | es | Traducción de contratos comerciales | skill:legal-translation | — | chosen | skill:legal-translation | — | 0.792 | 0.792 | 0.90 |
| skill | — | en | bilge water management | — | — | minted | skill:bilge-management | — | 0.673 | — | — |
| skill | — | pt | Esmerilhamento | — | — | unmatched | — | — | 0.522 | — | 0.40 |
| cert | worker | en | Texas Journeyman Electrician License | cert:electrician-license:us-tx | journeyman | label | cert:electrician-license:us-tx | journeyman | 0.904 | 0.904 | — |
| cert | worker | en | Texas Journeyman Plumber License | cert:plumber-license:us-tx | journeyman | label | cert:plumber-license:us-tx | journeyman | 0.911 | 0.911 | — |
| cert | worker | en | BOSIET with CA-EBS | cert:bosiet | ca-ebs | label | cert:bosiet | ca-ebs | 0.775 | 0.775 | — |
| cert | worker | en | STCW Basic Safety Training | cert:stcw-basic-safety | — | label | cert:stcw-basic-safety | — | 1 | 1 | — |
| cert | worker | en | OSHA 10-Hour Construction | cert:osha-outreach:us | 10-hour, construction | label | cert:osha-outreach:us | 10-hour, construction | 0.615 | 0.615 | — |
| cert | worker | en | TWIC card | cert:twic:us | — | label | cert:twic:us | — | 1 | 1 | — |
| cert | worker | en | NFPA 70E Arc Flash Training | — | — | unmatched | — | — | 0.68 | — | — |
| cert | worker | en | Backflow Prevention Assembly Tester | — | — | unmatched | — | — | 0.753 | — | — |
| cert | worker | en | USCG Merchant Mariner Credential (Third Assistant Engineer Unlimited) | — | — | unmatched | — | — | 0.528 | — | — |
| cert | worker | pt | NR-10 Básico | cert:nr-10:br | basic | label | cert:nr-10:br | basic | 0.772 | 0.772 | — |
| cert | worker | pt | NR-10 SEP | cert:nr-10:br | sep | label | cert:nr-10:br | sep | 0.863 | 0.863 | — |
| cert | worker | pt | NR-35 Trabalho em Altura | cert:nr-35:br | — | label | cert:nr-35:br | — | 1 | 1 | — |
| cert | worker | pt | NR-34 Trabalho a Quente | cert:nr-34:br | hot-work | label | cert:nr-34:br | hot-work | 0.732 | 0.732 | — |
| cert | worker | pt | Qualificação de soldador ASME IX | cert:asme-ix-welder | — | label | cert:asme-ix-welder | — | 1 | 1 | — |
| cert | worker | pt | CBSP | cert:cbsp:br | — | label | cert:cbsp:br | — | 1 | 1 | — |
| cert | worker | pt | HUET | cert:huet | — | label | cert:huet | — | 1 | 1 | — |
| cert | worker | pt | Curso de CLP Siemens S7 | — | — | unmatched | — | — | 0.588 | — | — |
| cert | worker | es | OSHA 30 horas | cert:osha-outreach:us | 30-hour | label | cert:osha-outreach:us | 30-hour | 0.614 | 0.614 | — |
| cert | worker | es | NCCCO Aparejador Nivel II | cert:nccco-rigger | level-2 | label | cert:nccco-rigger | level-2 | 0.708 | 0.708 | — |
| cert | worker | es | NCCCO Operador de Grúa Telescópica | cert:nccco-crane-operator | telescopic | label | cert:nccco-crane-operator | telescopic | 0.817 | 0.817 | — |
| cert | worker | es | Perito Traductor certificado | — | — | unmatched | — | — | 0.813 | — | — |
| cert | worker | es | Diplomado en Traducción Jurídica | — | — | unmatched | — | — | -1 | — | — |
| cert | worker | en | Basic Offshore Safety Induction & Emergency Training (OPITO), CA-EBS | cert:bosiet | ca-ebs | label | cert:bosiet | ca-ebs | 0.783 | 0.783 | — |
| cert | worker | en | Texas Master Electrician | cert:electrician-license:us-tx | master | chosen | cert:electrician-license:us-tx | master | 0.785 | 0.785 | 0.91 |
| cert | worker | en | EPA 608 Universal | cert:epa-608:us | universal | label | cert:epa-608:us | universal | 0.875 | 0.875 | — |
| cert | worker | en | NCCCO Signalperson | cert:nccco-signalperson | — | label | cert:nccco-signalperson | — | 1 | 1 | — |
| cert | worker | pt | Rigger Nível II certificado pela NCCCO | cert:nccco-rigger | level-2 | label | cert:nccco-rigger | level-2 | 0.853 | 0.853 | — |
| cert | worker | es | Licencia de Plomero Maestro, Texas | cert:plumber-license:us-tx | master | label | cert:plumber-license:us-tx | master | 0.89 | 0.89 | — |
| cert | worker | en | Texas Apprentice Electrician License | — | — | unmatched | — | — | 0.944 | — | — |
| cert | worker | en | Journeyman Electrician License | — | — | unmatched | — | — | 0.83 | — | — |
| cert | worker | en | Texas Journeyman Industrial Electrician License | — | — | unmatched | — | — | 0.861 | — | — |
| cert | worker | en | licensed electrician | — | — | unmatched | — | — | 0.81 | — | — |
| cert | worker | en | certified rigger | — | — | unmatched | — | — | 0.861 | — | — |
| cert | worker | en | OSHA 500 Trainer Course | — | — | unmatched | — | — | 0.7 | — | — |
| cert | worker | en | Texas Electrician License, Class B | — | — | unmatched | — | — | 0.827 | — | — |
| cert | worker | pt | NR-10 Básico e SEP | cert:nr-10:br | basic | label | cert:nr-10:br | basic | 0.699 | 0.699 | — |
| cert | worker | en | STCW 2010 Basic Safety Training | cert:stcw-basic-safety | — | label | cert:stcw-basic-safety | — | 0.833 | 0.833 | — |
| cert | worker | en | OSHA 30-Hour Construction Safety and Health | cert:osha-outreach:us | 30-hour, construction | label | cert:osha-outreach:us | 30-hour, construction | 0.647 | 0.647 | — |
| cert | worker | en | ASME IX 6G SMAW | cert:asme-ix-welder | 6g | label | cert:asme-ix-welder | 6g | 0.746 | 0.746 | — |
| cert | worker | en | TWIC valid until 2028 | cert:twic:us | — | label | cert:twic:us | — | -1 | -1 | — |
| cert | worker | en | TWIC valid until 2025 | — | — | unmatched | — | — | -1 | — | — |
| cert | worker | en | TWIC 2019-2024 | — | — | unmatched | — | — | 0.711 | — | — |
| cert | worker | es | TWIC no vigente | — | — | unmatched | — | — | 0.761 | — | — |
| cert | worker | en | OSHA 40-Hour | — | — | unmatched | — | — | 0.643 | — | — |
| cert | worker | en | NCCCO Operator | — | — | unmatched | — | — | 0.847 | — | — |
| cert | worker | es | Traductor certificado, CDMX | — | — | unmatched | — | — | 0.854 | — | — |
| cert | hirer, us-tx | en | licensed electrician | cert:electrician-license:us-tx | — | label | cert:electrician-license:us-tx | — | 0.81 | 0.81 | — |
| cert | hirer, us-tx | en | certified rigger | cert:nccco-rigger | — | label | cert:nccco-rigger | — | 0.861 | 0.861 | — |
| cert | hirer, br-sp | pt | eletricista com licença | — | — | unmatched | — | — | 0.789 | — | — |
| cert | hirer, us-tx | pt | rigger certificado | cert:nccco-rigger | — | label | cert:nccco-rigger | — | 0.814 | 0.814 | — |
| cert | hirer, mx-nle | es | electricista con licencia | — | — | unmatched | — | — | 0.805 | — | — |
| cert | hirer, us-tx | es | aparejador certificado | cert:nccco-rigger | — | label | cert:nccco-rigger | — | 0.686 | 0.686 | — |
| cert | hirer, us-tx | es | electricista con licencia | cert:electrician-license:us-tx | — | label | cert:electrician-license:us-tx | — | 0.805 | 0.805 | — |
| cert | hirer, us-la | en | licensed plumber | cert:plumber-license:us-la | — | label | cert:plumber-license:us-la | — | 0.807 | 0.807 | — |
| cert | hirer, us-tx | en | master plumber | cert:plumber-license:us-tx | master | chosen | cert:plumber-license:us-tx | master | 0.68 | 0.675 | 0.95 |
| cert | hirer, us-tx | en | OSHA 30 | cert:osha-outreach:us | 30-hour | label | cert:osha-outreach:us | 30-hour | 0.64 | 0.64 | — |
| cert | hirer, us-tx | en | NCCCO Rigger Level II | cert:nccco-rigger | level-2 | label | cert:nccco-rigger | level-2 | 0.834 | 0.834 | — |
| cert | hirer, br-sp | pt | NR-10 Básico e SEP | cert:nr-10:br | sep | label | cert:nr-10:br | sep | -1 | -1 | — |
| cert | hirer, us-tx | en | licensed journeyman wireman | cert:electrician-license:us-tx | journeyman | **unmatched** | — | — | 0.736 | 0.736 | — |
| cert | hirer, us-tx | en | EPA 608 Type I and II | — | — | unmatched | — | — | 0.764 | — | — |
| cert | hirer, us-tx | en | HAZWOPER 40 | — | — | unmatched | — | — | 0.481 | — | — |
| cert | hirer, br-sp | pt | NR-12 | — | — | unmatched | — | — | 0.687 | — | — |
| cert | hirer, mx-cmx | es | traductor | — | — | unmatched | — | — | 0.769 | — | — |
