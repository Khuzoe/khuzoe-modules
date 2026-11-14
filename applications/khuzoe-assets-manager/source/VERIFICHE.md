# Verifiche · build 0.3.0

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
