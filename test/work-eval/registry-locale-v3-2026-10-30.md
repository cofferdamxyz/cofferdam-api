# Regional words and false friends on the v3 replica, 2026-10-30

23 synthetic strings (`test/fixtures/work/locale-cases.json`), each with the market of the worker who wrote it, snapped against the v3 generation's registry (`test/work-eval/replica.ts`: the ESCO import's and the US layer's SQL, 16978 tokens and 230108 labels, no certificate token; 229654 vectors of EmbeddingGemma 2 at 768, a national label's region kept), each string embedded as the phone embeds it (`gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0` through llama-embedding, a query and a document), with `@cf/cloudflare/clef-flash` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` over the Workers AI REST API from the Mac. τ_auto 0.96, τ_low 0.81. Three arms on the same registry and vectors: **before**, the hosted requests as they were before the locale (cofferdam-api 16ab6a8: Clef told the language's code, no language beside a matched label, the pivot given the bare string); **language**, production's requests with no market; **market**, production's with the listing's market. Right: one of the expected tokens, or, where no token fits, none or a new one; a false friend is the token ESCO's Spanish or Portuguese gives the word.

| Group | Before | Language | Market (production) |
|---|---|---|---|
| regional | 12 of 15 right, 0 false friend, 3 other | 14 of 15 right, 0 false friend, 1 other | 13 of 15 right, 0 false friend, 2 other |
| false friend | 2 of 5 right, 1 false friend, 2 other | 3 of 5 right, 0 false friend, 2 other | 2 of 5 right, 0 false friend, 3 other |
| label | 1 of 3 right, 2 false friend, 0 other | 1 of 3 right, 2 false friend, 0 other | 1 of 3 right, 2 false friend, 0 other |
| all | 15 of 23 | 18 of 23 | 16 of 23 |

Cost per snap 0.000042 USD (the embeddings are the Mac's). 0 snaps ran again after a hosted call threw; none still failed.

Clef's band answers, read again at other floors (the shipped floor is 0.5), per arm:

**before**, 19 answers:

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 10 | 4 | 1 | 4 |
| 0.4 | 10 | 1 | 1 | 7 |
| 0.5 | 7 | 0 | 1 | 11 |
| 0.6 | 6 | 0 | 1 | 12 |
| 0.7 | 5 | 0 | 0 | 14 |
| 0.8 | 2 | 0 | 0 | 17 |

**language**, 19 answers:

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 10 | 6 | 2 | 1 |
| 0.4 | 8 | 2 | 1 | 8 |
| 0.5 | 7 | 1 | 1 | 10 |
| 0.6 | 6 | 1 | 1 | 11 |
| 0.7 | 2 | 0 | 0 | 17 |
| 0.8 | 1 | 0 | 0 | 18 |

**market**, 19 answers:

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 9 | 4 | 4 | 2 |
| 0.4 | 9 | 3 | 2 | 5 |
| 0.5 | 8 | 3 | 2 | 6 |
| 0.6 | 7 | 3 | 2 | 7 |
| 0.7 | 4 | 0 | 1 | 14 |
| 0.8 | 2 | 0 | 1 | 16 |

| Group | String | Language, market | Expected | Before | Language | Market (production) |
|---|---|---|---|---|---|---|
| regional | Encanador | pt, br-sp | pos:plumber | pivot pos:plumber; Clef pos:hardwood-floor-layer 0.36, none 0.27; pivot "plumber" | pivot pos:plumber; Clef none 0.36, none 0.36; pivot "plumber" | pivot pos:plumber; Clef none 0.61, none 0.61; pivot "plumber" |
| regional | Bombeiro hidráulico | pt, br-rj | pos:plumber | **pivot pos:firefighter**; Clef pos:firefighter 0.29, none 0.21; pivot "firefighter" | pivot pos:plumber; Clef pos:firefighter 0.39, none 0.21; pivot "plumber" | **chosen pos:firefighter**; Clef pos:firefighter 0.61, none 0.10 |
| regional | Terceiro Oficial de Máquinas | pt, br-rj | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | chosen pos:marine-engineer; Clef pos:marine-engineer 0.69, none 0.03 | chosen pos:marine-engineer; Clef pos:marine-engineer 0.63, none 0.06 | chosen pos:marine-engineer; Clef pos:marine-engineer 0.69, none 0.05 |
| regional | Garçom | pt, br-sp | pos:waiter-waitress | pivot pos:waiter-waitress; Clef pos:bartender 0.26, none 0.23; pivot "waiter" | pivot pos:waiter-waitress; Clef pos:restaurant-host-restaurant-hostess 0.40, none 0.26; pivot "waiter" | pivot pos:waiter-waitress; Clef none 0.36, none 0.36; pivot "waiter" |
| regional | Caminhoneiro | pt, br-pr | pos:cargo-vehicle-driver | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.82, none 0.03 | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.59, none 0.05 | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.77, none 0.03 |
| regional | Operador de empilhadeira | pt, br-sp | pos:forklift-operator | chosen pos:forklift-operator; Clef pos:forklift-operator 0.79, none 0.04 | chosen pos:forklift-operator; Clef pos:forklift-operator 0.77, none 0.05 | chosen pos:forklift-operator; Clef pos:forklift-operator 0.81, none 0.04 |
| regional | Frentista | pt, br-mg | pos:fuel-station-specialised-seller | **minted pos:gas-station-attendant**; pivot "gas station attendant" | **minted pos:gas-station-attendant**; pivot "gas station attendant" | **minted pos:gas-station-attendant**; pivot "gas station attendant" |
| regional | Motorista de ônibus | pt, br-sp | pos:bus-driver | chosen pos:bus-driver; Clef pos:bus-driver 0.94, none 0.06 | chosen pos:bus-driver; Clef pos:bus-driver 0.88, none 0.12 | chosen pos:bus-driver; Clef pos:bus-driver 0.93, none 0.07 |
| regional | Auxiliar de cozinha | pt, br-sp | pos:kitchen-assistant, pos:kitchen-porter | pivot pos:kitchen-assistant; Clef pos:kitchen-assistant 0.48, none 0.02; pivot "kitchen assistant" | pivot pos:kitchen-assistant; Clef pos:kitchen-assistant 0.34, none 0.04; pivot "kitchen assistant" | pivot pos:kitchen-assistant; Clef pos:kitchen-assistant 0.47, none 0.04; pivot "kitchen assistant" |
| regional | Soldador de Tubulação | pt, br-rj | pos:pipe-welder, pos:welder | chosen pos:pipe-welder; Clef pos:pipe-welder 0.75, none 0.05 | chosen pos:pipe-welder; Clef pos:pipe-welder 0.66, none 0.07 | chosen pos:pipe-welder; Clef pos:pipe-welder 0.66, none 0.06 |
| regional | Plomero | es, mx-nle | pos:plumber | pivot pos:plumber; Clef pos:plumber 0.43, none 0.11; pivot "plumber" | pivot pos:plumber; Clef pos:plumber 0.48, none 0.09; pivot "plumber" | chosen pos:plumber; Clef pos:plumber 0.55, none 0.06 |
| regional | Tercer Ingeniero | es, mx-ver | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | pivot pos:marine-engineer; Clef pos:ship-assistant-engineer 0.50, none 0.14; pivot "marine engineer" | pivot pos:marine-engineer; Clef pos:ship-assistant-engineer 0.40, none 0.13; pivot "marine engineer" | pivot pos:marine-engineer; Clef pos:mechanical-engineer 0.29, none 0.20; pivot "marine engineer" |
| regional | Mesero | es, mx-cmx | pos:waiter-waitress | chosen pos:waiter-waitress; Clef pos:waiter-waitress 0.57, none 0.07 | chosen pos:waiter-waitress; Clef pos:waiter-waitress 0.61, none 0.05 | chosen pos:waiter-waitress; Clef pos:waiter-waitress 0.70, none 0.04 |
| regional | Camionero | es, mx-nle | pos:cargo-vehicle-driver | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.74, none 0.03 | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.68, none 0.05 | chosen pos:cargo-vehicle-driver; Clef pos:cargo-vehicle-driver 0.72, none 0.03 |
| regional | Montacarguista | es, mx-nle | pos:forklift-operator | **pivot pos:stevedore**; Clef none 0.64, none 0.64; pivot "stevedore" | pivot pos:forklift-operator; Clef none 0.66, none 0.66; pivot "forklift operator" | pivot pos:forklift-operator; Clef none 0.87, none 0.87; pivot "forklift operator" |
| false friend | Instructor | en, us-tx | none | **pivot pos:politics-lecturer**; Clef pos:higher-education-lecturer 0.35, none 0.15; pivot "teacher" | unmatched —; Clef pos:higher-education-lecturer 0.37, none 0.17; pivot "instructor" | **chosen pos:higher-education-lecturer**; Clef pos:higher-education-lecturer 0.66, none 0.05 |
| false friend | Coach | en, us-tx | pos:sports-coach, none | unmatched —; Clef pos:carriage-driver 0.44, none 0.09; pivot "coach" | **chosen pos:carriage-driver**; Clef pos:carriage-driver 0.64, none 0.05 | unmatched —; Clef pos:bus-driver 0.33, none 0.16; pivot "coach" |
| false friend | Valet | en, us-fl | pos:parking-valet, none | **pivot pos:civil-enforcement-officer**; Clef pos:room-attendant 0.25, none 0.14; pivot "parking attendant" | **pivot pos:civil-enforcement-officer**; Clef pos:private-chauffeur 0.38, none 0.14; pivot "parking attendant" | **pivot pos:civil-enforcement-officer**; Clef pos:hotel-porter 0.30, none 0.10; pivot "parking attendant" |
| false friend | Compositor | en, us-ca | pos:typesetter, pos:digital-artist, none | **pivot pos:composer**; Clef pos:desktop-publisher 0.34, none 0.22; pivot "composer" | pivot pos:typesetter; Clef pos:desktop-publisher 0.30, none 0.23; pivot "typesetter" | **chosen pos:desktop-publisher**; Clef pos:desktop-publisher 0.63, none 0.15 |
| false friend | Instrutor | pt, br-sp | none | unmatched —; Clef pos:ski-instructor 0.28, none 0.28; pivot "instructor" | unmatched —; Clef pos:horse-riding-instructor 0.23, none 0.22; pivot "instructor" | unmatched —; Clef none 0.32, none 0.32; pivot "instructor" |
| label | Instructor | es, mx-cmx | none | **label pos:air-force-officer** | **label pos:air-force-officer** | **label pos:air-force-officer** |
| label | Valet | es, mx-cmx | pos:parking-valet, none | **label pos:room-attendant** | **label pos:room-attendant** | **label pos:room-attendant** |
| label | Coach | pt, br-sp | pos:life-coach, pos:sports-coach | label pos:life-coach | label pos:life-coach | label pos:life-coach |

The nearest candidates (token, matched label, its language and a national label's region, cosine), the same in every arm:

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
| Instructor (en) | pos:air-force-officer "instructor" es 0.958; pos:zoo-educator "education instructor" en 0.926; pos:higher-education-lecturer "Educational Instructor" en-us 0.923; pos:politics-lecturer "Government Instructor" en-us 0.910; pos:secondary-school-teacher "English Instructor" en-us 0.910 |
| Coach (en) | pos:life-coach "Coach" pt 0.970; pos:sports-coach "Track Coach" en-us 0.909; pos:carriage-driver "coachman" en 0.901; pos:bus-driver "coach driver" en 0.899; pos:business-coach "Coach profissional" pt 0.899 |
| Valet (en) | pos:room-attendant "valet" es 0.898; pos:parking-valet "Valet Driver" en-us 0.895; pos:private-chauffeur "private valet" en 0.860; pos:hotel-butler "Mordomo" pt 0.831; pos:hotel-porter "bellboy" en 0.828 |
| Compositor (en) | pos:composer "Compositor" pt 0.970; pos:desktop-publisher "Computer Compositor" en-us 0.931; pos:digital-artist "Compositor digital" pt 0.871; pos:imagesetter "compositora de imágenes" es 0.846; pos:lyricist "composer-lyricist" en 0.834 |
| Instrutor (pt) | pos:air-force-officer "instructor" es 0.907; pos:armed-forces-training-and-education-officer "Instrutor militar" pt 0.904; pos:ski-instructor "Instrutor  de equi" pt 0.889; pos:animal-handler "Instrutor de animais" pt 0.882; pos:horse-riding-instructor "Instrutor de equitação" pt 0.879 |
| Instructor (es) | — |
| Valet (es) | — |
| Coach (pt) | — |

What Clef was told in production's arm (the state and the `match` criteria), for the first string of each group that reached it:

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Encanador

c0: bulk filler (matched "Enfardador", Portuguese)
c1: carpet fitter (matched "enmoquetador", Spanish)
c2: hardwood floor layer (matched "entarimador", Spanish)
c3: derrickhand (matched "encuellador", Spanish)
c4: assayer (matched "ensayador", Spanish)
none: None of these: a different occupation
```

```
An occupation written in American English by a worker in the United States (us-tx):
Instructor

c0: air force officer (matched "instructor", Spanish)
c1: zoo educator (matched "education instructor", English)
c2: higher education lecturer (matched "Educational Instructor", American English)
c3: politics lecturer (matched "Government Instructor", American English)
c4: secondary school teacher (matched "English Instructor", American English)
none: None of these: a different occupation
```
