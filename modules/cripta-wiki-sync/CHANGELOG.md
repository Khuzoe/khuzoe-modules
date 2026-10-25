# Khuzoe Wiki Sync 0.11.11 — 8 ottobre 2026

- Rafforzato il salvataggio di Link Actor Data del token predefinito: aggiornamento puntuale del flag se la configurazione completa non lo conserva e verifica immediata prima di convertire i token in mappa. Un rifiuto effettivo interrompe la conversione e mantiene il ripristino dal backup; la diagnostica non suggerisce più di impostare manualmente il collegamento su No.
- La configurazione del PrototypeToken usa l'aggiornamento ricorsivo nativo, sostituendo soltanto i flag. Evitato l'azzeramento di `displayBars` nel ciclo v14 di validazione, trasporto e persistenza quando Bar Brawl elimina il campo invariato dal payload. Conservate anche le opzioni `appendNumber` e `prependAdjective`, oltre a `randomImg`, che appartengono soltanto al token predefinito.
- Verifiche con i veri DataModel, PrototypeToken, operatori e hook Bar Brawl installati, su copie in memoria: attivazione, ripristino, rifiuto e protezione delle barre. Nessun dato reale del mondo modificato. Ricaricare il client GM con **Ctrl+F5** e richiedere una nuova ispezione dal sito; il caso segnalato va confermato nel mondo effettivo.

# Khuzoe Wiki Sync 0.11.10 — 8 ottobre 2026

- Corretta la verifica nativa di Link Actor Data: l'importazione Foundry rimuove `ownership` dagli Item incorporati e la persistenza ripristina il valore predefinito `{default: 0}`. Campo assente, oggetto vuoto e questo solo valore predefinito vengono confrontati come equivalenti.
- Il confronto resta completo su permessi personalizzati, statistiche, attività, danni, utilizzi, effetti e flag. La normalizzazione vale soltanto per il campo nativo degli Item dell'Actor, senza ignorare campi omonimi nel sistema o nei flag dei moduli. La stessa verifica protegge conversione e ripristino.
- Verificato il caso dei 19 Item con il vero `DocumentOwnershipField` v14 e documenti in memoria. Nessun documento reale, impostazione del mondo o backup è stato modificato. Ricaricare Foundry con **Ctrl+F5**, richiedere una nuova ispezione e confermare di nuovo lo stato scelto, senza correggere manualmente i permessi delle capacità.

# Khuzoe Wiki Sync 0.11.9 — 8 ottobre 2026

- Autenticazione delle finestre wiki dopo la navigazione dell'iframe: nessun token inviato al documento iniziale `about:blank` che eredita l'origine di Foundry.
- Invii duplicati evitati per la stessa finestra e sessione; il messaggio verificato `cripta-embed-ready` permette alla pagina di richiedere l'autenticazione dopo il proprio avvio. Conservati i controlli sulla finestra mittente e sull'origine esatta, senza usare `*`.
- Chiusura e sostituzione delle finestre rimuovono i listener dal riquadro effettivamente collegato. Verifiche con finestre simulate, senza modifiche ai dati reali del mondo. Ricaricare il client con **Ctrl+F5**.

# Khuzoe Wiki Sync 0.11.8 — 7 ottobre 2026

Compatibilità della sincronizzazione degli alberi con l'archivio D1 della wiki.

- Le risposte autorevoli `source: "kv"` e `source: "d1"` vengono entrambe accettate per definizioni e progressi, mantenendo i controlli su campagna, versione, nodi e sblocchi. Risposte statiche, incomplete o non valide continuano a interrompere la sincronizzazione prima di qualunque scrittura.
- API e comportamento degli alberi rimangono invariati. Verifica con Actor simulati e letture delle tre campagne; nessuna modifica ai dati reali del mondo durante lo sviluppo. Ricaricare il client GM con **Ctrl+F5**.

# Khuzoe Wiki Sync 0.11.6 — 2 ottobre 2026

Corretto l'allineamento della visibilità dei dossier durante l'apertura del mondo.

- Le operazioni Actor e Token ricevono ciascuna una nuova copia delle opzioni interne. Foundry v14 aggiunge `parentUuid` alle opzioni degli aggiornamenti nelle scene: riutilizzando lo stesso oggetto, l'Actor successivo veniva erroneamente cercato nella Scene e falliva con `Actor is not a valid embedded Document within the Scene Document`.
- Conservate propagazione al token predefinito e ai token collegati e non collegati, prevenzione dei ritorni di sincronizzazione, controllo dei permessi e verifica della persistenza. Gli allineamenti non confermati vengono ripresi al caricamento successivo.
- Correzione verificata con i metodi nativi di Document e ClientDatabaseBackend v14 su documenti in memoria. Nessuna modifica diretta ai dati del mondo durante lo sviluppo. Ricaricare il client GM con **Ctrl+F5**.

# Khuzoe Wiki Sync 0.11.5 — 2 ottobre 2026

Salvataggio delle probabilità delle capacità indipendente dalla versione di Khuzoe Automations.

- Wiki Sync valida struttura, intervalli e attività con un validatore locale e salva `flags.khuzoe-automations.midiRollConfig` anche se il modulo dei tiri è precedente, disattivato o assente. Restano invariati baseline, conflitti, verifica della persistenza e conservazione degli altri flag.
- Il FE mostra la sezione all'admin anche sulle schede già sincronizzate senza la capacità dell'editor nel vecchio snapshot. Le attività native devono essere presenti nei dati della capacità.
- Il flag memorizzato non modifica i dadi finché Khuzoe Automations non dispone dell'integrazione aggiornata e attiva. Nessuna impostazione o messaggio aggiunto all'interfaccia Foundry, nessuna nuova richiesta periodica e nessuna modifica ai dati reali durante lo sviluppo. Ricaricare il client GM con **Ctrl+F5**.

# Khuzoe Wiki Sync 0.11.4 — 1 ottobre 2026

Verifica completa dell'Actor copiato durante l'attivazione di Link Actor Data e del ripristino del backup.

- Il JSON completo del token scelto passa attraverso migrazione e validazione native di Foundry prima della scrittura, con `dropInvalidEmbedded: false`: un Item o Active Effect invalido interrompe l'importazione anziché essere scartato silenziosamente.
- Il documento atteso viene conservato dal payload normalizzato prima di `Actor.update`, mantenendo identità, cartella e permessi dell'Actor di destinazione. La verifica legge il JSON persistente, senza confonderlo con valori preparati o nomi localizzati.
- L'Actor viene verificato dopo l'importazione e prima della conferma finale, dopo gli aggiornamenti dei token. Una copia parziale di statistiche, capacità o effetti fallisce e avvia il ripristino; un ripristino parziale fallisce mantenendo il backup disponibile.
- Superate 14 nuove prove isolate, le suite esistenti di sicurezza, Bar Brawl e campi D&D5e, e i 30 controlli di aggiornamento Actor. Nessuna modifica ai dati reali durante lo sviluppo. Ricaricare il client GM con **Ctrl+F5**. Il caso di modifiche concorrenti durante la conversione resta da correggere separatamente.

# Khuzoe Wiki Sync 0.11.3 — 1 ottobre 2026

Allineamento retroattivo Foundry → wiki della visibilità dei dossier NPC.

- Al primo caricamento dell'indice, gli NPC già presenti nella wiki con **Hovered by Anyone** sul token predefinito o su un token in una qualsiasi scena vengono accodati per rendere pubblico il dossier. Compresi i token non collegati e gli NPC già letti dalla versione precedente.
- Verifica registrata una sola volta per NPC, mondo e campagna; i riavvii non annullano una successiva scelta **solo DM** sulla wiki. Code e revisione di partenza sono conservate anche in caso di riavvio o problemi di rete.
- Riutilizzati indice, API del dossier e coda esistenti, senza nuovo polling. Il normale aggiornamento delle immagini conserva la modalità del nome che ha avviato una pubblicazione ancora in attesa.
- Statistiche e capitoli riservati mantengono i permessi. Verificato con dati fittizi; nessuna modifica diretta ai dati del mondo durante lo sviluppo. Ricaricare il client GM con **Ctrl+F5**, con sincronizzazione bidirezionale attiva.

# Khuzoe Wiki Sync 0.11.2 — 1 ottobre 2026

Collegamento della visibilità del dossier NPC con il nome dei token in Foundry.

- Impostare **Hovered by Anyone** sul token predefinito o su un token in scena di un NPC già sincronizzato pubblica il suo dossier. Funziona anche per i token non collegati all'Actor.
- Rendere pubblico il dossier sulla wiki imposta **Hovered by Anyone** sul token predefinito e sui token dello stesso NPC in tutte le scene. Al primo caricamento vengono allineati anche i dossier già pubblici.
- Il collegamento riguarda queste due attivazioni: gli altri modi di visualizzazione non nascondono il dossier; rendere privato il dossier non nasconde automaticamente il nome in Foundry. Statistiche, permessi dei capitoli, proprietà e stato nascosto dei token restano invariati.
- Esegue la sincronizzazione un solo GM attivo, rispettando le modalità Push/Pull. Riutilizzati indice e notifiche live esistenti, senza un nuovo polling del Worker. Code persistenti, nuovi tentativi dopo errori di rete e controlli di revisione evitano duplicazioni e sovrascritture di modifiche concorrenti.
- Test con dati fittizi sul modulo installato e sul Worker locale; nessuna modifica ai dati del mondo durante lo sviluppo. Ricaricare il client GM con **Ctrl+F5**. Nessuna pubblicazione del pacchetto remoto o modifica FE/Worker richiesta per questa funzione.

# Khuzoe Wiki Sync 0.10.8 — 17 settembre 2026

Verifica delle modifiche alle statistiche inviate dal sito prima della conferma.

- Rilettura dei campi modificati dopo l'aggiornamento dell'Actor: i valori ignorati o ricalcolati vengono segnalati come non applicati, con il valore effettivo.
- Il bonus di competenza derivato da D&D5e e i campi controllati dagli effetti attivi non vengono riscritti come valori di base.
- Errori di validazione restituiti al sito; conferma inviata soltanto dopo la pubblicazione dello stato aggiornato, anche in modalità Pull.
- Verifiche isolate di modifica, conflitto, ripetizione, errori e conferma. Nessuna modifica ai documenti del mondo durante i test. Ricaricare il client GM per attivare il codice aggiornato.

# Khuzoe Wiki Sync 0.10.7 — 12 settembre 2026

Corretta l'interazione con Bar Brawl 1.9.3 durante la copia della configurazione dei token per Link Actor Data. Gli aggiornamenti completi con una barra nativa vuota e senza la corrispondente voce Bar Brawl provocavano `Cannot read properties of undefined (reading 'attribute')` nei suoi hook `preUpdateActor` e `preUpdateToken`.

- Wiki Sync indica esplicitamente le barre assenti con l'operatore di rimozione di Foundry 14, già supportato da Bar Brawl. La gestione è limitata agli aggiornamenti preparati da Link Actor Data, inclusi prototype, token nelle scene e ripristino dei token dal backup.
- Barre personalizzate, valori, colori, visibilità e altri flag conservati. Nessuna modifica quando Bar Brawl è disattivato; nessun hook disabilitato e nessuna modifica al codice di Bar Brawl.
- Dodici test isolati eseguono il codice installato di Bar Brawl e l'operatore nativo di Foundry: riproduzione dei due errori originali, copie corrette, barre vuote/personalizzate, ripetizioni, modulo disattivato, posizione dei token e ripristino. Superate anche le 129 prove esistenti di Wiki Sync.

Nessuna sincronizzazione o modifica dei dati del mondo eseguita durante l'intervento. Copia precedente in `.maintenance/before-link-bars-20260912/`. Ricaricare il client GM con Ctrl+F5 per caricare il nuovo codice; verifica interattiva ancora da effettuare. Pacchetto remoto non pubblicato.

# Khuzoe Wiki Sync 0.10.6 — 12 settembre 2026

Eliminati gli accessi ai campi deprecati di D&D5e 5.3.3 che generavano gli avvisi `SpellData#preparation` durante la sincronizzazione e `senses.… has moved` durante l'ispezione di Link Actor Data.

- Incantesimi letti e aggiornati attraverso `system.method` e `system.prepared`. Distinti gli stati non preparato (0), preparato (1) e sempre preparato (2), anche nei confronti e nei ripristini. La preparazione resta uno stato dell'istanza durante gli aggiornamenti del catalogo.
- Conservato il formato di preparazione consumato dal sito pubblicato, ricostruendolo come JSON dai campi attuali. I comandi del sito con i vecchi percorsi vengono confrontati e tradotti prima dell'aggiornamento Foundry; restano attivi i controlli dei conflitti e vengono evitate le scritture senza cambiamenti.
- Sensi confrontati tramite `ranges`, senza enumerare i getter deprecati. Conservati valori risolti, zero, sensi personalizzati, unità e informazioni speciali; nel riepilogo le differenze sono mostrate per singolo senso.
- Test isolati delle funzioni effettive con getter deprecati che sollevano errori, inclusi esportazione, comandi del sito, conflitti, ripetizioni, ripristino dei vecchi snapshot e propagazione dal catalogo. Controllate anche le suite esistenti degli override, degli alberi abilità, dei collegamenti NPC e della migrazione Token Switcher.

Modificato soltanto Wiki Sync. Nessuna sincronizzazione, conversione Link Actor Data o modifica dei dati del mondo eseguita durante l'intervento. Copia precedente in `.maintenance/before-dnd5e-modern-fields-20260912/`. Ricaricare completamente il client GM (Ctrl+F5); verifica interattiva ancora da effettuare. Pacchetto remoto non pubblicato.

# Khuzoe Wiki Sync 0.10.5 — 12 settembre 2026

Corretta l'interruzione «Flag scope \"khuzoe-token-switcher\" is not valid or not currently active» durante la sincronizzazione delle trasformazioni con Tokenizer.

- La migrazione legge i dati precedenti direttamente da `actor.flags`, senza usare `getFlag` per il modulo disattivato o disinstallato. Foundry 14 controlla che il modulo sia attivo prima ancora di verificare se il flag esiste.
- Conservati dati precedenti, nomi, immagini, dimensioni, filtri della forma base e delle forme già gestite dalla wiki, e comportamento della migrazione una tantum. Nessuna necessità di riattivare Token Switcher.
- Undici test isolati sulle funzioni effettive: vecchio modulo attivo/disattivato/rimosso, dati mancanti o non validi, migrazione, ripetizioni, errore Tokenizer con nuovo tentativo e sincronizzazione completa di più Actor. Controllate anche le suite esistenti degli override e degli alberi abilità.

La modifica runtime riguarda soltanto la lettura in `getLegacyTokenSwitcherEntries`. Non è stata eseguita una sincronizzazione sui dati del mondo. Copia precedente in `.maintenance/before-legacy-switcher-scope-20260912/`. Ricaricare completamente il client GM (Ctrl+F5) per caricare la correzione. Pacchetto remoto non pubblicato.

# Khuzoe Wiki Sync 0.10.4 — 12 settembre 2026

Il pulsante **Wiki** sulle schede NPC e sui token apre la pagina dell'Actor sincronizzato attraverso gli identificativi di campagna, mondo e Actor. Non dipende più dalla corrispondenza del nome nel vecchio indice statico.

- Consultazione in sola lettura della directory NPC, con lo stesso indirizzo `pages/characters/managed-actor.html?world=…&actor=…` usato dal sito. Rispettata la modalità di sola lettura del profilo quando il sito non concede accesso alle statistiche. Credenziali escluse dagli indirizzi.
- Precedenza ai collegamenti manuali; conservati `wikiNpcId`, riferimenti Foundry precedenti, alias e bozze locali. I token possono ereditare il collegamento dall'Actor di base. Una bozza locale non viene aperta come una pagina già pubblicata.
- Consultazione dei vecchi NPC anche nell'archivio remoto aggiornato, con ripiego sull'indice statico. Gli omonimi ambigui, i collegamenti non trovati e gli errori di accesso/rete producono messaggi distinti; nessuna selezione arbitraria di un'altra pagina.
- Una pagina NPC gestita richiede una sola lettura dell'indice, senza caricare anche gli indici di oggetti e personaggi. Le ricerche simultanee della finestra e del log del token condividono la stessa richiesta; una nuova apertura ricontrolla lo stato corrente.
- Navigazione priva di scritture su documenti, impostazioni e sito. Non sono state modificate le procedure di sincronizzazione o le automazioni di combattimento.

Verifiche: 32 test specifici su riconoscimento, token sintetici, collegamenti precedenti, isolamento tra mondi e campagne, permessi, richieste simultanee, indisponibilità degli indici e apertura della finestra. Controllate anche le 29 prove degli override e le 28 degli alberi abilità. Il formato degli indirizzi è stato confrontato con la funzione del [sito pubblicato](https://khuzoe.github.io/sigillo-del-male/assets/js/pages/npcs.js), sia per le statistiche sia per il solo profilo.

Per caricare il nuovo codice ricaricare completamente i client Foundry (Ctrl+F5). Nessuna sincronizzazione o modifica dei dati del mondo eseguita durante l'intervento. Copia precedente in `.maintenance/before-npc-wiki-links-20260912/`. Pacchetto remoto non pubblicato; verifica interattiva nel client dell'utente ancora da effettuare.

# Khuzoe Wiki Sync 0.10.3 — 12 settembre 2026

Eliminate le scritture ripetute dei dati di sincronizzazione durante il controllo automatico degli override di abilità e inventario. Prima il campo `appliedAt` cambiava anche con immagini e descrizioni identiche: questo produceva aggiornamenti degli Item, ricalcoli degli Actor e molti messaggi di debug CAT.

- Confronto delle impronte dei contenuti prima di creare la data di applicazione. Se le impronte sono identiche non viene effettuato alcun salvataggio; la data originale e gli altri metadati restano conservati.
- La prima registrazione dei riferimenti al sito avviene una sola volta. Una modifica reale continua ad aggiornare contenuto e riferimenti, rispettando le protezioni delle personalizzazioni locali.
- Conteggi separati per **contenuti aggiornati**, **soli dati di sincronizzazione aggiornati**, **invariati** e **saltati**. Ogni voce appartiene a una sola categoria: gli aggiornamenti dei contenuti includono gli eventuali metadati associati. Immagini non risolte e salvataggi dei contenuti annullati non vengono più conteggiati come modifiche applicate.
- Gli aggiornamenti della sola descrizione dell'inventario non avviano la registrazione di un'immagine già allineata o protetta. Le modifiche diventate superflue prima del salvataggio vengono scartate.
- Non è stato cambiato il controllo delle revisioni remote: la nuova versione non forza una sincronizzazione completa. Nessuna modifica alle impostazioni di debug CAT o agli effetti DAE.

Verificati offline **29 nuovi test** sulle funzioni effettive degli override e sul confronto dei riferimenti, oltre ai **28 test** esistenti sugli alberi. Due controlli consecutivi su 120 abilità e su 120 oggetti già allineati producono zero scritture. Verificati anche prima registrazione, modifiche reali, equivalenza degli URL, personalizzazioni locali, selezione manuale, annullamenti, errori e conservazione di usi, effetti, automazioni Khuzoe e origine negli alberi.

Per caricare il nuovo codice ricaricare completamente il client GM (Ctrl+F5). Non è stata avviata una sincronizzazione sul mondo o sul sito durante questa correzione. Copia precedente in `.maintenance/before-override-noop-fix-20260912/`. Il pacchetto remoto non è stato pubblicato.

# Khuzoe Wiki Sync 0.10.2 — 11 settembre 2026

Riorganizzato il pannello Wiki Sync per renderne leggibili i comandi. I pulsanti precedenti ereditavano l’altezza fissa di Foundry 14, facendo sovrapporre titoli e descrizioni.

- Finestra più ampia e ridimensionabile, con pulsanti ad altezza automatica e scorrimento del contenuto.
- Quattro sezioni: **Personaggi e abilità**, **Oggetti**, **Immagini e token**, **Stato e aggiornamenti**. Verifica e allineamento degli alberi sono visibili nella prima sezione.
- Descrizioni semplificate, direzione del trasferimento accanto ai comandi e modalità di sincronizzazione corrente in testa al pannello.
- Navigazione accessibile da tastiera, indicatore di operazione in corso ed esito del comando. Tutti i 15 comandi precedenti rimangono disponibili con le stesse funzioni e opzioni.

Verificata l’anteprima con gli stili locali di Foundry 14 a tre larghezze (920, 620 e 420 pixel), nelle quattro sezioni. Controllati anche tastiera, attesa ed errore di un comando simulato. Non è stata eseguita alcuna sincronizzazione sul mondo o sul sito. Copia precedente in `.maintenance/before-panel-redesign-20260911/`; immagini e controlli in `.maintenance/panel-preview-20260911/`.

# Khuzoe Wiki Sync 0.10.1 — 11 settembre 2026

Corretto l’errore «Actor is not a valid embedded Document within the Actor Document» durante l’allineamento delle abilità. La versione 0.10.0 riutilizzava un unico oggetto di opzioni tra i salvataggi. Le API di Foundry 14 modificano quell’oggetto e vi conservano `parentUuid`: dopo un’operazione su una capacità o su un effetto, il successivo salvataggio del personaggio poteva quindi usare il contesto sbagliato.

- Ogni scrittura di capacità, effetti, copie di recupero e stato di sincronizzazione riceve ora opzioni indipendenti.
- I documenti simulati nei test riproducono anche la modifica delle opzioni effettuata da Foundry. Con questa simulazione la versione precedente riproduce l’errore segnalato; quella corretta supera tutti i **28 test**.
- Verificati anche il nuovo tentativo dopo un aggiornamento parziale e l’allineamento di più personaggi con aggiunte, aggiornamenti, revoche ed effetti collegati. Il nuovo tentativo conserva le capacità già aggiornate e completa i metadati mancanti.

Per caricare la correzione occorre ricaricare completamente il client GM. Il collaudo è stato eseguito offline: non è stato avviato l’allineamento sul mondo durante questa correzione. La copia dei file precedenti è in `.maintenance/before-operation-fix-20260911/`; gli esiti dei test prima e dopo la correzione sono in `.maintenance/test-operation-fix-before-20260911.tap` e `.maintenance/test-operation-fix-after-20260911.tap`.

# Khuzoe Wiki Sync 0.10.0 — 11 settembre 2026

La sincronizzazione delle abilità allinea ora le capacità gestite agli sblocchi effettivi degli alberi non archiviati. La precedente versione aggiungeva soltanto le capacità mancanti e poteva scegliere uno stato obsoleto.

- Stati individuali: precedenza uguale al sito, con identificatore corrispondente e aggiornamento più recente. Una selezione esplicitamente vuota prevale sugli sblocchi predefiniti. Supportati anche gli alberi condivisi e le descrizioni per livello; i nodi grafici di gruppo non diventano capacità.
- Aggiunta delle capacità mancanti e aggiornamento di nome, descrizione e metadati delle capacità gestite. Attività, usi consumati, effetti incorporati, macro e configurazioni Khuzoe/Midi rimangono intatti. Le icone personalizzate vengono conservate.
- Revoca delle capacità gestite deselezionate o provenienti da alberi archiviati. Prima della rimozione viene salvata e verificata una copia completa nella scheda. Gli effetti esplicitamente collegati alla fonte ritirata vengono disattivati; Foundry gestisce inoltre i propri documenti dipendenti durante la rimozione.
- Quando la stessa capacità viene sbloccata nuovamente, si recuperano identificatore, configurazione e usi conservati. I vecchi effetti temporanei esterni non vengono riattivati automaticamente.
- Origine registrata per campagna, personaggio, albero e nodo. Una capacità con più fonti gestite resta disponibile finché una fonte è attiva. Le copie gestite duplicate o le capacità riconoscibili soltanto dal nome vengono segnalate e conservate.
- Nessuna modifica alle schede se la lettura fallisce o restituisce dati non autorevoli, incompleti o più vecchi dell’ultima sincronizzazione. I dati statici rimangono utilizzabili per la consultazione, non per revocare capacità.
- Un solo GM responsabile, coda locale con rilettura dopo gli aggiornamenti arrivati durante un’esecuzione e coordinamento tra schede del browser tramite Web Locks dove disponibile. Modalità Diagnostica e Solo Foundry → sito non eseguono l’allineamento.

## Comandi nel pannello Wiki Sync

Nella sezione **Avanzate e forzature manuali**:

- **Verifica abilità alberi** mostra un’anteprima in sola lettura delle aggiunte, degli aggiornamenti, delle revoche e dei collegamenti incerti.
- **Allinea abilità alberi** esegue la riconciliazione con le stesse regole della sincronizzazione automatica.

Le capacità aggiunte a mano o importate in passato senza un riferimento certo non vengono adottate o eliminate automaticamente. Il semplice nome non dimostra che siano gestite dal sito. Il collegamento di queste capacità resta da verificare separatamente.

## Verifica eseguita

26 test automatici superati, inclusi i punti di ingresso effettivi del modulo: stati duplicati, archiviazione, selezioni vuote, livelli, conservazione delle automazioni e degli usi, revoca/ripristino, errori e annullamenti delle scritture, fonti multiple, modalità di sincronizzazione, autorità GM e richieste concorrenti. I test usano documenti simulati; non costituiscono un collaudo nella scena Foundry.

L’anteprima offline sulla copia della campagna esaminata prevede **5 aggiunte, 7 aggiornamenti, 5 revoche e 4 collegamenti da verificare**. I quattro casi sono Cariche Tonanti, Spirito Interiore, Intelletto Arcano e Ragionamento Preciso. Non è stata eseguita alcuna sincronizzazione sul mondo reale o di test durante lo sviluppo.

## Dettagli per manutenzione

Test: `node modules/cripta-wiki-sync/tools/test-skill-tree-sync.mjs` dalla cartella Data. L’esecuzione diretta evita di avviare processi figli nel test runner di Node.

API GM: `game.modules.get("cripta-wiki-sync").api.previewSkillTreeSync()` per l’anteprima; `getSkillTreeSyncReport()` per l’ultimo risultato; `syncUnlockedSkillTreeAbilitiesToFoundry({notify: true})` per l’allineamento.

Le copie delle capacità ritirate risiedono in `actor.flags["cripta-wiki-sync"].skillTreeArchive`, indicizzate per ID originale dell’Item. Gli stati `pending`, `retired` e `restored` permettono anche il recupero dopo un’interruzione. Il contenuto delle copie non va applicato direttamente al mondo senza rivalutare gli sblocchi sul sito.

La copia dei due file preesistenti modificati è in `.maintenance/before-skill-tree-sync-20260911/`. Il confronto offline è in `.maintenance/campaign-preview-20260911.json`.
