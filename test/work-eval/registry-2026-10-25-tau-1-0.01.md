# Canonicalization evaluation, 2026-10-25

Retrieve-then-choose over the synthetic occupation and skill seed (`test/fixtures/work/registry-seed.json`, no ESCO data) and the curated certificate seed (`src/services/work/certificates.json`: 24 certificates), 50 tokens and 264 labels in en, pt and es, each of 106 strings against a fresh copy, with `@cf/baai/bge-m3`, `@cf/cloudflare/clef-flash` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` over the Workers AI REST API from the Mac. τ_auto 1, τ_low 0.01. A certificate is right only with its level and modules; one where none fits is right only when nothing snaps.

| Kind | Right | Wrong token or level | A token where none fits | No token where one fits |
|---|---|---|---|---|
| pos | 87% (20 of 23) | 1 | 0 | 2 |
| skill | 95% (19 of 20) | 0 | 0 | 1 |
| cert, a worker’s claim | 100% (46 of 46) | 0 | 0 | 0 |
| cert, a hirer’s requirement | 94.1% (16 of 17) | 0 | 0 | 1 |

Decisions: label 46, chosen 25, unmatched 33, pivot 1, minted 1. Cost per snap 0.000005 USD, median 432 ms.

Cosine of the expected token's best label: min -1.000, median 0.800. Best cosine of strings with no fitting token: max 0.914.

| Kind | As | Language | String | Expected | Expected level, modules | Decision | Token | Level, modules | Top cos | Expected cos | Clef p |
|---|---|---|---|---|---|---|---|---|---|---|---|
| pos | — | en | Marine engineer | pos:marine-engineer | — | label | pos:marine-engineer | — | 0.962 | 0.962 | — |
| pos | — | en | Third Assistant Engineer | pos:marine-engineer | — | chosen | pos:marine-engineer | — | 0.583 | 0.566 | 0.89 |
| pos | — | en | Engine Cadet | pos:marine-engineer | — | chosen | pos:marine-engineer | — | 0.712 | 0.712 | 0.68 |
| pos | — | en | journeyman electrician | pos:electrician | — | chosen | pos:electrician | — | 0.774 | 0.774 | 0.88 |
| pos | — | en | Electrician Apprentice | pos:electrician | — | chosen | pos:electrician | — | 0.79 | 0.79 | 0.82 |
| pos | — | en | Residential plumber | pos:plumber | — | chosen | pos:plumber | — | 0.792 | 0.792 | 0.92 |
| pos | — | en | Service Plumber | pos:plumber | — | chosen | pos:plumber | — | 0.742 | 0.742 | 0.85 |
| pos | — | en | Plumber's Helper | pos:plumber | — | chosen | pos:plumber | — | 0.697 | 0.697 | 0.84 |
| pos | — | pt | Soldador de Tubulação | pos:welder | — | **chosen** | pos:plumber | — | 0.675 | 0.675 | 0.63 |
| pos | — | pt | Caldeireiro | pos:boilermaker | — | label | pos:boilermaker | — | 0.827 | 0.827 | — |
| pos | — | pt | Eletricista de Manutenção Industrial | pos:industrial-electrician | — | **unmatched** | — | — | -1 | -1 | — |
| pos | — | pt | Ajudante de Eletricista | pos:electrician | — | chosen | pos:electrician | — | 0.79 | 0.79 | 0.82 |
| pos | — | pt | Jardineiro e paisagista | pos:gardener | — | chosen | pos:gardener | — | 0.81 | 0.81 | 0.88 |
| pos | — | pt | Auxiliar de Paisagismo | pos:gardener | — | chosen | pos:gardener | — | 0.753 | 0.753 | 0.90 |
| pos | — | es | Aparejador (Rigger) | pos:rigger | — | pivot | pos:rigger | — | 0.677 | 0.677 | — |
| pos | — | es | Operador de Grúa Móvil | pos:crane-operator | — | chosen | pos:crane-operator | — | 0.77 | 0.77 | 0.89 |
| pos | — | es | Traductora inglés-español | pos:translator | — | chosen | pos:translator | — | 0.769 | 0.769 | 0.91 |
| pos | — | es | Traductora Independiente | pos:translator | — | chosen | pos:translator | — | 0.771 | 0.771 | 0.90 |
| pos | — | es | Plomero Oficial | pos:plumber | — | chosen | pos:plumber | — | 0.776 | 0.776 | 0.86 |
| pos | — | es | Ayudante de Plomería | pos:plumber | — | **unmatched** | — | — | 0.632 | 0.632 | — |
| pos | — | en | Pastry chef | — | — | minted | pos:pastry-chef | — | 0.552 | — | — |
| pos | — | pt | Motorista de caminhão | — | — | unmatched | — | — | -1 | — | — |
| pos | — | es | Cocinero de línea | — | — | unmatched | — | — | 0.562 | — | — |
| skill | — | en | fixing leaks | skill:leak-repair | — | label | skill:leak-repair | — | 1 | 1 | — |
| skill | — | en | Leak detection | skill:leak-detection | — | label | skill:leak-detection | — | 0.994 | 0.994 | — |
| skill | — | en | replacing water heaters | skill:water-heater-installation | — | chosen | skill:water-heater-installation | — | 0.801 | 0.801 | 0.90 |
| skill | — | en | clearing drains | skill:drain-cleaning | — | chosen | skill:drain-cleaning | — | 0.881 | 0.881 | 0.91 |
| skill | — | en | EV chargers | skill:ev-charger-installation | — | chosen | skill:ev-charger-installation | — | 0.831 | 0.831 | 0.89 |
| skill | — | en | panel upgrades | skill:electrical-panel-upgrade | — | chosen | skill:electrical-panel-upgrade | — | 0.872 | 0.872 | 0.71 |
| skill | — | en | Diesel engine maintenance | skill:diesel-engine-maintenance | — | label | skill:diesel-engine-maintenance | — | 0.972 | 0.972 | — |
| skill | — | pt | Corte com maçarico | skill:torch-cutting | — | label | skill:torch-cutting | — | 0.971 | 0.971 | — |
| skill | — | pt | Leitura de desenho isométrico | skill:isometric-drawing-reading | — | chosen | skill:isometric-drawing-reading | — | 0.877 | 0.877 | 0.96 |
| skill | — | pt | Corte de grama | skill:lawn-mowing | — | label | skill:lawn-mowing | — | 0.977 | 0.977 | — |
| skill | — | pt | poda de cercas vivas | skill:pruning | — | chosen | skill:pruning | — | 0.647 | 0.621 | 0.86 |
| skill | — | pt | Irrigação por gotejamento | skill:irrigation-maintenance | — | chosen | skill:irrigation-maintenance | — | 0.703 | 0.703 | 0.77 |
| skill | — | es | Reparación de fugas | skill:leak-repair | — | label | skill:leak-repair | — | 0.95 | 0.95 | — |
| skill | — | es | Detección de fugas | skill:leak-detection | — | label | skill:leak-detection | — | 0.986 | 0.986 | — |
| skill | — | es | Instalación de calentadores | skill:water-heater-installation | — | label | skill:water-heater-installation | — | 0.975 | 0.975 | — |
| skill | — | es | maniobras de carga | skill:rigging | — | label | skill:rigging | — | 1 | 1 | — |
| skill | — | es | Operación de grúas telescópicas | skill:crane-operation | — | **unmatched** | — | — | -1 | -1 | — |
| skill | — | es | Traducción de contratos comerciales | skill:legal-translation | — | chosen | skill:legal-translation | — | 0.831 | 0.831 | 0.90 |
| skill | — | en | bilge water management | — | — | unmatched | — | — | -1 | — | — |
| skill | — | pt | Esmerilhamento | — | — | unmatched | — | — | 0.606 | — | — |
| cert | worker | en | Texas Journeyman Electrician License | cert:electrician-license:us-tx | journeyman | label | cert:electrician-license:us-tx | journeyman | 0.825 | 0.825 | — |
| cert | worker | en | Texas Journeyman Plumber License | cert:plumber-license:us-tx | journeyman | label | cert:plumber-license:us-tx | journeyman | 0.791 | 0.791 | — |
| cert | worker | en | BOSIET with CA-EBS | cert:bosiet | ca-ebs | label | cert:bosiet | ca-ebs | 0.772 | 0.772 | — |
| cert | worker | en | STCW Basic Safety Training | cert:stcw-basic-safety | — | label | cert:stcw-basic-safety | — | 1 | 1 | — |
| cert | worker | en | OSHA 10-Hour Construction | cert:osha-outreach:us | 10-hour, construction | label | cert:osha-outreach:us | 10-hour, construction | 0.7 | 0.7 | — |
| cert | worker | en | TWIC card | cert:twic:us | — | label | cert:twic:us | — | 1 | 1 | — |
| cert | worker | en | NFPA 70E Arc Flash Training | — | — | unmatched | — | — | 0.572 | — | — |
| cert | worker | en | Backflow Prevention Assembly Tester | — | — | unmatched | — | — | 0.745 | — | — |
| cert | worker | en | USCG Merchant Mariner Credential (Third Assistant Engineer Unlimited) | — | — | unmatched | — | — | 0.534 | — | — |
| cert | worker | pt | NR-10 Básico | cert:nr-10:br | basic | label | cert:nr-10:br | basic | 0.836 | 0.836 | — |
| cert | worker | pt | NR-10 SEP | cert:nr-10:br | sep | label | cert:nr-10:br | sep | 0.9 | 0.9 | — |
| cert | worker | pt | NR-35 Trabalho em Altura | cert:nr-35:br | — | label | cert:nr-35:br | — | 1 | 1 | — |
| cert | worker | pt | NR-34 Trabalho a Quente | cert:nr-34:br | hot-work | label | cert:nr-34:br | hot-work | 0.758 | 0.758 | — |
| cert | worker | pt | Qualificação de soldador ASME IX | cert:asme-ix-welder | — | label | cert:asme-ix-welder | — | 1 | 1 | — |
| cert | worker | pt | CBSP | cert:cbsp:br | — | label | cert:cbsp:br | — | 1 | 1 | — |
| cert | worker | pt | HUET | cert:huet | — | label | cert:huet | — | 1 | 1 | — |
| cert | worker | pt | Curso de CLP Siemens S7 | — | — | unmatched | — | — | 0.548 | — | — |
| cert | worker | es | OSHA 30 horas | cert:osha-outreach:us | 30-hour | label | cert:osha-outreach:us | 30-hour | 0.715 | 0.715 | — |
| cert | worker | es | NCCCO Aparejador Nivel II | cert:nccco-rigger | level-2 | label | cert:nccco-rigger | level-2 | 0.817 | 0.817 | — |
| cert | worker | es | NCCCO Operador de Grúa Telescópica | cert:nccco-crane-operator | telescopic | label | cert:nccco-crane-operator | telescopic | 0.771 | 0.771 | — |
| cert | worker | es | Perito Traductor certificado | — | — | unmatched | — | — | 0.802 | — | — |
| cert | worker | es | Diplomado en Traducción Jurídica | — | — | unmatched | — | — | 0.614 | — | — |
| cert | worker | en | Basic Offshore Safety Induction & Emergency Training (OPITO), CA-EBS | cert:bosiet | ca-ebs | label | cert:bosiet | ca-ebs | 0.789 | 0.789 | — |
| cert | worker | en | Texas Master Electrician | cert:electrician-license:us-tx | master | chosen | cert:electrician-license:us-tx | master | 0.808 | 0.808 | 0.91 |
| cert | worker | en | EPA 608 Universal | cert:epa-608:us | universal | label | cert:epa-608:us | universal | 0.901 | 0.901 | — |
| cert | worker | en | NCCCO Signalperson | cert:nccco-signalperson | — | label | cert:nccco-signalperson | — | 1 | 1 | — |
| cert | worker | pt | Rigger Nível II certificado pela NCCCO | cert:nccco-rigger | level-2 | label | cert:nccco-rigger | level-2 | 0.893 | 0.893 | — |
| cert | worker | es | Licencia de Plomero Maestro, Texas | cert:plumber-license:us-tx | master | label | cert:plumber-license:us-tx | master | 0.844 | 0.844 | — |
| cert | worker | en | Texas Apprentice Electrician License | — | — | unmatched | — | — | 0.914 | — | — |
| cert | worker | en | Journeyman Electrician License | — | — | unmatched | — | — | 0.691 | — | — |
| cert | worker | en | Texas Journeyman Industrial Electrician License | — | — | unmatched | — | — | 0.787 | — | — |
| cert | worker | en | licensed electrician | — | — | unmatched | — | — | 0.766 | — | — |
| cert | worker | en | certified rigger | — | — | unmatched | — | — | 0.863 | — | — |
| cert | worker | en | OSHA 500 Trainer Course | — | — | unmatched | — | — | 0.805 | — | — |
| cert | worker | en | Texas Electrician License, Class B | — | — | unmatched | — | — | 0.834 | — | — |
| cert | worker | pt | NR-10 Básico e SEP | cert:nr-10:br | basic | label | cert:nr-10:br | basic | 0.771 | 0.771 | — |
| cert | worker | en | STCW 2010 Basic Safety Training | cert:stcw-basic-safety | — | label | cert:stcw-basic-safety | — | 0.898 | 0.898 | — |
| cert | worker | en | OSHA 30-Hour Construction Safety and Health | cert:osha-outreach:us | 30-hour, construction | label | cert:osha-outreach:us | 30-hour, construction | 0.657 | 0.657 | — |
| cert | worker | en | ASME IX 6G SMAW | cert:asme-ix-welder | 6g | label | cert:asme-ix-welder | 6g | 0.73 | 0.73 | — |
| cert | worker | en | TWIC valid until 2028 | cert:twic:us | — | label | cert:twic:us | — | 0.738 | 0.738 | — |
| cert | worker | en | TWIC valid until 2025 | — | — | unmatched | — | — | 0.76 | — | — |
| cert | worker | en | TWIC 2019-2024 | — | — | unmatched | — | — | 0.8 | — | — |
| cert | worker | es | TWIC no vigente | — | — | unmatched | — | — | 0.797 | — | — |
| cert | worker | en | OSHA 40-Hour | — | — | unmatched | — | — | 0.684 | — | — |
| cert | worker | en | NCCCO Operator | — | — | unmatched | — | — | 0.848 | — | — |
| cert | worker | es | Traductor certificado, CDMX | — | — | unmatched | — | — | 0.818 | — | — |
| cert | hirer, us-tx | en | licensed electrician | cert:electrician-license:us-tx | — | label | cert:electrician-license:us-tx | — | 0.766 | 0.766 | — |
| cert | hirer, us-tx | en | certified rigger | cert:nccco-rigger | — | label | cert:nccco-rigger | — | 0.863 | 0.863 | — |
| cert | hirer, br-sp | pt | eletricista com licença | — | — | unmatched | — | — | 0.76 | — | — |
| cert | hirer, us-tx | pt | rigger certificado | cert:nccco-rigger | — | label | cert:nccco-rigger | — | 0.8 | 0.8 | — |
| cert | hirer, mx-nle | es | electricista con licencia | — | — | unmatched | — | — | 0.746 | — | — |
| cert | hirer, us-tx | es | aparejador certificado | cert:nccco-rigger | — | label | cert:nccco-rigger | — | 0.691 | 0.691 | — |
| cert | hirer, us-tx | es | electricista con licencia | cert:electrician-license:us-tx | — | label | cert:electrician-license:us-tx | — | 0.746 | 0.746 | — |
| cert | hirer, us-la | en | licensed plumber | cert:plumber-license:us-la | — | label | cert:plumber-license:us-la | — | 0.807 | 0.807 | — |
| cert | hirer, us-tx | en | master plumber | cert:plumber-license:us-tx | master | chosen | cert:plumber-license:us-tx | master | 0.641 | 0.641 | 0.96 |
| cert | hirer, us-tx | en | OSHA 30 | cert:osha-outreach:us | 30-hour | label | cert:osha-outreach:us | 30-hour | 0.763 | 0.763 | — |
| cert | hirer, us-tx | en | NCCCO Rigger Level II | cert:nccco-rigger | level-2 | label | cert:nccco-rigger | level-2 | 0.836 | 0.836 | — |
| cert | hirer, br-sp | pt | NR-10 Básico e SEP | cert:nr-10:br | sep | label | cert:nr-10:br | sep | 0.771 | 0.771 | — |
| cert | hirer, us-tx | en | licensed journeyman wireman | cert:electrician-license:us-tx | journeyman | **unmatched** | — | — | 0.574 | 0.552 | — |
| cert | hirer, us-tx | en | EPA 608 Type I and II | — | — | unmatched | — | — | 0.865 | — | — |
| cert | hirer, us-tx | en | HAZWOPER 40 | — | — | unmatched | — | — | 0.449 | — | — |
| cert | hirer, br-sp | pt | NR-12 | — | — | unmatched | — | — | 0.784 | — | — |
| cert | hirer, mx-cmx | es | traductor | — | — | unmatched | — | — | 0.712 | — | — |
