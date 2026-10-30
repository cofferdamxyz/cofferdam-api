# The job profile on short requests, 2026-10-30

62 short requests, each read by `@cf/deepseek-ai/deepseek-v4.1-flash-1017` (`work-job-profile`) with reasoning off and at low effort, over the Workers AI REST API from the Mac: the 23 requests for a worker of `test/chat-eval/hire-prompts.json` (in the market of their language: us-tx, br-sp, mx-cmx), and the 39 strings of `test/fixtures/work/locale-cases.json` as vacancy headlines in their own market ("Hiring: …", "Contrata-se …", "Se solicita …"). Each English occupation snapped on the v2 replica (ESCO and the US layer; English, never minting, with litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm's vectors from the Mac), and a locale string is right when its occupation snaps to one of the fixture's expected tokens, or, where the fixture allows none, when an occupation was read and snapped to nothing. A reading that names no occupation is counted apart.

- **Reasoning off:** 25 of 39 right, 11 wrong, 3 with no occupation read (3 of them where the fixture allows none), 0 failed reads and 0 failed snaps; median 1357 ms and 58 output tokens, 1 failed after six tries.
- **Low effort:** 30 of 39 right, 9 wrong, 0 with no occupation read (0 of them where the fixture allows none), 0 failed reads and 0 failed snaps; median 3483 ms and 368 output tokens, 0 failed after six tries.

| Request | Expected | Reasoning off: occupation → token | Low effort: occupation → token |
|---|---|---|---|
| Hi, I am looking for a plumber to fix my sink | — | plumber → pos:plumber | plumber → pos:plumber |
| I need an electrician tomorrow morning to install two outlets, budget 120 dollars | — | electrician → pos:electrician | electrician → pos:electrician |
| Looking to hire a welder for a 3-week shutdown in Houston, must hold a 6G certification | — | welder → — | welder → — |
| Can someone come clean my apartment this Saturday? I'll pay $80 | — | apartment cleaner → — | residential cleaner → pos:domestic-cleaner |
| We're hiring a forklift operator for the night shift, 2 years of experience required | — | forklift operator → pos:forklift-operator | forklift operator → pos:forklift-operator |
| Need a babysitter for Friday night | — | babysitter → pos:babysitter | babysitter → pos:babysitter |
| urgent: I need someone to fix a gas leak today | — | gas fitter → pos:plumber | gas leak repair technician → pos:gas-service-technician |
| I want to post a job for a graphic designer to make our logo, remote | — | graphic designer → pos:graphic-designer | graphic designer → pos:graphic-designer |
| Who can paint my fence next week? Around 200 bucks | — | fence painter → — | fence painter → — |
| Maintenance Technician, full time. We are looking for a maintenance technician for our foo | — | maintenance technician → pos:laser-beam-welder | maintenance technician → pos:laser-beam-welder |
| can you find someone to fix it tomorrow? | — | no occupation → — | no occupation → — |
| Oi, preciso de um encanador para consertar a pia da cozinha | — | plumber → pos:plumber | plumber → pos:plumber |
| Procuro eletricista para instalar um chuveiro amanhã, pago 150 reais | — | electrician → pos:electrician | electrician → pos:electrician |
| Estou contratando motoboy para entregas no centro de São Paulo | — | delivery motorcycle courier → pos:motorcycle-delivery-person | motorcycle courier → pos:motorcycle-delivery-person |
| Preciso de uma faxineira toda sexta-feira | — | cleaner → pos:domestic-cleaner | house cleaner → pos:domestic-cleaner |
| Vaga: soldador TIG com NR-34, 2 anos de experiência, em Macaé | — | tig welder → pos:welder | tig welder → pos:welder |
| Auxiliar de Cozinha. Restaurante em Pinheiros contrata auxiliar de cozinha. Atividades: pr | — | kitchen assistant → pos:kitchen-assistant | kitchen assistant → pos:kitchen-assistant |
| Hola, busco un plomero para arreglar el lavabo | — | plumber → pos:plumber | plumber → pos:plumber |
| Necesito un velador para mi bodega en Monterrey, turno de noche | — | failed | night watchman → pos:security-guard |
| Se solicita mesero con experiencia para restaurante en la CDMX | — | waiter → pos:waiter-waitress | waiter → pos:waiter-waitress |
| ¿Alguien que me pueda pintar la casa este fin de semana? Pago 2000 pesos | — | house painter → pos:construction-painter | house painter → pos:construction-painter |
| Contratamos chofer con licencia federal tipo E | — | truck driver → pos:cargo-vehicle-driver | truck driver → pos:cargo-vehicle-driver |
| Técnico Electricista. Empresa de servicios en Guadalajara solicita técnico electricista. F | — | electrician → pos:electrician | electrical technician → pos:electrical-engineering-technician |
| Contrata-se Encanador | plumber | plumber → pos:plumber | plumber → pos:plumber |
| Contrata-se Bombeiro hidráulico | plumber | plumber → pos:plumber | plumber → pos:plumber |
| Contrata-se Terceiro Oficial de Máquinas | marine-engineer, ship-duty-engineer, ship-assistant-engineer | third engineer (marine) → pos:marine-engineer | marine engineer officer → pos:marine-engineer |
| Contrata-se Garçom | waiter-waitress | waiter → pos:waiter-waitress | waiter → pos:waiter-waitress |
| Contrata-se Caminhoneiro | cargo-vehicle-driver | truck driver → pos:cargo-vehicle-driver | truck driver → pos:cargo-vehicle-driver |
| Contrata-se Operador de empilhadeira | forklift-operator | forklift operator → pos:forklift-operator | forklift operator → pos:forklift-operator |
| Contrata-se Frentista | fuel-station-specialised-seller | **gas station attendant → —** | **gas station attendant → —** |
| Contrata-se Motorista de ônibus | bus-driver | bus driver → pos:bus-driver | bus driver → pos:bus-driver |
| Contrata-se Auxiliar de cozinha | kitchen-assistant, kitchen-porter | kitchen assistant → pos:kitchen-assistant | kitchen assistant → pos:kitchen-assistant |
| Contrata-se Soldador de Tubulação | pipe-welder, welder | pipe welder → pos:pipe-welder | pipe welder → pos:pipe-welder |
| Se solicita Plomero | plumber | plumber → pos:plumber | plumber → pos:plumber |
| Se solicita Tercer Ingeniero | marine-engineer, ship-duty-engineer, ship-assistant-engineer | **third engineer → —** | **third engineer → —** |
| Se solicita Mesero | waiter-waitress | waiter → pos:waiter-waitress | waiter → pos:waiter-waitress |
| Se solicita Camionero | cargo-vehicle-driver | truck driver → pos:cargo-vehicle-driver | truck driver → pos:cargo-vehicle-driver |
| Se solicita Montacarguista | forklift-operator | forklift operator → pos:forklift-operator | forklift operator → pos:forklift-operator |
| Se solicita Tablajero | butcher | **meat cutter → pos:meat-cutter** | **meat cutter → pos:meat-cutter** |
| Contrata-se Borracheiro | tyre-vulcaniser, tyre-fitter | tire repairer → pos:tyre-vulcaniser | tire repairer → pos:tyre-vulcaniser |
| Se solicita Vulcanizador | tyre-vulcaniser, tyre-fitter | tire repairer → pos:tyre-vulcaniser | tire repairer → pos:tyre-vulcaniser |
| Contrata-se Gesseiro | plasterer, ceiling-installer | **drywall installer → —** | plasterer → pos:plasterer |
| Contrata-se Babá | nanny, babysitter | nanny → pos:nanny | nanny → pos:nanny |
| Se solicita Velador | security-guard | security guard → pos:security-guard | night watchman → pos:security-guard |
| Contrata-se Motoboy | motorcycle-delivery-person | delivery motorcycle rider → pos:motorcycle-delivery-person | motorcycle courier → pos:motorcycle-delivery-person |
| Se solicita Lavaloza | kitchen-porter | dishwasher → pos:kitchen-porter | dishwasher → pos:kitchen-porter |
| Se solicita Hojalatero | refurbishing-technician | **sheet metal worker → pos:sheet-metal-worker** | **sheet metal worker → pos:sheet-metal-worker** |
| Se solicita Bodeguero | warehouse-worker, warehouse-order-picker | **warehouse keeper → —** | **warehouse keeper → —** |
| Contrata-se Faxineira | domestic-cleaner, building-cleaner, domestic-housekeeper | cleaner → pos:domestic-cleaner | cleaner → pos:domestic-cleaner |
| Se solicita Afanadora | building-cleaner, domestic-cleaner | cleaner → pos:domestic-cleaner | cleaner → pos:domestic-cleaner |
| Hiring: Instructor | none | instructor → — | instructor → — |
| Hiring: Coach | sports-coach, none | no occupation → — | coach → — |
| Hiring: Valet | parking-valet, none | valet → — | valet → — |
| Hiring: Compositor | typesetter, digital-artist, none | compositor → — | compositor → — |
| Contrata-se Instrutor | none | no occupation → — | instructor → — |
| Contrata-se Professora | primary-school-teacher, secondary-school-teacher, early-years-teacher, none | **teacher → pos:politics-lecturer** | **teacher → pos:politics-lecturer** |
| Se solicita Maestra | primary-school-teacher, secondary-school-teacher, early-years-teacher, none | **teacher → pos:politics-lecturer** | **teacher → pos:politics-lecturer** |
| Contrata-se Torneiro mecânico | fitter-and-turner, lathe-and-turning-machine-operator, metalworking-lathe-operator | **cnc machinist → pos:computer-numerical-control-machine-operator** | lathe operator → pos:lathe-and-turning-machine-operator |
| Contrata-se Supervisora | none | **supervisor → pos:oil-refinery-control-room-operator** | **supervisor → pos:oil-refinery-control-room-operator** |
| Se solicita Instructor | none | no occupation → — | instructor → — |
| Se solicita Valet | parking-valet, none | valet parking attendant → pos:parking-valet | valet parking attendant → pos:parking-valet |
| Contrata-se Coach | life-coach, sports-coach | **coach → —** | **coach → —** |

Run in 5.4 minutes.
