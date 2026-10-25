# Khuzoe Auras

Khuzoe Auras è un modulo leggero e indipendente per gestire aure in:

- Foundry Virtual Tabletop 14 (verificato su 14.367);
- sistema D&D 5e 5.3 (verificato su 5.3.3).

Non richiede Midi-QOL, DAE o socketlib.

## 0.5.4 — Correzioni e riepilogo delle aure

- La rimozione delle aure e delle relative immunità usa la sostituzione nativa dei flag di Foundry 14: un'aura eliminata non ricompare al salvataggio e gli altri flag restano intatti.
- Gli effetti disattivati, scaduti o soppressi di altre fonti non impediscono una nuova applicazione. Gli effetti della stessa aura vengono rinnovati; quelli di un altro portatore non vengono modificati.
- L'attivazione manuale rispetta il requisito di coscienza e ricontrolla la configurazione al momento dell'esecuzione. Le operazioni in coda si fermano se il client non è più il GM attivo.
- La chat raggruppa i risultati per aura, portatore e momento di attivazione. Mostra PF effettivamente recuperati o persi, PF temporanei finali, tiro, TS con CD ed esito, stato di ciascun effetto ed eventuale immunità all'aura.
- Gli effetti già attivi, le immunità alle condizioni e gli effetti mancanti sono distinti. Un riepilogo con più portatori non viene attribuito soltanto al primo.
- La visibilità del riepilogo segue la modalità dei messaggi scelta in Foundry, anche per le azioni senza dadi.

Per caricare questa versione nei client già aperti, ricaricare la pagina di Foundry. Non serve riconfigurare le aure.

Verifiche: `npm run validate`; per i controlli contro le funzioni native di Foundry e il rendering Handlebars, `npm run test:native` nell'installazione portatile oppure `node tools/test-foundry-native.mjs <percorso-App/resources/app>`.

## Funzioni

- Più aure per token.
- Creazione e modifica disponibili al GM e a ogni proprietario del token.
- Raggio visivo e meccanico unificato: il centro del bersaglio deve trovarsi nel cerchio dell'aura.
- Bersagli alleati, nemici, neutrali o tutti.
- Trigger all'inizio/fine del turno del portatore.
- Trigger all'inizio/fine del turno di ciascun bersaglio nell'aura.
- Trigger a inizio/fine round, ingresso, uscita e attivazione manuale.
- Azioni di cura, danno, punti ferita temporanei ed effetti.
- Più azioni per la stessa aura.
- Tiri separati o un unico tiro condiviso.
- Tiri salvezza opzionali per danni ed effetti.
- Immunità persistente alla singola aura dopo un tiro salvezza riuscito, se abilitata.
- Condizioni ed effetti dell'attore applicabili quando il tiro salvezza fallisce.
- Icona degli effetti falliti mostrabile o nascondibile sul token.
- Resistenze, vulnerabilità e immunità gestite tramite `Actor5e.applyDamage`.
- Protezione contro esecuzioni duplicate.
- Regole configurabili per aure sovrapposte.
- Visualizzazione client-side senza creare template persistenti.
- Modalità **Solo visuale** senza bersagli, trigger, azioni o messaggi in chat.
- Interfaccia nativa ApplicationV2 di Foundry 14.
- Configurazione moderna a sezioni, riepiloghi immediati e checklist degli effetti senza multiselezione tramite Ctrl.
- Supporto ai campi di movimento e ai livelli nativi introdotti in Foundry 14.
- API per registrare nuovi tipi di azione.

Le aure configurate nella versione v12 restano utilizzabili: il formato salvato nei flag dei Token non è stato modificato e non viene eseguita alcuna migrazione distruttiva all'avvio.

## Installazione locale

1. Copiare la cartella `khuzoe-auras` dentro `FoundryVTT/Data/modules/`.
2. Riavviare Foundry VTT.
3. Abilitare **Khuzoe Auras** nella gestione moduli del mondo.
4. Selezionare un token e usare il pulsante a forma di sole nel Token HUD.

## Esempio: aura curativa

Configurazione consigliata:

- raggio: `15`;
- bersagli: `Alleati`;
- trigger: `Inizio turno del portatore`;
- azione: `Cura`;
- formula: `1d6`.

Per curare ogni alleato sia all'inizio sia alla fine del suo turno, selezionare invece:

- `Inizio turno del bersaglio`;
- `Fine turno del bersaglio`.

## Esempio: aura dannosa

- bersagli: `Nemici`;
- trigger: `Inizio turno del bersaglio`;
- azione: `Danno`;
- formula: `2d6`;
- tipo: `radiante`, `fuoco` o qualsiasi tipo disponibile in dnd5e;
- tiro salvezza opzionale con effetto nullo o danno dimezzato.

Per rendere il superamento del tiro salvezza definitivo per quella specifica aura, attivare **Un successo rende immune all'aura**. L'immunità resta valida anche uscendo e rientrando nell'area e viene azzerata quando l'aura viene disattivata o rimossa.

## Esempio: effetto al fallimento

- azione: `Effetto` oppure `Danno`;
- attivare il tiro salvezza e impostare caratteristica e CD;
- selezionare una o più condizioni o effetti in **Effetti in caso di fallimento**;
- impostare la durata in round; `0` indica una durata indefinita.

Gli effetti disponibili comprendono le condizioni native di D&D 5e e gli Active Effect presenti sull'attore portatore o sui suoi oggetti. Il modulo crea veri Active Effect sul bersaglio e non modifica l'effetto sorgente.

## Semantica dei trigger

- I trigger del **portatore** esaminano tutti i bersagli validi quando comincia o termina il suo turno.
- I trigger del **bersaglio** agiscono solo sulla creatura il cui turno sta cominciando o terminando.
- `Ingresso` e `Uscita` vengono calcolati dopo che un token ha concluso l'animazione di movimento.
- Durante lo spostamento l'aura resta nella posizione di partenza e viene aggiornata soltanto all'arrivo.
- I cambi di livello, profondità, forma e dimensione del Token aggiornano immediatamente l'appartenenza all'aura.
- Gli effetti automatici vengono applicati esclusivamente dal GM attivo.
- Un arretramento manuale del tracker non riapplica gli effetti.

## Distanze e muri

Il raggio configurato parte dal bordo del portatore, non dal suo centro. Il bersaglio viene però coinvolto soltanto quando il centro del suo token si trova dentro o esattamente sul cerchio visualizzato. Il semplice contatto del bordo del bersaglio con l'aura non è sufficiente; la stessa geometria viene usata su scene con e senza griglia.

Il controllo dei muri è opzionale. La collisione usa il backend di visione di Foundry quando la scena è aperta sul canvas del GM; su scene non visualizzate il muro non viene considerato.

L'elevazione opzionale usa una distanza euclidea tridimensionale fra le elevazioni dei token.

## Sovrapposizione

Le aure senza un gruppo di sovrapposizione sono indipendenti. Due aure con lo stesso gruppo possono:

- sommarsi;
- applicare solo quella con priorità più alta;
- applicare solo la prima.

## API

L'API è disponibile dopo l'hook `khuzoeAuras.ready`:

```js
game.khuzoeAuras.getAuras(token);
game.khuzoeAuras.getAura(token, auraId);
game.khuzoeAuras.getAuraSources(scene, auraId);
game.khuzoeAuras.getEligibleTargets(token, auraId);
game.khuzoeAuras.getEligibleTargets(token, auraId, { includeInactiveSource: true });
game.khuzoeAuras.isTargetEligible(token, target, auraId);
game.khuzoeAuras.setAuras(token, auras);
game.khuzoeAuras.activateAura(token, auraId);

// Geometria condivisa anche con i moduli che forniscono aure solo visuali.
game.khuzoeAuras.geometry.tokenCenter(scene, token);
game.khuzoeAuras.geometry.tokenPixelBounds(scene, token);
game.khuzoeAuras.geometry.auraRadiusPixels(token, aura, scene);
game.khuzoeAuras.geometry.isWithinAura(scene, token, target, aura);

game.khuzoeAuras.registerActionType("my-action", async (action, context) => {
  // Restituire un oggetto risultato per includerlo nel riepilogo in chat.
});
```

## Prestazioni

Non viene eseguito alcun polling e non vengono effettuati calcoli a ogni fotogramma. Le appartenenze vengono aggiornate solo su movimenti, modifiche delle aure, cambi turno e cambi round. La modalità diagnostica nelle impostazioni del modulo mostra tempi e numero di confronti nella console.

## Sviluppo

Richiede Node.js 20 o successivo solo per le verifiche locali:

```text
npm run validate
```

Foundry VTT non richiede Node.js aggiuntivo per utilizzare il modulo.

## Revisione 0.5.2

La massimizzazione delle guarigioni riconosce `flags.midi-qol.grants.max.damage.heal`, usato dagli effetti che potenziano le cure ricevute. La vecchia chiave rimane un fallback. Verificati i 45 test del modulo; questa revisione non migra dati o impostazioni del mondo.
