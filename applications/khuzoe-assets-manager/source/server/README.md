# Riconoscimento muri sul servizio Khuzoe

Il desktop usa il backend già configurato per Discord. Le richieste restano sotto `https://sigillo-api.khuzoe.workers.dev/api/assets/walls?campaign=cripta-di-sangue`. La campagna segue quella della sessione dell'app. Il server autentica ogni richiesta e richiede permessi DM/admin; un segreto di sincronizzazione Foundry non autorizza l'analisi.

## Integrazione nel repository del sito

- Copiare `wall-detection.js` in `workers/main-worker/src/wall-detection.js`.
- Esportare `WallDetectionStore` dall'entry point e instradare GET/POST `/api/assets/walls`, GET `/api/assets/walls/{uuid}` e POST `/api/assets/walls/{uuid}/stop` a `handleWallDetection`. Passare le funzioni già esistenti `requireUser`, `isAuthenticatedCampaignContentEditor` e `getAuthenticatedAccountId`, applicando le intestazioni CORS come per Tiles Creator.
- Aggiungere il binding Durable Object `WALL_DETECTOR`, classe `WallDetectionStore`, con migrazione SQLite `assets-wall-detection-v1`. Riutilizzare `MEDIA_BUCKET` e il segreto server `OPENAI_API_KEY`; nessuna chiave nel desktop o nel repository.
- Configurare `ASSETS_WALL_MODEL` e `ASSETS_WALL_DETAIL`. Valori iniziali: `gpt-5.4` e `original`. Cambiare il modello sul Worker non richiede una nuova release dell'app. Il provider deve supportare immagini, Responses API e JSON Schema strutturato. Modelli con parametri diversi possono richiedere un adattamento in `recognizeWallTile`.
- Eseguire `node --experimental-default-type=module --test scripts/test-assets-wall-detection.mjs` nel sito, poi verificare e pubblicare il Worker con la procedura già usata dal progetto. Qui gli stessi test si eseguono con `node --experimental-default-type=module --test server/wall-detection.test.mjs`.

La patch dell'entry point e della configurazione è preparata anche nel repository del sito. La pubblicazione dell'app Windows e quella del Worker sono distinte. Fino all'attivazione del Worker, l'app mostra che la funzione non è disponibile, senza caricare immagini o chiamare l'AI.

## Contratto versione 1

GET base restituisce `version`, `enabled`, `model`, `detail`, `maxTiles` e `maxBytes`, senza chiamare il fornitore AI. POST base accetta un UUID, il rettangolo complessivo `frame` e `tiles`. Ogni tile contiene il rettangolo scena `frame` con contesto, il rettangolo disgiunto `core`, dimensioni raster e JPEG base64. Nessun percorso locale, documento Foundry, password o nome file è necessario. I core devono coprire l'area richiesta, senza sovrapposizioni.

L'app conserva la ricevuta prima del POST. Il server vincola UUID e impronta dei dati allo stesso account/campagna. POST ripetuti con la stessa impronta recuperano l'analisi; dati diversi producono conflitto. Una richiesta attiva per account/campagna. GET consulta esclusivamente i risultati: nessuna chiamata AI e nessun recupero tramite un nuovo POST. Il cambio della scena rende impossibile confermare automaticamente un risultato ottenuto sulla vecchia geometria.

Le mappe vengono composte dagli originali, escludendo griglia, muri, luci ed elementi nascosti, in ritagli da massimo 1280×1280 con margine di contesto. Il piano usa fino a 64 porzioni; oltre questa dimensione riduce il campionamento mantenendo l'intera area. L'opzione dettaglio ridotto dimezza la densità desiderata. Il server verifica dimensioni JPEG, coordinate, copertura, numero di ritagli e limite complessivo di 15 MiB.

Ogni porzione avvia una sola richiesta al modello. Le coordinate normalizzate sono verificate e ritagliate al core; l'app ricongiunge estremi distanti al massimo 1,5 unità scena e scarta segmenti duplicati. Nessuna chiusura automatica di aperture più grandi e nessuna classificazione automatica di porte/finestre in questa versione. Le segnalazioni di incertezza sono suggerimenti del modello, non probabilità calibrate.

Il server registra il tentativo prima della chiamata esterna. In caso di riavvio, timeout, errore o risposta incompleta non ripete automaticamente la chiamata. Interrompere evita le chiamate ai ritagli successivi; la richiesta già inviata può avere un costo. I risultati parziali restano revisionabili. I contatori token includono le risposte registrate, incluse quelle con geometria inutilizzabile; chiamate interrotte o non registrate possono essere fatturate comunque dal fornitore.

Le immagini in ingresso sono private in R2 e vengono cancellate a termine/interruzione. Ricevute e segmenti restano recuperabili per sette giorni, poi sono rimossi. La richiesta OpenAI usa `store:false`; questo parametro non sostituisce le regole di conservazione del fornitore. Nessun input o segreto è scritto nei log applicativi.

I test simulano il fornitore AI: verificano autorizzazioni, geometria, idempotenza, annullamento, consumo registrato e gestione dei guasti. Non misurano la precisione del modello su mappe reali. Non sono state eseguite chiamate AI a pagamento durante lo sviluppo.

## Coordinate AI non valide

Lo schema impone esplicitamente coordinate normalizzate da 0 a 1000 per entrambi gli assi, insieme ai limiti di punti e tracciati. Il prompt definisce angoli e centro dell'immagine e chiede di terminare le pareti sul bordo, senza estenderle fuori dal ritaglio.

La validazione resta attiva anche con lo schema. Un piccolo sconfinamento, entro il 2% del ritaglio, viene tagliato geometricamente al core e segnalato come incerto. Coordinate non numeriche, non finite o molto esterne invalidano soltanto i segmenti incidenti. I vertici sui lati opposti di un punto scartato non vengono ricongiunti; i frammenti conservati sono incerti. Non si tenta di indovinare un diverso sistema di coordinate.

Se una risposta AI completata contiene geometria illeggibile, la porzione viene registrata come scartata e l'analisi continua sulle successive. La chiamata già eseguita non viene ripetuta; i token comunicati dal fornitore vengono conteggiati anche per la porzione inutilizzabile. Rifiuti del modello, timeout ed errori di rete conservano la gestione precedente, senza tentativi automatici.

Il risultato usa lo stato compatibile `partial` e il campo `error` per spiegare cosa controllare. I campi opzionali `skippedTiles`, `discardedSegments`, `discardedPaths` e `clippedSegments` espongono i contatori. Il client 0.5.0 può già mostrare l'avviso e aprire Controlla muri per revisionare i segmenti conservati. Nessuna modifica al modello o all'eseguibile è necessaria per questa correzione.

La modifica riguarda le nuove analisi. Un'analisi già terminata con errore mantiene i propri risultati parziali; non riparte automaticamente e non si possono recuperare le porzioni non elaborate senza una nuova richiesta esplicita. Non vengono ricostruiti o stimati retroattivamente i token di risposte precedentemente scartate.
