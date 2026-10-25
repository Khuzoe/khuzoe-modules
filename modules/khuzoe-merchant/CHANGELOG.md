# Changelog

## 1.21.2 - 2026-09-21

- Il doppio clic su borse, zaini e altri contenitori D&D5e lasciati a terra apre un'anteprima del contenuto prima della raccolta. Mostra quantità, contenitori annidati e monete native contenute nelle borse.
- «Lascia a terra» e la chiusura della finestra non inviano richieste di raccolta e non modificano inventari o Token. «Raccogli» mantiene il trasferimento completo del contenitore con i suoi oggetti; per i contenitori pieni non viene più proposta una quantità parziale che il GM rifiuterebbe.
- L'anteprima rispetta la selezione del personaggio, la visibilità e la distanza di raccolta. Il GM ricontrolla disponibilità, permessi e distanza al momento del trasferimento. Nessuna migrazione o modifica diretta dei mondi.
- Sei nuove prove comportamentali su consultazione da giocatore, chiusura, trasferimento annidato, permessi, cambiamenti durante l'anteprima e raccolta ordinaria.

## 1.21.1 - 2026-09-12

- Corretta la sostituzione diretta di `CONFIG.Token.documentClass.prototype.getBarAttribute` che libWrapper segnalava come potenziale conflitto con Bar Brawl. Quando disponibile, Merchant registra ora un `WRAPPER` tramite libWrapper: chiama sempre la catena delle barre e restituisce `null` soltanto per bottino e contenitori gestiti.
- Adeguata anche l'esclusione dei bersagli in `setTarget` alla registrazione libWrapper, di tipo `MIXED` perché blocca soltanto la selezione degli oggetti a terra. Creature e deselezione mantengono la chiamata normale.
- Registrazione unica per classe e metodo fra `init`, `ready` e cambi scena. Conservato il comportamento autonomo senza libWrapper; un errore di registrazione non viene aggirato sostituendo direttamente la funzione.
- Otto nuove prove isolate: catena con il callback della versione installata di Bar Brawl nei due ordini di registrazione, barre e argomenti delle creature, esclusione del bottino, bersagli, inizializzazioni ripetute, errori e assenza di libWrapper. Le due prove Bar Brawl vengono saltate se quel modulo opzionale non è installato. Verificate anche le suite preesistenti.
- Intervento locale circoscritto a Khuzoe Merchant. Nessuna modifica a Bar Brawl, a libWrapper o ai dati del mondo; nessuna migrazione. Copia precedente in `.maintenance/before-libwrapper-bars-20260912/`. Ricaricare completamente i client Foundry (Ctrl+F5) per rimuovere la vecchia integrazione dalla memoria.

## 1.21.0 - 2026-09-11

- Identificati oggetti a terra e casse tramite i flag del modulo: esclusi come destinatari di oggetti/valute e dai controlli riservati ai personaggi.
- Disabilitate le barre delle risorse dei Token gestiti, anche già esistenti, senza riscriverne i dati. I nuovi Token hanno inoltre entrambi gli attributi delle barre vuoti e la vista disattivata.
- Esclusi i Token gestiti da bersagli, nuovi combattenti, Health Estimate, Token Action HUD e Khuzoe Monster HUD; mantenuti i normali controlli di posizionamento e configurazione. Gli adattatori risiedono soltanto in questo modulo.
- Corretto il trascinamento v14 usando le tappe del movimento nativo, con elevazione, livelli, controllo di proprietà, blocco, pausa e pulizia delle anteprime.
- Applicati gli agganci di mercanti, casse e oggetti a terra alla stessa classe Token configurata dal sistema, preservando l'apertura delle rispettive interfacce con D&D5e.
- Conservati i riferimenti tra zaini, borse e oggetti annidati durante la raccolta. I ripristini conservano anche il contenitore originario della borsa trasferita.
- Risolti i Token sorgente e destinatario per gli Actor collegati, compresi i trasferimenti tramite scheda, senza scegliere arbitrariamente fra più Token. Le convalide del GM verificano identità e distanza.
- La raccolta conserva il destinatario del primo clic soltanto per il doppio clic sullo stesso oggetto; una selezione multipla produce un errore esplicito.
- Verificate creazione, consumo e aggiornamento effettivi di Item, Token e valute, con ripristino anche in caso di scritture parziali o eccezioni successive alla scrittura.
- Aggiunta manutenzione facoltativa `groundLoot.tokenSettings()`: restituisce un'anteprima senza scritture; l'applicazione richiede il parametro esplicito `{ apply: true }` del GM principale. Nessuna nuova migrazione automatica dei dati.
- Aggiunti 31 test comportamentali isolati su raccolta, depositi, trasferimenti, permessi, movimento v14, integrazioni e recupero dagli errori, eseguibili insieme alla suite esistente con `npm test`.

## 1.20.3 - 2026-08-22

- Sostituito l'accesso ai globali deprecati `Token` e `Tile` con le classi namespaced ufficiali di Foundry v14.
- Conservato un fallback non deprecato tramite `CONFIG` per i test e gli ambienti che inizializzano le classi canvas in ritardo.

## 1.20.2 - 2026-08-21

- Ripristinate le icone native dei controlli ApplicationV2 nella barra superiore: la tipografia del modulo ora è limitata ai pulsanti dentro il contenuto della finestra.

## 1.20.1 - 2026-08-21

- Corrette le schede Catalogo, Produzione e quelle dei contenitori sotto ApplicationV2: la radice form nativa non viene più scambiata per un wrapper legacy indicizzato.
- Aggiunto un test di regressione specifico per le radici HTMLFormElement di Foundry v14.

## 1.20.0 - 2026-08-21

- Migrati negozio, contenitore, configurazione mercante, configurazione contenitore e registro economico a `ApplicationV2` con parti Handlebars e azioni native v14.
- Migrati selezione quantità e conferma dei trasferimenti a `DialogV2`.
- Aggiunto un tema v14 separato che usa le variabili di Foundry, supporta modalità chiara/scura, focus da tastiera e movimento ridotto.
- Aggiunti al negozio filtri per articoli acquistabili/disponibili, ordinamento per nome/prezzo/scorta e controlli quantità `− / +`.
- Aggiunte al catalogo GM selezione multipla, variazione collettiva dei prezzi, impostazione collettiva delle scorte e indicatore di modifiche non salvate.
- Aggiunte validazione in tempo reale e anteprima delle conversioni al registro economico.
- Conservati formato dei flag, archivio GM, inventari, valute, produzione e protocollo transazionale: l'aggiornamento della UI non richiede migrazioni dei dati.

## 1.19.0 - 2026-08-21

- Migrato il manifest a Foundry Virtual Tabletop v14.367, rimuovendo il limite massimo alla v12.
- Aggiunto il controllo **Mercante** alle intestazioni ApplicationV2 di Actor e NPC, mantenendo il controllo legacy per le finestre ApplicationV1.
- Spostata l'integrazione del portafoglio sul hook generico `renderApplicationV2`, compatibile con le schede Actor e Item di D&D5e 5.3.3.
- Il rinnovo delle schede aperte considera ora sia le finestre ApplicationV1 sia il registro delle applicazioni v14.
- Adeguato lo strumento **Crea contenitore** alla struttura a record dei controlli scena v14 e al callback `onChange`.
- Adeguati `FilePicker` e `ImagePopout` alle classi namespaced e ai costruttori ApplicationV2 di Foundry v14.
- Conservate le finestre del modulo su ApplicationV1, ancora disponibile in Foundry v14, senza modificare dati, flag, inventari, valute o protocollo delle transazioni.
- Verificate le firme v14 delle interazioni Token usate da mercanti, contenitori e oggetti a terra.

## 1.18.1 - 2026-08-21

- Corretto il caricamento dell'interfaccia 1.18 nelle installazioni Foundry v12 che conservavano l'elenco dei fogli di stile della versione precedente.
- Il percorso storico `styles/merchant.css` è ora un punto di ingresso stabile che carica prima le regole di base e poi il nuovo layout, con versione esplicita per evitare copie in cache.
- All'avvio il modulo verifica inoltre che il foglio dell'interfaccia ridisegnata sia presente e, se necessario, lo aggiunge con un URL legato alla versione installata.
- Mercante e contenitore mantengono così le schede su una sola riga, i riepiloghi in griglia, l'area centrale scorrevole e il piè di pagina separato anche dopo un aggiornamento sopra una versione esistente.

### Aggiornamento non distruttivo

- La correzione riguarda esclusivamente il caricamento dei fogli grafici; non legge, migra o riscrive dati di mercanti, contenitori, inventari, valute, chiavi o produzione.

## 1.18.0 - 2026-08-21

- Ridisegnate integralmente le finestre di mercanti e contenitori, mantenendo tutte le meccaniche già presenti.
- La configurazione del mercante è ora divisa nelle schede **Generale**, **Catalogo** e **Produzione**; quella del contenitore usa **Generale**, **Contenuto**, **Serratura** e **Produzione**.
- Intestazione, navigazione e comandi di salvataggio rimangono fermi, mentre soltanto l'area di lavoro centrale scorre: liste lunghe, valute e regole di produzione non si sovrappongono più al piè di pagina.
- Oggetti, valute, riepiloghi, aree di deposito e impostazioni sono più compatti, leggibili e coerenti nelle proporzioni.
- Le finestre dei giocatori usano tutta la larghezza disponibile; ricerca, conteggio, modalità **Elenco / Completa**, fondi, disponibilità e azioni restano immediatamente riconoscibili.
- La vista del contenitore distingue chiaramente chiave inserita, deposito, valute e bottino, conservando immagini ingrandibili e dettagli completi degli oggetti.
- Migliorato il comportamento nelle finestre strette: controlli e schede si ricompongono senza scorrimenti orizzontali indesiderati.
- Le schede di configurazione supportano anche tastiera, stato attivo accessibile e conteggi sintetici.
- Aggiunto un foglio di compatibilità grafica caricato dopo gli stili precedenti, così l'aggiornamento prevale anche sulle installazioni che hanno già usato le vecchie interfacce.

### Aggiornamento non distruttivo

- L'aggiornamento modifica presentazione e navigazione, ma non cambia il formato di inventari, prezzi, scorte, valute, chiavi, produzione o archivio GM.
- Nessuna configurazione esistente viene migrata, azzerata o salvata automaticamente soltanto per avere installato questa versione.
- Tutti i flussi di acquisto, deposito, prelievo, inserimento della chiave e produzione continuano a usare le convalide e i rollback autorevoli già presenti.

## 1.17.0 - 2026-08-21

- Aggiunta la produzione periodica configurabile sia ai mercanti sia ai contenitori.
- Ogni regola supporta formule di quantità sicure come `1d2` o `1d4+1`, probabilità percentuale e limite massimo della scorta.
- La modalità **Risultati alternativi** sceglie al massimo una riga e ammette una percentuale residua senza produzione; la modalità **Probabilità indipendenti** tira separatamente ogni riga.
- La frequenza usa a scelta i giorni del mondo di gioco o il tempo reale; i cicli trascorsi vengono recuperati con un limite configurabile e quelli eccedenti sono saltati senza accumuli incontrollati.
- Il comando **Produci ora** esegue un ciclo manuale senza spostare la scadenza automatica; gli ultimi 30 cicli restano consultabili nella configurazione GM.
- Gli oggetti esauriti nei contenitori conservano il modello necessario a ricomparire, mentre le casse produttive non vengono eliminate quando la scorta corrente arriva a zero.
- Le regole, gli snapshot degli oggetti e il registro restano nel Journal protetto; nei flag visibili ai giocatori viene pubblicato soltanto lo stato minimo necessario al controllo delle scadenze.
- Gli aggiornamenti degli Item originali sincronizzano anche i modelli usati dalla produzione.

### Aggiornamento non distruttivo

- Mercanti e contenitori delle versioni precedenti ricevono in lettura una configurazione di produzione vuota e disattivata: nessun oggetto viene aggiunto automaticamente dopo l'aggiornamento.
- Inventari, prezzi, scorte, valute, serrature e riferimenti all'archivio esistenti non vengono riscritti finché il documento non viene normalmente salvato o aggiornato.
- Disattivare temporaneamente la produzione conserva regole, formule e registro; riattivandola il conteggio riparte dal nuovo salvataggio senza recuperare il periodo di sospensione.

## 1.16.0 - 2026-08-21

- Tutte le mutazioni di mercanti, contenitori, trasferimenti e bottini a terra passano ora da una sola coda autorevole; le richieste socket sono idempotenti, le conclusioni recenti vengono conservate in un piccolo registro del mondo per il passaggio fra GM e un timeout interroga lo stato senza rieseguire l'operazione.
- Aggiunte revisioni alle configurazioni: una finestra GM rimasta aperta non può più sovrascrivere acquisti, depositi, prelievi o sincronizzazioni avvenuti nel frattempo.
- I contenitori Item di D&D5e conservano ricorsivamente il proprio contenuto durante acquisti, depositi, raccolte e trasferimenti; il legame `system.container` viene ricostruito con ID nuovi.
- Lo stacking automatico è limitato agli oggetti realmente compatibili e confronta le personalizzazioni; armi, equipaggiamenti e contenitori non vengono più fusi.
- Le descrizioni pubbliche escludono le sezioni segrete o riservate a GM/proprietario.
- I trasferimenti tra Actor richiedono per impostazione predefinita il possesso del destinatario e la vicinanza fra Token; il GM può riabilitare esplicitamente le consegne ad Actor non posseduti.
- La selezione del GM primario segue l'elezione nativa di Foundry v12.
- Le chiavi restituite mantengono un'identità stabile e possono essere reinserite senza sparire o risultare errate.
- Gli snapshot completi di mercanti e contenitori vengono migrati, senza cancellazioni, in un Journal con permessi riservati ai GM; Actor e Token espongono soltanto i dati necessari alle interfacce, mentre uno scrigno chiuso nasconde anche elenco e valute.
- Il registro valute rifiuta revisioni remote obsolete, ID o percorsi duplicati; la sincronizzazione col sito è manuale per impostazione predefinita e usa un timeout di rete.
- Le valute archiviate restano invisibili ai giocatori ma sono visibili e recuperabili dal GM nei contenitori.
- Ridotte le risoluzioni ripetute degli UUID durante i render e mantenuto un indice leggero delle fonti negli scrigni protetti.
- Rimossi i sorgenti obsoleti duplicati; il CSS dei contenitori resta consolidato nel foglio principale caricato dal manifest.
- Ampliati i test automatici per idempotenza, chiavi, stacking, permessi, vault e trasferimenti D&D5e.

### Aggiornamento non distruttivo

- I flag `merchant` e `container` esistenti vengono normalizzati in lettura; inventari, scorte, prezzi, valute e snapshot preesistenti non vengono cancellati.
- I nuovi campi (`revision`, `dataBundle`, identità chiave e riferimento vault) vengono aggiunti soltanto quando il documento viene aggiornato o migrato.
- Prima di alleggerire un vecchio mercante o contenitore, il modulo salva con successo la copia completa nell'archivio GM. Se l'Actor o il Token non può essere aggiornato, anche l'archivio viene riportato allo stato precedente.

## 1.15.1 - 2026-07-25

- La chiave inserita viene ora verificata sull'inventario sorgente prima di aprire lo scrigno.
- Riprendere la chiave crea sempre un Item fisico distinto nell'inventario destinatario, senza confonderlo con copie omonime o nasconderlo dentro un contenitore D&D5e.
- Lo scrigno si richiude soltanto dopo aver verificato che il nuovo Item sia realmente presente; in caso contrario l'operazione viene annullata.
- Le schede inventario vengono aggiornate immediatamente dopo inserimento e restituzione della chiave.


## 1.15.0 - 2026-07-25

- I giocatori possono depositare oggetti e valute in un contenitore aperto dalla sua finestra oppure trascinandoli direttamente sul Token in mappa.
- Il GM può associare a ogni scrigno una chiave-oggetto specifica tramite una nuova area nella configurazione.
- Trascinare la chiave corretta dal proprio inventario sullo scrigno ne consuma una unità, la inserisce nella serratura e apre il contenuto a tutti.
- La vista dello scrigno aperto mostra una cella dedicata alla chiave; riprenderla la restituisce al personaggio e richiude immediatamente lo scrigno.
- Chiavi errate, distanze, proprietà e quantità vengono convalidate dal GM con rollback automatico delle operazioni incomplete.
- Gli scrigni con serratura non vengono eliminati automaticamente quando il normale bottino termina.

## 1.14.1 - 2026-07-25

- Depositare oggetti o valute da un inventario in un contenitore ora li rimuove realmente dall'Actor sorgente.
- I depositi sono salvati subito, serializzati dal GM e ripristinano automaticamente la sorgente se l'aggiornamento della cassa fallisce.
- Gli Oggetti trascinati dal mondo o da un Compendio restano disponibili come copie amministrative del GM.
- La configurazione GM include il pulsante «Preleva con il token selezionato», che apre la normale interfaccia di prelievo per il destinatario scelto.
- Il GM può amministrare un prelievo anche oltre la distanza di interazione, mentre il limite resta invariato per i giocatori.

## 1.14.0 - 2026-07-25

- Oggetti e valute multiple chiedono ora la quantità quando vengono posati a terra, trasferiti oppure aggiunti a un contenitore.
- Il doppio clic su un bottino a terra permette di raccoglierne solo una parte; ciò che resta rimane sulla mappa.
- I pulsanti dei contenitori aprono la stessa scelta di quantità per oggetti e valute, mentre «Prendi tutto» resta immediato.
- Le quantità richieste vengono ricontrollate dal GM e i trasferimenti parziali mantengono il ripristino automatico in caso di errore.

## 1.13.3 - 2026-07-25

- Rimossa dall'interfaccia la stringa con il percorso dell'immagine: il GM cambia l'aspetto cliccando direttamente sull'anteprima del contenitore.
- Le valute archiviate non vengono più mostrate nella configurazione GM né nella finestra dei giocatori.
- Gli importi archiviati già presenti restano conservati nei dati e non vengono trasferiti inavvertitamente con «Prendi tutto».


## 1.13.2 - 2026-07-25

- Incorporato il layout dei contenitori nel foglio grafico principale, così viene caricato correttamente anche nelle installazioni già esistenti.
- Corrette definitivamente le immagini delle monete fuori scala e la disposizione del selettore dell'immagine.
- Verificati nel mondo Foundry la griglia delle valute, lo scorrimento centrale e il piè di pagina fisso senza sovrapposizioni.


## 1.13.1 - 2026-07-25

- Ridisegnate le finestre dei contenitori con proporzioni più compatte e coerenti.
- La configurazione GM e l'apertura giocatore hanno ora un'area centrale sempre scorrevole.
- Le schede degli oggetti non ereditano più larghezze inadatte dal negozio e i comandi non si sovrappongono.
- Migliorata la disposizione responsive di valute, quantità, dettagli e pulsanti di prelievo.
- Le descrizioni complete restano leggibili senza spezzare il layout.
## 1.13.0 - 2026-07-25

- Il GM può creare contenitori dalla barra strumenti della scena e collocarli con un clic nel punto desiderato.
- I contenitori sono Token sbloccati e possono essere spostati normalmente sulla mappa dal GM.
- Oggetti, quantità, monete native e valute personalizzate vengono configurati in un'unica finestra italiana.
- I giocatori aprono i contenitori con doppio clic sinistro e possono prendere un oggetto, una valuta oppure tutto il contenuto.
- I prelievi vengono convalidati e serializzati dal GM, con ripristino automatico in caso di errore.
- Un contenitore vuoto può restare sulla mappa oppure eliminarsi automaticamente.
- Le descrizioni e le immagini degli oggetti seguono la fonte originale, conservando uno snapshot di sicurezza.

## 1.12.0 - 2026-07-21

- Gli oggetti a terra usano un unico Actor tecnico condiviso, così Token Action HUD e le interazioni native non ricevono più Token senza Actor.
- Il trascinamento torna al ciclo nativo di Foundry: proprietario e GM possono spostare i drop senza errori di pressione prolungata.
- I vecchi oggetti a terra e le vecchie Tile vengono migrati automaticamente e in modo non distruttivo all'avvio del GM.
- La creazione concorrente del proxy è protetta per evitare duplicati quando più drop partono insieme.


## 1.11.0 - 2026-07-21

- Trascinare un Item su un altro Token o sulla sua scheda propone il trasferimento diretto invece del deposito a terra.
- I trasferimenti tra Actor sono convalidati dal GM e ripristinano automaticamente il destinatario se la rimozione dalla sorgente fallisce.
- Gli oggetti a terra possono essere spostati dal giocatore che li ha depositati oppure dal GM, senza perdere il Token selezionato per la raccolta.
- Il comando Mercante compare soltanto nell'intestazione delle schede Actor.
- Le valute personalizzate compaiono solo nei portamonete nativi, inclusi i container, e non nelle finestre di uso di oggetti o abilità.
- Le denominazioni archiviate, come l'electrum, vengono nascoste senza cancellare i saldi esistenti.

## 1.10.0 - 2026-07-20

- La raccolta usa esclusivamente l'Actor dell'unico token selezionato.
- Il trascinamento normale deposita l'intero stack; con Alt viene depositata una sola unità.
- Alla raccolta gli Item compatibili vengono sommati allo stack esistente con rollback atomico.
- Monete D&D5e e valute personalizzate possono essere trascinate dal portamonete e raccolte da un altro Actor.
- Le valute usano la propria icona configurata o un'illustrazione coerente di fallback.

## 1.9.0 - 2026-07-20

- Gli oggetti a terra sono veri Token leggeri senza Actor dedicato, non Tile.
- I Token-oggetto sono più naturali da selezionare e spostare per il GM e conservano il doppio clic per la raccolta.
- Le vecchie Tile create dal modulo vengono convertite automaticamente e rimosse solo dopo la creazione riuscita del Token equivalente.
- Nomi e messaggi di drop/raccolta vengono normalizzati e non mostrano più caratteri corrotti.

## 1.8.2 - 2026-07-20

- Il GM attivo esegue drop e raccolta localmente, senza attendere il ritorno del proprio messaggio socket.
- Per i giocatori la mediazione del GM resta interamente automatica e non richiede conferme o pulsanti.
- Le risposte locali mantengono la stessa coda e le stesse garanzie di rollback del percorso remoto.

## 1.8.1 - 2026-07-20

- Rimosso il comando dalle schede: gli oggetti si depositano trascinandoli direttamente sulla mappa.
- Il trascinamento funziona sia dagli inventari degli Actor sia dalla Directory Item.
- Dall'inventario viene trasferita una unita; dalla Directory il GM crea una copia senza consumare il modello.
- L'anteprima compare nel punto scelto e il doppio clic la raccoglie senza finestre intermedie.
- Tutte le operazioni continuano a essere verificate, serializzate ed eseguite dal client GM.

## 1.8.0 - 2026-07-20

- Gli Item posseduti possono essere buttati a terra dalla loro scheda.
- L'oggetto viene mostrato nella scena come anteprima della propria immagine e raccolto con doppio clic.
- Drop e raccolta sono verificati dal GM attivo, serializzati e dotati di rollback per evitare perdite o duplicazioni.
- Quantità, flag, icone Tokenizer e dati completi dell'Item seguono il trasferimento.

## 1.7.0 - 2026-07-19

- Le valute personalizzate possono usare l'icona configurata nel registro condiviso.
- Nelle schede D&D5e appaiono con lo stesso formato compatto delle monete native.
- Il simbolo della valuta resta disponibile come fallback quando manca un'icona.

## 1.6.2 - 2026-07-19

- La configurazione valute usa un recupero diretto dal sito se il ponte interno con Cripta Wiki Sync fallisce.
- Gli errori di sincronizzazione mostrano ora la causa direttamente nella finestra.

## 1.6.1 - 2026-07-19

- Le valute personalizzate compaiono direttamente nel portamonete delle schede Actor, accanto alle monete native.
- Il registro valute forza un aggiornamento dal sito quando viene aperto e mostra chiaramente lo stato della sincronizzazione.
- Corretta la scrollbar della configurazione con molte valute.

## 1.6.0 - 2026-07-19

- Aggiunto il registro valute configurabile del mondo con gruppi convertibili o indipendenti.
- Le valute personalizzate usano campi stabili sull'Actor e seguono gli oggetti tra personaggi diversi.
- Prezzi e acquisti supportano valute personalizzate senza perdere la compatibilit? con i prezzi D&D5e esistenti.
- Le valute rimosse vengono archiviate e possono essere ripristinate senza cancellare saldi o riferimenti storici.

## 1.5.0 - 2026-07-19

- L'interfaccia del modulo viene mostrata in italiano anche sui client Foundry impostati in inglese.
- Tradotti gli ultimi messaggi tecnici e corretti gli accenti mancanti.

## 1.4.2 - 2026-07-19

- Aggiunto nella configurazione un pulsante per aprire la scheda dell'Item originale.
- Le modifiche salvate nell'Item continuano a sincronizzarsi automaticamente con il mercante.

## 1.4.1 - 2026-07-19

- Corretto lo stock mostrato ai player sui token NPC non collegati.
- Lettura e decremento della scorta usano ora sempre l'Actor principale del mercante.
- Aumentata la dimensione di prezzo e disponibilita nel catalogo.

## 1.4.0 - 2026-07-19

- Nome, immagine, tipo e descrizione degli articoli si sincronizzano con l'Item originale.
- Prezzo e scorta restano personalizzabili per ciascun mercante.
- Migliorato il contrasto del selettore valuta e del pulsante Dettagli.

## 1.3.2 - 2026-07-19

- Le configurazioni aperte da token non collegati vengono ora salvate sull'Actor principale.
- Le configurazioni gia presenti sugli Actor sintetici vengono adottate automaticamente senza eliminare i dati originali.
- Migliorata l'integrazione automatica con Cripta Wiki Sync e il sito.

## 1.3.1 - 2026-07-18

- Corretto il trascinamento degli Item D&D5e 4.4.4 evitando l'accesso al percorso rimosso Item.data.
- Conservata la compatibilita con gli snapshot legacy gia salvati nei mercanti.

## 1.3.0 - 2026-07-18

- Rimosso il segnalino numerico della distanza dalla barra del negozio.
- In modalita Lista ogni articolo ha un pulsante Dettagli che espande la singola scheda.
- Le immagini possono essere ingrandite con un clic sia in Lista sia in Completa.
- Riordinate le etichette di quantita e totale e separati meglio i comandi di acquisto.

## 1.2.0 — 2026-07-18

- Aggiunto il selettore personale **Lista / Completa** nel negozio.
- La modalità Lista presenta un catalogo sintetico; la modalità Completa mostra descrizioni integrali.
- In modalità Completa le immagini degli articoli possono essere aperte e ingrandite.
- Le descrizioni non vengono più troncate a 180 caratteri e vengono recuperate anche dagli snapshot esistenti.

## 1.1.4 — 2026-07-18

- Corretto il doppio clic dei giocatori sui mercanti privi di permessi Actor.
- Il controllo di visualizzazione del token consente l'interazione soltanto per i mercanti attivi, senza concedere proprietà o controllo dell'NPC.
- Le patch dell'interazione vengono ora installate durante `init`, prima che Foundry costruisca i gestori dei token sulla mappa.

## 1.1.3 — 2026-07-18

- Rimossa la barra di configurazione interna alla scheda NPC perché troppo invasiva.
- La configurazione resta disponibile come piccolo comando **Mercante** nell'intestazione della finestra.
- Conservato l'hook specifico delle schede Actor necessario per D&D5e 4.4.4.

## 1.1.2 — 2026-07-18

- Confermata l'apertura del negozio per i giocatori tramite doppio clic sinistro sul token mercante.
- Non sono richiesti clic destro, controllo o proprietà del token NPC.
- La selezione automatica del personaggio assegnato o del token posseduto più vicino è ora il comportamento predefinito.
- L'intercettazione usa la classe Token configurata dal sistema, migliorando la compatibilità con D&D5e.

## 1.1.1 — 2026-07-18

- Aggiunto il supporto all'hook specifico delle schede Actor di Foundry v12.
- Aggiunto un pulsante **Configura mercante** sempre visibile dentro la scheda NPC D&D5e 4.4.4.
- Il pulsante mostra chiaramente se il mercante è attivo, senza aggiungere controlli all'HUD del token.

## 1.1.0 — 2026-07-18

- Rimossa l'icona di configurazione dall'HUD del token; il mercante si configura dalla scheda NPC.
- Autenticati mittente e risposte delle transazioni tramite l'identità fornita da Foundry.
- Impediti acquisti da scene diverse da quella visualizzata dal giocatore.
- Allineate valuta mostrata e valuta addebitata, incluso l'arrotondamento minimo al rame in D&D5e.
- Quantità massima limitata automaticamente da fondi e scorte.
- Migliorati ricerca, stati dei pulsanti, accessibilità, responsive e rifinitura grafica.

## 1.0.0 — 2026-07-18

- Prima versione completa per Foundry Virtual Tabletop v12.
- Configurazione mercante, catalogo drag-and-drop e scorte.
- Negozio responsive con apertura a distanza tramite doppio clic.
- Transazioni convalidate dal GM, adattatore D&D5e e valuta singola configurabile.
- Localizzazione italiana e inglese.



