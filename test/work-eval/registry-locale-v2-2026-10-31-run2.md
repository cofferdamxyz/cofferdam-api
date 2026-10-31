# Regional words and false friends on the v2 replica, 2026-10-31

39 synthetic strings (`test/fixtures/work/locale-cases.json`), each with the market of the worker who wrote it, snapped against the v2 generation's registry, the one the plane runs (`test/work-eval/replica.ts`: the ESCO import's and the US layer's SQL, 16978 tokens and 230108 labels, no certificate token; 229654 v2 vectors of EmbeddingGemma 2's LiteRT-LM file at 768, a national label's region kept), each string embedded as the phone embeds it (`litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm` through LiteRT-LM on the Mac, a query and a document), with `@cf/cloudflare/clef-flash` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` over the Workers AI REST API from the Mac. τ_auto 0.96, τ_low 0.81. Three arms on the same registry and vectors: **before**, the hosted requests as they were before the locale (cofferdam-api 16ab6a8: Clef told the language's code, no language beside a matched label, the pivot given the bare string); **language**, production's requests with no market; **market**, production's with the listing's market. The English pivot in the band is off, as on the plane today. Right: one of the expected tokens, or, where no token fits, none or a new one; a false friend is the token ESCO's Spanish or Portuguese gives the word, or the one a generic English name holds as a label (workspace OD-28).

| Group | Before | Language | Market (production) |
|---|---|---|---|
| regional | 14 of 27 right, 0 false friend, 13 other | 19 of 27 right, 0 false friend, 8 other | 17 of 27 right, 0 false friend, 10 other |
| false friend | 2 of 5 right, 1 false friend, 2 other | 4 of 5 right, 0 false friend, 1 other | 2 of 5 right, 0 false friend, 3 other |
| generic name | 1 of 4 right, 1 false friend, 2 other | 1 of 4 right, 2 false friend, 1 other | 1 of 4 right, 3 false friend, 0 other |
| label | 1 of 3 right, 2 false friend, 0 other | 1 of 3 right, 2 false friend, 0 other | 1 of 3 right, 2 false friend, 0 other |
| all | 18 of 39 | 25 of 39 | 21 of 39 |

Cost per snap 0.000050 USD (the embeddings are the Mac's). 0 snaps ran again after a hosted call threw; none still failed.

Clef's band answers, read again at other floors (the shipped floor is 0.5), per arm:

**before**, 33 answers:

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 10 | 10 | 10 | 3 |
| 0.4 | 10 | 9 | 8 | 6 |
| 0.5 | 7 | 5 | 6 | 15 |
| 0.6 | 7 | 2 | 4 | 20 |
| 0.7 | 6 | 1 | 2 | 24 |
| 0.8 | 3 | 0 | 0 | 30 |

**language**, 33 answers:

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 10 | 14 | 8 | 1 |
| 0.4 | 9 | 6 | 6 | 12 |
| 0.5 | 7 | 3 | 5 | 18 |
| 0.6 | 5 | 2 | 3 | 23 |
| 0.7 | 3 | 0 | 2 | 28 |
| 0.8 | 1 | 0 | 2 | 30 |

**market**, 33 answers:

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 10 | 11 | 10 | 2 |
| 0.4 | 10 | 10 | 9 | 4 |
| 0.5 | 9 | 4 | 9 | 11 |
| 0.6 | 8 | 3 | 8 | 14 |
| 0.7 | 4 | 0 | 7 | 22 |
| 0.8 | 3 | 0 | 4 | 26 |

| Group | String | Language, market | Expected | Before | Language | Market (production) |
|---|---|---|---|---|---|---|
| regional | Encanador | pt, br-sp | pos:plumber | pivot pos:plumber; Clef pos:hardwood-floor-layer 0.48, none 0.19; pivot "plumber" | pivot pos:plumber; Clef pos:carpet-fitter 0.33, none 0.28; pivot "plumber" | pivot pos:plumber; Clef none 0.53, none 0.53; pivot "plumber" |
| regional | Bombeiro hidráulico | pt, br-rj | pos:plumber | **pivot pos:firefighter**; Clef pos:firefighter 0.25, none 0.22; pivot "firefighter" | pivot pos:plumber; Clef pos:firefighter 0.31, none 0.20; pivot "plumber" | **chosen pos:firefighter**; Clef pos:firefighter 0.57, none 0.10 |
| regional | Terceiro Oficial de Máquinas | pt, br-rj | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | **chosen pos:marine-mechanic**; Clef pos:marine-mechanic 0.71, none 0.05 | pivot pos:marine-engineer; Clef pos:marine-chief-engineer 0.34, none 0.14; pivot "marine engineer" | pivot pos:marine-engineer; Clef pos:marine-mechanic 0.42, none 0.09; pivot "marine engineer" |
| regional | Garçom | pt, br-sp | pos:waiter-waitress | pivot pos:waiter-waitress; pivot "waiter" | pivot pos:waiter-waitress; pivot "waiter" | pivot pos:waiter-waitress; pivot "waiter" |
| regional | Caminhoneiro | pt, br-pr | pos:cargo-vehicle-driver | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.80, none 0.04 | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.50, none 0.05 | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.68, none 0.05 |
| regional | Operador de empilhadeira | pt, br-sp | pos:forklift-operator | chosen pos:forklift-operator; Clef pos:forklift-operator 0.80, none 0.04 | chosen pos:forklift-operator; Clef pos:forklift-operator 0.78, none 0.05 | chosen pos:forklift-operator; Clef pos:forklift-operator 0.82, none 0.04 |
| regional | Frentista | pt, br-mg | pos:fuel-station-specialised-seller | **minted pos:gas-station-attendant**; Clef none 0.53, none 0.53; pivot "gas station attendant" | **unmatched —**; Clef pos:production-plant-crane-operator 0.36, none 0.34; pivot "gas station attendant" | **minted pos:gas-station-attendant**; Clef none 0.74, none 0.74; pivot "gas station attendant" |
| regional | Motorista de ônibus | pt, br-sp | pos:bus-driver | chosen pos:bus-driver; Clef pos:bus-driver 0.86, none 0.02 | chosen pos:bus-driver; Clef pos:bus-driver 0.62, none 0.08 | chosen pos:bus-driver; Clef pos:bus-driver 0.82, none 0.02 |
| regional | Auxiliar de cozinha | pt, br-sp | pos:kitchen-assistant, pos:kitchen-porter | pivot pos:kitchen-assistant; Clef pos:kitchen-assistant 0.47, none 0.04; pivot "kitchen assistant" | pivot pos:kitchen-assistant; Clef pos:kitchen-porter 0.49, none 0.06; pivot "kitchen assistant" | pivot pos:kitchen-assistant; Clef pos:kitchen-assistant 0.47, none 0.04; pivot "kitchen assistant" |
| regional | Soldador de Tubulação | pt, br-rj | pos:pipe-welder, pos:welder | chosen pos:pipe-welder; Clef pos:pipe-welder 0.61, none 0.04 | chosen pos:pipe-welder; Clef pos:pipe-welder 0.59, none 0.05 | chosen pos:pipe-welder; Clef pos:pipe-welder 0.59, none 0.05 |
| regional | Plomero | es, mx-nle | pos:plumber | pivot pos:plumber; Clef pos:plumber 0.41, none 0.12; pivot "plumber" | pivot pos:plumber; Clef pos:plumber 0.44, none 0.10; pivot "plumber" | chosen pos:plumber; Clef pos:plumber 0.64, none 0.07 |
| regional | Tercer Ingeniero | es, mx-ver | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | pivot pos:marine-engineer; Clef pos:ship-assistant-engineer 0.50, none 0.14; pivot "marine engineer" | pivot pos:marine-engineer; Clef pos:mechanical-engineer 0.43, none 0.11; pivot "marine engineer" | pivot pos:marine-engineer; Clef pos:mechanical-engineer 0.48, none 0.11; pivot "marine engineer" |
| regional | Mesero | es, mx-cmx | pos:waiter-waitress | pivot pos:waiter-waitress; Clef none 0.48, none 0.48; pivot "waiter" | pivot pos:waiter-waitress; Clef none 0.92, none 0.92; pivot "waiter" | pivot pos:waiter-waitress; Clef none 0.98, none 0.98; pivot "waiter" |
| regional | Camionero | es, mx-nle | pos:cargo-vehicle-driver | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.82, none 0.02 | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.72, none 0.04 | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.72, none 0.04 |
| regional | Montacarguista | es, mx-nle | pos:forklift-operator | **pivot pos:stevedore**; Clef none 0.74, none 0.74; pivot "stevedore" | pivot pos:forklift-operator; Clef none 0.70, none 0.70; pivot "forklift operator" | pivot pos:forklift-operator; Clef none 0.78, none 0.78; pivot "forklift operator" |
| regional | Tablajero | es, mx-cmx | pos:butcher | **pivot pos:cabinet-maker**; Clef none 0.37, none 0.37; pivot "cabinetmaker" | **pivot pos:cabinet-maker**; Clef none 0.35, none 0.35; pivot "cabinetmaker" | **pivot pos:cabinet-maker**; Clef pos:lumber-grader 0.28, none 0.27; pivot "cabinetmaker" |
| regional | Borracheiro | pt, br-sp | pos:tyre-vulcaniser, pos:tyre-fitter | **minted pos:cobbler**; Clef none 0.70, none 0.70; pivot "cobbler" | pivot pos:tyre-fitter; Clef none 0.91, none 0.91; pivot "tyre fitter" | **pivot pos:vehicle-technician**; Clef none 0.91, none 0.91; pivot "tire technician" |
| regional | Vulcanizador | es, mx-nle | pos:tyre-vulcaniser, pos:tyre-fitter | chosen pos:tyre-vulcaniser; Clef pos:tyre-vulcaniser 0.83, none 0.10 | chosen pos:tyre-vulcaniser; Clef pos:tyre-vulcaniser 0.81, none 0.10 | chosen pos:tyre-vulcaniser; Clef pos:tyre-vulcaniser 0.81, none 0.10 |
| regional | Gesseiro | pt, br-sp | pos:plasterer, pos:ceiling-installer | **pivot pos:tile-fitter**; Clef none 0.66, none 0.66; pivot "tiler" | **chosen pos:bricklayer**; Clef pos:bricklayer 0.53, none 0.16 | **chosen pos:bricklayer**; Clef pos:bricklayer 0.68, none 0.10 |
| regional | Babá | pt, br-sp | pos:nanny, pos:babysitter | pivot pos:nanny; pivot "nanny" | pivot pos:nanny; pivot "nanny" | pivot pos:nanny; pivot "nanny" |
| regional | Velador | es, mx-nle | pos:security-guard | **pivot pos:officer-of-the-watch**; Clef none 0.51, none 0.51; pivot "watchman" | pivot pos:security-guard; Clef none 0.48, none 0.48; pivot "security guard" | **pivot pos:officer-of-the-watch**; Clef none 0.72, none 0.72; pivot "watchman" |
| regional | Motoboy | pt, br-sp | pos:motorcycle-delivery-person | **minted pos:courier**; pivot "courier" | **minted pos:courier**; pivot "courier" | **minted pos:messenger**; pivot "messenger" |
| regional | Lavaloza | es, mx-cmx | pos:kitchen-porter | **pivot pos:laundry-worker**; Clef none 0.41, none 0.41; pivot "laundry worker" | **pivot pos:laundry-worker**; Clef pos:kitchen-porter 0.39, none 0.31; pivot "laundry worker" | chosen pos:kitchen-porter; Clef pos:kitchen-porter 0.61, none 0.20 |
| regional | Hojalatero | es, mx-cmx | pos:refurbishing-technician | **pivot pos:roofer**; Clef pos:jeweller 0.47, none 0.32; pivot "tinsmith" | **pivot pos:sheet-metal-worker**; Clef none 0.56, none 0.56; pivot "sheet metal worker" | **pivot pos:sheet-metal-worker**; Clef none 0.81, none 0.81; pivot "sheet metal worker" |
| regional | Bodeguero | es, mx-nle | pos:warehouse-worker, pos:warehouse-order-picker | **chosen pos:vineyard-cellar-master**; Clef pos:vineyard-cellar-master 0.62, none 0.21 | **chosen pos:vineyard-cellar-master**; Clef pos:vineyard-cellar-master 0.68, none 0.16 | **chosen pos:vineyard-cellar-master**; Clef pos:vineyard-cellar-master 0.64, none 0.24 |
| regional | Faxineira | pt, br-rj | pos:domestic-cleaner, pos:building-cleaner, pos:domestic-housekeeper | pivot pos:domestic-cleaner; Clef none 0.64, none 0.64; pivot "cleaner" | pivot pos:domestic-cleaner; Clef none 0.56, none 0.56; pivot "cleaner" | pivot pos:domestic-cleaner; Clef none 0.90, none 0.90; pivot "cleaner" |
| regional | Afanadora | es, mx-cmx | pos:building-cleaner, pos:domestic-cleaner | **chosen pos:tool-grinder**; Clef pos:tool-grinder 0.56, none 0.16 | **unmatched —**; Clef pos:tool-grinder 0.50, none 0.22; pivot "threshing machine operator" | **unmatched —**; Clef pos:tool-grinder 0.50, none 0.28; pivot "threshing machine operator" |
| false friend | Instructor | en, us-tx | none | **pivot pos:politics-lecturer**; Clef pos:higher-education-lecturer 0.40, none 0.15; pivot "teacher" | **pivot pos:politics-lecturer**; Clef pos:higher-education-lecturer 0.29, none 0.22; pivot "teacher" | **pivot pos:politics-lecturer**; Clef pos:higher-education-lecturer 0.45, none 0.09; pivot "teacher" |
| false friend | Coach | en, us-tx | pos:sports-coach, none | unmatched —; Clef pos:bus-driver 0.43, none 0.11; pivot "coach" | unmatched —; Clef pos:carriage-driver 0.39, none 0.08; pivot "coach" | unmatched —; Clef pos:bus-driver 0.41, none 0.09; pivot "coach" |
| false friend | Valet | en, us-fl | pos:parking-valet, none | **pivot pos:civil-enforcement-officer**; Clef pos:room-attendant 0.30, none 0.13; pivot "parking attendant" | unmatched —; Clef pos:private-chauffeur 0.33, none 0.19; pivot "valet" | **pivot pos:civil-enforcement-officer**; Clef pos:hotel-porter 0.39, none 0.11; pivot "parking attendant" |
| false friend | Compositor | en, us-ca | pos:typesetter, pos:digital-artist, none | **pivot pos:composer**; Clef pos:desktop-publisher 0.33, none 0.22; pivot "composer" | pivot pos:typesetter; Clef pos:imagesetter 0.34, none 0.21; pivot "typesetter" | **chosen pos:desktop-publisher**; Clef pos:desktop-publisher 0.63, none 0.15 |
| false friend | Instrutor | pt, br-sp | none | unmatched —; Clef pos:armed-forces-training-and-education-officer 0.29, none 0.26; pivot "instructor" | unmatched —; Clef pos:ski-instructor 0.35, none 0.19; pivot "instructor" | unmatched —; Clef pos:armed-forces-training-and-education-officer 0.29, none 0.27; pivot "instructor" |
| generic name | Professora | pt, br-sp | pos:primary-school-teacher, pos:secondary-school-teacher, pos:early-years-teacher, none | **chosen pos:higher-education-lecturer**; Clef pos:higher-education-lecturer 0.56, none 0.14 | **pivot pos:politics-lecturer**; Clef none 0.34, none 0.34; pivot "teacher" | **pivot pos:politics-lecturer**; Clef none 0.31, none 0.31; pivot "teacher" |
| generic name | Maestra | es, mx-cmx | pos:primary-school-teacher, pos:secondary-school-teacher, pos:early-years-teacher, none | **pivot pos:politics-lecturer**; Clef none 0.33, none 0.33; pivot "teacher" | **pivot pos:politics-lecturer**; Clef pos:house-builder 0.49, none 0.11; pivot "teacher" | **pivot pos:politics-lecturer**; Clef none 0.68, none 0.68; pivot "teacher" |
| generic name | Torneiro mecânico | pt, br-sp | pos:fitter-and-turner, pos:lathe-and-turning-machine-operator, pos:metalworking-lathe-operator | chosen pos:fitter-and-turner; Clef pos:fitter-and-turner 0.71, none 0.04 | chosen pos:fitter-and-turner; Clef pos:fitter-and-turner 0.65, none 0.06 | chosen pos:fitter-and-turner; Clef pos:fitter-and-turner 0.63, none 0.07 |
| generic name | Supervisora | pt, br-sp | none | **chosen pos:construction-general-supervisor**; Clef pos:construction-general-supervisor 0.56, none 0.12 | **chosen pos:construction-general-supervisor**; Clef pos:construction-general-supervisor 0.63, none 0.10 | **pivot pos:oil-refinery-control-room-operator**; Clef pos:construction-general-supervisor 0.43, none 0.18; pivot "supervisor" |
| label | Instructor | es, mx-cmx | none | **label pos:air-force-officer** | **label pos:air-force-officer** | **label pos:air-force-officer** |
| label | Valet | es, mx-cmx | pos:parking-valet, none | **label pos:room-attendant** | **label pos:room-attendant** | **label pos:room-attendant** |
| label | Coach | pt, br-sp | pos:life-coach, pos:sports-coach | label pos:life-coach | label pos:life-coach | label pos:life-coach |

The nearest candidates (token, matched label, its language and a national label's region, cosine), the same in every arm:

| String | Candidates |
|---|---|
| Encanador (pt) | pos:bulk-filler "Enfardador" pt 0.858; pos:derrickhand "encuellador" es 0.852; pos:assayer "ensayador" es 0.840; pos:carpet-fitter "enmoquetador" es 0.839; pos:hardwood-floor-layer "entarimador" es 0.838 |
| Bombeiro hidráulico (pt) | pos:water-engineer "Engenheiro hidráulico" pt 0.844; pos:fluid-power-engineer "Engenheiro hidráulico" pt 0.844; pos:firefighter "Bombeiro" pt 0.840; pos:industrial-firefighter "Bombeira industrial" pt 0.822; pos:fluid-power-technician "Técnica de potência hidráulica" pt 0.822 |
| Terceiro Oficial de Máquinas (pt) | pos:marine-mechanic "oficial de máquinas" es 0.884; pos:deck-officer "primer oficial de máquinas" es 0.867; pos:marine-chief-engineer "Chefe de máquinas" pt 0.835; pos:rail-operations-manager "Maquinista" pt 0.823; pos:second-officer "Segundo oficial" pt 0.822 |
| Garçom (pt) | pos:gauger "gager" en 0.734; pos:hotel-butler "Mordomo" pt 0.728; pos:bartender "camarera" es 0.726; pos:car-and-van-delivery-driver "deliveryman" en 0.725; pos:fuel-station-specialised-seller "gasolinero" es 0.723 |
| Caminhoneiro (pt) | pos:tow-truck-driver "camionero de remolque" es 0.868; pos:cargo-vehicle-driver "trucker" en 0.855; pos:moving-truck-driver "Motorista de camiões de mudanças" pt 0.851; pos:coachbuilder "Carroçador" pt 0.849; pos:room-attendant "Camareiro" pt 0.844 |
| Operador de empilhadeira (pt) | pos:forklift-operator "Operador de empilhadores" pt 0.918; pos:excavator-operator "Operador de escavadora" pt 0.885; pos:warehouse-order-picker "Operador de armazém" pt 0.883; pos:high-rigger "operador de montacargas" es 0.870; pos:miller "Operador de moinho" pt 0.866 |
| Frentista (pt) | pos:pawnbroker "prestamista" es 0.823; pos:foreign-exchange-broker "cambista" es 0.818; pos:grill-cook "planchista" es 0.817; pos:circus-artist "Malabarista" pt 0.816; pos:production-plant-crane-operator "gruista" es 0.816 |
| Motorista de ônibus (pt) | pos:bus-driver "bus driver" en 0.897; pos:trolley-bus-driver "bus operator" en 0.866; pos:bus-driving-instructor "bus driver instructor" en 0.853 |
| Auxiliar de cozinha (pt) | pos:kitchen-assistant "Assistente de cozinha" pt 0.943; pos:kitchen-porter "Ajudante de cozinha" pt 0.922; pos:restaurant-manager "Gestor de cozinha" pt 0.877; pos:cook "Cozinheira" pt 0.873; pos:industrial-cook "Cozinheira industrial" pt 0.862 |
| Soldador de Tubulação (pt) | pos:pipe-welder "Soldador de tubos" pt 0.890; pos:drain-technician "Técnico de tubagem" pt 0.861; pos:welding-engineer "Engenheiro de soldadura" pt 0.853; pos:welding-inspector "Inspetor de soldadura" pt 0.839; pos:welder "soldador" es 0.832 |
| Plomero (es) | pos:plumber "fontanero" es 0.848; pos:pipe-welder "montador de tuberías" es 0.844; pos:bricklayer "albañil" es 0.834; pos:cabinet-maker "Marceneiro" pt 0.831; pos:carpenter "Marceneiro" pt 0.831 |
| Tercer Ingeniero (es) | pos:ship-assistant-engineer "third assistant engineer" en 0.857; pos:offshore-renewable-energy-engineer "ingeniera ORE" es 0.845; pos:mechanical-engineer "ingeniero mecánico/ingeniera mecánica" es 0.843; pos:military-engineer "ingeniera politécnica del Ejército de Tierra" es 0.841; pos:maintenance-and-repair-engineer "ingeniera de equipos" es 0.840 |
| Mesero (es) | pos:foundry-moulder "machero" es 0.849; pos:mouldmaker "machero" es 0.849; pos:moulding-machine-operator "machero" es 0.849; pos:coquille-casting-worker "machero" es 0.849; pos:basketmaker "cestero" es 0.832 |
| Camionero (es) | pos:tow-truck-driver "camionero de remolque" es 0.908; pos:cargo-vehicle-driver "truck driver" en 0.874; pos:moving-truck-driver "Motorista de camiões de mudanças" pt 0.867; pos:vehicle-technician "mecánico de camiones" es 0.849; pos:truck-driving-instructor "instructor de autoescuela para camiones" es 0.838 |
| Montacarguista (es) | pos:coachbuilder "Carroçador" pt 0.853; pos:tent-installer "montadora de carpas" es 0.841; pos:marine-fitter "montador naval" pt 0.839; pos:bicycle-assembler "montadora de tándems" es 0.835; pos:rolling-stock-assembler "montador de ferrocarriles" es 0.819 |
| Tablajero (es) | pos:woodcarver "tallador" es 0.848; pos:snowboard-instructor "monitora de tablanieve" es 0.835; pos:lumber-grader "clasificador de tablones de madera" es 0.827; pos:waiter-waitress "Técnica de mesa" pt 0.826; pos:sign-maker "Fabricante de tabuletas e sinalética" pt 0.823 |
| Borracheiro (pt) | pos:shoe-and-leather-accessories-shop-manager "Correeiro" pt 0.852; pos:chain-making-machine-operator "Barbeleira" pt 0.842; pos:locksmith "Serralheira" pt 0.841; pos:structural-ironwork-supervisor "Serralheira" pt 0.841; pos:door-supervisor "Porteiro" pt 0.833 |
| Vulcanizador (es) | pos:tyre-vulcaniser "Vulcanizador de pneus" pt 0.835; pos:electroplating-machine-operator "Metalizer" en-us 0.816; pos:surveying-technician "aparejador" es 0.814; pos:quantity-surveyor "aparejador" es 0.814; pos:wood-caulker "calafateador" es 0.813 |
| Gesseiro (pt) | pos:basketmaker "Cesteiro" pt 0.852; pos:cider-master "sidrero" es 0.816; pos:shoe-and-leather-accessories-shop-manager "Correeiro" pt 0.813; pos:coachbuilder "carrocero" es 0.811; pos:bricklayer "Calceteiro" pt 0.806 |
| Babá (pt) | pos:nanny "nanny" en 0.802; pos:barber "barbera" es 0.780; pos:circus-artist "Mágico" pt 0.779; pos:babysitter "babysitter" en 0.775; pos:monk-nun "Monge" pt 0.775 |
| Velador (es) | pos:handyperson "zelador" pt 0.866; pos:pawnbroker "fiador" es 0.851; pos:farrier "Ferrador" pt 0.848; pos:terrazzo-setter "solador" es 0.844; pos:vineyard-worker "vendimiador" es 0.837 |
| Motoboy (pt) | pos:professional-athlete "motorcycle driver" en 0.797; pos:motorcycle-delivery-person "motorcycle driver of deliveries" en 0.795; pos:police-officer "Motorcycle Police" en-us 0.790; pos:vehicle-technician "técnico de motas" pt 0.790; pos:motorcycle-instructor "Instrutor de condução de motociclos" pt 0.779 |
| Lavaloza (es) | pos:kitchen-porter "lavaplatos" es 0.813; pos:handyperson "zelador/zeladora" pt 0.789; pos:linen-room-attendant "lencero" es 0.787; pos:military-engineer "zapadora" es 0.781; pos:roofer "Latoeira" pt 0.780 |
| Hojalatero (es) | pos:jeweller "Joalheiro/Joalheira" pt 0.836; pos:crop-production-worker "jornalero" es 0.833; pos:forest-worker "jornalero" es 0.833; pos:yarn-spinner "hilandero" es 0.832; pos:shoemaker "zapatera" es 0.830 |
| Bodeguero (es) | pos:vineyard-cellar-master "bodeguero vinícola" es 0.891; pos:woodturner "bodger" en 0.851; pos:room-attendant "Camareiro" pt 0.821; pos:pastry-chef "Padeiro" pt 0.814; pos:baker "Padeiro" pt 0.814 |
| Faxineira (pt) | pos:coppersmith "Funileira" pt 0.843; pos:knitter "Fazedora de renda" pt 0.819; pos:circus-artist "Faquir" pt 0.816; pos:miller "Moleiro/Moleira" pt 0.816; pos:landscape-gardener "Jardineira" pt 0.810 |
| Afanadora (es) | pos:tool-grinder "afiladora" es 0.859; pos:fortune-teller "Advinhadora" pt 0.836; pos:infantry-soldier "Atiradora" pt 0.832; pos:military-engineer "zapadora" es 0.829; pos:farrier "Ferradora" pt 0.828 |
| Instructor (en) | pos:air-force-officer "instructor" es 0.960; pos:higher-education-lecturer "Educational Instructor" en-us 0.930; pos:zoo-educator "education instructor" en 0.926; pos:secondary-school-teacher "English Instructor" en-us 0.907; pos:business-lecturer "Management Instructor" en-us 0.907 |
| Coach (en) | pos:life-coach "Coach" pt 0.964; pos:carriage-driver "coachman" en 0.916; pos:sports-coach "coach in sports" en 0.901; pos:business-coach "Coach profissional" pt 0.898; pos:bus-driver "coach driver" en 0.897 |
| Valet (en) | pos:parking-valet "Valet Driver" en-us 0.903; pos:room-attendant "valet" es 0.896; pos:private-chauffeur "private valet" en 0.854; pos:vehicle-cleaner "van valeter" en 0.835; pos:hotel-porter "bellboy" en 0.830 |
| Compositor (en) | pos:composer "Compositor" pt 0.973; pos:desktop-publisher "Computer Compositor" en-us 0.930; pos:digital-artist "Compositor digital" pt 0.861; pos:extra "comparsa" es 0.846; pos:imagesetter "compositor de imágenes" es 0.838 |
| Instrutor (pt) | pos:air-force-officer "instructora" es 0.921; pos:armed-forces-training-and-education-officer "Instrutor militar" pt 0.904; pos:ski-instructor "Instrutor  de equi" pt 0.899; pos:guide-dog-instructor "Instrutor de cães-guias" pt 0.892; pos:assayer "Ensaiador" pt 0.886 |
| Professora (pt) | pos:higher-education-lecturer "Professora universitária" pt 0.905; pos:assistant-lecturer "Professora assistente" pt 0.891; pos:vocational-teacher "Professora do ensino profissional" pt 0.881; pos:philosophy-lecturer "Professora de Filosofia" pt 0.878; pos:classical-languages-lecturer "Professora de Grego" pt 0.873 |
| Maestra (es) | pos:malt-master "maestro maltero/maestra maltera" es 0.879; pos:cider-master "maestro sidrero/maestra sidrera" es 0.874; pos:musical-conductor "maestro/maestrina" pt 0.867; pos:soap-maker "maestra jabonera" es 0.866; pos:house-builder "maestra albañil" es 0.866 |
| Torneiro mecânico (pt) | pos:fitter-and-turner "Torneiro" pt 0.885; pos:laundry-ironer "Engomador mecânico" pt 0.871; pos:woodturner "Torneiro de madeiras" pt 0.870; pos:industrial-machinery-mechanic "Mecânico industrial" pt 0.845; pos:roadside-vehicle-technician "Mecânico de intervenção" pt 0.843 |
| Supervisora (pt) | pos:oil-refinery-control-room-operator "supervisor" en 0.897; pos:script-supervisor "Supervisora de guião" pt 0.885; pos:chemical-processing-supervisor "Supervisora de laboratório" pt 0.881; pos:landfill-supervisor "Supervisora de aterros" pt 0.877; pos:construction-general-supervisor "Supervisora de construção" pt 0.873 |
| Instructor (es) | — |
| Valet (es) | — |
| Coach (pt) | — |

What Clef was told in production's arm (the state and the `match` criteria), for the first string of each group that reached it:

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Encanador

c0: bulk filler (matched "Enfardador", Portuguese)
c1: derrickhand (matched "encuellador", Spanish)
c2: assayer (matched "ensayador", Spanish)
c3: carpet fitter (matched "enmoquetador", Spanish)
c4: hardwood floor layer (matched "entarimador", Spanish)
none: None of these: a different occupation
```

```
An occupation written in American English by a worker in the United States (us-tx):
Instructor

c0: air force officer (matched "instructor", Spanish)
c1: higher education lecturer (matched "Educational Instructor", American English)
c2: zoo educator (matched "education instructor", English)
c3: secondary school teacher (matched "English Instructor", American English)
c4: business lecturer (matched "Management Instructor", American English)
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Professora

c0: higher education lecturer (matched "Professora universitária", Portuguese)
c1: assistant lecturer (matched "Professora assistente", Portuguese)
c2: vocational teacher (matched "Professora do ensino profissional", Portuguese)
c3: philosophy lecturer (matched "Professora de Filosofia", Portuguese)
c4: classical languages lecturer (matched "Professora de Grego", Portuguese)
none: None of these: a different occupation
```
