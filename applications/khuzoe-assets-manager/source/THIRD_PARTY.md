# Componenti di terze parti

L'eseguibile dell'app è compilato con il .NET Framework incluso in Windows e non dipende da pacchetti NuGet.

Gli eseguibili di elaborazione vengono scaricati direttamente dai rispettivi canali ufficiali al primo utilizzo, in una directory locale dell'utente. La distribuzione e le licenze dei progetti originali restano applicabili.

| Componente | Fonte ufficiale | Licenza del progetto |
| --- | --- | --- |
| yt-dlp, build Windows autonoma | https://github.com/yt-dlp/yt-dlp | Unlicense e licenze dei componenti incorporati, riportate dal progetto |
| FFmpeg e ffprobe, build statica Windows GPL | https://github.com/yt-dlp/FFmpeg-Builds | GPL, secondo configurazione e componenti della build; sorgenti e istruzioni disponibili nel progetto delle build e su https://ffmpeg.org |
| Node.js, eseguibile Windows della linea 22 | https://nodejs.org/dist/latest-v22.x/ | MIT e licenze delle dipendenze, consultabili su https://github.com/nodejs/node/blob/main/LICENSE |

L'app verifica l'impronta pubblicata nella release GitHub per yt-dlp e il pacchetto FFmpeg. Node viene verificato contro `SHASUMS256.txt` distribuito da nodejs.org. I quattro eseguibili installati vengono registrati in un manifesto locale SHA-256 e controllati prima dell'uso.

L'integrità dipende dall'autenticità dei canali ufficiali HTTPS e degli account di pubblicazione. L'app non modifica le impostazioni di verifica dei certificati di Windows.

## Lettore scene incluso nel pacchetto

La directory `scene-reader` include il lettore Khuzoe e `classic-level` 3.0.0 con le sue dipendenze di produzione, fissate nel `package-lock.json`. Fonte: https://github.com/Level/classic-level . Il progetto classic-level è MIT; le licenze di LevelDB e degli altri componenti sono conservate nelle directory dei rispettivi pacchetti. Il codice nativo precompilato viene distribuito dal progetto classic-level. Non sono inclusi codice o componenti proprietari di Foundry.

`integrity.json` contiene le impronte SHA-256 dei file inclusi ed è controllato prima della lettura. Non è una firma del produttore. Il lettore apre soltanto copie identificate dall'app, mai la directory del database originale.
