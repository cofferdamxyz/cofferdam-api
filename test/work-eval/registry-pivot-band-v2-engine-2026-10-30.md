# The English pivot in the band on the v2 engine, 2026-10-30

39 synthetic strings (`test/fixtures/work/locale-cases.json`), each with the market of the worker who wrote it, snapped on the v2 engine: the registry replica (`test/work-eval/replica.ts`: the ESCO import's and the US layer's SQL, 16978 tokens and 230108 labels, no certificate token; 229654 vectors of EmbeddingGemma 2 at 768, a national label's region kept), each string embedded with the same GGUF (`gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0` through llama-embedding, a query and a document; the v2 generation's LiteRT-LM vectors match these at a median cosine of 0.990), with `@cf/cloudflare/clef-flash` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` over the Workers AI REST API from the Mac. τ_auto 0.96, τ_low 0.81. Two arms on the same registry and vectors: **market**, production's requests with the listing's market, the pivot asked only below the band or after Clef's none, as today; **pivot**, the same with the English pivot in the band (workspace decision 0018, amendment proposed 2026-10-30): a worker's Portuguese or Spanish string asks the pivot beside the snap's search, and Clef is shown the token its English name names. Right: one of the expected tokens, or, where no token fits, none or a new one; a false friend is the token ESCO's Spanish or Portuguese gives the word, or the one a generic English name holds as a label (workspace OD-28).

| Group | Market (production) | With the pivot in the band |
|---|---|---|
| regional | 17 of 27 right, 0 false friend or generic name, 10 other | 18 of 27 right, 0 false friend or generic name, 9 other |
| false friend | 2 of 5 right, 0 false friend or generic name, 3 other | 2 of 5 right, 0 false friend or generic name, 3 other |
| generic name | 1 of 4 right, 3 false friend or generic name, 0 other | 2 of 4 right, 2 false friend or generic name, 0 other |
| label | 1 of 3 right, 2 false friend or generic name, 0 other | 1 of 3 right, 2 false friend or generic name, 0 other |
| all | 21 of 39 | 23 of 39 |

**Market (production):** cost per snap 0.000046 USD, median 855 ms a snap (the phone's vectors were embedded before, and the replica searches its vectors in process, so this is no production latency); calls: work-embed 0.00 a snap, work-pivot 0.51 a snap (median 588 ms answered), work-adjudicate 0.87 a snap (median 484 ms answered); 0 pivot calls a τ_auto take left unread (cancelled while running, or metered as answered).

**With the pivot in the band:** cost per snap 0.000070 USD, median 1119 ms a snap (the phone's vectors were embedded before, and the replica searches its vectors in process, so this is no production latency); calls: work-embed 0.00 a snap, work-pivot 0.87 a snap (median 696 ms answered), work-adjudicate 0.87 a snap (median 473 ms answered); 0 pivot calls a τ_auto take left unread (cancelled while running, or metered as answered).

In the band, the English name named a token for 27 strings: shown after the nearest five 16 times, already among them 11 times. Clef chose that token 16 times, chose another 1 times and refused it with its none 1 times; 9 times Clef answered under its floor and step 3 took it.

0 snaps ran again after a hosted call threw; none still failed.

Clef's band answers, read again at other floors (the shipped floor is 0.5), per arm:

**market**, 34 answers:

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 12 | 9 | 11 | 2 |
| 0.4 | 12 | 6 | 7 | 9 |
| 0.5 | 10 | 6 | 7 | 11 |
| 0.6 | 8 | 4 | 7 | 15 |
| 0.7 | 4 | 0 | 5 | 25 |
| 0.8 | 2 | 0 | 5 | 27 |

**pivot**, 34 answers:

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 17 | 11 | 3 | 3 |
| 0.4 | 17 | 9 | 1 | 7 |
| 0.5 | 15 | 6 | 1 | 12 |
| 0.6 | 13 | 6 | 1 | 14 |
| 0.7 | 8 | 2 | 1 | 23 |
| 0.8 | 6 | 1 | 0 | 27 |

| Group | String | Language, market | Expected | Market (production) | With the pivot in the band |
|---|---|---|---|---|---|
| regional | Encanador | pt, br-sp | pos:plumber | pivot pos:plumber; Clef none 0.61, none 0.61; pivot "plumber → pos:plumber" | chosen pos:plumber; Clef pos:plumber 0.82, none 0.06; pivot "plumber → pos:plumber (in the band)" |
| regional | Bombeiro hidráulico | pt, br-rj | pos:plumber | **chosen pos:firefighter**; Clef pos:firefighter 0.61, none 0.10 | pivot pos:plumber; Clef pos:firefighter 0.43, none 0.08; pivot "plumber → pos:plumber (in the band)" |
| regional | Terceiro Oficial de Máquinas | pt, br-rj | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | chosen pos:marine-engineer; Clef pos:marine-engineer 0.69, none 0.05 | chosen pos:marine-engineer; Clef pos:marine-engineer 0.69, none 0.05; pivot "marine engineer → pos:marine-engineer" |
| regional | Garçom | pt, br-sp | pos:waiter-waitress | pivot pos:waiter-waitress; Clef none 0.36, none 0.36; pivot "waiter → pos:waiter-waitress" | chosen pos:waiter-waitress; Clef pos:waiter-waitress 0.92, none 0.02; pivot "waiter → pos:waiter-waitress (in the band)" |
| regional | Caminhoneiro | pt, br-pr | pos:cargo-vehicle-driver | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.77, none 0.03 | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.77, none 0.03; pivot "truck driver → pos:cargo-vehicle-driver" |
| regional | Operador de empilhadeira | pt, br-sp | pos:forklift-operator | chosen pos:forklift-operator; Clef pos:forklift-operator 0.81, none 0.04 | chosen pos:forklift-operator; Clef pos:forklift-operator 0.81, none 0.04; pivot "forklift operator → pos:forklift-operator" |
| regional | Frentista | pt, br-mg | pos:fuel-station-specialised-seller | **minted pos:gas-station-attendant**; pivot "gas station attendant → no token" | **minted pos:gas-station-attendant**; pivot "gas station attendant → no token" |
| regional | Motorista de ônibus | pt, br-sp | pos:bus-driver | chosen pos:bus-driver; Clef pos:bus-driver 0.93, none 0.07 | chosen pos:bus-driver; Clef pos:bus-driver 0.93, none 0.07; pivot "bus driver → pos:bus-driver" |
| regional | Auxiliar de cozinha | pt, br-sp | pos:kitchen-assistant, pos:kitchen-porter | pivot pos:kitchen-assistant; Clef pos:kitchen-assistant 0.47, none 0.04; pivot "kitchen assistant → pos:kitchen-assistant" | pivot pos:kitchen-assistant; Clef pos:kitchen-assistant 0.47, none 0.04; pivot "kitchen assistant → pos:kitchen-assistant" |
| regional | Soldador de Tubulação | pt, br-rj | pos:pipe-welder, pos:welder | chosen pos:pipe-welder; Clef pos:pipe-welder 0.66, none 0.06 | chosen pos:pipe-welder; Clef pos:pipe-welder 0.66, none 0.06; pivot "pipe welder → pos:pipe-welder" |
| regional | Plomero | es, mx-nle | pos:plumber | chosen pos:plumber; Clef pos:plumber 0.55, none 0.06 | chosen pos:plumber; Clef pos:plumber 0.55, none 0.06; pivot "plumber → pos:plumber" |
| regional | Tercer Ingeniero | es, mx-ver | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | pivot pos:marine-engineer; Clef pos:mechanical-engineer 0.29, none 0.20; pivot "marine engineer → pos:marine-engineer" | pivot pos:marine-engineer; Clef pos:mechanical-engineer 0.30, none 0.14; pivot "marine engineer → pos:marine-engineer (in the band)" |
| regional | Mesero | es, mx-cmx | pos:waiter-waitress | chosen pos:waiter-waitress; Clef pos:waiter-waitress 0.70, none 0.04 | chosen pos:waiter-waitress; Clef pos:waiter-waitress 0.70, none 0.04; pivot "waiter → pos:waiter-waitress" |
| regional | Camionero | es, mx-nle | pos:cargo-vehicle-driver | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.72, none 0.03 | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.72, none 0.03; pivot "truck driver → pos:cargo-vehicle-driver" |
| regional | Montacarguista | es, mx-nle | pos:forklift-operator | pivot pos:forklift-operator; Clef none 0.87, none 0.87; pivot "forklift operator → pos:forklift-operator" | chosen pos:forklift-operator; Clef pos:forklift-operator 0.88, none 0.06; pivot "forklift operator → pos:forklift-operator (in the band)" |
| regional | Tablajero | es, mx-cmx | pos:butcher | **chosen pos:roofer**; Clef pos:roofer 0.50, none 0.15 | **pivot pos:cabinet-maker**; Clef pos:roofer 0.48, none 0.13; pivot "cabinetmaker → pos:cabinet-maker (in the band)" |
| regional | Borracheiro | pt, br-sp | pos:tyre-vulcaniser, pos:tyre-fitter | **pivot pos:vehicle-technician**; Clef none 0.85, none 0.85; pivot "tire technician → pos:vehicle-technician" | **chosen pos:vehicle-technician**; Clef pos:vehicle-technician 0.62, none 0.27; pivot "tire technician → pos:vehicle-technician (in the band)" |
| regional | Vulcanizador | es, mx-nle | pos:tyre-vulcaniser, pos:tyre-fitter | chosen pos:tyre-vulcaniser; Clef pos:tyre-vulcaniser 0.59, none 0.13 | chosen pos:tyre-vulcaniser; Clef pos:tyre-vulcaniser 0.59, none 0.13; pivot "vulcanizer → no token" |
| regional | Gesseiro | pt, br-sp | pos:plasterer, pos:ceiling-installer | pivot pos:plasterer; Clef none 0.34, none 0.34; pivot "plasterer → pos:plasterer" | chosen pos:plasterer; Clef pos:plasterer 0.70, none 0.08; pivot "plasterer → pos:plasterer (in the band)" |
| regional | Babá | pt, br-sp | pos:nanny, pos:babysitter | pivot pos:nanny; Clef pos:nanny 0.49, none 0.05; pivot "nanny → pos:nanny" | pivot pos:nanny; Clef pos:nanny 0.49, none 0.05; pivot "nanny → pos:nanny" |
| regional | Velador | es, mx-nle | pos:security-guard | **pivot pos:officer-of-the-watch**; Clef none 0.63, none 0.63; pivot "watchman → pos:officer-of-the-watch" | **chosen pos:officer-of-the-watch**; Clef pos:officer-of-the-watch 0.76, none 0.10; pivot "watchman → pos:officer-of-the-watch (in the band)" |
| regional | Motoboy | pt, br-sp | pos:motorcycle-delivery-person | **minted pos:courier**; pivot "courier → no token" | **minted pos:messenger**; pivot "messenger → no token" |
| regional | Lavaloza | es, mx-cmx | pos:kitchen-porter | **pivot pos:laundry-worker**; Clef pos:laundry-worker 0.38, none 0.11; pivot "laundry worker → pos:laundry-worker" | **pivot pos:vehicle-cleaner**; Clef pos:laundry-worker 0.35, none 0.08; pivot "car washer → pos:vehicle-cleaner (in the band)" |
| regional | Hojalatero | es, mx-cmx | pos:refurbishing-technician | **pivot pos:sheet-metal-worker**; Clef none 0.88, none 0.88; pivot "sheet metal worker → pos:sheet-metal-worker" | **chosen pos:sheet-metal-worker**; Clef pos:sheet-metal-worker 0.93, none 0.02; pivot "sheet metal worker → pos:sheet-metal-worker (in the band)" |
| regional | Bodeguero | es, mx-nle | pos:warehouse-worker, pos:warehouse-order-picker | **chosen pos:vineyard-cellar-master**; Clef pos:vineyard-cellar-master 0.61, none 0.22 | **chosen pos:vineyard-cellar-master**; Clef pos:vineyard-cellar-master 0.61, none 0.22; pivot "storekeeper → no token" |
| regional | Faxineira | pt, br-rj | pos:domestic-cleaner, pos:building-cleaner, pos:domestic-housekeeper | pivot pos:domestic-cleaner; Clef none 0.94, none 0.94; pivot "cleaner → pos:domestic-cleaner" | chosen pos:domestic-cleaner; Clef pos:domestic-cleaner 0.89, none 0.05; pivot "cleaner → pos:domestic-cleaner (in the band)" |
| regional | Afanadora | es, mx-cmx | pos:building-cleaner, pos:domestic-cleaner | **chosen pos:tool-grinder**; Clef pos:tool-grinder 0.53, none 0.26 | **pivot pos:chimney-sweep**; Clef pos:tool-grinder 0.49, none 0.26; pivot "sweeper → pos:chimney-sweep (in the band)" |
| false friend | Instructor | en, us-tx | none | **chosen pos:higher-education-lecturer**; Clef pos:higher-education-lecturer 0.66, none 0.05 | **chosen pos:higher-education-lecturer**; Clef pos:higher-education-lecturer 0.66, none 0.05 |
| false friend | Coach | en, us-tx | pos:sports-coach, none | unmatched —; Clef pos:bus-driver 0.33, none 0.16; pivot "coach → no token" | unmatched —; Clef pos:bus-driver 0.33, none 0.16; pivot "coach → no token" |
| false friend | Valet | en, us-fl | pos:parking-valet, none | **pivot pos:civil-enforcement-officer**; Clef pos:hotel-porter 0.30, none 0.10; pivot "parking attendant → pos:civil-enforcement-officer" | **pivot pos:civil-enforcement-officer**; Clef pos:hotel-porter 0.30, none 0.10; pivot "parking attendant → pos:civil-enforcement-officer" |
| false friend | Compositor | en, us-ca | pos:typesetter, pos:digital-artist, none | **chosen pos:desktop-publisher**; Clef pos:desktop-publisher 0.63, none 0.15 | **chosen pos:desktop-publisher**; Clef pos:desktop-publisher 0.63, none 0.15 |
| false friend | Instrutor | pt, br-sp | none | unmatched —; Clef none 0.32, none 0.32; pivot "instructor → no token" | unmatched —; Clef none 0.32, none 0.32; pivot "instructor → no token" |
| generic name | Professora | pt, br-sp | pos:primary-school-teacher, pos:secondary-school-teacher, pos:early-years-teacher, none | **pivot pos:politics-lecturer**; Clef pos:higher-education-lecturer 0.31, none 0.27; pivot "teacher → pos:politics-lecturer" | **pivot pos:politics-lecturer**; Clef pos:higher-education-lecturer 0.28, none 0.27; pivot "teacher → pos:politics-lecturer (in the band)" |
| generic name | Maestra | es, mx-cmx | pos:primary-school-teacher, pos:secondary-school-teacher, pos:early-years-teacher, none | **pivot pos:politics-lecturer**; Clef none 0.90, none 0.90; pivot "teacher → pos:politics-lecturer" | unmatched —; Clef none 0.79, none 0.79; pivot "teacher → pos:politics-lecturer (in the band)" |
| generic name | Torneiro mecânico | pt, br-sp | pos:fitter-and-turner, pos:lathe-and-turning-machine-operator, pos:metalworking-lathe-operator | chosen pos:fitter-and-turner; Clef pos:fitter-and-turner 0.66, none 0.06 | chosen pos:fitter-and-turner; Clef pos:fitter-and-turner 0.61, none 0.06; pivot "machinist → pos:tyre-fitter (in the band)" |
| generic name | Supervisora | pt, br-sp | none | **pivot pos:oil-refinery-control-room-operator**; Clef none 0.33, none 0.33; pivot "supervisor → pos:oil-refinery-control-room-operator" | **pivot pos:oil-refinery-control-room-operator**; Clef none 0.33, none 0.33; pivot "supervisor → pos:oil-refinery-control-room-operator" |
| label | Instructor | es, mx-cmx | none | **label pos:air-force-officer** | **label pos:air-force-officer** |
| label | Valet | es, mx-cmx | pos:parking-valet, none | **label pos:room-attendant** | **label pos:room-attendant** |
| label | Coach | pt, br-sp | pos:life-coach, pos:sports-coach | label pos:life-coach | label pos:life-coach |

The nearest candidates (token, matched label, its language and a national label's region, cosine), the same in both arms:

| String | Candidates |
|---|---|
| Encanador (pt) | pos:bulk-filler "Enfardador" pt 0.863; pos:carpet-fitter "enmoquetador" es 0.844; pos:hardwood-floor-layer "entarimador" es 0.838; pos:derrickhand "encuellador" es 0.829; pos:assayer "ensayador" es 0.818 |
| Bombeiro hidráulico (pt) | pos:water-engineer "Engenheiro hidráulico" pt 0.841; pos:fluid-power-engineer "Engenheiro hidráulico" pt 0.841; pos:firefighter "Bombeiro" pt 0.834; pos:fluid-power-technician "Técnica de potência hidráulica" pt 0.819; pos:marine-firefighter "Bombeiro naval" pt 0.819 |
| Terceiro Oficial de Máquinas (pt) | pos:marine-mechanic "oficial de máquinas" es 0.893; pos:deck-officer "primer oficial de máquinas" es 0.875; pos:marine-chief-engineer "Chefe de máquinas" pt 0.842; pos:marine-engineer "oficial de máquinas de la marina mercante" es 0.825; pos:rail-operations-manager "Maquinista" pt 0.817 |
| Garçom (pt) | pos:hotel-butler "Mordomo" pt 0.846; pos:bartender "camarera" es 0.841; pos:domestic-butler "Mordomo doméstico" pt 0.838; pos:restaurant-host-restaurant-hostess "Rececionista de restaurante" pt 0.828; pos:hotel-concierge "Assistente de serviço" pt 0.827 |
| Caminhoneiro (pt) | pos:tow-truck-driver "camionero de remolque" es 0.863; pos:room-attendant "Camareiro" pt 0.861; pos:cargo-vehicle-driver "trucker" en 0.858; pos:moving-truck-driver "Motorista de camiões de mudanças" pt 0.855; pos:police-commissioner "Comissária" pt 0.833 |
| Operador de empilhadeira (pt) | pos:forklift-operator "Operador de empilhadores" pt 0.918; pos:warehouse-order-picker "Operador de armazém" pt 0.891; pos:high-rigger "operador de montacargas" es 0.887; pos:excavator-operator "Operador de escavadora" pt 0.883; pos:forestry-equipment-operator "Operador de máquinas florestais" pt 0.872 |
| Frentista (pt) | pos:sewing-machine-operator "Front Facer" en-us 0.809; pos:plumber "fontanera" es 0.797; pos:taxi-driver "taxista" es 0.792; pos:user-interface-developer "desarrolladora de frontales" es 0.791; pos:fuel-station-specialised-seller "gasolinero" es 0.786 |
| Motorista de ônibus (pt) | pos:bus-driver "conductor de autobús" es 0.908 |
| Auxiliar de cozinha (pt) | pos:kitchen-assistant "Assistente de cozinha" pt 0.936; pos:kitchen-porter "auxiliar de cocina" es 0.920; pos:cook "Chefe de cozinha" pt 0.868; pos:restaurant-manager "Gestor de cozinha" pt 0.867; pos:food-service-worker "kitchen assistant" en 0.858 |
| Soldador de Tubulação (pt) | pos:pipe-welder "Soldador de tubos" pt 0.900; pos:drain-technician "Técnico de tubagem" pt 0.875; pos:welding-engineer "Engenheiro de soldadura" pt 0.858; pos:welding-inspector "Inspetor de soldadura" pt 0.840; pos:solderer "Soldador por brasagem" pt 0.836 |
| Plomero (es) | pos:plumber "fontanero" es 0.885; pos:pipe-welder "plumber" en 0.864; pos:bathroom-fitter "fontanero instalador de cuartos de baño" es 0.859; pos:plumbing-supervisor "especialista en instalación de tuberías" es 0.824 |
| Tercer Ingeniero (es) | pos:ship-assistant-engineer "third assistant engineer" en 0.861; pos:military-engineer "ingeniera del ejército" es 0.840; pos:offshore-renewable-energy-engineer "ingeniero ORE" es 0.840; pos:mechanical-engineer "ingeniero mecánico/ingeniera mecánica" es 0.839; pos:maintenance-and-repair-engineer "ingeniera de equipos" es 0.838 |
| Mesero (es) | pos:hotel-butler "Mordomo" pt 0.843; pos:bartender "camarera" es 0.838; pos:head-waiter-head-waitress "camarero jefe" es 0.836; pos:waiter-waitress "camarero/camarera" es 0.831; pos:quick-service-restaurant-crew-member "Mess Attendant" en-us 0.828 |
| Camionero (es) | pos:tow-truck-driver "camionero de remolque" es 0.899; pos:cargo-vehicle-driver "trucker" en 0.870; pos:room-attendant "Camareiro" pt 0.866; pos:moving-truck-driver "Motorista de camiões de mudanças" pt 0.853; pos:forklift-operator "Inside Trucker" en-us 0.850 |
| Montacarguista (es) | pos:marine-fitter "montador naval" pt 0.825; pos:tent-installer "montadora de carpas" es 0.825; pos:coachbuilder "Carroçador" pt 0.819; pos:bicycle-assembler "montadora de tándems" es 0.816; pos:staircase-installer "montador de escaleras" es 0.810 |
| Tablajero (es) | pos:woodcarver "tallador" es 0.851; pos:roofer "colocador de pizarra" es 0.816; pos:lumber-grader "clasificador de tablones de madera" es 0.814; pos:paperhanger "empapelador" es 0.810; pos:paperhanger-supervisor "empapelador" es 0.810 |
| Borracheiro (pt) | pos:shoe-and-leather-accessories-shop-manager "Correeiro" pt 0.830; pos:miller "Moleiro/Moleira" pt 0.817; pos:locksmith "Serralheira" pt 0.811; pos:structural-ironwork-supervisor "Serralheira" pt 0.811; pos:embroiderer "Bordadeira" pt 0.809 |
| Vulcanizador (es) | pos:tyre-vulcaniser "Vulcanizador de pneus" pt 0.832; pos:belt-builder "vulcanizador de bandas y correas transportadoras" es 0.810; pos:electroplating-machine-operator "Metalizer" en-us 0.810; pos:plumber "Canalizador" pt 0.807; pos:bathroom-fitter "Canalizador" pt 0.807 |
| Gesseiro (pt) | pos:basketmaker "cestero/cestera" es 0.839; pos:shoe-and-leather-accessories-shop-manager "Correeiro" pt 0.809; pos:cider-master "sidrero" es 0.807; pos:coachbuilder "carrocero" es 0.807; pos:house-sitter "Caseiro" pt 0.806 |
| Babá (pt) | pos:nanny "nanny" en 0.814; pos:circus-artist "Mágico" pt 0.787; pos:babysitter "baby-sitter" en 0.785; pos:au-pair "baby sitter" en 0.783; pos:child-day-care-worker "Acompanhante de crianças" pt 0.781 |
| Velador (es) | pos:handyperson "zelador" pt 0.850; pos:terrazzo-setter "solador" es 0.839; pos:farrier "Ferrador" pt 0.823; pos:pawnbroker "fiador" es 0.821; pos:collection-manager "Curador" pt 0.820 |
| Motoboy (pt) | pos:motorcycle-delivery-person "Condutora de motociclos para entregas" pt 0.792; pos:vehicle-technician "técnico de motas" pt 0.787; pos:parking-valet "Manobrista" pt 0.783; pos:motorcycle-assembler "montador de motos" es 0.775; pos:postman-postwoman "motorcycle messenger" en 0.774 |
| Lavaloza (es) | pos:kitchen-porter "lavaplatos" es 0.869; pos:laundry-worker "Laundress" en-us 0.819; pos:laundromat-attendant "empleada de lavandería" es 0.817; pos:linen-room-attendant "empleada de lavandería" es 0.817; pos:pottery-and-porcelain-caster "moldeador de loza" es 0.815 |
| Hojalatero (es) | pos:yarn-spinner "hilandero" es 0.821; pos:crop-production-worker "jornalero" es 0.814; pos:forest-worker "jornalero" es 0.814; pos:chocolatier "chocolatero" es 0.814; pos:milliner "sombrerero" es 0.811 |
| Bodeguero (es) | pos:vineyard-cellar-master "maestro bodeguero" es 0.875; pos:woodturner "bodger" en 0.812; pos:bulldozer-operator "operario de buldócer" es 0.772; pos:circus-artist "Domador" pt 0.768; pos:pastry-chef "Padeiro" pt 0.765 |
| Faxineira (pt) | pos:coppersmith "Funileira" pt 0.824; pos:special-forces-officer "Fuzileira" pt 0.814; pos:assayer "Ensaiadora" pt 0.806; pos:knitter "Fazedora de renda" pt 0.806; pos:circus-artist "Faquir" pt 0.802 |
| Afanadora (es) | pos:tool-grinder "afiladora" es 0.843; pos:circus-artist "Domadora" pt 0.834; pos:farrier "Ferrador/Ferradora" pt 0.827; pos:military-engineer "zapadora" es 0.825; pos:fortune-teller "Advinhadora" pt 0.822 |
| Instructor (en) | pos:air-force-officer "instructor" es 0.958; pos:zoo-educator "education instructor" en 0.926; pos:higher-education-lecturer "Educational Instructor" en-us 0.923; pos:politics-lecturer "Government Instructor" en-us 0.910; pos:secondary-school-teacher "English Instructor" en-us 0.910 |
| Coach (en) | pos:life-coach "Coach" pt 0.970; pos:sports-coach "Track Coach" en-us 0.909; pos:carriage-driver "coachman" en 0.901; pos:bus-driver "coach driver" en 0.899; pos:business-coach "Coach profissional" pt 0.899 |
| Valet (en) | pos:room-attendant "valet" es 0.898; pos:parking-valet "Valet Driver" en-us 0.895; pos:private-chauffeur "private valet" en 0.860; pos:hotel-butler "Mordomo" pt 0.831; pos:hotel-porter "bellboy" en 0.828 |
| Compositor (en) | pos:composer "Compositor" pt 0.970; pos:desktop-publisher "Computer Compositor" en-us 0.931; pos:digital-artist "Compositor digital" pt 0.871; pos:imagesetter "compositora de imágenes" es 0.846; pos:lyricist "composer-lyricist" en 0.834 |
| Instrutor (pt) | pos:air-force-officer "instructor" es 0.907; pos:armed-forces-training-and-education-officer "Instrutor militar" pt 0.904; pos:ski-instructor "Instrutor  de equi" pt 0.889; pos:animal-handler "Instrutor de animais" pt 0.882; pos:horse-riding-instructor "Instrutor de equitação" pt 0.879 |
| Professora (pt) | pos:higher-education-lecturer "Professora universitária" pt 0.906; pos:assistant-lecturer "Professora assistente" pt 0.887; pos:art-studies-lecturer "Professora de Arte" pt 0.880; pos:vocational-teacher "Professora do ensino profissional" pt 0.878; pos:classical-languages-lecturer "Professora de Grego" pt 0.877 |
| Maestra (es) | pos:malt-master "maestro maltero/maestra maltera" es 0.871; pos:hotel-butler "maestresala" es 0.870; pos:head-waiter-head-waitress "maestresala" es 0.870; pos:vineyard-cellar-master "maestra bodeguera" es 0.863; pos:cider-master "maestro sidrero/maestra sidrera" es 0.861 |
| Torneiro mecânico (pt) | pos:fitter-and-turner "Torneiro" pt 0.882; pos:woodturner "Torneiro de madeiras" pt 0.863; pos:laundry-ironer "Engomador mecânico" pt 0.857; pos:spring-maker "tornero de espiral" es 0.841; pos:industrial-machinery-mechanic "Mecânico industrial" pt 0.834 |
| Supervisora (pt) | pos:script-supervisor "Supervisora de guião" pt 0.896; pos:chemical-processing-supervisor "Supervisora de laboratório" pt 0.891; pos:oil-refinery-control-room-operator "supervisor" en 0.884; pos:mine-supervisor "Supervisora de mineração" pt 0.878; pos:facilities-manager "Supervisora de instalações" pt 0.878 |
| Instructor (es) | — |
| Valet (es) | — |
| Coach (pt) | — |

What Clef was told with the pivot in the band (the state and the `match` criteria), for each string whose band showed the English name's token after the nearest five:

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Encanador

c0: bulk filler (matched "Enfardador", Portuguese)
c1: carpet fitter (matched "enmoquetador", Spanish)
c2: hardwood floor layer (matched "entarimador", Spanish)
c3: derrickhand (matched "encuellador", Spanish)
c4: assayer (matched "ensayador", Spanish)
c5: plumber
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-rj):
Bombeiro hidráulico

c0: water engineer (matched "Engenheiro hidráulico", Portuguese)
c1: fluid power engineer (matched "Engenheiro hidráulico", Portuguese)
c2: firefighter (matched "Bombeiro", Portuguese)
c3: fluid power technician (matched "Técnica de potência hidráulica", Portuguese)
c4: marine firefighter (matched "Bombeiro naval", Portuguese)
c5: plumber
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Garçom

c0: hotel butler (matched "Mordomo", Portuguese)
c1: bartender (matched "camarera", Spanish)
c2: domestic butler (matched "Mordomo doméstico", Portuguese)
c3: restaurant host/restaurant hostess (matched "Rececionista de restaurante", Portuguese)
c4: hotel concierge (matched "Assistente de serviço", Portuguese)
c5: waiter/waitress (matched "waiter", English)
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-ver):
Tercer Ingeniero

c0: ship assistant engineer (matched "third assistant engineer", English)
c1: military engineer (matched "ingeniera del ejército", Spanish)
c2: offshore renewable energy engineer (matched "ingeniero ORE", Spanish)
c3: mechanical engineer (matched "ingeniero mecánico/ingeniera mecánica", Spanish)
c4: maintenance and repair engineer (matched "ingeniera de equipos", Spanish)
c5: marine engineer
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-nle):
Montacarguista

c0: marine fitter (matched "montador naval", Portuguese)
c1: tent installer (matched "montadora de carpas", Spanish)
c2: coachbuilder (matched "Carroçador", Portuguese)
c3: bicycle assembler (matched "montadora de tándems", Spanish)
c4: staircase installer (matched "montador de escaleras", Spanish)
c5: forklift operator
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-cmx):
Tablajero

c0: woodcarver (matched "tallador", Spanish)
c1: roofer (matched "colocador de pizarra", Spanish)
c2: lumber grader (matched "clasificador de tablones de madera", Spanish)
c3: paperhanger (matched "empapelador", Spanish)
c4: paperhanger supervisor (matched "empapelador", Spanish)
c5: cabinet maker (matched "cabinetmaker", English)
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Borracheiro

c0: shoe and leather accessories shop manager (matched "Correeiro", Portuguese)
c1: miller (matched "Moleiro/Moleira", Portuguese)
c2: locksmith (matched "Serralheira", Portuguese)
c3: structural ironwork supervisor (matched "Serralheira", Portuguese)
c4: embroiderer (matched "Bordadeira", Portuguese)
c5: vehicle technician (matched "tire technician", English)
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Gesseiro

c0: basketmaker (matched "cestero/cestera", Spanish)
c1: shoe and leather accessories shop manager (matched "Correeiro", Portuguese)
c2: cider master (matched "sidrero", Spanish)
c3: coachbuilder (matched "carrocero", Spanish)
c4: house sitter (matched "Caseiro", Portuguese)
c5: plasterer
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-nle):
Velador

c0: handyperson (matched "zelador", Portuguese)
c1: terrazzo setter (matched "solador", Spanish)
c2: farrier (matched "Ferrador", Portuguese)
c3: pawnbroker (matched "fiador", Spanish)
c4: collection manager (matched "Curador", Portuguese)
c5: officer of the watch (matched "watchman", English)
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-cmx):
Lavaloza

c0: kitchen porter (matched "lavaplatos", Spanish)
c1: laundry worker (matched "Laundress", American English)
c2: laundromat attendant (matched "empleada de lavandería", Spanish)
c3: linen room attendant (matched "empleada de lavandería", Spanish)
c4: pottery and porcelain caster (matched "moldeador de loza", Spanish)
c5: vehicle cleaner (matched "car washer", English)
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-cmx):
Hojalatero

c0: yarn spinner (matched "hilandero", Spanish)
c1: crop production worker (matched "jornalero", Spanish)
c2: forest worker (matched "jornalero", Spanish)
c3: chocolatier (matched "chocolatero", Spanish)
c4: milliner (matched "sombrerero", Spanish)
c5: sheet metal worker
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-rj):
Faxineira

c0: coppersmith (matched "Funileira", Portuguese)
c1: special forces officer (matched "Fuzileira", Portuguese)
c2: assayer (matched "Ensaiadora", Portuguese)
c3: knitter (matched "Fazedora de renda", Portuguese)
c4: circus artist (matched "Faquir", Portuguese)
c5: domestic cleaner (matched "cleaner", English)
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-cmx):
Afanadora

c0: tool grinder (matched "afiladora", Spanish)
c1: circus artist (matched "Domadora", Portuguese)
c2: farrier (matched "Ferrador/Ferradora", Portuguese)
c3: military engineer (matched "zapadora", Spanish)
c4: fortune teller (matched "Advinhadora", Portuguese)
c5: chimney sweep (matched "sweeper", English)
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Professora

c0: higher education lecturer (matched "Professora universitária", Portuguese)
c1: assistant lecturer (matched "Professora assistente", Portuguese)
c2: art studies lecturer (matched "Professora de Arte", Portuguese)
c3: vocational teacher (matched "Professora do ensino profissional", Portuguese)
c4: classical languages lecturer (matched "Professora de Grego", Portuguese)
c5: politics lecturer (matched "teacher", English)
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-cmx):
Maestra

c0: malt master (matched "maestro maltero/maestra maltera", Spanish)
c1: hotel butler (matched "maestresala", Spanish)
c2: head waiter/head waitress (matched "maestresala", Spanish)
c3: vineyard cellar master (matched "maestra bodeguera", Spanish)
c4: cider master (matched "maestro sidrero/maestra sidrera", Spanish)
c5: politics lecturer (matched "teacher", English)
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Torneiro mecânico

c0: fitter and turner (matched "Torneiro", Portuguese)
c1: woodturner (matched "Torneiro de madeiras", Portuguese)
c2: laundry ironer (matched "Engomador mecânico", Portuguese)
c3: spring maker (matched "tornero de espiral", Spanish)
c4: industrial machinery mechanic (matched "Mecânico industrial", Portuguese)
c5: tyre fitter (matched "machinist", English)
none: None of these: a different occupation
```
