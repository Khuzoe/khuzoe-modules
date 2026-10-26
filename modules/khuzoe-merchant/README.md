# Khuzoe Merchant

Modulo per **Foundry Virtual Tabletop v14** che trasforma un NPC in un mercante interattivo. Il GM prepara il catalogo trascinando normali documenti Item; i giocatori aprono il negozio con un doppio clic sul token e possono acquistare solo quando un proprio token è abbastanza vicino.

## Funzioni

- In Lista ogni articolo puo essere espanso con **Dettagli**; le immagini sono ingrandibili in entrambe le visualizzazioni.

- Piccolo comando **Mercante** nell'intestazione della scheda NPC, senza aggiungere controlli dentro la scheda o nell'HUD del token.
- Inventario drag-and-drop da Directory Item, Compendi o inventari degli Attori.
- Prezzo modificabile, valuta e scorta finita oppure illimitata per ogni articolo.
- Negozio ApplicationV2 responsive con ricerca, filtri per disponibilità, ordinamento, selettore quantità `− / +`, saldo, scorte e aggiornamento del totale.
- Visualizzazione personale **Lista / Completa**; la modalità completa mostra il testo integrale e permette di ingrandire le immagini.
- Configurazioni organizzate per attività: **Generale / Catalogo / Produzione** per i mercanti e **Generale / Contenuto / Serratura / Produzione** per le casse.
- Il catalogo GM permette selezioni multiple e modifiche collettive di prezzi e scorte, con indicatore delle modifiche non salvate.
- Il registro economico valida identificatori e percorsi in tempo reale e mostra un'anteprima dei cambi automatici.
- Tema nativo Foundry v14, compatibile con modalità chiara e scura, tastiera e preferenza di movimento ridotto.
- Intestazioni e comandi principali restano visibili, mentre inventari, valute e regole scorrono in una sola area centrale anche nelle finestre più strette.
- Distanza configurabile per ogni mercante, misurata tra i bordi dei token nelle unità della scena.
- Acquisti autorizzati dal GM con controllo di proprietà, scena, distanza, quantità, prezzo, saldo e scorta.
- Coda transazionale unica per acquisti, contenitori, trasferimenti e oggetti a terra, con richieste idempotenti e controllo dello stato dopo un timeout.
- Ripristino automatico della valuta e rimozione dell'Item creato se una transazione non può essere completata.
- Ricevute private opzionali in chat.
- Contenitori condivisi collocabili dalla barra della scena, con oggetti, quantità, monete e valute personalizzate.
- I contenitori sono Token sbloccati: il GM può selezionarli e spostarli normalmente sulla mappa.
- I giocatori li aprono con doppio clic sinistro, depositano trascinando dal proprio inventario e scelgono quanto prendere di ogni oggetto o valuta.
- Oggetti e valute posseduti possono essere posati sulla mappa scegliendone la quantità; i giocatori vicini li raccolgono interamente o in parte con doppio clic.
- Il trasferimento inventario → scena → inventario è convalidato dal GM e usa rollback automatici per evitare perdite o duplicazioni.
- Zaini e contenitori Item di D&D5e conservano gli oggetti annidati durante acquisto, deposito, raccolta e trasferimento.
- Gli snapshot completi di mercanti e contenitori restano in un archivio riservato ai GM; Actor e Token espongono soltanto i dati necessari all'interfaccia, e gli scrigni chiusi nascondono anche elenco e valute.
- Mercanti e contenitori possono produrre periodicamente oggetti con formule come `1d2`, probabilità alternative o indipendenti, limiti di scorta e recupero controllato dei cicli trascorsi.
- Interfaccia e documentazione in italiano; anche i client impostati in inglese caricano intenzionalmente la localizzazione italiana.

## Compatibilità

- Foundry Virtual Tabletop: **v14**, verificato con la build **14.367**.
- D&D5e: verificato con **5.3.3**; le valute native, i contenitori Item e le schede ApplicationV2 sono supportati.
- D&D5e: adattatore automatico per `pp`, `gp`, `ep`, `sp` e `cp`, incluso il cambio tra denominazioni.
- Altri sistemi: adattatore a valuta singola configurabile dalle impostazioni del modulo.
- Non richiede moduli o librerie esterne.

## Installazione manuale

1. Chiudi Foundry VTT.
2. Estrai la cartella `khuzoe-merchant` in `{Foundry User Data}/Data/modules/`.
3. Verifica che il manifest si trovi esattamente in `Data/modules/khuzoe-merchant/module.json` e non in una cartella annidata aggiuntiva.
4. Avvia Foundry, apri il mondo v14 e abilita **Khuzoe Merchant** in **Gestione Moduli**.

Il file ZIP distribuito contiene già la cartella radice corretta. Per pubblicare il modulo tramite URL manifest, aggiungi al `module.json` i campi `url`, `manifest` e `download` dopo avere caricato il progetto su un host raggiungibile.

## Utilizzo per il GM

1. Apri la scheda di un Attore di tipo `npc` e premi **Mercante** nell'intestazione della finestra. Se lo spazio è ridotto, il comando può trovarsi nel menu dei controlli della finestra.
2. Nella scheda **Generale**, attiva l'interruttore **Mercante** e scegli sottotitolo e distanza massima.
3. Apri **Catalogo** e trascina gli Item nell'area tratteggiata.
4. Modifica prezzo, sigla della valuta e scorta. Lascia la scorta vuota per renderla illimitata.
5. Se serve, configura il rifornimento nella scheda **Produzione**.
6. Salva la configurazione e colloca il token dell'NPC nella scena.

Il tipo Actor predefinito è `npc`. Se il sistema usa nomi diversi, modifica **Tipi di Attore mercante** nelle impostazioni del modulo con un elenco separato da virgole (per esempio `npc,creature`) oppure usa `*`.

### Creare e usare un contenitore

1. Seleziona gli strumenti **Token** nella barra a sinistra della scena e premi **Crea contenitore**.
2. Clicca sulla mappa nel punto desiderato; `Esc` annulla il posizionamento.
3. In **Generale**, scegli nome, immagine e comportamento quando il contenitore si svuota.
4. In **Contenuto**, trascina Item o valute nell'area tratteggiata e scegli la quantità. Se provengono da un inventario vengono rimossi dall'Actor sorgente; gli Oggetti del mondo o dei Compendi vengono copiati come modelli del GM. Il deposito viene salvato subito.
5. Se vuoi proteggerlo, apri **Serratura** e trascina l'Item che fungerà da chiave: lo scrigno verrà chiuso quando salvi.
6. Salva. Il Token può essere selezionato e spostato normalmente dal GM.

Per modificare un contenitore esistente, il GM fa doppio clic sinistro sul suo Token. Per prelevare, seleziona prima il Token del personaggio destinatario e usa **Preleva con il token selezionato** nella configurazione. I giocatori aprono direttamente gli scrigni non protetti o già aperti con doppio clic e possono depositare dalla finestra o trascinando sul Token. Uno scrigno chiuso si apre trascinando la chiave corretta dal proprio inventario sul Token: una unità viene inserita nella serratura e scompare dall'inventario. La cella **Chiave inserita** permette di riprenderla: la chiave viene ricreata come Item distinto nell'inventario del destinatario e solo dopo lo scrigno si richiude. Per ogni oggetto o valuta si sceglie la quantità; **Prendi tutto** trasferisce l'intero contenuto senza ulteriori richieste.

Durante il primo avvio dopo l'aggiornamento, mercanti e contenitori esistenti vengono copiati in un Journal riservato ai GM prima che i flag pubblici vengano alleggeriti. Il Journal resta come copia di recupero e non viene eliminato automaticamente.

### Produzione periodica

La scheda **Produzione** è disponibile nella configurazione di ogni mercante e contenitore. È disattivata per impostazione predefinita, compresi tutti i documenti creati con versioni precedenti.

1. Aggiungi normalmente al mercante o al contenitore gli oggetti che serviranno da modello.
2. Attiva **Produzione periodica** e seleziona le righe da produrre.
3. Per ciascuna riga imposta una quantità (`1d2`, `2`, `1d4+1`), una probabilità e, se desiderato, una scorta massima.
4. Scegli la modalità **Risultati alternativi** per ottenere al massimo un risultato per ciclo. La somma delle percentuali non può superare il 100%; l'eventuale parte restante produce un ciclo vuoto.
5. Scegli **Probabilità indipendenti** se ogni oggetto deve effettuare il proprio tiro e possono quindi essere prodotti più oggetti nello stesso ciclo.
6. Imposta la frequenza in giorni e scegli se usare il tempo del mondo di gioco oppure il tempo reale.
7. Salva per avviare il conteggio. **Produci ora** esegue un ciclo di prova senza spostare la prossima scadenza automatica.

Esempio: frequenza di due giorni, modalità alternativa, `1d2 Lunarmana Rosso` al 25% e `1d2 Lunarmana Rosso Instabile` al 75%. A ogni ciclo viene scelto uno dei due risultati e la quantità viene tirata dal GM.

I cicli trascorsi vengono recuperati all'apertura del mondo, entro il limite configurato; quelli più vecchi vengono segnati come saltati per impedire accumuli enormi. Il registro conserva gli ultimi 30 cicli nell'archivio riservato al GM. Un contenitore con produzione attiva non scompare quando la scorta corrente arriva a zero, e un oggetto esaurito può essere ricreato dal modello conservato. Per i mercanti la produzione richiede una scorta numerica: gli articoli illimitati non possono aumentare.

## Utilizzo per i giocatori

1. Porta il token del tuo personaggio entro la distanza configurata dal mercante.
2. Fai **doppio clic sinistro** sul token del mercante: non servono clic destro né permessi sull'NPC.
3. Il modulo usa automaticamente il personaggio assegnato all'utente o il token posseduto più vicino.
4. Scegli quantità e articolo, quindi premi **Acquista**.

Il GM può attivare **Richiedi un token controllato** nelle impostazioni del modulo se preferisce obbligare i giocatori a selezionare prima il proprio token.

Almeno un GM deve essere connesso. Se il personaggio si allontana mentre il negozio è aperto, la finestra lo segnala e il GM rifiuta ogni acquisto fuori portata.

## Configurazione valuta

Le impostazioni si trovano in **Configura impostazioni → Impostazioni modulo → Khuzoe Merchant**.
Sono impostazioni del mondo e non vengono mostrate ai normali giocatori.

### Modalità automatica / D&D5e

Con il sistema `dnd5e`, la modalità automatica legge il portamonete da `system.currency` e il prezzo dall'Item. Il costo viene convertito in rame, sottratto dal valore complessivo e il resto viene ricomposto in monete. Questo consente, per esempio, di acquistare un oggetto in `sp` possedendo soltanto `gp`.

### Modalità valuta singola

Per gli altri sistemi configura:

- **Percorso valuta dell'Attore**: campo numerico aggiornabile, per esempio `system.currency.gp`.
- **Percorso prezzo dell'Oggetto**: campo letto quando l'Item viene aggiunto, per esempio `system.price.value`.
- **Etichetta valuta**: testo mostrato nell'interfaccia, per esempio `mo` o `crediti`.

I percorsi sono limitati al ramo `system.*`. Il prezzo importato è solo un valore iniziale: il GM può sempre correggerlo nel catalogo. Se un sistema usa più valute con regole proprie e non è D&D5e, usa una valuta contabile unica oppure aggiungi un adattatore dedicato in `scripts/currency-v2.js`.


### Registro valute del mondo

Il GM può aprire **Configura valute** dalle impostazioni del modulo e creare gruppi di valute convertibili oppure indipendenti. Le valute D&D restano nei campi nativi dell'Actor; le valute personalizzate vengono conservate in `flags.khuzoe-merchant.wallet.<id>`, così un oggetto può passare da un personaggio all'altro senza dipendere dalla sua cartella o dal proprietario originale.

Le valute non si eliminano in modo distruttivo: vengono archiviate e possono essere ripristinate. Il GM continua a vederne gli importi nei contenitori e può recuperarli; i giocatori non li vedono. Ogni prezzo può usare una valuta attiva; il motore degli acquisti verifica e sottrae in un unico aggiornamento sia monete convertibili sia valute indipendenti. La sincronizzazione col sito è manuale per impostazione predefinita e rifiuta snapshot meno recenti o registri con identificatori e percorsi duplicati.

### Oggetti a terra

Non viene aggiunto alcun pulsante alle schede. Trascina un Item o una valuta direttamente sulla mappa e scegli la quantità:

- dall'inventario di un Actor viene trasferita la quantità scelta e la quantità residua viene aggiornata;
- dalla Directory Item il GM deposita una copia e il documento originale resta disponibile come modello;
- l'immagine viene mostrata nel punto esatto del rilascio;
- seleziona un solo Token personaggio e fai doppio clic sull'oggetto per scegliere quanto raccogliere, entro la distanza configurata; una selezione multipla viene segnalata senza scegliere un destinatario;
- il trascinamento normale permette di scegliere la quantità, mentre Alt deposita una sola unità;
- gli stack uguali vengono riuniti automaticamente alla raccolta;
- anche monete native e valute personalizzate si trascinano dalla loro icona nel portamonete: trascinamento normale per scegliere la quantità, Alt per una unità.

Creazione, consumo e raccolta sono sempre ricalcolati dal GM attivo. In caso di errore la procedura annulla la parte già eseguita, evitando per quanto possibile perdite o duplicazioni. Gli stack vengono uniti soltanto quando il tipo e tutti i dati rilevanti coincidono; armi ed equipaggiamenti non vengono mai fusi automaticamente.

Oggetti a terra e casse continuano a essere Token con un Actor di supporto: il modulo li riconosce dai propri flag e ne esclude barre delle risorse, bersaglio, combattimento e comandi delle creature. Sono presenti adattatori facoltativi per Health Estimate, Token Action HUD e Khuzoe Monster HUD. Il modello NPC di supporto conserva i campi richiesti dal sistema, ma non viene usato come destinatario degli inventari o come personaggio da configurare.

Il GM e il giocatore che ha posato un oggetto possono spostarlo. Il movimento usa il percorso nativo v14, compresi elevazione e livelli; per il giocatore restano validi blocco del Token, pausa e ostacoli. Zaini e borse pieni vengono trasferiti interamente, conservando la gerarchia dei contenuti. I trasferimenti diretti fra personaggi funzionano anche con Actor collegati: se un Actor ha più Token nella scena, seleziona quello da usare.

Le esclusioni delle barre si applicano anche agli oggetti esistenti senza aggiornamenti persistenti. Per manutenzione, il GM principale può consultare l'anteprima con `await game.modules.get("khuzoe-merchant").api.groundLoot.tokenSettings()`. Soltanto una chiamata esplicita con `{ apply: true }` salva la disattivazione delle barre nei Token contrassegnati dal modulo; non aggiorna gli Actor. Questa nuova manutenzione non viene eseguita all'avvio. Restano le precedenti procedure di compatibilità per i vecchi oggetti rappresentati da Tile.

I test si eseguono con `npm test` dalla cartella del modulo: usano documenti simulati e non aprono né modificano mondi Foundry.

## Dati e permessi

La configurazione viene salvata nel flag dell'Attore:

```text
flags.khuzoe-merchant.merchant
```

Ogni voce conserva UUID e snapshot dell'Item. Gli snapshot completi sono archiviati in pagine separate del Journal GM **[Khuzoe Merchant] Archivio protetto**; il flag pubblico contiene solo metadati utili all'interfaccia. Al momento dell'acquisto il GM usa il documento sorgente se esiste ancora e ripiega sullo snapshot se il Compendio o l'Item originale non è più disponibile.

Il client del giocatore invia soltanto ID dell'articolo e quantità. Il GM eletto tra quelli attivi rilegge tutti i dati autorevoli e verifica:

- che l'identità autenticata del mittente corrisponda all'utente indicato;
- che utente, scena e token esistano ancora;
- che il giocatore stia effettivamente visualizzando la scena del mercante;
- che il giocatore sia proprietario dell'Attore acquirente;
- che il mercante sia attivo e in portata;
- che quantità e scorta siano valide;
- che il prezzo corrente e i fondi siano sufficienti.

Solo dopo i controlli il GM deduce la valuta, crea l'Item e aggiorna la scorta. Le richieste sono elaborate in serie. In caso di errore durante la creazione o l'aggiornamento della scorta, il modulo tenta il rollback completo e registra eventuali problemi nella console del GM.

## Struttura del progetto

```text
khuzoe-merchant/
├── lang/it.json
├── scripts/
│   ├── constants.js
│   ├── container-data.js
│   ├── container-store.js
│   ├── container-socket.js
│   ├── container.js
│   ├── currency-v2.js
│   ├── distance.js
│   ├── item-transfer.js
│   ├── main.js
│   ├── merchant-config.js
│   ├── merchant-shop.js
│   ├── production-data.js
│   ├── production.js
│   ├── settings.js
│   ├── socket.js
│   ├── transaction-coordinator.js
│   ├── ui-tabs.js
│   └── utils.js
├── styles/
│   ├── economy.css
│   ├── interface-v2.css
│   ├── merchant-legacy.css
│   └── merchant.css
├── templates/
│   ├── container-config.hbs
│   ├── container-sheet.hbs
│   ├── merchant-config.hbs
│   └── merchant-shop.hbs
├── LICENSE
├── module.json
└── README.md
```

## API per macro o integrazioni

Dopo l'hook `ready`, il modulo espone:

```js
const api = game.modules.get("khuzoe-merchant").api;

// Apre la configurazione GM per un Actor.
await api.configure(actor);

// Apre il negozio per un oggetto Token sulla canvas.
await api.open(token);

// Crea un contenitore nel punto indicato della scena.
await api.containers.create(canvas.scene, x, y);

// Apre il contenitore oppure la sua configurazione GM.
await api.containers.open(token);
await api.containers.configure(token);

// Esegue manualmente un ciclo senza modificare la scadenza programmata.
await api.production.runMerchant(actor);
await api.production.runContainer(token);
```

## Note tecniche

Foundry v14 non espone un hook pubblico specifico per il doppio clic sui Token. Durante `init` il modulo applica quindi patch minime ai metodi di interazione della classe Token configurata dal sistema. Per i giocatori la visualizzazione viene consentita soltanto su mercanti, contenitori e bottino gestiti dal modulo; proprietà e configurazione degli altri Token restano invariate. I metodi originali vengono conservati e richiamati per tutti gli oggetti non gestiti.

Le schede Actor e Item del sistema sono integrate tramite `renderApplicationV2` e `getHeaderControlsApplicationV2`. Negozio, contenitore, configurazioni, registro economico e dialoghi sono applicazioni native v14 basate su `ApplicationV2`, `HandlebarsApplicationMixin` e `DialogV2`. I dati persistenti e il protocollo delle transazioni restano indipendenti dal livello grafico.

## Licenza

MIT. Consulta `LICENSE`.

## Calendari personalizzati (1.21.3)

Le produzioni basate sul tempo del mondo usano la durata del giorno del calendario nativo Foundry, compreso Khuzoe Calendar: con un giorno da 40 ore, un ciclo giornaliero dura 40 ore. Anche la stima del prossimo ciclo usa le stesse unità. Le produzioni basate sul tempo reale restano su giorni da 24 ore. Senza calendario personalizzato il comportamento precedente rimane invariato.

L'aggiornamento non attiva produzioni né modifica inventari o configurazioni esistenti. Al successivo controllo di produzione, l'intervallo viene interpretato con il calendario attivo e l'ultimo istante già registrato; restano validi il limite dei recuperi e la protezione dai salti indietro.

Verifica: `node --test tests/production-calendar.test.mjs tests/module.test.mjs`.
