# Khuzoe Tiles Creator

Seleziona una porzione di una scena Foundry VTT 14 e descrivi come modificarla. Il servizio immagini della wiki riceve la composizione di sfondo e tile statici visibili del livello corrente. Controlla l'anteprima e conferma per creare un nuovo tile; gli originali rimangono intatti.

## Uso

1. Abilita **Khuzoe Tiles Creator** insieme a **Khuzoe Wiki Sync**.
2. In Wiki Sync seleziona la campagna e accedi con un account della wiki DM/admin. Sono necessari permessi GM locali, scritture abilitate in Wiki Sync e caricamento file consentito.
3. Apri una scena. Nella barra **Tile**, premi la bacchetta **Modifica area con AI**. In alternativa: impostazioni modulo → Apri Tiles Creator, oppure **Alt + Shift + T**.
4. Scegli la risoluzione, premi **Seleziona area** e trascina un rettangolo sulla mappa. **Esc** annulla. Un margine di contesto aiuta il generatore a mantenere lo stile.
5. Se vuoi, aggiungi **Reference secondarie**: **Allega immagini** carica PNG/JPG/WebP dal computer, **Allega area della scena** cattura un altro rettangolo con sfondo e tile visibili. La mappa da modificare rimane sempre l'immagine **1**; le reference sono numerate da **2** e hanno una nota facoltativa **Cosa riprendere** (texture, simbolo, arredamento…). Puoi ingrandirle o rimuoverle prima della generazione. Descrivi la modifica e premi **Genera anteprima**. Puoi chiudere e riaprire la finestra nella stessa scena per recuperare bozza, allegati e risultato.
6. Per altre modifiche, premi **Usa come nuovo input**: l'anteprima corrente diventa la nuova base. Scrivi le altre modifiche e premi **Genera nuova modifica**. Puoi ripetere il ciclo; ogni generazione conserva il risultato precedente. **Torna all’anteprima precedente** annulla la richiesta ancora in bozza senza chiamate AI.
7. Prima di posizionare, premi **Gomma** per cancellare parti dell'anteprima. Regola la dimensione del pennello con il cursore o il valore in pixel e trascina sull'immagine. **Annulla tratto**, **Rifai** e **Ripristina tutto** consentono di correggere il ritocco. Il motivo a scacchi indica le parti trasparenti. Premi **Applica gomma** per conservare il ritocco, oppure **Annulla** per uscire senza modificarlo.
8. Regola il raccordo dei bordi e premi **Posiziona nella scena**. Il tile è bloccato inizialmente, con posizione e dimensioni della selezione. Rimane un normale tile Foundry e puoi sbloccarlo, nasconderlo o eliminarlo. Puoi continuare anche da un risultato già posizionato, purché il tile e la mappa siano rimasti invariati: alla conferma viene creato un nuovo tile sovrapposto, conservando il precedente.

## Servizio wiki

È necessario pubblicare il Worker aggiornato, con la nuova binding `TILE_GENERATOR` / classe SQLite Durable Object `TileGenerationStore` e la migrazione additiva `tile-generation-v1`. Usa il segreto `OPENAI_API_KEY` già configurato. Il modulo non contiene la chiave e il segreto di sincronizzazione Foundry non autorizza le generazioni a pagamento.

Il modello è lo stesso del generatore avatar (`gpt-image-2.5-sunburst`), con prompt dedicato alle mappe. Qualità media/alta; risoluzione media circa 1 MP, alta circa 2,25 MP, con proporzioni mantenute entro i vincoli API. Cambiare risoluzione prima della generazione aggiorna la cattura senza costi AI; nelle modifiche progressive ridimensiona la base scelta, mantenendo le modifiche precedenti. **Non esiste un limite mensile di generazioni tile.** Rimangono l'autenticazione DM/admin, la verifica della campagna e un solo lavoro attivo alla volta per campagna. Ogni nuova generazione usa le API a pagamento. Un invio ambiguo conserva lo stesso identificativo; nessun nuovo tentativo a pagamento è automatico.

Le immagini su R2 sono nel prefisso privato `_private/ai-tiles/`, accessibili tramite richieste autenticate del proprietario della generazione. Al posizionamento viene salvata una copia in `Data/khuzoe-tiles/<worldId>/<generationId>.webp`. Nessuna cattura o immagine viene pubblicata nella wiki o nei suoi elenchi NPC. Nessuna modifica ai dati esistenti in KV.

Le reference vengono preparate localmente in WebP, senza chiamate AI: fino a 15 immagini secondarie, massimo 1536 pixel sul lato lungo, 2 MB ciascuna e 6 MB complessivi dopo la preparazione. L'API riceve la mappa per prima e le reference nell'ordine mostrato. Le reference aumentano il contenuto in input della richiesta a pagamento; vengono caricate su R2 e inviate al servizio immagini soltanto premendo **Genera**. Le modifiche progressive mantengono gli allegati, che puoi cambiare nella nuova bozza. Il risultato resta un tile della selezione primaria, nelle dimensioni originali.

## Ambito e limiti

- Sfondo e tile statici visibili, rispettando texture, ancoraggio, scala, rotazione, colore, opacità e ordinamento del livello. I tile nascosti e quelli di altri livelli non vengono inclusi. I tile parzialmente fuori area sono ritagliati automaticamente.
- Token, griglia, note, disegni, luci e nebbia non vengono catturati. L'illuminazione dinamica continua a essere applicata da Foundry al nuovo tile.
- Le selezioni sono rettangolari, interne alla mappa e con rapporto fra i lati massimo 3:1. Il risultato viene ricomposto esclusivamente dentro il rettangolo; il margine di contesto non diventa parte del tile.
- Mappe animate/video e trasformazioni aggiunte da altri moduli tramite shader non sono supportate nella prima versione. Una griglia già disegnata nell'immagine di sfondo resta parte dell'immagine.
- L'AI può reinterpretare dettagli, perciò serve controllare l'anteprima. Il raccordo dei bordi si calcola localmente e non richiede nuove chiamate AI.
- Se sfondo o tile cambiano dopo la cattura, il posizionamento viene bloccato. I cambiamenti a token o combattimento non lo bloccano. Ripetere la conferma della stessa generazione riutilizza il tile già creato, evitando duplicati.
- I muri, le porte, i token, le collisioni e gli altri documenti della scena non vengono modificati. Gli originali non vengono cancellati.

## Sviluppo

La sorgente versionata è `integrations/khuzoe-tiles-creator`. `node scripts/install-tiles-creator.mjs` aggiorna soltanto questa cartella nella directory modules locale. I test usano un servizio immagini simulato, senza chiamate a pagamento o modifiche a scene reali.

## Correzioni 0.1.1

La cattura ignora le texture non configurate dei livelli Foundry, compreso il primo piano vuoto restituito anche nelle scene con solo sfondo. Funzionano anche scene prive di tile e sfondi di solo colore. I primi piani con un'immagine configurata restano inclusi.

## Modifiche 0.2.0

Modifiche progressive: usa l'anteprima come nuovo input, mantenendo il margine di contesto originale. La base scelta e il testo ancora in bozza sono recuperabili dopo la chiusura della finestra. Il servizio conserva il collegamento fra una generazione e la sua base senza sovrascrivere le immagini precedenti. Rimosso il limite mensile dei tile; contatori già esistenti restano conservati per l'utilizzo storico. L'aggiornamento richiede il nuovo Worker, senza migrazioni o modifiche ai dati in KV.

## Modifiche 0.3.0

Gomma locale con pennello regolabile da 4 a 300 pixel, annullamento/ripetizione dei tratti e ripristino completo. Le parti cancellate vengono salvate come trasparenza nel WebP finale, non come colore di sfondo. La maschera rimane in questo browser, distinta per campagna/mondo/scena/livello/generazione, ed è recuperata riaprendo la finestra o ricaricando Foundry. Cambiare il raccordo dei bordi conserva le cancellazioni. Le modifiche progressive mantengono la maschera, anche quando si cambia risoluzione; il ripristino completo permette di rimuoverla. Il ritocco non usa API AI e non modifica immagini o tile già presenti. Non serve ripubblicare il Worker per questo aggiornamento.

## Modifiche 0.4.0

Reference secondarie da file o aree della scena, con anteprima, note e rimozione. La mappa rimane sempre il primo input. Bozze e tentativi interrotti conservano immagini, ordine e note; riaprire una generazione completata recupera gli allegati tramite route private. Gli invii ripetuti non possono cambiare i file del tentativo originale. È necessario aggiornare il Worker; la compatibilità viene verificata prima di avviare una generazione con allegati. Nessuna migrazione, cancellazione o sovrascrittura dei dati precedenti.
