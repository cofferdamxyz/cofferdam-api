# Regional words and false friends on ESCO, 2026-10-26

23 synthetic strings (`test/fixtures/work/locale-cases.json`), each with the market of the worker who wrote it, snapped against ESCO v1.2.1's occupations as loaded (3039 tokens, 62598 labels in en, pt and es; `test/work-eval/escoRegistry.ts`), each against the registry as loaded, with `@cf/baai/bge-m3`, `@cf/cloudflare/clef-flash` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` over the Workers AI REST API from the Mac. τ_auto 0.95, τ_low 0.6. Right: one of the expected tokens, or, where no token fits, none or a new one; a false friend is the token ESCO's Spanish or Portuguese gives the word.

| Group | Right | A false friend | Another token |
|---|---|---|---|
| regional | 10 of 15 | 0 | 5 |
| false friend | 2 of 5 | 1 | 2 |
| label | 1 of 3 | 2 | 0 |

Cost per snap 0.000041 USD. 0 snaps ran again after a hosted call threw; none still failed.

Clef answered 17 strings in the band. Each answer read again at other floors (the shipped floor is 0.5):

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 4 | 4 | 6 | 3 |
| 0.4 | 4 | 2 | 5 | 6 |
| 0.5 | 3 | 2 | 3 | 9 |
| 0.6 | 2 | 2 | 2 | 11 |
| 0.7 | 0 | 1 | 2 | 14 |
| 0.8 | 0 | 1 | 0 | 16 |

| Group | String | Language, market | Expected | Decision | Token | Clef band answer | Pivot | Nearest candidates (token, matched label, language, cosine) |
|---|---|---|---|---|---|---|---|---|
| regional | Encanador | pt, br-sp | pos:plumber | pivot | pos:plumber | pos:carpet-fitter 0.36, none 0.30 | plumber | pos:assayer "Ensaiador" pt 0.738; pos:bulk-filler "Enfardador" pt 0.734; pos:ambassador "Enbaixador" pt 0.730; pos:fitter-and-turner "Afinador" pt 0.710; pos:carpet-fitter "enmoquetador" es 0.699 |
| regional | Bombeiro hidráulico | pt, br-rj | pos:plumber | **pivot** | pos:firefighter | none 0.36, none 0.36 | firefighter | pos:fluid-power-engineer "Engenheiro hidráulico" pt 0.783; pos:water-engineer "Engenheiro hidráulico" pt 0.783; pos:marine-firefighter "Bombeiro naval" pt 0.761; pos:industrial-firefighter "Bombeiro industrial" pt 0.741; pos:hydrologist "ingeniero hidráulico" es 0.740 |
| regional | Terceiro Oficial de Máquinas | pt, br-rj | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | **chosen** | pos:marine-mechanic | pos:marine-mechanic 0.88, none 0.06 | — | pos:metal-drawing-machine-operator "Operador de máquinas de trefilagem" pt 0.648; pos:marine-mechanic "oficial de máquinas" es 0.646; pos:wholesale-merchant-in-machine-tools "mayorista de máquinas herramienta" es 0.636; pos:office-equipment-repair-technician "office machines technician" en 0.627; pos:computer-aided-design-operator "3D computer-aided manufacturing technician" en 0.622 |
| regional | Garçom | pt, br-sp | pos:waiter-waitress | pivot | pos:waiter-waitress | — | waiter | pos:circus-artist "Palhaço" pt 0.541; pos:coachbuilder "Carroçador" pt 0.521; pos:verger "Sacristão" pt 0.503; pos:upholsterer "tapicero" es 0.502; pos:hairdresser "Cabeleireiro" pt 0.501 |
| regional | Caminhoneiro | pt, br-pr | pos:cargo-vehicle-driver | pivot | pos:cargo-vehicle-driver | none 0.54, none 0.54 | truck driver | pos:cook "Cozinheiro" pt 0.745; pos:helmsman "Timoneiro" pt 0.713; pos:street-sweeper "Cantoneiro" pt 0.708; pos:sailor "Marinheiro" pt 0.702; pos:room-attendant "Camareiro" pt 0.690 |
| regional | Operador de empilhadeira | pt, br-sp | pos:forklift-operator | auto | pos:forklift-operator | — | — | pos:forklift-operator "Operador de empilhadores" pt 0.964; pos:bindery-operator "Operador de máquina de encadernação" pt 0.802; pos:excavator-operator "Operador de escavadora" pt 0.798; pos:upsetting-machine-operator "Operador de recalcadora" pt 0.791; pos:winding-machine-operator "Operador de bobinadeiras" pt 0.784 |
| regional | Frentista | pt, br-mg | pos:fuel-station-specialised-seller | **minted** | pos:gas-station-attendant | none 0.73, none 0.73 | gas station attendant | pos:dietitian "Dietista" pt 0.695; pos:geneticist "genetista" es 0.658; pos:specialist-dentist "Endontista" pt 0.648; pos:drafter "Projetista" pt 0.636; pos:cartoonist "historietista" es 0.635 |
| regional | Motorista de ônibus | pt, br-sp | pos:bus-driver | chosen | pos:bus-driver | pos:bus-driver 0.69, none 0.04 | — | pos:bus-driver "conductor de autobús" es 0.884; pos:taxi-driver "Motorista de táxis" pt 0.847; pos:trolley-bus-driver "bus operator" en 0.840 |
| regional | Auxiliar de cozinha | pt, br-sp | pos:kitchen-assistant, pos:kitchen-porter | auto | pos:kitchen-porter | — | — | pos:kitchen-porter "Ajudante de cozinha" pt 0.976; pos:kitchen-assistant "Assistente de cozinha" pt 0.965; pos:food-service-worker "kitchen assistant" en 0.843; pos:cook "encargada de cocina" es 0.819; pos:restaurant-manager "Gestor de cozinha" pt 0.805 |
| regional | Soldador de Tubulação | pt, br-rj | pos:pipe-welder, pos:welder | chosen | pos:pipe-welder | pos:pipe-welder 0.62, none 0.04 | — | pos:pipe-welder "Soldador de tubos" pt 0.833; pos:solderer "Soldador" pt 0.705; pos:welder "Soldador" pt 0.705; pos:laser-beam-welder "Soldador a laser" pt 0.700; pos:army-corporal "Soldado" pt 0.689 |
| regional | Plomero | es, mx-nle | pos:plumber | chosen | pos:plumber | pos:plumber 0.55, none 0.11 | — | pos:plumber "plummer" en 0.626; pos:milliner "sombrerero" es 0.598; pos:plate-glass-installer "cristalero" es 0.574; pos:production-potter "alfarero" es 0.567; pos:pump-operator "bombero" es 0.552 |
| regional | Tercer Ingeniero | es, mx-ver | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | pivot | pos:marine-engineer | pos:ship-assistant-engineer 0.47, none 0.11 | marine engineer | pos:ship-assistant-engineer "third assistant engineer" en 0.628; pos:military-engineer "Engenheiro do Exército" pt 0.607; pos:industrial-engineer "ingeniero industrial" es 0.606; pos:material-stress-analyst "ingeniero industrial" es 0.606; pos:mechanical-engineer "ingeniero mecánico" es 0.599 |
| regional | Mesero | es, mx-cmx | pos:waiter-waitress | pivot | pos:waiter-waitress | none 0.49, none 0.49 | waiter | pos:corporate-treasurer "tesorero" es 0.650; pos:basketmaker "cestero" es 0.635; pos:missionary "misionero" es 0.628; pos:coquille-casting-worker "machero" es 0.617; pos:moulding-machine-operator "machero" es 0.617 |
| regional | Camionero | es, mx-nle | pos:cargo-vehicle-driver | **chosen** | pos:tow-truck-driver | pos:tow-truck-driver 0.68, none 0.20 | — | pos:tow-truck-driver "camionero de remolque" es 0.711; pos:fuel-station-specialised-seller "gasolinero" es 0.692; pos:followspot-operator "cañonero" es 0.676; pos:brigadier "Brigadeiro" pt 0.646; pos:coachbuilder "Carroçador" pt 0.646 |
| regional | Montacarguista | es, mx-nle | pos:forklift-operator | **pivot** | pos:stevedore | none 0.75, none 0.75 | stevedore | pos:mineral-processing-engineer "Mineralogista" pt 0.636; pos:mineralogist "Mineralogista" pt 0.636; pos:rail-operations-manager "Maquinista" pt 0.613; pos:masseur-masseuse "Massagista" pt 0.603; pos:stage-machinist "maquinista" es 0.588 |
| false friend | Instructor | en, us-tx | none | **pivot** | pos:politics-lecturer | pos:fitness-instructor 0.28, none 0.19 | teacher | pos:air-force-officer "instructor" es 0.871; pos:armed-forces-training-and-education-officer "Instrutor militar" pt 0.844; pos:zoo-educator "educator" en 0.839; pos:fitness-instructor "Instrutor de fitness" pt 0.835; pos:sports-instructor "sports instructor" en 0.833 |
| false friend | Coach | en, us-tx | pos:sports-coach, none | unmatched | — | none 0.28, none 0.28 | coach | pos:life-coach "Coach" pt 1.000; pos:business-coach "Coach profissional" pt 0.833; pos:sports-coach "sports coach" en 0.827; pos:football-coach "football coach" en 0.817; pos:vehicle-technician "coach technician" en 0.816 |
| false friend | Valet | en, us-fl | pos:parking-valet, none | **pivot** | pos:civil-enforcement-officer | pos:private-chauffeur 0.35, none 0.16 | parking attendant | pos:room-attendant "valet" es 0.738; pos:vehicle-cleaner "car valeter" en 0.607; pos:private-chauffeur "private valet" en 0.602; pos:parking-valet "parking valet" en 0.601; pos:officer-of-the-watch "vigilante" es 0.577 |
| false friend | Compositor | en, us-ca | pos:typesetter, pos:digital-artist, none | **pivot** | pos:composer | none 0.47, none 0.47 | composer | pos:composer "Compositor" pt 1.000; pos:lyricist "composer-lyricist" en 0.804; pos:musician "cantante y compositor de canciones" es 0.752; pos:writer "Poeta" pt 0.747; pos:variety-artist "musician" en 0.724 |
| false friend | Instrutor | pt, br-sp | none | unmatched | — | pos:fitness-instructor 0.29, none 0.17 | instructor | pos:air-force-officer "instructor" es 0.876; pos:zoo-educator "educator" en 0.861; pos:armed-forces-training-and-education-officer "Instrutor militar" pt 0.852; pos:fitness-instructor "Instrutor de fitness" pt 0.838; pos:driving-instructor "Instrutor de condução" pt 0.835 |
| label | Instructor | es, mx-cmx | none | **label** | pos:air-force-officer | — | — | — |
| label | Valet | es, mx-cmx | pos:parking-valet, none | **label** | pos:room-attendant | — | — | — |
| label | Coach | pt, br-sp | pos:life-coach, pos:sports-coach | label | pos:life-coach | — | — | — |

What Clef was told (the state and the `match` criteria), for the first string of each group that reached it:

```
A occupation as a worker or a hirer wrote it, in pt:
Encanador

c0: assayer (matched "Ensaiador")
c1: bulk filler (matched "Enfardador")
c2: ambassador (matched "Enbaixador")
c3: fitter and turner (matched "Afinador")
c4: carpet fitter (matched "enmoquetador")
none: None of these: a different occupation
```

```
A occupation as a worker or a hirer wrote it, in en:
Instructor

c0: air force officer (matched "instructor")
c1: armed forces training and education officer (matched "Instrutor militar")
c2: zoo educator (matched "educator")
c3: fitness instructor (matched "Instrutor de fitness")
c4: sports instructor
none: None of these: a different occupation
```
