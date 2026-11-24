using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace AirDeskWinHelper
{
    class Program
    {
        private static readonly IntPtr AIRDESK_MAGIC = new IntPtr(0x41495244);

        private const int INPUT_MOUSE = 0;
        private const int INPUT_KEYBOARD = 1;

        private const uint MOUSEEVENTF_MOVE = 0x0001;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;
        private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        private const uint MOUSEEVENTF_WHEEL = 0x0800;
        private const uint MOUSEEVENTF_HWHEEL = 0x1000;
        private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
        private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

        private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint KEYEVENTF_UNICODE = 0x0004;

        private const int SM_XVIRTUALSCREEN = 76;
        private const int SM_YVIRTUALSCREEN = 77;
        private const int SM_CXVIRTUALSCREEN = 78;
        private const int SM_CYVIRTUALSCREEN = 79;

        private const int WH_MOUSE_LL = 14;
        private const uint LLMHF_INJECTED = 0x00000001;
        private const int WM_MOUSEMOVE = 0x0200;
        private const uint MAPVK_VK_TO_VSC = 0;
        private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

        private const uint SPI_GETANIMATION = 0x0048;
        private const uint SPI_SETANIMATION = 0x0049;
        private const uint DESKTOP_READOBJECTS = 0x0001;
        private const int UOI_NAME = 2;
        private const int ERROR_ACCESS_DENIED = 5;

        [StructLayout(LayoutKind.Sequential)]
        struct ANIMATIONINFO
        {
            public uint cbSize;
            public int iMinAnimate;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public int type; public InputUnion u; }

        [StructLayout(LayoutKind.Explicit)]
        struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT
        {
            public int dx; public int dy; public uint mouseData;
            public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT
        {
            public ushort wVk; public ushort wScan; public uint dwFlags;
            public uint time; public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct MSLLHOOKSTRUCT
        {
            public int ptX; public int ptY; public uint mouseData;
            public uint flags; public uint time; public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct MSG
        {
            public IntPtr hwnd; public uint message; public IntPtr wParam;
            public IntPtr lParam; public uint time; public int ptX; public int ptY;
        }

        delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        static extern int GetSystemMetrics(int nIndex);

        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("user32.dll")]
        static extern uint MapVirtualKey(uint uCode, uint uMapType);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref ANIMATIONINFO pvParam, uint fWinIni);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool CloseDesktop(IntPtr hDesktop);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool GetUserObjectInformationW(
            IntPtr hObj,
            int nIndex,
            byte[] pvInfo,
            int nLength,
            out int lpnLengthNeeded
        );

        private static readonly object _stdoutLock = new object();
        private static LowLevelMouseProc _mouseProc;
        private static IntPtr _mouseHookHandle = IntPtr.Zero;
        private static uint _hookThreadId = 0;
        private static long _lastPhysicalNotifyMs = 0;
        private static int _physicalMousePending = 0;
        private static readonly AutoResetEvent _physicalMouseSignal = new AutoResetEvent(false);
        private static volatile bool _hookStopping = false;
        private static volatile bool _secureDesktopStopping = false;
        private static readonly AutoResetEvent _secureDesktopStopEvent = new AutoResetEvent(false);
        private static long _lastSendErrorLogMs = 0;

        private static int _cachedVx = 0;
        private static int _cachedVy = 0;
        private static int _cachedVw = 1920;
        private static int _cachedVh = 1080;
        private static long _lastMetricsRefreshMs = 0;

        [DllImport("kernel32.dll")]
        static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        static extern bool PostThreadMessage(uint idThread, uint Msg, IntPtr wParam, IntPtr lParam);

        private const uint WM_QUIT = 0x0012;
        private static readonly Dictionary<ushort, bool> _activeKeys = new Dictionary<ushort, bool>();
        private static bool _leftDown = false;
        private static bool _rightDown = false;
        private static bool _middleDown = false;
        private static bool _winAnimSuppressed = false;
        private static int _savedMinAnimate = 0;

        static void SetWindowAnimationSuppressed(bool suppress)
        {
            try
            {
                if (suppress)
                {
                    if (_winAnimSuppressed) return;
                    ANIMATIONINFO ai = new ANIMATIONINFO { cbSize = (uint)Marshal.SizeOf(typeof(ANIMATIONINFO)), iMinAnimate = 0 };
                    if (SystemParametersInfo(SPI_GETANIMATION, ai.cbSize, ref ai, 0))
                    {
                        _savedMinAnimate = ai.iMinAnimate;
                        _winAnimSuppressed = true;
                        if (ai.iMinAnimate != 0)
                        {
                            ai.iMinAnimate = 0;
                            SystemParametersInfo(SPI_SETANIMATION, ai.cbSize, ref ai, 0);
                        }
                    }
                }
                else
                {
                    if (!_winAnimSuppressed) return;
                    _winAnimSuppressed = false;
                    if (_savedMinAnimate != 0)
                    {
                        ANIMATIONINFO ai = new ANIMATIONINFO { cbSize = (uint)Marshal.SizeOf(typeof(ANIMATIONINFO)), iMinAnimate = _savedMinAnimate };
                        SystemParametersInfo(SPI_SETANIMATION, ai.cbSize, ref ai, 0);
                        _savedMinAnimate = 0;
                    }
                }
            }
            catch { }
        }

        static void ReleaseAllKeysAndMouse()
        {
            foreach (KeyValuePair<ushort, bool> kv in new List<KeyValuePair<ushort, bool>>(_activeKeys))
            {
                SendVirtualKey(kv.Key, kv.Value, true);
            }
            _activeKeys.Clear();

            // Always force-release standard Windows modifiers in case host & helper went out of sync
            ushort[] nonExtMods = { 0xA0, 0xA1, 0x10, 0xA2, 0x11, 0xA4, 0x12 };
            foreach (ushort vk in nonExtMods) SendVirtualKey(vk, false, true);
            ushort[] extMods = { 0xA3, 0xA5, 0x5B, 0x5C };
            foreach (ushort vk in extMods) SendVirtualKey(vk, true, true);

            if (_leftDown) { SendMouse(0, 0, MOUSEEVENTF_LEFTUP); _leftDown = false; }
            if (_rightDown) { SendMouse(0, 0, MOUSEEVENTF_RIGHTUP); _rightDown = false; }
            if (_middleDown) { SendMouse(0, 0, MOUSEEVENTF_MIDDLEUP); _middleDown = false; }
        }

        static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && wParam == (IntPtr)WM_MOUSEMOVE)
            {
                MSLLHOOKSTRUCT info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                bool isInjected = (info.flags & LLMHF_INJECTED) != 0 || info.dwExtraInfo == AIRDESK_MAGIC;
                if (!isInjected)
                {
                    long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    long prev = Interlocked.Read(ref _lastPhysicalNotifyMs);
                    if (now - prev > 600 && Interlocked.CompareExchange(ref _lastPhysicalNotifyMs, now, prev) == prev)
                    {
                        Interlocked.Exchange(ref _physicalMousePending, 1);
                        _physicalMouseSignal.Set();
                    }
                }
            }
            return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }

        static void EmitJsonLine(string json)
        {
            lock (_stdoutLock)
            {
                try { Console.WriteLine(json); } catch { }
            }
        }

        static string GetDesktopName(IntPtr hDesk)
        {
            if (hDesk == IntPtr.Zero) return "";
            int needed = 0;
            GetUserObjectInformationW(hDesk, UOI_NAME, null, 0, out needed);
            if (needed <= 0) return "";
            byte[] buf = new byte[needed];
            if (!GetUserObjectInformationW(hDesk, UOI_NAME, buf, needed, out needed))
            {
                return "";
            }
            return Encoding.Unicode.GetString(buf).TrimEnd('\0');
        }

        static void StartSecureDesktopMonitor()
        {
            _secureDesktopStopping = false;
            Thread monitorThread = new Thread(() =>
            {
                bool reportedSecure = false;
                bool? pendingSecure = null;
                int pendingCount = 0;
                while (!_secureDesktopStopping)
                {
                    if (_secureDesktopStopEvent.WaitOne(400) || _secureDesktopStopping) break;
                    bool? sampleSecure = null;
                    IntPtr hDesk = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
                    if (hDesk == IntPtr.Zero)
                    {
                        int err = Marshal.GetLastWin32Error();
                        if (err == ERROR_ACCESS_DENIED)
                        {
                            sampleSecure = true;
                        }
                    }
                    else
                    {
                        try
                        {
                            string name = GetDesktopName(hDesk);
                            if (!string.IsNullOrEmpty(name))
                            {
                                sampleSecure = !string.Equals(name, "Default", StringComparison.OrdinalIgnoreCase);
                            }
                        }
                        finally
                        {
                            CloseDesktop(hDesk);
                        }
                    }

                    if (!sampleSecure.HasValue) continue;
                    bool nowSecure = sampleSecure.Value;
                    if (nowSecure == reportedSecure)
                    {
                        pendingSecure = null;
                        pendingCount = 0;
                        continue;
                    }
                    if (pendingSecure.HasValue && pendingSecure.Value == nowSecure)
                    {
                        pendingCount++;
                    }
                    else
                    {
                        pendingSecure = nowSecure;
                        pendingCount = 1;
                    }
                    if (pendingCount >= 2)
                    {
                        reportedSecure = nowSecure;
                        pendingSecure = null;
                        pendingCount = 0;
                        EmitJsonLine("{\"event\":\"secure_desktop\",\"active\":" + (reportedSecure ? "true" : "false") + "}");
                    }
                }
            });
            monitorThread.IsBackground = true;
            monitorThread.Start();
        }

        static void StopSecureDesktopMonitor()
        {
            _secureDesktopStopping = true;
            _secureDesktopStopEvent.Set();
        }

        static void StartPhysicalMouseMonitor()
        {
            _hookStopping = false;
            Thread notifyThread = new Thread(() =>
            {
                while (!_hookStopping)
                {
                    _physicalMouseSignal.WaitOne(500);
                    if (_hookStopping) break;
                    if (Interlocked.Exchange(ref _physicalMousePending, 0) == 1)
                    {
                        EmitJsonLine("{\"event\":\"physical_mouse_override\"}");
                    }
                }
            });
            notifyThread.IsBackground = true;
            notifyThread.Start();

            Thread hookThread = new Thread(() =>
            {
                _hookThreadId = GetCurrentThreadId();
                _mouseProc = HookCallback;
                _mouseHookHandle = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, IntPtr.Zero, 0);
                MSG msg;
                while (GetMessage(out msg, IntPtr.Zero, 0, 0)) { }
                IntPtr h = Interlocked.Exchange(ref _mouseHookHandle, IntPtr.Zero);
                if (h != IntPtr.Zero) UnhookWindowsHookEx(h);
            });
            hookThread.IsBackground = true;
            hookThread.Start();
        }

        static void StopPhysicalMouseMonitor()
        {
            _hookStopping = true;
            _physicalMouseSignal.Set();
            IntPtr h = Interlocked.Exchange(ref _mouseHookHandle, IntPtr.Zero);
            if (h != IntPtr.Zero)
            {
                try { UnhookWindowsHookEx(h); } catch { }
            }
            if (_hookThreadId != 0)
            {
                try { PostThreadMessage(_hookThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero); } catch { }
            }
        }

        static void InvokeSendInput(INPUT[] inputs)
        {
            if (inputs == null || inputs.Length == 0) return;
            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent < inputs.Length)
            {
                int err = Marshal.GetLastWin32Error();
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                long prev = Interlocked.Read(ref _lastSendErrorLogMs);
                if (now - prev >= 5000 && Interlocked.CompareExchange(ref _lastSendErrorLogMs, now, prev) == prev)
                {
                    try
                    {
                        Console.Error.WriteLine("[AirDeskWinHelper] SendInput incomplete: sent=" + sent + "/" + inputs.Length + " err=" + err);
                    }
                    catch { }
                }
            }
        }

        static void RefreshVirtualScreenBounds(bool force)
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (!force && now - _lastMetricsRefreshMs < 2000) return;
            _lastMetricsRefreshMs = now;
            _cachedVx = GetSystemMetrics(SM_XVIRTUALSCREEN);
            _cachedVy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            _cachedVw = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
            _cachedVh = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
        }

        static void SendMouse(int dx, int dy, uint flags, uint mouseData = 0)
        {
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = INPUT_MOUSE;
            inputs[0].u.mi = new MOUSEINPUT
            {
                dx = dx, dy = dy, mouseData = mouseData,
                dwFlags = flags, time = 0, dwExtraInfo = AIRDESK_MAGIC
            };
            InvokeSendInput(inputs);
        }

        static void SendVirtualKey(ushort vk, bool isExtended, bool keyUp)
        {
            uint flags = (isExtended ? KEYEVENTF_EXTENDEDKEY : 0u) | (keyUp ? KEYEVENTF_KEYUP : 0u);
            ushort scan = (ushort)(MapVirtualKey(vk, MAPVK_VK_TO_VSC) & 0xFF);
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].u.ki = new KEYBDINPUT
            {
                wVk = vk, wScan = scan, dwFlags = flags,
                time = 0, dwExtraInfo = AIRDESK_MAGIC
            };
            InvokeSendInput(inputs);
        }

        static void SendUnicodeText(string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            List<INPUT> list = new List<INPUT>(text.Length * 2);
            foreach (char ch in text)
            {
                list.Add(new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = KEYEVENTF_UNICODE, dwExtraInfo = AIRDESK_MAGIC } } });
                list.Add(new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, dwExtraInfo = AIRDESK_MAGIC } } });
            }
            InvokeSendInput(list.ToArray());
        }

        static bool TryMapCodeToVk(string code, out ushort vk, out bool isExtended)
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

                // Extended navigation & editing keys (require KEYEVENTF_EXTENDEDKEY for terminals/games)
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

                // Modifiers
                case "ControlLeft": vk = 0xA2; return true;
                case "ControlRight": vk = 0xA3; isExtended = true; return true;
                case "AltLeft": vk = 0xA4; return true;
                case "AltRight": vk = 0xA5; isExtended = true; return true;
                case "ShiftLeft": vk = 0xA0; return true;
                case "ShiftRight": vk = 0xA1; return true;
                case "MetaLeft": vk = 0x5B; isExtended = true; return true;
                case "MetaRight": vk = 0x5C; isExtended = true; return true;

                // Punctuation (OEM US layout VKs)
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

                // Numpad operators
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

        static string GetStr(Dictionary<string, object> obj, string key)
        {
            object val;
            return obj.TryGetValue(key, out val) && val != null ? Convert.ToString(val) : "";
        }

        static bool TryGetDouble(Dictionary<string, object> obj, string key, out double result)
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

        static string ReadLineBounded(TextReader reader, int maxChars = 32768)
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
                    throw new InvalidDataException("Input line exceeded maximum allowed length");
                }
            }
            return sb.Length > 0 ? sb.ToString() : null;
        }

        [STAThread]
        static void Main(string[] args)
        {
            Console.InputEncoding = Encoding.UTF8;
            Console.OutputEncoding = Encoding.UTF8;
            if (args != null && args.Length > 0)
            {
                if (string.Equals(args[0], "--audio-list", StringComparison.OrdinalIgnoreCase))
                {
                    AudioRouter.PrintAudioListJson();
                    return;
                }
                if (string.Equals(args[0], "--audio-set", StringComparison.OrdinalIgnoreCase))
                {
                    string devId = args.Length > 1 ? args[1] : "";
                    AudioRouter.SetDefaultDeviceJson(devId);
                    return;
                }
            }
            try
            {
                if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
                {
                    SetProcessDPIAware();
                }
            }
            catch
            {
                try { SetProcessDPIAware(); } catch { }
            }
            RefreshVirtualScreenBounds(true);
            StartPhysicalMouseMonitor();
            StartSecureDesktopMonitor();

            JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 2000000 };

            string line;
            try
            {
                while ((line = ReadLineBounded(Console.In, 32768)) != null)
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    try
                    {
                        Dictionary<string, object> obj = serializer.Deserialize<Dictionary<string, object>>(line);
                        if (obj == null) continue;
                        string t = GetStr(obj, "t");

                        if (t == "m:rel")
                        {
                            double dx, dy;
                            TryGetDouble(obj, "dx", out dx);
                            TryGetDouble(obj, "dy", out dy);
                            SendMouse((int)Math.Round(dx), (int)Math.Round(dy), MOUSEEVENTF_MOVE);
                        }
                        else if (t == "m:abs")
                        {
                            double px, py;
                            if (TryGetDouble(obj, "px", out px) && TryGetDouble(obj, "py", out py))
                            {
                                RefreshVirtualScreenBounds(false);
                                int normX = (int)Math.Round(((px - _cachedVx) * 65535.0) / Math.Max(1, _cachedVw - 1));
                                int normY = (int)Math.Round(((py - _cachedVy) * 65535.0) / Math.Max(1, _cachedVh - 1));
                                normX = Math.Max(0, Math.Min(65535, normX));
                                normY = Math.Max(0, Math.Min(65535, normY));
                                SendMouse(normX, normY, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
                            }
                        }
                        else if (t == "m:btn")
                        {
                            string btn = GetStr(obj, "button");
                            bool down = GetStr(obj, "state") == "down";
                            if (btn == "right") _rightDown = down;
                            else if (btn == "middle") _middleDown = down;
                            else _leftDown = down;
                            uint flag = btn == "right" ? (down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP)
                                      : btn == "middle" ? (down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP)
                                      : (down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP);
                            SendMouse(0, 0, flag);
                        }
                        else if (t == "m:whl")
                        {
                            double dx, dy;
                            if (TryGetDouble(obj, "dy", out dy))
                            {
                                int wheel = (int)Math.Round(-dy * 120.0);
                                if (wheel != 0) SendMouse(0, 0, MOUSEEVENTF_WHEEL, unchecked((uint)wheel));
                            }
                            if (TryGetDouble(obj, "dx", out dx))
                            {
                                int hwheel = (int)Math.Round(dx * 120.0);
                                if (hwheel != 0) SendMouse(0, 0, MOUSEEVENTF_HWHEEL, unchecked((uint)hwheel));
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
                        else if (t == "sys:fast_win_anim")
                        {
                            object enVal;
                            bool en = obj.TryGetValue("enabled", out enVal) && enVal is bool && (bool)enVal;
                            SetWindowAnimationSuppressed(en);
                        }
                    }
                    catch
                    {
                        // Never crash helper loop on malformed input lines
                    }
                }
            }
            finally
            {
                StopSecureDesktopMonitor();
                StopPhysicalMouseMonitor();
                SetWindowAnimationSuppressed(false);
                ReleaseAllKeysAndMouse();
            }
        }
    }

    static class AudioRouter
    {
        private const int eRender = 0;
        private const uint DEVICE_STATE_ACTIVE = 0x00000001;
        private const int STGM_READ = 0;
        private const ushort VT_LPWSTR = 31;

        private enum ERole : uint
        {
            eConsole = 0,
            eMultimedia = 1,
            eCommunications = 2
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROPERTYKEY
        {
            public Guid fmtid;
            public uint pid;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROPVARIANT
        {
            public ushort vt;
            public ushort wReserved1;
            public ushort wReserved2;
            public ushort wReserved3;
            public IntPtr p;
            public IntPtr p2;
        }

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PROPVARIANT pvar);

        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
        private class MMDeviceEnumerator { }

        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDeviceEnumerator
        {
            [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint dwStateMask, out IMMDeviceCollection ppDevices);
            [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
            [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
            [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr pClient);
            [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr pClient);
        }

        [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDeviceCollection
        {
            [PreserveSig] int GetCount(out uint pcDevices);
            [PreserveSig] int Item(uint nDevice, out IMMDevice ppDevice);
        }

        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDevice
        {
            [PreserveSig] int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
            [PreserveSig] int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
            [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
            [PreserveSig] int GetState(out uint pdwState);
        }

        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPropertyStore
        {
            [PreserveSig] int GetCount(out uint cProps);
            [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
            [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
            [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT propvar);
            [PreserveSig] int Commit();
        }

        [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
        private class CPolicyConfigClient { }

        [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPolicyConfig
        {
            [PreserveSig] int GetMixFormat();
            [PreserveSig] int GetDeviceFormat();
            [PreserveSig] int ResetDeviceFormat();
            [PreserveSig] int SetDeviceFormat();
            [PreserveSig] int GetProcessingPeriod();
            [PreserveSig] int SetProcessingPeriod();
            [PreserveSig] int GetShareMode();
            [PreserveSig] int SetShareMode();
            [PreserveSig] int GetPropertyValue();
            [PreserveSig] int SetPropertyValue();
            [PreserveSig] int SetDefaultEndpoint([In, MarshalAs(UnmanagedType.LPWStr)] string wszDeviceId, [In, MarshalAs(UnmanagedType.U4)] ERole role);
            [PreserveSig] int SetEndpointVisibility();
        }

        private static readonly PROPERTYKEY PKEY_Device_FriendlyName = new PROPERTYKEY
        {
            fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),
            pid = 14
        };

        private static string GetFriendlyName(IMMDevice dev)
        {
            if (dev == null) return "";
            IPropertyStore store = null;
            try
            {
                if (dev.OpenPropertyStore(STGM_READ, out store) != 0 || store == null) return "";
                PROPERTYKEY key = PKEY_Device_FriendlyName;
                PROPVARIANT pv;
                if (store.GetValue(ref key, out pv) != 0) return "";
                try
                {
                    if (pv.vt == VT_LPWSTR && pv.p != IntPtr.Zero)
                    {
                        return Marshal.PtrToStringUni(pv.p) ?? "";
                    }
                    return "";
                }
                finally
                {
                    PropVariantClear(ref pv);
                }
            }
            catch
            {
                return "";
            }
            finally
            {
                if (store != null) Marshal.ReleaseComObject(store);
            }
        }

        public static void PrintAudioListJson()
        {
            JavaScriptSerializer ser = new JavaScriptSerializer();
            IMMDeviceEnumerator enumerator = null;
            IMMDeviceCollection col = null;
            IMMDevice defDev = null;
            try
            {
                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                string defaultId = "";
                if (enumerator.GetDefaultAudioEndpoint(eRender, (int)ERole.eMultimedia, out defDev) == 0 && defDev != null)
                {
                    defDev.GetId(out defaultId);
                }
                else if (enumerator.GetDefaultAudioEndpoint(eRender, (int)ERole.eConsole, out defDev) == 0 && defDev != null)
                {
                    defDev.GetId(out defaultId);
                }

                List<Dictionary<string, string>> devices = new List<Dictionary<string, string>>();
                if (enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out col) == 0 && col != null)
                {
                    uint count = 0;
                    col.GetCount(out count);
                    for (uint i = 0; i < count; i++)
                    {
                        IMMDevice dev = null;
                        try
                        {
                            if (col.Item(i, out dev) == 0 && dev != null)
                            {
                                string id = "";
                                dev.GetId(out id);
                                string name = GetFriendlyName(dev);
                                if (!string.IsNullOrEmpty(id))
                                {
                                    Dictionary<string, string> item = new Dictionary<string, string>();
                                    item["id"] = id;
                                    item["name"] = string.IsNullOrEmpty(name) ? id : name;
                                    devices.Add(item);
                                }
                            }
                        }
                        finally
                        {
                            if (dev != null) Marshal.ReleaseComObject(dev);
                        }
                    }
                }

                Dictionary<string, object> result = new Dictionary<string, object>();
                result["ok"] = true;
                result["defaultId"] = defaultId ?? "";
                result["devices"] = devices;
                Console.WriteLine(ser.Serialize(result));
            }
            catch (Exception ex)
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["ok"] = false;
                err["error"] = ex.Message;
                Console.WriteLine(ser.Serialize(err));
            }
            finally
            {
                if (defDev != null) Marshal.ReleaseComObject(defDev);
                if (col != null) Marshal.ReleaseComObject(col);
                if (enumerator != null) Marshal.ReleaseComObject(enumerator);
            }
        }

        public static void SetDefaultDeviceJson(string deviceId)
        {
            JavaScriptSerializer ser = new JavaScriptSerializer();
            IPolicyConfig policy = null;
            try
            {
                if (string.IsNullOrWhiteSpace(deviceId))
                {
                    throw new ArgumentException("Missing deviceId");
                }
                policy = (IPolicyConfig)new CPolicyConfigClient();
                int hrConsole = policy.SetDefaultEndpoint(deviceId, ERole.eConsole);
                int hrMedia = policy.SetDefaultEndpoint(deviceId, ERole.eMultimedia);
                policy.SetDefaultEndpoint(deviceId, ERole.eCommunications);
                if (hrConsole != 0 && hrMedia != 0)
                {
                    Marshal.ThrowExceptionForHR(hrMedia != 0 ? hrMedia : hrConsole);
                }
                Dictionary<string, object> ok = new Dictionary<string, object>();
                ok["ok"] = true;
                Console.WriteLine(ser.Serialize(ok));
            }
            catch (Exception ex)
            {
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["ok"] = false;
                err["error"] = ex.Message;
                Console.WriteLine(ser.Serialize(err));
            }
            finally
            {
                if (policy != null) Marshal.ReleaseComObject(policy);
            }
        }
    }
}
