# Khuzoe Tiles Creator

Seleziona una porzione di una scena Foundry VTT 14 e descrivi come modificarla. Il servizio immagini della wiki riceve la composizione di sfondo e tile statici visibili del livello corrente. Controlla l'anteprima e conferma per creare un nuovo tile; gli originali rimangono intatti.

## Uso

1. Abilita **Khuzoe Tiles Creator** insieme a **Khuzoe Wiki Sync**.
2. In Wiki Sync seleziona la campagna e accedi con un account della wiki DM/admin. Sono necessari permessi GM locali, scritture abilitate in Wiki Sync e caricamento file consentito.
3. Apri una scena. Nella barra **Tile**, premi la bacchetta **Modifica area con AI**. In alternativa: impostazioni modulo → Apri Tiles Creator, oppure **Alt + Shift + T**.
4. Scegli la risoluzione, premi **Seleziona area** e trascina un rettangolo sulla mappa. **Esc** annulla. Un margine di contesto aiuta il generatore a mantenere lo stile.
5. Descrivi la modifica e premi **Genera anteprima**. Puoi chiudere e riaprire la finestra nella stessa scena per recuperare il risultato. Clicca sulle immagini per ingrandirle.
6. Regola il raccordo dei bordi e premi **Posiziona nella scena**. Il tile è bloccato inizialmente, con posizione e dimensioni della selezione. Rimane un normale tile Foundry e puoi sbloccarlo, nasconderlo o eliminarlo.

## Servizio wiki

È necessario pubblicare il Worker aggiornato, con la nuova binding `TILE_GENERATOR` / classe SQLite Durable Object `TileGenerationStore` e la migrazione additiva `tile-generation-v1`. Usa il segreto `OPENAI_API_KEY` già configurato. Il modulo non contiene la chiave e il segreto di sincronizzazione Foundry non autorizza le generazioni a pagamento.

Il modello è lo stesso del generatore avatar (`gpt-image-2.5-sunburst`), con prompt dedicato alle mappe. Qualità media/alta; risoluzione media circa 1 MP, alta circa 2,25 MP, con proporzioni mantenute entro i vincoli API. Cambiare risoluzione prima della generazione aggiorna la cattura senza costi AI. Il limite `TILE_MONTHLY_LIMIT` è inizialmente **20 generazioni per campagna al mese**: è un numero di richieste, non un tetto monetario. Un invio ambiguo conserva lo stesso identificativo; nessun nuovo tentativo a pagamento è automatico.

Le immagini su R2 sono nel prefisso privato `_private/ai-tiles/`, accessibili tramite richieste autenticate del proprietario della generazione. Al posizionamento viene salvata una copia in `Data/khuzoe-tiles/<worldId>/<generationId>.webp`. Nessuna cattura o immagine viene pubblicata nella wiki o nei suoi elenchi NPC. Nessuna modifica ai dati esistenti in KV.

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
