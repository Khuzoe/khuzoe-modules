# Khuzoe Updater e distribuzione moduli

- Questo progetto contiene COPIE dei moduli presenti nel Foundry esterno. Non cancellare, sostituire o modificare le cartelle `../modules` nell'ambito di modifiche all'Updater o al publisher.
- Sotto applications/<id> versionare application.zip (runtime compilato), application.json e release.json; i sorgenti completi dell'app sono sotto source/. Il catalogo espone le app in applications, separatamente da modules per mantenere compatibili gli Updater precedenti. Installarle solo sotto Data/khuzoe-apps/<id>. L'app aperta non va sostituita. La cartella Foundry si trasmette con --foundry-data; preferenze e sessioni restano in AppData. La pubblicazione dei soli sorgenti non rigenera release runtime immutabili.
- Non pubblicare l'intera cartella dati Foundry; tenere fuori mondi, impostazioni, credenziali, file utente, cache, node_modules e backup.
- Non versionare node_modules come sorgenti: gli ZIP delle applicazioni includono soltanto le dipendenze runtime necessarie, verificate e con le relative licenze. Il publisher usa i pacchetti già compilati e controlla dimensione, SHA-256 e contenuto, senza richiedere i sorgenti dell'app.
- Configurazione di distribuzione: `publisher.config.json`. La build incorpora URL catalogo e identificatori nell'app. Dopo modifiche alla configurazione ricompilare e aumentare la versione app se cambia il binario distribuito.
- Per ogni modifica runtime a `modules/<id>`, aumentare la versione di QUEL modulo, mantenendo l'identificatore. Il publisher rifiuta modifiche senza aumento versione.
- I compendi sono distribuiti dalle revisioni compilate dichiarate nel manifest; non invocare automaticamente `build-packs.mjs`, che modifica versioni e percorsi. Verificare i compendi con `tools/verify-packs.mjs`.
- App semplice: cartella salvata, controllo, Aggiorna. Non aggiungere profili, servizi residenti, avvio Foundry o gestione backup senza richiesta.
- Verifiche: `tools/build-app.ps1 -Test`, `tools/build-app.ps1`, `node --test tests/publisher.test.mjs`, `node tools/publisher.mjs preview`, poi test C# passando `build/publication/site/catalog.json`. Le installazioni di prova devono usare fixture isolate, mai i moduli veri.
- Il codice Windows usa C# 5 compatibile con il compilatore .NET Framework incluso in Windows. Nessuna dipendenza NuGet.
