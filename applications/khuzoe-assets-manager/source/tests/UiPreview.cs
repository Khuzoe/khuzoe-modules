using System;
using System.IO;
namespace KhuzoeAssetsManager
{
    internal static class UiPreview
    {
        [STAThread]
        static void Main() { Tests.ShowFixture(Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "build", "ui-preview"))); }
    }
}
