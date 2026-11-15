using System;
using System.ComponentModel;
using System.Drawing;
using System.Linq;

namespace KhuzoeAssetsManager
{
    public enum EditorDoor { Muro = 0, Porta = 1, Segreta = 2 }
    public enum EditorDoorState { Chiusa = 0, Aperta = 1, Bloccata = 2 }
    public abstract class SceneProperties
    {
        protected readonly SceneDraft Draft;
        protected SceneProperties(SceneDraft draft) { Draft = draft; }
        protected void Set(Action change) { Draft.Apply("Modifica proprietà", change); }
        protected double Position(double value) { return SceneDraft.Number(value, -1000000, 1000000); }
        protected double Positive(double value) { return SceneDraft.Number(value, 1, 1000000); }
        protected static string Hex(Color color) { return "#" + color.R.ToString("x2") + color.G.ToString("x2") + color.B.ToString("x2"); }
    }
    public sealed class WallProperties : SceneProperties
    {
        public WallProperties(SceneDraft draft) : base(draft) { }
        SceneWall Wall { get { return Draft.Wall; } }
        [Category("Estremità A"), DisplayName("X")] public double X1 { get { return Wall.X1; } set { double n = Position(value); Set(() => Wall.X1 = n); } }
        [Category("Estremità A"), DisplayName("Y")] public double Y1 { get { return Wall.Y1; } set { double n = Position(value); Set(() => Wall.Y1 = n); } }
        [Category("Estremità B"), DisplayName("X")] public double X2 { get { return Wall.X2; } set { double n = Position(value); Set(() => Wall.X2 = n); } }
        [Category("Estremità B"), DisplayName("Y")] public double Y2 { get { return Wall.Y2; } set { double n = Position(value); Set(() => Wall.Y2 = n); } }
        [Category("Muro e porta"), DisplayName("Tipo")] public EditorDoor Door { get { return (EditorDoor)Wall.Door; } set { Set(() => Wall.Door = (int)value); } }
        [Category("Muro e porta"), DisplayName("Stato porta")] public EditorDoorState DoorState { get { return (EditorDoorState)Wall.DoorState; } set { Set(() => Wall.DoorState = (int)value); } }
        [Category("Muro e porta"), DisplayName("Blocca vista")] public bool Sight { get { return Wall.Sight != 0; } set { Set(() => Wall.Sight = value ? 20 : 0); } }
        [Category("Muro e porta"), DisplayName("Blocca movimento")] public bool Move { get { return Wall.Move != 0; } set { Set(() => Wall.Move = value ? 20 : 0); } }
        [Category("Muro e porta"), DisplayName("Blocca luce")] public bool Light { get { return Wall.Light != 0; } set { Set(() => Wall.Light = value ? 20 : 0); } }
    }
    public sealed class LightProperties : SceneProperties
    {
        public LightProperties(SceneDraft draft) : base(draft) { }
        SceneLight Light { get { return Draft.Light; } }
        [Category("Luce"), DisplayName("Nome")] public string Name { get { return Light.Name; } set { if ((value ?? "").Length > 160) throw new ArgumentException("Nome troppo lungo."); Set(() => Light.Name = value ?? ""); } }
        [Category("Posizione"), DisplayName("X")] public double X { get { return Light.X; } set { double n = Position(value); Set(() => Light.X = n); } }
        [Category("Posizione"), DisplayName("Y")] public double Y { get { return Light.Y; } set { double n = Position(value); Set(() => Light.Y = n); } }
        [Category("Luce"), DisplayName("Raggio intenso"), Description("Distanza nelle unità della scena.")] public double Bright { get { return Light.Bright; } set { double n = SceneDraft.Number(value, 0, 100000); Set(() => Light.Bright = n); } }
        [Category("Luce"), DisplayName("Raggio tenue")] public double Dim { get { return Light.Dim; } set { double n = SceneDraft.Number(value, 0, 100000); Set(() => Light.Dim = n); } }
        [Category("Luce"), DisplayName("Colore")] public Color Color { get { return SceneCanvas.ParseColor(Light.Color, System.Drawing.Color.Gold); } set { Set(() => Light.Color = Hex(value)); } }
        [Category("Luce"), DisplayName("Angolo")] public double Angle { get { return Light.Angle; } set { double n = SceneDraft.Number(value, 0, 360); Set(() => Light.Angle = n); } }
        [Category("Luce"), DisplayName("Rotazione")] public double Rotation { get { return Light.Rotation; } set { double n = SceneDraft.Number(value, -360, 360); Set(() => Light.Rotation = n); } }
        [Category("Luce"), DisplayName("Disattivata")] public bool Hidden { get { return Light.Hidden; } set { Set(() => Light.Hidden = value); } }
    }
    public sealed class ImageProperties : SceneProperties
    {
        public ImageProperties(SceneDraft draft) : base(draft) { }
        SceneTile Image { get { return Draft.Image; } }
        [Category("Posizione"), DisplayName("X")] public double X { get { return Image.X; } set { double n = Position(value); Set(() => Image.X = n); } }
        [Category("Posizione"), DisplayName("Y")] public double Y { get { return Image.Y; } set { double n = Position(value); Set(() => Image.Y = n); } }
        [Category("Immagine"), DisplayName("Larghezza")] public double Width { get { return Image.Width; } set { double n = Positive(value); Set(() => Image.Width = n); } }
        [Category("Immagine"), DisplayName("Altezza")] public double Height { get { return Image.Height; } set { double n = Positive(value); Set(() => Image.Height = n); } }
        [Category("Immagine"), DisplayName("Rotazione")] public double Rotation { get { return Image.Rotation; } set { double n = SceneDraft.Number(value, -360, 360); Set(() => Image.Rotation = n); } }
        [Category("Immagine"), DisplayName("Opacità")] public double Alpha { get { return Image.Alpha; } set { double n = SceneDraft.Number(value, 0, 1); Set(() => Image.Alpha = n); } }
        [Category("Immagine"), DisplayName("Ordine")] public double Sort { get { return Image.Sort; } set { double n = Position(value); Set(() => Image.Sort = n); } }
        [Category("Immagine"), DisplayName("Nascosta")] public bool Hidden { get { return Image.Hidden; } set { Set(() => Image.Hidden = value); } }
    }
    public sealed class MapProperties : SceneProperties
    {
        readonly string level;
        public MapProperties(SceneDraft draft, string level) : base(draft) { this.level = level; }
        SceneTexture Texture { get { return Draft.Scene.Levels.First(value => value.Id == level).Textures; } }
        [Category("Griglia"), DisplayName("Pixel / cella")] public double GridSize { get { return Draft.Scene.GridSize; } set { double n = SceneDraft.Number(value, 1, 10000); Set(() => Draft.Scene.GridSize = n); } }
        [Category("Griglia"), DisplayName("Distanza / cella")] public double GridDistance { get { return Draft.Scene.GridDistance; } set { double n = SceneDraft.Number(value, .001, 100000); Set(() => Draft.Scene.GridDistance = n); } }
        [Category("Griglia"), DisplayName("Unità")] public string GridUnits { get { return Draft.Scene.GridUnits; } set { if (String.IsNullOrWhiteSpace(value) || value.Length > 24) throw new ArgumentException("Indica un'unità di misura breve."); Set(() => Draft.Scene.GridUnits = value.Trim()); } }
        [Category("Mappa"), DisplayName("Spostamento X")] public double X { get { return Texture.OffsetX; } set { double n = Position(value); Set(() => Texture.OffsetX = n); } }
        [Category("Mappa"), DisplayName("Spostamento Y")] public double Y { get { return Texture.OffsetY; } set { double n = Position(value); Set(() => Texture.OffsetY = n); } }
        [Category("Mappa"), DisplayName("Scala X")] public double ScaleX { get { return Texture.ScaleX; } set { double n = SceneDraft.Number(value, 0.01, 20); Set(() => Texture.ScaleX = n); } }
        [Category("Mappa"), DisplayName("Scala Y")] public double ScaleY { get { return Texture.ScaleY; } set { double n = SceneDraft.Number(value, 0.01, 20); Set(() => Texture.ScaleY = n); } }
        [Category("Mappa"), DisplayName("Rotazione")] public double Rotation { get { return Texture.Rotation; } set { double n = SceneDraft.Number(value, -360, 360); Set(() => Texture.Rotation = n); } }
    }
}
