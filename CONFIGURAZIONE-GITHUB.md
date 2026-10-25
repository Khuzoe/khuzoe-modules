# Configurazione GitHub — una volta sola

Progetto pubblicato in **Khuzoe/khuzoe-modules**. GitHub Actions e Pages sono attivi; catalogo e download verificati il 25 ottobre 2026. Nessun modulo già installato è stato cancellato o sostituito. I passaggi seguenti restano come riferimento per la configurazione iniziale.

## Cosa devi fare tu

1. Su GitHub, con l'account **Khuzoe**, crea un repository chiamato **khuzoe-modules**, pubblico. Lascialo vuoto: non aggiungere README, licenza o `.gitignore` iniziali. Il progetto preparato contiene già README e `.gitignore`.
2. Se vuoi che Codex carichi i file, autorizza questo nuovo repository nel collegamento GitHub di Codex. Attualmente il collegamento disponibile vede solo `Khuzoe/sigillo-del-male`. Comunica poi il link del nuovo repository. Non occorre condividere password o token in chat.
3. Nel nuovo repository apri **Settings → Actions → General** e consenti GitHub Actions. Se ci sono restrizioni sulle azioni, devono essere consentite le azioni ufficiali `actions/*` utilizzate dai workflow.
4. Apri **Settings → Pages → Build and deployment** e imposta **Source: GitHub Actions**. Se Pages non è ancora configurabile perché il repository è vuoto, fallo subito dopo il primo caricamento dei file.

I workflow dichiarano già i permessi necessari: `contents: write` per le Releases; `pages: write` e `id-token: write` per Pages. Il token temporaneo `GITHUB_TOKEN` viene creato automaticamente da GitHub. In questa configurazione non servono token personali, segreti, servizi a pagamento o un dominio.

## Primo caricamento e pubblicazione

Nel repository va caricata **la radice di questo progetto**, con `.github`, `app`, `modules`, `tests`, `tools`, `publisher.config.json`, README e guide. Non va caricata la cartella dati di Foundry. Non includere `build`, `dist`, `.work` o `node_modules`.

Se il caricamento viene eseguito con Git, `.gitignore` esclude già queste cartelle. La prima importazione su `main` è stata completata; le modifiche successive si inviano allo stesso repository.

Dopo il primo caricamento, in **Actions** devono comparire:

- **Pubblica moduli Khuzoe**: crea undici Releases separate e pubblica il catalogo Pages.
- **Compila Khuzoe Updater**: verifica e compila l'app Windows e pubblica la release `updater-v0.1.0`.

Se il workflow dei moduli parte prima che tu abbia attivato Pages, attiva Pages e poi apri la run fallita e premi **Re-run all jobs**. Puoi anche avviare il workflow dalla sua pagina con **Run workflow**, scegliendo `main`. Un secondo tentativo non sovrascrive release diverse: controlla che i pacchetti esistenti coincidano.

La prima pubblicazione usa le versioni attuali dei moduli; non vengono aumentate automaticamente. Chi ha già quelle versioni vedrà **Aggiornato**. Quando pubblichi una versione più alta del singolo modulo, vedrà **Da aggiornare**.

## Indirizzi dopo la pubblicazione

- Catalogo: https://khuzoe.github.io/khuzoe-modules/catalog.json
- Releases: https://github.com/Khuzoe/khuzoe-modules/releases
- Manifest di esempio: https://khuzoe.github.io/khuzoe-modules/modules/khuzoe-merchant/module.json

L'indirizzo del catalogo è già incorporato nell'eseguibile preparato. Se scegli un nome di account/repository diverso, vanno aggiornati `publisher.config.json` e ricompilata l'app prima di distribuirla. Non basta rinominare il repository dopo aver distribuito l'eseguibile.

Per i DM distribuisci `KhuzoeUpdater-Windows.zip`, non lo ZIP dei sorgenti del progetto. Devono estrarlo e lasciare insieme `KhuzoeUpdater.exe` e `KhuzoeUpdater.exe.config`.

## Uso successivo

Per pubblicare Merchant, per esempio, si modificano i suoi file e si porta la versione da `1.21.2` a `1.21.3`, poi si invia a `main`. GitHub genera soltanto la nuova release Merchant. Il catalogo continua a contenere le versioni precedenti degli altri moduli.

Non serve creare tag, ZIP o release a mano. Il workflow non pubblica automaticamente modifiche rimaste soltanto nelle cartelle del tuo Foundry locale: devono essere riportate nei sorgenti di questo repository e inviate a `main`.

## Riferimenti

- [Workflow personalizzati per GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [Token temporaneo GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)
- [Eventi che avviano GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
