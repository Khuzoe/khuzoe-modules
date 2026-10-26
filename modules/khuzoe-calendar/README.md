# Khuzoe Calendar · 0.3.0

Calendario condiviso tra la wiki Khuzoe e Foundry VTT 14.367. Richiede **Khuzoe Wiki Sync** con il servizio calendario incluso in questa modifica.

## Primo avvio

1. Pubblicare il Worker aggiornato (`workers/main-worker`): include secondi, salvataggi serializzati per campagna e protezione dai doppi invii. Pubblicare anche il FE aggiornato per vedere automaticamente i cambiamenti di Foundry.
2. Abilitare Khuzoe Wiki Sync e Khuzoe Calendar nel mondo desiderato. Nessun mondo viene configurato dall'installazione dei file.
3. Nelle impostazioni di Wiki Sync scegliere la campagna, accedere con il proprio account wiki e impostare **Bidirezionale** per sincronizzare l'orologio. I permessi provengono dall'account wiki: essere GM in Foundry non concede accesso ai dati riservati della wiki.
4. Aprire il calendario dall'orologio compatto, dal pulsante nei controlli token, dalle impostazioni del modulo o con **Maiusc+K**.
5. Il GM autorizzato preme **Collega calendario a Foundry**. Serve un calendario già salvato sulla wiki. Se è ancora quello predefinito, configurarlo e salvarlo dal sito prima del collegamento.

Con il widget visibile, la data della wiki viene caricata automaticamente all’apertura di Foundry, anche prima del collegamento e senza aprire la finestra. Il tempo si modifica con i comandi manuali o con gli avanzamenti già previsti dal gioco. Se non è ancora collegato, il widget legge nuovamente la wiki ogni 15 minuti; i giocatori già collegati ricevono invece l’ora nativa senza letture periodiche aggiuntive. Attivare il widget dalle impostazioni o cambiare campagna/account carica i dati necessari senza clic ulteriori.

Il collegamento iniziale assegna la data della wiki all'istante attuale senza modificare `core.time`, durate o istanti iniziali degli effetti. Prima del collegamento il modulo legge la wiki e consente eventi/note secondo i permessi; non assume il controllo dell'orologio.

## Cosa è disponibile

- Mese, agenda del giorno, eventi di più giorni, note personali/condivise, visibilità, stato e tag. Gli eventuali riferimenti di eventi già esistenti vengono conservati.
- Creazione, modifica e archiviazione dalla stessa API usata dal sito. Archiviare non elimina il record. I testi non sono interpretati come HTML o script.
- Data/ora e passi rapidi, mesi e settimane personalizzati, giorni di durata diversa da 24 ore. La struttura del calendario si configura dalla wiki, raggiungibile con **Apri wiki**.
- Widget trascinabile dalla maniglia a puntini, con posizione salvata nelle preferenze locali del browser. Puoi spostarlo anche con le frecce della tastiera dopo aver selezionato la maniglia; Maiusc aumenta il passo. Il GM dispone dei passi rapidi configurati nel calendario wiki direttamente sul widget (in assenza di configurazione: **−1 h, −15 m, +15 m, +1 h**), quando collegamento e permessi lo consentono. Cliccando su data o ora si apre il calendario completo. Lo spostamento del widget non fa richieste alla wiki.
- Un solo GM controlla gli aggiornamenti wiki ogni 15 minuti. Gli avanzamenti automatici di Foundry vengono raggruppati ogni 15 minuti reali, solo se l'orologio è cambiato. La wiki può quindi mostrare un orario arretrato fino a circa 15 minuti reali, indipendentemente dalla velocità di gioco. **Aggiorna** forza l’allineamento. La precisione del valore salvato rimane al secondo; combattimenti e riposi che avanzano già `game.time` non vengono conteggiati di nuovo.
- I comandi **Avanza** e **Imposta data**, gli eventi e le note vengono salvati subito. Gli altri utenti caricano i propri eventi all'apertura del calendario e, se lo tengono aperto, quando arriva una notifica di modifica. A finestra chiusa, i client già collegati non interrogano periodicamente la wiki; un widget visibile non ancora collegato legge invece la data ogni 15 minuti.
- Un GM coordina il tempo: quello che ha collegato il calendario, se attivo, altrimenti il GM attivo designato da Foundry. Deve avere accesso in scrittura alla campagna wiki.
- Ultima definizione disponibile anche offline. Un GM può usare i passi locali anche dopo un riavvio senza connessione, se il calendario era già collegato e Wiki Sync è Bidirezionale; le scritture remote richiedono sempre una verifica dei permessi. Un rifiuto esplicito di accesso impedisce i comandi del modulo. Gli avanzamenti locali restano rilevabili attraverso il tempo del mondo e l'ultimo istante confermato. I POST incerti vengono ritentati con lo stesso identificativo.
- Conflitti espliciti fra modifiche alla stessa data o allo stesso evento. Le finestre evento non vengono ridisegnate dai refresh: la bozza rimane disponibile.

La scelta **Mantieni data wiki** durante un conflitto corregge l'etichetta dell'istante corrente senza far scorrere effetti. Gli avanzamenti ordinari e **Imposta data** fanno invece scorrere `game.time`, con le consuete conseguenze sulle scadenze. Se si cambia la struttura del calendario sulla wiki, viene riallineata la data senza ricalcolare gli effetti esistenti.

## Interfaccia e comandi manuali

- Data e ora attuali sono sempre separate dal mese che si sta consultando. Mese e anno si scelgono direttamente; **Data attuale** riporta al giorno della campagna senza modificarlo.
- **Modifica data e ora** apre l'impostazione esplicita della data. **Fai passare tempo** raccoglie i passi rapidi e rimane aperto per eseguire più avanzamenti consecutivi.
- Selezionare un giorno e premere **Aggiungi evento** (o **Aggiungi nota**). Titolo, destinatari, data e descrizione sono subito disponibili; tipo, stato e tag sono sotto **Altri dettagli**. I secondi già salvati sono conservati anche se non sono mostrati nell'editor.
- Lo stato del collegamento è distinto dalle azioni quotidiane: espandere **Collegato a Foundry** per i dettagli di sincronizzazione o per scollegarlo.
- Lo scorrimento con il tempo reale è disabilitato. Non vengono mostrati Avvia, Pausa o velocità e una vecchia configurazione non può riavviare il timer. Restano disponibili gli avanzamenti manuali, i riposi e i combattimenti gestiti dagli altri moduli.
- La visualizzazione stagionale di D&D5e mostra una data normale quando non sono definite stagioni.

La versione 0.3.0 non richiede modifiche al Worker, a Merchant o a Wiki Sync rispetto al collegamento già funzionante. Ricaricare Foundry e la pagina wiki dopo l'aggiornamento dei file. L'installazione non altera dati del mondo; l'intervallo di sincronizzazione Foundry resta di 15 minuti.

## Permessi e compatibilità

Nessun token viene inviato via socket o salvato nelle impostazioni del modulo. Le notifiche via socket contengono solo un avviso di modifica, campagna e mittente Foundry, senza testi di eventi o note: ogni destinatario rilegge i dati con il proprio account e i propri permessi. Gli eventi restano nella memoria del client che li ha richiesti e vengono filtrati dal Worker. Le impostazioni condivise contengono solo definizione del calendario, data e stato di sincronizzazione. Le note personali seguono i permessi attuali della wiki, che le rendono leggibili anche ai gestori della campagna.

Scollegare ripristina il provider precedente senza cancellare il calendario wiki o cambiare i secondi del mondo. Gli aggiornamenti non ancora confermati vengono abbandonati. Non abilitare due provider calendario: Simple Calendar/Reborn, Calendaria, Simple Timekeeping e Seasons & Stars sono rilevati prima del collegamento.

Questo modulo usa le API native v14; **non implementa `SimpleCalendar.api`**. Funzioni di altri moduli che richiedono quell'API non vengono adattate automaticamente. Alcuni moduli e alcune durate D&D5e assumono ancora giorni di 24 ore, mesi di 30 giorni o anni di 365: un calendario personalizzato non cambia tali regole. Non include automazioni meteo/lune, anni bisestili o ricorrenze automatiche. Per SmallTime viene adattata in memoria soltanto la lettura dell'ora con giorni standard (24 ore, 60 minuti): usa il calendario nativo con il suo scarto, invece dei secondi grezzi del mondo. Nessun file di SmallTime viene modificato. Con giorni personalizzati la sua interfaccia e l'oscurità collegata restano incompatibili: viene mostrato un avviso. Khuzoe Merchant 1.21.3 calcola invece i cicli in giorni di gioco usando la durata del calendario; le produzioni basate sul tempo reale restano di 24 ore.

## Backend e distribuzione

Il nuovo Durable Object `CalendarStore` conserva i calendari per campagna e serializza tutte le modifiche; documento e ricevuta di un invio vengono salvati nella stessa transazione. Le ultime 512 ricevute consentono retry senza doppi avanzamenti. Un indice limitato evita di rileggere tutte le ricevute a ogni salvataggio.

I calendari già in KV vengono importati al primo accesso, anche quando esiste solo il formato precedente. L'assenza di dati viene registrata per evitare nuove letture KV dopo ogni riavvio dell'oggetto. Le vecchie chiavi KV non vengono modificate o cancellate. I successivi accessi al documento usano memoria locale e archivio del Durable Object; i permessi vengono invece verificati per ogni richiesta. Dopo la migrazione non ritornare al vecchio Worker per gestire calendari: leggerebbe la copia KV precedente.

Anche la pagina wiki controlla gli aggiornamenti ogni 60 secondi, solo quando è visibile e senza editor aperti. Le richieste fallite vengono diradate fino a cinque minuti, senza richiedere di nuovo il calendario legacy a ogni tentativo. Il modulo mantiene gli avanzamenti locali e ritenta gli invii incerti senza duplicarli. Senza un GM coordinatore connesso le modifiche wiki si recuperano riaprendo il calendario o con **Aggiorna**; l'orologio Foundry continua a usare la definizione già disponibile.

Come riferimento, sei client Foundry con calendario già collegato per quattro ore con il calendario fermo producono 16 controlli periodici. Aperture, salvataggi, notifiche e sincronizzazione del tempo si aggiungono a questo conteggio. Il consumo totale del piano gratuito dipende anche dal resto della wiki e dal numero di campagne attive: questa ottimizzazione non verifica le quote dell'account Cloudflare.

L'orologio verifica le capacità del backend prima del collegamento: un Worker precedente permette lettura ed eventi ma non il nuovo collegamento nativo. Nessuna pubblicazione o abilitazione è eseguita dal modulo.

## Verifica offline

`node --test tests/calendar.test.mjs tests/clock-widget.test.mjs` dalla cartella del modulo. I test usano anche i metodi della classe calendario v14 installata, senza avviare Foundry e senza scrivere dati di mondi. `node tests/widget-preview.mjs --serve` apre un'anteprima locale del widget su `http://127.0.0.1:8859/`, con dati fittizi e senza collegamenti alla wiki o a Foundry. Nel repository wiki: `npm run test:calendar`. Dopo la compilazione locale del Worker in `output/khuzoe-calendar-worker-check`, `node scripts/test-calendar-runtime.mjs` verifica l'integrazione in un runtime Cloudflare temporaneo con dati fittizi.

Riferimenti API: [GameTime v14](https://foundryvtt.com/api/v14/classes/foundry.helpers.GameTime.html), [CalendarData v14](https://foundryvtt.com/api/v14/classes/foundry.data.CalendarData.html), [transazioni SQLite dei Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction).
