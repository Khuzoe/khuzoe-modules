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

Ogni utente può scegliere gli effetti personali nelle impostazioni del modulo. Durante lo scontro, `Discreti` anima la barra. `Cinematici` aggiunge un leggero scuotimento e particelle sul token visibile quando subisce un colpo rilevante, entra in fase critica o viene sconfitto.

### Ingresso del boss

Quando il GM seleziona un NPC e preme il cuore `Aggiungi selezionati`, la sua card appare al centro dello schermo del GM e dei giocatori collegati per circa cinque secondi. L'ingresso funziona anche con il GM da solo. Il GM deve avere accesso alla card tramite **Khuzoe Wiki Sync**, la stessa fonte usata da Khuzoe HUD. I giocatori ricevono l'immagine anche senza un account wiki. La barra appare subito anche quando la card manca o tarda a caricarsi.

Con `Discreti` la card si apre al centro e un riflesso attraversa l'illustrazione. Con `Cinematici` entra in prospettiva davanti a un sigillo in rotazione. Il nome e la cornice riprendono lo stile della barra. Movimento ridotto e modalità fotosensibile mostrano una card statica. `Disattivati` salta la presentazione.

Le card dei boss aggiunti insieme appaiono una alla volta. Per ripetere l'ingresso, seleziona il boss e premi di nuovo il cuore, anche con la barra già visibile. I minion e gli aggiornamenti dei punti ferita non avviano la sequenza.

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

## Posizionamento all'avvio (0.4.2)

Corretto lo spostamento imprevisto delle barre verso il centro durante l'avvio:
le notifiche temporanee non cambiano più l'ancoraggio. La navigazione scene di
Foundry V14 è verticale e viene ora evitata lateralmente, senza posizionare la
barra sotto le sue liste o contenitori alti quanto lo schermo. La navigazione è
osservata anche quando viene espansa o ricreata durante il caricamento.

Nascondere/ripristinare la barra o cliccare un comando di trascinamento o
ridimensionamento senza muoverlo non fissa più la posizione automatica come
manuale. Trascinamenti e ridimensionamenti intenzionali restano conservati
nella sessione. L'ancoraggio inferiore continua a evitare hotbar e video.
Ricaricare i client per applicare la correzione e azzerare le vecchie posizioni
errate conservate nella memoria della sessione.
