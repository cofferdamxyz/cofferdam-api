# Regional words and false friends on ESCO, 2026-10-26

23 synthetic strings (`test/fixtures/work/locale-cases.json`), each with the market of the worker who wrote it, snapped against ESCO v1.2.1's occupations as loaded (3039 tokens, 62598 labels in en, pt and es; `test/work-eval/escoRegistry.ts`), each against the registry as loaded, with `@cf/google/embeddinggemma-300m`, `@cf/cloudflare/clef-flash` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast` over the Workers AI REST API from the Mac. τ_auto 0.81, τ_low 0.45. Right: one of the expected tokens, or, where no token fits, none or a new one; a false friend is the token ESCO's Spanish or Portuguese gives the word.

| Group | Right | A false friend | Another token |
|---|---|---|---|
| regional | 12 of 15 | 0 | 3 |
| false friend | 2 of 5 | 0 | 3 |
| label | 1 of 3 | 2 | 0 |

Cost per snap 0.000046 USD. 0 snaps ran again after a hosted call threw; none still failed.

Clef answered 19 strings in the band. Each answer read again at other floors (the shipped floor is 0.5):

| Floor | Picked an expected token | Picked another | None | Below the floor |
|---|---|---|---|---|
| 0.3 | 10 | 5 | 3 | 1 |
| 0.4 | 9 | 4 | 3 | 3 |
| 0.5 | 6 | 2 | 3 | 8 |
| 0.6 | 6 | 1 | 2 | 10 |
| 0.7 | 6 | 0 | 2 | 11 |
| 0.8 | 4 | 0 | 1 | 14 |

| Group | String | Language, market | Expected | Decision | Token | Clef band answer | Pivot | Nearest candidates (token, matched label, language, cosine) |
|---|---|---|---|---|---|---|---|---|
| regional | Encanador | pt, br-sp | pos:plumber | pivot | pos:plumber | none 0.83, none 0.83 | plumber | pos:carpet-fitter "enmoquetadora" es 0.566; pos:derrickhand "encuelladora" es 0.546; pos:bulk-filler "Enfardador" pt 0.479; pos:followspot-operator "cañonero/cañonera" es 0.470; pos:assayer "ensayador" es 0.463 |
| regional | Bombeiro hidráulico | pt, br-rj | pos:plumber | **chosen** | pos:firefighter | pos:firefighter 0.51, none 0.11 | — | pos:industrial-firefighter "Bombeiro industrial" pt 0.549; pos:water-engineer "hydraulic engineer" en 0.546; pos:marine-firefighter "bombera de brigada acuática" es 0.536; pos:pump-operator "fire engine pump operator" en 0.533; pos:firefighter "Bombeiro" pt 0.530 |
| regional | Terceiro Oficial de Máquinas | pt, br-rj | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | chosen | pos:ship-assistant-engineer | pos:ship-assistant-engineer 0.83, none 0.03 | — | pos:marine-mechanic "oficial de máquinas" es 0.658; pos:deck-officer "primer oficial de máquinas" es 0.577; pos:ship-assistant-engineer "third assistant engineer" en 0.519; pos:mechanical-engineer "machinery engineer" en 0.497; pos:offset-printer "maquinista offset" es 0.497 |
| regional | Garçom | pt, br-sp | pos:waiter-waitress | pivot | pos:waiter-waitress | — | waiter | pos:security-guard "garage security guard" en 0.448; pos:chef "commis chef" en 0.429; pos:carpenter-supervisor "carpentry foreman" en 0.423; pos:tailor "garment worker" en 0.420; pos:carpenter "Carpinteiro" pt 0.420 |
| regional | Caminhoneiro | pt, br-pr | pos:cargo-vehicle-driver | chosen | pos:cargo-vehicle-driver | pos:cargo-vehicle-driver 0.83, none 0.04 | — | pos:vehicle-technician "técnico de veículos pesados" pt 0.555; pos:coachbuilder "Carroçador" pt 0.554; pos:cargo-vehicle-driver "trucker" en 0.550; pos:tow-truck-driver "motorista de reboques" pt 0.550; pos:room-attendant "Camareiro" pt 0.500 |
| regional | Operador de empilhadeira | pt, br-sp | pos:forklift-operator | chosen | pos:forklift-operator | pos:forklift-operator 0.85, none 0.03 | — | pos:forklift-operator "operator of forklift trucks" en 0.655; pos:high-rigger "operador de montacargas" es 0.630; pos:pile-driving-hammer-operator "pile-driver operator" en 0.626; pos:wood-pallet-maker "pallet machine operator" en 0.620; pos:warehouse-worker "warehouse operator" en 0.618 |
| regional | Frentista | pt, br-mg | pos:fuel-station-specialised-seller | **minted** | pos:gas-station-attendant | none 0.58, none 0.58 | gas station attendant | pos:monk-nun "Freira" pt 0.477; pos:structural-ironworker "ferrallista" es 0.473; pos:sheet-metal-worker "chapista" es 0.443; pos:phlebotomist "Flebotomista" pt 0.431; pos:production-plant-crane-operator "gruista" es 0.429 |
| regional | Motorista de ônibus | pt, br-sp | pos:bus-driver | chosen | pos:bus-driver | pos:bus-driver 0.76, none 0.02 | — | pos:bus-driver "driver of bus" en 0.662; pos:trolley-bus-driver "bus operator" en 0.612; pos:bus-driving-instructor "bus driver instructor" en 0.577; pos:vehicle-technician "bus technician" en 0.576 |
| regional | Auxiliar de cozinha | pt, br-sp | pos:kitchen-assistant, pos:kitchen-porter | pivot | pos:kitchen-assistant | pos:kitchen-assistant 0.48, none 0.04 | kitchen assistant | pos:kitchen-porter "auxiliar de cocina" es 0.670; pos:kitchen-assistant "asistente de cocina" es 0.643; pos:food-service-worker "kitchen assistant" en 0.642; pos:maternity-support-worker "auxiliar de comadrona" es 0.600; pos:steward-stewardess "auxiliar" es 0.544 |
| regional | Soldador de Tubulação | pt, br-rj | pos:pipe-welder, pos:welder | **unmatched** | — | pos:pipe-welder 0.39, none 0.09 | pipefitter | pos:pipe-welder "soldador de tuberías" es 0.682; pos:welder "soldador/soldadora" es 0.608; pos:solderer "soldadora" es 0.598; pos:laser-beam-welder "laser tube welder" en 0.595 |
| regional | Plomero | es, mx-nle | pos:plumber | pivot | pos:plumber | pos:plumber 0.42, none 0.06 | plumber | pos:plumber "plumbber" en 0.585; pos:plumbing-supervisor "plumbing foreman" en 0.543; pos:pipe-welder "plumber" en 0.542; pos:coppersmith "pipe fabricator" en 0.500; pos:drain-technician "sewer pipe repairer" en 0.491 |
| regional | Tercer Ingeniero | es, mx-ver | pos:marine-engineer, pos:ship-duty-engineer, pos:ship-assistant-engineer | pivot | pos:marine-engineer | pos:civil-engineer 0.40, none 0.09 | marine engineer | pos:ship-assistant-engineer "third assistant engineer" en 0.723; pos:military-engineer "ingeniero del ejercito" es 0.513; pos:bridge-construction-supervisor "ingeniera civil" es 0.500; pos:civil-engineer "ingeniera civil" es 0.500; pos:civil-engineering-technician "ingeniera técnica civil" es 0.495 |
| regional | Mesero | es, mx-cmx | pos:waiter-waitress | chosen | pos:waiter-waitress | pos:waiter-waitress 0.73, none 0.05 | — | pos:bartender "camarero" es 0.539; pos:waiter-waitress "table waiter" en 0.539; pos:head-waiter-head-waitress "camarero jefe" es 0.507; pos:room-attendant "camarero de pisos" es 0.490; pos:kitchen-porter "kitchen steward" en 0.477 |
| regional | Camionero | es, mx-nle | pos:cargo-vehicle-driver | chosen | pos:cargo-vehicle-driver | pos:cargo-vehicle-driver 0.81, none 0.03 | — | pos:vehicle-technician "mecánica de camiones" es 0.561; pos:tow-truck-driver "camionero de remolque" es 0.559; pos:coachbuilder "carrocero/carrocera" es 0.551; pos:cargo-vehicle-driver "trucker" en 0.548; pos:vehicle-cleaner "truck valeter" en 0.537 |
| regional | Montacarguista | es, mx-nle | pos:forklift-operator | pivot | pos:forklift-operator | none 0.72, none 0.72 | forklift operator | pos:marine-fitter "montador naval" pt 0.501; pos:coachbuilder "carrocera" es 0.484; pos:bicycle-assembler "montador de monociclos" es 0.475; pos:tent-installer "montador de carpas" es 0.474; pos:construction-scaffolder "montador de andamios" es 0.468 |
| false friend | Instructor | en, us-tx | none | **pivot** | pos:politics-lecturer | pos:music-teacher 0.43, none 0.18 | teacher | pos:air-force-officer "instructor" es 0.726; pos:zoo-educator "education instructor" en 0.686; pos:music-teacher "instructor of music" en 0.662; pos:medicine-lecturer "medicine instructor" en 0.654; pos:armed-forces-training-and-education-officer "instructor militar" es 0.652 |
| false friend | Coach | en, us-tx | pos:sports-coach, none | unmatched | — | pos:sports-coach 0.44, none 0.19 | coach | pos:life-coach "coach" es 0.700; pos:horse-riding-instructor "riding coach" en 0.663; pos:groom "riding coach" en 0.663; pos:sports-coach "sport coach" en 0.644; pos:automotive-engineer "coach designer" en 0.620 |
| false friend | Valet | en, us-fl | pos:parking-valet, none | **pivot** | pos:civil-enforcement-officer | pos:hotel-butler 0.28, none 0.11 | parking attendant | pos:room-attendant "valet" es 0.772; pos:private-chauffeur "personal valet" en 0.663; pos:parking-valet "parking valet" en 0.654; pos:hotel-butler "hotel butler" en 0.580; pos:vehicle-cleaner "car valeter" en 0.573 |
| false friend | Compositor | en, us-ca | pos:typesetter, pos:digital-artist, none | pivot | pos:typesetter | pos:imagesetter 0.36, none 0.31 | typesetter | pos:composer "Compositor" pt 0.791; pos:digital-artist "Compositor digital" pt 0.691; pos:imagesetter "compositor de imágenes" es 0.580; pos:sound-designer "composer and sound designer" en 0.579; pos:lyricist "composer-lyricist" en 0.557 |
| false friend | Instrutor | pt, br-sp | none | **chosen** | pos:armed-forces-training-and-education-officer | pos:armed-forces-training-and-education-officer 0.68, none 0.22 | — | pos:air-force-officer "instructora" es 0.604; pos:armed-forces-training-and-education-officer "Instrutor militar" pt 0.566; pos:aircraft-maintenance-technician "aircraft instrument operator" en 0.555; pos:aircraft-interior-technician "aircraft interior instrument operator" en 0.546; pos:guitar-maker "stringed instrument inspector" en 0.542 |
| label | Instructor | es, mx-cmx | none | **label** | pos:air-force-officer | — | — | — |
| label | Valet | es, mx-cmx | pos:parking-valet, none | **label** | pos:room-attendant | — | — | — |
| label | Coach | pt, br-sp | pos:life-coach, pos:sports-coach | label | pos:life-coach | — | — | — |

What Clef was told (the state and the `match` criteria), for the first string of each group that reached it:

```
An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):
Encanador

c0: carpet fitter (matched "enmoquetadora", Spanish)
c1: derrickhand (matched "encuelladora", Spanish)
c2: bulk filler (matched "Enfardador", Portuguese)
c3: followspot operator (matched "cañonero/cañonera", Spanish)
c4: assayer (matched "ensayador", Spanish)
none: None of these: a different occupation
```

```
An occupation written in American English by a worker in the United States (us-tx):
Instructor

c0: air force officer (matched "instructor", Spanish)
c1: zoo educator (matched "education instructor", English)
c2: music teacher (matched "instructor of music", English)
c3: medicine lecturer (matched "medicine instructor", English)
c4: armed forces training and education officer (matched "instructor militar", Spanish)
none: None of these: a different occupation
```
