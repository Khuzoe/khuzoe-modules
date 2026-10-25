# Khuzoe Monster HUD

Overlay minimale per controllare rapidamente NPC e personaggi in Foundry VTT 14.367 con D&D 5e 5.3.3.

## Funzioni

- Abilità rapide selezionabili dalla scheda dell'NPC, con la loro icona originale.
- Suggerimento automatico delle principali abilità quando non esiste una configurazione.
- Multiattack configurato per abilità, con un numero indipendente di utilizzi per ciascuna o una riserva condivisa.
- Conteggio per turno persistito sul Combatant e reset automatico al cambio turno.
- Legendary Actions e Legendary Resistances sincronizzate con le risorse native D&D5e.
- Pulsante per applicare una Legendary Resistance all'ultimo TS fallito compatibile.
- Sei tiri salvezza rapidi più Percezione, Furtività, Atletica e Acrobazia.
- Pannello spell diviso per livello con slot e utilizzi nativi.
- Posizione e scala configurabili per client.
- HUD trascinabile dalla testata, con posizione salvata sul client e ripristino tramite doppio clic.
- Interruttore GM **Rivela nome** tra `Hover Anyone` e `Hovered by Owner` per il token selezionato.
- Compatibilità con token collegati e non collegati.
- Accesso per ownership: ogni proprietario può vedere, usare e configurare l'HUD sia per i propri personaggi sia per i propri NPC; non è richiesta una concessione globale del GM.

Il modulo usa `Item.use()` di D&D5e e osserva l'hook nativo `dnd5e.postUseActivity`: tiri, consumi, messaggi chat e integrazioni con altri moduli continuano a passare dal workflow ufficiale del sistema.

## Utilizzo

1. Abilitare **Khuzoe Monster HUD** nel mondo.
2. Controllare un token NPC o personaggio di cui si è proprietari: l'overlay appare vicino alla hotbar e non può essere disattivato accidentalmente tramite le vecchie impostazioni di accesso.
3. Usare l'ingranaggio nell'overlay, oppure il drago nel Token HUD, per scegliere le abilità.
4. Per un Multiattack creare un gruppo, includere le abilità desiderate e impostare il campo **Volte** per ciascuna.

Quando si apre una configurazione senza gruppi, il modulo prova a leggere la capacità Multiattack dell'NPC. Compila automaticamente le quantità soltanto se il testo associa numeri inequivocabili alle singole abilità; in caso di alternative esplicite con “o/or” crea gruppi separati, mentre in caso di dubbio lascia la configurazione manuale.

Il limite Multiattack è intenzionalmente morbido: quando esaurito l'interfaccia si oscura e avvisa, ma il GM può comunque eseguire l'abilità.

## Dati

- Configurazione: `flags.khuzoe-monster-hud.config` sull'Actor base.
- Conteggio del turno: `flags.khuzoe-monster-hud.turnUsage` sul Combatant.
- Legendary Actions, Legendary Resistances, slot e utilizzi rimangono dati nativi D&D5e.

Non vengono modificati sito, worker o dati di Wiki Sync.

## Verifica locale

```text
npm run validate
```
