using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;

namespace KhuzoeAssetsManager
{
    public sealed class SceneViewSettings
    {
        public bool Walls { get; set; }
        public bool Lights { get; set; }
        public bool Indicators { get; set; }
        public bool Grid { get; set; }
        public bool Tiles { get; set; }
        public bool Foreground { get; set; }
        public bool Hidden { get; set; }
        public SceneViewSettings() { Walls = Lights = Indicators = Tiles = Foreground = Hidden = true; }
    }
    public sealed class FoundryWorld
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public string Directory { get; set; }
        public override string ToString() { return Name; }
    }
    public class SceneSummary
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public double Width { get; set; }
        public double Height { get; set; }
        public int WallsCount { get; set; }
        public int LightsCount { get; set; }
        public int LevelsCount { get; set; }
        public bool Active { get; set; }
        public double ModifiedAt { get; set; }
        public string Details { get { return WallsCount + " muri  ·  " + LightsCount + " luci" + (LevelsCount > 1 ? "  ·  " + LevelsCount + " livelli" : ""); } }
        public override string ToString() { return Name; }
    }
    public sealed class SceneCatalog
    {
        public int Schema { get; set; }
        public string WorldId { get; set; }
        public DateTime CapturedAt { get; set; }
        public List<SceneSummary> Scenes { get; set; }
        public SceneCatalog() { Scenes = new List<SceneSummary>(); }
    }
    public sealed class SceneTexture
    {
        public double AnchorX { get; set; }
        public double AnchorY { get; set; }
        public double OffsetX { get; set; }
        public double OffsetY { get; set; }
        public double ScaleX { get; set; }
        public double ScaleY { get; set; }
        public double Rotation { get; set; }
        public string Fit { get; set; }
        public SceneTexture() { AnchorX = AnchorY = 0.5; ScaleX = ScaleY = 1; Fit = "fill"; }
    }
    public sealed class SceneLevel
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public double Sort { get; set; }
        public string Background { get; set; }
        public string Foreground { get; set; }
        public string BackgroundColor { get; set; }
        public string BackgroundTint { get; set; }
        public string ForegroundTint { get; set; }
        public SceneTexture Textures { get; set; }
        public SceneLevel() { Textures = new SceneTexture(); }
        public override string ToString() { return Name; }
    }
    public sealed class SceneWall
    {
        public string Id { get; set; }
        public double X1 { get; set; }
        public double Y1 { get; set; }
        public double X2 { get; set; }
        public double Y2 { get; set; }
        public int Door { get; set; }
        public int DoorState { get; set; }
        public int Direction { get; set; }
        public int Light { get; set; }
        public int Sight { get; set; }
        public int Move { get; set; }
        public int Sound { get; set; }
        public string[] Levels { get; set; }
    }
    public sealed class SceneLight
    {
        public string Id { get; set; }
        public string Name { get; set; }
        public double X { get; set; }
        public double Y { get; set; }
        public bool Hidden { get; set; }
        public double Rotation { get; set; }
        public string[] Levels { get; set; }
        public bool Walls { get; set; }
        public double Bright { get; set; }
        public double Dim { get; set; }
        public double Angle { get; set; }
        public double Alpha { get; set; }
        public double Luminosity { get; set; }
        public string Color { get; set; }
        public string Animation { get; set; }
    }
    public sealed class SceneTile
    {
        public string Id { get; set; }
        public double X { get; set; }
        public double Y { get; set; }
        public double Width { get; set; }
        public double Height { get; set; }
        public double Rotation { get; set; }
        public double Sort { get; set; }
        public double Elevation { get; set; }
        public bool Hidden { get; set; }
        public string[] Levels { get; set; }
        public string Src { get; set; }
        public string Tint { get; set; }
        public double Alpha { get; set; }
        public SceneTexture Textures { get; set; }
    }
    public sealed class SceneDetail : SceneSummary
    {
        public int Schema { get; set; }
        public string InitialLevel { get; set; }
        public double Padding { get; set; }
        public double ShiftX { get; set; }
        public double ShiftY { get; set; }
        public int GridType { get; set; }
        public double GridSize { get; set; }
        public double GridDistance { get; set; }
        public string GridUnits { get; set; }
        public double Darkness { get; set; }
        public List<SceneLevel> Levels { get; set; }
        public List<SceneWall> Walls { get; set; }
        public List<SceneLight> Lights { get; set; }
        public List<SceneTile> Tiles { get; set; }
        public List<string> Warnings { get; set; }
        public Dictionary<string, string> LocalAssets { get; set; }
        public SceneDetail() { Levels = new List<SceneLevel>(); Walls = new List<SceneWall>(); Lights = new List<SceneLight>(); Tiles = new List<SceneTile>(); Warnings = new List<string>(); LocalAssets = new Dictionary<string, string>(); }
        public static bool Included(string[] levels, string current) { return levels == null || levels.Length == 0 || levels.Contains(current); }
    }
    public sealed class SceneLayout
    {
        public double Width, Height, MapX, MapY, MapWidth, MapHeight;
        public static SceneLayout From(SceneDetail scene)
        {
            double cell = Math.Max(1, scene.GridSize), padding = Math.Max(0, Math.Min(0.5, scene.Padding));
            double strideX = cell, strideY = cell;
            bool hex = scene.GridType >= 2, columns = scene.GridType >= 4;
            double hexWidth = columns ? 2 * cell / Math.Sqrt(3) : cell;
            double hexHeight = columns ? cell : 2 * cell / Math.Sqrt(3);
            if (hex) { strideX = columns ? hexWidth * 0.75 : hexWidth; strideY = columns ? hexHeight : hexHeight * 0.75; }
            double padX = Math.Ceiling(padding * scene.Width * (1 / strideX)) * strideX;
            double padY = Math.Ceiling(padding * scene.Height * (1 / strideY)) * strideY;
            double width = scene.Width + 2 * padX, height = scene.Height + 2 * padY;
            if (hex && padding > 0)
            {
                width = scene.Width + 2 * Round(padX); height = scene.Height + 2 * Round(padY);
                if (((int)Round(columns ? padX / strideX : padY / strideY) & 1) != 0)
                { if (columns) { padY += hexHeight / 2; height += hexHeight; } else { padX += hexWidth / 2; width += hexWidth; } }
                width = Round(width * (1 / strideX)) * strideX; height = Round(height * (1 / strideY)) * strideY;
                if (columns) width += hexWidth / 4; else height += hexHeight / 4;
            }
            return new SceneLayout { Width = width, Height = height, MapX = padX - scene.ShiftX, MapY = padY - scene.ShiftY, MapWidth = scene.Width, MapHeight = scene.Height };
        }
        static double Round(double number) { return Math.Floor(number + 0.5); }
    }
    public sealed class SceneImageSet : IDisposable
    {
        public Image Background { get; set; }
        public Image Foreground { get; set; }
        public Dictionary<string, Image> Tiles { get; private set; }
        public List<string> Warnings { get; private set; }
        public SceneImageSet() { Tiles = new Dictionary<string, Image>(); Warnings = new List<string>(); }
        public void Dispose() { if (Background != null) Background.Dispose(); if (Foreground != null) Foreground.Dispose(); foreach (var image in Tiles.Values) image.Dispose(); Tiles.Clear(); }
    }
}
