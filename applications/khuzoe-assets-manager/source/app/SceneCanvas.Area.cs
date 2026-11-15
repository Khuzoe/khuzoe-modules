using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;

namespace KhuzoeAssetsManager
{
    public sealed partial class SceneCanvas
    {
        public RectangleF? AnalysisArea { get; private set; }
        RectangleF? areaBefore;
        public event EventHandler AnalysisAreaChanged;
        public IList<SceneWall> ReferenceWalls { get; set; }
        public HashSet<string> UncertainWalls { get; set; }
        public void SetAnalysisArea(RectangleF? value)
        {
            if (value.HasValue && (!WallFrame.From(value.Value).Valid)) value = null;
            if (AnalysisArea == value) return; AnalysisArea = value; Invalidate(); if (AnalysisAreaChanged != null) AnalysisAreaChanged(this, EventArgs.Empty);
        }
        void DrawAnalysisArea(Graphics g)
        {
            if (!AnalysisArea.HasValue) return; var a = AnalysisArea.Value;
            var first = Screen(a.Left, a.Top); var last = Screen(a.Right, a.Bottom); var rect = RectangleF.FromLTRB(first.X, first.Y, last.X, last.Y);
            using (var fill = new SolidBrush(Color.FromArgb(25, 100, 210, 240))) using (var pen = new Pen(Color.FromArgb(110, 220, 245), 2) { DashStyle = DashStyle.Dash }) { g.FillRectangle(fill, rect); g.DrawRectangle(pen, rect.X, rect.Y, rect.Width, rect.Height); }
        }
    }
}
