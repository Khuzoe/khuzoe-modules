using System;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    public sealed class SceneEditorPanel : UserControl
    {
        readonly SceneCanvas canvas;
        readonly PropertyGrid properties = new PropertyGrid();
        readonly Label title = Theme.Label("Seleziona un elemento", 11F, Theme.Gold, FontStyle.Bold);
        readonly Label hint = Theme.Label("Trascina un elemento. Usa il quadratino delle immagini per ridimensionarle.", 8.5F, Theme.Muted, FontStyle.Regular);
        readonly WebButton undo, redo, delete, duplicate;
        readonly ToolTip tips = new ToolTip();
        readonly System.Collections.Generic.Dictionary<SceneEditTool, WebButton> tools = new System.Collections.Generic.Dictionary<SceneEditTool, WebButton>();
        SceneDraft draft;
        bool enabled, inspectorPending;
        SceneDraft inspectorDraft;
        SceneSelectionKind inspectorKind;
        string inspectorId;
        public FlowLayoutPanel Toolbar { get; private set; }
        public event EventHandler Changed, ImportImage, ChangeMap, AnalyzeWalls;
        public SceneEditorPanel(SceneCanvas canvas)
        {
            this.canvas = canvas; Dock = DockStyle.Fill; BackColor = Theme.Surface;
            Toolbar = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, AutoScroll = true, Margin = Padding.Empty, Padding = Padding.Empty };
            ToolButton("Seleziona", SceneEditTool.Select); tools[SceneEditTool.Select].Click += (s, e) => { if (draft != null && draft.Selection.Kind == SceneSelectionKind.Map) draft.Select(SceneSelectionKind.None, null); };
            ToolButton("Sposta vista", SceneEditTool.Pan); ToolButton("Muro", SceneEditTool.Wall); ToolButton("Luce", SceneEditTool.Light);
            ToolButton("Area", SceneEditTool.Area);
            Button("Muri AI", 83, () => { if (AnalyzeWalls != null) AnalyzeWalls(this, EventArgs.Empty); });
            Button("+ Immagine", 104, () => { if (ImportImage != null) ImportImage(this, EventArgs.Empty); });
            Button("Mappa", 72, () => { if (draft != null && canvas.Level != null) { SetTool(SceneEditTool.Select); draft.Select(SceneSelectionKind.Map, canvas.Level.Id); } });
            undo = Button("Annulla", 78, () => { if (draft != null) draft.Undo(); }); redo = Button("Ripeti", 72, () => { if (draft != null) draft.Redo(); });
            var snap = new CheckBox { Text = "Aggancio", AutoSize = true, Checked = true, ForeColor = Theme.Text, Margin = new Padding(8, 8, 4, 0), AccessibleName = "Aggancia alla griglia" };
            snap.CheckedChanged += (s, e) => canvas.SnapToGrid = snap.Checked; canvas.SnapToGrid = true; Toolbar.Controls.Add(snap);
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 5, Padding = new Padding(10, 0, 0, 0), Margin = Padding.Empty };
            foreach (var row in new[] { new RowStyle(SizeType.Absolute, 29), new RowStyle(SizeType.Percent, 100), new RowStyle(SizeType.Absolute, 36), new RowStyle(SizeType.Absolute, 36), new RowStyle(SizeType.Absolute, 65) }) layout.RowStyles.Add(row);
            layout.Controls.Add(title, 0, 0);
            properties.Dock = DockStyle.Fill; properties.ToolbarVisible = false; properties.HelpVisible = false; properties.PropertySort = PropertySort.Categorized;
            properties.BackColor = properties.ViewBackColor = Theme.Surface; properties.ViewForeColor = Theme.Text; properties.LineColor = Theme.Border; properties.CategoryForeColor = Theme.Gold;
            properties.AccessibleName = "Proprietà elemento selezionato"; layout.Controls.Add(properties, 0, 1);
            var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty };
            duplicate = new WebButton { Text = "Duplica", Width = 101, Height = 31, Margin = new Padding(0, 3, 5, 0) }; duplicate.Click += (s, e) => { if (draft != null) draft.DuplicateSelection(); };
            delete = new WebButton { Text = "Elimina", Width = 101, Height = 31, Margin = new Padding(0, 3, 0, 0) }; delete.Click += (s, e) => { properties.SelectedObject = null; if (draft != null) draft.DeleteSelection(); };
            buttons.Controls.Add(duplicate); buttons.Controls.Add(delete); layout.Controls.Add(buttons, 0, 2);
            var replace = new WebButton { Text = "Cambia immagine della mappa", Dock = DockStyle.Fill, Height = 30, Margin = new Padding(0, 3, 0, 0) }; replace.Click += (s, e) => { if (ChangeMap != null) ChangeMap(this, EventArgs.Empty); }; layout.Controls.Add(replace, 0, 3);
            layout.Controls.Add(hint, 0, 4); Controls.Add(layout);
            tips.SetToolTip(undo, "Annulla l'ultima modifica locale (Ctrl+Z sulla mappa)."); tips.SetToolTip(redo, "Ripeti una modifica annullata (Ctrl+Y).");
        }
        WebButton Button(string label, int width, Action action)
        { var button = new WebButton { Text = label, Width = width, Height = 31, Margin = new Padding(1, 2, 3, 0), AccessibleName = label }; button.Click += (s, e) => action(); Toolbar.Controls.Add(button); return button; }
        void ToolButton(string label, SceneEditTool tool) { tools[tool] = Button(label, tool == SceneEditTool.Pan ? 100 : tool == SceneEditTool.Select ? 88 : 65, () => SetTool(tool)); }
        public void SetTool(SceneEditTool tool)
        {
            canvas.CancelEditorGesture(); canvas.Tool = tool;
            foreach (var item in tools) { item.Value.Primary = item.Key == tool; item.Value.Invalidate(); }
            if (tool == SceneEditTool.Area) { hint.Text = "Trascina un rettangolo, anche fuori dalla mappa. Muri AI analizzerà l’area scelta; Esc rimuove la selezione."; return; }
            hint.Text = tool == SceneEditTool.Wall ? "Trascina per disegnare un muro. Maiusc sospende l'aggancio." : tool == SceneEditTool.Light ? "Clicca sulla mappa per aggiungere una luce." : tool == SceneEditTool.Pan ? "Trascina per spostare la vista. Rotella per lo zoom." : "Trascina per spostare. Estremi dei muri e quadratino delle immagini sono modificabili. Spazio trascina la vista.";
        }
        public void Bind(SceneDraft value)
        {
            if (draft != null) { draft.Changed -= DraftChanged; draft.SelectionChanged -= SelectionChanged; }
            draft = value; canvas.Draft = value;
            if (draft != null) { draft.Changed += DraftChanged; draft.SelectionChanged += SelectionChanged; }
            UpdateInspector(); SetTool(SceneEditTool.Select);
        }
        public void SetEditing(bool value) { if (enabled == value && Enabled == value && Toolbar.Enabled == value) return; enabled = value; canvas.Editing = value; Enabled = value; Toolbar.Enabled = value; UpdateInspector(); }
        void SelectionChanged(object sender, EventArgs e) { UpdateInspector(); canvas.Invalidate(); }
        void DraftChanged(object sender, EventArgs e)
        {
            if (Changed != null) Changed(this, EventArgs.Empty);
            if (IsHandleCreated && !IsDisposed && !inspectorPending)
            { inspectorPending = true; BeginInvoke(new Action(() => { inspectorPending = false; if (!IsDisposed) UpdateInspector(); })); }
        }
        void UpdateInspector()
        {
            if (IsDisposed) return;
            if (InvokeRequired) { BeginInvoke(new Action(UpdateInspector)); return; }
            undo.Enabled = enabled && draft != null && draft.CanUndo; redo.Enabled = enabled && draft != null && draft.CanRedo;
            var kind = enabled && draft != null ? draft.Selection.Kind : SceneSelectionKind.None;
            string id = kind == SceneSelectionKind.None ? null : draft.Selection.Id;
            delete.Enabled = duplicate.Enabled = enabled && draft != null && (draft.Wall != null || draft.Light != null || draft.Image != null);
            if (Object.ReferenceEquals(inspectorDraft, draft) && inspectorKind == kind && inspectorId == id) { properties.Refresh(); return; }
            inspectorDraft = draft; inspectorKind = kind; inspectorId = id;
            object selected = null;
            if (draft != null && enabled)
            {
                if (draft.Wall != null) { selected = new WallProperties(draft); title.Text = "Muro / porta"; }
                else if (draft.Light != null) { selected = new LightProperties(draft); title.Text = "Luce"; }
                else if (draft.Image != null) { selected = new ImageProperties(draft); title.Text = "Immagine"; }
                else if (draft.Selection.Kind == SceneSelectionKind.Map && canvas.Level != null) { selected = new MapProperties(draft, canvas.Level.Id); title.Text = "Mappa del livello"; }
            }
            if (selected == null) title.Text = "Seleziona un elemento";
            properties.SelectedObject = selected;
        }
        protected override void Dispose(bool disposing) { if (disposing) { Bind(null); tips.Dispose(); Toolbar.Dispose(); } base.Dispose(disposing); }
    }
}
