using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using KhuzoeUpdater;

internal static class CoreTests
{
    static int passed;
    static void Assert(bool condition, string description)
    { if (!condition) throw new Exception(description); passed++; Console.WriteLine("OK " + description); }
    static void Reject(Action action, string description)
    {
        try { action(); } catch (Exception ex) { if (!(ex is InvalidDataException || ex is IOException)) throw; Assert(true, description); return; }
        throw new Exception("NON RIFIUTATO: " + description);
    }
    static void Write(string path, string text) { Directory.CreateDirectory(Path.GetDirectoryName(path)); File.WriteAllText(path, text, new UTF8Encoding(false)); }
    static void Manifest(string modules, string id, string version)
    { Write(Path.Combine(modules, id, "module.json"), "{\"id\":\"" + id + "\",\"version\":\"" + version + "\"}"); }
    static Release Release(string id, string version)
    {
        return new Release { id = id, title = id, version = version, compatibility = new Dictionary<string, object> { { "minimum", "14" }, { "maximum", "14" } },
            download = "https://github.com/Khuzoe/khuzoe-modules/releases/download/" + id + "-v" + version + "/module.zip", size = 100, sha256 = new string('a', 64) };
    }
    static Catalog Catalog(params Release[] modules) { return new Catalog { schemaVersion = 1, repository = "Khuzoe/khuzoe-modules", modules = modules.ToList() }; }
    static void Zip(string path, params string[] entries)
    {
        using (var file = File.Create(path))
        using (var zip = new ZipArchive(file, ZipArchiveMode.Create))
            for (int i = 0; i < entries.Length; i += 2)
                using (var writer = new StreamWriter(zip.CreateEntry(entries[i]).Open())) writer.Write(entries[i + 1]);
    }
    static void VerifyPackages(string catalogPath, string root)
    {
        var catalog = Json.FileRead<Catalog>(catalogPath);
        Network.Validate(catalog);
        string output = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(catalogPath), "..", "packages"));
        foreach (var release in catalog.modules)
        {
            string package = Path.Combine(output, release.id, "module.zip");
            Assert(new FileInfo(package).Length == release.size && Network.Hash(package) == release.sha256, "dimensione e integrità " + release.id);
            Installer.Extract(package, Path.Combine(root, "integration", release.id), release);
            Assert(File.Exists(Path.Combine(root, "integration", release.id, "module.json")), "ZIP reale leggibile dall'app: " + release.id);
        }
    }
    public static int Main(string[] args)
    {
        string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".work", "khuzoe-tests-" + Guid.NewGuid().ToString("N")));
        Directory.CreateDirectory(root);
        try
        {
            Assert(Versioning.Compare("0.10.0", "0.9.9") > 0, "confronto numerico delle versioni");
            Assert(Versioning.Compare("14", "14.0") == 0, "versioni equivalenti");
            Assert(!Versioning.Valid("1.0.0-beta"), "nessuna distribuzione accidentale di prerelease");
            Assert(Versioning.Compatible("14.367", new Dictionary<string, object> { { "maximum", "14" } }), "limite Foundry per generazione");
            Assert(!Versioning.Compatible("15.1", new Dictionary<string, object> { { "maximum", "14" } }), "generazione non compatibile bloccata");
            string modules = Path.Combine(root, "Foundry", "Data", "modules");
            Manifest(modules, "khuzoe-merchant", "1.0.0");
            Manifest(modules, "foreign-module", "9.0.0");
            string foreign = Path.Combine(modules, "foreign-module", "module.json");
            string foreignBefore = File.ReadAllText(foreign);
            string selected = Path.Combine(root, "Foundry");
            Write(Path.Combine(selected, "App", "resources", "app", "package.json"), "{\"name\":\"foundryvtt\",\"release\":{\"generation\":14,\"build\":367}}");
            var install = Paths.Find(selected).Single();
            Assert(install.ModulesPath == modules && install.FoundryVersion == "14.367", "cartella Foundry e versione individuate");
            Assert(Paths.Find(Path.Combine(selected, "Data")).Count == 1, "selezione diretta cartella dati");
            Manifest(Path.Combine(selected, "Data", "Data", "modules"), "khuzoe-calendar", "1.0.0");
            Assert(Paths.Find(selected).Count == 2, "cartelle multiple lasciate alla scelta esplicita");
            var plan = Planner.Scan(install, Catalog(Release("khuzoe-merchant", "1.1.0"), Release("khuzoe-calendar", "1.0.0")));
            Assert(plan.Count == 1 && plan[0].CanUpdate, "solo moduli autorizzati già installati");
            Assert(!Planner.Scan(install, Catalog(Release("khuzoe-merchant", "0.9.0")))[0].CanUpdate, "versione locale più recente conservata");
            Write(Path.Combine(modules, "khuzoe-merchant", "khuzoe-merchant.lock"), "locked");
            Assert(!Planner.Scan(install, Catalog(Release("khuzoe-merchant", "1.1.0")))[0].CanUpdate, "blocco aggiornamento Foundry rispettato");
            File.Delete(Path.Combine(modules, "khuzoe-merchant", "khuzoe-merchant.lock"));
            var unknown = new Installation { ModulesPath = modules, SelectedPath = selected };
            Assert(!Planner.Scan(unknown, Catalog(Release("khuzoe-merchant", "1.1.0")))[0].CanUpdate, "Foundry non riconosciuto non aggiornato alla cieca");
            Manifest(modules, "khuzoe-calendar", "1.0.0");
            Manifest(modules, "cripta-wiki-sync", "1.0.0");
            var calendar = Release("khuzoe-calendar", "1.1.0");
            calendar.relationships = Json.Read<Dictionary<string, object>>("{\"requires\":[{\"id\":\"cripta-wiki-sync\",\"compatibility\":{\"minimum\":\"1.1.0\"}}]}");
            Assert(Planner.Scan(install, Catalog(calendar, Release("cripta-wiki-sync", "1.1.0"))).All(r => r.CanUpdate), "dipendenze coordinate pianificate insieme");
            Assert(!Planner.Scan(install, Catalog(calendar))[0].CanUpdate, "dipendenza insufficiente segnalata");
            Network.Validate(Catalog(Release("khuzoe-merchant", "1.1.0")));
            Assert(true, "catalogo del repository previsto accettato");
            Reject(() => Network.Validate(Catalog(Release("foreign-module", "1.0.0"))), "modulo estraneo rifiutato dal catalogo");
            Reject(() => Network.Validate(Catalog(Release("khuzoe-merchant", "1.0.0"), Release("khuzoe-merchant", "1.1.0"))), "catalogo duplicato rifiutato");
            var external = Release("khuzoe-merchant", "1.1.0"); external.download = "https://example.com/evil.zip";
            Reject(() => Network.Validate(Catalog(external)), "download fuori repository rifiutato");
            string malicious = Path.Combine(root, "malicious.zip"); Zip(malicious, "../foreign-module/module.json", "bad");
            Reject(() => Installer.Extract(malicious, Path.Combine(root, "malicious"), Release("khuzoe-merchant", "1.1.0")), "ZIP con percorso esterno rifiutato");
            string duplicate = Path.Combine(root, "duplicate.zip"); Zip(duplicate, "scripts/a.js", "a", "scripts/A.js", "b");
            Reject(() => Installer.Extract(duplicate, Path.Combine(root, "duplicate"), Release("khuzoe-merchant", "1.1.0")), "collisione maiuscole Windows rifiutata");
            string wrong = Path.Combine(root, "wrong.zip"); Zip(wrong, "module.json", "{\"id\":\"foreign-module\",\"version\":\"1.1.0\"}");
            Reject(() => Installer.Extract(wrong, Path.Combine(root, "wrong"), Release("khuzoe-merchant", "1.1.0")), "identità pacchetto errata rifiutata");
            string valid = Path.Combine(root, "valid.zip"); Zip(valid, "module.json", "{\"id\":\"khuzoe-merchant\",\"version\":\"1.1.0\"}", "scripts/new.js", "new");
            string staged = Path.Combine(root, "staged");
            Installer.Extract(valid, staged, plan[0].Release);
            Write(Path.Combine(modules, "khuzoe-merchant", "obsolete.js"), "obsolete");
            Installer.Replace(modules, staged, plan[0]);
            Assert(File.Exists(Path.Combine(modules, "khuzoe-merchant", "scripts", "new.js")), "nuovo contenuto installato");
            Assert(!File.Exists(Path.Combine(modules, "khuzoe-merchant", "obsolete.js")), "file obsoleto rimosso solo nel modulo aggiornato");
            Assert(File.ReadAllText(foreign) == foreignBefore, "moduli estranei intatti");
            Reject(() => Installer.Replace(modules, staged, plan[0]), "modulo cambiato dopo scansione non sovrascritto");
            string settings = Path.Combine(root, "settings", "settings.json");
            Settings.Save(new Preferences { ModulesPath = modules, SelectedPath = selected }, settings);
            Settings.Save(new Preferences { ModulesPath = modules, SelectedPath = selected }, settings);
            Assert(Json.FileRead<Preferences>(settings).ModulesPath == modules, "cartella memorizzata e risalvata");
            Assert(Network.Hash(valid).Length == 64, "impronta SHA-256 disponibile");
            if (args.Length == 1) VerifyPackages(args[0], root);
            Console.WriteLine("PASS: " + passed + " controlli, solo cartelle temporanee.");
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
        finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }
}
