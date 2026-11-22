using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace AirDeskElevatedService
{
    static class NativeApi
    {
        public static readonly IntPtr AIRDESK_MAGIC = new IntPtr(0x41495244);

        public const int INPUT_MOUSE = 0;
        public const int INPUT_KEYBOARD = 1;

        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_HWHEEL = 0x1000;
        public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
        public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_UNICODE = 0x0004;

        public const int SM_XVIRTUALSCREEN = 76;
        public const int SM_YVIRTUALSCREEN = 77;
        public const int SM_CXVIRTUALSCREEN = 78;
        public const int SM_CYVIRTUALSCREEN = 79;

        public const int WH_MOUSE_LL = 14;
        public const uint LLMHF_INJECTED = 0x00000001;
        public const int WM_MOUSEMOVE = 0x0200;

        public const uint SPI_GETANIMATION = 0x0048;
        public const uint SPI_SETANIMATION = 0x0049;

        [StructLayout(LayoutKind.Sequential)]
        public struct ANIMATIONINFO
        {
            public uint cbSize;
            public int iMinAnimate;
        }

        public const uint DESKTOP_READOBJECTS = 0x0001;
        public const uint DESKTOP_CREATEWINDOW = 0x0002;
        public const uint DESKTOP_CREATEMENU = 0x0004;
        public const uint DESKTOP_HOOKCONTROL = 0x0008;
        public const uint DESKTOP_JOURNALRECORD = 0x0010;
        public const uint DESKTOP_JOURNALPLAYBACK = 0x0020;
        public const uint DESKTOP_ENUMERATE = 0x0040;
        public const uint DESKTOP_WRITEOBJECTS = 0x0080;
        public const uint DESKTOP_SWITCHDESKTOP = 0x0100;
        public const uint DESKTOP_ALL_ACCESS = 0x01FF;
        public const int UOI_NAME = 2;

        public const uint TOKEN_ALL_ACCESS = 0xF01FF;
        public const int SecurityImpersonation = 2;
        public const int TokenPrimary = 1;
        public const int TokenSessionId = 12;
        public const uint CREATE_NO_WINDOW = 0x08000000;
        public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        public const PipeOptions PipeOptionFirstInstance = (PipeOptions)0x00080000;

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public int type; public InputUnion u; }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx; public int dy; public uint mouseData;
            public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk; public ushort wScan; public uint dwFlags;
            public uint time; public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSLLHOOKSTRUCT
        {
            public int ptX; public int ptY; public uint mouseData;
            public uint flags; public uint time; public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSG
        {
            public IntPtr hwnd; public uint message; public IntPtr wParam;
            public IntPtr lParam; public uint time; public int ptX; public int ptY;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetThreadDesktop(IntPtr hDesktop);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool CloseDesktop(IntPtr hDesktop);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool GetUserObjectInformationW(
            IntPtr hObj,
            int nIndex,
            byte[] pvInfo,
            int nLength,
            out int lpnLengthNeeded
        );

        [DllImport("kernel32.dll")]
        public static extern uint WTSGetActiveConsoleSessionId();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetNamedPipeClientProcessId(IntPtr Pipe, out uint ClientProcessId);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool DuplicateTokenEx(
            IntPtr hExistingToken,
            uint dwDesiredAccess,
            IntPtr lpTokenAttributes,
            int ImpersonationLevel,
            int TokenType,
            out IntPtr phNewToken
        );

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool SetTokenInformation(
            IntPtr TokenHandle,
            int TokenInformationClass,
            ref uint TokenInformation,
            int TokenInformationLength
        );

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CreateProcessAsUserW(
            IntPtr hToken,
            string lpApplicationName,
            string lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation
        );

        [DllImport("sas.dll", SetLastError = true)]
        public static extern void SendSAS(bool asUser);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref ANIMATIONINFO pvParam, uint fWinIni);
    }

    sealed class AirDeskSessionService : ServiceBase
    {
        private volatile bool _stopping = false;
        private Thread _supervisorThread;
        private Process _workerProcess;
        private uint _workerSessionId = 0xFFFFFFFF;
        private readonly object _procLock = new object();

        public AirDeskSessionService()
        {
            ServiceName = "AirDeskElevatedInput";
            CanStop = true;
            CanShutdown = true;
        }

        protected override void OnStart(string[] args)
        {
            _stopping = false;
            _supervisorThread = new Thread(SupervisorLoop);
            _supervisorThread.IsBackground = true;
            _supervisorThread.Start();
        }

        protected override void OnStop()
        {
            _stopping = true;
            KillWorker();
            if (_supervisorThread != null && _supervisorThread.IsAlive)
            {
                _supervisorThread.Join(2000);
            }
        }

        protected override void OnShutdown()
        {
            OnStop();
        }

        private void KillWorker()
        {
            lock (_procLock)
            {
                if (_workerProcess != null)
                {
                    try
                    {
                        if (!_workerProcess.HasExited) _workerProcess.Kill();
                    }
                    catch { }
                    try { _workerProcess.Dispose(); } catch { }
                    _workerProcess = null;
                    _workerSessionId = 0xFFFFFFFF;
                }
            }
        }

        private void SupervisorLoop()
        {
            while (!_stopping)
            {
                try
                {
                    uint activeSession = NativeApi.WTSGetActiveConsoleSessionId();
                    bool needRestart = false;

                    lock (_procLock)
                    {
                        if (activeSession == 0xFFFFFFFF)
                        {
                            if (_workerProcess != null) KillWorker();
                        }
                        else if (_workerProcess == null || _workerProcess.HasExited || _workerSessionId != activeSession)
                        {
                            needRestart = true;
                        }
                    }

                    if (needRestart && activeSession != 0xFFFFFFFF)
                    {
                        KillWorker();
                        SpawnWorkerInSession(activeSession);
                    }
                }
                catch { }
                Thread.Sleep(1200);
            }
        }

        private void SpawnWorkerInSession(uint sessionId)
        {
            IntPtr currentToken = IntPtr.Zero;
            IntPtr dupToken = IntPtr.Zero;
            try
            {
                if (!NativeApi.OpenProcessToken(Process.GetCurrentProcess().Handle, NativeApi.TOKEN_ALL_ACCESS, out currentToken))
                {
                    return;
                }
                if (!NativeApi.DuplicateTokenEx(
                    currentToken,
                    NativeApi.TOKEN_ALL_ACCESS,
                    IntPtr.Zero,
                    NativeApi.SecurityImpersonation,
                    NativeApi.TokenPrimary,
                    out dupToken))
                {
                    return;
                }
                uint sid = sessionId;
                if (!NativeApi.SetTokenInformation(dupToken, NativeApi.TokenSessionId, ref sid, sizeof(uint)))
                {
                    return;
                }

                string exePath = Process.GetCurrentProcess().MainModule.FileName;
                string cmdLine = "\"" + exePath + "\" --worker";

                NativeApi.STARTUPINFO si = new NativeApi.STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(NativeApi.STARTUPINFO));
                si.lpDesktop = "winsta0\\default";

                NativeApi.PROCESS_INFORMATION pi;
                bool ok = NativeApi.CreateProcessAsUserW(
                    dupToken,
                    exePath,
                    cmdLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    NativeApi.CREATE_NO_WINDOW | NativeApi.CREATE_UNICODE_ENVIRONMENT,
                    IntPtr.Zero,
                    Path.GetDirectoryName(exePath),
                    ref si,
                    out pi);

                if (ok)
                {
                    NativeApi.CloseHandle(pi.hThread);
                    NativeApi.CloseHandle(pi.hProcess);
                    lock (_procLock)
                    {
                        try
                        {
                            _workerProcess = Process.GetProcessById((int)pi.dwProcessId);
                            _workerSessionId = sessionId;
                        }
                        catch
                        {
                            _workerProcess = null;
                            _workerSessionId = 0xFFFFFFFF;
                        }
                    }
                }
            }
            finally
            {
                if (dupToken != IntPtr.Zero) NativeApi.CloseHandle(dupToken);
                if (currentToken != IntPtr.Zero) NativeApi.CloseHandle(currentToken);
            }
        }
    }

    static class ElevatedInputWorker
    {
        private const string PipeName = "AirDeskElevatedInput";
        private const string SecretFilePath = @"C:\ProgramData\AirDesk\pipe.secret";

        private static NativeApi.LowLevelMouseProc _mouseProc;
        private static long _lastPhysicalNotifyMs = 0;
        private static readonly Dictionary<ushort, bool> _activeKeys = new Dictionary<ushort, bool>();
        private static bool _leftDown = false;
        private static bool _rightDown = false;
        private static bool _middleDown = false;
        private static bool _winAnimSuppressed = false;
        private static int _savedMinAnimate = 0;

        private static void SetWindowAnimationSuppressed(bool suppress)
        {
            try
            {
                if (suppress)
                {
                    if (_winAnimSuppressed) return;
                    NativeApi.ANIMATIONINFO ai = new NativeApi.ANIMATIONINFO
                    {
                        cbSize = (uint)Marshal.SizeOf(typeof(NativeApi.ANIMATIONINFO)),
                        iMinAnimate = 0
                    };
                    if (NativeApi.SystemParametersInfo(NativeApi.SPI_GETANIMATION, ai.cbSize, ref ai, 0))
                    {
                        _savedMinAnimate = ai.iMinAnimate;
                        _winAnimSuppressed = true;
                        if (ai.iMinAnimate != 0)
                        {
                            ai.iMinAnimate = 0;
                            NativeApi.SystemParametersInfo(NativeApi.SPI_SETANIMATION, ai.cbSize, ref ai, 0);
                        }
                    }
                }
                else
                {
                    if (!_winAnimSuppressed) return;
                    _winAnimSuppressed = false;
                    if (_savedMinAnimate != 0)
                    {
                        NativeApi.ANIMATIONINFO ai = new NativeApi.ANIMATIONINFO
                        {
                            cbSize = (uint)Marshal.SizeOf(typeof(NativeApi.ANIMATIONINFO)),
                            iMinAnimate = _savedMinAnimate
                        };
                        NativeApi.SystemParametersInfo(NativeApi.SPI_SETANIMATION, ai.cbSize, ref ai, 0);
                        _savedMinAnimate = 0;
                    }
                }
            }
            catch { }
        }

        private static IntPtr _currentDesktopHandle = IntPtr.Zero;
        private static string _currentDesktopName = "";

        private static readonly object _pipeWriteLock = new object();
        private static StreamWriter _activeWriter = null;

        private static string ReadLineBounded(TextReader reader, int maxChars = 32768)
        {
            StringBuilder sb = new StringBuilder(256);
            int ch;
            while ((ch = reader.Read()) != -1)
            {
                if (ch == '\r') continue;
                if (ch == '\n') return sb.ToString();
                sb.Append((char)ch);
                if (sb.Length > maxChars)
                {
                    throw new InvalidDataException("Pipe input line exceeded maximum allowed length");
                }
            }
            return sb.Length > 0 ? sb.ToString() : null;
        }

        private static string LoadPipeSecret()
        {
            try
            {
                if (File.Exists(SecretFilePath))
                {
                    return File.ReadAllText(SecretFilePath, Encoding.UTF8).Trim();
                }
            }
            catch { }
            return "";
        }

        private static bool FixedTimeEquals(string a, string b)
        {
            if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) return false;
            byte[] ba = Encoding.UTF8.GetBytes(a);
            byte[] bb = Encoding.UTF8.GetBytes(b);
            int diff = ba.Length ^ bb.Length;
            int minLen = Math.Min(ba.Length, bb.Length);
            for (int i = 0; i < minLen; i++)
            {
                diff |= ba[i] ^ bb[i];
            }
            return diff == 0;
        }

        private static bool VerifyPipeClientSession(NamedPipeServerStream pipe)
        {
            try
            {
                uint clientPid = 0;
                if (!NativeApi.GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out clientPid) || clientPid == 0)
                {
                    return false;
                }
                using (Process proc = Process.GetProcessById((int)clientPid))
                {
                    uint activeSession = NativeApi.WTSGetActiveConsoleSessionId();
                    return activeSession != 0xFFFFFFFF && (uint)proc.SessionId == activeSession;
                }
            }
            catch
            {
                return false;
            }
        }

        public static void Run()
        {
            NativeApi.SetProcessDPIAware();
            StartPhysicalMouseMonitor();

            JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 2000000 };

            while (true)
            {
                NamedPipeServerStream server = null;
                try
                {
                    PipeSecurity ps = new PipeSecurity();
                    ps.AddAccessRule(new PipeAccessRule(
                        new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                        PipeAccessRights.FullControl,
                        AccessControlType.Allow));
                    ps.AddAccessRule(new PipeAccessRule(
                        new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
                        PipeAccessRights.ReadWrite,
                        AccessControlType.Allow));
                    ps.AddAccessRule(new PipeAccessRule(
                        new SecurityIdentifier(WellKnownSidType.NetworkSid, null),
                        PipeAccessRights.FullControl,
                        AccessControlType.Deny));

                    server = new NamedPipeServerStream(
                        PipeName,
                        PipeDirection.InOut,
                        1,
                        PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous | NativeApi.PipeOptionFirstInstance,
                        4096,
                        4096,
                        ps);

                    server.WaitForConnection();

                    if (!VerifyPipeClientSession(server))
                    {
                        continue;
                    }

                    using (StreamReader reader = new StreamReader(server, Encoding.UTF8, false, 4096, true))
                    using (StreamWriter writer = new StreamWriter(server, new UTF8Encoding(false), 4096, true))
                    {
                        writer.AutoFlush = true;

                        string expectedSecret = LoadPipeSecret();
                        if (!string.IsNullOrEmpty(expectedSecret))
                        {
                            string authLine = ReadLineBounded(reader, 2048);
                            if (string.IsNullOrWhiteSpace(authLine)) continue;
                            Dictionary<string, object> authObj = serializer.Deserialize<Dictionary<string, object>>(authLine);
                            if (authObj == null || GetStr(authObj, "t") != "auth" || !FixedTimeEquals(GetStr(authObj, "secret"), expectedSecret))
                            {
                                continue;
                            }
                        }

                        lock (_pipeWriteLock)
                        {
                            _activeWriter = writer;
                        }

                        EnsureCurrentInputDesktop(true);
                        EmitPipeEvent("{\"event\":\"elevated_ready\"}");

                        string line;
                        while ((line = ReadLineBounded(reader, 32768)) != null)
                        {
                            if (string.IsNullOrWhiteSpace(line)) continue;
                            EnsureCurrentInputDesktop(false);
                            HandleCommandLine(serializer, line);
                        }
                    }
                }
                catch
                {
                    // Re-listen cleanly on pipe disconnect or transient error
                }
                finally
                {
                    lock (_pipeWriteLock)
                    {
                        _activeWriter = null;
                    }
                    SetWindowAnimationSuppressed(false);
                    ReleaseAllKeysAndMouse();
                    if (server != null)
                    {
                        try { server.Dispose(); } catch { }
                    }
                }
                Thread.Sleep(150);
            }
        }

        private static void EmitPipeEvent(string jsonLine)
        {
            lock (_pipeWriteLock)
            {
                if (_activeWriter == null) return;
                try
                {
                    _activeWriter.WriteLine(jsonLine);
                }
                catch
                {
                    _activeWriter = null;
                }
            }
        }

        private static string GetDesktopName(IntPtr hDesk)
        {
            if (hDesk == IntPtr.Zero) return "";
            int needed = 0;
            NativeApi.GetUserObjectInformationW(hDesk, NativeApi.UOI_NAME, null, 0, out needed);
            if (needed <= 0) return "";
            byte[] buf = new byte[needed];
            if (!NativeApi.GetUserObjectInformationW(hDesk, NativeApi.UOI_NAME, buf, needed, out needed))
            {
                return "";
            }
            return Encoding.Unicode.GetString(buf).TrimEnd('\0');
        }

        private static void EnsureCurrentInputDesktop(bool forceNotify)
        {
            IntPtr hDesk = NativeApi.OpenInputDesktop(0, false, NativeApi.DESKTOP_ALL_ACCESS);
            if (hDesk == IntPtr.Zero) return;
            string name = GetDesktopName(hDesk);
            if (!string.IsNullOrEmpty(name) && (forceNotify || !string.Equals(name, _currentDesktopName, StringComparison.OrdinalIgnoreCase)))
            {
                if (NativeApi.SetThreadDesktop(hDesk))
                {
                    if (_currentDesktopHandle != IntPtr.Zero && _currentDesktopHandle != hDesk)
                    {
                        NativeApi.CloseDesktop(_currentDesktopHandle);
                    }
                    _currentDesktopHandle = hDesk;
                    _currentDesktopName = name;
                    EmitPipeEvent("{\"event\":\"desktop_changed\",\"desktop\":\"" + EscapeJson(name) + "\"}");
                    return;
                }
            }
            NativeApi.CloseDesktop(hDesk);
        }

        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private static void HandleCommandLine(JavaScriptSerializer serializer, string line)
        {
            try
            {
                Dictionary<string, object> obj = serializer.Deserialize<Dictionary<string, object>>(line);
                if (obj == null) return;
                string t = GetStr(obj, "t");

                if (t == "m:rel")
                {
                    double dx, dy;
                    TryGetDouble(obj, "dx", out dx);
                    TryGetDouble(obj, "dy", out dy);
                    SendMouse((int)Math.Round(dx), (int)Math.Round(dy), NativeApi.MOUSEEVENTF_MOVE);
                }
                else if (t == "m:abs")
                {
                    double px, py;
                    if (TryGetDouble(obj, "px", out px) && TryGetDouble(obj, "py", out py))
                    {
                        int vx = NativeApi.GetSystemMetrics(NativeApi.SM_XVIRTUALSCREEN);
                        int vy = NativeApi.GetSystemMetrics(NativeApi.SM_YVIRTUALSCREEN);
                        int vw = Math.Max(1, NativeApi.GetSystemMetrics(NativeApi.SM_CXVIRTUALSCREEN));
                        int vh = Math.Max(1, NativeApi.GetSystemMetrics(NativeApi.SM_CYVIRTUALSCREEN));
                        int normX = (int)Math.Round(((px - vx) * 65535.0) / Math.Max(1, vw - 1));
                        int normY = (int)Math.Round(((py - vy) * 65535.0) / Math.Max(1, vh - 1));
                        SendMouse(normX, normY, NativeApi.MOUSEEVENTF_MOVE | NativeApi.MOUSEEVENTF_ABSOLUTE | NativeApi.MOUSEEVENTF_VIRTUALDESK);
                    }
                }
                else if (t == "m:btn")
                {
                    string btn = GetStr(obj, "button");
                    bool down = GetStr(obj, "state") == "down";
                    if (btn == "right") _rightDown = down;
                    else if (btn == "middle") _middleDown = down;
                    else _leftDown = down;
                    uint flag = btn == "right" ? (down ? NativeApi.MOUSEEVENTF_RIGHTDOWN : NativeApi.MOUSEEVENTF_RIGHTUP)
                              : btn == "middle" ? (down ? NativeApi.MOUSEEVENTF_MIDDLEDOWN : NativeApi.MOUSEEVENTF_MIDDLEUP)
                              : (down ? NativeApi.MOUSEEVENTF_LEFTDOWN : NativeApi.MOUSEEVENTF_LEFTUP);
                    SendMouse(0, 0, flag);
                }
                else if (t == "m:whl")
                {
                    double dx, dy;
                    if (TryGetDouble(obj, "dy", out dy))
                    {
                        int wheel = (int)Math.Round(-dy * 120.0);
                        if (wheel != 0) SendMouse(0, 0, NativeApi.MOUSEEVENTF_WHEEL, unchecked((uint)wheel));
                    }
                    if (TryGetDouble(obj, "dx", out dx))
                    {
                        int hwheel = (int)Math.Round(dx * 120.0);
                        if (hwheel != 0) SendMouse(0, 0, NativeApi.MOUSEEVENTF_HWHEEL, unchecked((uint)hwheel));
                    }
                }
                else if (t == "k:down" || t == "k:up")
                {
                    ushort vk;
                    bool ext;
                    if (TryMapCodeToVk(GetStr(obj, "code"), out vk, out ext))
                    {
                        if (t == "k:down") _activeKeys[vk] = ext;
                        else _activeKeys.Remove(vk);
                        SendVirtualKey(vk, ext, t == "k:up");
                    }
                }
                else if (t == "k:release_all")
                {
                    ReleaseAllKeysAndMouse();
                }
                else if (t == "text:unicode")
                {
                    SendUnicodeText(GetStr(obj, "text"));
                }
                else if (t == "sys:sas")
                {
                    try { NativeApi.SendSAS(false); } catch { }
                }
                else if (t == "sys:fast_win_anim")
                {
                    object enVal;
                    bool en = obj.TryGetValue("enabled", out enVal) && enVal is bool && (bool)enVal;
                    SetWindowAnimationSuppressed(en);
                }
            }
            catch
            {
                // Never crash worker loop on malformed line
            }
        }

        private static void ReleaseAllKeysAndMouse()
        {
            foreach (KeyValuePair<ushort, bool> kv in new List<KeyValuePair<ushort, bool>>(_activeKeys))
            {
                SendVirtualKey(kv.Key, kv.Value, true);
            }
            _activeKeys.Clear();

            ushort[] nonExtMods = { 0xA0, 0xA1, 0x10, 0xA2, 0x11, 0xA4, 0x12 };
            foreach (ushort vk in nonExtMods) SendVirtualKey(vk, false, true);
            ushort[] extMods = { 0xA3, 0xA5, 0x5B, 0x5C };
            foreach (ushort vk in extMods) SendVirtualKey(vk, true, true);

            if (_leftDown) { SendMouse(0, 0, NativeApi.MOUSEEVENTF_LEFTUP); _leftDown = false; }
            if (_rightDown) { SendMouse(0, 0, NativeApi.MOUSEEVENTF_RIGHTUP); _rightDown = false; }
            if (_middleDown) { SendMouse(0, 0, NativeApi.MOUSEEVENTF_MIDDLEUP); _middleDown = false; }
        }

        private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && wParam == (IntPtr)NativeApi.WM_MOUSEMOVE)
            {
                NativeApi.MSLLHOOKSTRUCT info = (NativeApi.MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(NativeApi.MSLLHOOKSTRUCT));
                bool isInjected = (info.flags & NativeApi.LLMHF_INJECTED) != 0 || info.dwExtraInfo == NativeApi.AIRDESK_MAGIC;
                if (!isInjected)
                {
                    long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    if (now - _lastPhysicalNotifyMs > 600)
                    {
                        _lastPhysicalNotifyMs = now;
                        EmitPipeEvent("{\"event\":\"physical_mouse_override\"}");
                    }
                }
            }
            return NativeApi.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }

        private static void StartPhysicalMouseMonitor()
        {
            Thread hookThread = new Thread(() =>
            {
                _mouseProc = HookCallback;
                NativeApi.SetWindowsHookEx(NativeApi.WH_MOUSE_LL, _mouseProc, IntPtr.Zero, 0);
                NativeApi.MSG msg;
                while (NativeApi.GetMessage(out msg, IntPtr.Zero, 0, 0)) { }
            });
            hookThread.IsBackground = true;
            hookThread.Start();
        }

        private static void SendMouse(int dx, int dy, uint flags, uint mouseData = 0)
        {
            NativeApi.INPUT[] inputs = new NativeApi.INPUT[1];
            inputs[0].type = NativeApi.INPUT_MOUSE;
            inputs[0].u.mi = new NativeApi.MOUSEINPUT
            {
                dx = dx, dy = dy, mouseData = mouseData,
                dwFlags = flags, time = 0, dwExtraInfo = NativeApi.AIRDESK_MAGIC
            };
            NativeApi.SendInput(1, inputs, Marshal.SizeOf(typeof(NativeApi.INPUT)));
        }

        private static void SendVirtualKey(ushort vk, bool isExtended, bool keyUp)
        {
            uint flags = (isExtended ? NativeApi.KEYEVENTF_EXTENDEDKEY : 0u) | (keyUp ? NativeApi.KEYEVENTF_KEYUP : 0u);
            NativeApi.INPUT[] inputs = new NativeApi.INPUT[1];
            inputs[0].type = NativeApi.INPUT_KEYBOARD;
            inputs[0].u.ki = new NativeApi.KEYBDINPUT
            {
                wVk = vk, wScan = 0, dwFlags = flags,
                time = 0, dwExtraInfo = NativeApi.AIRDESK_MAGIC
            };
            NativeApi.SendInput(1, inputs, Marshal.SizeOf(typeof(NativeApi.INPUT)));
        }

        private static void SendUnicodeText(string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            List<NativeApi.INPUT> list = new List<NativeApi.INPUT>(text.Length * 2);
            foreach (char ch in text)
            {
                list.Add(new NativeApi.INPUT { type = NativeApi.INPUT_KEYBOARD, u = new NativeApi.InputUnion { ki = new NativeApi.KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = NativeApi.KEYEVENTF_UNICODE, dwExtraInfo = NativeApi.AIRDESK_MAGIC } } });
                list.Add(new NativeApi.INPUT { type = NativeApi.INPUT_KEYBOARD, u = new NativeApi.InputUnion { ki = new NativeApi.KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = NativeApi.KEYEVENTF_UNICODE | NativeApi.KEYEVENTF_KEYUP, dwExtraInfo = NativeApi.AIRDESK_MAGIC } } });
            }
            NativeApi.SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(NativeApi.INPUT)));
        }

        private static bool TryMapCodeToVk(string code, out ushort vk, out bool isExtended)
        {
            vk = 0;
            isExtended = false;
            if (string.IsNullOrEmpty(code)) return false;

            switch (code)
            {
                case "Escape": vk = 0x1B; return true;
                case "Tab": vk = 0x09; return true;
                case "Enter": vk = 0x0D; return true;
                case "NumpadEnter": vk = 0x0D; isExtended = true; return true;
                case "Backspace": vk = 0x08; return true;
                case "Space": vk = 0x20; return true;
                case "CapsLock": vk = 0x14; return true;
                case "PrintScreen": vk = 0x2C; isExtended = true; return true;

                case "Insert": vk = 0x2D; isExtended = true; return true;
                case "Delete": vk = 0x2E; isExtended = true; return true;
                case "Home": vk = 0x24; isExtended = true; return true;
                case "End": vk = 0x23; isExtended = true; return true;
                case "PageUp": vk = 0x21; isExtended = true; return true;
                case "PageDown": vk = 0x22; isExtended = true; return true;
                case "ArrowLeft": vk = 0x25; isExtended = true; return true;
                case "ArrowUp": vk = 0x26; isExtended = true; return true;
                case "ArrowRight": vk = 0x27; isExtended = true; return true;
                case "ArrowDown": vk = 0x28; isExtended = true; return true;

                case "ControlLeft": vk = 0xA2; return true;
                case "ControlRight": vk = 0xA3; isExtended = true; return true;
                case "AltLeft": vk = 0xA4; return true;
                case "AltRight": vk = 0xA5; isExtended = true; return true;
                case "ShiftLeft": vk = 0xA0; return true;
                case "ShiftRight": vk = 0xA1; return true;
                case "MetaLeft": vk = 0x5B; isExtended = true; return true;
                case "MetaRight": vk = 0x5C; isExtended = true; return true;

                case "Minus": vk = 0xBD; return true;
                case "Equal": vk = 0xBB; return true;
                case "BracketLeft": vk = 0xDB; return true;
                case "BracketRight": vk = 0xDD; return true;
                case "Backslash": vk = 0xDC; return true;
                case "Semicolon": vk = 0xBA; return true;
                case "Quote": vk = 0xDE; return true;
                case "Backquote": vk = 0xC0; return true;
                case "Comma": vk = 0xBC; return true;
                case "Period": vk = 0xBE; return true;
                case "Slash": vk = 0xBF; return true;

                case "NumpadMultiply": vk = 0x6A; return true;
                case "NumpadAdd": vk = 0x6B; return true;
                case "NumpadSubtract": vk = 0x6D; return true;
                case "NumpadDecimal": vk = 0x6E; return true;
                case "NumpadDivide": vk = 0x6F; isExtended = true; return true;
            }

            if (code.StartsWith("Key") && code.Length == 4) { vk = (ushort)char.ToUpper(code[3]); return true; }
            if (code.StartsWith("Digit") && code.Length == 6) { vk = (ushort)code[5]; return true; }
            if (code.StartsWith("Numpad") && code.Length == 7 && char.IsDigit(code[6]))
            {
                vk = (ushort)(0x60 + (code[6] - '0'));
                return true;
            }
            if (code.StartsWith("F") && code.Length <= 3)
            {
                int fn;
                if (int.TryParse(code.Substring(1), out fn) && fn >= 1 && fn <= 12)
                {
                    vk = (ushort)(0x6F + fn);
                    return true;
                }
            }
            return false;
        }

        private static string GetStr(Dictionary<string, object> obj, string key)
        {
            object val;
            return obj.TryGetValue(key, out val) && val != null ? Convert.ToString(val) : "";
        }

        private static bool TryGetDouble(Dictionary<string, object> obj, string key, out double result)
        {
            object val;
            if (obj.TryGetValue(key, out val) && val != null)
            {
                try { result = Convert.ToDouble(val); return !double.IsNaN(result) && !double.IsInfinity(result); }
                catch { }
            }
            result = 0;
            return false;
        }
    }

    static class Program
    {
        static void Main(string[] args)
        {
            bool runWorker = false;
            if (args != null)
            {
                foreach (string a in args)
                {
                    if (string.Equals(a, "--worker", StringComparison.OrdinalIgnoreCase))
                    {
                        runWorker = true;
                        break;
                    }
                }
            }

            if (runWorker)
            {
                ElevatedInputWorker.Run();
                return;
            }

            ServiceBase.Run(new ServiceBase[] { new AirDeskSessionService() });
        }
    }
}
