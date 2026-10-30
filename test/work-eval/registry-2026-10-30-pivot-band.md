# Canonicalization evaluation, 2026-10-30

Retrieve-then-choose over the synthetic seed (`test/fixtures/work/registry-seed.json`, no ESCO data; its 11 certificates are test data, since the plane holds none until a Vault document mints one, workspace decision 0070), 37 tokens and 134 labels in en, pt and es, each of 61 strings against a fresh copy, with `@cf/baai/bge-m3`, `@cf/cloudflare/clef-flash` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` over the Workers AI REST API from the Mac. τ_auto 0.95, τ_low 0.6. An occupation or a skill is a worker's, with their listing's market. A certificate snaps as a skill does, without a market and never minted, a worker's claim and a hirer's words alike; one where no token fits is right only when nothing snaps. The English pivot in the band (workspace decision 0018, amendment proposed 2026-10-30): on, so a worker's Portuguese or Spanish occupation or skill asks the pivot beside the embedding, and Clef is shown the token its English name names.

| Kind | Right | Wrong token | A token where none fits | No token where one fits |
|---|---|---|---|---|
| pos | 100% (23 of 23) | 0 | 0 | 0 |
| skill | 100% (20 of 20) | 0 | 0 | 0 |
| cert | 83.3% (15 of 18) | 0 | 0 | 3 |

Decisions: label 21, pivot 3, chosen 25, minted 4, unmatched 8. Cost per snap 0.000032 USD, median 581 ms. 0 snaps ran again after a hosted call threw; none still failed.

Calls: work-embed 0.70 a snap (median 209 ms answered), work-pivot 0.36 a snap (median 579 ms answered), work-adjudicate 0.57 a snap (median 427 ms answered); 0 pivot calls a τ_auto take left unread (cancelled while running, or metered as answered).

Cosine of the expected token's best label: min 0.566, median 0.855. Best cosine of strings with no fitting token: max 0.688.

Clef answered 35 strings in the band. Each answer read again at other floors (the shipped floor is 0.5): a pick counts at or above the floor, none too, and anything else is undecided.

| Floor | Picked the expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 29 | 1 | 5 | 0 |
| 0.4 | 27 | 0 | 5 | 3 |
| 0.5 | 25 | 0 | 3 | 7 |
| 0.6 | 25 | 0 | 3 | 7 |
| 0.7 | 20 | 0 | 2 | 13 |
| 0.8 | 16 | 0 | 1 | 18 |

| Kind | As | Language | String | Expected | Decision | Token | Top cos | Expected cos | Clef p | Clef band answer | Pivot |
|---|---|---|---|---|---|---|---|---|---|---|---|
| pos | worker, us-tx | en | Marine engineer | pos:marine-engineer | label | pos:marine-engineer | 0.962 | 0.962 | — | — | — |
| pos | worker, us-tx | en | Third Assistant Engineer | pos:marine-engineer | pivot | pos:marine-engineer | 0.583 | 0.566 | — | — | marine engineer → pos:marine-engineer |
| pos | worker, us-tx | en | Engine Cadet | pos:marine-engineer | chosen | pos:marine-engineer | 0.712 | 0.712 | 0.71 | pos:marine-engineer 0.71, none 0.16 | — |
| pos | worker, us-tx | en | journeyman electrician | pos:electrician | chosen | pos:electrician | 0.774 | 0.774 | 0.82 | pos:electrician 0.82, none 0.03 | — |
| pos | worker, us-tx | en | Electrician Apprentice | pos:electrician | chosen | pos:electrician | 0.79 | 0.79 | 0.76 | pos:electrician 0.76, none 0.04 | — |
| pos | worker, us-tx | en | Residential plumber | pos:plumber | chosen | pos:plumber | 0.792 | 0.792 | 0.85 | pos:plumber 0.85, none 0.04 | — |
| pos | worker, us-tx | en | Service Plumber | pos:plumber | chosen | pos:plumber | 0.742 | 0.742 | 0.76 | pos:plumber 0.76, none 0.08 | — |
| pos | worker, us-tx | en | Plumber's Helper | pos:plumber | chosen | pos:plumber | 0.697 | 0.697 | 0.66 | pos:plumber 0.66, none 0.14 | — |
| pos | worker, br-sp | pt | Soldador de Tubulação | pos:welder | pivot | pos:welder | 0.675 | 0.675 | — | pos:welder 0.45, none 0.06 | pipe welder → pos:welder |
| pos | worker, br-sp | pt | Caldeireiro | pos:boilermaker | label | pos:boilermaker | 0.827 | 0.827 | — | — | — |
| pos | worker, br-sp | pt | Eletricista de Manutenção Industrial | pos:industrial-electrician | chosen | pos:industrial-electrician | 0.855 | 0.855 | 0.70 | pos:industrial-electrician 0.70, none 0.02 | electrician → pos:electrician |
| pos | worker, br-sp | pt | Ajudante de Eletricista | pos:electrician | chosen | pos:electrician | 0.79 | 0.79 | 0.65 | pos:electrician 0.65, none 0.09 | electrician → pos:electrician |
| pos | worker, br-sp | pt | Jardineiro e paisagista | pos:gardener | chosen | pos:gardener | 0.81 | 0.81 | 0.84 | pos:gardener 0.84, none 0.11 | gardener and landscaper → no token |
| pos | worker, br-sp | pt | Auxiliar de Paisagismo | pos:gardener | chosen | pos:gardener | 0.753 | 0.753 | 0.83 | pos:gardener 0.83, none 0.13 | landscape gardener → no token |
| pos | worker, mx-nle | es | Aparejador (Rigger) | pos:rigger | pivot | pos:rigger | 0.677 | 0.677 | — | pos:rigger 0.48, none 0.21 | rigger → pos:rigger |
| pos | worker, mx-nle | es | Operador de Grúa Móvil | pos:crane-operator | chosen | pos:crane-operator | 0.77 | 0.77 | 0.87 | pos:crane-operator 0.87, none 0.03 | crane operator → pos:crane-operator |
| pos | worker, mx-nle | es | Traductora inglés-español | pos:translator | chosen | pos:translator | 0.769 | 0.769 | 0.79 | pos:translator 0.79, none 0.10 | translator → pos:translator |
| pos | worker, mx-nle | es | Traductora Independiente | pos:translator | chosen | pos:translator | 0.771 | 0.771 | 0.84 | pos:translator 0.84, none 0.06 | translator → pos:translator |
| pos | worker, mx-nle | es | Plomero Oficial | pos:plumber | chosen | pos:plumber | 0.776 | 0.776 | 0.86 | pos:plumber 0.86, none 0.04 | plumber → pos:plumber |
| pos | worker, mx-nle | es | Ayudante de Plomería | pos:plumber | chosen | pos:plumber | 0.632 | 0.632 | 0.83 | pos:plumber 0.83, none 0.05 | plumber → pos:plumber |
| pos | worker, us-tx | en | Pastry chef | — | minted | pos:pastry-chef | 0.552 | — | — | — | pastry chef → no token |
| pos | worker, br-sp | pt | Motorista de caminhão | — | minted | pos:truck-driver | 0.632 | — | — | none 0.68, none 0.68 | truck driver → no token |
| pos | worker, mx-nle | es | Cocinero de línea | — | minted | pos:cook | 0.562 | — | — | — | cook → no token |
| skill | worker, us-tx | en | fixing leaks | skill:leak-repair | label | skill:leak-repair | 1 | 1 | — | — | — |
| skill | worker, us-tx | en | Leak detection | skill:leak-detection | label | skill:leak-detection | 0.994 | 0.994 | — | — | — |
| skill | worker, us-tx | en | replacing water heaters | skill:water-heater-installation | chosen | skill:water-heater-installation | 0.801 | 0.801 | 0.84 | skill:water-heater-installation 0.84, none 0.06 | — |
| skill | worker, us-tx | en | clearing drains | skill:drain-cleaning | chosen | skill:drain-cleaning | 0.881 | 0.881 | 0.84 | skill:drain-cleaning 0.84, none 0.05 | — |
| skill | worker, us-tx | en | EV chargers | skill:ev-charger-installation | chosen | skill:ev-charger-installation | 0.831 | 0.831 | 0.89 | skill:ev-charger-installation 0.89, none 0.05 | — |
| skill | worker, us-tx | en | panel upgrades | skill:electrical-panel-upgrade | chosen | skill:electrical-panel-upgrade | 0.872 | 0.872 | 0.88 | skill:electrical-panel-upgrade 0.88, none 0.05 | — |
| skill | worker, us-tx | en | Diesel engine maintenance | skill:diesel-engine-maintenance | label | skill:diesel-engine-maintenance | 0.972 | 0.972 | — | — | — |
| skill | worker, br-sp | pt | Corte com maçarico | skill:torch-cutting | label | skill:torch-cutting | 0.971 | 0.971 | — | — | — |
| skill | worker, br-sp | pt | Leitura de desenho isométrico | skill:isometric-drawing-reading | chosen | skill:isometric-drawing-reading | 0.877 | 0.877 | 0.96 | skill:isometric-drawing-reading 0.96, none 0.02 | isometric drawing reading → skill:isometric-drawing-reading |
| skill | worker, br-sp | pt | Corte de grama | skill:lawn-mowing | label | skill:lawn-mowing | 0.977 | 0.977 | — | — | — |
| skill | worker, br-sp | pt | poda de cercas vivas | skill:pruning | chosen | skill:pruning | 0.647 | 0.621 | 0.92 | skill:pruning 0.92, none 0.02 | hedge trimming → skill:pruning |
| skill | worker, br-sp | pt | Irrigação por gotejamento | skill:irrigation-maintenance | chosen | skill:irrigation-maintenance | 0.703 | 0.703 | 0.68 | skill:irrigation-maintenance 0.68, none 0.25 | drip irrigation → skill:irrigation-maintenance |
| skill | worker, mx-nle | es | Reparación de fugas | skill:leak-repair | label | skill:leak-repair | 0.95 | 0.95 | — | — | — |
| skill | worker, mx-nle | es | Detección de fugas | skill:leak-detection | label | skill:leak-detection | 0.986 | 0.986 | — | — | — |
| skill | worker, mx-nle | es | Instalación de calentadores | skill:water-heater-installation | label | skill:water-heater-installation | 0.975 | 0.975 | — | — | — |
| skill | worker, mx-nle | es | maniobras de carga | skill:rigging | label | skill:rigging | 1 | 1 | — | — | — |
| skill | worker, mx-nle | es | Operación de grúas telescópicas | skill:crane-operation | chosen | skill:crane-operation | 0.857 | 0.857 | 0.90 | skill:crane-operation 0.90, none 0.03 | telescopic crane operation → no token |
| skill | worker, mx-nle | es | Traducción de contratos comerciales | skill:legal-translation | chosen | skill:legal-translation | 0.831 | 0.831 | 0.96 | skill:legal-translation 0.96, none 0.02 | commercial contract translation → no token |
| skill | worker, us-tx | en | bilge water management | — | unmatched | — | 0.641 | — | 0.40 | skill:leak-repair 0.40, none 0.31 | bilge water management → no token |
| skill | worker, br-sp | pt | Esmerilhamento | — | minted | skill:grinding | 0.606 | — | — | none 0.88, none 0.88 | grinding → no token |
| cert | worker or hirer | en | Texas Journeyman Electrician License | cert:electrician-license:us-tx | label | cert:electrician-license:us-tx | 0.944 | 0.944 | — | — | — |
| cert | worker or hirer | en | Texas Journeyman Plumber License | cert:plumber-license:us-tx | label | cert:plumber-license:us-tx | 0.906 | 0.906 | — | — | — |
| cert | worker or hirer | en | BOSIET with CA-EBS | cert:bosiet | **unmatched** | — | 0.772 | 0.772 | 0.33 | cert:bosiet 0.33, none 0.30 | — |
| cert | worker or hirer | en | STCW Basic Safety Training | cert:stcw-basic-safety | label | cert:stcw-basic-safety | 1 | 1 | — | — | — |
| cert | worker or hirer | en | OSHA 10-Hour Construction | cert:osha-10 | **unmatched** | — | 0.922 | 0.922 | 0.34 | cert:osha-10 0.34, none 0.17 | — |
| cert | worker or hirer | pt | NR-10 Básico | cert:nr-10:br | chosen | cert:nr-10:br | 0.836 | 0.836 | 0.63 | cert:nr-10:br 0.63, none 0.13 | — |
| cert | worker or hirer | pt | NR-35 Trabalho em Altura | cert:nr-35:br | label | cert:nr-35:br | 0.931 | 0.931 | — | — | — |
| cert | worker or hirer | pt | Qualificação de soldador ASME IX | cert:asme-ix-welder | label | cert:asme-ix-welder | 0.974 | 0.974 | — | — | — |
| cert | worker or hirer | es | OSHA 30 horas | cert:osha-30 | label | cert:osha-30 | 1 | 1 | — | — | — |
| cert | worker or hirer | es | NCCCO Aparejador Nivel II | cert:nccco-rigger | **unmatched** | — | 0.728 | 0.728 | 0.40 | none 0.40, none 0.40 | — |
| cert | worker or hirer | es | NCCCO Operador de Grúa Telescópica | cert:nccco-crane-operator | label | cert:nccco-crane-operator | 0.871 | 0.871 | — | — | — |
| cert | worker or hirer | en | licensed electrician | cert:electrician-license:us-tx | label | cert:electrician-license:us-tx | 1 | 1 | — | — | — |
| cert | worker or hirer | en | certified rigger | cert:nccco-rigger | label | cert:nccco-rigger | 1 | 1 | — | — | — |
| cert | worker or hirer | es | aparejador certificado | cert:nccco-rigger | label | cert:nccco-rigger | 1 | 1 | — | — | — |
| cert | worker or hirer | en | TWIC card | — | unmatched | — | 0.467 | — | — | — | — |
| cert | worker or hirer | en | NFPA 70E Arc Flash Training | — | unmatched | — | 0.505 | — | — | — | — |
| cert | worker or hirer | pt | NR-34 Trabalho a Quente | — | unmatched | — | 0.688 | — | 0.47 | none 0.47, none 0.47 | — |
| cert | worker or hirer | es | Perito Traductor certificado | — | unmatched | — | 0.629 | — | — | none 0.73, none 0.73 | — |
