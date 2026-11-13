# Regional words and false friends on the v2 replica, 2026-11-13

39 synthetic strings (`test/fixtures/work/locale-cases.json`), each with the market of the worker who wrote it, snapped against the v2 generation's registry, the one the plane runs (`test/work-eval/replica.ts`: the ESCO import's and the US layer's SQL, 16978 tokens and 230108 labels, no certificate token; 229654 v2 vectors of EmbeddingGemma 2's LiteRT-LM file at 768, a national label's region kept), each string embedded as the plane embeds a Cofferdam Cloud user's (the plane's `embedTexts` under the v2 pin, Workers AI's `@cf/google/embeddinggemma-2` as its stand-in, workspace decision 0084, a query and a document), with `@cf/cloudflare/clef-flash` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` over the Workers AI REST API from the Mac. τ_auto 0.96, τ_low 0.81. Three arms on the same registry and vectors: **before**, the hosted requests as they were before the locale (cofferdam-api 16ab6a8: Clef told the language's code, no language beside a matched label, the pivot given the bare string); **language**, production's requests with no market; **market**, production's with the listing's market. The English pivot in the band is off, as on the plane today. Right: one of the expected tokens, or, where no token fits, none or a new one; a false friend is the token ESCO's Spanish or Portuguese gives the word, or the one a generic English name holds as a label (workspace OD-28).

| Group | Before | Language | Market (production) |
|---|---|---|---|
| regional | 13 of 27 right, 0 false friend, 14 other | 18 of 27 right, 0 false friend, 9 other | 17 of 27 right, 0 false friend, 10 other |
| false friend | 2 of 5 right, 1 false friend, 2 other | 4 of 5 right, 0 false friend, 1 other | 3 of 5 right, 0 false friend, 2 other |
| generic name | 1 of 4 right, 2 false friend, 1 other | 1 of 4 right, 3 false friend, 0 other | 1 of 4 right, 3 false friend, 0 other |
| label | 1 of 3 right, 2 false friend, 0 other | 1 of 3 right, 2 false friend, 0 other | 1 of 3 right, 2 false friend, 0 other |
| all | 17 of 39 | 24 of 39 | 22 of 39 |

Cost per snap 0.000045 USD (the embeddings made before the snaps, through the plane's stand-in). 7 snaps ran again after a hosted call threw; 3 still failed: before Borracheiro: work-adjudicate: work-adjudicate gave no answer within 6000 ms; before Vulcanizador: work-adjudicate: work-adjudicate gave no answer within 6000 ms; before Gesseiro: work-adjudicate: work-adjudicate gave no answer within 6000 ms.

Clef's band answers, read again at other floors (the shipped floor is 0.5), per arm:

**before**, 31 answers:

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 13 | 13 | 5 | 0 |
| 0.4 | 12 | 7 | 3 | 9 |
| 0.5 | 11 | 5 | 2 | 13 |
| 0.6 | 7 | 2 | 0 | 22 |
| 0.7 | 6 | 0 | 0 | 25 |
| 0.8 | 4 | 0 | 0 | 27 |

**language**, 34 answers:

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 13 | 10 | 8 | 3 |
| 0.4 | 11 | 3 | 6 | 14 |
| 0.5 | 9 | 2 | 4 | 19 |
| 0.6 | 7 | 1 | 4 | 22 |
| 0.7 | 5 | 0 | 3 | 26 |
| 0.8 | 1 | 0 | 1 | 32 |

**market**, 34 answers:

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 14 | 8 | 10 | 2 |
| 0.4 | 13 | 5 | 8 | 8 |
| 0.5 | 13 | 4 | 8 | 9 |
| 0.6 | 9 | 3 | 7 | 15 |
| 0.7 | 7 | 0 | 5 | 22 |
| 0.8 | 3 | 0 | 4 | 27 |

| Group | String | Language, market | Expected | Before | Language | Market (production) |
|---|---|---|---|---|---|---|
| regional | Encanador | pt, br-sp | pos:plumber | **chosen pos:hardwood-floor-layer**; Clef pos:hardwood-floor-layer 0.54, none 0.20 | pivot pos:plumber; Clef pos:hardwood-floor-layer 0.38, none 0.30; pivot "plumber" | pivot pos:plumber; Clef none 0.68, none 0.68; pivot "plumber" |
| regional | Bombeiro hidráulico | pt, br-rj | pos:plumber | **pivot pos:firefighter**; Clef none 0.31, none 0.31; pivot "firefighter" | pivot pos:plumber; Clef none 0.31, none 0.31; pivot "plumber" | pivot pos:plumber; Clef none 0.31, none 0.31; pivot "plumber" |
| regional | Terceiro Oficial de Máquinas | pt, br-rj | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | chosen pos:marine-engineer; Clef pos:marine-engineer 0.66, none 0.03 | chosen pos:marine-engineer; Clef pos:marine-engineer 0.54, none 0.07 | chosen pos:marine-engineer; Clef pos:marine-engineer 0.62, none 0.05 |
| regional | Garçom | pt, br-sp | pos:waiter-waitress | pivot pos:waiter-waitress; Clef none 0.31, none 0.31; pivot "waiter" | pivot pos:waiter-waitress; Clef none 0.45, none 0.45; pivot "waiter" | pivot pos:waiter-waitress; Clef none 0.55, none 0.55; pivot "waiter" |
| regional | Caminhoneiro | pt, br-pr | pos:cargo-vehicle-driver | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.76, none 0.05 | pivot pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.44, none 0.09; pivot "truck driver" | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.79, none 0.04 |
| regional | Operador de empilhadeira | pt, br-sp | pos:forklift-operator | chosen pos:forklift-operator; Clef pos:forklift-operator 0.81, none 0.04 | chosen pos:forklift-operator; Clef pos:forklift-operator 0.77, none 0.06 | chosen pos:forklift-operator; Clef pos:forklift-operator 0.84, none 0.04 |
| regional | Frentista | pt, br-mg | pos:fuel-station-specialised-seller | **minted pos:gas-station-attendant**; pivot "gas station attendant" | **minted pos:gas-station-attendant**; pivot "gas station attendant" | **minted pos:gas-station-attendant**; pivot "gas station attendant" |
| regional | Motorista de ônibus | pt, br-sp | pos:bus-driver | chosen pos:bus-driver; Clef pos:bus-driver 0.82, none 0.03 | chosen pos:bus-driver; Clef pos:bus-driver 0.69, none 0.06 | chosen pos:bus-driver; Clef pos:bus-driver 0.82, none 0.02 |
| regional | Auxiliar de cozinha | pt, br-sp | pos:kitchen-assistant, pos:kitchen-porter | chosen pos:kitchen-assistant; Clef pos:kitchen-assistant 0.57, none 0.02 | pivot pos:kitchen-assistant; Clef pos:food-service-worker 0.36, none 0.06; pivot "kitchen assistant" | chosen pos:kitchen-assistant; Clef pos:kitchen-assistant 0.53, none 0.04 |
| regional | Soldador de Tubulação | pt, br-rj | pos:pipe-welder, pos:welder | chosen pos:pipe-welder; Clef pos:pipe-welder 0.58, none 0.04 | chosen pos:pipe-welder; Clef pos:pipe-welder 0.68, none 0.05 | chosen pos:pipe-welder; Clef pos:pipe-welder 0.59, none 0.04 |
| regional | Plomero | es, mx-nle | pos:plumber | pivot pos:plumber; Clef pos:plumber 0.41, none 0.10; pivot "plumber" | chosen pos:plumber; Clef pos:plumber 0.52, none 0.07 | chosen pos:plumber; Clef pos:plumber 0.59, none 0.07 |
| regional | Tercer Ingeniero | es, mx-ver | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | chosen pos:ship-assistant-engineer; Clef pos:ship-assistant-engineer 0.54, none 0.10 | pivot pos:marine-engineer; Clef pos:ship-assistant-engineer 0.37, none 0.17; pivot "marine engineer" | pivot pos:marine-engineer; Clef pos:mechanical-engineer 0.38, none 0.17; pivot "marine engineer" |
| regional | Mesero | es, mx-cmx | pos:waiter-waitress | chosen pos:waiter-waitress; Clef pos:waiter-waitress 0.80, none 0.03 | chosen pos:waiter-waitress; Clef pos:waiter-waitress 0.77, none 0.04 | chosen pos:waiter-waitress; Clef pos:waiter-waitress 0.83, none 0.02 |
| regional | Camionero | es, mx-nle | pos:cargo-vehicle-driver | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.71, none 0.04 | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.75, none 0.03 | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.75, none 0.03 |
| regional | Montacarguista | es, mx-nle | pos:forklift-operator | **pivot pos:stevedore**; Clef none 0.57, none 0.57; pivot "stevedore" | pivot pos:forklift-operator; Clef none 0.78, none 0.78; pivot "forklift operator" | pivot pos:forklift-operator; Clef none 0.90, none 0.90; pivot "forklift operator" |
| regional | Tablajero | es, mx-cmx | pos:butcher | **pivot pos:cabinet-maker**; Clef pos:lumber-grader 0.35, none 0.21; pivot "cabinetmaker" | **pivot pos:cabinet-maker**; Clef pos:lumber-grader 0.25, none 0.20; pivot "cabinetmaker" | **pivot pos:cabinet-maker**; Clef pos:roofer 0.29, none 0.19; pivot "cabinetmaker" |
| regional | Borracheiro | pt, br-sp | pos:tyre-vulcaniser, pos:tyre-fitter | **unmatched —** | **pivot pos:vehicle-technician**; Clef none 0.84, none 0.84; pivot "tire technician" | **pivot pos:vehicle-technician**; Clef none 0.91, none 0.91; pivot "tire technician" |
| regional | Vulcanizador | es, mx-nle | pos:tyre-vulcaniser, pos:tyre-fitter | **unmatched —** | chosen pos:tyre-vulcaniser; Clef pos:tyre-vulcaniser 0.81, none 0.09 | chosen pos:tyre-vulcaniser; Clef pos:tyre-vulcaniser 0.79, none 0.09 |
| regional | Gesseiro | pt, br-sp | pos:plasterer, pos:ceiling-installer | **unmatched —** | pivot pos:plasterer; Clef pos:bricklayer 0.38, none 0.25; pivot "plasterer" | **chosen pos:bricklayer**; Clef pos:bricklayer 0.60, none 0.18 |
| regional | Babá | pt, br-sp | pos:nanny, pos:babysitter | chosen pos:nanny; Clef pos:nanny 0.53, none 0.07 | pivot pos:nanny; Clef pos:nanny 0.43, none 0.08; pivot "nanny" | chosen pos:nanny; Clef pos:nanny 0.53, none 0.06 |
| regional | Velador | es, mx-nle | pos:security-guard | **pivot pos:officer-of-the-watch**; Clef none 0.47, none 0.47; pivot "watchman" | **pivot pos:officer-of-the-watch**; Clef none 0.40, none 0.40; pivot "watchman" | **pivot pos:officer-of-the-watch**; Clef none 0.61, none 0.61; pivot "watchman" |
| regional | Motoboy | pt, br-sp | pos:motorcycle-delivery-person | **minted pos:courier**; pivot "courier" | **minted pos:courier**; pivot "courier" | **minted pos:messenger**; pivot "messenger" |
| regional | Lavaloza | es, mx-cmx | pos:kitchen-porter | **chosen pos:laundry-worker**; Clef pos:laundry-worker 0.63, none 0.11 | **chosen pos:laundry-worker**; Clef pos:laundry-worker 0.62, none 0.07 | **chosen pos:laundry-worker**; Clef pos:laundry-worker 0.65, none 0.07 |
| regional | Hojalatero | es, mx-cmx | pos:refurbishing-technician | **pivot pos:roofer**; Clef none 0.60, none 0.60; pivot "tinsmith" | **pivot pos:sheet-metal-worker**; Clef none 0.74, none 0.74; pivot "sheet metal worker" | **pivot pos:sheet-metal-worker**; Clef none 0.80, none 0.80; pivot "sheet metal worker" |
| regional | Bodeguero | es, mx-nle | pos:warehouse-worker, pos:warehouse-order-picker | **chosen pos:vineyard-cellar-master**; Clef pos:vineyard-cellar-master 0.53, none 0.21 | **chosen pos:vineyard-cellar-master**; Clef pos:vineyard-cellar-master 0.60, none 0.16 | **chosen pos:vineyard-cellar-master**; Clef pos:vineyard-cellar-master 0.63, none 0.18 |
| regional | Faxineira | pt, br-rj | pos:domestic-cleaner, pos:building-cleaner, pos:domestic-housekeeper | pivot pos:domestic-cleaner; Clef pos:landscape-gardener 0.34, none 0.29; pivot "cleaner" | pivot pos:domestic-cleaner; Clef none 0.68, none 0.68; pivot "cleaner" | pivot pos:domestic-cleaner; Clef none 0.88, none 0.88; pivot "cleaner" |
| regional | Afanadora | es, mx-cmx | pos:building-cleaner, pos:domestic-cleaner | **chosen pos:tool-grinder**; Clef pos:tool-grinder 0.68, none 0.12 | **unmatched —**; Clef pos:tool-grinder 0.37, none 0.23; pivot "threshing machine operator" | **chosen pos:tool-grinder**; Clef pos:tool-grinder 0.57, none 0.26 |
| false friend | Instructor | en, us-tx | none | **pivot pos:politics-lecturer**; Clef pos:higher-education-lecturer 0.50, none 0.15; pivot "teacher" | unmatched —; Clef pos:higher-education-lecturer 0.39, none 0.24; pivot "instructor" | **pivot pos:politics-lecturer**; Clef pos:higher-education-lecturer 0.42, none 0.10; pivot "teacher" |
| false friend | Coach | en, us-tx | pos:sports-coach, none | unmatched —; Clef pos:carriage-driver 0.31, none 0.15; pivot "coach" | unmatched —; Clef pos:carriage-driver 0.32, none 0.10; pivot "coach" | unmatched —; Clef pos:bus-driver 0.36, none 0.11; pivot "coach" |
| false friend | Valet | en, us-fl | pos:parking-valet, none | **pivot pos:civil-enforcement-officer**; Clef pos:room-attendant 0.37, none 0.18; pivot "parking attendant" | **pivot pos:civil-enforcement-officer**; Clef pos:private-chauffeur 0.44, none 0.14; pivot "parking attendant" | **pivot pos:civil-enforcement-officer**; Clef pos:parking-valet 0.38, none 0.12; pivot "parking attendant" |
| false friend | Compositor | en, us-ca | pos:typesetter, pos:digital-artist, pos:desktop-publisher, none | **pivot pos:composer**; Clef pos:desktop-publisher 0.31, none 0.21; pivot "composer" | pivot pos:typesetter; Clef pos:desktop-publisher 0.33, none 0.23; pivot "typesetter" | chosen pos:desktop-publisher; Clef pos:desktop-publisher 0.66, none 0.12 |
| false friend | Instrutor | pt, br-sp | none | unmatched —; Clef pos:armed-forces-training-and-education-officer 0.31, none 0.28; pivot "instructor" | unmatched —; Clef pos:armed-forces-training-and-education-officer 0.36, none 0.13; pivot "instructor" | unmatched —; Clef pos:armed-forces-training-and-education-officer 0.35, none 0.30; pivot "instructor" |
| generic name | Professora | pt, br-sp | pos:primary-school-teacher, pos:secondary-school-teacher, pos:early-years-teacher, none | **chosen pos:higher-education-lecturer**; Clef pos:higher-education-lecturer 0.51, none 0.17 | **pivot pos:politics-lecturer**; Clef none 0.32, none 0.32; pivot "teacher" | **pivot pos:politics-lecturer**; Clef none 0.32, none 0.32; pivot "teacher" |
| generic name | Maestra | es, mx-cmx | pos:primary-school-teacher, pos:secondary-school-teacher, pos:early-years-teacher, none | **pivot pos:politics-lecturer**; Clef pos:musical-conductor 0.44, none 0.15; pivot "teacher" | **pivot pos:politics-lecturer**; Clef pos:head-waiter-head-waitress 0.30, none 0.26; pivot "teacher" | **pivot pos:politics-lecturer**; Clef none 0.80, none 0.80; pivot "teacher" |
| generic name | Torneiro mecânico | pt, br-sp | pos:fitter-and-turner, pos:lathe-and-turning-machine-operator, pos:metalworking-lathe-operator | chosen pos:fitter-and-turner; Clef pos:fitter-and-turner 0.82, none 0.03 | chosen pos:fitter-and-turner; Clef pos:fitter-and-turner 0.77, none 0.04 | chosen pos:fitter-and-turner; Clef pos:fitter-and-turner 0.75, none 0.04 |
| generic name | Supervisora | pt, br-sp | none | **pivot pos:oil-refinery-control-room-operator**; Clef pos:roofing-supervisor 0.33, none 0.23; pivot "supervisor" | **pivot pos:oil-refinery-control-room-operator**; Clef none 0.27, none 0.27; pivot "supervisor" | **pivot pos:oil-refinery-control-room-operator**; Clef pos:script-supervisor 0.29, none 0.28; pivot "supervisor" |
| label | Instructor | es, mx-cmx | none | **label pos:air-force-officer** | **label pos:air-force-officer** | **label pos:air-force-officer** |
| label | Valet | es, mx-cmx | pos:parking-valet, none | **label pos:room-attendant** | **label pos:room-attendant** | **label pos:room-attendant** |
| label | Coach | pt, br-sp | pos:life-coach, pos:sports-coach | label pos:life-coach | label pos:life-coach | label pos:life-coach |

The nearest candidates (token, matched label, its language and a national label's region, cosine), the same in every arm:

| String | Candidates |
|---|---|
| Encanador (pt) | pos:derrickhand "encuellador" es 0.860; pos:bulk-filler "Enfardador" pt 0.858; pos:hardwood-floor-layer "entarimador" es 0.842; pos:carpet-fitter "enmoquetador" es 0.834; pos:assayer "ensayador" es 0.834 |
| Bombeiro hidráulico (pt) | pos:firefighter "Bombeira" pt 0.840; pos:water-engineer "Engenheiro hidráulico" pt 0.835; pos:fluid-power-engineer "Engenheiro hidráulico" pt 0.835; pos:industrial-firefighter "Bombeira industrial" pt 0.818; pos:marine-firefighter "Bombeiro naval" pt 0.811 |
| Terceiro Oficial de Máquinas (pt) | pos:marine-mechanic "oficial de máquinas" es 0.887; pos:deck-officer "primer oficial de máquinas" es 0.876; pos:marine-chief-engineer "Chefe de máquinas" pt 0.837; pos:rail-operations-manager "Maquinista" pt 0.817; pos:marine-engineer "oficial de máquinas de la marina mercante" es 0.814 |
| Garçom (pt) | pos:bartender "camarera" es 0.860; pos:domestic-butler "Mordomo doméstico" pt 0.833; pos:receptionist "Rececionista" pt 0.828; pos:hospitality-establishment-receptionist "Rececionista" pt 0.828; pos:night-auditor "Rececionista" pt 0.828 |
| Caminhoneiro (pt) | pos:tow-truck-driver "camionero de remolque" es 0.864; pos:cargo-vehicle-driver "trucker" en 0.851; pos:moving-truck-driver "Motorista de camiões de mudanças" pt 0.849; pos:coachbuilder "Carroçador" pt 0.841; pos:room-attendant "Camareiro" pt 0.835 |
| Operador de empilhadeira (pt) | pos:forklift-operator "Operador de empilhadores" pt 0.909; pos:warehouse-order-picker "Operador de armazém" pt 0.885; pos:excavator-operator "Operador de escavadora" pt 0.876; pos:high-rigger "operador de montacargas" es 0.869; pos:spinning-machine-operator "Operador de máquinas de fiação" pt 0.865 |
| Frentista (pt) | pos:sewing-machine-operator "Front Facer" en-us 0.807; pos:plumber "fontanera" es 0.800; pos:rail-operations-manager "Maquinista" pt 0.792; pos:user-interface-developer "desarrollador de frontales" es 0.791; pos:hotel-porter "Moça de fretes" pt 0.790 |
| Motorista de ônibus (pt) | pos:bus-driver "bus driver" en 0.896; pos:trolley-bus-driver "bus operator" en 0.862; pos:bus-driving-instructor "bus driver instructor" en 0.852 |
| Auxiliar de cozinha (pt) | pos:kitchen-assistant "Assistente de cozinha" pt 0.933; pos:kitchen-porter "auxiliar de cocinero" es 0.923; pos:restaurant-manager "Gestor de cozinha" pt 0.867; pos:cook "empleada en cocinas" es 0.863; pos:food-service-worker "kitchen assistant" en 0.851 |
| Soldador de Tubulação (pt) | pos:pipe-welder "Soldador de tubos" pt 0.891; pos:drain-technician "Técnico de tubagem" pt 0.870; pos:welding-engineer "Engenheiro de soldadura" pt 0.850; pos:welding-inspector "Inspetor de soldadura" pt 0.835; pos:welder "soldador" es 0.825 |
| Plomero (es) | pos:plumber "fontanero" es 0.859; pos:pipe-welder "plumber" en 0.848; pos:bathroom-fitter "fontanero instalador de cuartos de baño" es 0.846; pos:plumbing-supervisor "jefe de equipo de fontaneros" es 0.821 |
| Tercer Ingeniero (es) | pos:ship-assistant-engineer "third assistant engineer" en 0.852; pos:military-engineer "ingeniera del ejército" es 0.843; pos:offshore-renewable-energy-engineer "ingeniera ORE" es 0.842; pos:mechanical-engineer "ingeniero mecánico/ingeniera mecánica" es 0.837; pos:maintenance-and-repair-engineer "ingeniera de equipos" es 0.834 |
| Mesero (es) | pos:bartender "camarera" es 0.848; pos:head-waiter-head-waitress "camarera jefe" es 0.838; pos:quick-service-restaurant-crew-member "Mess Attendant" en-us 0.825; pos:waiter-waitress "camarero/camarera" es 0.820; pos:hotel-butler "mayordomo de hostelería" es 0.815 |
| Camionero (es) | pos:tow-truck-driver "camionero de remolque" es 0.896; pos:cargo-vehicle-driver "trucker" en 0.862; pos:moving-truck-driver "Motorista de camiões de mudanças" pt 0.852; pos:room-attendant "Camareiro" pt 0.844; pos:forklift-operator "Inside Trucker" en-us 0.831 |
| Montacarguista (es) | pos:coachbuilder "Carroçador" pt 0.838; pos:tent-installer "montadora de carpas" es 0.835; pos:marine-fitter "montador naval" pt 0.824; pos:bicycle-assembler "montadora de tándems" es 0.824; pos:mechatronics-assembler "montadora en mecatrónica" es 0.804 |
| Tablajero (es) | pos:woodcarver "tallador" es 0.837; pos:lumber-grader "clasificador de tablones de madera" es 0.825; pos:roofer "colocador de pizarra" es 0.820; pos:military-engineer "zapador" es 0.816; pos:engineered-wood-board-grader "clasificador de tableros aglomerados" es 0.810 |
| Borracheiro (pt) | pos:shoe-and-leather-accessories-shop-manager "Correeiro" pt 0.835; pos:door-supervisor "Porteiro" pt 0.823; pos:doorman-doorwoman "Porteiro" pt 0.823; pos:chain-making-machine-operator "Barbeleira" pt 0.822; pos:locksmith "Serralheira" pt 0.820 |
| Vulcanizador (es) | pos:tyre-vulcaniser "Vulcanizador de pneus" pt 0.824; pos:electroplating-machine-operator "Metalizer" en-us 0.813; pos:plumber "Canalizador" pt 0.810; pos:bathroom-fitter "Canalizador" pt 0.810; pos:plumbing-supervisor "Canalizador" pt 0.810 |
| Gesseiro (pt) | pos:basketmaker "Cesteiro" pt 0.841; pos:shoe-and-leather-accessories-shop-manager "Correeiro" pt 0.810; pos:cider-master "sidrero" es 0.806; pos:hand-packer "Caser" en-us 0.805; pos:bricklayer "Calceteiro" pt 0.804 |
| Babá (pt) | pos:nanny "nanny" en 0.812; pos:child-day-care-worker "Acompanhante de crianças" pt 0.791; pos:home-care-aide "Ajudante familiar" pt 0.790; pos:circus-artist "Mágico" pt 0.789; pos:babysitter "baby-sitter" en 0.781 |
| Velador (es) | pos:handyperson "zelador" pt 0.849; pos:terrazzo-setter "solador" es 0.829; pos:vineyard-worker "vendimiador" es 0.829; pos:farrier "Ferrador" pt 0.828; pos:pawnbroker "fiador" es 0.822 |
| Motoboy (pt) | pos:motorcycle-delivery-person "motorcycle driver of deliveries" en 0.795; pos:professional-athlete "motorcycle driver" en 0.786; pos:police-officer "Motorcycle Police" en-us 0.780; pos:vehicle-technician "técnico de motas" pt 0.778; pos:motorcycle-instructor "Instrutor de condução de motociclos" pt 0.775 |
| Lavaloza (es) | pos:kitchen-porter "lavaplatos" es 0.884; pos:linen-room-attendant "operaria de lavandería" es 0.821; pos:laundry-worker "operaria de lavandería" es 0.821; pos:laundry-ironer "planchador de lavandería" es 0.814; pos:pottery-and-porcelain-caster "moldeador de loza" es 0.813 |
| Hojalatero (es) | pos:chocolatier "chocolatero" es 0.815; pos:malt-master "maltero" es 0.815; pos:shoemaker "zapatera" es 0.815; pos:yarn-spinner "hilandero" es 0.812; pos:milliner "sombrerero" es 0.811 |
| Bodeguero (es) | pos:vineyard-cellar-master "maestro bodeguero" es 0.839; pos:woodturner "bodger" en 0.814; pos:bulldozer-operator "operario de buldócer" es 0.778; pos:circus-artist "torero" es 0.774; pos:shoe-and-leather-accessories-shop-manager "Correeiro" pt 0.767 |
| Faxineira (pt) | pos:coppersmith "Funileira" pt 0.831; pos:knitter "Fazedora de renda" pt 0.827; pos:miller "Moleiro/Moleira" pt 0.809; pos:landscape-gardener "Jardineira" pt 0.807; pos:groundsman-groundswoman "Jardineira" pt 0.807 |
| Afanadora (es) | pos:tool-grinder "afiladora" es 0.855; pos:fortune-teller "Advinhadora" pt 0.837; pos:infantry-soldier "Atiradora" pt 0.833; pos:farrier "Ferradora" pt 0.827; pos:rigger "Aparelhadora" pt 0.826 |
| Instructor (en) | pos:air-force-officer "instructor" es 0.950; pos:higher-education-lecturer "Educational Instructor" en-us 0.926; pos:zoo-educator "education instructor" en 0.916; pos:business-lecturer "Management Instructor" en-us 0.904; pos:special-educational-needs-assistant "Assistant Instructor" en-us 0.903 |
| Coach (en) | pos:life-coach "Coach" pt 0.961; pos:carriage-driver "coachman" en 0.916; pos:bus-driver "coach driver" en 0.899; pos:sports-coach "coach in sports" en 0.898; pos:business-coach "Coach profissional" pt 0.893 |
| Valet (en) | pos:room-attendant "valet" es 0.898; pos:parking-valet "Valet Driver" en-us 0.897; pos:private-chauffeur "private valet" en 0.853; pos:hotel-porter "bellboy" en 0.830; pos:vehicle-cleaner "van valeter" en 0.826 |
| Compositor (en) | pos:composer "Compositor" pt 0.959; pos:desktop-publisher "Computer Compositor" en-us 0.920; pos:digital-artist "Compositora digital" pt 0.852; pos:extra "comparsa" es 0.842; pos:imagesetter "compositora de imágenes" es 0.841 |
| Instrutor (pt) | pos:air-force-officer "instructora" es 0.913; pos:armed-forces-training-and-education-officer "Instrutor militar" pt 0.902; pos:ski-instructor "Instrutor  de equi" pt 0.889; pos:guide-dog-instructor "Instrutor de cães-guias" pt 0.884; pos:assayer "Ensaiador" pt 0.879 |
| Professora (pt) | pos:higher-education-lecturer "Professora universitária" pt 0.905; pos:assistant-lecturer "Professora assistente" pt 0.887; pos:vocational-teacher "Professora do ensino profissional" pt 0.884; pos:classical-languages-lecturer "Professora de Grego" pt 0.881; pos:philosophy-lecturer "Professora de Filosofia" pt 0.880 |
| Maestra (es) | pos:malt-master "maestro maltero/maestra maltera" es 0.876; pos:musical-conductor "maestro/maestrina" pt 0.873; pos:cider-master "maestro sidrero/maestra sidrera" es 0.871; pos:hotel-butler "maestresala" es 0.863; pos:head-waiter-head-waitress "maestresala" es 0.863 |
| Torneiro mecânico (pt) | pos:laundry-ironer "Engomador mecânico" pt 0.871; pos:woodturner "Torneiro de madeiras" pt 0.865; pos:fitter-and-turner "Torneiro" pt 0.858; pos:industrial-machinery-mechanic "Mecânico industrial" pt 0.836; pos:roadside-vehicle-technician "Mecânico de intervenção" pt 0.830 |
| Supervisora (pt) | pos:oil-refinery-control-room-operator "supervisor" en 0.882; pos:chemical-processing-supervisor "Supervisora de laboratório" pt 0.870; pos:script-supervisor "Supervisora de guião" pt 0.870; pos:police-commissioner "Superintendente" pt 0.868; pos:roofing-supervisor "supervisora de tejadores" es 0.866 |
| Instructor (es) | — |
| Valet (es) | — |
| Coach (pt) | — |

What Clef was told in production's arm (the state and the `match` criteria), for the first string of each group that reached it:

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Encanador

c0: derrickhand (matched "encuellador", Spanish)
c1: bulk filler (matched "Enfardador", Portuguese)
c2: hardwood floor layer (matched "entarimador", Spanish)
c3: carpet fitter (matched "enmoquetador", Spanish)
c4: assayer (matched "ensayador", Spanish)
none: None of these: a different occupation
```

```
An occupation written in American English by a worker in the United States (us-tx):
Instructor

c0: air force officer (matched "instructor", Spanish)
c1: higher education lecturer (matched "Educational Instructor", American English)
c2: zoo educator (matched "education instructor", English)
c3: business lecturer (matched "Management Instructor", American English)
c4: special educational needs assistant (matched "Assistant Instructor", American English)
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Professora

c0: higher education lecturer (matched "Professora universitária", Portuguese)
c1: assistant lecturer (matched "Professora assistente", Portuguese)
c2: vocational teacher (matched "Professora do ensino profissional", Portuguese)
c3: classical languages lecturer (matched "Professora de Grego", Portuguese)
c4: philosophy lecturer (matched "Professora de Filosofia", Portuguese)
none: None of these: a different occupation
```
