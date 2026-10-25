# Khuzoe WebP Autoconverter

Modulo per FoundryVTT v14 che converte automaticamente PNG/JPG caricati tramite FilePicker in WebP lato client, mantenendo la trasparenza. Se il file è già WebP non viene toccato.

## Come funziona
- Chiunque carichi (GM o Player con permesso) passa dal FilePicker V14: il file viene convertito in WebP sul client e poi inviato al server.
- Il nome rimane lo stesso, cambia solo l'estensione in `.webp`.
- Formati gestiti: PNG, JPG, JPEG. WebP viene lasciato invariato.

## Impostazione
In `Impostazioni di Gioco` → `Modulo Khuzoe WebP Autoconverter` trovi:
- **Qualità WebP (0-100)**: default 85. Imposta la qualità di compressione usata per creare il WebP.

## Note
- Non modifica i file già presenti nella campagna; agisce solo sui nuovi upload via UI di Foundry.
- Non gestisce GIF animate o SVG.
- La conversione è lato client: eventuali upload fuori da Foundry (copiati a mano nel file system) non vengono convertiti.
