# The English pivot in the band on the v2 replica, 2026-10-31

39 synthetic strings (`test/fixtures/work/locale-cases.json`), each with the market of the worker who wrote it, snapped on the v2 generation, the one the plane runs: the registry replica (`test/work-eval/replica.ts`: the ESCO import's and the US layer's SQL, 16978 tokens and 230108 labels, no certificate token; 229654 v2 vectors of EmbeddingGemma 2's LiteRT-LM file at 768, a national label's region kept), each string embedded as the phone embeds it (`litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm` through LiteRT-LM on the Mac, a query and a document), with `@cf/cloudflare/clef-flash` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` over the Workers AI REST API from the Mac. τ_auto 0.96, τ_low 0.81. Two arms on the same registry and vectors: **market**, production's requests with the listing's market, the pivot asked only below the band or after Clef's none, as today; **pivot**, the same with the English pivot in the band (workspace decision 0018, amendment proposed 2026-10-30): a worker's Portuguese or Spanish string asks the pivot beside the snap's search, and Clef is shown the token its English name names. Right: one of the expected tokens, or, where no token fits, none or a new one; a false friend is the token ESCO's Spanish or Portuguese gives the word, or the one a generic English name holds as a label (workspace OD-28).

| Group | Market (production) | With the pivot in the band |
|---|---|---|
| regional | 17 of 27 right, 0 false friend or generic name, 10 other | 19 of 27 right, 0 false friend or generic name, 8 other |
| false friend | 2 of 5 right, 0 false friend or generic name, 3 other | 2 of 5 right, 0 false friend or generic name, 3 other |
| generic name | 1 of 4 right, 3 false friend or generic name, 0 other | 2 of 4 right, 2 false friend or generic name, 0 other |
| label | 1 of 3 right, 2 false friend or generic name, 0 other | 1 of 3 right, 2 false friend or generic name, 0 other |
| all | 21 of 39 | 24 of 39 |

**Market (production):** cost per snap 0.000051 USD, median 1041 ms a snap (the phone's vectors were embedded before, and the replica searches its vectors in process, so this is no production latency); calls: work-embed 0.00 a snap, work-pivot 0.59 a snap (median 546 ms answered), work-adjudicate 0.85 a snap (median 648 ms answered); 0 pivot calls a τ_auto take left unread (cancelled while running, or metered as answered).

**With the pivot in the band:** cost per snap 0.000071 USD, median 1109 ms a snap (the phone's vectors were embedded before, and the replica searches its vectors in process, so this is no production latency); calls: work-embed 0.00 a snap, work-pivot 0.90 a snap (median 590 ms answered), work-adjudicate 0.85 a snap (median 477 ms answered); 0 pivot calls a τ_auto take left unread (cancelled while running, or metered as answered).

In the band, the English name named a token for 24 strings: shown after the nearest five 16 times, already among them 8 times. Clef chose that token 14 times, chose another 1 times and refused it with its none 1 times; 8 times Clef answered under its floor and step 3 took it.

The amendment's two open rules for an answer under Clef's floor, replayed on the pivot arm without a model call. Step 3 took the English name's token after Clef answered under its floor in 10 snaps, 8 of them with that token shown to Clef; Clef never saw it for Instructor (en), Valet (en). Refusing that token also when Clef's likeliest answer is none: 24 of 39 right (gained none; lost none) where Clef saw it, 24 of 39 right (gained none; lost none) on every such snap. Taking it only when it is Clef's likeliest answer: 23 of 39 right (gained Professora (pt), Supervisora (pt); lost Bombeiro hidráulico (pt), Tercer Ingeniero (es), Gesseiro (pt)) where Clef saw it, 25 of 39 right (gained Instructor (en), Valet (en), Professora (pt), Supervisora (pt); lost Bombeiro hidráulico (pt), Tercer Ingeniero (es), Gesseiro (pt)) on every such snap.

0 snaps ran again after a hosted call threw; none still failed.

Clef's band answers, read again at other floors (the shipped floor is 0.5), per arm:

**market**, 33 answers:

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 10 | 11 | 10 | 2 |
| 0.4 | 10 | 10 | 9 | 4 |
| 0.5 | 9 | 4 | 9 | 11 |
| 0.6 | 8 | 3 | 8 | 14 |
| 0.7 | 4 | 0 | 7 | 22 |
| 0.8 | 3 | 0 | 4 | 26 |

**pivot**, 33 answers:

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 15 | 14 | 2 | 2 |
| 0.4 | 15 | 13 | 2 | 3 |
| 0.5 | 14 | 5 | 2 | 12 |
| 0.6 | 13 | 4 | 1 | 15 |
| 0.7 | 9 | 2 | 1 | 21 |
| 0.8 | 6 | 1 | 0 | 26 |

| Group | String | Language, market | Expected | Market (production) | With the pivot in the band |
|---|---|---|---|---|---|
| regional | Encanador | pt, br-sp | pos:plumber | pivot pos:plumber; Clef none 0.53, none 0.53; pivot "plumber → pos:plumber" | chosen pos:plumber; Clef pos:plumber 0.74, none 0.10; pivot "plumber → pos:plumber (in the band)" |
| regional | Bombeiro hidráulico | pt, br-rj | pos:plumber | **chosen pos:firefighter**; Clef pos:firefighter 0.57, none 0.10 | pivot pos:plumber; Clef pos:firefighter 0.41, none 0.09; pivot "plumber → pos:plumber (in the band)" |
| regional | Terceiro Oficial de Máquinas | pt, br-rj | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | pivot pos:marine-engineer; Clef pos:marine-mechanic 0.42, none 0.09; pivot "marine engineer → pos:marine-engineer" | chosen pos:marine-engineer; Clef pos:marine-engineer 0.72, none 0.04; pivot "marine engineer → pos:marine-engineer (in the band)" |
| regional | Garçom | pt, br-sp | pos:waiter-waitress | pivot pos:waiter-waitress; pivot "waiter → pos:waiter-waitress" | pivot pos:waiter-waitress; pivot "waiter → pos:waiter-waitress" |
| regional | Caminhoneiro | pt, br-pr | pos:cargo-vehicle-driver | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.68, none 0.05 | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.68, none 0.05; pivot "truck driver → pos:cargo-vehicle-driver" |
| regional | Operador de empilhadeira | pt, br-sp | pos:forklift-operator | chosen pos:forklift-operator; Clef pos:forklift-operator 0.82, none 0.04 | chosen pos:forklift-operator; Clef pos:forklift-operator 0.82, none 0.04; pivot "forklift operator → pos:forklift-operator" |
| regional | Frentista | pt, br-mg | pos:fuel-station-specialised-seller | **minted pos:gas-station-attendant**; Clef none 0.74, none 0.74; pivot "gas station attendant → no token" | **minted pos:gas-station-attendant**; Clef none 0.74, none 0.74; pivot "gas station attendant → no token" |
| regional | Motorista de ônibus | pt, br-sp | pos:bus-driver | chosen pos:bus-driver; Clef pos:bus-driver 0.82, none 0.02 | chosen pos:bus-driver; Clef pos:bus-driver 0.82, none 0.02; pivot "bus driver → pos:bus-driver" |
| regional | Auxiliar de cozinha | pt, br-sp | pos:kitchen-assistant, pos:kitchen-porter | pivot pos:kitchen-assistant; Clef pos:kitchen-assistant 0.47, none 0.04; pivot "kitchen assistant → pos:kitchen-assistant" | pivot pos:kitchen-assistant; Clef pos:kitchen-assistant 0.47, none 0.04; pivot "kitchen assistant → pos:kitchen-assistant" |
| regional | Soldador de Tubulação | pt, br-rj | pos:pipe-welder, pos:welder | chosen pos:pipe-welder; Clef pos:pipe-welder 0.59, none 0.05 | chosen pos:pipe-welder; Clef pos:pipe-welder 0.59, none 0.05; pivot "pipe welder → pos:pipe-welder" |
| regional | Plomero | es, mx-nle | pos:plumber | chosen pos:plumber; Clef pos:plumber 0.64, none 0.07 | chosen pos:plumber; Clef pos:plumber 0.64, none 0.07; pivot "plumber → pos:plumber" |
| regional | Tercer Ingeniero | es, mx-ver | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | pivot pos:marine-engineer; Clef pos:mechanical-engineer 0.48, none 0.11; pivot "marine engineer → pos:marine-engineer" | pivot pos:marine-engineer; Clef pos:mechanical-engineer 0.46, none 0.10; pivot "marine engineer → pos:marine-engineer (in the band)" |
| regional | Mesero | es, mx-cmx | pos:waiter-waitress | pivot pos:waiter-waitress; Clef none 0.98, none 0.98; pivot "waiter → pos:waiter-waitress" | chosen pos:waiter-waitress; Clef pos:waiter-waitress 0.90, none 0.03; pivot "waiter → pos:waiter-waitress (in the band)" |
| regional | Camionero | es, mx-nle | pos:cargo-vehicle-driver | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.72, none 0.04 | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.72, none 0.04; pivot "truck driver → pos:cargo-vehicle-driver" |
| regional | Montacarguista | es, mx-nle | pos:forklift-operator | pivot pos:forklift-operator; Clef none 0.78, none 0.78; pivot "forklift operator → pos:forklift-operator" | chosen pos:forklift-operator; Clef pos:forklift-operator 0.87, none 0.05; pivot "forklift operator → pos:forklift-operator (in the band)" |
| regional | Tablajero | es, mx-cmx | pos:butcher | **pivot pos:cabinet-maker**; Clef pos:lumber-grader 0.28, none 0.27; pivot "cabinetmaker → pos:cabinet-maker" | **pivot pos:cabinet-maker**; Clef pos:cabinet-maker 0.42, none 0.16; pivot "cabinetmaker → pos:cabinet-maker (in the band)" |
| regional | Borracheiro | pt, br-sp | pos:tyre-vulcaniser, pos:tyre-fitter | **pivot pos:vehicle-technician**; Clef none 0.91, none 0.91; pivot "tire technician → pos:vehicle-technician" | **chosen pos:vehicle-technician**; Clef pos:vehicle-technician 0.60, none 0.32; pivot "tire technician → pos:vehicle-technician (in the band)" |
| regional | Vulcanizador | es, mx-nle | pos:tyre-vulcaniser, pos:tyre-fitter | chosen pos:tyre-vulcaniser; Clef pos:tyre-vulcaniser 0.81, none 0.10 | chosen pos:tyre-vulcaniser; Clef pos:tyre-vulcaniser 0.81, none 0.10; pivot "vulcanizer → no token" |
| regional | Gesseiro | pt, br-sp | pos:plasterer, pos:ceiling-installer | **chosen pos:bricklayer**; Clef pos:bricklayer 0.68, none 0.10 | pivot pos:plasterer; Clef pos:bricklayer 0.49, none 0.08; pivot "plasterer → pos:plasterer (in the band)" |
| regional | Babá | pt, br-sp | pos:nanny, pos:babysitter | pivot pos:nanny; pivot "nanny → pos:nanny" | pivot pos:nanny; pivot "nanny → pos:nanny" |
| regional | Velador | es, mx-nle | pos:security-guard | **pivot pos:officer-of-the-watch**; Clef none 0.72, none 0.72; pivot "watchman → pos:officer-of-the-watch" | **chosen pos:officer-of-the-watch**; Clef pos:officer-of-the-watch 0.73, none 0.12; pivot "watchman → pos:officer-of-the-watch (in the band)" |
| regional | Motoboy | pt, br-sp | pos:motorcycle-delivery-person | **minted pos:messenger**; pivot "messenger → no token" | **minted pos:messenger**; pivot "messenger → no token" |
| regional | Lavaloza | es, mx-cmx | pos:kitchen-porter | chosen pos:kitchen-porter; Clef pos:kitchen-porter 0.61, none 0.20 | chosen pos:kitchen-porter; Clef pos:kitchen-porter 0.61, none 0.20; pivot "washer → no token" |
| regional | Hojalatero | es, mx-cmx | pos:refurbishing-technician | **pivot pos:sheet-metal-worker**; Clef none 0.81, none 0.81; pivot "sheet metal worker → pos:sheet-metal-worker" | **chosen pos:sheet-metal-worker**; Clef pos:sheet-metal-worker 0.95, none 0.02; pivot "sheet metal worker → pos:sheet-metal-worker (in the band)" |
| regional | Bodeguero | es, mx-nle | pos:warehouse-worker, pos:warehouse-order-picker | **chosen pos:vineyard-cellar-master**; Clef pos:vineyard-cellar-master 0.64, none 0.24 | **chosen pos:vineyard-cellar-master**; Clef pos:vineyard-cellar-master 0.64, none 0.24; pivot "storekeeper → no token" |
| regional | Faxineira | pt, br-rj | pos:domestic-cleaner, pos:building-cleaner, pos:domestic-housekeeper | pivot pos:domestic-cleaner; Clef none 0.90, none 0.90; pivot "cleaner → pos:domestic-cleaner" | chosen pos:domestic-cleaner; Clef pos:domestic-cleaner 0.88, none 0.05; pivot "cleaner → pos:domestic-cleaner (in the band)" |
| regional | Afanadora | es, mx-cmx | pos:building-cleaner, pos:domestic-cleaner | **unmatched —**; Clef pos:tool-grinder 0.50, none 0.28; pivot "threshing machine operator → no token" | **pivot pos:fruit-and-vegetable-picker**; Clef pos:tool-grinder 0.43, none 0.26; pivot "harvester → pos:fruit-and-vegetable-picker (in the band)" |
| false friend | Instructor | en, us-tx | none | **pivot pos:politics-lecturer**; Clef pos:higher-education-lecturer 0.45, none 0.09; pivot "teacher → pos:politics-lecturer" | **pivot pos:politics-lecturer**; Clef pos:higher-education-lecturer 0.45, none 0.09; pivot "teacher → pos:politics-lecturer" |
| false friend | Coach | en, us-tx | pos:sports-coach, none | unmatched —; Clef pos:bus-driver 0.41, none 0.09; pivot "coach → no token" | unmatched —; Clef pos:bus-driver 0.41, none 0.09; pivot "coach → no token" |
| false friend | Valet | en, us-fl | pos:parking-valet, none | **pivot pos:civil-enforcement-officer**; Clef pos:hotel-porter 0.39, none 0.11; pivot "parking attendant → pos:civil-enforcement-officer" | **pivot pos:civil-enforcement-officer**; Clef pos:hotel-porter 0.39, none 0.11; pivot "parking attendant → pos:civil-enforcement-officer" |
| false friend | Compositor | en, us-ca | pos:typesetter, pos:digital-artist, none | **chosen pos:desktop-publisher**; Clef pos:desktop-publisher 0.63, none 0.15 | **chosen pos:desktop-publisher**; Clef pos:desktop-publisher 0.63, none 0.15 |
| false friend | Instrutor | pt, br-sp | none | unmatched —; Clef pos:armed-forces-training-and-education-officer 0.29, none 0.27; pivot "instructor → no token" | unmatched —; Clef pos:armed-forces-training-and-education-officer 0.29, none 0.27; pivot "instructor → no token" |
| generic name | Professora | pt, br-sp | pos:primary-school-teacher, pos:secondary-school-teacher, pos:early-years-teacher, none | **pivot pos:politics-lecturer**; Clef none 0.31, none 0.31; pivot "teacher → pos:politics-lecturer" | **pivot pos:politics-lecturer**; Clef pos:higher-education-lecturer 0.29, none 0.29; pivot "teacher → pos:politics-lecturer (in the band)" |
| generic name | Maestra | es, mx-cmx | pos:primary-school-teacher, pos:secondary-school-teacher, pos:early-years-teacher, none | **pivot pos:politics-lecturer**; Clef none 0.68, none 0.68; pivot "teacher → pos:politics-lecturer" | unmatched —; Clef none 0.56, none 0.56; pivot "teacher → pos:politics-lecturer (in the band)" |
| generic name | Torneiro mecânico | pt, br-sp | pos:fitter-and-turner, pos:lathe-and-turning-machine-operator, pos:metalworking-lathe-operator | chosen pos:fitter-and-turner; Clef pos:fitter-and-turner 0.63, none 0.07 | chosen pos:fitter-and-turner; Clef pos:fitter-and-turner 0.61, none 0.06; pivot "machinist → pos:tyre-fitter (in the band)" |
| generic name | Supervisora | pt, br-sp | none | **pivot pos:oil-refinery-control-room-operator**; Clef pos:construction-general-supervisor 0.43, none 0.18; pivot "supervisor → pos:oil-refinery-control-room-operator" | **pivot pos:oil-refinery-control-room-operator**; Clef pos:construction-general-supervisor 0.43, none 0.18; pivot "supervisor → pos:oil-refinery-control-room-operator" |
| label | Instructor | es, mx-cmx | none | **label pos:air-force-officer** | **label pos:air-force-officer** |
| label | Valet | es, mx-cmx | pos:parking-valet, none | **label pos:room-attendant** | **label pos:room-attendant** |
| label | Coach | pt, br-sp | pos:life-coach, pos:sports-coach | label pos:life-coach | label pos:life-coach |

The nearest candidates (token, matched label, its language and a national label's region, cosine), the same in both arms:

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

What Clef was told with the pivot in the band (the state and the `match` criteria), for each string whose band showed the English name's token after the nearest five:

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Encanador

c0: bulk filler (matched "Enfardador", Portuguese)
c1: derrickhand (matched "encuellador", Spanish)
c2: assayer (matched "ensayador", Spanish)
c3: carpet fitter (matched "enmoquetador", Spanish)
c4: hardwood floor layer (matched "entarimador", Spanish)
c5: plumber
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-rj):
Bombeiro hidráulico

c0: water engineer (matched "Engenheiro hidráulico", Portuguese)
c1: fluid power engineer (matched "Engenheiro hidráulico", Portuguese)
c2: firefighter (matched "Bombeiro", Portuguese)
c3: industrial firefighter (matched "Bombeira industrial", Portuguese)
c4: fluid power technician (matched "Técnica de potência hidráulica", Portuguese)
c5: plumber
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-rj):
Terceiro Oficial de Máquinas

c0: marine mechanic (matched "oficial de máquinas", Spanish)
c1: deck officer (matched "primer oficial de máquinas", Spanish)
c2: marine chief engineer (matched "Chefe de máquinas", Portuguese)
c3: rail operations manager (matched "Maquinista", Portuguese)
c4: second officer (matched "Segundo oficial", Portuguese)
c5: marine engineer
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-ver):
Tercer Ingeniero

c0: ship assistant engineer (matched "third assistant engineer", English)
c1: offshore renewable energy engineer (matched "ingeniera ORE", Spanish)
c2: mechanical engineer (matched "ingeniero mecánico/ingeniera mecánica", Spanish)
c3: military engineer (matched "ingeniera politécnica del Ejército de Tierra", Spanish)
c4: maintenance and repair engineer (matched "ingeniera de equipos", Spanish)
c5: marine engineer
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-cmx):
Mesero

c0: foundry moulder (matched "machero", Spanish)
c1: mouldmaker (matched "machero", Spanish)
c2: moulding machine operator (matched "machero", Spanish)
c3: coquille casting worker (matched "machero", Spanish)
c4: basketmaker (matched "cestero", Spanish)
c5: waiter/waitress (matched "waiter", English)
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-nle):
Montacarguista

c0: coachbuilder (matched "Carroçador", Portuguese)
c1: tent installer (matched "montadora de carpas", Spanish)
c2: marine fitter (matched "montador naval", Portuguese)
c3: bicycle assembler (matched "montadora de tándems", Spanish)
c4: rolling stock assembler (matched "montador de ferrocarriles", Spanish)
c5: forklift operator
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-cmx):
Tablajero

c0: woodcarver (matched "tallador", Spanish)
c1: snowboard instructor (matched "monitora de tablanieve", Spanish)
c2: lumber grader (matched "clasificador de tablones de madera", Spanish)
c3: waiter/waitress (matched "Técnica de mesa", Portuguese)
c4: sign maker (matched "Fabricante de tabuletas e sinalética", Portuguese)
c5: cabinet maker (matched "cabinetmaker", English)
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Borracheiro

c0: shoe and leather accessories shop manager (matched "Correeiro", Portuguese)
c1: chain making machine operator (matched "Barbeleira", Portuguese)
c2: locksmith (matched "Serralheira", Portuguese)
c3: structural ironwork supervisor (matched "Serralheira", Portuguese)
c4: door supervisor (matched "Porteiro", Portuguese)
c5: vehicle technician (matched "tire technician", English)
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Gesseiro

c0: basketmaker (matched "Cesteiro", Portuguese)
c1: cider master (matched "sidrero", Spanish)
c2: shoe and leather accessories shop manager (matched "Correeiro", Portuguese)
c3: coachbuilder (matched "carrocero", Spanish)
c4: bricklayer (matched "Calceteiro", Portuguese)
c5: plasterer
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-nle):
Velador

c0: handyperson (matched "zelador", Portuguese)
c1: pawnbroker (matched "fiador", Spanish)
c2: farrier (matched "Ferrador", Portuguese)
c3: terrazzo setter (matched "solador", Spanish)
c4: vineyard worker (matched "vendimiador", Spanish)
c5: officer of the watch (matched "watchman", English)
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-cmx):
Hojalatero

c0: jeweller (matched "Joalheiro/Joalheira", Portuguese)
c1: crop production worker (matched "jornalero", Spanish)
c2: forest worker (matched "jornalero", Spanish)
c3: yarn spinner (matched "hilandero", Spanish)
c4: shoemaker (matched "zapatera", Spanish)
c5: sheet metal worker
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-rj):
Faxineira

c0: coppersmith (matched "Funileira", Portuguese)
c1: knitter (matched "Fazedora de renda", Portuguese)
c2: circus artist (matched "Faquir", Portuguese)
c3: miller (matched "Moleiro/Moleira", Portuguese)
c4: landscape gardener (matched "Jardineira", Portuguese)
c5: domestic cleaner (matched "cleaner", English)
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-cmx):
Afanadora

c0: tool grinder (matched "afiladora", Spanish)
c1: fortune teller (matched "Advinhadora", Portuguese)
c2: infantry soldier (matched "Atiradora", Portuguese)
c3: military engineer (matched "zapadora", Spanish)
c4: farrier (matched "Ferradora", Portuguese)
c5: fruit and vegetable picker (matched "harvester", English)
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
c5: politics lecturer (matched "teacher", English)
none: None of these: a different occupation
```

```
An occupation written in Mexican Spanish by a worker in Mexico (mx-cmx):
Maestra

c0: malt master (matched "maestro maltero/maestra maltera", Spanish)
c1: cider master (matched "maestro sidrero/maestra sidrera", Spanish)
c2: musical conductor (matched "maestro/maestrina", Portuguese)
c3: soap maker (matched "maestra jabonera", Spanish)
c4: house builder (matched "maestra albañil", Spanish)
c5: politics lecturer (matched "teacher", English)
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Torneiro mecânico

c0: fitter and turner (matched "Torneiro", Portuguese)
c1: laundry ironer (matched "Engomador mecânico", Portuguese)
c2: woodturner (matched "Torneiro de madeiras", Portuguese)
c3: industrial machinery mechanic (matched "Mecânico industrial", Portuguese)
c4: roadside vehicle technician (matched "Mecânico de intervenção", Portuguese)
c5: tyre fitter (matched "machinist", English)
none: None of these: a different occupation
```
