using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace KhuzoeUpdater
{
    public static class DesktopApplications
    {
        public static string EntryPoint(Release release)
        {
            if (release.id != "khuzoe-assets-manager") throw new InvalidDataException("Applicazione non riconosciuta.");
            return "KhuzoeAssetsManager.exe";
        }
        public static void ValidateLocal(string directory, Release release, string version)
        {
            var manifest = Json.FileRead<Dictionary<string, object>>(Paths.Child(directory, "application.json"));
            string exe = Paths.Child(directory, EntryPoint(release));
            if (Json.Str(manifest, "id") != release.id || Json.Str(manifest, "version") != version || Json.Str(manifest, "entryPoint") != EntryPoint(release)
                || !File.Exists(exe) || !File.Exists(exe + ".config") || Versioning.Compare(FileVersionInfo.GetVersionInfo(exe).FileVersion, version) != 0)
                throw new InvalidDataException("L'app locale è incompleta o non corrisponde alla versione indicata.");
        }
        public static void ValidatePackage(string directory, Release release)
        {
            ValidateLocal(directory, release, release.version);
            string runtime = Paths.Child(directory, "scene-reader");
            var files = Json.FileRead<Dictionary<string, string>>(Paths.Child(runtime, "integrity.json"));
            if (files == null || !files.ContainsKey("reader.cjs") || !files.Keys.Any(key => key.EndsWith(".node", StringComparison.OrdinalIgnoreCase)))
                throw new InvalidDataException("Il pacchetto non contiene il lettore scene completo.");
            foreach (var item in files)
                if (!Regex.IsMatch(item.Value ?? "", "^[a-fA-F0-9]{64}$") || !String.Equals(Network.Hash(Paths.Child(runtime, item.Key)), item.Value, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Un file del lettore scene non supera il controllo di integrità.");
        }
        public static void EnsureClosed(ModuleStatus row)
        {
            if (!row.IsInstalled) return;
            string target = Paths.Child(row.DirectoryPath, EntryPoint(row.Release));
            foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(target)))
                using (process)
                {
                    try
                    {
                        if (!process.HasExited && String.Equals(Paths.Full(process.MainModule.FileName), target, StringComparison.OrdinalIgnoreCase))
                            throw new IOException("Chiudi " + row.Release.title + " prima di aggiornarlo.");
                    }
                    catch (Win32Exception) { throw new IOException("Non riesco a verificare se " + row.Release.title + " è chiuso. Chiudilo e riprova."); }
                    catch (InvalidOperationException) { /* The process exited during inspection. */ }
                }
        }
        public static ProcessStartInfo LaunchInfo(Installation install, ModuleStatus row)
        {
            if (!row.Release.IsApplication || !row.IsInstalled || row.Status == "Errore") throw new IOException("Installa prima l'app dal catalogo.");
            string directory = Paths.Child(Installer.RootFor(install, row.Release), row.Release.id);
            ValidateLocal(directory, row.Release, row.LocalVersion);
            string dataRoot = Path.GetDirectoryName(Paths.Full(install.ModulesPath));
            if (dataRoot.IndexOf('"') >= 0) throw new IOException("Percorso Foundry non valido.");
            return new ProcessStartInfo { FileName = Paths.Child(directory, EntryPoint(row.Release)), WorkingDirectory = directory,
                Arguments = "--foundry-data \"" + dataRoot + "\"", UseShellExecute = false };
        }
        public static void Open(Installation install, ModuleStatus row)
        { using (var process = Process.Start(LaunchInfo(install, row))) { } }
    }
}
