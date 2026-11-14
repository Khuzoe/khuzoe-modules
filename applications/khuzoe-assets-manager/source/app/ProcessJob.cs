using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace KhuzoeAssetsManager
{
    // A private Windows job owns only the child process started for one operation.
    // Closing/terminating it also stops ffmpeg children, without enumerating other apps.
    internal sealed class ProcessJob : IDisposable
    {
        IntPtr handle;
        bool attached;
        [StructLayout(LayoutKind.Sequential)] struct BasicLimits
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters
        { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits
        {
            public BasicLimits BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        public ProcessJob()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) return;
            var info = new ExtendedLimits { BasicLimitInformation = new BasicLimits { LimitFlags = 0x2000 } };
            int length = Marshal.SizeOf(info); IntPtr pointer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(info, pointer, false);
                if (!SetInformationJobObject(handle, 9, pointer, (uint)length)) { CloseHandle(handle); handle = IntPtr.Zero; }
            }
            finally { Marshal.FreeHGlobal(pointer); }
        }
        public void Attach(Process process) { if (handle != IntPtr.Zero) attached = AssignProcessToJobObject(handle, process.Handle); }
        public void Terminate(Process process)
        {
            if (attached && handle != IntPtr.Zero && TerminateJobObject(handle, 1)) return;
            try { if (!process.HasExited) process.Kill(); } catch (InvalidOperationException) { }
        }
        public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    }
}
