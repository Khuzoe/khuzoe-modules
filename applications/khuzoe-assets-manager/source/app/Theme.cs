using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    internal static class Theme
    {
        internal static readonly Color Background = Color.FromArgb(18, 19, 23);
        internal static readonly Color Sidebar = Color.FromArgb(23, 24, 29);
        internal static readonly Color Surface = Color.FromArgb(29, 30, 36);
        internal static readonly Color Input = Color.FromArgb(23, 24, 29);
        internal static readonly Color Border = Color.FromArgb(49, 50, 58);
        internal static readonly Color Text = Color.FromArgb(238, 234, 225);
        internal static readonly Color Muted = Color.FromArgb(161, 160, 168);
        internal static readonly Color Gold = Color.FromArgb(218, 187, 118);
        internal static readonly Color Green = Color.FromArgb(142, 194, 165);
        internal static GraphicsPath Rounded(Rectangle rectangle, int radius)
        {
            int diameter = radius * 2; var path = new GraphicsPath();
            path.AddArc(rectangle.Left, rectangle.Top, diameter, diameter, 180, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Top, diameter, diameter, 270, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rectangle.Left, rectangle.Bottom - diameter, diameter, diameter, 90, 90); path.CloseFigure(); return path;
        }
        internal static Label Label(string text, float size, Color color, FontStyle style)
        { return new Label { Text = text, ForeColor = color, BackColor = Color.Transparent, Font = new Font("Segoe UI", size, style), AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }; }
        internal static TextBox TextBox(string accessibleName)
        { return new TextBox { BackColor = Input, ForeColor = Text, BorderStyle = BorderStyle.FixedSingle, Font = new Font("Segoe UI", 10F), Dock = DockStyle.Fill, AccessibleName = accessibleName }; }
        internal static ComboBox Combo(string accessibleName)
        { return new ComboBox { BackColor = Input, ForeColor = Text, FlatStyle = FlatStyle.Flat, Font = new Font("Segoe UI", 10F), Dock = DockStyle.Fill, AccessibleName = accessibleName }; }
    }
    internal sealed class SurfacePanel : Panel
    {
        public SurfacePanel() { DoubleBuffered = true; BackColor = Theme.Surface; }
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent == null ? Theme.Background : Parent.BackColor);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var shape = Theme.Rounded(new Rectangle(0, 0, Width - 1, Height - 1), 12))
            using (var brush = new SolidBrush(BackColor)) using (var pen = new Pen(Theme.Border))
            { e.Graphics.FillPath(brush, shape); e.Graphics.DrawPath(pen, shape); }
        }
    }
    internal sealed class WebButton : Button
    {
        public bool Primary { get; set; }
        bool hovered;
        public WebButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; Cursor = Cursors.Hand;
            Font = new Font("Segoe UI", 9.5F, FontStyle.Bold); Height = 36;
        }
        protected override void OnMouseEnter(EventArgs e) { hovered = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hovered = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent == null ? Theme.Background : Parent.BackColor); e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color fill = !Enabled ? Theme.Border : Primary ? (hovered ? Color.FromArgb(235, 205, 140) : Theme.Gold) : hovered ? Color.FromArgb(48, 49, 58) : Theme.Surface;
            Color ink = !Enabled ? Theme.Muted : Primary ? Theme.Background : Theme.Text;
            using (var shape = Theme.Rounded(new Rectangle(0, 0, Width - 1, Height - 1), 7))
            using (var brush = new SolidBrush(fill)) using (var pen = new Pen(Primary ? fill : Theme.Border))
            { e.Graphics.FillPath(brush, shape); e.Graphics.DrawPath(pen, shape); }
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, ink, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            if (Focused && ShowFocusCues) ControlPaint.DrawFocusRectangle(e.Graphics, Rectangle.Inflate(ClientRectangle, -5, -5), ink, fill);
        }
    }
}
