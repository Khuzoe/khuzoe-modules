# Khuzoe Boss Bar

Modulo Foundry Virtual Tabletop V14 per mondi DnD5e. Il GM seleziona uno o piu token con punti ferita e mostra ai giocatori barre vita in stile souls-like, senza numeri HP.

## Installazione in sviluppo

1. Copia o collega questa cartella dentro `{userData}/Data/modules/khuzoe-boss-bar`.
2. Avvia Foundry VTT V14.
3. Abilita `Khuzoe Boss Bar` nel mondo DnD5e.

## Uso

1. Il GM seleziona uno o piu token mostro sulla scena.
2. Clicca `Aggiungi selezionati` nei controlli token a sinistra.
3. Tutti i client vedono le barre in alto. Le barre restano visibili cambiando scena.
4. Trascina la piccola icona di spostamento sulla barra per posizionarla dove preferisci. La posizione non viene salvata: quando la barra riappare parte dal default in alto al centro.
5. Tutti possono usare `Nascondi` dentro una barra per nasconderle sul proprio client. Resta un piccolo pulsante quadrato per renderle di nuovo visibili.
6. Il GM puo usare il cestino su una singola barra per rimuovere solo quella.

Ogni utente puo scegliere in `Impostazioni di Gioco` se ancorare le barre in alto o in basso. Le nuove barre crescono verso il centro dello schermo e la larghezza disponibile evita automaticamente i controlli scena, la sidebar e gli eventuali pannelli video laterali.

Ogni utente puo inoltre scegliere gli effetti personali: `Disattivati`, `Discreti` oppure `Cinematici`. La modalita discreta anima solo la barra; quella cinematica usa le API native v14 per un leggero scuotimento e un breve burst di particelle sul token visibile quando subisce un colpo rilevante, entra in fase critica o viene sconfitto. Gli effetti rispettano automaticamente le preferenze di movimento ridotto e la modalita fotosensibile di Foundry, non mostrano valori numerici e sono limitati da soglie e tempi di recupero anti-spam.

Il modulo salva nel world setting solo percentuale, nome, immagine e riferimenti documento. Non salva HP correnti o massimi nello stato condiviso con i giocatori.

## Temi automatici (0.4.0)

Le nuove barre scelgono automaticamente fra Fiamma, Gelo, Tempesta, Veleno e acido,
Spettrale, Radioso, Arcano, Silvestre e Ferro. Se gli indizi sono deboli o ambigui,
resta il tema Classico con la palette estratta dal ritratto.

Il GM apre i comandi cliccando la barra, poi preme la tavolozza. Il selettore Tema
mostra anche la scelta rilevata in Automatico. Puoi scegliere un tema diverso per
ogni boss e minion; la scelta è condivisa con tutti i giocatori. Torna ad Automatico
per riprendere il rilevamento. Il colore personalizzato ha precedenza sui colori
del tema; il pulsante con freccia circolare ripristina il colore del tema/ritratto.
Se riaggiungi lo stesso token o la vita cambia, le scelte manuali sono conservate.

Il riconoscimento usa tipo di creatura, nome e sottotipo, immunità, resistenze,
nomi delle capacità e tipi di danno delle attività DnD5e (anche il formato legacy).
Una sola resistenza o un generico incantesimo non bastano. Non interpreta biografie
né immagini con IA: l'immagine fornisce già la palette del tema Classico.
Gli oggetti e gli effetti del boss aggiornano il riconoscimento automaticamente.
Le barre già presenti sono aggiornate dal GM alla ricarica senza doverle ricreare.

Ogni tema aggiunge texture luminose ed effetti coerenti, più intensi a vita bassa,
con spegnimento alla sconfitta. I burst cinematografici usano il colore del tema.
Disattivati lascia i colori statici; movimento ridotto e modalità fotosensibile
fermano le nuove animazioni. Non vengono condivisi schede, descrizioni, capacità,
resistenze o valori HP: solo gli identificativi dei temi e la percentuale vita già
usata dal modulo. Non viene modificato alcun dato del boss.

## Origini e bordo esterno (0.4.1)

Nuovi temi: Vuoto cosmico, Ombra, Sangue e Abissale. Il riconoscimento considera
nomi e sottotipi espliciti (per esempio "Lich del Vuoto", "Shadow Dragon" o
"Demone abissale") e nomi di capacità coerenti. Un'aberrazione generica resta
Arcana: la sola categoria non basta a dedurre un'origine nel Vuoto. Il GM può
sempre scegliere questi temi dal selettore, oppure tornare ad Automatico.

I temi ora decorano anche una fascia stretta appena fuori dalla barra, con
piccole particelle, foschia e filamenti coerenti con il tema. Il Vuoto mostra
fratture violacee, Ombra una foschia scura, Sangue piccole gocce e Abissale
scintille corrotte. A vita alta gli effetti sono tenui; sotto metà vita diventano
più presenti, sotto il 25% l'aura pulsa lentamente, e alla sconfitta si spegne.
Non sono nuove fasi di gioco: la reazione è solo visiva, basata sulla percentuale
vita già condivisa. Gli effetti dei minion e dei boss multipli sono più contenuti.
Movimento ridotto e modalità fotosensibile lasciano il bordo statico, mentre
Disattivati nasconde la decorazione esterna. Nessun nuovo intervallo o ciclo JS.
