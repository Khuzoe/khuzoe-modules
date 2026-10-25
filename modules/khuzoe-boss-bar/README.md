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
