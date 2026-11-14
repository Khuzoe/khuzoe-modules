using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace KhuzoeAssetsManager
{
    public enum SceneEditTool { Select, Pan, Wall, Light }
    public enum SceneSelectionKind { None, Wall, Light, Image, Map }
    public sealed class SceneSelection
    {
        public SceneSelectionKind Kind; public string Id;
        public SceneSelection(SceneSelectionKind kind, string id) { Kind = kind; Id = id; }
    }
    public sealed class SceneDraft
    {
        sealed class Step { public string Before, After, Name; }
        readonly List<Step> undo = new List<Step>(), redo = new List<Step>();
        readonly string original;
        public SceneDetail Scene { get; private set; }
        public SceneSelection Selection { get; private set; }
        public bool IsDirty { get; private set; }
        public bool CanUndo { get { return undo.Count > 0; } }
        public bool CanRedo { get { return redo.Count > 0; } }
        public string OriginalHash { get; private set; }
        public event EventHandler Changed, SelectionChanged;
        public SceneDraft(SceneDetail scene)
        {
            original = Json.Write(scene); OriginalHash = Digest(original); Scene = Copy(scene); Selection = new SceneSelection(SceneSelectionKind.None, null);
        }
        public static string Digest(string text) { using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant(); }
        public static SceneDetail Copy(SceneDetail scene) { return Json.Read<SceneDetail>(Json.Write(scene)); }
        public string Snapshot() { return Json.Write(Scene); }
        public void Select(SceneSelectionKind kind, string id)
        { Selection = new SceneSelection(kind, id); if (SelectionChanged != null) SelectionChanged(this, EventArgs.Empty); }
        public SceneWall Wall { get { return Scene.Walls.FirstOrDefault(value => Selection.Kind == SceneSelectionKind.Wall && value.Id == Selection.Id); } }
        public SceneLight Light { get { return Scene.Lights.FirstOrDefault(value => Selection.Kind == SceneSelectionKind.Light && value.Id == Selection.Id); } }
        public SceneTile Image { get { return Scene.Tiles.FirstOrDefault(value => Selection.Kind == SceneSelectionKind.Image && value.Id == Selection.Id); } }
        public void Apply(string name, Action action)
        {
            string before = Snapshot();
            try { action(); Commit(before, name); } catch { Scene = Json.Read<SceneDetail>(before); throw; }
        }
        public void Commit(string before, string name)
        {
            string after = Snapshot(); if (before == after) return;
            undo.Add(new Step { Before = before, After = after, Name = name }); redo.Clear();
            while (undo.Count > 30 || (undo.Count > 1 && undo.Sum(step => (long)step.Before.Length + step.After.Length) > 10 * 1024 * 1024)) undo.RemoveAt(0);
            Notify();
        }
        public void Cancel(string before) { Scene = Json.Read<SceneDetail>(before); Notify(); }
        public void Undo() { if (!CanUndo) return; var step = undo[undo.Count - 1]; undo.RemoveAt(undo.Count - 1); redo.Add(step); Scene = Json.Read<SceneDetail>(step.Before); Notify(); }
        public void Redo() { if (!CanRedo) return; var step = redo[redo.Count - 1]; redo.RemoveAt(redo.Count - 1); undo.Add(step); Scene = Json.Read<SceneDetail>(step.After); Notify(); }
        void Notify()
        {
            IsDirty = Snapshot() != original;
            if (Selection.Kind != SceneSelectionKind.None && Selection.Kind != SceneSelectionKind.Map && Wall == null && Light == null && Image == null) Select(SceneSelectionKind.None, null);
            if (Changed != null) Changed(this, EventArgs.Empty);
        }
        public void Reset() { Apply("Ripristina scena", () => Scene = Json.Read<SceneDetail>(original)); Select(SceneSelectionKind.None, null); }
        public void Restore(SceneDetail saved) { Scene = Copy(saved); IsDirty = Snapshot() != original; }
        public static string NewId() { return Guid.NewGuid().ToString("N").Substring(0, 16); }
        public SceneWall AddWall(PointF a, PointF b, string level)
        {
            var wall = new SceneWall { Id = NewId(), X1 = a.X, Y1 = a.Y, X2 = b.X, Y2 = b.Y, Light = 20, Sight = 20, Move = 20, Sound = 20, Levels = new[] { level } };
            Apply("Nuovo muro", () => Scene.Walls.Add(wall)); Select(SceneSelectionKind.Wall, wall.Id); return wall;
        }
        public SceneLight AddLight(PointF point, string level)
        {
            var light = new SceneLight { Id = NewId(), Name = "Nuova luce", X = point.X, Y = point.Y, Bright = Scene.GridDistance * 2, Dim = Scene.GridDistance * 4, Color = "#ffcc77", Alpha = 0.5, Angle = 360, Luminosity = 0.5, Walls = true, Levels = new[] { level } };
            Apply("Nuova luce", () => Scene.Lights.Add(light)); Select(SceneSelectionKind.Light, light.Id); return light;
        }
        public SceneTile AddImage(string file, Size size, PointF point, string level)
        {
            string alias = "khuzoe-local/" + NewId(); double width = Math.Min(700, Scene.Width * 0.35);
            var tile = new SceneTile { Id = NewId(), X = point.X, Y = point.Y, Width = width, Height = width * size.Height / Math.Max(1, size.Width), Rotation = 0, Alpha = 1, Tint = "#ffffff", Src = alias, Textures = new SceneTexture(), Levels = new[] { level }, Sort = Scene.Tiles.Count == 0 ? 0 : Scene.Tiles.Max(value => value.Sort) + 1 };
            Apply("Nuova immagine", () => { Scene.LocalAssets[alias] = Path.GetFullPath(file); Scene.Tiles.Add(tile); }); Select(SceneSelectionKind.Image, tile.Id); return tile;
        }
        public void ChangeMap(string file, string levelId)
        {
            string alias = "khuzoe-local/" + NewId();
            Apply("Cambia mappa", () => { Scene.LocalAssets[alias] = Path.GetFullPath(file); Scene.Levels.First(value => value.Id == levelId).Background = alias; }); Select(SceneSelectionKind.Map, levelId);
        }
        public void DeleteSelection()
        {
            var selected = Selection;
            if (selected.Kind == SceneSelectionKind.None || selected.Kind == SceneSelectionKind.Map) return;
            Apply("Elimina elemento", () => { Scene.Walls.RemoveAll(value => selected.Kind == SceneSelectionKind.Wall && value.Id == selected.Id); Scene.Lights.RemoveAll(value => selected.Kind == SceneSelectionKind.Light && value.Id == selected.Id); Scene.Tiles.RemoveAll(value => selected.Kind == SceneSelectionKind.Image && value.Id == selected.Id); }); Select(SceneSelectionKind.None, null);
        }
        public void DuplicateSelection()
        {
            double step = Math.Max(10, Scene.GridSize / 2); string id = NewId(); var selected = Selection;
            if (Wall != null) { var copy = Json.Read<SceneWall>(Json.Write(Wall)); copy.Id = id; copy.X1 += step; copy.X2 += step; copy.Y1 += step; copy.Y2 += step; Apply("Duplica muro", () => Scene.Walls.Add(copy)); }
            else if (Light != null) { var copy = Json.Read<SceneLight>(Json.Write(Light)); copy.Id = id; copy.X += step; copy.Y += step; Apply("Duplica luce", () => Scene.Lights.Add(copy)); }
            else if (Image != null) { var copy = Json.Read<SceneTile>(Json.Write(Image)); copy.Id = id; copy.X += step; copy.Y += step; copy.Sort++; Apply("Duplica immagine", () => Scene.Tiles.Add(copy)); }
            else return;
            Select(selected.Kind, id);
        }
        public static double Number(double value, double minimum, double maximum)
        { if (Double.IsNaN(value) || Double.IsInfinity(value) || value < minimum || value > maximum) throw new ArgumentException("Inserisci un numero compreso tra " + minimum + " e " + maximum + "."); return value; }
    }
    public sealed class SceneDraftRecord
    {
        public int Schema { get; set; } public string OriginalHash { get; set; } public SceneDetail Scene { get; set; }
    }
    public sealed class SceneDraftStore
    {
        readonly string directory;
        public SceneDraftStore(AppStorage storage) { directory = Path.Combine(storage.Root, "scene-drafts"); }
        string FileName(string key) { return Path.Combine(directory, SceneDraft.Digest(key) + ".json"); }
        public bool Load(string key, SceneDraft draft)
        {
            string file = FileName(key); FoundryPaths.NoLinks(file); if (!File.Exists(file)) return true;
            if (new FileInfo(file).Length > 8 * 1024 * 1024) return false;
            var saved = Json.Read<SceneDraftRecord>(File.ReadAllText(file, Encoding.UTF8));
            if (saved == null || saved.Schema != 1 || saved.OriginalHash != draft.OriginalHash || saved.Scene == null || saved.Scene.Id != draft.Scene.Id || saved.Scene.Levels == null || saved.Scene.Levels.Count == 0 || saved.Scene.Walls == null || saved.Scene.Lights == null || saved.Scene.Tiles == null || saved.Scene.LocalAssets == null) return false;
            draft.Restore(saved.Scene); return true;
        }
        public void Save(string key, SceneDraft draft)
        {
            string file = FileName(key); FoundryPaths.NoLinks(file);
            if (!draft.IsDirty) { if (File.Exists(file)) File.Delete(file); return; }
            Json.Save(file, new SceneDraftRecord { Schema = 1, OriginalHash = draft.OriginalHash, Scene = draft.Scene });
        }
    }
}
