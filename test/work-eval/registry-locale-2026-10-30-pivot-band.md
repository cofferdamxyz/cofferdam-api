# Regional words and false friends on ESCO, 2026-10-30

39 synthetic strings (`test/fixtures/work/locale-cases.json`), each with the market of the worker who wrote it, snapped against ESCO v1.2.1's occupations as loaded (3039 tokens, 62598 labels in en, pt and es; `test/work-eval/escoRegistry.ts`), each against the registry as loaded, with `@cf/baai/bge-m3`, `@cf/cloudflare/clef-flash` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` over the Workers AI REST API from the Mac. τ_auto 0.95, τ_low 0.6. Right: one of the expected tokens, or, where no token fits, none or a new one; a false friend is the token ESCO's Spanish or Portuguese gives the word, or the one a generic English name holds as a label (workspace OD-28). The English pivot in the band (workspace decision 0018, amendment proposed 2026-10-30): on, so a worker's Portuguese or Spanish string asks the pivot beside the embedding, and Clef is shown the token its English name names.

| Group | Right | A false friend or a generic name's token | Another token |
|---|---|---|---|
| regional | 17 of 27 | 0 | 10 |
| false friend | 3 of 5 | 0 | 2 |
| generic name | 2 of 4 | 1 | 1 |
| label | 1 of 3 | 2 | 0 |

All: 23 of 39 right.

Cost per snap 0.000071 USD, median 1175 ms. 0 snaps ran again after a hosted call threw; none still failed.

Calls: work-embed 1.00 a snap (median 190 ms answered), work-pivot 0.92 a snap (median 650 ms answered), work-adjudicate 0.77 a snap (median 488 ms answered); 2 pivot calls a τ_auto take left unread (cancelled while running, or metered as answered).

In the band, the English name named a token for 20 strings: shown after the nearest five 15 times, already among them 5 times. Clef chose that token 12 times, chose another 2 times and refused it with its none 1 times; 5 times Clef answered under its floor and step 3 took it.

Clef answered 30 strings in the band. Each answer read again at other floors (the shipped floor is 0.5):

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 15 | 7 | 6 | 2 |
| 0.4 | 14 | 5 | 5 | 6 |
| 0.5 | 13 | 3 | 4 | 10 |
| 0.6 | 11 | 3 | 2 | 14 |
| 0.7 | 10 | 0 | 2 | 18 |
| 0.8 | 7 | 0 | 2 | 21 |

| Group | String | Language, market | Expected | Decision | Token | Clef band answer | Pivot | Nearest candidates (token, matched label, language, cosine) |
|---|---|---|---|---|---|---|---|---|
| regional | Encanador | pt, br-sp | pos:plumber | chosen | pos:plumber | pos:plumber 0.88, none 0.03 | plumber → pos:plumber (in the band) | pos:assayer "Ensaiador" pt 0.738; pos:bulk-filler "Enfardador" pt 0.734; pos:ambassador "Enbaixador" pt 0.730; pos:fitter-and-turner "Afinador" pt 0.710; pos:carpet-fitter "enmoquetador" es 0.699 |
| regional | Bombeiro hidráulico | pt, br-rj | pos:plumber | pivot | pos:plumber | pos:plumber 0.50, none 0.13 | plumber → pos:plumber (in the band) | pos:fluid-power-engineer "Engenheiro hidráulico" pt 0.783; pos:water-engineer "Engenheiro hidráulico" pt 0.783; pos:marine-firefighter "Bombeiro naval" pt 0.761; pos:industrial-firefighter "Bombeiro industrial" pt 0.741; pos:hydrologist "ingeniero hidráulico" es 0.740 |
| regional | Terceiro Oficial de Máquinas | pt, br-rj | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | chosen | pos:marine-engineer | pos:marine-engineer 0.75, none 0.04 | marine engineer → pos:marine-engineer (in the band) | pos:metal-drawing-machine-operator "Operador de máquinas de trefilagem" pt 0.648; pos:marine-mechanic "oficial de máquinas" es 0.646; pos:wholesale-merchant-in-machine-tools "mayorista de máquinas herramienta" es 0.636; pos:office-equipment-repair-technician "office machines technician" en 0.627; pos:computer-aided-design-operator "3D computer-aided manufacturing technician" en 0.622 |
| regional | Garçom | pt, br-sp | pos:waiter-waitress | pivot | pos:waiter-waitress | — | waiter → pos:waiter-waitress | pos:circus-artist "Palhaço" pt 0.541; pos:coachbuilder "Carroçador" pt 0.521; pos:verger "Sacristão" pt 0.503; pos:upholsterer "tapicero" es 0.502; pos:hairdresser "Cabeleireiro" pt 0.501 |
| regional | Caminhoneiro | pt, br-pr | pos:cargo-vehicle-driver | chosen | pos:cargo-vehicle-driver | pos:cargo-vehicle-driver 0.92, none 0.02 | truck driver → pos:cargo-vehicle-driver (in the band) | pos:cook "Cozinheiro" pt 0.745; pos:helmsman "Timoneiro" pt 0.713; pos:street-sweeper "Cantoneiro" pt 0.708; pos:sailor "Marinheiro" pt 0.702; pos:room-attendant "Camareiro" pt 0.690 |
| regional | Operador de empilhadeira | pt, br-sp | pos:forklift-operator | auto | pos:forklift-operator | — | — | pos:forklift-operator "Operador de empilhadores" pt 0.964; pos:bindery-operator "Operador de máquina de encadernação" pt 0.802; pos:excavator-operator "Operador de escavadora" pt 0.798; pos:upsetting-machine-operator "Operador de recalcadora" pt 0.791; pos:winding-machine-operator "Operador de bobinadeiras" pt 0.784 |
| regional | Frentista | pt, br-mg | pos:fuel-station-specialised-seller | **minted** | pos:gas-station-attendant | none 0.94, none 0.94 | gas station attendant → no token | pos:dietitian "Dietista" pt 0.695; pos:geneticist "genetista" es 0.658; pos:specialist-dentist "Endontista" pt 0.648; pos:drafter "Projetista" pt 0.636; pos:cartoonist "historietista" es 0.635 |
| regional | Motorista de ônibus | pt, br-sp | pos:bus-driver | chosen | pos:bus-driver | pos:bus-driver 0.60, none 0.06 | bus driver → pos:bus-driver | pos:bus-driver "conductor de autobús" es 0.884; pos:taxi-driver "Motorista de táxis" pt 0.847; pos:trolley-bus-driver "bus operator" en 0.840 |
| regional | Auxiliar de cozinha | pt, br-sp | pos:kitchen-assistant, pos:kitchen-porter | auto | pos:kitchen-porter | — | — | pos:kitchen-porter "Ajudante de cozinha" pt 0.976; pos:kitchen-assistant "Assistente de cozinha" pt 0.965; pos:food-service-worker "kitchen assistant" en 0.843; pos:cook "encargada de cocina" es 0.819; pos:restaurant-manager "Gestor de cozinha" pt 0.805 |
| regional | Soldador de Tubulação | pt, br-rj | pos:pipe-welder, pos:welder | chosen | pos:pipe-welder | pos:pipe-welder 0.53, none 0.05 | pipe welder → pos:pipe-welder | pos:pipe-welder "Soldador de tubos" pt 0.833; pos:solderer "Soldador" pt 0.705; pos:welder "Soldador" pt 0.705; pos:laser-beam-welder "Soldador a laser" pt 0.700; pos:army-corporal "Soldado" pt 0.689 |
| regional | Plomero | es, mx-nle | pos:plumber | chosen | pos:plumber | pos:plumber 0.60, none 0.07 | plumber → pos:plumber | pos:plumber "plummer" en 0.626; pos:milliner "sombrerero" es 0.598; pos:plate-glass-installer "cristalero" es 0.574; pos:production-potter "alfarero" es 0.567; pos:pump-operator "bombero" es 0.552 |
| regional | Tercer Ingeniero | es, mx-ver | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | pivot | pos:marine-engineer | pos:industrial-engineer 0.32, none 0.12 | marine engineer → pos:marine-engineer (in the band) | pos:ship-assistant-engineer "third assistant engineer" en 0.628; pos:military-engineer "Engenheiro do Exército" pt 0.607; pos:industrial-engineer "ingeniero industrial" es 0.606; pos:material-stress-analyst "ingeniero industrial" es 0.606; pos:mechanical-engineer "ingeniero mecánico" es 0.599 |
| regional | Mesero | es, mx-cmx | pos:waiter-waitress | chosen | pos:waiter-waitress | pos:waiter-waitress 0.89, none 0.03 | waiter → pos:waiter-waitress (in the band) | pos:corporate-treasurer "tesorero" es 0.650; pos:basketmaker "cestero" es 0.635; pos:missionary "misionero" es 0.628; pos:coquille-casting-worker "machero" es 0.617; pos:moulding-machine-operator "machero" es 0.617 |
| regional | Camionero | es, mx-nle | pos:cargo-vehicle-driver | chosen | pos:cargo-vehicle-driver | pos:cargo-vehicle-driver 0.81, none 0.03 | truck driver → pos:cargo-vehicle-driver (in the band) | pos:tow-truck-driver "camionero de remolque" es 0.711; pos:fuel-station-specialised-seller "gasolinero" es 0.692; pos:followspot-operator "cañonero" es 0.676; pos:brigadier "Brigadeiro" pt 0.646; pos:coachbuilder "Carroçador" pt 0.646 |
| regional | Montacarguista | es, mx-nle | pos:forklift-operator | chosen | pos:forklift-operator | pos:forklift-operator 0.87, none 0.07 | forklift operator → pos:forklift-operator (in the band) | pos:mineral-processing-engineer "Mineralogista" pt 0.636; pos:mineralogist "Mineralogista" pt 0.636; pos:rail-operations-manager "Maquinista" pt 0.613; pos:masseur-masseuse "Massagista" pt 0.603; pos:stage-machinist "maquinista" es 0.588 |
| regional | Tablajero | es, mx-cmx | pos:butcher | **pivot** | pos:cabinet-maker | pos:brick-and-tile-caster 0.29, none 0.23 | cabinetmaker → pos:cabinet-maker (in the band) | pos:cashier "cajero" es 0.679; pos:cattle-breeder "granjero" es 0.675; pos:locksmith "cerrajero" es 0.668; pos:brick-and-tile-caster "tejero" es 0.662; pos:shepherd "ovejero" es 0.659 |
| regional | Borracheiro | pt, br-sp | pos:tyre-vulcaniser, pos:tyre-fitter | **unmatched** | — | none 0.47, none 0.47 | tire technician → no token | pos:mattress-maker "Colchoeiro" pt 0.665; pos:sailor "Marinheiro" pt 0.648; pos:barber "Barbeiro" pt 0.647; pos:firefighter "Bombeiro" pt 0.636; pos:plate-glass-installer "Vidraceira" pt 0.624 |
| regional | Vulcanizador | es, mx-nle | pos:tyre-vulcaniser, pos:tyre-fitter | chosen | pos:tyre-vulcaniser | pos:tyre-vulcaniser 0.74, none 0.12 | vulcanizer → no token | pos:tyre-vulcaniser "Vulcanizador de pneus" pt 0.797; pos:plumbing-supervisor "Canalizador" pt 0.764; pos:bathroom-fitter "Canalizador" pt 0.764; pos:plumber "Canalizador" pt 0.764; pos:localiser "Localizador" pt 0.713 |
| regional | Gesseiro | pt, br-sp | pos:plasterer, pos:ceiling-installer | chosen | pos:plasterer | pos:plasterer 0.80, none 0.06 | plasterer → pos:plasterer (in the band) | pos:textile-specialised-seller "Retroseiro" pt 0.674; pos:house-sitter "Caseiro" pt 0.667; pos:fish-and-seafood-shop-manager "Peixeiro" pt 0.646; pos:fish-preparation-operator "Peixeiro" pt 0.646; pos:budget-manager "Tesoureiro" pt 0.635 |
| regional | Babá | pt, br-sp | pos:nanny, pos:babysitter | chosen | pos:nanny | pos:nanny 0.82, none 0.09 | nanny → pos:nanny | pos:barber "barbera" es 0.609; pos:nanny "Ama" pt 0.587; pos:skipper "Capitã" pt 0.558; pos:air-force-officer "Capitão" pt 0.546; pos:chaplain "Capelã" pt 0.540 |
| regional | Velador | es, mx-nle | pos:security-guard | **chosen** | pos:officer-of-the-watch | pos:officer-of-the-watch 0.66, none 0.14 | watchman → pos:officer-of-the-watch (in the band) | pos:roofer "tejador" es 0.680; pos:glass-annealer "templador" es 0.672; pos:handyperson "zelador/zeladora" pt 0.672; pos:city-councillor "Vereador" pt 0.670; pos:leather-goods-hand-stitcher "aparador" es 0.655 |
| regional | Motoboy | pt, br-sp | pos:motorcycle-delivery-person | **minted** | pos:courier | — | courier → no token | pos:hotel-porter "bellboy" en 0.577; pos:motorcycle-assembler "motorbike builder" en 0.557; pos:singer "Rapper" pt 0.552; pos:vehicle-technician "motorbike mechanic" en 0.547; pos:professional-athlete "motorcycle driver" en 0.544 |
| regional | Lavaloza | es, mx-cmx | pos:kitchen-porter | **pivot** | pos:laundry-worker | — | laundry worker → pos:laundry-worker | pos:glove-maker "Luvista" pt 0.596; pos:equine-worker "caballeriza" es 0.569; pos:coppersmith "latonera" es 0.568; pos:laundry-worker "Operadora de lavandaria" pt 0.546; pos:stone-engraver "lapicida" es 0.535 |
| regional | Hojalatero | es, mx-cmx | pos:refurbishing-technician | **pivot** | pos:sheet-metal-worker | — | sheet metal worker → pos:sheet-metal-worker | pos:shepherd "ovejero" es 0.591; pos:postman-postwoman "Carteiro" pt 0.590; pos:yarn-spinner "hilandero" es 0.588; pos:cashier "cajera" es 0.587; pos:forest-worker "jornalero" es 0.586 |
| regional | Bodeguero | es, mx-nle | pos:warehouse-worker, pos:warehouse-order-picker | **chosen** | pos:vineyard-cellar-master | pos:vineyard-cellar-master 0.64, none 0.23 | storekeeper → no token | pos:vineyard-cellar-master "bodeguero vinícola" es 0.777; pos:woodturner "bodger" en 0.619; pos:boiler-operator "calderero" es 0.581; pos:boilermaker "calderero" es 0.581; pos:welder "calderero" es 0.581 |
| regional | Faxineira | pt, br-rj | pos:domestic-cleaner, pos:building-cleaner, pos:domestic-housekeeper | **minted** | pos:cleaner | none 0.53, none 0.53 | cleaner → no token | pos:special-forces-officer "Fuzileira" pt 0.698; pos:refuse-collector "Lixeira" pt 0.684; pos:coppersmith "Funileira" pt 0.682; pos:cook "Cozinheira" pt 0.680; pos:confectioner "Confeiteira" pt 0.671 |
| regional | Afanadora | es, mx-cmx | pos:building-cleaner, pos:domestic-cleaner | **pivot** | pos:chimney-sweep | pos:tool-grinder 0.47, none 0.20 | sweeper → pos:chimney-sweep (in the band) | pos:tool-grinder "afiladora" es 0.771; pos:fitter-and-turner "Afinadora" pt 0.765; pos:leather-goods-hand-stitcher "aparadora" es 0.728; pos:driller "barrenadora" es 0.696; pos:upholsterer "Estofadora" pt 0.693 |
| false friend | Instructor | en, us-tx | none | **pivot** | pos:politics-lecturer | pos:fitness-instructor 0.30, none 0.18 | teacher → pos:politics-lecturer | pos:air-force-officer "instructor" es 0.871; pos:armed-forces-training-and-education-officer "Instrutor militar" pt 0.844; pos:zoo-educator "educator" en 0.839; pos:fitness-instructor "Instrutor de fitness" pt 0.835; pos:sports-instructor "sports instructor" en 0.833 |
| false friend | Coach | en, us-tx | pos:sports-coach, none | unmatched | — | pos:sports-coach 0.33, none 0.17 | coach → no token | pos:life-coach "Coach" pt 1.000; pos:business-coach "Coach profissional" pt 0.833; pos:sports-coach "sports coach" en 0.827; pos:football-coach "football coach" en 0.817; pos:vehicle-technician "coach technician" en 0.816 |
| false friend | Valet | en, us-fl | pos:parking-valet, none | **pivot** | pos:civil-enforcement-officer | pos:private-chauffeur 0.35, none 0.12 | parking attendant → pos:civil-enforcement-officer | pos:room-attendant "valet" es 0.738; pos:vehicle-cleaner "car valeter" en 0.607; pos:private-chauffeur "private valet" en 0.602; pos:parking-valet "parking valet" en 0.601; pos:officer-of-the-watch "vigilante" es 0.577 |
| false friend | Compositor | en, us-ca | pos:typesetter, pos:digital-artist, none | pivot | pos:typesetter | none 0.54, none 0.54 | typesetter → pos:typesetter | pos:composer "Compositor" pt 1.000; pos:lyricist "composer-lyricist" en 0.804; pos:musician "cantante y compositor de canciones" es 0.752; pos:writer "Poeta" pt 0.747; pos:variety-artist "musician" en 0.724 |
| false friend | Instrutor | pt, br-sp | none | unmatched | — | pos:driving-instructor 0.45, none 0.11 | instructor → no token | pos:air-force-officer "instructor" es 0.876; pos:zoo-educator "educator" en 0.861; pos:armed-forces-training-and-education-officer "Instrutor militar" pt 0.852; pos:fitness-instructor "Instrutor de fitness" pt 0.838; pos:driving-instructor "Instrutor de condução" pt 0.835 |
| generic name | Professora | pt, br-sp | pos:primary-school-teacher, pos:secondary-school-teacher, pos:early-years-teacher, none | **pivot** | pos:politics-lecturer | none 0.38, none 0.38 | teacher → pos:politics-lecturer (in the band) | pos:higher-education-lecturer "Professora universitária" pt 0.826; pos:music-instructor "Professora de Música" pt 0.808; pos:music-teacher "Professora de Música" pt 0.808; pos:medicine-lecturer "Professora de Medicina" pt 0.803; pos:law-lecturer "Professora de Direito" pt 0.799 |
| generic name | Maestra | es, mx-cmx | pos:primary-school-teacher, pos:secondary-school-teacher, pos:early-years-teacher, none | unmatched | — | none 0.83, none 0.83 | teacher → pos:politics-lecturer (in the band) | pos:webmaster "maestra web" es 0.773; pos:head-waiter-head-waitress "maestresala" es 0.748; pos:hotel-butler "maestresala" es 0.748; pos:musical-conductor "maestro/maestrina" pt 0.691; pos:cider-master "maestra de sidra" es 0.691 |
| generic name | Torneiro mecânico | pt, br-sp | pos:fitter-and-turner, pos:lathe-and-turning-machine-operator, pos:metalworking-lathe-operator | chosen | pos:fitter-and-turner | pos:fitter-and-turner 0.76, none 0.03 | machinist → pos:tyre-fitter (in the band) | pos:industrial-machinery-mechanic "Mecânico industrial" pt 0.786; pos:mechanical-engineer "Engenheiro mecânico" pt 0.771; pos:electromechanical-engineer "Engenheiro mecânico" pt 0.771; pos:fitter-and-turner "Torneiro" pt 0.765; pos:woodturner "Torneiro de madeiras" pt 0.755 |
| generic name | Supervisora | pt, br-sp | none | **chosen** | pos:production-supervisor | pos:production-supervisor 0.64, none 0.11 | supervisor → pos:oil-refinery-control-room-operator | pos:kennel-supervisor "supervisora de perrera" es 0.776; pos:script-supervisor "Supervisora de guião" pt 0.773; pos:plumbing-supervisor "Supervisora de canalização" pt 0.768; pos:oil-refinery-control-room-operator "supervisor" en 0.763; pos:production-supervisor "Supervisora de produção" pt 0.741 |
| label | Instructor | es, mx-cmx | none | **label** | pos:air-force-officer | — | — | — |
| label | Valet | es, mx-cmx | pos:parking-valet, none | **label** | pos:room-attendant | — | — | — |
| label | Coach | pt, br-sp | pos:life-coach, pos:sports-coach | label | pos:life-coach | — | — | — |

What Clef was told (the state and the `match` criteria), for the first string of each group that reached it:

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Encanador

c0: assayer (matched "Ensaiador", Portuguese)
c1: bulk filler (matched "Enfardador", Portuguese)
c2: ambassador (matched "Enbaixador", Portuguese)
c3: fitter and turner (matched "Afinador", Portuguese)
c4: carpet fitter (matched "enmoquetador", Spanish)
c5: plumber
none: None of these: a different occupation
```

```
An occupation written in American English by a worker in the United States (us-tx):
Instructor

c0: air force officer (matched "instructor", Spanish)
c1: armed forces training and education officer (matched "Instrutor militar", Portuguese)
c2: zoo educator (matched "educator", English)
c3: fitness instructor (matched "Instrutor de fitness", Portuguese)
c4: sports instructor
none: None of these: a different occupation
```

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Professora

c0: higher education lecturer (matched "Professora universitária", Portuguese)
c1: music instructor (matched "Professora de Música", Portuguese)
c2: music teacher (matched "Professora de Música", Portuguese)
c3: medicine lecturer (matched "Professora de Medicina", Portuguese)
c4: law lecturer (matched "Professora de Direito", Portuguese)
c5: politics lecturer (matched "teacher", English)
none: None of these: a different occupation
```
