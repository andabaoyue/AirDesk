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

        private const uint SPI_GETANIMATION = 0x0048;
        private const uint SPI_SETANIMATION = 0x0049;

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
        static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll")]
        static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        static extern bool GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref ANIMATIONINFO pvParam, uint fWinIni);

        private static LowLevelMouseProc _mouseProc;
        private static long _lastPhysicalNotifyMs = 0;
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
                    if (now - _lastPhysicalNotifyMs > 600)
                    {
                        _lastPhysicalNotifyMs = now;
                        Console.WriteLine("{\"event\":\"physical_mouse_override\"}");
                    }
                }
            }
            return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }

        static void StartPhysicalMouseMonitor()
        {
            Thread hookThread = new Thread(() =>
            {
                _mouseProc = HookCallback;
                SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, IntPtr.Zero, 0);
                MSG msg;
                while (GetMessage(out msg, IntPtr.Zero, 0, 0)) { }
            });
            hookThread.IsBackground = true;
            hookThread.Start();
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
            SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        static void SendVirtualKey(ushort vk, bool isExtended, bool keyUp)
        {
            uint flags = (isExtended ? KEYEVENTF_EXTENDEDKEY : 0u) | (keyUp ? KEYEVENTF_KEYUP : 0u);
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].u.ki = new KEYBDINPUT
            {
                wVk = vk, wScan = 0, dwFlags = flags,
                time = 0, dwExtraInfo = AIRDESK_MAGIC
            };
            SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
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
            SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
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

        static void Main(string[] args)
        {
            Console.InputEncoding = Encoding.UTF8;
            Console.OutputEncoding = Encoding.UTF8;
            SetProcessDPIAware();
            StartPhysicalMouseMonitor();

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
                                int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
                                int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
                                int vw = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
                                int vh = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));
                                int normX = (int)Math.Round(((px - vx) * 65535.0) / Math.Max(1, vw - 1));
                                int normY = (int)Math.Round(((py - vy) * 65535.0) / Math.Max(1, vh - 1));
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
                SetWindowAnimationSuppressed(false);
                ReleaseAllKeysAndMouse();
            }
        }
    }
}
