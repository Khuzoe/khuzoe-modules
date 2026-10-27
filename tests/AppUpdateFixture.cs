using System;
using System.IO;
using System.Threading;
internal static class AppUpdateFixture
{
    static void Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--hold") Thread.Sleep(2500);
        else File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "restart.marker"), "restarted");
    }
}
