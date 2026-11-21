$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    $control = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
    $spec = ConvertFrom-Json -InputObject ($control.ReadLine())
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

public static class AgyJob {
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long ProcessTimeLimit, JobTimeLimit;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObject(uint access, bool inherit, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job, int infoClass, out Accounting accounting, int length, IntPtr returned);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job, int infoClass, ref ExtendedLimits limits, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    private static string JobName(string id) {
        Guid parsed;
        if (!Guid.TryParseExact(id, "N", out parsed))
            throw new ArgumentException("Invalid Antigravity job identity");
        return "Local\\conductor-agy-" + parsed.ToString("N");
    }

    public static void Stop(string id) {
        const uint QueryAndTerminate = 0x4 | 0x8;
        const int BasicAccountingInformation = 1;
        IntPtr job = OpenJobObject(QueryAndTerminate, false, JobName(id));
        if (job == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            if (error == 2)
                return;
            throw new Win32Exception(error);
        }
        try {
            if (!TerminateJobObject(job, 125))
                throw new Win32Exception();
            var elapsed = Stopwatch.StartNew();
            do {
                Accounting accounting;
                if (!QueryInformationJobObject(job, BasicAccountingInformation, out accounting,
                        Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
                    throw new Win32Exception();
                if (accounting.ActiveProcesses == 0)
                    return;
                Thread.Sleep(25);
            } while (elapsed.ElapsedMilliseconds < 5000);
            throw new TimeoutException("Antigravity Job Object still has active processes");
        } finally {
            CloseHandle(job);
        }
    }

    public static int Run(TextReader control, string id, string executable, string arguments, string cwd, byte[] prompt) {
        const uint KillOnJobClose = 0x2000;
        const int ExtendedLimitInformation = 9;

        // Assign the supervisor first so every child enters the job at creation.
        IntPtr job = CreateJobObject(IntPtr.Zero, JobName(id));
        if (job == IntPtr.Zero)
            throw new Win32Exception();
        if (Marshal.GetLastWin32Error() == 183)
            throw new InvalidOperationException("Antigravity Job Object already exists");
        var limits = new ExtendedLimits();
        limits.Basic.Flags = KillOnJobClose;
        if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, Marshal.SizeOf(limits)) ||
            !AssignProcessToJobObject(job, GetCurrentProcess()))
            throw new Win32Exception();

        Console.WriteLine("AGY_JOB_READY");
        Console.Out.Flush();
        var launch = Task.Run(() => control.ReadLine());
        if (!launch.Wait(8000) || launch.Result != "GO")
            return 125;

        // The non-inheritable handle stays open until supervisor exit.
        Task.Run(() => {
            try {
                while (true) {
                    var heartbeat = Task.Run(() => control.ReadLine());
                    if (!heartbeat.Wait(8000) || heartbeat.Result == null)
                        break;
                }
            } finally {
                Environment.Exit(125);
            }
        });

        using (var child = Process.Start(new ProcessStartInfo {
            FileName = executable,
            Arguments = arguments,
            WorkingDirectory = cwd,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true
        })) {
            Task.Run(() => {
                try {
                    using (var stdin = child.StandardInput.BaseStream)
                        stdin.Write(prompt, 0, prompt.Length);
                } catch (IOException) {}
            });
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
'@
    if ($spec.cancel) {
        [AgyJob]::Stop($spec.job)
        [Console]::WriteLine("AGY_JOB_STOPPED")
        exit 0
    }
    exit ([AgyJob]::Run($control, $spec.job, $spec.command, $spec.arguments, $spec.cwd,
        [Convert]::FromBase64String($spec.prompt)))
} catch {
    [Console]::Error.WriteLine("agy Windows supervisor: " + $_.Exception.Message)
    exit 125
}
