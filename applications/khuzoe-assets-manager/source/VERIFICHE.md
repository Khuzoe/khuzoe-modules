# Verifiche · build 0.4.3

## Qualità immagini e composizione — 15 novembre 2026

- 50 test C# e 5 test Node. Le nuove prove verificano dimensioni native, coordinate esterne, griglia, trasformazioni inverse con rotazione/specchio, budget dei ritagli, esecuzione fuori dal thread UI, riuso/evizione, annullamento dei risultati dopo cambio scena e composizione senza raddoppiare l'opacità. La quota disco elimina soltanto i ritagli ricreabili con nomi propri della cache. Identità della scena normalizzata nell'ordine delle proprietà JSON; lettura del formato precedente delle bozze verificata.
- Pipeline con FFmpeg reale: sorgente PNG 4096×3072, anteprima 1024×768 e ritaglio nativo 503×337 all'origine dispari (1231, 871). Confrontati campioni distribuiti del ritaglio con i pixel della sorgente: errore massimo ammesso di un livello su 255. Metadati nativi conservati al riuso della cache; impronta SHA-256 dell'originale invariata.
- Fixture Windows Forms completata: importazione alla dimensione nativa, dettaglio a zoom 100%, griglia 140 pixel, immagine aggiunta affiancata al bordo destro in un elemento separato e adattamento della vista anche oltre i bordi. Originali e directory Foundry simulata invariati. Non sono state eseguite generazioni AI.
- Anteprime con budget complessivo di 64 MiB; ritagli fino a 2 megapixel ciascuno e cache RAM di 64 MiB. Fino a otto immagini ricevono dettaglio per ogni vista, con priorità a quella selezionata. Un solo processo di decodifica alla volta, avviato in background dopo la navigazione; richieste superate annullate e risultati obsoleti scartati. Quota su disco di 256 MiB soltanto per i ritagli ricreabili. I decoder hanno limiti di durata, allocazione, thread e protocolli.
- I pixel originali, la trasformazione di ogni immagine e le coordinate della scena restano distinti dalle dimensioni delle cache. Questo consente future selezioni interne/esterne e aggiunte generate come immagini indipendenti; selezione di aree e collegamenti AI restano sviluppi successivi.

## Zoom con la rotellina — 14 novembre 2026

- 43 test C# e 5 test Node superati. Le tre nuove prove verificano riutilizzo dei raster durante lo scorrimento, ancoraggio al puntatore, delta piccoli e multipli, delta nullo, limiti dello zoom, eventi accorpati, ripristino della qualità e uso immediato degli strumenti. Verificati anche cambio scena e perdita della cattura del mouse durante lo spostamento della vista.
- Gli input aggiornano subito la posizione della vista; le richieste di ridisegno vengono accorpate tramite un timer dell'interfaccia a 16 ms. Durante la rotellina vengono riutilizzate le immagini disponibili e saltata la ricomposizione degli sfondi; campionamento rapido e contorni semplificati riducono il costo del fotogramma. Dopo circa 150 ms senza input torna il disegno completo. Il timer appartiene al controllo della scena e viene eliminato alla chiusura.
- I documenti della scena, le coordinate degli elementi e la cronologia non cambiano durante lo zoom. Un clic su uno strumento interrompe l'anteprima rapida; cambio scena, ridimensionamento, occultamento del controllo e chiusura fermano il timer.
- Benchmark nativo con gli eventi `OnMouseWheel` del controllo: 30 fotogrammi di zoom in/out alternato intorno allo stesso puntatore, dopo riscaldamento. Stessa fixture con 2.000 muri, 40 luci, mappa 4096×3072 e finestra 1040×780. Il dato comprende input e disegno del fotogramma, senza presentazione a schermo o cadenza del timer, e non misura gli FPS reali.

| Rotellina: tempo per fotogramma | 0.4.1 | 0.4.2 |
| --- | ---: | ---: |
| Mediana | 48,81 ms | 17,01 ms |
| 95° percentile | 51,56 ms | 18,35 ms |

Il rendering a qualità completa resta quello dell'editor; la correzione riguarda il lavoro eseguito ripetutamente durante la rotellina. Non sono stati aperti o modificati mondi reali nelle prove.

## Reattività dell'editor — 14 novembre 2026

- 40 test C# e 5 test Node superati. Cinque prove nuove coprono scrittura asincrona ordinata e accorpamento delle modifiche, attesa delle scritture alla chiusura, recupero dopo errori, memoria e trasparenza delle anteprime, invalidazione dello sfondo quando cambiano texture/zoom/dimensioni e stabilità dell'ispettore con annulla/ripeti.
- Selezionare un elemento e rilasciarlo o annullare senza spostarlo non ricrea il documento, non aggiunge cronologia e non avvia salvataggi. Le modifiche riutilizzano lo snapshot già serializzato; la scrittura riceve stringhe immutabili e non accede al modello mentre viene trascinato.
- Le scritture locali passano da un solo worker. Le modifiche ancora in attesa alla stessa bozza vengono accorpate; un ripristino non può essere sovrascritto da un salvataggio precedente. Gli errori sono riportati nell'interfaccia e una modifica successiva può tentare di nuovo il salvataggio.
- Il ridisegno riutilizza mappe raster alla risoluzione di visualizzazione e sfondi già composti quando la vista non cambia. Cache raster fino a 24 MiB, più un massimo di 8 MiB per ciascuno dei due sfondi a schermo; rilascio delle copie al cambio immagini e alla chiusura. I file originali e le immagini decodificate non vengono modificati dalle cache. Penne e pennelli dei muri vengono riutilizzati; gli elementi fuori vista vengono esclusi dal disegno.
- Fixture nativa completata con importazione, rotazione/ridimensionamento, muri/porte, luci, sostituzione mappa, riapertura bozza libera, dimensione minima della finestra e chiusura immediata dopo una modifica. Ultima bozza presente su disco dopo la chiusura; tutti i file Foundry simulati hanno le stesse impronte prima e dopo.
- Benchmark riproducibile in `tests/EditorPerformance.cs`: scena sintetica con 2.000 muri, 40 luci, sfondo 4096×3072 e finestra 1040×780. Confronto sequenziale nella stessa sessione Windows, eseguibili 0.4.0 e 0.4.1, riscaldamento prima delle misure. Sono tempi del codice di ridisegno e dei gesti, senza presentazione a schermo: non misurano gli FPS reali o le prestazioni di ogni PC. La prima preparazione di un'anteprima e il caricamento dei file restano operazioni distinte.

| Mediana del benchmark | 0.4.0 | 0.4.1 |
| --- | ---: | ---: |
| Ridisegno della vista ferma | 76,83 ms | 20,91 ms |
| Clic di selezione senza spostamento | 49,40 ms | 0,55 ms |
| Gesto annullato senza spostamento | 80,67 ms | 0,57 ms |
| Fotogramma durante trascinamento | 79,77 ms | 20,57 ms |
| Fotogramma con variazione dello zoom | 81,88 ms | 38,66 ms |
| Modifica proprietà più scrittura sincrona di confronto | 109,06 ms | 34,69 ms |

Il confronto dell'ultima riga mantiene intenzionalmente la scrittura sincrona nel benchmark; nell'interfaccia 0.4.1 il disco viene invece gestito dalla coda in background. Il 95° percentile dei fotogrammi durante trascinamento passa da 89,03 a 21,09 ms. Le misure non comprendono un account Discord reale o download Internet.

## Editor di bozze locali — 14 novembre 2026

- Compilazione C# 5 con warning trattati come errori; 35 test C# e 5 test Node. I sei nuovi test coprono isolamento del clone, creazione e proprietà, annulla/ripeti, duplica/elimina/ripristina, valori invalidi, annullamento dei gesti, persistenza locale e rifiuto di bozze riferite a dati originali cambiati.
- Gesti eseguiti sui controlli canvas Windows Forms: creazione di muri, aggiunta e spostamento di luci, selezione di immagini ruotate e ridimensionamento tramite maniglia. Il documento sorgente rimane invariato.
- Importazione di un'immagine esterna con alias locale e caricamento dalla cache. Confronto delle impronte dei file originali e controllo della directory Foundry simulata: nessuna scrittura o modifica ai dati Foundry.
- Fixture grafica nativa con Node e FFmpeg reali: importazione immagine, rotazione/dimensioni, muro con porta, luce colorata, proprietà, sostituzione della mappa, riapertura della bozza libera e annulla/ripeti. Rendering a 1280×920 e 1080×800, seguito da controllo visivo. Le impronte di tutti i file Foundry della fixture vengono confrontate prima e dopo.
- Nessun accesso a mondi reali e nessuna sessione Discord reale usata nelle fixture. Il rendering delle luci resta illustrativo, senza ombre o occlusione. L'editor non contiene un comando per salvare o applicare modifiche a Foundry.

## Integrazione Updater · 14 novembre 2026

- 29 test C# superati, incluso avvio con `--foundry-data`: il percorso valido viene memorizzato, categorie e filtri sono conservati, percorsi mancanti o non validi vengono rifiutati senza perdere le preferenze precedenti.
- Distribuzione gestita dal catalogo di Khuzoe Updater 0.5.0, con manifest applicazione separato dai moduli e conservazione dei dati utente esterni al pacchetto.

## Scheda Scene · 14 novembre 2026

- Compilazione C# 5 con warning trattati come errori: riuscita. **28 test C# superati** (i 20 test di regressione delle musiche più 8 test scene) e **5 test Node superati**.
- Lettura del formato LevelDB e dei sottoarchivi scene, livelli, muri, luci e tile verificata sul codice locale di Foundry v14.367. I test usano database reali classic-level costruiti con dati dimostrativi, senza aprire i database dei mondi dell'utente.
- Un processo separato tiene aperto il database della fixture: l'app ne copia e legge una scena con 2 livelli, 6 muri e 3 luci. Confronto SHA-256 di tutti i file dati originali prima e dopo: invariati. Il processo scrive poi una seconda scena nel WAL; una nuova copia la recupera senza chiudere l'originale.
- Copia stabile con confronto di nomi, dimensioni, date e impronte dei file mutabili; ripetizione in caso di cambiamenti; annullamento e rimozione delle copie parziali. Il motore rifiuta database privi dell'identificatore di copia Khuzoe. Controllati anche manifesti runtime alterati, confinamento dei percorsi asset e rifiuto di indirizzi remoti privati o contenuti non immagine.
- Verificati padding/spostamento delle coordinate, appartenenza ai livelli e conservazione dei filtri. Il confronto del rendering conferma che i filtri cambiano l'anteprima senza modificare i dati della scena.
- Pipeline con Node e FFmpeg reali: catalogo di 2 scene, dati incorporati, caricamento PNG, conversione e caricamento WebP, dimensioni corrette. Risultato: completata.
- Fixture grafica Windows Forms con mappa dimostrativa: selezione di mondo/scena, livello superiore, ricerca senza risultati e successivo recupero, pulsanti/checkbox reali per nascondere indicatori, muri e luci. Rendering a 1280×920 e alla dimensione minima 1080×800, seguito da controllo visivo: superato. Nessuna sessione Discord reale è stata usata nelle fixture.
- La scheda è un visualizzatore locale: non usa AI, non scrive ai mondi e non riproduce il rendering di ombre, visione o animazioni di Foundry. Il test non sostituisce un collaudo con ogni mappa, formato o modulo di terze parti.

## Verifiche della sezione Musiche · 0.1.0

Eseguite il 14 novembre 2026; i test automatici di regressione sono stati rieseguiti con la build 0.2.0.

- Compilazione C# 5 con il compilatore .NET Framework di Windows, warning trattati come errori.
- **20 test automatici superati**: normalizzazione link e rifiuto URL non ammessi; rilevamento installazioni Foundry; protezione delle destinazioni; nomi riservati Windows; sessioni DPAPI; vincolo degli URL di accesso; proxy e NO_PROXY; fonti e SHA-256 dei componenti; estrazione ZIP a nomi fissi; argomenti dei processi senza shell; annullamento effettivo anche dei processi figli; salvataggio e persistenza della raccolta; duplicati; cartelle separate; collisioni senza sovrascrittura; output audio non valido; video inatteso; pulizia dopo annullamento; percorsi alterati nella raccolta.
- Il test dell'annullamento misura anche il tempo di terminazione del processo. È stato corretto usando un job Windows privato per i processi dell'operazione; non vengono enumerati o terminati altri programmi.
- Verifica HTTP del backend già esistente: l'avvio del collegamento Discord restituisce un identificatore temporaneo di 32 caratteri e gli URL HTTPS previsti; il polling senza autorizzazione resta `pending`. Nessun login dell'utente è stato effettuato e nessun token reale è stato acquisito.
- Componenti ufficiali scaricati in una fixture isolata e verificati con SHA-256. Versioni provate: yt-dlp `2026.10.26`, FFmpeg/ffprobe `N-128900-gf8bb61cd57-20261113`, Node `v22.23.5`.
- Preparazione iniziale completata anche attraverso il codice dell'app, da una directory vuota: download ufficiali, controlli, estrazione e verifica dei quattro eseguibili. È stato aggiunto il supporto ai proxy d'ambiente standard, non letti automaticamente da .NET Framework, senza modificare impostazioni di Windows o controlli TLS.
- Prova del motore con FFmpeg e ffprobe reali: generazione di audio sintetico di un secondo, conversione MP3 a 192 kbps, verifica del codec/durata, pubblicazione nella cartella Foundry simulata, registrazione nella raccolta. Risultato: MP3 valido di 25.748 byte. Nessuna musica reale è stata modificata.
- Download YouTube reale completato sul video `aqz-KE-bpKQ`, **Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film**: download, conversione, verifica, salvataggio e raccolta. MP3 a 192 kbps, durata 634,624 secondi, 15.233.260 byte. È un contenuto di prova del progetto Blender, con licenza CC BY 3.0: https://peach.blender.org/about/ . Attribuzione: © 2008, Blender Foundation / www.bigbuckbunny.org. Il file è rimasto esclusivamente nella fixture di sviluppo e non viene incluso nel pacchetto.
- Una seconda esecuzione sullo stesso video e sulla stessa cartella ha riconosciuto e verificato il file esistente, senza scaricarlo di nuovo.
- Rendering nativo dell'interfaccia con sessione e raccolta di test, seguito da controllo visivo. I dati dimostrativi appartengono solo al test e non vengono inseriti nell'app distribuita.

## Limiti dell'ambiente di prova

Il primo tentativo di preparazione aveva incontrato un errore socket perché .NET Framework non leggeva il proxy d'ambiente. Dopo la correzione, la preparazione eseguita direttamente dall'app è riuscita. Il helper PowerShell usato inizialmente per la diagnosi è solo uno strumento di sviluppo e non è necessario agli utenti.

L'automazione grafica disponibile non si avvia in questo ambiente. Il rendering è stato verificato con una fixture nativa; non è stato completato un collaudo interattivo dell'accesso Discord con un account reale.

Una prova riuscita non garantisce l'accessibilità di ogni video: durante le verifiche un altro video di test è risultato non disponibile e l'app ha restituito l'errore senza creare un MP3 o una voce nella raccolta.
