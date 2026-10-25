# Khuzoe Calendar · 0.1.0

Calendario condiviso tra la wiki Khuzoe e Foundry VTT 14.367. Richiede **Khuzoe Wiki Sync** con il servizio calendario incluso in questa modifica.

## Primo avvio

1. Pubblicare il Worker aggiornato (`workers/main-worker`): include secondi, salvataggi serializzati per campagna e protezione dai doppi invii. Pubblicare anche il FE aggiornato per vedere automaticamente i cambiamenti di Foundry.
2. Abilitare Khuzoe Wiki Sync e Khuzoe Calendar nel mondo desiderato. Nessun mondo viene configurato dall'installazione dei file.
3. Nelle impostazioni di Wiki Sync scegliere la campagna, accedere con il proprio account wiki e impostare **Bidirezionale** per sincronizzare l'orologio. I permessi provengono dall'account wiki: essere GM in Foundry non concede accesso ai dati riservati della wiki.
4. Aprire il calendario dall'orologio compatto, dal pulsante nei controlli token, dalle impostazioni del modulo o con **Maiusc+K**.
5. Il GM autorizzato preme **Usa come calendario Foundry**. Serve un calendario già salvato sulla wiki. Se è ancora quello predefinito, configurarlo e salvarlo dal sito prima del collegamento.

Il collegamento iniziale assegna la data della wiki all'istante attuale senza modificare `core.time`, durate o istanti iniziali degli effetti. Prima del collegamento il modulo legge la wiki e consente eventi/note secondo i permessi; non assume il controllo dell'orologio.

## Cosa è disponibile

- Mese, agenda del giorno, eventi di più giorni, note personali/condivise, visibilità, stato e tag. Gli eventuali riferimenti di eventi già esistenti vengono conservati.
- Creazione, modifica e archiviazione dalla stessa API usata dal sito. Archiviare non elimina il record. I testi non sono interpretati come HTML o script.
- Data/ora e passi rapidi, mesi e settimane personalizzati, giorni di durata diversa da 24 ore. La struttura del calendario si configura dalla wiki, raggiungibile con **Apri wiki**.
- Widget trascinabile dalla maniglia a puntini, con posizione salvata nelle preferenze locali del browser. Puoi spostarlo anche con le frecce della tastiera dopo aver selezionato la maniglia; Maiusc aumenta il passo. Il GM dispone di **−1 h, −15 m, +15 m, +1 h** direttamente sul widget, quando collegamento e permessi lo consentono. Cliccando su data o ora si apre il calendario completo. Lo spostamento del widget non fa richieste alla wiki.
- Un solo GM controlla gli aggiornamenti wiki ogni 60 secondi. Gli avanzamenti automatici di Foundry vengono raggruppati ogni 30 secondi reali, solo se l'orologio è cambiato. La precisione rimane al secondo; combattimenti e riposi che avanzano già `game.time` non vengono conteggiati di nuovo.
- I comandi **Avanza** e **Imposta data**, gli eventi e le note vengono salvati subito. Gli altri utenti caricano i propri eventi all'apertura del calendario e, se lo tengono aperto, quando arriva una notifica di modifica. A finestra chiusa non interrogano periodicamente la wiki.
- Un GM coordina il tempo: quello che ha collegato il calendario, se attivo, altrimenti il GM attivo designato da Foundry. Deve avere accesso in scrittura alla campagna wiki.
- Ultima definizione disponibile anche offline. Gli avanzamenti locali restano rilevabili attraverso il tempo del mondo e l'ultimo istante confermato. I POST incerti vengono ritentati con lo stesso identificativo.
- Conflitti espliciti fra modifiche alla stessa data o allo stesso evento. Le finestre evento non vengono ridisegnate dai refresh: la bozza rimane disponibile.

La scelta **Mantieni data wiki** durante un conflitto corregge l'etichetta dell'istante corrente senza far scorrere effetti. Gli avanzamenti ordinari e **Imposta data** fanno invece scorrere `game.time`, con le consuete conseguenze sulle scadenze. Se si cambia la struttura del calendario sulla wiki, viene riallineata la data senza ricalcolare gli effetti esistenti.

## Permessi e compatibilità

Nessun token viene inviato via socket o salvato nelle impostazioni del modulo. Le notifiche via socket contengono solo un avviso di modifica, campagna e mittente Foundry, senza testi di eventi o note: ogni destinatario rilegge i dati con il proprio account e i propri permessi. Gli eventi restano nella memoria del client che li ha richiesti e vengono filtrati dal Worker. Le impostazioni condivise contengono solo definizione del calendario, data e stato di sincronizzazione. Le note personali seguono i permessi attuali della wiki, che le rendono leggibili anche ai gestori della campagna.

Scollegare ripristina il provider precedente senza cancellare il calendario wiki o cambiare i secondi del mondo. Gli aggiornamenti non ancora confermati vengono abbandonati. Non abilitare due provider calendario: Simple Calendar/Reborn, Calendaria, Simple Timekeeping e Seasons & Stars sono rilevati prima del collegamento.

Questo modulo usa le API native v14; **non implementa `SimpleCalendar.api`**. Funzioni di altri moduli che richiedono quell'API non vengono adattate automaticamente. Alcuni moduli e alcune durate D&D5e assumono ancora giorni di 24 ore, mesi di 30 giorni o anni di 365: un calendario personalizzato non cambia tali regole. Niente patch a moduli terzi, automazioni meteo/lune, anni bisestili o ricorrenze automatiche in questa prima versione.

## Backend e distribuzione

Il nuovo Durable Object `CalendarStore` conserva i calendari per campagna e serializza tutte le modifiche; documento e ricevuta di un invio vengono salvati nella stessa transazione. Le ultime 512 ricevute consentono retry senza doppi avanzamenti. Un indice limitato evita di rileggere tutte le ricevute a ogni salvataggio.

I calendari già in KV vengono importati al primo accesso, anche quando esiste solo il formato precedente. L'assenza di dati viene registrata per evitare nuove letture KV dopo ogni riavvio dell'oggetto. Le vecchie chiavi KV non vengono modificate o cancellate. I successivi accessi al documento usano memoria locale e archivio del Durable Object; i permessi vengono invece verificati per ogni richiesta. Dopo la migrazione non ritornare al vecchio Worker per gestire calendari: leggerebbe la copia KV precedente.

Anche la pagina wiki controlla gli aggiornamenti ogni 60 secondi, solo quando è visibile e senza editor aperti. Le richieste fallite vengono diradate fino a cinque minuti, senza richiedere di nuovo il calendario legacy a ogni tentativo. Il modulo mantiene gli avanzamenti locali e ritenta gli invii incerti senza duplicarli. Senza un GM coordinatore connesso le modifiche wiki si recuperano riaprendo il calendario o con **Aggiorna**; l'orologio Foundry continua a usare la definizione già disponibile.

Come riferimento, sei client Foundry collegati per quattro ore con il calendario fermo producono 240 controlli periodici anziché 5.760. Aperture, salvataggi, notifiche e sincronizzazione del tempo si aggiungono a questo conteggio. Il consumo totale del piano gratuito dipende anche dal resto della wiki e dal numero di campagne attive: questa ottimizzazione non verifica le quote dell'account Cloudflare.

L'orologio verifica le capacità del backend prima del collegamento: un Worker precedente permette lettura ed eventi ma non il nuovo collegamento nativo. Nessuna pubblicazione o abilitazione è eseguita dal modulo.

## Verifica offline

`node tests/calendar.test.mjs` e `node tests/clock-widget.test.mjs` dalla cartella del modulo. I test usano anche i metodi della classe calendario v14 installata, senza avviare Foundry e senza scrivere dati di mondi. `node tests/widget-preview.mjs --serve` apre un'anteprima locale del widget su `http://127.0.0.1:8859/`, con dati fittizi e senza collegamenti alla wiki o a Foundry. Nel repository wiki: `npm run test:calendar`. Dopo la compilazione locale del Worker in `output/khuzoe-calendar-worker-check`, `node scripts/test-calendar-runtime.mjs` verifica l'integrazione in un runtime Cloudflare temporaneo con dati fittizi.

Riferimenti API: [GameTime v14](https://foundryvtt.com/api/v14/classes/foundry.helpers.GameTime.html), [CalendarData v14](https://foundryvtt.com/api/v14/classes/foundry.data.CalendarData.html), [transazioni SQLite dei Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction).
