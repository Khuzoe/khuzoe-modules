# Verifiche della consegna — 25 ottobre 2026

- Eseguibile Windows compilato e aperto: finestra iniziale verificata visivamente, intestazioni e pulsanti leggibili.
- 27 controlli C# su cartelle isolate: individuazione cartelle, selezioni ambigue, versioni, dipendenze coordinate, blocchi Foundry, memoria del percorso, moduli estranei, pacchetti errati e percorsi ZIP pericolosi.
- 22 controlli aggiuntivi sui pacchetti reali: dimensione/impronta SHA-256 e lettura/estrazione di ciascuno degli undici ZIP usando lo stesso codice dell'app. Totale del test integrato: 49 controlli superati.
- 8 test del publisher: pubblicazione iniziale, nessuna ripubblicazione a parità di contenuto, pubblicazione del singolo modulo, aumento versione obbligatorio, rifiuto downgrade, file mancanti, esclusione cartelle di sviluppo, revisioni compendi, tag indipendenti, caricamento prima della pubblicazione e immutabilità dei pacchetti pubblicati. Le richieste GitHub sono simulate: nessun dato inviato online dai test.
- Tutti e tre i file workflow YAML analizzati senza errori.
- Compendi Automations estratti e letti con lo strumento ufficiale Foundry, esclusivamente su copie temporanee: 100 incantesimi 2014, 1 incantesimo 2024, 51 capacità di classe, 1 evocazione, 16 capacità NPC. Identificatori univoci.
- Confronto SHA-256 di 1.140 file delle cartelle originali: nessuna modifica o cancellazione rilevata. Escluse cartelle preesistenti node_modules, .maintenance e .git; nessuna installazione di prova effettuata nei moduli reali.

## Da verificare dopo la configurazione GitHub

Il repository `Khuzoe/khuzoe-modules` non era disponibile nel collegamento GitHub al momento della consegna. I workflow sono preparati localmente ma non sono stati eseguiti sui runner GitHub. Il catalogo remoto non è stato attivato.

Il primo test completo online sarà: caricamento progetto → esecuzione Actions → catalogo Pages disponibile → controllo dell'app. Il test con una versione più alta di un modulo andrà eseguito inizialmente su una copia Foundry di prova. I trasferimenti HTTPS reali e la prima pubblicazione remota restano subordinati alla configurazione descritta in CONFIGURAZIONE-GITHUB.md.

I cinque compendi sono quelli già compilati presenti nella versione attuale del modulo; questa verifica ne controlla leggibilità e identificatori, non la corrispondenza integrale con packData né il funzionamento delle singole automazioni in una sessione di gioco.
