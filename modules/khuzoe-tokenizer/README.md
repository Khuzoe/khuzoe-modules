# Khuzoe Tokenizer

## 1.2.0 — Avatar opzionali delle varianti

- In **Gestisci varianti** ogni variante offre **Associa avatar**, **Sostituisci** e **Usa avatar base**. Nell'editor Tokenizer il pulsante ritratto accanto a ciascuna variante apre la gestione. Le varianti esistenti usano il ritratto base fino a un'associazione esplicita.
- L'immagine viene convertita in WebP mantenendo il formato originale e il limite `avatarMaxDimension`, poi caricata e verificata nella cartella dell'Actor con nome `avatar-variant-<id>-<hash>.webp`. Rimuovere l'associazione non cancella file.
- Con **M** sul token viene mostrato l'avatar della sua variante attiva. Token diversi dello stesso Actor possono mostrare ritratti diversi; `Actor.img`, scheda condivisa, chat e dossier wiki restano invariati. Tornando alla base o a una variante senza avatar, l'anteprima usa il ritratto base. Permessi e anteprime del bottino di Khuzoe Merchant restano applicati.
- L'associazione è memorizzata in `tokenVariants[].avatarSrc`; l'API `getTokenAvatar(tokenDocument)` restituisce il ritratto effettivo del token. Il catalogo resta sull'Actor, la scelta della variante sul singolo Token.
- `replaceVariants()` e `syncVariants()` conservano l'avatar locale quando il campo è omesso; `avatarSrc: null` o `""` rimuove l'associazione. Wiki Sync attualmente non trasporta il campo: l'associazione resta locale al mondo Foundry.
- Nessuna migrazione dei documenti al caricamento, nessuna nuova esportazione verso R2. Ricaricare Foundry per utilizzare la nuova versione.

Validazione: suite del modulo e prove su token collegati, varianti precedenti, fallback, rimozione, permessi, errore di upload e aggiornamenti esterni con campo omesso.

## 1.1.0 — Immagine utente e scala delle varianti

- Nel profilo utente Foundry, accanto al campo dell'immagine, **Inquadra immagine** apre l'editor con trascinamento, zoom, ritaglio e sfondo. Salva `User.avatar`, senza cambiare il ritratto del personaggio assegnato. Un giocatore può modificare il proprio profilo; il GM anche quelli degli altri utenti.
- In **Varianti token** e **Gestisci varianti**, **Griglia** controlla l'ingombro; **Scala visiva** controlla l'immagine (per esempio `1,25` o `1.25` = 125%). Accetta valori da 0,01 a 10. Vuoto eredita la scala base, anche per le vecchie varianti. Specchiatura e ripristino del token base sono conservati.
- La scala aggiorna anche i token già collocati che usano quella variante e che l'utente può modificare. Un cambio della sola scala non sposta il token.
- Le sincronizzazioni esterne che omettono `scale` conservano il valore locale della stessa variante. `scale: null` ripristina l'ereditarietà. Wiki Sync attualmente non trasporta questo campo: la scala resta locale e non viene distribuita attraverso il sito.
- API aggiunte: `openUser(user = game.user)` e `openDocumentImage(user)`; evento `khuzoe-tokenizer.userImageSaved`. Le immagini profilo vengono salvate in `<itemIconDirectory>/<world>/users/<user-id>/` con sorgenti recuperabili se abilitate.

Validazione: `node tests/module.test.mjs` e `node tests/features.test.mjs`.

Modulo nativo Foundry VTT v14.367 per gestire avatar e token degli Actor, varianti dei token e immagini degli Item.

## Funzioni

- Click sull'immagine dell'Actor in modalita edit per aprire l'editor.
- Click sull'immagine di oggetti, capacità, talenti e incantesimi in modalità edit per aprire l'editor quadrato dedicato.
- Icone salvate nella cartella globale `khuzoe-tokenizer-icons/<world>/`: seguono l'Item quando passa tra personaggi.
- Nomi file derivati dal contenuto per riusare immagini identiche senza dipendere dalla cartella del proprietario.
- Con il cursore sopra un token visibile, la scorciatoia configurabile `M` apre localmente l'avatar completo dell'Actor.
- Editor a due colonne: avatar a sinistra, token a destra.
- Drag and drop, FilePicker e paste da clipboard.
- Crop con trascinamento e zoom con rotellina.
- Token sempre quadrato.
- Varianti token multiple per Actor, salvate dal tokenizer con dimensione griglia configurabile.
- Nell'editor token la base e separata dalle varianti salvate; una variante puo essere caricata e aggiornata senza sovrascrivere il token base.
- Switch rapido delle varianti dal Token HUD tramite popup con anteprime, mantenendo la trasformazione visuale base.
- Gestione rapida delle varianti dalla sezione Appearance della Token Configuration, con FilePicker, drag and drop, nome, taglia e rimozione.
- Layer multipli su avatar e token: caricamento multiplo, selezione, visibilita, ordine e rimozione, inclusa la base.
- Colore flat opzionale come sfondo sotto le immagini trasparenti di avatar e token.
- Cornici opzionali come asset WebP trasparenti sovrapposti al token.
- Frame mostrati come anteprime dalla cartella configurata, con upload diretto in WebP.
- Il frame ideale e un WebP quadrato con centro trasparente e area esterna trasparente.
- Con un frame attivo, il token riempie di default il cerchio esterno; il ritaglio puo fermarsi all'outer edge o restare libero.
- Avatar esportato mantenendo il formato dell'immagine sorgente.
- Conversione WebP con qualita configurabile.
- Salvataggio in `khuzoe-tokenizer/<actor>-<id>/` nella sorgente Data di Foundry.
- I nomi delle cartelle Actor sono canonici e conservano sempre l'ID completo; il salvataggio viene confermato solo dopo aver verificato che il file esista davvero.
- File con nomi stabili: base, sorgenti, layer e varianti vengono sovrascritti ai salvataggi successivi invece di accumulare copie timestamp.
- Opzione GM per aggiornare anche i token gia presenti nelle scene.
- Se un giocatore proprietario salva per la prima volta e la cartella dell'Actor non esiste, il client GM attivo la crea automaticamente in background e il salvataggio prosegue senza finestre di conferma.

## Compatibilità v14

Le quattro finestre del modulo usano `ApplicationV2` e il renderer Handlebars di Foundry v14. Le integrazioni con schede Actor e Item supportano sia le schede native v14 sia eventuali schede di sistema ancora basate sull'interfaccia precedente, senza modificare i prototipi globali di Foundry.

I dati creati dalle versioni v12 restano compatibili: nomi dei flag, percorsi delle immagini e struttura delle varianti non sono stati cambiati. Al primo avvio del mondo un GM normalizza una sola volta gli eventuali vecchi parametri `?ktz` presenti nei percorsi.

## Installazione locale

Copia questa cartella dentro:

```text
FoundryVTT/Data/modules/khuzoe-tokenizer
```

Poi abilita il modulo nel mondo.

## Impostazioni

- `Qualita WebP`: default `1`, cioe 100%.
- `Dimensione token`: default `1024`, minimo `1024`; immagini sorgente piu grandi vengono esportate alla loro dimensione, fino a `4096`.
- `Dimensione massima avatar`: default `1024`.
- Cartella output: default khuzoe-tokenizer.
- Cartella frame: default khuzoe-tokenizer/frames.
- `Conserva sorgenti WebP`: salva anche una sorgente ricropabile.
- `Aggiorna token piazzati`: default della spunta nell'editor.
- `Avatar dei token visibili`: consente ai giocatori di aprire con `M` l'avatar dei token che possono vedere; proprietari e GM restano sempre autorizzati.
## API per moduli esterni

Dalla versione 0.2.0 il modulo espone `game.modules.get("khuzoe-tokenizer").api` con:

- `open(actor)`
- `openItem(item)`
- `openDocumentImage(document)`
- `manageVariants(actor)`
- `getVariants(actor)`
- `syncVariants(actor, { source, actorId, base, variants })`
- `replaceVariants(actor, { source, revision, variants })`
- `applyVariant(tokenDocument, variantId, { actor, source, reason })`
- `restoreBase(tokenDocument, options)`

Dalla versione 0.3.2 le varianti Managed Actor sincronizzate dal sito diventano varianti manuali normali: possono essere aggiunte, rinominate, sostituite o rimosse sia dal Tokenizer sia dal sito. `replaceVariants()` sostituisce la copia locale con la raccolta canonica senza emettere un nuovo salvataggio verso il Worker, evitando cicli di sincronizzazione.


Il pull di una raccolta condivisa emette `khuzoe-tokenizer.variantsSynchronized`; non emette `saved`, quindi un modulo integratore puo aggiornare Foundry senza generare un POST di ritorno inutile.
Nelle schede D&D5e moderne il click sul ritratto apre il Tokenizer soltanto in modalita Edit. In modalita Play viene mantenuto il normale visualizzatore immagini di Foundry.

Le varianti sincronizzate conservano `source`, `revision`, associazioni di match e Actor proprietario. Ogni sorgente aggiorna solo le proprie varianti, lasciando intatte quelle manuali. Le dimensioni token supportano incrementi di 0,25 a partire da 0,5 caselle. Applicazione e ripristino aggiornano texture, dimensione e flag del Token con una sola operazione.
### Eventi per integrazioni

Dalla versione 0.3.0, dopo un salvataggio manuale riuscito il modulo emette:

- `khuzoe-tokenizer.saved`: avatar/token base o varianti manuali salvati, aggiornati o rimossi;
- `khuzoe-tokenizer.variantsChanged`: sottoinsieme degli eventi precedenti relativo alle varianti.

Il payload include `changedTargets`, `removedVariantIds`, manifest base, varianti correnti e `savedAt`. Gli eventi partono solo dopo che file e flag Actor sono stati salvati correttamente; `syncVariants()` continua a usare il proprio evento `khuzoe-tokenizer.variantsSynchronized` e non promuove automaticamente contenuti sincronizzati da moduli esterni.

Dalla versione 0.3.4 ogni salvataggio scrive inoltre un evento compatto nel flag Actor `khuzoe-tokenizer.syncEvent`. Il flag permette alle integrazioni eseguite dal GM di ricevere in modo affidabile anche i salvataggi effettuati dai proprietari dell'Actor, senza trasportare immagini nel socket e senza rendere obbligatorio alcun modulo esterno.

Dalla versione 0.4.3 gli stati di editing obsoleti vengono ignorati quando avatar o token sono stati modificati da un'integrazione esterna. Un upload mancante o non verificabile interrompe il salvataggio senza aggiornare l'Actor ne emettere eventi di sincronizzazione.
