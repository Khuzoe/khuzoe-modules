# Khuzoe Updater

App Windows per installare e aggiornare i moduli Khuzoe in Foundry. Scegli la cartella una volta: **Aggiorna** aggiorna quelli già presenti; **Installa**, accanto a un modulo mancante, scarica l'ultima versione pubblicata.

## Per i DM

1. Scarica `KhuzoeUpdater-Windows.zip` dalla release dell'app ed estrailo.
2. Apri `KhuzoeUpdater.exe` (lascia accanto il file `.exe.config`).
3. Premi **Scegli cartella** e seleziona la cartella principale di Foundry, quella contenente l'app e/o la cartella dati. Se rileva più cartelle moduli, seleziona quella corretta.
4. L'app ricorda il percorso e controlla gli aggiornamenti a ogni apertura.
5. Chiudi completamente Foundry, poi premi **Aggiorna** per aggiornare i moduli presenti oppure **Installa** sulla riga di un modulo mancante.
6. Per usare un modulo appena installato, riapri il mondo e abilitalo in **Gestione moduli** di Foundry.
7. Se compare una nuova versione dell'Updater, premi **Aggiorna app** in alto: scarica il pacchetto, lo verifica e riapre automaticamente l'app aggiornata. **Controlla app** consente di ripetere la verifica.

Windows 10 con .NET Framework 4.8 o Windows 11; nessuna installazione di Node, Python o SDK. Il componente .NET Framework è già incluso nelle versioni recenti di Windows. Nessun account GitHub o password Foundry per i DM.

Le impostazioni vengono salvate in `%LOCALAPPDATA%\KhuzoeUpdater\settings.json`. Il programma va eseguito sul computer che ospita i moduli. Per installazioni Windows normali cerca anche la cartella dati standard; la cartella principale dell'app serve a riconoscere la versione Foundry. Se i dati sono separati dall'app e la versione non è individuabile, l'aggiornamento viene bloccato con una spiegazione.

Dalla versione **0.4.0** l'app si aggiorna su richiesta. Chi usa una versione precedente deve scaricare ed estrarre una volta il nuovo ZIP. Mantieni il nome `KhuzoeUpdater.exe`, il suo file `.config` e una cartella in cui il tuo account può scrivere. L'aggiornamento conserva la cartella Foundry salvata e cambia soltanto i due file dell'app. Non richiede la chiusura di Foundry per aggiornare l'Updater; le operazioni sui moduli richiedono invece Foundry chiuso. Durante un'installazione o aggiornamento dei moduli, il pulsante dell'app è disabilitato.

Il supporto di aggiornamento è una copia temporanea dell'Updater stesso, estratta automaticamente: nessun programma aggiuntivo da installare. Attende la chiusura dell'app prima di sostituire EXE e configurazione. Controlla HTTPS, repository, versione, dimensione e impronte SHA-256 del pacchetto e dei due file. I temporanei completati vengono eliminati al riavvio, quelli abbandonati dopo due giorni. Come per i moduli, l'integrità dipende dalla sicurezza dell'account che pubblica su GitHub.

Mostra tutti i moduli del catalogo. I mancanti hanno stato **Da installare**, versione locale **—** e un pulsante **Installa** quando compatibili. Non vengono installati automaticamente dal pulsante **Aggiorna**. L'installazione del singolo modulo include soltanto le sue dipendenze Khuzoe necessarie, installate prima del modulo richiesto; quelle già compatibili vengono mantenute. Le dipendenze esterne vengono controllate ma non installate o aggiornate. Una cartella che compare dopo il controllo non viene sovrascritta da una nuova installazione.

Rispetta i file di blocco aggiornamento di Foundry (`<id>.lock`) e mantiene le versioni locali più recenti. Verifica Foundry, sistema e dipendenze obbligatorie. Non ci sono profili, avvio automatico di Foundry, cronologia o interfaccia di ripristino. Gli aggiornamenti sostituiscono il contenuto del singolo modulo; le personalizzazioni fatte dentro la sua cartella vengono sostituite come in una normale reinstallazione. Mondi, sistemi e altri moduli non vengono aggiornati.

Prima di cambiare file scarica, verifica ed estrae tutti i pacchetti necessari. Il controllo SHA-256 verifica che i byte corrispondano al catalogo. Le cartelle temporanee sono nella cartella `modules` per poter spostare i file sullo stesso disco; vengono eliminate dopo l'operazione. Durante la sostituzione viene mantenuta una copia temporanea del singolo modulo, ripristinata solo se lo spostamento immediato fallisce. Non è un backup storico né un ripristino di un gruppo di moduli in caso di spegnimento del PC. Se un gruppo si interrompe, i moduli già installati restano aggiornati e quelli rimanenti possono essere ritentati. Non avviare Foundry durante l'aggiornamento.

## Per chi pubblica

Leggi [CONFIGURAZIONE-GITHUB.md](CONFIGURAZIONE-GITHUB.md). Il repository previsto è `Khuzoe/khuzoe-modules` e contiene sia app sia sorgenti dei singoli moduli. L'app e i moduli hanno workflow e versioni indipendenti.

Le cartelle `modules/` in questo progetto sono **copie** preparate per il repository; i moduli installati nel Foundry da cui è stato creato il progetto non sono stati modificati. Non caricare l'intera cartella dati di Foundry su GitHub.

Dopo la configurazione iniziale:

1. Modifica il sorgente del singolo modulo nella cartella `modules/<id>` di questo repository.
2. Prova la modifica in un Foundry di test. Se hai lavorato prima nella cartella installata, riporta esplicitamente i file modificati nella copia di questo repository prima di pubblicare: nessun collegamento automatico tra le due cartelle.
3. Aumenta `version` nel suo `module.json`; se esiste, allinea anche `package.json`/`package-lock.json`. Esempio: Merchant `1.21.2` → `1.21.3`. Le versioni degli altri moduli restano uguali.
4. Invia le modifiche a `main`: GitHub pubblica solo i pacchetti nuovi e aggiorna il catalogo.

Per Automations i compendi dichiarati nel manifest sono già compilati e inclusi nella copia. Il workflow controlla che siano leggibili e li distribuisce senza rigenerare numeri di revisione o versione. Se modifichi i contenuti dei compendi, usa il flusso di compilazione del modulo prima della pubblicazione e includi i nuovi pack dichiarati dal manifest. Non basta modificare solo `packData/` per cambiare un compendio distribuito.

Il generatore aggiunge gli URL manifest/download ai pacchetti pubblicati, senza riscrivere i manifest sorgenti. Ogni modulo ha una release propria (`khuzoe-merchant-v1.21.3`) con `module.zip` e `module.json`; i manifest stabili stanno su Pages in `modules/<id>/module.json`.

I download del vecchio sito wiki non vengono modificati da questo progetto. `cripta-wiki-sync` mantiene il suo identificatore; le future versioni di questo canale vanno pubblicate dalla copia qui presente. Evitare di mantenere due versioni divergenti del suo sorgente.

## Compilazione e controlli locali

Da PowerShell nella cartella del progetto:

```powershell
./tools/build-app.ps1 -Test
./tools/build-app.ps1
node --test tests/publisher.test.mjs
node tools/publisher.mjs preview
./dist/KhuzoeUpdater.Tests.exe ./build/publication/site/catalog.json
```

La compilazione usa il compilatore C# incluso in .NET Framework; non richiede NuGet o un SDK .NET. Il programma compilato è `dist/KhuzoeUpdater.exe`. `preview` prepara tutti i pacchetti localmente senza rete, pubblicazione o modifica dei sorgenti. Il comando `prepare` del workflow confronta invece il catalogo online e rifiuta file runtime cambiati senza aumento versione o versioni inferiori a quelle pubblicate.

Per verificare i compendi: esegui `npm ci` in `modules/khuzoe-automations`, quindi `node tools/verify-packs.mjs` dalla radice. Questi strumenti sono solo per sviluppo e GitHub: i DM non ne hanno bisogno.

Le modifiche dell'app richiedono l'aumento di `app/version.txt` e l'allineamento di `app/app.manifest`. Il workflow Windows compila, verifica e pubblica lo ZIP dell'app con `app-update.json`, senza influire sulle release dei moduli. Dopo la pubblicazione aggiorna l'asset `app-update.json` della release tecnica `updater-channel`: è il canale stabile dell'app, indipendente dal catalogo moduli su Pages e dalle altre release. Le release `updater-v<versione>` restano immutabili; un nuovo tentativo del workflow riusa il manifest pubblicato e può ripristinare il canale. Il canale non viene riportato a una versione precedente. Non servono nuovi segreti o permessi GitHub oltre a `contents: write` già configurato. Aggiungere identificatori al catalogo richiede anche ricompilare l'app, perché l'elenco autorizzato viene incorporato nell'eseguibile.
