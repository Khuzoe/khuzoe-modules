# Khuzoe Automations

Versione **0.26.0** — ambiente di riferimento **Foundry VTT 14.367 / D&D5e 5.3.3**. Arcane Ward e le capacità Armorer di Valdor sono descritte in [WARD-ARMORER-0.26.0.md](WARD-ARMORER-0.26.0.md). Le capacità introdotte nella 0.25.0 sono descritte in [CAMPAIGN-FEATURES-0.25.0.md](CAMPAIGN-FEATURES-0.25.0.md), con l'aggiornamento sulla rimozione dello Shield del guardiano; il registro precedente resta in [REMEDIATION-0.24.0.md](REMEDIATION-0.24.0.md). Le copie già presenti sugli attori si aggiornano dall'icona Khuzoe nella barra della scheda oppure dal Medkit CAT. Nessun aggiornamento del mondo viene eseguito dagli strumenti di compilazione.

Automazioni D&D 5e per Foundry VTT v14 basate su Coven's Automation Toolkit, Midi-QOL e DAE.

## Capacità della campagna — primo gruppo

Sono supportate **Difesa Impenetrabile**, **Premonizione Ripetuta**, **Ragionamento Preciso**, **Salvaculo Ragionato** e **Regeneration da 10 PF** del guardiano. Le prime quattro mantengono le regole 2024 indicate nelle schede della campagna; Regeneration mantiene quelle 2014. Il nome storico del compendio delle capacità di classe resta invariato.

Dalla 0.25.1 lo **Shield del guardiano non è automatizzato**: rimosse reazione, configurazione dell'amuleto e sorgente del compendio. L'incantesimo Shield resta disponibile. Riavviare completamente l'applicazione Foundry per caricare codice e compendi aggiornati. Anche i vecchi riferimenti all'automazione eventualmente presenti sulle schede diventano inerti; nessuna scheda viene modificata automaticamente. Un'eventuale vecchia attività “Configura amuleto” già copiata sulla scheda resta priva di automatismo e può essere eliminata dalla scheda.

## Accesso diretto dalla scheda

La bacchetta Khuzoe è sempre visibile nella barra superiore delle schede Actor aperte, prima del menu con i tre puntini. Il colore indica lo stato delle capacità supportate presenti sulla scheda: rosso (!) se almeno una deve essere applicata, giallo (↑) se ci sono versioni da aggiornare, verde (✓) se tutte risultano aggiornate. Il grigio indica che non sono presenti capacità supportate. Il suggerimento sull'icona mostra i conteggi; il verde riguarda le versioni applicate, non certifica le impostazioni di Midi né il funzionamento di ogni capacità nel mondo.

Il proprietario del personaggio o il GM può premere l'icona per vedere l'elenco e applicare le sole automazioni mancanti o obsolete. Aprire la scheda non modifica alcun oggetto. Il colore si aggiorna dopo l'applicazione e quando si aggiungono, modificano o rimuovono capacità. Il pulsante del Medkit resta disponibile e usa la stessa procedura.

## Bless

CAT riconosce gli oggetti `Bless` tramite `system.identifier = "bless"`. Dallo scudo CAT della scheda dell'oggetto o dell'Actor propone **Khuzoe Automations** come sorgente; l'applicazione resta sempre una scelta esplicita dell'utente.

L'automazione conserva nome, descrizione, sorgente, materiali, utilizzi e immagine personalizzata dell'oggetto esistente, mentre aggiorna attività ed effetto operativo.

## Armor of Agathys

CAT riconosce `system.identifier = "armor-of-agathys"` sia con regole 2014 sia con regole 2024. L'automazione gestisce i punti ferita temporanei scalati, la durata, il danno da freddo riflesso sugli attacchi in mischia e la rimozione dell'effetto quando i punti ferita temporanei si esauriscono. L'attività tecnica del danno riflesso resta nascosta nella normale scheda dell'incantesimo.

## Create Bonfire 2014

CAT riconosce `system.identifier = "create-bonfire"`. L'automazione posiziona una Regione persistente di 1,5 metri, risolve il tiro salvezza iniziale e richiama l'attività tecnica nascosta quando una creatura entra per la prima volta in un turno oppure termina il turno nell'area. I due eventi hanno contatori distinti: ciascuno può applicare il danno una volta, anche nello stesso turno; il danno del trucchetto scala automaticamente ai livelli 5, 11 e 17.

## Wall of Fire 2014

CAT riconosce `system.identifier = "wall-of-fire"`. Al lancio consente di scegliere un muro lineare o un anello, le dimensioni consentite, l'altezza e il lato caldo. Crea una Regione sottile e opaca per le fiamme e una seconda Regione per i 10 ft del lato caldo, entrambe collegate alla concentrazione. Il TS iniziale riguarda soltanto le creature nel muro; ingresso e attraversamento condividono il limite del primo ingresso per turno; il danno di fine turno ha un contatore distinto e rispettano il livello dello slot. Se Sequencer e una libreria JB2A compatibile sono attivi, viene aggiunta anche l'animazione persistente del muro.

La Regione viene collegata all'effetto di concentrazione nativo: terminare la concentrazione la elimina. L'accensione degli oggetti infiammabili incustoditi rimane intenzionalmente descrittiva, perché Foundry non dispone di un modello attendibile per classificare gli oggetti nell'area.

## Grapple e Shove 2014

Il compendio delle capacità 2014 include **Grapple** e **Shove** come azioni tecniche autonome. Entrambe validano bersaglio, portata e differenza di taglia e risolvono Atletica dell'attaccante contro Atletica o Acrobazia scelta dal proprietario del difensore; il difensore vince i pareggi.

Grapple applica due effetti collegati, mostra la condizione sul bersaglio e gli aggiunge automaticamente **Escape Grapple**. La fuga consente di scegliere il grappler quando ce n'è più di uno; l'azione tecnica sparisce quando termina l'ultimo grapple. Se il grappler diventa incapacitato, i collegamenti vengono conclusi. Shove consente di scegliere tra **Prone** e uno spostamento di 5 ft lontano dall'attaccante, con collisioni e muri affidati al movimento nativo di CAT.

Foundry non può determinare in modo affidabile se una mano sia davvero libera: quel requisito di Grapple viene confermato dal giocatore. Come nelle regole 2014, le due azioni possono sostituire un singolo attacco dell'azione Attack; l'economia degli attacchi multipli non viene consumata automaticamente dal sistema.

## Incantesimi 2014

Il compendio 2014 include inoltre **Booming Blade**, **Protection from Evil and Good**, **Sanctuary**, **Shield of Faith**, **Shield**, **Aid**, **Aura of Vitality**, **Guardian of Faith**, **Aura of Life**, **Death Ward** e **Circle of Power**. Il Medkit CAT li rileva tramite il loro identificatore standard e può applicarli singolarmente o insieme alle altre automazioni Khuzoe. Durante Wall of Fire, il passaggio del cursore sulle scelte del lato caldo mostra sul canvas un'anteprima semitrasparente della parete e dell'area pericolosa; funziona sia per linea sia per anello e non crea Region temporanee.

Sono gestiti gli attacchi e il movimento di Booming Blade, il tiro imposto da Sanctuary, i bonus difensivi, lo scaling e la scadenza di Aid, la cura bonus di Aura of Vitality, l'evocazione e il limite di 60 danni del Guardian, le due aure da 30 ft e l'intercettazione del danno letale di Death Ward. Shield viene proposto sui colpi e su Magic Missile; finché è attivo applica +5 CA e annulla i danni di Magic Missile.

Shield termina all'inizio del prossimo turno dell'incantatore, anche quando viene lanciato come reazione durante un altro turno nello stesso round. Alla creazione dell'effetto Khuzoe imposta la scadenza nativa e la collega al combattente corretto, evitando la vecchia durata DAE `turnStartSource`. Fuori dal combattimento conserva una durata di 6 secondi. La correzione vale per i nuovi effetti dopo il ricaricamento dei client; gli effetti già presenti non vengono riscritti.

La versione 0.17 aggiunge **78 automazioni 2014 facili e medie** rilevate dal catalogo Cauldron installato. Sono incluse, tra le altre, le famiglie Smite, Hex/Hunter's Mark, i proiettili multipli, teletrasporti e spostamenti, le aure di Aura of Purity/Crusader's Mantle/Pass without Trace, Grease con Region native v14, armi generate, trasformazioni e protezioni persistenti. Gli effetti incorporati sono stati migrati allo schema v14 e le meccaniche Khuzoe non dipendono dal runtime di Chris's Premades.

Tutte le aure Khuzoe usano un confine circolare coerente con il disegno, anche quando gli effetti passano da CAT. Gli aggiornamenti dei buff sono serializzati sul GM e abbinati tramite UUID della sorgente. Aura of Vitality richiede l'aura attiva e un bersaglio nel cerchio; Spirit Shroud usa il cerchio per il danno extra e il rallentamento a inizio turno. Gli effetti già applicati da Spirit Shroud mantengono la loro durata anche dopo l'uscita. Gli incantesimi a bersaglio limitato filtrano quantità e creature valide, mentre stati come charmed, paralyzed, incapacitated, blinded e frightened sono effetti v14 espliciti. Animazioni JB2A/Sequencer puramente estetiche di Cauldron non vengono duplicate. Dettagli e verifiche in [AURA-CIRCLES.md](AURA-CIRCLES.md).

## Sword Bard 2014

- **Bardic Inspiration** valida il bersaglio, usa il dado corretto della scala del bardo e lo propone nel pannello CAT per attacchi, prove di caratteristica, prove di abilità e tiri salvezza. L'effetto viene consumato solo quando il bonus viene scelto.
- **Blade Flourish** gestisce il bonus di movimento e quattro attività tecniche native v14: movimento, Defensive Flourish, Mobile Flourish e Slashing Flourish. Il flourish è limitato a una volta per turno e consuma Bardic Inspiration.
- **Master's Flourish** abilita il d6 gratuito; se il bardo dispone ancora di Bardic Inspiration, lascia scegliere quale dado usare.

Le attività tecniche di Blade Flourish restano nascoste durante l'uso ordinario e vengono richiamate dall'automazione.

## Rune Knight 2014

Il pacchetto include l'intero insieme di capacità operative del Rune Knight:

- **Giant's Might**, inclusi taglia del token, vantaggio alle prove e ai TS di Forza, danno extra una volta per turno e usi pari al bonus di competenza. Il danno extra viene confermato dal proprietario attivo dell'attore, non dal GM; il GM è usato soltanto se nessun owner è connesso. Le taglie normale e di Runic Juggernaut sono configurabili sulla singola capacità dalla sua intestazione o dal Medkit dell'attore; i valori ufficiali restano Large e Huge. Il rinnovo dell'effetto conserva senza scatti la dimensione originale del token.
- **Cloud, Fire, Frost, Hill, Stone e Storm Rune**, con vantaggi passivi, reazioni, tiri salvezza, condizioni, danni ricorrenti e durate gestiti in modo nativo per v14. Le attività attivabili dal giocatore restano visibili, mentre quelle tecniche usano copie runtime non-rider e non compaiono sulla scheda. Cloud Rune viene proposta soltanto quando il bersaglio originale ha disposizione `Friendly`; la creatura a cui deviare l'attacco resta liberamente selezionabile. Storm Rune applica direttamente la scelta dell'owner senza chiedere una seconda conferma a chi effettua il tiro.
- **Runic Shield**, con ripetizione del solo d20 del tiro per colpire, conservazione degli altri dadi e ricalcolo dell’esito contro la CA.
- **Great Stature, Master of Runes e Runic Juggernaut**, rilevati automaticamente per aumentare il dado, portare ogni runa a due invocazioni, consentire la taglia Huge e aumentare la portata in mischia.

Le icone degli effetti temporanei derivano dall'icona corrente della capacità sull'attore. L'applicazione o l'aggiornamento dell'automazione conserva inoltre l'icona personalizzata e il numero di usi già spesi. Gli usi e le reazioni sono serializzati per evitare doppi consumi su eventi simultanei; Fire Rune e Stone Rune provenienti da Rune Knight diversi possono convivere sullo stesso bersaglio.

## Paladino 2014

- **Lay on Hands** mantiene una riserva pari a cinque volte il livello da Paladino. Il giocatore sceglie liberamente quanti punti spendere per la cura; neutralizzare un veleno o curare una malattia costa 5 punti e rimuove l'effetto scelto. Costrutti e non morti vengono esclusi.
- **Divine Smite** viene proposto dopo un colpo con arma da mischia. Il giocatore sceglie lo slot da consumare; i dadi radianti scalano fino al limite di 5d8 e ricevono il d8 aggiuntivo contro immondi e non morti.
- **Aura of Protection** applica il modificatore di Carisma, con minimo +1, ai tiri salvezza del Paladino e degli alleati nell'area.
- **Aura of Courage** rende il Paladino e gli alleati nell'area immuni a `frightened`.
- **Holy Nimbus** consuma il suo uso a riposo lungo e dura 1 minuto. Infligge 10 danni radianti a ogni nemico che inizia il proprio turno nell'aura circolare da 30 ft, mostrata da Khuzoe Auras. Il danno segue il cerchio anche attraverso i muri e indipendentemente dall'illuminazione: questa è la modalità scelta per l'automazione. La luce nativa di Foundry resta un effetto separato, intensa entro 30 ft e fioca per altri 30 ft. Il Paladino riceve inoltre vantaggio ai TS contro incantesimi lanciati da immondi o non morti.

Aura of Protection e Aura of Courage sono operative soltanto mentre il Paladino è cosciente e passano automaticamente da 10 ft a 30 ft al livello 18. Un riconciliatore serializzato aggiorna gli effetti quando i token si muovono o lo stato della sorgente cambia: più spostamenti simultanei vengono accorpati, ogni attore conserva una sola copia dell'effetto e gli eventuali residui importati dalle precedenti aure CAT/Chris's Premades vengono migrati o rimossi. Per questa gestione deve esserci un GM attivo.

Aura of Protection, Aura of Courage e Holy Nimbus usano la geometria circolare di Khuzoe Auras: il raggio parte dal bordo della sorgente e il centro del bersaglio deve essere nel cerchio, considerando anche la differenza di quota. Il calcolo resta circolare anche senza il modulo opzionale e non cambia con il costo delle diagonali della griglia. Nelle scene in metri, il raggio visualizzato viene convertito dai piedi della capacità. Dopo questa correzione del codice basta ricaricare completamente i client, incluso quello del GM che riconcilia gli effetti; non occorre riapplicare CAT.

## Wizard e Bladesinger 2014

- **Arcane Recovery** mostra soltanto gli slot dal 1° al 5° livello realmente spesi e applica un budget pesato pari a metà del livello da Wizard, arrotondato per eccesso. Pact Magic viene esclusa. Il comando è disponibile dopo un riposo breve; l’utilizzo viene riservato per evitare consumi concorrenti e restituito se il recupero fallisce.
- **Bladesong** applica per 1 minuto il modificatore di Intelligenza alla CA e ai TS di concentrazione, +10 ft al movimento e vantaggio ad Acrobatics. Può essere conclusa manualmente e termina a 0 PF o quando il personaggio diventa incapacitato.
- **Song of Defense** viene proposta soltanto durante Bladesong e se la reazione e almeno uno slot sono disponibili. Consuma lo slot scelto, marca la reazione e riduce il danno di `5 × livello dello slot`.
- **Song of Victory** aggiunge automaticamente il modificatore di Intelligenza ai danni degli attacchi con arma da mischia durante Bladesong.

L'applicazione dell'automazione conserva icona e configurazione degli utilizzi già presenti su Arcane Recovery e Bladesong. Una capacità SCAG configurata con due usi per riposo breve rimane quindi tale; una nuova Bladesong proveniente dal compendio usa invece il bonus di competenza per riposo lungo secondo Tasha.

## Incantesimi speciali 2014 — primo blocco (0.23.0)

Il catalogo incantesimi 2014 comprende ora **99 spell**. Questo blocco aggiunge sei automazioni indipendenti in `special-spells-2014.mjs`, senza hook globali sul danno né dipendenza runtime da Cauldron:

- **Mirror Image**: tre duplicati con conteggio nel nome dell'effetto; deviazione degli attacchi, CA del duplicato, critici e sensi speciali. Non protegge dai tiri salvezza.
- **Heat Metal**: danno iniziale e attività bonus **Riscalda di nuovo**, con lo slot originale; dialogo al proprietario del bersaglio per lasciare l'oggetto, tentare di trattenerlo o dichiararlo non rimovibile. Il tavolo identifica l'oggetto metallico: si bersagliano le creature in contatto con esso. Chi lo lascia non viene più danneggiato automaticamente; per un nuovo contatto, selezionare le creature e confermare. Lo svantaggio termina all'inizio del prossimo turno dell'incantatore.
- **Dragon's Breath**: scelta del tipo, capacità temporanea sul destinatario con cono di 15 ft, CD dell'incantatore e scaling dello slot. La capacità viene rimossa insieme all'effetto/concentrazione.
- **Holy Weapon**: selezione dell'arma, proprietà magica e 2d8 radianti solo per i suoi attacchi. Luce sul token del portatore (ATL, se attivo, oppure ripristino controllato dei valori precedenti). **Detona arma sacra** è un'azione bonus; consente di scegliere i bersagli visibili entro 30 ft dall'arma, termina la concentrazione e lascia l'accecamento ai bersagli che falliscono, con TS COS ripetuto a fine turno. L'annullamento del selettore non termina la spell. Lo spostamento materiale dell'arma ad altri portatori o come oggetto a terra non è tracciato: riapplicare la spell al nuovo portatore.
- **Vampiric Touch**: primo attacco al lancio e attacchi successivi senza altri slot; cura tramite Midi-QOL metà del danno necrotico dopo resistenze e riduzioni. L'attività successiva richiede che la concentrazione sia ancora attiva.
- **Chaos Bolt**: scelta del tipo dai due d8 originali e rimbalzo su un'altra creatura entro 30 ft dopo il completamento del danno. Le creature già bersagliate sono escluse dalla stessa catena, le catene di lanci distinti non condividono flag sull'Item e i rimbalzi non consumano altre risorse.

Dopo l'aggiornamento riavviare Foundry, ricaricare i client e applicare le nuove spell dal Medkit con sorgente **Khuzoe Automations**. Nessun attore del mondo viene aggiornato dal build del modulo. Il nuovo pack fisico è `khuzoe-spells-2014-v11`; gli UUID logici di tutte le spell preesistenti rimangono invariati.

Verifica automatica: `node tools/test-special-spells-2014.mjs` e suite completa `npm test`. I test simulano workflow e documenti e non sostituiscono le prove in Foundry con gli altri moduli attivi. Per il collaudo: usare un lancio a livello superiore, ripetere le attività nel turno successivo, terminare la concentrazione, provare immunità/resistenza, annullare i dialoghi e verificare da un client giocatore proprietario dell'attore.

## Rogue 2014

- **Sneak Attack** viene proposto soltanto dopo un colpo valido con arma a distanza o finesse. Richiede vantaggio oppure un altro nemico attivo entro 5 ft dal bersaglio in assenza di svantaggio, ricava i dadi dalla scala del Rogue e ne permette un solo uso per turno. Un attacco di reazione effettuato in un turno differente può quindi applicarlo di nuovo; i critici vengono gestiti dal normale motore dei danni.
- **Cunning Action** espone Dash, Disengage e Hide come tre attività bonus separate, utilizzabili dalla scheda e dalle barre rapide con il tracciamento dell'economia delle azioni di Midi-QOL.
- **Uncanny Dodge** controlla attacco, visibilità, danno e disponibilità della reazione; dopo conferma dimezza il danno totale dell'attacco e marca la reazione come usata.
- **Evasion** usa il supporto Super Saver di Midi-QOL soltanto per effetti che prevedono metà danni su un TS di Destrezza: zero danni sul successo e metà sul fallimento.
- **Reliable Talent** usa la regola nativa di D&D5e 5.3: nelle prove di caratteristica con competenza, un risultato naturale inferiore a 10 viene trattato come 10. Non modifica attacchi, tiri salvezza o prove senza competenza.

L'applicazione o l'aggiornamento delle cinque automazioni conserva l'icona personalizzata della capacità esistente.

## Goliath 2014

**Stone's Endurance** viene proposta al proprietario del Goliath quando sta per subire danni e dispone ancora della reazione e di almeno un uso. Dopo la conferma tira `1d12 + Costituzione`, riduce il danno effettivo senza poterlo portare sotto zero e registra pubblicamente il risultato; un errore tecnico durante il tiro ripristina uso e reazione. La capacità nuova usa un utilizzo per riposo breve o lungo secondo la versione classica 2014, mentre l'aggiornamento conserva eventuali usi e recuperi già personalizzati sull'attore.

## NPC homebrew

Il compendio **Khuzoe Automations — Capacità NPC 2014** contiene le capacità operative di **El'Athel**, **Na'Niss** e **Spirito Elementale Fatato**. Il Medkit CAT le riconosce sugli oggetti originali senza sostituirne nome, descrizione, immagine, attività o flag appartenenti ad altri moduli.

- **El'Athel**: Psychic Strike in mischia e a distanza condividono il conteggio dei colpi e applicano lo stordimento previsto al secondo colpo; Brain Storm gestisce il danno corretto e i TS ripetuti contro il veleno; Impenetrable Ego e Appeal to the Fervent intervengono automaticamente nei rispettivi tiri. Multiattack riceve un comando dedicato solo su questo attore. **Bend the Spoon è intenzionalmente esclusa.**
- **Na'Niss**: Aura Rinvigorente, evocazione dello Spirito, Danza Incoraggiante, Multiattacco e Colpo Purificante sono collegati tra loro. Il secondo colpo può potenziare le cure dell'aura e lo Spirito evocato segue l'iniziativa di Na'Niss.
- **Spirito Elementale Fatato**: Aura Rinvigorente Espansa, Esplosione Radiosa, Protettore Spirituale, Multiattacco e Colpo Energico gestiscono cure, punti ferita temporanei e trasferimento del danno nell'area condivisa.

Le due aure possono sovrapporsi e funzionano come sorgenti indipendenti. Per distanza e bersagli usano **Khuzoe Auras**; il modulo è quindi indicato tra le dipendenze consigliate.

Protettore Spirituale usa la stessa aura configurata dello Spirito anche per distribuire il proprio effetto. La riconciliazione conserva l'area configurata delle aure NPC esistenti; le nuove aure da 15 ft vengono convertite nelle unità della scena.

## Applicazione multipla dal Medkit

Nel tab **Automazioni** del Medkit CAT dell'attore è disponibile **Applica tutte le automazioni Khuzoe**. Il comando è disponibile al GM e a qualsiasi utente proprietario dell'Actor, indipendentemente dalla soglia di ruolo scelta per modificare le altre automazioni CAT. Rileva gli incantesimi supportati, Keeper of Giant's Strength e le capacità Sword Bard, Rune Knight, Paladino, Wizard, Bladesinger, Rogue, Goliath, Barbaro e Druido compatibili; salta quelle già aggiornate e chiede conferma prima di applicare le rimanenti. Oggetti non supportati e automazioni di altre fonti non vengono modificati.

## Keeper of Giant's Strength (Homebrew 2014)

CAT riconosce `system.identifier = "keeper-of-giants-strength"`. Sugli attacchi in mischia basati su Forza propone prima del tiro l'opzione **−5 al tiro per colpire / +10 ai danni**, ma soltanto quando il bersaglio è più piccolo o risulta afferrato dall'attaccante. Il collegamento del grapple viene riconosciuto dagli effetti creati dalle automazioni CPR/CAT o da un effetto con origine esplicita; il solo stato generico `grappled`, privo di sorgente, non viene attribuito arbitrariamente all'attaccante.

Su un colpo critico contro un bersaglio più piccolo aggiunge il modificatore di Forza per ogni categoria di differenza, una sola volta durante il proprio turno; i critici ottenuti con reazioni nel turno altrui non lo attivano. Il nuovo Grapple Khuzoe viene riconosciuto direttamente. Entrambi i bonus sono valori fissi e non vengono raddoppiati dal critico. Il danno usa lo stesso tipo dell'attacco.

## Wild Shape (Druido 2014)

CAT rileva `system.identifier = "wild-shape"` e applica una capacità che usa la trasformazione nativa di D&D5e 5.3. Il selettore filtra automaticamente CR, volo, nuoto, Circle Forms ed Elemental Wild Shape. Gli utilizzi vengono consumati soltanto dopo una trasformazione riuscita; la durata, il ritorno volontario e il danno eccedente a 0 PF vengono gestiti dal modulo.

Il GM configura le sorgenti predefinite da **Impostazioni modulo → Wild Shape — sorgenti**. Dal Medkit dell'attore, oppure dalla scheda della capacità, può assegnare compendi, cartelle e forme conosciute alla singola abilità di trasformazione. Se lo stesso attore possiede più capacità Wild Shape, il Medkit mostra quale si sta configurando: ciascuna può quindi usare sorgenti differenti. Le precedenti configurazioni salvate sull'attore restano valide come fallback e vengono copiate sull'abilità al primo salvataggio, senza cancellare dati. Le creature sorgente non vengono copiate né modificate.

## Rage e Bear Totem (Barbaro 2014)

CAT rileva `system.identifier = "rage"`. **Attiva Rage** consuma gli utilizzi già configurati sulla capacità e crea un effetto di 1 minuto con vantaggio alle prove e ai TS di Forza, bonus ai danni degli attacchi in mischia basati su Forza e resistenza a contundente, perforante e tagliente. Se l'attore possiede `totem-spirit-bear` (anche con nome italiano riconosciuto), l'effetto applica tutte le resistenze standard tranne psichico. **Termina Rage** consente la conclusione manuale come azione bonus.

Il mantenimento viene controllato tra due fini-turno: un attacco effettuato, anche senza bersaglio selezionato o senza colpire, oppure qualsiasi danno realmente subito ai PF o ai PF temporanei mantiene Rage. In assenza di entrambi, Rage termina automaticamente alla fine del turno. **Persistent Rage** esclude questa conclusione anticipata. L’attivazione termina la concentrazione; durante Rage gli incantesimi vengono bloccati. L’armatura pesante disabilita i benefici ordinari che la escludono, conservando le eccezioni previste per Bear Totem.

Circle of the Moon aggiunge automaticamente attivazione come azione bonus, guarigione con slot, CR di Circle Forms, Primal Strike e le quattro forme elementali. Un GM attivo è necessario quando un giocatore non possiede il permesso globale di creare Attori: l'operazione viene delegata in modo ristretto tramite SocketLib.

## Comandi e comportamento dopo la revisione

Nel Medkit è disponibile **Aiuta / termina un effetto**: rimozione dell’acido di Tasha’s Caustic Brew, liberazione dal ghiaccio di Rime’s Binding Ice, risveglio da Hypnotic Pattern, termine volontario di Gaseous Form, uso di Death Ward contro una morte istantanea senza danni e rilascio/richiamo di Shadow Blade. Le azioni di aiuto richiedono una creatura capace di agire; il richiamo della lama consuma un’azione bonus.

Booming Blade e Green-Flame Blade aggiungono i dadi iniziali al tiro dell’arma, affinché critici e reazioni vedano un unico attacco. I danni ceduti da Legame del Danno e Protettore Spirituale vengono applicati dopo la risoluzione del danno originale. Le guarigioni generate usano il sistema nativo e rispettano le sue protezioni e limitazioni.

Grease, Earth Tremor, Ice Storm e le forme pertinenti di Guardian of Nature e Investiture of Ice creano terreno difficile tramite Regioni. Earth Tremor resta finché il terreno non viene ripulito e il GM elimina la relativa Regione. Lo spazio disponibile per crescere, le mani libere, gli oggetti e le altre condizioni narrative richiedono una decisione del tavolo.
