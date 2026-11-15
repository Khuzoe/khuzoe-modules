using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    internal sealed class WallReviewForm : Form
    {
        readonly SceneCanvas canvas = new SceneCanvas();
        readonly SceneDraft draft;
        readonly PropertyGrid properties = new PropertyGrid();
        readonly Label info = Theme.Label("", 9F, Theme.Muted, FontStyle.Regular);
        public List<SceneWall> AcceptedWalls { get; private set; }
        internal SceneCanvas Canvas { get { return canvas; } }
        internal SceneDraft Draft { get { return draft; } }
        public WallReviewForm(SceneDetail source, string levelId, SceneImageSet images, WallJob job, SceneViewSettings settings)
        {
            Text = "Controlla i muri suggeriti — bozza locale"; StartPosition = FormStartPosition.CenterParent; Size = new Size(1200, 820); MinimumSize = new Size(880, 580); BackColor = Theme.Background; ForeColor = Theme.Text;
            var scene = SceneDraft.Copy(source); var suggestions = SceneWallAnalysis.Walls(job, levelId); scene.Walls = suggestions; scene.Lights.Clear();
            var uncertain = new HashSet<string>(suggestions.Where(w => w.SuggestedUncertain).Select(w => w.Id));
            draft = new SceneDraft(scene); canvas.Draft = draft; canvas.Editing = true; canvas.SnapToGrid = false; canvas.UncertainWalls = uncertain;
            canvas.ReferenceWalls = source.Walls; canvas.Settings = new SceneViewSettings { Walls = true, Lights = false, Indicators = true, Grid = false, Tiles = settings.Tiles, Foreground = settings.Foreground, Hidden = settings.Hidden };
            canvas.SetScene(draft.Scene, draft.Scene.Levels.First(l => l.Id == levelId), images, true);
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 4, ColumnCount = 1, Padding = new Padding(12) };
            foreach (var style in new[] { new RowStyle(SizeType.Absolute, 40), new RowStyle(SizeType.Percent, 100), new RowStyle(SizeType.Absolute, 39), new RowStyle(SizeType.Absolute, 43) }) layout.RowStyles.Add(style);
            var bar = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, AutoScroll = true };
            Action<string, Action> button = (label, action) => { var b = new WebButton { Text = label, AutoSize = true, Height = 31, Margin = new Padding(0, 2, 5, 0) }; b.Click += (s, e) => action(); bar.Controls.Add(b); };
            button("Seleziona", () => SetTool(SceneEditTool.Select)); button("Sposta vista", () => SetTool(SceneEditTool.Pan)); button("Muro", () => SetTool(SceneEditTool.Wall));
            button("Annulla", () => draft.Undo()); button("Ripeti", () => draft.Redo()); button("Elimina", () => draft.DeleteSelection()); button("Adatta", () => canvas.Fit());
            var original = new CheckBox { Text = "Muri esistenti in grigio", Checked = true, ForeColor = Theme.Muted, AutoSize = true, Margin = new Padding(8, 7, 0, 0) }; original.CheckedChanged += (s, e) => { canvas.ReferenceWalls = original.Checked ? source.Walls : null; canvas.Invalidate(); }; bar.Controls.Add(original); layout.Controls.Add(bar, 0, 0);
            var content = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty }; content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); content.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 240));
            content.Controls.Add(canvas, 0, 0); properties.Dock = DockStyle.Fill; properties.ToolbarVisible = properties.HelpVisible = false; properties.ViewBackColor = Theme.Surface; properties.ViewForeColor = Theme.Text; properties.LineColor = Theme.Border; content.Controls.Add(properties, 1, 0); layout.Controls.Add(content, 0, 1);
            layout.Controls.Add(info, 0, 2);
            var bottom = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false };
            var accept = new WebButton { Text = "Aggiungi alla bozza", Width = 172, Height = 33, Primary = true }; accept.Click += (s, e) => { canvas.CancelEditorGesture(); AcceptedWalls = draft.Scene.Walls.Select(w => Json.Read<SceneWall>(Json.Write(w))).ToList(); DialogResult = DialogResult.OK; Close(); };
            var cancel = new WebButton { Text = "Torna all’analisi", Width = 150, Height = 33 }; cancel.Click += (s, e) => { DialogResult = DialogResult.Cancel; Close(); }; bottom.Controls.Add(accept); bottom.Controls.Add(cancel); layout.Controls.Add(bottom, 0, 3); Controls.Add(layout);
            draft.Changed += (s, e) => { canvas.SetScene(draft.Scene, draft.Scene.Levels.First(l => l.Id == levelId), images, false); UpdateInfo(); properties.Refresh(); };
            draft.SelectionChanged += (s, e) => { SelectWall(); canvas.Invalidate(); };
            Shown += (s, e) => canvas.Fit(); UpdateInfo();
        }
        void SetTool(SceneEditTool tool) { canvas.CancelEditorGesture(); canvas.Tool = tool; }
        void SelectWall() { properties.SelectedObject = draft.Wall == null ? null : new WallProperties(draft); }
        void UpdateInfo() { info.Text = draft.Scene.Walls.Count + " segmenti suggeriti. Arancio: da verificare. Trascina gli estremi, elimina o aggiungi muri. Zoom con la rotella. Le modifiche restano in questa anteprima fino alla conferma."; }
    }
}
