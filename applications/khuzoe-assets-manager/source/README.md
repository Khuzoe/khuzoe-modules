# Khuzoe Assets Manager · 0.3.0

App Windows per preparare gli asset delle sessioni Foundry. Contiene le sezioni **Musiche** e **Scene**. Il progetto è separato da Khuzoe Updater.

## Avvio

Con **Khuzoe Updater 0.5.0 o successivo**, premi **Installa** sulla riga Assets Manager e poi **Apri**. Gli aggiornamenti successivi passano dal normale pulsante **Aggiorna**, dopo aver chiuso Assets Manager. L'Updater trasmette la cartella Foundry già scelta. L'accesso Discord e le preferenze rimangono in `%LOCALAPPDATA%\KhuzoeAssetsManager`.

Per l'avvio manuale:

1. Estrai tutto il pacchetto in una cartella a tua scelta.
2. Apri **KhuzoeAssetsManager.exe**, lasciando accanto il file `.exe.config` e la cartella `scene-reader`.
3. Premi **Accedi con Discord**. Si apre il browser: l'accesso e la password vengono gestiti dalla pagina ufficiale Discord. Dopo la conferma torna all'app, che completa automaticamente il collegamento.
4. Premi **Scegli cartella** e seleziona la cartella principale di Foundry oppure la directory dati che contiene `modules`, `worlds` e `systems`. Se vengono trovate più installazioni, scegli quella corretta. Il percorso viene ricordato.

Richiede Windows 10/11 a 64 bit e .NET Framework 4.8. Non richiede l'installazione manuale di Node, Python o FFmpeg. Non installa servizi, non si avvia con Windows e non cambia il modo in cui apri Foundry.

## Scaricare musiche

1. Incolla un link YouTube, oppure più link con **un video per riga** (fino a 50).
2. Indica una categoria. Puoi usare quelle proposte oppure scriverne una nuova.
3. Scegli la cartella relativa ai dati Foundry. La destinazione proposta è `musics/youtube/<categoria>`; puoi modificarla o scegliere una directory esistente sotto `musics`.
4. Scegli la qualità MP3 e premi **Scarica MP3**.

Il nome personalizzato e **Analizza link** si applicano a un solo video. Per più link vengono usati i titoli originali. Analizza link mostra titolo, autore e durata; l'ascolto è disponibile per i file già scaricati.

La prima operazione prepara automaticamente gli strumenti necessari nelle impostazioni locali dell'app. Serve una connessione Internet: il download iniziale è di circa 300 MiB e gli strumenti occupano circa 450 MiB. L'avanzamento viene mostrato nell'app. I download arrivano dalle release ufficiali dei progetti e vengono verificati con SHA-256 prima dell'utilizzo.

Le operazioni sono eseguite una alla volta. Puoi aggiungere altri brani mentre la coda lavora. **Ferma coda** annulla l'operazione corrente e quelle in attesa; i file già completati vengono conservati. Nella scheda **Coda**, seleziona un errore o un'operazione interrotta e premi **Riprova selezionato**. Alla chiusura, l'app chiede se annullare le operazioni ancora in corso; non rimane in esecuzione in background.

La raccolta permette di cercare per titolo, autore e categoria, ascoltare un MP3, aprire la sua cartella e copiare il percorso relativo. Lo stesso video già scaricato nella stessa cartella viene riconosciuto e riutilizzato se il file corrisponde alla copia registrata. Un file esistente non viene sovrascritto.

## Portare i brani nelle playlist Foundry

Gli MP3 sono già nella directory dati letta da Foundry. La playlist è invece un elenco appartenente a un mondo: l'app **non modifica i database dei mondi**.

1. Apri **Playlist audio** in Foundry e crea o scegli una playlist.
2. Fai clic destro sulla playlist e scegli **Bulk Import Sounds**.
3. Seleziona la cartella in cui hai scaricato i brani, per esempio `musics/youtube/combattimento`.
4. Premi **Bulk Import**.

Foundry v14 importa i file audio della cartella e salta quelli già presenti nella playlist con lo stesso percorso. Puoi ripetere l'operazione dopo un gruppo di download. Il pulsante **Come portarle in Foundry** mostra queste istruzioni anche nell'app. Non serve chiudere Foundry per salvare nuovi MP3.

## Visualizzare le scene

1. Apri **Scene** dalla barra laterale. Usa la stessa cartella Foundry già scelta per le musiche.
2. Seleziona un **mondo**. L'elenco mostra le sue scene con il numero di muri e luci; puoi cercarle per nome.
3. Seleziona una scena e, nelle scene con più livelli di Foundry v14, scegli il livello dal menu sopra la mappa.
4. Attiva o disattiva **Muri**, **Luci** e **Indicatori**. Gli indicatori comprendono i vertici dei muri, le porte e le sorgenti luminose. Puoi anche mostrare griglia quadrata, tile, primo piano ed elementi disattivati/nascosti. I filtri vengono ricordati.
5. Trascina per spostare la mappa; usa la rotella o **+ / −** per ingrandire. **Adatta** ripristina la vista completa.
6. Premi **Aggiorna** per recuperare i nuovi salvataggi di Foundry. Durante la lettura lo stesso pulsante permette di annullarla.

Questa scheda legge esclusivamente i dati: non crea né modifica scene, muri o luci e **non usa AI o crediti AI**. Il database originale non viene aperto dal motore LevelDB: l'app legge una copia temporanea controllata. Funziona anche con il mondo aperto, quando i file rimangono stabili per il tempo della copia. Se Foundry sta salvando o compattando il database, attendi e riprova con **Aggiorna**. L'ora della copia è visibile sotto la mappa; la vista non riceve aggiornamenti continui.

L'anteprima mostra posizione e portata delle luci, senza simulare ombre, occlusione, animazioni o visione dei token. Non è un rendering del canvas di Foundry. I muri e le luci rispettano l'appartenenza ai livelli; gli elementi senza un livello specifico vengono inclusi in tutti i livelli.

Sono visualizzabili immagini PNG, JPEG, WebP, GIF e BMP presenti nei dati Foundry o raggiungibili tramite HTTPS pubblico. Le immagini vengono ridotte per l'anteprima (massimo 4096 pixel per la mappa, 512 per ogni tile, fino a 96 tile per livello; limite 100 MiB per file). Video, SVG, URL autenticati e risorse interne all'applicazione Foundry esterne alla cartella dati non sono visualizzabili in questa versione. Un'immagine mancante viene segnalata: muri e luci restano consultabili. Non vengono inviati mappe o dati delle scene ad API AI o al sito Khuzoe; un eventuale fornitore di immagini remoto riceve la richiesta per la propria immagine.

## Account e dati

- L'accesso riutilizza il backend Discord già esistente del sito Khuzoe: `https://sigillo-api.khuzoe.workers.dev`.
- L'app usa il browser di sistema e il flusso con collegamento temporaneo già previsto dal backend. Il collegamento scade e viene consumato quando l'app riceve la sessione.
- La sessione viene verificata dal backend all'apertura e prima di avviare le operazioni. Non viene considerato valido il semplice contenuto di un token letto sul computer.
- Non vengono richieste password Discord nell'app e non vengono distribuiti client secret, chiavi AI o codici personali.
- La sessione ricordata è protetta con Windows DPAPI per l'utente corrente, in `%LOCALAPPDATA%\KhuzoeAssetsManager\session.bin`.
- **Esci dall'account** elimina questa sessione dal computer. Il backend attuale emette sessioni con scadenza di sette giorni; questa versione non aggiunge una nuova revoca remota al backend.
- Cartella Foundry, categorie, raccolta, coda, ultimo mondo e filtri scene vengono conservati separatamente nello stesso percorso locale. Le copie e le anteprime delle scene restano nella cache dell'app; i file MP3 restano sotto `musics` nella directory dati selezionata.
- L'elenco dei brani e i percorsi locali non vengono inviati al sito. Il backend riceve le richieste di autenticazione; YouTube riceve le richieste relative ai video.

Questa versione verifica l'identità Discord. Non introduce abbonamenti, crediti AI o controlli di ruolo aggiuntivi. Queste funzioni richiederanno regole esplicite sul backend quando verranno aggiunte.

## Aggiornamenti e limiti

**Aggiorna strumenti** prepara una nuova copia dei componenti ufficiali e sostituisce la precedente solo al termine delle verifiche. Usalo se i download smettono di funzionare dopo cambiamenti di YouTube. La prima versione dell'app non contiene ancora un aggiornamento automatico dell'eseguibile.

Sono supportati singoli video pubblici, anche con link brevi, Shorts o YouTube Music. Le playlist YouTube intere, le dirette in corso, i video privati o che richiedono accesso, e i contenuti oltre 12 ore non fanno parte di questa prima versione. Il limite del file scaricato è 500 MiB. Non vengono letti automaticamente cookie o credenziali dei browser. La disponibilità dei download dipende anche dalle risposte e dalle verifiche di YouTube.

Per scaricare musiche serve l'accesso in scrittura alla directory dati Foundry scelta; la scheda Scene legge i dati. Il programma va eseguito sul computer Windows che ospita i file di Foundry; la sola selezione di una cartella locale non carica file su hosting remoti.

## Sviluppo

I sorgenti completi di Assets Manager sono disponibili in `applications/khuzoe-assets-manager/source` nel repository pubblico [Khuzoe/khuzoe-modules](https://github.com/Khuzoe/khuzoe-modules). Comprendono codice C#, lettore scene, test, script di compilazione e documentazione. Il pacchetto scaricato dall'Updater contiene i file necessari all'esecuzione e le licenze delle librerie. C# 5, .NET Framework 4.8, Windows Forms, nessun pacchetto NuGet. Il lettore delle copie scene usa Node.js e `classic-level` con dipendenze fissate nel lockfile. Gli utenti non devono installarli manualmente.

```powershell
cd engine
npm ci --ignore-scripts --omit=dev
node --test reader.test.cjs
cd ..
./tools/build-app.ps1 -Test
./tools/build-app.ps1
./tools/package.ps1
```

Nel clone del repository, esegui questi comandi dalla cartella `applications/khuzoe-assets-manager/source`. Per preparare una nuova release runtime: `./tools/prepare-updater-package.ps1 -PublisherRoot ../../..`. Per una copia di sviluppo esterna al repository, indica invece il percorso della cartella `khuzoe-updater`. Lo script compila in una cartella separata, verifica la versione e prepara `application.zip`, `application.json` e `release.json`; il publisher li distribuisce tramite il catalogo. La sola pubblicazione dei sorgenti non rigenera i pacchetti già pubblicati.

Se l'eseguibile precedente è aperto, crea una build separata con `./tools/build-app.ps1 -OutputDirectory build/release-0.3.0` e confezionala con `./tools/package.ps1 -BuildDirectory build/release-0.3.0`. Per aggiornare manualmente l'app estrai l'intero nuovo pacchetto dopo aver chiuso la versione in esecuzione. Preferenze e sessione restano nella directory locale dell'utente.

Vedi `VERIFICHE.md` per gli esiti e i limiti delle prove. Le directory `build` e `dist` non sono sorgenti. I test usano installazioni Foundry simulate, senza modificare mondi, moduli o musiche reali.
